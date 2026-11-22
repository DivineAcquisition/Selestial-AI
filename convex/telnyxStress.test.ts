/**
 * Telnyx under load, end to end: the real outbox, the real Telnyx client and the real /webhooks/telnyx route,
 * against a fake Telnyx that behaves like the documented one (Idempotency-Key replay for 24 hours, 409 while a
 * key is in progress, errors not replayed) and misbehaves on purpose: rate limits, its own errors, answers lost
 * after it took the text, and delivery reports that come early, late, out of order and more than once.
 *
 * What must hold however it goes: no text is ever sent twice; a text Telnyx may have sent is never called
 * failed; every text ends delivered, failed or unconfirmed (never stuck); each delivery is recorded once; and a
 * forged, altered or stale webhook changes nothing.
 *
 * @vitest-environment edge-runtime
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flush } from "../tests/dispatchHarness";
import { company, dispatchCleaner, NOW, readyMessaging, start, type T } from "../tests/harness";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { queueMessage } from "./lib/messaging/outbox";

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

async function signer() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = b64(await crypto.subtle.exportKey("raw", pair.publicKey));
  const sign = async (timestamp: string, body: string) => b64(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(`${timestamp}|${body}`)));
  return { publicKey, sign };
}

/** Reproducible randomness, so a failing run can be run again exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<X>(items: X[], random: () => number): X[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const finalized = (id: string, messageId: string, status: string, code?: string) =>
  JSON.stringify({ data: { id, event_type: "message.finalized", record_type: "event", occurred_at: new Date().toISOString(), payload: { id: messageId, to: [{ phone_number: "+15550101010", status }], cost: { amount: "0.0040", currency: "USD" }, parts: 1, errors: code ? [{ code, title: "x" }] : [] } }, meta: { attempt: 1 } });
const received = (id: string, from: string, to: string, text: string) =>
  JSON.stringify({ data: { id, event_type: "message.received", record_type: "event", occurred_at: new Date().toISOString(), payload: { id: `in-${id}`, from: { phone_number: from }, to: [{ phone_number: to, status: "webhook_delivered" }], text, parts: 1 } }, meta: { attempt: 1 } });

type Behaviour = "ok" | "rate_limited" | "telnyx_error" | "lost_after_accept" | "network_down" | "in_progress";

/**
 * Telnyx as documented: a key it accepted is replayed (same id, Idempotent-Replayed) and never sent twice;
 * errors are not stored, so the same key may be tried again. `plan` decides how each call goes.
 */
function fakeTelnyx(plan: (call: { key: string; attempt: number; n: number }) => Behaviour) {
  const accepted = new Map<string, { id: string; body: string }>();
  /** How many times each key actually went to a phone. Must never pass 1. */
  const handsets = new Map<string, number>();
  const calls: { key: string; behaviour: Behaviour; replayed: boolean }[] = [];
  let ids = 0;
  const perKey = new Map<string, number>();
  const lastBody = new Map<string, string>();
  /** Telnyx finishes the request it was working on under this key: the text goes, once. */
  const complete = (key: string) => {
    ids += 1;
    accepted.set(key, { id: `tx-${ids}`, body: lastBody.get(key)! });
    handsets.set(key, (handsets.get(key) ?? 0) + 1);
  };
  const fetcher = async (url: string, init: RequestInit) => {
    if (!String(url).startsWith("https://api.telnyx.com/v2/messages")) throw new Error(`unexpected request to ${url}`);
    const headers = init.headers as Record<string, string>;
    const key = headers["idempotency-key"];
    const body = String(init.body);
    const n = (perKey.get(key) ?? 0) + 1;
    perKey.set(key, n);
    lastBody.set(key, body);
    const sent = JSON.parse(body) as { to: string };
    const stored = accepted.get(key);
    if (stored) {
      calls.push({ key, behaviour: "ok", replayed: true });
      if (stored.body !== body) return new Response(JSON.stringify({ errors: [{ code: "10037", title: "Idempotency key reused" }] }), { status: 422 });
      return new Response(JSON.stringify({ data: { id: stored.id, parts: 1, to: [{ phone_number: sent.to, status: "queued" }] } }), { status: 200, headers: { "idempotent-replayed": "true" } });
    }
    const behaviour = plan({ key, attempt: n, n: calls.length });
    calls.push({ key, behaviour, replayed: false });
    const take = () => {
      ids += 1;
      const id = `tx-${ids}`;
      accepted.set(key, { id, body });
      handsets.set(key, (handsets.get(key) ?? 0) + 1);
      return id;
    };
    switch (behaviour) {
      case "ok":
        return new Response(JSON.stringify({ data: { id: take(), parts: 1, to: [{ phone_number: sent.to, status: "queued" }] } }), { status: 200 });
      case "rate_limited":
        return new Response(JSON.stringify({ errors: [{ code: "10011", title: "Too many requests" }] }), { status: 429 });
      case "telnyx_error":
        return new Response(JSON.stringify({ errors: [{ code: "10007", title: "Unexpected error" }] }), { status: 503 });
      case "in_progress":
        return new Response(JSON.stringify({ errors: [{ code: "10036", title: "Request in progress" }] }), { status: 409 });
      case "lost_after_accept":
        take();
        throw new TypeError("fetch failed: connection reset");
      case "network_down":
        throw new TypeError("fetch failed: getaddrinfo ENOTFOUND");
    }
  };
  return { fetcher, accepted, handsets, calls, complete };
}

