/**
 * @vitest-environment edge-runtime
 *
 * Quality reading HighLevel through Selestial's Marketplace app, against the real backend (convex-test) with a
 * fake HighLevel. Nothing reaches HighLevel. The shapes follow HighLevel's developer docs; they are not
 * verified against the live API (docs/quality/02-verification.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchTestEnv } from "../tests/dispatchHarness";
import { CUSTOMER_PHONE, DAY, flush, JOB_START, qualitySetup } from "../tests/qualityHarness";
import { api, internal } from "./_generated/api";
import { highLevelKeyOverride, mockHighLevel, type HighLevelApi, type HighLevelMessage, type HighLevelSentence, type HighLevelTokens } from "./lib/quality/comms/highlevel";

let undo: () => void;
let pair: CryptoKeyPair;
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

beforeEach(async () => {
  undo = dispatchTestEnv();
  process.env.MAILBOX_TOKEN_KEY = btoa("k".repeat(32));
  process.env.CONVEX_SITE_URL = "https://example.convex.site";
  process.env.HIGHLEVEL_CLIENT_ID = "client-123";
  process.env.HIGHLEVEL_CLIENT_SECRET = "secret-456";
  process.env.HIGHLEVEL_INSTALL_URL = "https://marketplace.gohighlevel.com/oauth/chooselocation?response_type=code&client_id=client-123&scope=conversations.readonly";
  pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  highLevelKeyOverride.spkiBase64 = toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
});
afterEach(() => {
  undo();
  mockHighLevel.api = null;
  mockHighLevel.tokens = null;
  highLevelKeyOverride.spkiBase64 = null;
  for (const key of ["HIGHLEVEL_CLIENT_ID", "HIGHLEVEL_CLIENT_SECRET", "HIGHLEVEL_INSTALL_URL"]) delete process.env[key];
});

const CHECKLIST = [
  { label: "Clean the shower", state: "done" as const },
  { label: "Wipe kitchen counters", state: "done" as const },
];

function fakeHighLevel() {
  const state = { conversations: [] as { id: string; contactId?: string }[], messages: new Map<string, HighLevelMessage[]>(), transcriptions: new Map<string, HighLevelSentence[]>(), refreshes: 0 };
  const api: HighLevelApi = {
    async conversations() {
      return state.conversations;
    },
    async messages(conversationId) {
      return { messages: state.messages.get(conversationId) ?? [], next: null };
    },
    async transcription(_location, messageId) {
      return state.transcriptions.get(messageId) ?? [];
    },
    async contact() {
      return null;
    },
  };
  const tokens = (grant: "authorization_code" | "refresh_token", value: string): HighLevelTokens => {
    if (grant === "refresh_token") state.refreshes += 1;
    return { accessToken: `access-${grant}-${state.refreshes}`, refreshToken: `refresh-${state.refreshes}`, expiresAt: Date.now() + DAY, locationId: value === "agency-code" ? null : "LOC1", companyId: "AGENCY1", userType: "Location", scope: ["conversations.readonly"] };
  };
  mockHighLevel.api = api;
  mockHighLevel.tokens = tokens;
  return state;
}

async function signed(body: string): Promise<RequestInit> {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(body)));
  return { method: "POST", headers: { "content-type": "application/json", "x-ghl-signature": toBase64(sig) }, body };
}

/** The Owner installs the app: start, HighLevel's page, back to the callback with a code. */
async function install(s: Awaited<ReturnType<typeof qualitySetup>>, code = "the-code") {
  const { url } = await s.as.mutation(api.qualityHighLevel.start, { companyId: s.companyId });
  const state = new URL(url).searchParams.get("state")!;
  const back = await s.t.fetch(`/oauth/highlevel/callback?code=${code}&state=${encodeURIComponent(state)}`, { method: "GET" });
  await flush(s.t);
  return { url, back };
}

const message = (fields: Partial<Record<string, unknown>>) => JSON.stringify({ type: "InboundMessage", locationId: "LOC1", messageType: "SMS", messageTypeString: "TYPE_SMS", direction: "inbound", contactId: "CT1", conversationId: "CV1", dateAdded: new Date().toISOString(), webhookId: `wh-${Math.random().toString(36).slice(2)}`, ...fields });

