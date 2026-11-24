/**
 * @vitest-environment edge-runtime
 *
 * Square payments in Finance (docs/finance/square.md), against a stand-in for Square's API
 * (tests/fakeSquare.ts): connecting through OAuth and confirming the business, locations, the pay page's
 * hosted checkout, webhooks, refunds, reconciliation, losing and ending access, and switching providers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { company, dispatchJob, dispatchPlace, NOW, refusal, start, type T } from "../tests/harness";
import { fakeSquare } from "../tests/fakeSquare";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { payToken } from "./lib/finance/payLinks";
import { setSquareTransportForTests, signForTests, squareConfig } from "./lib/finance/square";

const SECRET = "test-only-secret-for-action-links-0123456789";
const SIGNATURE_KEY = "square-webhook-signature-key-for-tests";
const SITE = "https://test-backend.convex.site";
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const key = (n: number | string) => `client-key-${n}-0000`;

let square = fakeSquare();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  square = fakeSquare();
  setSquareTransportForTests(square.fetch);
  process.env.ACTION_LINK_SECRET = SECRET;
  process.env.APP_ORIGIN = "https://app.selestial.test";
  process.env.LINK_ORIGIN = "https://link.selestial.test";
  process.env.CONVEX_SITE_URL = SITE;
  process.env.SQUARE_APPLICATION_ID = "sandbox-sq0idb-TESTAPPLICATION0001";
  process.env.SQUARE_APPLICATION_SECRET = "sandbox-sq0csb-test-secret";
  process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = SIGNATURE_KEY;
  process.env.MAILBOX_TOKEN_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
});
afterEach(() => {
  vi.useRealTimers();
  setSquareTransportForTests(null);
  for (const name of ["ACTION_LINK_SECRET", "APP_ORIGIN", "LINK_ORIGIN", "CONVEX_SITE_URL", "SQUARE_APPLICATION_ID", "SQUARE_APPLICATION_SECRET", "SQUARE_WEBHOOK_SIGNATURE_KEY", "MAILBOX_TOKEN_KEY"]) delete process.env[name];
});

async function setup(name = "Alpha Cleaning", subject = "owner-a") {
  const t = start();
  return { t, ...(await companyIn(t, subject, name)) };
}

async function companyIn(t: T, subject: string, name: string) {
  const { as, companyId } = await company(t, subject, name);
  const place = await dispatchPlace(as, companyId);
  const jobId = await dispatchJob(as, companyId, place, { priceCents: 24000 });
  await t.run(async (ctx) => ctx.db.patch(jobId, { status: "completed" }));
  return { as, companyId, jobId };
}

type S = Awaited<ReturnType<typeof setup>>;

/** The Owner goes to Square, agrees, and comes back: what the browser's address says afterwards. */
async function authorize(s: Pick<S, "t" | "as" | "companyId">, merchantId: string) {
  const { url } = await s.as.mutation(api.financeSquare.startConnect, { companyId: s.companyId });
  const state = new URL(url).searchParams.get("state")!;
  const code = square.authorize(merchantId);
  const back = await s.t.fetch(`/oauth/square/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`);
  return { back: new URL(back.headers.get("Location")!), state, url: new URL(url) };
}

/** Connects, confirms the business and chooses its eligible location. */
async function connect(s: Pick<S, "t" | "as" | "companyId">, merchantId = "MERCHANT1", name = "Sparkle Co") {
  if (!square.state.merchants.has(merchantId)) square.addMerchant(merchantId, name);
  const { back } = await authorize(s, merchantId);
  const result = await s.as.mutation(api.financeSquare.confirmConnect, { companyId: s.companyId, token: back.searchParams.get("t")! });
  await settle(s.t);
  await s.as.mutation(api.financeSquare.chooseLocation, { companyId: s.companyId, locationId: `${merchantId}-LOC1` });
  return result;
}

async function chooseSquare(s: S) {
  const preview = await s.as.query(api.finance.providerPreview, { companyId: s.companyId, provider: "square" });
  await s.as.mutation(api.finance.setPaymentProvider, { companyId: s.companyId, provider: "square", bindsTo: preview.bindsTo });
}