const SMS_FINAL = new Set(["delivered", "failed", "unconfirmed", "not_sent"]);

async function companyWithCleaners(t: T, count: number) {
  const { as, companyId } = await company(t, "owner-stress", "Stress Cleaning");
  const smsNumber = await readyMessaging(t, companyId, "Stress Cleaning");
  const cleaners: { id: Id<"cleaners">; phone: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = await dispatchCleaner(as, companyId, `Cleaner ${i}`);
    const phone = `+1555020${String(1000 + i).slice(-4)}`;
    await as.mutation(api.cleaners.update, { companyId, cleanerId: id, phone });
    cleaners.push({ id, phone });
  }
  return { as, companyId, smsNumber, cleaners };
}

/** Queues one work text to each cleaner, as Dispatch would, all at once. */
async function burst(t: T, companyId: Id<"companies">, cleaners: { id: Id<"cleaners"> }[], tag: string) {
  return t.run(async (ctx) => {
    const ids: Id<"messages">[] = [];
    for (const cleaner of cleaners) {
      const doc = (await ctx.db.get(cleaner.id))!;
      const message = await queueMessage(ctx, { companyId, purpose: "reminder", cleaner: doc, body: `Reminder ${tag}: your visit tomorrow at 9am.`, dedupeKey: `stress:${tag}:${cleaner.id}`, actor: { kind: "system" } });
      ids.push(message._id);
    }
    return ids;
  });
}

const messages = (t: T, ids: Id<"messages">[]) => t.run(async (ctx) => (await Promise.all(ids.map((id) => ctx.db.get(id)))) as Doc<"messages">[]);

/** Runs sends, their retries (30s, 60s apart) and the five-minute sweep, in fake time. */
async function settleEverything(t: T) {
  for (let round = 0; round < 8; round += 1) {
    await flush(t);
    vi.advanceTimersByTime(65_000);
    await t.finishInProgressScheduledFunctions();
  }
  vi.advanceTimersByTime(6 * 60_000);
  await t.mutation(internal.messaging.sweepStuck, {});
  await flush(t);
}

