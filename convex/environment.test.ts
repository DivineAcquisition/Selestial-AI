import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import { autumnConfig } from "./lib/billing/autumn";
import { emailProvider } from "./lib/email/provider";
import { deploymentName, environment, movedTo, NOT_SENT_ON_TEST, PRODUCTION_DEPLOYMENTS, publicApiOrigin, testRecipientAllowed } from "./lib/environment";
import { stripeConfig } from "./lib/finance/stripe";
import { orderNumber, searchNumbers } from "./lib/messaging/telnyxAccount";
import { telnyxProvider } from "./lib/messaging/telnyx";
import { recipientOf, sendFromGmail } from "./lib/recruiter/gmail";
import { company, readyMessaging, refusal, seedVisit, start, staffWith } from "../tests/harness";

const TEST_BACKEND = "https://happy-otter-123.convex.cloud";
const LIVE_BACKEND = `https://${PRODUCTION_DEPLOYMENTS[0]}.convex.cloud`;
const SAVED = ["CONVEX_CLOUD_URL", "MOVED_TO", "TEST_RECIPIENTS", "EMAIL_PROVIDER", "RESEND_API_KEY", "EMAIL_FROM", "TELNYX_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "AUTUMN_SECRET_KEY", "STAFF_BOOTSTRAP_EMAIL"];
const raw = (to: string) => btoa(`To: Customer <${to}>\r\nSubject: Hi\r\n\r\nHello`).replace(/\+/g, "-").replace(/\//g, "_");

describe("Which backend this is, and what a backend that is not production may do", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of SAVED) saved[name] = process.env[name];
  });
  afterEach(() => {
    for (const name of SAVED) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    vi.restoreAllMocks();
  });

  test("production is the live deployment by name; every other deployment is not; the test harness is unknown", () => {
    expect(environment({})).toBe("unknown");
    expect(environment({ CONVEX_CLOUD_URL: LIVE_BACKEND })).toBe("production");
    expect(environment({ CONVEX_CLOUD_URL: TEST_BACKEND })).toBe("non_production");
    expect(environment({ CONVEX_CLOUD_URL: "https://restored-copy-9.convex.cloud" })).toBe("non_production");
  });

  test("the build script names the same live deployment", () => {
    const script = readFileSync(path.join(process.cwd(), "scripts/build.mjs"), "utf8");
    const listed = /const PRODUCTION_DEPLOYMENTS = (\[[^\]]*\])/.exec(script)?.[1];
    expect(JSON.parse(listed!.replace(/'/g, '"'))).toEqual([...PRODUCTION_DEPLOYMENTS]);
  });

  test("a preview built against the live backend is built with no backend; against the test backend it keeps it", () => {
    const bin = mkdtempSync(path.join(tmpdir(), "fake-npx-"));
    writeFileSync(path.join(bin, "npx"), '#!/bin/sh\necho "BACKEND=[${NEXT_PUBLIC_CONVEX_URL}]"\n');
    chmodSync(path.join(bin, "npx"), 0o755);
    const build = (url: string) =>
      execFileSync(process.execPath, [path.join(process.cwd(), "scripts/build.mjs")], { env: { PATH: `${bin}:${process.env.PATH}`, VERCEL_ENV: "preview", NEXT_PUBLIC_CONVEX_URL: url } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
    const live = build(LIVE_BACKEND);
    expect(live).toContain("left out");
    expect(live).toContain("BACKEND=[]");
    expect(build(TEST_BACKEND)).toContain(`BACKEND=[${TEST_BACKEND}]`);
  });

  test("email from a test backend reaches only its test recipients", async () => {
    process.env.CONVEX_CLOUD_URL = TEST_BACKEND;
    process.env.TEST_RECIPIENTS = "qa@selestial.example, +1 512 555 0100";
    Object.assign(process.env, { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test", EMAIL_FROM: "Selestial <hello@selestial.io>" });
    const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    const provider = emailProvider()!;
    const blocked = await provider.send({ to: "real.customer@gmail.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi", idempotencyKey: "k1" });
    expect(blocked).toEqual({ ok: false, retryable: false, problem: NOT_SENT_ON_TEST });
    expect(fetched).not.toHaveBeenCalled();
    expect((await provider.send({ to: "QA@selestial.example", subject: "Hi", html: "<p>Hi</p>", text: "Hi", idempotencyKey: "k2" })).ok).toBe(true);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(testRecipientAllowed("(512) 555-0100")).toBe(true);
    expect(testRecipientAllowed("+15125550199")).toBe(false);
  });

  test("texts and Gmail sends from a test backend never reach a real person; on the live backend they go", async () => {
    process.env.CONVEX_CLOUD_URL = TEST_BACKEND;
    process.env.TELNYX_API_KEY = "KEY_TEST";
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { id: "m1" } }), { status: 200 }));
    const text = await telnyxProvider(fetcher as unknown as typeof fetch).send({ to: "+15125550199", from: "+15125550100", body: "Hi", idempotencyKey: "k", attempt: 1 });
    expect(text).toEqual({ ok: false, retryable: false, problem: NOT_SENT_ON_TEST });
    expect(recipientOf(raw("someone@gmail.com"))).toBe("someone@gmail.com");
    expect(await sendFromGmail({ token: "t", raw: raw("someone@gmail.com"), fetch: fetcher as unknown as typeof fetch })).toEqual({ ok: false, retryable: false, problem: NOT_SENT_ON_TEST });
    expect(fetcher).not.toHaveBeenCalled();
    process.env.CONVEX_CLOUD_URL = LIVE_BACKEND;
    await telnyxProvider(fetcher as unknown as typeof fetch).send({ to: "+15125550199", from: "+15125550100", body: "Hi", idempotencyKey: "k", attempt: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("a test backend may look numbers up at Telnyx but never buys one", async () => {
    process.env.CONVEX_CLOUD_URL = TEST_BACKEND;
    process.env.TELNYX_API_KEY = "KEY_TEST";
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const order = await orderNumber(fetcher as unknown as typeof fetch, { phoneNumber: "+15125550100", messagingProfileId: null, reference: "r1" });
    expect(order).toMatchObject({ ok: false, retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
    await searchNumbers(fetcher as unknown as typeof fetch, { areaCode: "512", limit: 5 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("a test backend ignores live Stripe and Autumn keys, so it can never charge a real card", () => {
    process.env.CONVEX_CLOUD_URL = TEST_BACKEND;
    process.env.STRIPE_SECRET_KEY = "sk_live_example";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_example";
    process.env.AUTUMN_SECRET_KEY = "am_sk_live_example";
    expect(stripeConfig()).toBeNull();
    expect(autumnConfig()).toBeNull();
    process.env.STRIPE_SECRET_KEY = "sk_test_example";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_example";
    process.env.AUTUMN_SECRET_KEY = "am_sk_test_example";
    expect(stripeConfig()).toMatchObject({ livemode: false });
    expect(autumnConfig()).toMatchObject({ env: "sandbox" });
    process.env.CONVEX_CLOUD_URL = LIVE_BACKEND;
    process.env.STRIPE_SECRET_KEY = "sk_live_example";
    expect(stripeConfig()).toMatchObject({ livemode: true });
  });

  test("a backend that used to be live forwards only to a Convex site, and never while it is production", () => {
    const live = `https://${PRODUCTION_DEPLOYMENTS[0]}.convex.site`;
    expect(movedTo({ CONVEX_CLOUD_URL: TEST_BACKEND, MOVED_TO: `${live}/` })).toBe(live);
    expect(movedTo({ CONVEX_CLOUD_URL: TEST_BACKEND })).toBeNull();
    expect(movedTo({ CONVEX_CLOUD_URL: LIVE_BACKEND, MOVED_TO: "https://other-name-1.convex.site" })).toBeNull();
    expect(movedTo({ CONVEX_CLOUD_URL: TEST_BACKEND, MOVED_TO: "https://example.com" })).toBeNull();
    expect(movedTo({ CONVEX_CLOUD_URL: TEST_BACKEND, MOVED_TO: "https://happy-otter-123.convex.site" })).toBeNull();
    expect(movedTo({ MOVED_TO: live })).toBeNull();
  });

  test("old addresses on a backend that used to be live are answered by the live backend, unchanged", async () => {
    const live = `https://${PRODUCTION_DEPLOYMENTS[0]}.convex.site`;
    const seen: { url: string; method: string; body: string | null; signature: string | null }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(input), method: init.method ?? "GET", body: init.body ? String(init.body) : null, signature: new Headers(init.headers).get("telnyx-signature-ed25519") });
      return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "content-type": "application/json" } });
    });
    try {
      const t = start();
      process.env.CONVEX_CLOUD_URL = TEST_BACKEND;
      process.env.MOVED_TO = live;
      const webhook = await t.fetch("/webhooks/telnyx?x=1", { method: "POST", headers: { "content-type": "application/json", "telnyx-signature-ed25519": "sig" }, body: '{"data":{}}' });
      expect(webhook.status).toBe(202);
      const unsubscribe = await t.fetch("/notify/unsubscribe?t=token-1", { method: "POST", body: "List-Unsubscribe=One-Click" });
      expect(unsubscribe.status).toBe(202);
      expect(seen).toEqual([
        { url: `${live}/webhooks/telnyx?x=1`, method: "POST", body: '{"data":{}}', signature: "sig" },
        { url: `${live}/notify/unsubscribe?t=token-1`, method: "POST", body: "List-Unsubscribe=One-Click", signature: null },
      ]);
      // Without MOVED_TO the route answers itself again (an unsigned callback is refused).
      delete process.env.MOVED_TO;
      expect((await t.fetch("/webhooks/telnyx", { method: "POST", body: "{}" })).status).toBe(401);
      expect(seen.length).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Staff controls need their capability", () => {
  const STAFF = { subject: "user_ops", email: "ops@selestial.example", emailVerified: true, name: "Ops" };
  afterEach(() => {
    delete process.env.STAFF_BOOTSTRAP_EMAIL;
  });

  test("emergency suspension needs outbound.suspend and a reason; a reviewer cannot", async () => {
    const t = start();
    const { companyId } = await company(t, "owner_a", "Alpha");
    const reviewer = { subject: "user_rev", email: "rev@selestial.example", emailVerified: true, name: "Rev" };
    await t.run((ctx) => ctx.db.insert("staff", { userId: reviewer.subject, email: reviewer.email, name: "Rev", role: "reviewer", status: "active", addedAt: 0, addedBy: "console" }));
    expect(await refusal(t.withIdentity(reviewer).mutation(api.compliance.setSuspended, { companyId, suspended: true, note: "Carrier complaint under review" }))).toBe("Not allowed.");
    await staffWith(t, STAFF, []);
    // Admins hold outbound.suspend by their role.
    expect(await refusal(t.withIdentity(STAFF).mutation(api.compliance.setSuspended, { companyId, suspended: true, note: "spam" }))).toContain("Say why");
    await t.withIdentity(STAFF).mutation(api.compliance.setSuspended, { companyId, suspended: true, note: "Carrier complaint under review" });
    expect((await t.run((ctx) => ctx.db.get(companyId)))!.suspendedAt).toBeDefined();
  });

  test("a paused agent's planned message is refused when it would go, and resuming does not release it", async () => {
    const t = start();
    const { companyId, as: owner } = await company(t, "owner_a", "Alpha");
    await readyMessaging(t, companyId);
    const messageId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", { companyId, purpose: "sales_follow_up", body: "Still interested?", to: "+15125550123", dedupeKey: "f1", status: "queued", attempts: 0, queuedAt: Date.now() });
      await ctx.db.insert("sendIntents", { companyId, messageId: id, channel: "sms", address: "+15125550123", category: "operational", origin: "follow_up", agent: "sales", at: Date.now() });
      return id;
    });
    await owner.mutation(api.companies.setPausedAgents, { companyId, agents: ["sales"] });
    expect(await t.mutation(internal.messaging.claim, { messageId })).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(messageId))).toMatchObject({ status: "not_sent", refusal: "agent_paused" });
    await owner.mutation(api.companies.setPausedAgents, { companyId, agents: [] });
    expect(await t.mutation(internal.messaging.claim, { messageId })).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(messageId)))!.status).toBe("not_sent");
  });
});