async function issued(s: S, options: { depositCents?: number } = {}) {
  const { invoiceId } = await s.as.mutation(api.finance.createInvoice, { companyId: s.companyId, jobId: s.jobId });
  let detail = await s.as.query(api.finance.invoice, { companyId: s.companyId, invoiceId });
  if (options.depositCents) {
    await s.as.mutation(api.finance.saveDraft, { companyId: s.companyId, invoiceId, revision: detail.revision, lines: detail.lines, depositCents: options.depositCents, memo: null });
    detail = await s.as.query(api.finance.invoice, { companyId: s.companyId, invoiceId });
  }
  await s.as.mutation(api.finance.issueInvoice, { companyId: s.companyId, invoiceId, revision: detail.revision, dueDate: null });
  const invoice = await s.t.run(async (ctx) => ctx.db.get(invoiceId));
  return { invoiceId, token: (await payToken(invoice!))! };
}

async function payment(t: T, paymentId: Id<"payments">) {
  return (await t.run(async (ctx) => ctx.db.get(paymentId)))!;
}

async function invoiceOf(t: T, invoiceId: Id<"invoices">) {
  return (await t.run(async (ctx) => ctx.db.get(invoiceId)))!;
}

async function webhook(t: T, event: Record<string, unknown>, signature?: string) {
  const body = JSON.stringify(event);
  return t.fetch("/webhooks/square", { method: "POST", headers: { "x-square-hmacsha256-signature": signature ?? (await signForTests(SIGNATURE_KEY, `${SITE}/webhooks/square`, body)), "content-type": "application/json" }, body });
}

const event = (type: string, merchantId: string, objectType: string, id: string, eventId = `evt-${Math.random().toString(36).slice(2)}`) => ({ merchant_id: merchantId, type, event_id: eventId, created_at: new Date(NOW).toISOString(), data: { type: objectType, id, object: {} } });

describe("Square configuration", () => {
  it("never uses a Production app on a test backend, and names what's missing without values", () => {
    expect(squareConfig({ SQUARE_APPLICATION_ID: "sq0idp-LIVEAPPLICATION001", CONVEX_SITE_URL: SITE }, true)).toBeNull();
    expect(squareConfig({ SQUARE_APPLICATION_ID: "sq0idp-LIVEAPPLICATION001", CONVEX_SITE_URL: SITE }, false)?.environment).toBe("production");
    const sandbox = squareConfig({ SQUARE_APPLICATION_ID: "sandbox-sq0idb-TESTAPPLICATION0001", CONVEX_SITE_URL: SITE }, true)!;
    expect(sandbox).toMatchObject({ environment: "sandbox", secret: null, redirectUri: `${SITE}/oauth/square/callback`, webhookUrl: `${SITE}/webhooks/square` });
    expect(squareConfig({ SQUARE_APPLICATION_ID: "EAAAnotanapplicationid" }, false)).toBeNull();
  });

  it("refuses to start connecting without the application secret, and says so", async () => {
    delete process.env.SQUARE_APPLICATION_SECRET;
    const s = await setup();
    const status = await s.as.query(api.financeSquare.status, { companyId: s.companyId });
    expect(status).toMatchObject({ state: "unavailable", canConnect: false, blockerSettings: ["SQUARE_APPLICATION_SECRET"] });
    expect(await refusal(s.as.mutation(api.financeSquare.startConnect, { companyId: s.companyId }))).toBe("Selestial's Square app secret isn't set yet.");
    expect(JSON.stringify(status)).not.toContain("sandbox-sq0csb");
  });
});