describe("Telnyx stress: sending", () => {
  let publicKey = "";
  let sign: (timestamp: string, body: string) => Promise<string> = async () => "";
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const keys = await signer();
    publicKey = keys.publicKey;
    sign = keys.sign;
    process.env.ACTION_LINK_SECRET = "test-only-secret-for-action-links-0123456789";
    process.env.MESSAGING_PROVIDER = "telnyx";
    process.env.TELNYX_API_KEY = "KEY_test";
    process.env.TELNYX_PUBLIC_KEY = publicKey;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const key of ["ACTION_LINK_SECRET", "MESSAGING_PROVIDER", "TELNYX_API_KEY", "TELNYX_PUBLIC_KEY"]) delete process.env[key];
  });

  const post = async (t: T, body: string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return t.fetch("/webhooks/telnyx", { method: "POST", headers: { "telnyx-signature-ed25519": await sign(ts, body), "telnyx-timestamp": ts }, body });
  };

  it("sends a burst of 60 texts through rate limits, Telnyx errors and lost answers: never twice, never wrongly failed, never stuck", async () => {
    const random = rng(1234);
    const telnyx = fakeTelnyx(({ attempt }) => {
      const roll = random();
      // Later attempts mostly get through, as a real outage clears.
      if (attempt >= 3) return roll < 0.85 ? "ok" : "telnyx_error";
      if (roll < 0.45) return "ok";
      if (roll < 0.65) return "rate_limited";
      if (roll < 0.8) return "telnyx_error";
      if (roll < 0.9) return "lost_after_accept";
      return "network_down";
    });
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const s = await companyWithCleaners(t, 60);
    const ids = await burst(t, s.companyId, s.cleaners, "a");
    await settleEverything(t);

    // Fresh unconfirmed texts are checked with Telnyx by Selestial itself, under the same key. A check whose own
    // answer is lost is swept and checked again on the next run, for 30 minutes from the first attempt.
    for (let run = 0; run < 3; run += 1) {
      await t.mutation(internal.operations.runCheck, { check: "uncertain_messages" });
      await settleEverything(t);
    }

    const rows = await messages(t, ids);
    const byStatus: Record<string, number> = {};
    for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    // Nothing is left in flight.
    expect(rows.filter((row) => !SMS_FINAL.has(row.status) && row.status !== "sent").map((row) => row.status)).toEqual([]);
    // No key reached a phone twice.
    expect([...telnyx.handsets.values()].every((count) => count === 1)).toBe(true);
    for (const row of rows) {
      const key = `selestial-${row._id}`;
      const atTelnyx = telnyx.accepted.get(key);
      // A text Telnyx took is never called failed or not sent.
      if (atTelnyx) expect({ id: row._id, status: row.status }).not.toMatchObject({ status: expect.stringMatching(/^(failed|not_sent)$/) });
      // A text recorded as sent carries the id Telnyx gave the one it took.
      if (row.status === "sent" || row.status === "delivered") expect(row.providerMessageId).toBe(atTelnyx?.id);
      // A failed text was never taken by Telnyx.
      if (row.status === "failed") expect(atTelnyx).toBeUndefined();
    }
    // Every answer that was lost after Telnyx took the text was recovered as sent by the replay, not sent again.
    const lost = telnyx.calls.filter((call) => call.behaviour === "lost_after_accept").map((call) => call.key);
    expect(lost.length).toBeGreaterThan(0);
    const recovered = lost.map((key) => rows.find((row) => `selestial-${row._id}` === key)!.status);
    expect(recovered.every((status) => status === "sent" || status === "unconfirmed")).toBe(true);
    expect(recovered.filter((status) => status === "sent").length).toBeGreaterThanOrEqual(Math.ceil(lost.length * 0.75));
    // None is stuck behind a check that never finished: each can be checked again.
    expect(rows.filter((row) => row.status === "unconfirmed" && row.reconcile)).toEqual([]);
    expect(telnyx.calls.some((call) => call.replayed)).toBe(true);
    // Most went; a handful may still have failed after three tries of a Telnyx outage.
    expect(byStatus.sent ?? 0).toBeGreaterThanOrEqual(50);
  });

  it("records each delivery once when reports come shuffled, early, three times over, and some before the send's own answer", async () => {
    const random = rng(99);
    const t = start();
    const early: string[] = [];
    let inner = fakeTelnyx(() => "ok");
    // A third of the texts get their delivery report before the send's own answer comes back.
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const response = await inner.fetcher(url, init);
      const json = (await response.clone().json()) as { data?: { id?: string } };
      if (json.data?.id && random() < 0.33) {
        early.push(json.data.id);
        expect((await post(t, finalized(`ev-early-${json.data.id}`, json.data.id, "delivered"))).status).toBe(200);
      }
      return response;
    });
    inner = fakeTelnyx(() => "ok");
    const s = await companyWithCleaners(t, 40);
    const ids = await burst(t, s.companyId, s.cleaners, "b");
    await settleEverything(t);
    expect(early.length).toBeGreaterThan(5);

    const rows = await messages(t, ids);
    expect(rows.every((row) => row.providerMessageId)).toBe(true);
    // Delivered for most, failed (by the carrier) for every fifth; each report sent three times with its own event id, shuffled.
    const reports = rows.flatMap((row, i) => {
      const failed = i % 5 === 0;
      const body = finalized(`ev-${row.providerMessageId}`, row.providerMessageId!, failed ? "delivery_failed" : "delivered", failed ? "40001" : undefined);
      return [body, body, body];
    });
    const results = await Promise.all(shuffle(reports, random).map((body) => post(t, body)));
    expect(results.every((response) => response.status === 200)).toBe(true);
    await flush(t);

    const after = await messages(t, ids);
    after.forEach((row, i) => {
      // The early "delivered" report for a text the carrier later failed: a delivered text stays delivered.
      const deliveredEarly = early.includes(row.providerMessageId!);
      expect({ i, status: row.status }).toEqual({ i, status: i % 5 === 0 && !deliveredEarly ? "failed" : "delivered" });
    });
    const events = await t.run(async (ctx) => (await ctx.db.query("events").collect()).filter((event) => event.type === "message.delivered"));
    const perMessage = new Map<string, number>();
    for (const event of events) perMessage.set(String(event.subject?.id), (perMessage.get(String(event.subject?.id)) ?? 0) + 1);
    expect([...perMessage.values()].every((count) => count === 1)).toBe(true);
    expect(perMessage.size).toBe(after.filter((row) => row.status === "delivered").length);
  });

  it("never calls a text failed while Telnyx keeps saying an earlier attempt under its key is still in progress", async () => {
    const telnyx = fakeTelnyx(() => "in_progress");
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const s = await companyWithCleaners(t, 3);
    const ids = await burst(t, s.companyId, s.cleaners, "c");
    await settleEverything(t);
    const rows = await messages(t, ids);
    // 409 means Telnyx is working on this exact key: the text may well have gone. Unknown, never failed.
    expect(rows.map((row) => row.status)).toEqual(["unconfirmed", "unconfirmed", "unconfirmed"]);
    expect(telnyx.calls.length).toBe(3);
    // When Telnyx has finished, Selestial's own check under the same key finds the text it took, and sends nothing new.
    for (const row of rows) telnyx.complete(`selestial-${row._id}`);
    await t.mutation(internal.operations.runCheck, { check: "uncertain_messages" });
    await settleEverything(t);
    expect((await messages(t, ids)).map((row) => row.status)).toEqual(["sent", "sent", "sent"]);
    expect([...telnyx.handsets.values()].every((count) => count <= 1)).toBe(true);
  });

  it("sends the same message once however many times it is queued at the same moment", async () => {
    const telnyx = fakeTelnyx(() => "ok");
    vi.stubGlobal("fetch", telnyx.fetcher);
    const t = start();
    const s = await companyWithCleaners(t, 5);
    const batches = await Promise.all(Array.from({ length: 6 }, () => burst(t, s.companyId, s.cleaners, "d")));
    expect(new Set(batches.flat()).size).toBe(5);
    // Each delivery started again (a retry storm from the scheduler) changes nothing.
    for (const id of batches[0]) await t.action(internal.messaging.deliver, { messageId: id });
    await settleEverything(t);
    expect(telnyx.calls.length).toBe(5);
    expect((await messages(t, batches[0])).every((row) => row.status === "sent")).toBe(true);
  });
});

