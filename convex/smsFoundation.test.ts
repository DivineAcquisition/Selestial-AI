/**
 * @vitest-environment edge-runtime
 *
 * SMS foundation (docs/sms/00-architecture.md, phase 2): provider opt-out blocks, Telnyx's own keyword
 * answers, "YES" never undoing a STOP, delivery that the carrier never confirmed, the company's own
 * messaging profile, the emergency stop reaching every agent, and a check with the provider that would
 * no longer send the same text. All against the mock provider or a stubbed Telnyx; nothing is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchTestEnv, flush, setup } from "../tests/dispatchHarness";
import { HOUR, refusal } from "../tests/harness";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { Actor } from "./lib/events";
import { fingerprint } from "./lib/messaging/fingerprint";
import { messageState, refusalClassOf } from "./lib/messaging/lifecycle";
import { queueMessage } from "./lib/messaging/outbox";

const DISPATCH: Actor = { kind: "agent", agent: "dispatch" };
/** The mock refuses numbers ending 0007 as a provider opt-out block (Telnyx 40300). */
const BLOCKED = "+15550100007";
/** The mock accepts numbers ending 0004 and never reports delivery. */
const QUIET = "+15550100004";

type S = Awaited<ReturnType<typeof setup>>;

async function remind(s: S, key: string) {
  return s.t.run(async (ctx) => queueMessage(ctx, { companyId: s.companyId, purpose: "reminder", cleaner: (await ctx.db.get(s.cleaners.Lena))!, body: `Reminder ${key}.`, dedupeKey: key, actor: DISPATCH }));
}
const message = (s: S, id: Id<"messages">) => s.t.run(async (ctx) => (await ctx.db.get(id))!);
const suppressionsAt = (s: S, address: string) => s.t.run(async (ctx) => (await ctx.db.query("suppressions").collect()).filter((row) => row.companyId === s.companyId && row.address === address && row.liftedAt === undefined));
const replies = (s: S) => s.t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((row) => row.purpose === "compliance_reply"));