describe("Connecting Square", () => {
  it("asks only for the needed permissions, holds Square's answer until the Owner confirms, then needs a location", async () => {
    const s = await setup();
    square.addMerchant("MERCHANT1", "Sparkle Co");
    const { back, url } = await authorize(s, "MERCHANT1");
    expect(url.origin).toBe("https://connect.squareupsandbox.com");
    expect(url.searchParams.get("scope")).toBe("MERCHANT_PROFILE_READ ORDERS_READ ORDERS_WRITE PAYMENTS_READ PAYMENTS_WRITE");
    expect(url.searchParams.get("session")).toBeNull(); // Sandbox ignores it; Production sends false.
    expect(back.pathname).toBe("/app/finance/setup");
    expect(back.searchParams.get("square")).toBe("confirm");
    // Nothing is connected by the callback itself.
    expect(await s.t.run(async (ctx) => ctx.db.query("squareConnections").collect())).toEqual([]);
    const pending = await s.as.query(api.financeSquare.pendingConnect, { companyId: s.companyId, token: back.searchParams.get("t")! });
    expect(pending).toMatchObject({ businessName: "Sparkle Co", environment: "sandbox", takenElsewhere: false, reconnect: false });
    expect(await s.as.mutation(api.financeSquare.confirmConnect, { companyId: s.companyId, token: back.searchParams.get("t")! })).toEqual({ result: "connected" });
    await settle(s.t);
    const [row] = await s.t.run(async (ctx) => ctx.db.query("squareConnections").collect());
    // Tokens are sealed: neither the access nor the refresh token is stored as Square gave it.
    expect(row.sealedAccessToken).not.toMatch(/^EAAA/);
    expect(row.sealedRefreshToken).not.toContain("rt-MERCHANT1");
    let status = await s.as.query(api.financeSquare.status, { companyId: s.companyId });
    expect(status).toMatchObject({ state: "needs_location", businessName: "Sparkle Co", canPay: false });
    expect(status.locations).toEqual([
      expect.objectContaining({ id: "MERCHANT1-LOC1", eligible: true }),
      expect.objectContaining({ id: "MERCHANT1-LOC2", eligible: false, why: "Square hasn't enabled card processing for this location yet." }),
    ]);
    // A readable location is not enough: one without card processing can't be chosen.
    expect(await refusal(s.as.mutation(api.financeSquare.chooseLocation, { companyId: s.companyId, locationId: "MERCHANT1-LOC2" }))).toBe("Square hasn't enabled card processing for this location yet.");
    await s.as.mutation(api.financeSquare.chooseLocation, { companyId: s.companyId, locationId: "MERCHANT1-LOC1" });
    status = await s.as.query(api.financeSquare.status, { companyId: s.companyId });
    expect(status).toMatchObject({ state: "ready", canPay: true, location: { id: "MERCHANT1-LOC1", name: "Sparkle Co Main", currency: "USD" } });
  });

  it("connects nothing when the Owner declines, when the state is replayed, or when it expired", async () => {
    const s = await setup();
    square.addMerchant("MERCHANT1", "Sparkle Co");
    const { url } = await s.as.mutation(api.financeSquare.startConnect, { companyId: s.companyId });
    const state = new URL(url).searchParams.get("state")!;
    const declined = await s.t.fetch(`/oauth/square/callback?state=${state}&error=access_denied&error_description=user_denied`);
    expect(new URL(declined.headers.get("Location")!).searchParams.get("square")).toBe("declined");
    // The same state can't be used again, even with a real code.
    const replay = await s.t.fetch(`/oauth/square/callback?state=${state}&code=${square.authorize("MERCHANT1")}`);
    expect(new URL(replay.headers.get("Location")!).searchParams.get("square")).toBe("expired");
    const fresh = new URL((await s.as.mutation(api.financeSquare.startConnect, { companyId: s.companyId })).url).searchParams.get("state")!;
    vi.setSystemTime(NOW + 11 * 60_000);
    const late = await s.t.fetch(`/oauth/square/callback?state=${fresh}&code=${square.authorize("MERCHANT1")}`);
    expect(new URL(late.headers.get("Location")!).searchParams.get("square")).toBe("expired");
    const forged = await s.t.fetch(`/oauth/square/callback?state=made-up&code=whatever`);
    expect(new URL(forged.headers.get("Location")!).searchParams.get("square")).toBe("failed");
    expect(await s.t.run(async (ctx) => ctx.db.query("squareConnections").collect())).toEqual([]);
  });

  it("refuses a Square account already connected to another company, without naming it or sharing access", async () => {
    const t = start();
    const a = await companyIn(t, "owner-a", "Alpha Cleaning");
    const b = await companyIn(t, "owner-b", "Beta Cleaning");
    square.addMerchant("MERCHANT1", "Sparkle Co");
    expect(await connect({ t, ...a }, "MERCHANT1")).toEqual({ result: "connected" });
    const { back } = await authorize({ t, ...b }, "MERCHANT1");
    const pending = await b.as.query(api.financeSquare.pendingConnect, { companyId: b.companyId, token: back.searchParams.get("t")! });
    expect(pending?.takenElsewhere).toBe(true);
    expect(JSON.stringify(pending)).not.toContain("Alpha");
    expect(await b.as.mutation(api.financeSquare.confirmConnect, { companyId: b.companyId, token: back.searchParams.get("t")! })).toEqual({ result: "taken" });
    await settle(t);
    expect((await a.as.query(api.financeSquare.status, { companyId: a.companyId })).state).toBe("ready");
    expect((await b.as.query(api.financeSquare.status, { companyId: b.companyId })).state).toBe("not_connected");
    // Company A's access still works: nothing revoked it.
    expect(square.state.merchants.get("MERCHANT1")!.revoked).toBe(false);
    // And another company's Owner can't confirm A's waiting authorization either.
    const again = await authorize({ t, ...a }, "MERCHANT1");
    expect(await b.as.query(api.financeSquare.pendingConnect, { companyId: b.companyId, token: again.back.searchParams.get("t")! })).toBeNull();
    expect(await refusal(b.as.mutation(api.financeSquare.confirmConnect, { companyId: b.companyId, token: again.back.searchParams.get("t")! }))).toBe("That Square authorization isn't waiting any more, so nothing was connected. Please start again.");
  });

  it("refreshes tokens before they expire, never lets an older refresh replace newer tokens, and asks to reconnect when Square refuses", async () => {
    const s = await setup();
    await connect(s);
    const [row] = await s.t.run(async (ctx) => ctx.db.query("squareConnections").collect());
    // Six days left: the sweep refreshes it.
    await s.t.run(async (ctx) => ctx.db.patch(row._id, { accessExpiresAt: Date.now() + 6 * 86_400_000 }));
    await s.t.mutation(internal.financeSquare.sweep, {});
    await settle(s.t);
    const refreshed = (await s.t.run(async (ctx) => ctx.db.get(row._id)))!;
    expect(refreshed.tokenVersion).toBe(row.tokenVersion + 1);
    expect(refreshed.accessExpiresAt).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    // A refresh that began before a newer one finished is thrown away.
    const lease = (await s.t.mutation(internal.financeSquare.beginRefresh, { connectionId: row._id }))!;
    expect(await s.t.mutation(internal.financeSquare.beginRefresh, { connectionId: row._id })).toBeNull();
    await s.t.run(async (ctx) => ctx.db.patch(row._id, { tokenVersion: lease.tokenVersion + 5 }));
    expect(await s.t.mutation(internal.financeSquare.tokensRefreshed, { connectionId: row._id, tokenVersion: lease.tokenVersion, sealedAccessToken: "old", sealedRefreshToken: "old", accessExpiresAt: 0 })).toBe(false);
    // The seller revoked access in Square: the next refresh is refused and the company must reconnect.
    await s.t.mutation(internal.financeSquare.endRefresh, { connectionId: row._id });
    square.revoke("MERCHANT1");
    await s.t.action(internal.financeSquare.refreshTokens, { connectionId: row._id });
    expect(await s.as.query(api.financeSquare.status, { companyId: s.companyId })).toMatchObject({ state: "needs_reconnect", canPay: false });
  });
});