describe("Telnyx stress: the webhook route and incoming texts", () => {
  let sign: (timestamp: string, body: string) => Promise<string> = async () => "";
  let forger: (timestamp: string, body: string) => Promise<string> = async () => "";
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const keys = await signer();
    sign = keys.sign;
    forger = (await signer()).sign;
    process.env.ACTION_LINK_SECRET = "test-only-secret-for-action-links-0123456789";
    process.env.MESSAGING_PROVIDER = "telnyx";
    process.env.TELNYX_API_KEY = "KEY_test";
    process.env.TELNYX_PUBLIC_KEY = keys.publicKey;
    vi.stubGlobal("fetch", fakeTelnyx(() => "ok").fetcher);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const key of ["ACTION_LINK_SECRET", "MESSAGING_PROVIDER", "TELNYX_API_KEY", "TELNYX_PUBLIC_KEY"]) delete process.env[key];
  });

  it("refuses 200 forged, altered, stale and unsigned webhooks and changes nothing", async () => {
    const t = start();
    const s = await companyWithCleaners(t, 2);
    const now = Math.floor(Date.now() / 1000);
    const attacks: { headers: Record<string, string>; body: string }[] = [];
    for (let i = 0; i < 50; i += 1) {
      const body = received(`atk-${i}`, s.cleaners[0].phone, s.smsNumber, "STOP");
      const ts = String(now);
      attacks.push({ headers: { "telnyx-signature-ed25519": await forger(ts, body), "telnyx-timestamp": ts }, body });
      const signed = await sign(ts, body);
      attacks.push({ headers: { "telnyx-signature-ed25519": signed, "telnyx-timestamp": ts }, body: body.replace("STOP", "START") });
      const stale = String(now - 10 * 60);
      attacks.push({ headers: { "telnyx-signature-ed25519": await sign(stale, body), "telnyx-timestamp": stale }, body });
      attacks.push({ headers: {}, body });
    }
    const results = await Promise.all(attacks.map((attack) => t.fetch("/webhooks/telnyx", { method: "POST", headers: attack.headers, body: attack.body })));
    expect(results.every((response) => response.status === 401)).toBe(true);
    const state = await t.run(async (ctx) => ({ suppressions: (await ctx.db.query("suppressions").collect()).length, receipts: (await ctx.db.query("providerReceipts").collect()).length, inbound: (await ctx.db.query("inboundMessages").collect()).length }));
    expect(state).toEqual({ suppressions: 0, receipts: 0, inbound: 0 });
  });

  it("handles a storm of STOP, START, HELP and replies from 25 numbers, each delivered twice and out of order, exactly once each", async () => {
    const random = rng(7);
    const t = start();
    const s = await companyWithCleaners(t, 25);
    const post = async (body: string) => {
      const ts = String(Math.floor(Date.now() / 1000));
      return (await t.fetch("/webhooks/telnyx", { method: "POST", headers: { "telnyx-signature-ed25519": await sign(ts, body), "telnyx-timestamp": ts }, body })).status;
    };
    // Round 1: everyone texts STOP (twice over, as Telnyx retries), and a few also say something ordinary.
    const round1 = s.cleaners.flatMap((cleaner, i) => {
      const stop = received(`stop-${i}`, cleaner.phone, s.smsNumber, i % 3 === 0 ? "stop" : "STOP");
      return i % 4 === 0 ? [stop, stop, received(`hi-${i}`, cleaner.phone, s.smsNumber, "running late")] : [stop, stop];
    });
    expect((await Promise.all(shuffle(round1, random).map(post))).every((status) => status === 200)).toBe(true);
    await flush(t);
    const active = async () => t.run(async (ctx) => (await ctx.db.query("suppressions").collect()).filter((row) => row.liftedAt === undefined && row.channel === "sms"));
    expect((await active()).length).toBe(25);
    const replies = async (kind: string) => t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((row) => row.purpose === "compliance_reply" && row.body.includes(kind)));
    // One confirmation each, not two.
    expect((await replies("no longer receive")).length).toBe(25);

    // Round 2: a second STOP with a new event id gets no new confirmation; START from the even ones lifts it once.
    const round2 = s.cleaners.flatMap((cleaner, i) => (i % 2 === 0 ? [received(`start-${i}`, cleaner.phone, s.smsNumber, "START"), received(`start-${i}`, cleaner.phone, s.smsNumber, "START")] : [received(`stop2-${i}`, cleaner.phone, s.smsNumber, "STOP")]));
    for (const body of shuffle(round2, random)) expect(await post(body)).toBe(200);
    await flush(t);
    expect((await active()).length).toBe(12);
    expect((await replies("no longer receive")).length).toBe(25);
    expect((await replies("receive texts from Stress Cleaning again")).length).toBe(13);

    // A text to a cleaner who stopped is refused by policy; to one who restarted, it goes.
    const ids = await burst(t, s.companyId, s.cleaners, "after");
    await flush(t);
    const rows = await messages(t, ids);
    rows.forEach((row, i) => expect({ i, status: row.status }).toEqual({ i, status: i % 2 === 0 ? "sent" : "not_sent" }));
  });
});