describe("SMS foundation", () => {
  let undo = () => {};
  beforeEach(() => {
    undo = dispatchTestEnv();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    undo();
    delete process.env.TELNYX_API_KEY;
  });

  it("records a provider opt-out block as a suppression that only the person can lift", async () => {
    const s = await setup(["Lena"], { Lena: BLOCKED });
    const first = await remind(s, "block-1");
    await flush(s.t);
    const row = await message(s, first._id);
    expect(row).toMatchObject({ status: "not_sent", refusal: "provider_block" });
    expect(messageState(row)).toMatchObject({ key: "suppressed", label: "Recipient opted out", refusalClass: "suppressed" });
    const stops = await suppressionsAt(s, BLOCKED);
    expect(stops).toEqual([expect.objectContaining({ reason: "provider_block", scope: "all" })]);
    // Nothing more is tried to that number: the policy refuses before the provider is asked.
    const second = await remind(s, "block-2");
    await flush(s.t);
    expect(await message(s, second._id)).toMatchObject({ status: "not_sent", refusal: "suppressed" });
    // The Owner can't lift it; only the person, by replying START.
    expect(await refusal(s.as.mutation(api.consent.lift, { companyId: s.companyId, suppressionId: stops[0]._id, note: "Asked us to" }))).toMatch(/Only the person can undo STOP/);
    await s.t.mutation(internal.inbound.sms, { to: s.smsNumber, from: BLOCKED, body: "START", receivedAt: Date.now() });
    expect(await suppressionsAt(s, BLOCKED)).toHaveLength(0);
  });

  it("records a STOP that Telnyx already answered, without sending a second confirmation", async () => {
    const s = await setup(["Lena", "Rosa"]);
    // Telnyx answered this STOP itself (the profile's auto-response): Selestial records it and stays quiet.
    await s.t.mutation(internal.inbound.telnyx, { eventId: "in-1", to: s.smsNumber, from: s.phone.Lena, body: "STOP", receivedAt: Date.now(), autoresponseType: "stop" });
    await flush(s.t);
    expect(await suppressionsAt(s, s.phone.Lena)).toEqual([expect.objectContaining({ reason: "stop_keyword" })]);
    expect(await replies(s)).toHaveLength(0);
    // Without Telnyx's answer, Selestial confirms the STOP itself, once.
    await s.t.mutation(internal.inbound.telnyx, { eventId: "in-2", to: s.smsNumber, from: s.phone.Rosa, body: "STOP", receivedAt: Date.now() });
    await flush(s.t);
    expect(await replies(s)).toHaveLength(1);
  });

  it("never lifts a STOP on YES; only START or UNSTOP does", async () => {
    const s = await setup(["Lena"]);
    const text = (body: string) => s.t.mutation(internal.inbound.sms, { to: s.smsNumber, from: s.phone.Lena, body, receivedAt: Date.now() });
    await text("STOP");
    expect(await suppressionsAt(s, s.phone.Lena)).toHaveLength(1);
    expect(await text("YES")).toMatchObject({ kind: "ignored" });
    expect(await suppressionsAt(s, s.phone.Lena)).toHaveLength(1);
    expect(await text("UNSTOP")).toMatchObject({ kind: "start" });
    expect(await suppressionsAt(s, s.phone.Lena)).toHaveLength(0);
  });

  it("shows a text the carrier never confirmed as 'Delivery not confirmed', never delivered or failed", async () => {
    const s = await setup(["Lena"], { Lena: QUIET });
    const sent = await remind(s, "quiet-1");
    await flush(s.t);
    const before = await message(s, sent._id);
    expect(messageState(before)).toMatchObject({ key: "accepted", label: "Provider accepted" });
    const receipt = { provider: "mock", eventId: "fin-quiet", providerMessageId: before.providerMessageId!, outcome: "unconfirmed" as const };
    await s.t.mutation(internal.messaging.receipt, receipt);
    const after = await message(s, sent._id);
    expect(after.status).toBe("sent");
    expect(after.deliveryUnconfirmedAt).toBeDefined();
    expect(messageState(after)).toMatchObject({ key: "delivery_unknown", label: "Delivery not confirmed", tone: "warning", terminal: true });
    // The same report again changes nothing.
    expect(await s.t.mutation(internal.messaging.receipt, receipt)).toBe("duplicate");
  });

  it("sends each company's texts on its own Telnyx messaging profile", async () => {
    const s = await setup(["Lena"]);
    await s.t.run(async (ctx) => {
      const profile = (await ctx.db.query("complianceProfiles").collect()).find((row) => row.companyId === s.companyId)!;
      await ctx.db.patch(profile._id, { messaging: { ...profile.messaging, messagingProfileId: "profile-alpha" } });
    });
    process.env.MESSAGING_PROVIDER = "telnyx";
    process.env.TELNYX_API_KEY = "KEY_test";
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: { id: `tx-${bodies.length}` } }), { status: 200 });
    });
    await remind(s, "profile-1");
    await flush(s.t);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ from: s.smsNumber, messaging_profile_id: "profile-alpha" });
  });

  it("pauses every agent, Quality included, with the emergency stop", async () => {
    const s = await setup(["Lena"]);
    await s.as.mutation(api.companies.pauseAll, { companyId: s.companyId });
    const paused = await s.t.run(async (ctx) => (await ctx.db.get(s.companyId))!.pausedAgents);
    expect([...paused].sort()).toEqual(["dispatch", "quality", "recruiter", "retention", "sales"]);
  });

  it("won't repeat a request to the provider when the text would now read differently", async () => {
    const s = await setup(["Lena"], { Lena: QUIET });
    const sent = await remind(s, "fp-1");
    await flush(s.t);
    const first = await message(s, sent._id);
    expect(first.sentFingerprint).toBe(fingerprint("Reminder fp-1."));
    // Unconfirmed and being checked with the provider, but its words changed since the first attempt.
    await s.t.run(async (ctx) => ctx.db.patch(sent._id, { status: "queued", body: "Reminder, reworded.", reconcile: { requestedAt: Date.now(), deadline: Date.now() + HOUR, by: "test" } }));
    await s.t.action(internal.messaging.deliver, { messageId: sent._id });
    const after = await message(s, sent._id);
    expect(after.status).toBe("unconfirmed");
    expect(after.problem).toMatch(/read differently/);
    expect(after.attempts).toBe(first.attempts);
  });
});