describe("Paying an invoice through Square", () => {
  it("checks out the server's amount once, records the payment only from Square's record, and counts it once", async () => {
    const s = await setup();
    await connect(s);
    await chooseSquare(s);
    const { invoiceId, token } = await issued(s);
    const view = (await s.t.query(api.pay.view, { token }))!;
    expect(view).toMatchObject({ provider: "square", canPayByCard: true, requestedCents: 24000, testMode: true });
    const { paymentId } = await s.t.mutation(api.pay.start, { token, amountCents: 24000, clientKey: key(1) });
    // A double click is the same attempt.
    expect(await s.t.mutation(api.pay.start, { token, amountCents: 24000, clientKey: key(1) })).toEqual({ paymentId });
    await settle(s.t);
    expect(square.callsTo(/POST \/v2\/online-checkout\/payment-links/)).toHaveLength(1);
    const p = await payment(s.t, paymentId!);
    const order = square.state.orders.get(p.square!.orderId!)!;
    expect(order.total).toBe(24000);
    const link = square.linkFor(order.id)!;
    expect(link.redirect_url).toBe(`https://link.selestial.test/c/pay/${token}?square=${paymentId}`);
    const attempt = (await s.t.query(api.pay.attempt, { token, paymentId: paymentId! }))!;
    expect(attempt).toMatchObject({ provider: "square", status: "awaiting_customer", checkoutUrl: link.url });
    // Coming back from Square proves nothing: until Square says so, nothing is received.
    await s.t.mutation(api.pay.returned, { token, paymentId: paymentId! });
    await settle(s.t);
    expect((await payment(s.t, paymentId!)).status).toBe("awaiting_customer");
    const paid = square.pay(order.id);
    // A forged notice changes nothing; Square's signed one points at the payment, which is read back.
    expect((await webhook(s.t, event("payment.updated", "MERCHANT1", "payment", paid.id), "bad-signature")).status).toBe(401);
    const notice = event("payment.updated", "MERCHANT1", "payment", paid.id, "evt-1");
    expect((await webhook(s.t, notice)).status).toBe(200);
    await settle(s.t);
    let after = await payment(s.t, paymentId!);
    expect(after).toMatchObject({ status: "succeeded", amountCents: 24000 });
    expect(after.square).toMatchObject({ paymentId: paid.id, feeCents: paid.fee, methodLabel: "Visa ending 1111", receiptUrl: `https://squareup.com/receipt/preview/${paid.id}` });
    expect(after.square!.checkoutUrl).toBeUndefined();
    let invoice = await invoiceOf(s.t, invoiceId);
    expect(invoice).toMatchObject({ status: "paid", totals: expect.objectContaining({ paidCents: 24000, balanceCents: 0 }) });
    // The same notice again, a second notice for the same payment, and the reconciliation sweep: still counted once.
    await webhook(s.t, notice);
    await webhook(s.t, event("payment.created", "MERCHANT1", "payment", paid.id, "evt-2"));
    await s.t.mutation(internal.financeSquarePay.reconcile, {});
    await settle(s.t);
    after = await payment(s.t, paymentId!);
    invoice = await invoiceOf(s.t, invoiceId);
    expect(invoice.totals.paidCents).toBe(24000);
    const succeeded = (await s.t.run(async (ctx) => ctx.db.query("events").collect())).filter((e) => e.type === "payment.succeeded");
    expect(succeeded).toHaveLength(1);
    const overview = await s.as.query(api.finance.invoice, { companyId: s.companyId, invoiceId });
    expect(overview.payments[0]).toMatchObject({ source: "square", feeCents: paid.fee, receiptUrl: after.square!.receiptUrl, references: { provider: "Square" } });
  });

  it("asks for the deposit first and lets the customer pay part when the company allows it", async () => {
    const s = await setup();
    await connect(s);
    await chooseSquare(s);
    const { token } = await issued(s, { depositCents: 6000 });
    expect((await s.t.query(api.pay.view, { token }))!.requestedCents).toBe(6000);
    expect(await refusal(s.t.mutation(api.pay.start, { token, amountCents: 24000, clientKey: key(2) }))).toBe("That's more than what's due right now.");
    const { paymentId } = await s.t.mutation(api.pay.start, { token, amountCents: 6000, clientKey: key(3) });
    await settle(s.t);
    const p = await payment(s.t, paymentId!);
    expect(square.state.orders.get(p.square!.orderId!)!.total).toBe(6000);
    // Square adds no tax, discount or tip of its own: the order is exactly the line Selestial sent.
    expect(square.state.orders.get(p.square!.orderId!)!.line_items).toHaveLength(1);
  });

  it("keeps the invoice unpaid when Square declines, and the checkout stays open for another card", async () => {
    const s = await setup();
    await connect(s);
    await chooseSquare(s);
    const { invoiceId, token } = await issued(s);
    const { paymentId } = await s.t.mutation(api.pay.start, { token, amountCents: 24000, clientKey: key(4) });
    await settle(s.t);
    const p = await payment(s.t, paymentId!);
    const declined = square.pay(p.square!.orderId!, { status: "FAILED" });
    await webhook(s.t, event("payment.updated", "MERCHANT1", "payment", declined.id));
    await settle(s.t);
    const after = await payment(s.t, paymentId!);
    expect(after.status).toBe("awaiting_customer");
    expect(after.problem).toBe("Square declined the payment. The invoice is still unpaid, and the checkout link stays open for another try.");
    expect((await invoiceOf(s.t, invoiceId)).status).toBe("open");
  });

  it("never makes a second checkout when Square's answer is lost after it acted", async () => {
    const s = await setup();
    await connect(s);
    await chooseSquare(s);
    const { token } = await issued(s);
    square.lose({ path: /POST \/v2\/online-checkout\/payment-links/, when: "after" });
    const { paymentId } = await s.t.mutation(api.pay.start, { token, amountCents: 24000, clientKey: key(5) });
    vi.runOnlyPendingTimers();
    await s.t.finishInProgressScheduledFunctions();
    expect((await payment(s.t, paymentId!)).status).toBe("checking");
    await settle(s.t);
    const creates = square.callsTo(/POST \/v2\/online-checkout\/payment-links/);
    // Asked again with the same key, which Square answered with the first link.
    expect(new Set(creates.map((c) => c.key))).toEqual(new Set([`sel-${paymentId}`]));
    expect(square.state.links.size).toBe(1);
    expect((await payment(s.t, paymentId!)).status).toBe("awaiting_customer");
  });

  it("closes an older checkout when the customer starts again, and records a payment that slipped through as an overpayment", async () => {
    const s = await setup();
    await connect(s);
    await chooseSquare(s);
    const { invoiceId, token } = await issued(s);
    const first = (await s.t.mutation(api.pay.start, { token, amountCents: 24000, clientKey: key(6) })).paymentId!;
    await settle(s.t);
    const firstOrder = (await payment(s.t, first)).square!.orderId!;
    // The customer pays the first checkout in another tab, then starts again here before Square's notice arrives.
    square.pay(firstOrder);
    const second = (await s.t.mutation(api.pay.start, { token, amountCents: 24000, clientKey: key(7) })).paymentId!;
    await settle(s.t);
    // The first is read back from Square: the money arrived, so it counts.
    expect((await payment(s.t, first)).status).toBe("succeeded");
    // The invoice is paid, so the second checkout is closed before anyone can pay it.
    const secondRow = await payment(s.t, second);
    expect(secondRow.status).toBe("canceled");
    expect(square.state.orders.get(secondRow.square!.orderId!)!.state).toBe("CANCELED");
    expect(() => square.pay(secondRow.square!.orderId!)).toThrow();
    expect((await invoiceOf(s.t, invoiceId)).totals.balanceCents).toBe(0);
  });

  it("closes an open checkout when the invoice is voided", async () => {
    const s = await setup();
    await connect(s);
    await chooseSquare(s);
    const { invoiceId, token } = await issued(s);
    const { paymentId } = await s.t.mutation(api.pay.start, { token, amountCents: 24000, clientKey: key(8) });
    await settle(s.t);
    const preview = await s.as.query(api.finance.voidPreview, { companyId: s.companyId, invoiceId });
    await s.as.mutation(api.finance.voidInvoice, { companyId: s.companyId, invoiceId, reason: "Booked twice.", bindsTo: preview.bindsTo });
    await settle(s.t);
    const p = await payment(s.t, paymentId!);
    expect(p.status).toBe("canceled");
    expect(square.state.orders.get(p.square!.orderId!)!.state).toBe("CANCELED");
  });

  it("is noted for Selestial's team, never matched, when an event names a Square account no company connected", async () => {
    const s = await setup();
    await connect(s);
    expect((await webhook(s.t, event("payment.updated", "STRANGER", "payment", "PAY-X"))).status).toBe(200);
    const signals = await s.t.run(async (ctx) => ctx.db.query("opsSignals").collect());
    expect(signals).toEqual([expect.objectContaining({ source: "/webhooks/square" })]);
    // A payment the business took elsewhere in Square matches no invoice and is left alone.
    const order = square.state.orders.size;
    expect((await webhook(s.t, event("payment.created", "MERCHANT1", "payment", "PAY-IN-STORE"))).status).toBe(200);
    await settle(s.t);
    expect(square.state.orders.size).toBe(order);
  });
});

