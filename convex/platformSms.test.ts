/**
 * @vitest-environment edge-runtime
 *
 * Selestial's own texts (docs/sms/00-architecture.md §4.6): sign-in codes Clerk asks Selestial to deliver,
 * and replies to Selestial's no-reply numbers. All against the mock provider; nothing is sent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatchTestEnv, flush, setup } from "../tests/dispatchHarness";
import { api, internal } from "./_generated/api";
import { mockOutbox } from "./lib/messaging/provider";
import { queueMessage } from "./lib/messaging/outbox";

const SECRET = `whsec_${btoa("clerk-test-signing-key-0123456789")}`;
const CODES_FROM = "+18885550100";
const NOTICES_FROM = "+18885550101";
const PERSON = "+15125550177";

async function sign(id: string, timestamp: number, body: string) {
  const raw = Uint8Array.from(atob(SECRET.slice(6)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}

type S = Awaited<ReturnType<typeof setup>>;
const smsCreated = (to: string, opts: { clerkDelivers?: boolean; message?: string } = {}) =>
  JSON.stringify({ type: "sms.created", object: "event", data: { object: "sms_message", id: "sms_1", to_phone_number: to, message: opts.message ?? "123456 is your Selestial verification code.", delivered_by_clerk: opts.clerkDelivers ?? false, user_id: "user_abc", slug: "verification_code", status: "queued" } });
async function clerk(s: S, body: string, id: string, signed = true) {
  const timestamp = Math.floor(Date.now() / 1000);
  return s.t.fetch("/webhooks/clerk", { method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": signed ? await sign(id, timestamp, body) : "v1,forged" }, body });
}
const platformRows = (s: S) => s.t.run(async (ctx) => ctx.db.query("platformMessages").collect());
const toCodes = () => mockOutbox.filter((row) => row.from === CODES_FROM);

describe("Platform SMS: sign-in codes from Clerk", () => {
  let undo = () => {};
  beforeEach(() => {
    undo = dispatchTestEnv();
    process.env.CLERK_WEBHOOK_SECRET = SECRET;
    process.env.PLATFORM_SMS_CODES_FROM = CODES_FROM;
    process.env.PLATFORM_SMS_CODES_PROFILE_ID = "profile-codes";
    process.env.PLATFORM_SMS_NOTICES_FROM = NOTICES_FROM;
    process.env.PLATFORM_SMS_NOTICES_PROFILE_ID = "profile-notices";
  });
  afterEach(() => {
    undo();
    for (const name of ["CLERK_WEBHOOK_SECRET", "PLATFORM_SMS_CODES_FROM", "PLATFORM_SMS_CODES_PROFILE_ID", "PLATFORM_SMS_NOTICES_FROM", "PLATFORM_SMS_NOTICES_PROFILE_ID", "MESSAGING_BILLING", "PLATFORM_SMS_CODES_PER_HOUR"]) delete process.env[name];
  });

  it("texts Clerk's own words from the code sender, once, and stores neither the code nor the number", async () => {
    const s = await setup(["Lena"]);
    expect((await clerk(s, smsCreated(PERSON), "msg_1", false)).status).toBe(401);
    expect(toCodes()).toHaveLength(0);
    expect((await clerk(s, smsCreated(PERSON), "msg_1")).status).toBe(200);
    // Clerk delivers at least once: the same delivery again sends nothing more.
    expect((await clerk(s, smsCreated(PERSON), "msg_1")).status).toBe(200);
    expect(toCodes()).toEqual([expect.objectContaining({ to: PERSON, from: CODES_FROM, messagingProfileId: "profile-codes", body: "123456 is your Selestial verification code." })]);
    const rows = await platformRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "auth_code", sender: "codes", reason: "verification_code", userId: "user_abc", toLast4: "0177", status: "delivered" });
    expect(rows[0].body).toBeUndefined();
    expect(rows[0].to).toBeUndefined();
    expect(JSON.stringify(rows[0])).not.toContain("123456");
    expect(JSON.stringify(rows[0])).not.toContain(PERSON);
  });

  it("does nothing when Clerk delivers the text itself", async () => {
    const s = await setup(["Lena"]);
    await clerk(s, smsCreated(PERSON, { clerkDelivers: true }), "msg_2");
    expect(toCodes()).toHaveLength(0);
    expect(await platformRows(s)).toHaveLength(0);
  });

  it("delivers a code with no messaging funds, every agent paused and the company's texting paused", async () => {
    const s = await setup(["Lena"]);
    process.env.MESSAGING_BILLING = "on";
    await s.as.mutation(api.companies.pauseAll, { companyId: s.companyId });
    await s.as.mutation(api.companies.pauseMessaging, { companyId: s.companyId });
    // The company's own texts wait...
    const held = await s.t.run(async (ctx) => queueMessage(ctx, { companyId: s.companyId, purpose: "reminder", cleaner: (await ctx.db.get(s.cleaners.Lena))!, body: "Reminder.", dedupeKey: "r1", actor: { kind: "system" } }));
    await flush(s.t);
    expect((await s.t.run(async (ctx) => ctx.db.get(held._id)))!.status).toBe("held");
    // ...a sign-in code never does, and it charges no company.
    await clerk(s, smsCreated(PERSON), "msg_3");
    expect(toCodes()).toHaveLength(1);
    expect(await s.t.run(async (ctx) => (await ctx.db.query("messagingCharges").collect()).length)).toBe(0);
    expect((await platformRows(s))[0].status).toBe("delivered");
  });

  it("refuses codes past the limits and to unsupported numbers, without sending", async () => {
    const s = await setup(["Lena"]);
    for (let i = 1; i <= 6; i += 1) await clerk(s, smsCreated(PERSON), `burst_${i}`);
    expect(toCodes()).toHaveLength(5);
    const refused = (await platformRows(s)).filter((row) => row.status === "not_sent");
    expect(refused.map((row) => row.refusal)).toEqual(["destination_limit"]);
    // A Canadian number is not on Selestial's routes.
    await clerk(s, smsCreated("+14165550123"), "ca_1");
    expect((await platformRows(s)).find((row) => row.toLast4 === "0123")).toMatchObject({ status: "not_sent", refusal: "unsupported_route" });
    // The platform-wide circuit breaker.
    process.env.PLATFORM_SMS_CODES_PER_HOUR = "1";
    await clerk(s, smsCreated("+15125550199"), "breaker_1");
    expect((await platformRows(s)).find((row) => row.toLast4 === "0199")).toMatchObject({ status: "not_sent", refusal: "platform_limit" });
  });

  it("records a code it can't send when Selestial's code sender isn't set up, so Clerk stays the deliverer", async () => {
    const s = await setup(["Lena"]);
    delete process.env.PLATFORM_SMS_CODES_FROM;
    await clerk(s, smsCreated(PERSON), "msg_4");
    expect(toCodes()).toHaveLength(0);
    expect((await platformRows(s))[0]).toMatchObject({ status: "not_sent", refusal: "sender_not_ready" });
  });

  it("reads delivery reports for its own texts without touching any company's", async () => {
    const s = await setup(["Lena"]);
    await clerk(s, smsCreated("+15125550004"), "msg_5");
    const row = (await platformRows(s))[0];
    expect(row.status).toBe("sent");
    expect(await s.t.mutation(internal.messaging.receipt, { provider: "mock", eventId: "fin-p1", providerMessageId: row.providerMessageId!, outcome: "delivered", providerCost: 75 })).toBe("platform");
    expect((await platformRows(s))[0]).toMatchObject({ status: "delivered", providerCost: 75 });
  });
});

describe("Platform SMS: replies to Selestial's numbers", () => {
  let undo = () => {};
  beforeEach(() => {
    undo = dispatchTestEnv();
    process.env.PLATFORM_SMS_NOTICES_FROM = NOTICES_FROM;
    process.env.PLATFORM_SMS_NOTICES_PROFILE_ID = "profile-notices";
  });
  afterEach(() => {
    undo();
    delete process.env.PLATFORM_SMS_NOTICES_FROM;
    delete process.env.PLATFORM_SMS_NOTICES_PROFILE_ID;
  });

  it("answers once a day that the number takes no replies, never after STOP, and never files it under a company", async () => {
    const s = await setup(["Lena"]);
    const text = (body: string) => s.t.mutation(internal.inbound.sms, { to: NOTICES_FROM, from: PERSON, body, receivedAt: Date.now() });
    expect(await text("who is this?")).toEqual({ kind: "platform_number", replied: true });
    expect(await text("hello??")).toEqual({ kind: "platform_number", replied: false });
    await flush(s.t);
    const answers = mockOutbox.filter((row) => row.from === NOTICES_FROM);
    expect(answers).toHaveLength(1);
    expect(answers[0].body).toContain("doesn't take replies");
    expect(await text("STOP")).toEqual({ kind: "platform_number", replied: false });
    // Nothing reached any company's inbox.
    expect(await s.t.run(async (ctx) => (await ctx.db.query("smsInbound").collect()).length)).toBe(0);
  });
});