describe("SMS foundation: pause and throughput", () => {
  let undo = () => {};
  beforeEach(() => {
    undo = dispatchTestEnv();
  });
  afterEach(() => {
    undo();
    delete process.env.SMS_COMPANY_PER_MINUTE;
    delete process.env.SMS_NUMBER_PER_MINUTE;
  });

  it("holds every message while the owner pauses texting, still answers STOP, and sends what waited on resume", async () => {
    const s = await setup(["Lena", "Rosa"]);
    await s.as.mutation(api.companies.pauseMessaging, { companyId: s.companyId, reason: "Checking our reminders" });
    const waiting = await remind(s, "paused-1");
    await flush(s.t);
    const held = await message(s, waiting._id);
    expect(held).toMatchObject({ status: "held", holdReason: "messaging_paused" });
    expect(messageState(held)).toMatchObject({ label: "Paused by the owner", refusalClass: "hold" });
    // A person's own STOP is still answered while paused.
    await s.t.mutation(internal.inbound.sms, { to: s.smsNumber, from: s.phone.Rosa, body: "STOP", receivedAt: Date.now() });
    await flush(s.t);
    expect((await replies(s)).map((row) => row.status)).toEqual(["delivered"]);
    // Resuming sends exactly what waited, through the whole policy again.
    expect(await s.as.mutation(api.companies.resumeMessaging, { companyId: s.companyId })).toEqual({ changed: true, released: 1 });
    await flush(s.t);
    expect((await message(s, waiting._id)).status).toBe("delivered");
  });

  it("keeps one company within its share per minute, without refusing or charging anything twice", async () => {
    process.env.SMS_COMPANY_PER_MINUTE = "2";
    const s = await setup(["Lena"]);
    const ids: Id<"messages">[] = [];
    for (const key of ["rate-1", "rate-2", "rate-3"]) ids.push((await remind(s, key))._id);
    await flush(s.t);
    const statuses = async () => Promise.all(ids.map(async (id) => (await message(s, id)).status));
    expect((await statuses()).sort()).toEqual(["delivered", "delivered", "queued"]);
    vi.advanceTimersByTime(90_000);
    await flush(s.t);
    expect(await statuses()).toEqual(["delivered", "delivered", "delivered"]);
    // Each was sent once.
    expect(await s.t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((row) => ids.includes(row._id)).map((row) => row.attempts))).toEqual([1, 1, 1]);
  });

  it("never makes an answer to STOP wait behind the company's other texts", async () => {
    process.env.SMS_COMPANY_PER_MINUTE = "1";
    const s = await setup(["Lena", "Rosa"]);
    await remind(s, "fill-1");
    await remind(s, "fill-2");
    await s.t.mutation(internal.inbound.sms, { to: s.smsNumber, from: s.phone.Rosa, body: "STOP", receivedAt: Date.now() });
    await flush(s.t);
    expect((await replies(s)).map((row) => row.status)).toEqual(["delivered"]);
  });
});