describe("Square refunds", () => {
  async function paidThroughSquare() {
    const s = await setup();
    await connect(s);
    await chooseSquare(s);
    const { invoiceId, token } = await issued(s);
    const { paymentId } = await s.t.mutation(api.pay.start, { token, amountCents: 24000, clientKey: key(9) });
    await settle(s.t);
    const paid = square.pay((await payment(s.t, paymentId!)).square!.orderId!);
    await webhook(s.t, event("payment.updated", "MERCHANT1", "payment", paid.id));
    await settle(s.t);
    return { s, invoiceId, paymentId: paymentId!, squarePaymentId: paid.id };
  }

  async function refund(s: S, paymentId: Id<"payments">, amountCents: number, n: number, alsoCredit = false) {
    const preview = await s.as.query(api.finance.refundPreview, { companyId: s.companyId, paymentId, amountCents, alsoCredit });
    expect(preview.blocked).toBeNull();
    return s.as.mutation(api.finance.requestRefund, { companyId: s.companyId, paymentId, amountCents, reason: "Missed a room.", alsoCredit, bindsTo: preview.bindsTo, clientKey: key(`refund-${n}`) });
  }

  it("sends partial and full refunds to Square under their own keys and adds them up once", async () => {
    const { s, invoiceId, paymentId, squarePaymentId } = await paidThroughSquare();
    const preview = await s.as.query(api.finance.refundPreview, { companyId: s.companyId, paymentId, amountCents: 4000, alsoCredit: false });
    expect(preview.lines[0]).toContain("Square returns $40.00");
    const first = await refund(s, paymentId, 4000, 1);
    await settle(s.t);
    expect(square.state.payments.get(squarePaymentId)!.refunded).toBe(4000);
    const row = (await s.t.run(async (ctx) => ctx.db.get(first.refundId)))!;
    expect(row).toMatchObject({ status: "succeeded", squareRefundId: expect.stringMatching(/^RFD/) });
    expect(square.callsTo(/POST \/v2\/refunds/)[0].key).toBe(first.refundId);
    await refund(s, paymentId, 20000, 2, true);
    await settle(s.t);
    expect((await payment(s.t, paymentId)).refundedCents).toBe(24000);
    const invoice = await invoiceOf(s.t, invoiceId);
    expect(invoice.totals).toMatchObject({ refundedCents: 24000, creditedCents: 20000 });
    // Nothing left to refund.
    expect((await s.as.query(api.finance.refundPreview, { companyId: s.companyId, paymentId, amountCents: 100, alsoCredit: false })).blocked).toBe("Up to $0.00 of this payment can still be refunded.");
  });

  it("finishes a refund whose answer was lost without refunding twice, and records one made in Square's Dashboard", async () => {
    const { s, paymentId, squarePaymentId } = await paidThroughSquare();
    square.lose({ path: /POST \/v2\/refunds/, when: "after" });
    const { refundId } = await refund(s, paymentId, 5000, 3);
    await settle(s.t);
    expect(square.state.refunds.size).toBe(1);
    expect((await s.t.run(async (ctx) => ctx.db.get(refundId)))!.status).toBe("succeeded");
    const counter = square.dashboardRefund(squarePaymentId, 1000);
    await webhook(s.t, event("refund.created", "MERCHANT1", "refund", counter.id));
    await settle(s.t);
    const refunds = await s.t.run(async (ctx) => ctx.db.query("refunds").collect());
    expect(refunds.find((r) => r.squareRefundId === counter.id)).toMatchObject({ origin: "square_dashboard", amountCents: 1000, status: "succeeded", reason: "Refunded in Square" });
    expect((await payment(s.t, paymentId)).refundedCents).toBe(6000);
  });
});