describe("Restoring without replaying anything", () => {
  test("lock-down suspends sending and pauses every agent, remembering each company's settings, and release puts them back", async () => {
    const t = start();
    const a = await company(t, "owner_a", "Alpha");
    const b = await company(t, "owner_b", "Bravo");
    await a.as.mutation(api.companies.setPausedAgents, { companyId: a.companyId, agents: ["recruiter"] });
    await t.run((ctx) => ctx.db.insert("messages", { companyId: b.companyId, purpose: "reminder", body: "x", to: "+15125550123", dedupeKey: "s1", status: "sending", attempts: 1, queuedAt: Date.now(), attemptedAt: Date.now() }));
    const locked = await t.mutation(internal.restoration.lockDown, { reason: "Restored from the 03:00 backup" });
    expect(locked).toMatchObject({ locked: 2, done: true });
    // Running it again changes nothing.
    expect(await t.mutation(internal.restoration.lockDown, { reason: "again" })).toMatchObject({ lockdownId: locked.lockdownId, locked: 0 });
    for (const id of [a.companyId, b.companyId]) {
      const row = (await t.run((ctx) => ctx.db.get(id)))!;
      expect(row.suspendedAt).toBeDefined();
      expect([...row.pausedAgents].sort()).toEqual(["dispatch", "recruiter", "retention", "sales"]);
    }
    const status = await t.query(internal.restoration.status, {});
    expect(status.lockdown).toMatchObject({ lockedCompanies: 2 });
    expect(status.toReconcile.messages.sending).toBe(1);
    const verified = await t.action(internal.restoration.verify, {});
    // No orphaned rows; the one message caught mid-send is named as something to look up before release.
    expect(verified.problems).toEqual(["1 messages may or may not have gone: look each up at its provider before release."]);
    expect(verified.companies).toBe(2);

    await expect(t.mutation(internal.restoration.release, { lockdownId: locked.lockdownId, note: "ok" })).rejects.toThrow(/reconciled/);
    await t.mutation(internal.restoration.release, { lockdownId: locked.lockdownId, note: "Reconciled the outbox with Telnyx and Resend, charges with Autumn" });
    const alpha = (await t.run((ctx) => ctx.db.get(a.companyId)))!;
    expect(alpha.suspendedAt).toBeUndefined();
    expect(alpha.pausedAgents).toEqual(["recruiter"]);
    expect((await t.run((ctx) => ctx.db.get(b.companyId)))!.pausedAgents).toEqual([]);
  });
});