describe("Message lifecycle words", () => {
  const row = (fields: Partial<Doc<"messages">> & { status: Doc<"messages">["status"] }) => fields as Pick<Doc<"messages">, "status" | "refusal" | "holdReason" | "scheduledFor"> & { deliveryUnconfirmedAt?: number };
  const now = 1_000_000;

  it("never shows provider acceptance as delivery", () => {
    expect(messageState(row({ status: "sent" }), now).label).toBe("Provider accepted");
    expect(messageState(row({ status: "delivered" }), now).label).toBe("Delivered");
    expect(messageState(row({ status: "sent", deliveryUnconfirmedAt: now }), now).label).toBe("Delivery not confirmed");
    expect(messageState(row({ status: "unconfirmed" }), now).label).toBe("Not known whether it went");
  });

  it("names what a held message is waiting for", () => {
    expect(messageState(row({ status: "held", holdReason: "quiet_hours" }), now)).toMatchObject({ label: "Waiting until sending hours", refusalClass: "hold" });
    expect(messageState(row({ status: "held", refusal: "quiet_hours" }), now).label).toBe("Waiting until sending hours");
    expect(messageState(row({ status: "held", holdReason: "messaging_balance" }), now).label).toBe("Add funds to continue");
    expect(messageState(row({ status: "held", scheduledFor: now + 1 }), now).label).toBe("Scheduled");
    expect(messageState(row({ status: "queued", scheduledFor: now + 1 }), now).key).toBe("scheduled");
  });

  it("tells permanent suppression, cancellation, missing setup and provider failure apart", () => {
    expect(messageState(row({ status: "not_sent", refusal: "suppressed" }), now)).toMatchObject({ key: "suppressed", label: "Recipient opted out", refusalClass: "suppressed" });
    expect(messageState(row({ status: "not_sent", refusal: "follow_up_cancelled" }), now)).toMatchObject({ key: "canceled", refusalClass: "canceled" });
    expect(messageState(row({ status: "not_sent", refusal: "sender_not_ready" }), now)).toMatchObject({ label: "Not sent: setup needed", refusalClass: "setup" });
    expect(messageState(row({ status: "failed" }), now).refusalClass).toBe("provider");
    expect(messageState(row({ status: "not_sent" }), now).refusalClass).toBe("policy");
    expect(refusalClassOf("quiet_hours")).toBe("hold");
    expect(refusalClassOf("no_such_code")).toBeNull();
  });
});

describe("SMS foundation: sending hours on the recipient's clock", () => {
  let undo = () => {};
  beforeEach(() => {
    undo = dispatchTestEnv();
  });
  afterEach(() => undo());

  it("holds a customer text until 8 AM the customer's time, sends work texts to the company's cleaners, and answers someone who just wrote", async () => {
    const s = await setup(["Lena"]);
    const customer = "+15125550171";
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.place.customerId, { phone: customer });
      // The customer's home is in California: two hours behind the company's Chicago clock.
      const property = (await ctx.db.get(s.place.propertyId))!;
      await ctx.db.patch(s.place.propertyId, { address: { ...property.address, region: "CA" } });
    });
    await s.as.mutation(api.consent.record, { companyId: s.companyId, recipient: { kind: "customer", id: s.place.customerId }, channel: "sms", category: "operational", status: "granted", source: "web_form", evidence: "Booking form." });
    // 9 AM in Chicago is 7 AM in California.
    vi.setSystemTime(Date.UTC(2027, 2, 1, 15, 0));
    const check = (to: string, recipient: { kind: "customer" | "cleaner"; id: string }) => s.as.query(api.consent.check, { companyId: s.companyId, channel: "sms", to, recipient: recipient as never, category: "operational", origin: "manual" });
    const held = await check(customer, { kind: "customer", id: s.place.customerId });
    expect(held).toMatchObject({ ok: false, code: "quiet_hours" });
    expect((held as { words: string }).words).toMatch(/It can go at 8:00 AM their time/);
    // A work text to the company's own cleaner isn't held by the floor.
    expect(await check(s.phone.Lena, { kind: "cleaner", id: s.cleaners.Lena })).toMatchObject({ ok: true });
    // Once the customer texts in, answering them isn't held.
    await s.t.mutation(internal.inbound.sms, { to: s.smsNumber, from: customer, body: "Can you come earlier?", receivedAt: Date.now() });
    expect(await check(customer, { kind: "customer", id: s.place.customerId })).toMatchObject({ ok: true });
    // Two hours after the customer's 8 AM, everything goes.
    vi.setSystemTime(Date.UTC(2027, 2, 1, 18, 0));
    expect(await check(customer, { kind: "customer", id: s.place.customerId })).toMatchObject({ ok: true });
  });
});