describe("Losing, ending and switching", () => {
  it("asks to reconnect when the seller revokes access, then reads waiting checkouts again on reconnect", async () => {
    const s = await setup();
    await connect(s);
    await chooseSquare(s);
    const { invoiceId, token } = await issued(s);
    const { paymentId } = await s.t.mutation(api.pay.start, { token, amountCents: 24000, clientKey: key(10) });
    await settle(s.t);
    const orderId = (await payment(s.t, paymentId!)).square!.orderId!;
    square.revoke("MERCHANT1");
    await webhook(s.t, { merchant_id: "MERCHANT1", type: "oauth.authorization.revoked", event_id: "evt-revoke", created_at: new Date(NOW).toISOString(), data: { type: "revocation", id: "r1", object: {} } });
    expect(await s.as.query(api.financeSquare.status, { companyId: s.companyId })).toMatchObject({ state: "needs_reconnect", openLinksAtLoss: 1 });
    expect((await s.t.query(api.pay.view, { token }))!.canPayByCard).toBe(false);
    const overview = await s.as.query(api.finance.overview, { companyId: s.companyId, period: "this_month" });
    expect(overview.findings.find((f) => f.id === "square_reconnect")?.title).toBe("Reconnect Square to accept new payments");
    // The customer paid the open checkout while Selestial couldn't see it.
    square.pay(orderId);
    const { back } = await authorize(s, "MERCHANT1");
    expect(await s.as.mutation(api.financeSquare.confirmConnect, { companyId: s.companyId, token: back.searchParams.get("t")! })).toEqual({ result: "reconnected" });
    await settle(s.t);
    expect((await payment(s.t, paymentId!)).status).toBe("succeeded");
    expect((await invoiceOf(s.t, invoiceId)).status).toBe("paid");
    expect((await s.as.query(api.financeSquare.status, { companyId: s.companyId })).state).toBe("ready");
  });

  it("won't disconnect while a payment is being confirmed, and closes unfinished checkouts before access ends", async () => {
    const s = await setup();
    await connect(s);
    await chooseSquare(s);
    const { token } = await issued(s);
    const { paymentId } = await s.t.mutation(api.pay.start, { token, amountCents: 24000, clientKey: key(11) });
    await settle(s.t);
    await s.t.run(async (ctx) => ctx.db.patch(paymentId!, { status: "processing" }));
    const blocked = (await s.as.query(api.financeSquare.disconnectPreview, { companyId: s.companyId }))!;
    expect(blocked.blocked).toContain("still being confirmed");
    expect(await refusal(s.as.mutation(api.financeSquare.disconnect, { companyId: s.companyId, bindsTo: blocked.bindsTo }))).toBe("Wait until Square payments and refunds in progress settle, then disconnect.");
    await s.t.run(async (ctx) => ctx.db.patch(paymentId!, { status: "awaiting_customer" }));
    const preview = (await s.as.query(api.financeSquare.disconnectPreview, { companyId: s.companyId }))!;
    expect(preview.lines.join(" ")).toContain("1 unfinished Square checkout is closed first");
    await s.as.mutation(api.financeSquare.disconnect, { companyId: s.companyId, bindsTo: preview.bindsTo });
    await settle(s.t);
    const p = await payment(s.t, paymentId!);
    expect(p.status).toBe("canceled");
    expect(square.state.orders.get(p.square!.orderId!)!.state).toBe("CANCELED");
    expect(square.state.merchants.get("MERCHANT1")!.revoked).toBe(true);
    const [row] = await s.t.run(async (ctx) => ctx.db.query("squareConnections").collect());
    expect(row).toMatchObject({ status: "disconnected", sealedAccessToken: "", sealedRefreshToken: "" });
    expect((await s.t.query(api.pay.view, { token }))!.canPayByCard).toBe(false);
  });

  it("switches providers only when the new one is ready and nothing is being confirmed, closing unfinished checkouts", async () => {
    const s = await setup();
    expect((await s.as.query(api.finance.providerPreview, { companyId: s.companyId, provider: "square" })).blocked).toBe("Connect Square first.");
    await connect(s);
    await chooseSquare(s);
    const { token } = await issued(s);
    const { paymentId } = await s.t.mutation(api.pay.start, { token, amountCents: 24000, clientKey: key(12) });
    await settle(s.t);
    // Back to Stripe, which isn't connected here: refused, and nothing changes.
    expect((await s.as.query(api.finance.providerPreview, { companyId: s.companyId, provider: "stripe" })).blocked).toBe("Finish connecting Stripe first.");
    // Pretend Stripe is ready, with this Square checkout being confirmed: still refused.
    await s.t.run(async (ctx) => {
      await ctx.db.insert("stripeAccounts", { companyId: s.companyId, accountId: "acct_1", livemode: false, status: "active", chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, requirementsDue: 0, createAttempt: 1, connectedBy: (await ctx.db.query("members").first())!._id, createdAt: NOW, updatedAt: NOW });
      await ctx.db.patch(paymentId!, { status: "checking" });
    });
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_fake";
    try {
      expect((await s.as.query(api.finance.providerPreview, { companyId: s.companyId, provider: "stripe" })).blocked).toContain("still being confirmed");
      await s.t.run(async (ctx) => ctx.db.patch(paymentId!, { status: "awaiting_customer" }));
      const preview = await s.as.query(api.finance.providerPreview, { companyId: s.companyId, provider: "stripe" });
      expect(preview.blocked).toBeNull();
      expect(preview.lines[1]).toBe("1 unfinished checkout is closed now; those customers start again on the same pay link.");
      await s.as.mutation(api.finance.setPaymentProvider, { companyId: s.companyId, provider: "stripe", bindsTo: preview.bindsTo });
      await settle(s.t);
      expect((await payment(s.t, paymentId!)).status).toBe("canceled");
      expect((await s.t.query(api.pay.view, { token }))!.provider).toBe("stripe");
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_PUBLISHABLE_KEY;
    }
  });
});