describe("custom domains", () => {
  test("a custom domain set as the live backend's client address still reads as production; an unknown one never does", () => {
    expect(deploymentName({ CONVEX_CLOUD_URL: "https://api.selestial.io" })).toBe("stoic-gazelle-731");
    expect(environment({ CONVEX_CLOUD_URL: "https://api.selestial.io/" })).toBe("production");
    expect(environment({ CONVEX_CLOUD_URL: "https://stoic-gazelle-731.convex.cloud" })).toBe("production");
    expect(environment({ CONVEX_CLOUD_URL: "https://api.someone-else.example" })).toBe("non_production");
    expect(environment({ CONVEX_CLOUD_URL: "https://terrific-avocet-835.convex.cloud" })).toBe("non_production");
  });

  test("people see api.selestial.io for the live backend's HTTP routes, and each other backend's own site address", () => {
    expect(publicApiOrigin({ CONVEX_CLOUD_URL: "https://stoic-gazelle-731.convex.cloud", CONVEX_SITE_URL: "https://stoic-gazelle-731.convex.site" })).toBe("https://api.selestial.io");
    expect(publicApiOrigin({ CONVEX_CLOUD_URL: "https://terrific-avocet-835.convex.cloud", CONVEX_SITE_URL: "https://terrific-avocet-835.convex.site" })).toBe("https://terrific-avocet-835.convex.site");
    expect(publicApiOrigin({ CONVEX_CLOUD_URL: "https://terrific-avocet-835.convex.cloud", PUBLIC_API_ORIGIN: "https://hooks.example.com/" })).toBe("https://hooks.example.com");
    expect(publicApiOrigin({})).toBeNull();
  });

  test("release undoes only what the lock-down set: staff suspensions, an unpaid-plan lock and changed pauses are left alone and reported", async () => {
    const t = start();
    const STAFF = { subject: "user_staff_restore", email: "staff@selestial.test", name: "Staff" };
    await staffWith(t, STAFF, ["outbound.suspend"]);
    const staff = t.withIdentity({ ...STAFF, emailVerified: true });
    const plain = await company(t, "owner_a", "Alpha");
    const before = await company(t, "owner_b", "Bravo");
    const during = await company(t, "owner_c", "Charlie");
    const unpaid = await company(t, "owner_d", "Delta");
    const changed = await company(t, "owner_e", "Echo");
    await plain.as.mutation(api.companies.setPausedAgents, { companyId: plain.companyId, agents: ["recruiter"] });
    await unpaid.as.mutation(api.companies.setPausedAgents, { companyId: unpaid.companyId, agents: ["sales"] });
    // Bravo was suspended by staff before the restore.
    await staff.mutation(api.compliance.setSuspended, { companyId: before.companyId, suspended: true, note: "Carrier complaint under review." });
    const earlier = (await t.run((ctx) => ctx.db.get(before.companyId)))!.suspendedAt!;

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      const locked = await t.mutation(internal.restoration.lockDown, { reason: "Restored from the 03:00 backup" });
      expect(locked).toMatchObject({ locked: 5, done: true });
      vi.setSystemTime(Date.now() + 60_000);
      // During the lock-down: staff suspend Charlie for their own reason (the time on the company does not change)...
      await staff.mutation(api.compliance.setSuspended, { companyId: during.companyId, suspended: true, note: "Reported for spam during the incident." });
      // ...Delta's plan goes unpaid and locks, remembering the lock-down's pauses as if they were the Owner's...
      const lockedAt = Date.now();
      const dunningId = await t.run(async (ctx) => {
        const all = (await ctx.db.get(unpaid.companyId))!.pausedAgents;
        await ctx.db.patch(unpaid.companyId, { billingLockedAt: lockedAt });
        return ctx.db.insert("billingDunning", { companyId: unpaid.companyId, env: "sandbox", invoiceId: "in_test_1", attempts: 4, amountCents: 9900, currency: "usd", hostedUrl: null, firstFailedAt: lockedAt, lastFailedAt: lockedAt, nextAttemptAt: null, lockedAt, priorPausedAgents: all, events: [], updatedAt: lockedAt });
      });
      // ...and someone sets Echo's pauses by hand.
      await t.run((ctx) => ctx.db.patch(changed.companyId, { pausedAgents: ["dispatch"] }));

      vi.setSystemTime(Date.now() + 60_000);
      const released = await t.mutation(internal.restoration.release, { lockdownId: locked.lockdownId, note: "Reconciled the outbox with Telnyx and Resend, charges with Autumn and Stripe" });
      // Alpha and Bravo go back exactly as they were; the other three are reported.
      expect(released).toMatchObject({ restored: 2, done: true });
      expect(released.skipped).toHaveLength(3);
      const why = Object.fromEntries(released.skipped.map((row) => [row.companyId, row.why]));

      // Alpha: exactly as it was.
      const alpha = (await t.run((ctx) => ctx.db.get(plain.companyId)))!;
      expect(alpha.suspendedAt).toBeUndefined();
      expect(alpha.pausedAgents).toEqual(["recruiter"]);
      // Bravo: suspended before, still suspended at the same time; its agents come back.
      const bravo = (await t.run((ctx) => ctx.db.get(before.companyId)))!;
      expect(bravo.suspendedAt).toBe(earlier);
      expect(bravo.pausedAgents).toEqual([]);
      // Charlie: staff suspended it during the lock-down, so release does not lift that.
      const charlie = (await t.run((ctx) => ctx.db.get(during.companyId)))!;
      expect(charlie.suspendedAt).toBeDefined();
      expect(why[during.companyId]).toMatch(/suspension changed since the lock-down/);
      // Delta: locked for an unpaid plan, so every agent stays paused, and paying gives back the Owner's own choice.
      const delta = (await t.run((ctx) => ctx.db.get(unpaid.companyId)))!;
      expect(delta.suspendedAt).toBeUndefined();
      expect(delta.billingLockedAt).toBe(lockedAt);
      expect([...delta.pausedAgents].sort()).toEqual(["dispatch", "recruiter", "retention", "sales"]);
      expect((await t.run((ctx) => ctx.db.get(dunningId)))!.priorPausedAgents).toEqual(["sales"]);
      expect(why[unpaid.companyId]).toMatch(/unpaid plan/);
      // Echo: its pauses were changed since, so they are left as they are; its suspension was the lock-down's own.
      const echo = (await t.run((ctx) => ctx.db.get(changed.companyId)))!;
      expect(echo.pausedAgents).toEqual(["dispatch"]);
      expect(echo.suspendedAt).toBeUndefined();
      expect(why[changed.companyId]).toMatch(/agent pauses changed/);
    } finally {
      vi.useRealTimers();
    }
  });

  test("status and verify list what must be reconciled first: in-flight card payments and refunds, unconfirmed messages, and messages that lost their timers", async () => {
    const t = start();
    const a = await company(t, "owner_a", "Alpha");
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const visit = await seedVisit(a.as, a.companyId);
    await t.run((ctx) => ctx.db.patch(visit.jobId, { status: "completed" }));
    const { invoiceId } = await a.as.mutation(api.finance.createInvoice, { companyId: a.companyId, jobId: visit.jobId });
    await t.run(async (ctx) => {
      const payment = { companyId: a.companyId, invoiceId, customerId: visit.customerId, amountCents: 18500, method: "card" as const, source: "stripe" as const, refundedCents: 0, createdAt: now, updatedAt: now };
      const stripe = { accountId: "acct_1", livemode: false, createTries: 1 };
      await ctx.db.insert("payments", { ...payment, status: "processing", clientKey: "k1", stripe: { ...stripe, paymentIntentId: "pi_processing" } });
      await ctx.db.insert("payments", { ...payment, status: "checking", clientKey: "k2", stripe: { ...stripe, paymentIntentId: "pi_checking" } });
      // A pay page nobody opened has nothing at Stripe; a settled payment is not in flight.
      await ctx.db.insert("payments", { ...payment, status: "awaiting_customer", clientKey: "k3" });
      const paid = await ctx.db.insert("payments", { ...payment, status: "succeeded", clientKey: "k4", stripe: { ...stripe, paymentIntentId: "pi_done" } });
      await ctx.db.insert("refunds", { companyId: a.companyId, paymentId: paid, invoiceId, customerId: visit.customerId, amountCents: 500, reason: "Missed a room", status: "pending", alsoCredit: false, stripeRefundId: "re_pending", tries: 1, clientKey: "r1", createdAt: now, updatedAt: now });
      const message = { companyId: a.companyId, purpose: "reminder" as const, body: "See you tomorrow", to: "+15125550123", attempts: 1 };
      await ctx.db.insert("messages", { ...message, dedupeKey: "m-unconfirmed", status: "unconfirmed", provider: "telnyx", providerMessageId: "tx_1", queuedAt: now - HOUR, attemptedAt: now - HOUR });
      await ctx.db.insert("messages", { ...message, dedupeKey: "m-queued-old", status: "queued", attempts: 0, queuedAt: now - 5 * HOUR });
      await ctx.db.insert("messages", { ...message, dedupeKey: "m-queued-new", status: "queued", attempts: 0, queuedAt: now - 60_000 });
      await ctx.db.insert("messages", { ...message, dedupeKey: "m-scheduled-past", status: "held", attempts: 0, queuedAt: now - 30 * HOUR, scheduledFor: now - 6 * HOUR });
      await ctx.db.insert("messages", { ...message, dedupeKey: "m-scheduled-later", status: "held", attempts: 0, queuedAt: now - HOUR, scheduledFor: now + 6 * HOUR });
    });
    const status = await t.query(internal.restoration.status, {});
    expect(status.toReconcile.payments).toMatchObject({ payment_processing: 1, payment_checking: 1, refund_pending: 1 });
    expect(status.stuckMessages.map((row) => [row.status, row.dueAt === null]).sort()).toEqual([["held", false], ["queued", true]]);

    const verified = await t.action(internal.restoration.verify, {});
    expect(verified.reconcileFirst.payments.map((row) => row.stripePaymentIntent).sort()).toEqual(["pi_checking", "pi_processing"]);
    expect(verified.reconcileFirst.refunds.map((row) => row.stripeRefund)).toEqual(["re_pending"]);
    expect(verified.reconcileFirst.unconfirmedMessages).toMatchObject([{ status: "unconfirmed", provider: "telnyx", providerMessageId: "tx_1" }]);
    expect(verified.reconcileFirst.stuckMessages).toHaveLength(2);
    expect(verified.problems.join(" ")).toMatch(/2 card payments are in progress.*1 refunds are in progress.*1 messages may or may not have gone.*2 queued or scheduled messages have lost their send timers/);
    // Ids and states only: no message body, no amount, no address.
    expect(JSON.stringify(verified.reconcileFirst)).not.toMatch(/See you tomorrow|5125550123|18500/);
    // Nothing is sent or scheduled by looking.
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(0);
  });
});