describe("HighLevel through Selestial's Marketplace app", () => {
  it("installs with a one-time state, keeps the tokens sealed, and records what the location allows", async () => {
    const s = await qualitySetup();
    const fake = fakeHighLevel();
    fake.conversations = [{ id: "CV1" }];
    fake.messages.set("CV1", [{ id: "M-call", kind: "call", direction: "incoming", body: "", occurredAt: Date.now() - DAY, callDuration: 120 }]);
    fake.transcriptions.set("M-call", [{ channel: 1, start: 0, end: 2, text: "Hello" }]);
    const { url, back } = await install(s);
    const target = new URL(url);
    expect(target.searchParams.get("redirect_uri")).toBe("https://example.convex.site/oauth/highlevel/callback");
    expect(target.searchParams.get("state")).toBeTruthy();
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toContain("/app/agents/quality/playbook?highlevel=connected");
    const [connection] = await s.t.run(async (ctx) => ctx.db.query("qualityConnections").collect());
    expect(connection).toMatchObject({ provider: "highlevel", externalId: "LOC1", status: "connected" });
    expect(connection.capabilities).toMatchObject({ readMessages: "available", readTranscripts: "available", recordings: "not_used", send: "not_used", webhooks: "unknown" });
    const [credential] = await s.t.run(async (ctx) => ctx.db.query("qualityCredentials").collect());
    expect(credential.sealedKey).not.toContain("refresh-");
    expect(credential.sealedAccess).not.toContain("access-");
    // A used state opens nothing a second time.
    const state = target.searchParams.get("state")!;
    const again = await s.t.fetch(`/oauth/highlevel/callback?code=x&state=${encodeURIComponent(state)}`, { method: "GET" });
    expect(again.headers.get("location")).toContain("highlevel=expired");
  });

  it("is not available until the app is configured, and an agency-level install reads nothing", async () => {
    const s = await qualitySetup();
    fakeHighLevel();
    const { back } = await install(s, "agency-code");
    expect(back.headers.get("location")).toContain("highlevel=choose_location");
    expect(await s.t.run(async (ctx) => ctx.db.query("qualityConnections").collect())).toEqual([]);
    delete process.env.HIGHLEVEL_CLIENT_ID;
    await expect(s.as.mutation(api.qualityHighLevel.start, { companyId: s.companyId })).rejects.toThrow(/isn't available/);
  });

  it("accepts only signed notices, once each, and reads a customer's text against their visit", async () => {
    const s = await qualitySetup();
    await s.trustRequests();
    const jobId = await s.submitted({ checklist: CHECKLIST, after: 3 });
    fakeHighLevel();
    await install(s);
    await s.as.mutation(api.quality.saveSettings, { companyId: s.companyId, settings: { readPhonePlatform: true } });
    vi.setSystemTime(JOB_START + DAY);
    const body = message({ body: "The shower was not cleaned yesterday and it's still dirty.", from: CUSTOMER_PHONE, to: "+15125550199", webhookId: "wh-1", messageId: "HL-M1" });
    // Unsigned, or signed by someone else: refused.
    expect((await s.t.fetch("/webhooks/highlevel", { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(401);
    expect((await s.t.fetch("/webhooks/highlevel", { ...(await signed(body)), body: body.replace("dirty", "fine") })).status).toBe(401);
    expect((await s.t.fetch("/webhooks/highlevel", await signed(body))).status).toBe(200);
    expect((await s.t.fetch("/webhooks/highlevel", await signed(body))).status).toBe(200);
    await flush(s.t);
    const comms = await s.t.run(async (ctx) => ctx.db.query("qualityComms").collect());
    expect(comms).toHaveLength(1);
    expect(comms[0]).toMatchObject({ provider: "highlevel", kind: "sms", direction: "incoming", jobId });
    const [qcase] = await s.qcases();
    expect(qcase).toMatchObject({ jobId, origin: "sms" });
    const [connection] = await s.t.run(async (ctx) => ctx.db.query("qualityConnections").collect());
    expect(connection.capabilities.webhooks).toBe("available");
  });

  it("does not read a quoted email history as a new complaint", async () => {
    const s = await qualitySetup();
    await s.submitted({ checklist: CHECKLIST, after: 3 });
    fakeHighLevel();
    await install(s);
    await s.as.mutation(api.quality.saveSettings, { companyId: s.companyId, settings: { readPhonePlatform: true } });
    const customerEmail = (await s.t.run(async (ctx) => ctx.db.get(s.place.customerId)))?.email ?? "dana@example.com";
    await s.t.run(async (ctx) => ctx.db.patch(s.place.customerId, { email: customerEmail }));
    const body = message({ messageType: "Email", messageTypeString: "TYPE_EMAIL", from: customerEmail, subject: "Re: Your visit", body: "<p>Thanks, Tuesday works.</p><p>On Mon, Mar 1, 2027 at 9:00 AM Office wrote:</p><blockquote>&gt; The shower was not cleaned and the floor is still dirty.</blockquote>", webhookId: "wh-e1", messageId: "HL-E1" });
    expect((await s.t.fetch("/webhooks/highlevel", await signed(body))).status).toBe(200);
    await flush(s.t);
    const comms = await s.t.run(async (ctx) => ctx.db.query("qualityComms").collect());
    expect(comms).toHaveLength(1);
    expect(comms[0].kind).toBe("email");
    expect(comms[0].body).not.toContain("<p>");
    expect(await s.qcases()).toEqual([]);
  });

  it("fetches a call's transcription later, names no speaker, and rotates the refresh token", async () => {
    const s = await qualitySetup();
    await s.submitted({ checklist: CHECKLIST, after: 3 });
    const fake = fakeHighLevel();
    await install(s);
    await s.as.mutation(api.quality.saveSettings, { companyId: s.companyId, settings: { readPhonePlatform: true } });
    const call = message({ messageType: "CALL", messageTypeString: "TYPE_CALL", from: CUSTOMER_PHONE, callDuration: 180, callStatus: "completed", webhookId: "wh-c1", messageId: "HL-C1", body: "" });
    expect((await s.t.fetch("/webhooks/highlevel", await signed(call))).status).toBe(200);
    await flush(s.t);
    let [comm] = await s.t.run(async (ctx) => ctx.db.query("qualityComms").collect());
    expect(comm).toMatchObject({ kind: "call", durationSec: 180 });
    expect(comm.recheckAt).toBeDefined();
    // The access token has expired: the next sync refreshes it (the refresh token rotates) and reads the transcription.
    fake.transcriptions.set("HL-C1", [{ channel: 1, start: 0, end: 4, text: "The shower was not cleaned and it is still dirty." }]);
    const before = (await s.t.run(async (ctx) => ctx.db.query("qualityCredentials").collect()))[0];
    await s.t.run(async (ctx) => ctx.db.patch(before._id, { accessExpiresAt: Date.now() - 1 }));
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await s.t.mutation(internal.qualityComms.sweep, {});
    await flush(s.t);
    [comm] = await s.t.run(async (ctx) => ctx.db.query("qualityComms").collect());
    expect(comm.transcript).toMatchObject({ status: "completed", version: 1 });
    expect(comm.transcript?.segments.every((seg) => seg.speakerKind === "unknown")).toBe(true);
    expect(fake.refreshes).toBe(1);
    const after = (await s.t.run(async (ctx) => ctx.db.query("qualityCredentials").collect()))[0];
    expect(after.sealedKey).not.toBe(before.sealedKey);
    expect(after.accessExpiresAt).toBeGreaterThan(Date.now());
  });

  it("an uninstall in HighLevel stops reading and forgets the tokens; one location belongs to one company", async () => {
    const s = await qualitySetup();
    fakeHighLevel();
    await install(s);
    const body = JSON.stringify({ type: "UNINSTALL", appId: "APP1", locationId: "LOC1", webhookId: "wh-u1" });
    expect((await s.t.fetch("/webhooks/highlevel", await signed(body))).status).toBe(200);
    const [connection] = await s.t.run(async (ctx) => ctx.db.query("qualityConnections").collect());
    expect(connection.status).toBe("expired");
    expect(await s.t.run(async (ctx) => ctx.db.query("qualityCredentials").collect())).toEqual([]);
    // Reinstalled by this company, it reads again; another company cannot take the same location.
    await install(s);
    const other = await s.t.run(async (ctx) => {
      const row = (await ctx.db.query("qualityConnections").collect())[0];
      const companyId = await ctx.db.insert("companies", { ...(await ctx.db.get(row.companyId))!, _id: undefined, _creationTime: undefined, name: "Other" } as never);
      return companyId;
    });
    const member = (await s.t.run(async (ctx) => (await ctx.db.query("members").collect()).find((m) => m.companyId === s.companyId)))!;
    expect(await s.t.mutation(internal.qualityHighLevel.installed, { companyId: other, memberId: member._id, locationId: "LOC1", refreshToken: "r", accessToken: "a", accessExpiresAt: Date.now() + DAY })).toBe("location_in_use");
  });
});
