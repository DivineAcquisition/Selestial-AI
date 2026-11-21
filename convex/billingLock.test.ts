/**
 * @vitest-environment edge-runtime
 *
 * An unpaid Selestial plan (convex/billingLock.ts): warned after the first failed payment, locked after
 * the second, reminded at 23 days, canceled at 30, and reopened the moment it's paid. Stripe's events
 * arrive signed at /webhooks/stripe-billing; Autumn is the stand-in from tests/setupBilling.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, NOW, person, refusal, staffWith, start, type T } from "../tests/harness";
import { billing } from "../tests/setupBilling";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CANCEL_AFTER_MS, parseInvoiceEvent, REMIND_BEFORE_CANCEL_MS } from "./lib/billing/lock";
import { setStripeTransportForTests, signForTests } from "./lib/finance/stripe";
import { AGENTS } from "./lib/statuses";

const SECRET = "whsec_test_only_billing_secret";
const DAY = 86_400_000;
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

let events = 0;
function invoiceEvent(type: string, companyId: Id<"companies"> | null, invoice: Record<string, unknown> = {}) {
  events += 1;
  return {
    id: `evt_${events}`,
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: "in_plan_1",
        customer: "cus_plan_1",
        subscription: "sub_plan_1",
        billing_reason: "subscription_cycle",
        attempt_count: 1,
        amount_due: 29900,
        amount_remaining: 29900,
        currency: "usd",
        hosted_invoice_url: "https://invoice.stripe.test/in_plan_1",
        next_payment_attempt: Math.floor((Date.now() + 3 * DAY) / 1000),
        ...(companyId ? { subscription_details: { metadata: { autumn_customer_id: `company_${companyId}` } } } : {}),
        ...invoice,
      },
    },
  };
}

async function deliver(t: T, event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  const signature = await signForTests(SECRET, body, Math.floor(Date.now() / 1000));
  const response = await t.fetch("/webhooks/stripe-billing", { method: "POST", headers: { "stripe-signature": signature, "content-type": "application/json" }, body });
  await settle(t);
  return response.status;
}

async function setup() {
  const t = start();
  const owner = await company(t, "owner-a", "Alpha Cleaning");
  // Billing sync makes Selestial's own record of the Autumn customer, which is what an event is matched to.
  await t.action(internal.billing.syncCompany, { companyId: owner.companyId });
  return { t, ...owner };
}

const notices = (t: T, companyId: Id<"companies">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("messages").collect())
      .filter((row) => row.companyId === companyId && row.notice?.event === "plan_access")
      .map((row) => row.notice?.facts?.kind),
  );
const companyRow = (t: T, companyId: Id<"companies">) => t.run((ctx) => ctx.db.get(companyId));

describe("an unpaid plan", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.STRIPE_BILLING_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.STRIPE_BILLING_WEBHOOK_SECRET;
    delete process.env.STRIPE_SECRET_KEY;
    setStripeTransportForTests(null);
  });

  it("warns after the first failure, locks after the second, and reopens as the Owner left it once paid", async () => {
    const s = await setup();
    const manager = await addMember(s.t, s.as, s.companyId, "mgr", "manager");
    // The Owner had paused Recruiter themselves; that choice must survive the lock.
    await s.t.run((ctx) => ctx.db.patch(s.companyId, { pausedAgents: ["recruiter"] }));

    expect(await deliver(s.t, invoiceEvent("invoice.payment_failed", s.companyId, { attempt_count: 1 }))).toBe(200);
    expect((await companyRow(s.t, s.companyId))?.billingLockedAt).toBeUndefined();
    expect(await notices(s.t, s.companyId)).toEqual(["first_failure"]);
    const warned = await s.as.query(api.billingLock.status, { companyId: s.companyId });
    expect(warned).toMatchObject({ locked: false, warning: { amountCents: 29900, payUrl: "https://invoice.stripe.test/in_plan_1" } });
    // The workspace still opens.
    await s.as.query(api.companies.get, { companyId: s.companyId });

    await deliver(s.t, invoiceEvent("invoice.payment_failed", s.companyId, { attempt_count: 2, last_finalization_error: { message: "Your card was declined." } }));
    const locked = await companyRow(s.t, s.companyId);
    const lockedAt = locked!.billingLockedAt!;
    expect(lockedAt - NOW).toBeLessThan(1000);
    expect([...(locked?.pausedAgents ?? [])].sort()).toEqual([...AGENTS].sort());
    expect(await notices(s.t, s.companyId)).toEqual(["first_failure", "locked"]);
    expect(await s.as.query(api.companies.mine, {})).toEqual([{ companyId: s.companyId, name: "Alpha Cleaning", role: "owner", locked: true }]);

    // Nobody on the team can open the workspace; the Owner can see what's owed and pay.
    for (const who of [s.as, manager]) expect(await refusal(who.query(api.companies.get, { companyId: s.companyId }))).toMatch(/locked because the Selestial plan is unpaid/);
    const forOwner = await s.as.query(api.billingLock.status, { companyId: s.companyId });
    expect(forOwner).toMatchObject({ locked: true, owner: true, amountCents: 29900, attempts: 2, payUrl: "https://invoice.stripe.test/in_plan_1", failure: "Your card was declined.", cancelAt: lockedAt + CANCEL_AFTER_MS });
    const forManager = await manager.query(api.billingLock.status, { companyId: s.companyId });
    expect(forManager).toMatchObject({ locked: true, owner: false, payUrl: null, failure: null });
    expect(forManager.ownerName).toBeTruthy();
    await s.as.mutation(api.billing.refresh, { companyId: s.companyId });

    // Paid: open again at once, with the Owner's own pause put back.
    await deliver(s.t, invoiceEvent("invoice.paid", s.companyId, { attempt_count: 2, amount_remaining: 0 }));
    const reopened = await companyRow(s.t, s.companyId);
    expect(reopened?.billingLockedAt).toBeUndefined();
    expect(reopened?.pausedAgents).toEqual(["recruiter"]);
    expect(await notices(s.t, s.companyId)).toEqual(["first_failure", "locked", "reinstated"]);
    await s.as.query(api.companies.get, { companyId: s.companyId });
    expect(await s.as.query(api.billingLock.status, { companyId: s.companyId })).toMatchObject({ locked: false, warning: null });
  });

  it("counts Stripe's attempts, however the events arrive, and applies each event once", async () => {
    const s = await setup();
    const second = invoiceEvent("invoice.payment_failed", s.companyId, { attempt_count: 2 });
    await deliver(s.t, second);
    // The second attempt arrived first: it locks, and the late first one sends no "first failure" warning.
    await deliver(s.t, invoiceEvent("invoice.payment_failed", s.companyId, { attempt_count: 1 }));
    await deliver(s.t, second);
    expect(await notices(s.t, s.companyId)).toEqual(["locked"]);
    const rows = await s.t.run((ctx) => ctx.db.query("billingDunning").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 2, lockedAt: expect.any(Number) });
  });

  it("ignores one-off purchases, invoices it never saw fail, and forged deliveries", async () => {
    const s = await setup();
    await deliver(s.t, invoiceEvent("invoice.payment_failed", s.companyId, { id: "in_topup", subscription: null, billing_reason: "manual", attempt_count: 2 }));
    await deliver(s.t, invoiceEvent("invoice.paid", s.companyId, { id: "in_other" }));
    const body = JSON.stringify(invoiceEvent("invoice.payment_failed", s.companyId, { attempt_count: 3 }));
    const forged = await s.t.fetch("/webhooks/stripe-billing", { method: "POST", headers: { "stripe-signature": "t=1,v1=00" }, body });
    expect(forged.status).toBe(401);
    expect(await s.t.run((ctx) => ctx.db.query("billingDunning").collect())).toEqual([]);
    expect((await companyRow(s.t, s.companyId))?.billingLockedAt).toBeUndefined();
  });

  it("finds the company through the Stripe customer when the invoice doesn't name it, and keeps strangers for staff", async () => {
    const s = await setup();
    process.env.STRIPE_SECRET_KEY = "sk_test_only_key";
    setStripeTransportForTests(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/customers/cus_plan_1")) return new Response(JSON.stringify({ id: "cus_plan_1", metadata: { autumn_id: `company_${s.companyId}` } }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: "No such customer" } }), { status: 404 });
    });
    await deliver(s.t, invoiceEvent("invoice.payment_failed", null, { attempt_count: 2 }));
    expect((await companyRow(s.t, s.companyId))?.billingLockedAt).toEqual(expect.any(Number));

    await deliver(s.t, invoiceEvent("invoice.payment_failed", null, { id: "in_stranger", customer: "cus_unknown", attempt_count: 2 }));
    const kept = await s.t.run((ctx) => ctx.db.query("billingWebhooks").collect());
    expect(kept.some((row) => row.type === "stripe.invoice.payment_failed.unmatched" && row.customerId === "cus_unknown")).toBe(true);
    expect(await s.t.run((ctx) => ctx.db.query("billingDunning").collect())).toHaveLength(1);
  });

  it("reminds the Owner 7 days before, cancels the plan after 30 days locked, and keeps the records", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.patch(s.companyId, { pausedAgents: ["retention"] }));
    await deliver(s.t, invoiceEvent("invoice.payment_failed", s.companyId, { attempt_count: 2 }));

    vi.setSystemTime(NOW + CANCEL_AFTER_MS - REMIND_BEFORE_CANCEL_MS - DAY);
    await s.t.mutation(internal.billingLock.sweep, {});
    await settle(s.t);
    expect(await notices(s.t, s.companyId)).toEqual(["locked"]);

    vi.setSystemTime(NOW + CANCEL_AFTER_MS - REMIND_BEFORE_CANCEL_MS + DAY);
    await s.t.mutation(internal.billingLock.sweep, {});
    await s.t.mutation(internal.billingLock.sweep, {});
    await settle(s.t);
    expect(await notices(s.t, s.companyId)).toEqual(["locked", "cancel_soon"]);

    vi.setSystemTime(NOW + CANCEL_AFTER_MS + HOUR_MS);
    await s.t.mutation(internal.billingLock.sweep, {});
    await settle(s.t);
    const cancel = billing.state.calls.find((call) => call.path === "/v1/billing.update");
    expect(cancel?.body).toMatchObject({ customer_id: `company_${s.companyId}`, cancel_action: "cancel_immediately" });
    const after = await companyRow(s.t, s.companyId);
    expect(after?.billingLockedAt).toBeUndefined();
    expect(after?.pausedAgents).toEqual(["retention"]);
    // Autumn now reports no plan, so agents still can't run until a plan is chosen again.
    expect(after?.plan).toBeUndefined();
    expect(await notices(s.t, s.companyId)).toEqual(["locked", "cancel_soon", "canceled"]);
    const [row] = await s.t.run((ctx) => ctx.db.query("billingDunning").collect());
    expect(row).toMatchObject({ resolution: "canceled" });
    const types = await s.t.run(async (ctx) => (await ctx.db.query("events").collect()).map((event) => event.type));
    expect(types).toEqual(expect.arrayContaining(["billing.account_locked", "billing.plan_canceled_unpaid", "billing.account_reinstated"]));
  });

  it("lets staff with billing adjustments lift a lock, with a reason, and nobody else", async () => {
    const s = await setup();
    await deliver(s.t, invoiceEvent("invoice.payment_failed", s.companyId, { attempt_count: 2 }));
    await staffWith(s.t, { subject: "staff-billing", email: "billing@selestial.test", name: "Billing" }, ["billing.adjust"]);
    await staffWith(s.t, { subject: "staff-plain", email: "plain@selestial.test", name: "Plain" }, []);
    const billingStaff = s.t.withIdentity(person("staff-billing", { email: "billing@selestial.test" }));
    const plainStaff = s.t.withIdentity(person("staff-plain", { email: "plain@selestial.test" }));
    const [locked] = await billingStaff.query(api.billingLock.lockedAccounts, {});
    expect(locked).toMatchObject({ companyId: s.companyId, amountCents: 29900, cancelAt: locked.lockedAt + CANCEL_AFTER_MS });
    await expect(plainStaff.mutation(api.billingLock.lift, { id: locked.id, note: "Paid by bank transfer" })).rejects.toThrow();
    expect(await refusal(billingStaff.mutation(api.billingLock.lift, { id: locked.id, note: "ok" }))).toMatch(/Say why/);
    await billingStaff.mutation(api.billingLock.lift, { id: locked.id, note: "Paid by bank transfer on 3/2" });
    await settle(s.t);
    expect((await companyRow(s.t, s.companyId))?.billingLockedAt).toBeUndefined();
    expect(await s.as.query(api.companies.mine, {})).toEqual([expect.objectContaining({ locked: false })]);
  });
});

describe("reading Stripe's invoice events", () => {
  it("reads only the invoice events it handles, with Stripe's attempt count and Autumn's customer id", () => {
    const event = invoiceEvent("invoice.payment_failed", null, { attempt_count: 2, parent: { subscription_details: { subscription: "sub_1", metadata: { autumn_customer_id: "company_abcdefghij12" } } } });
    expect(parseInvoiceEvent(JSON.stringify(event))).toMatchObject({ type: "invoice.payment_failed", invoiceId: "in_plan_1", attempts: 2, amountCents: 29900, subscription: true, customerHint: "company_abcdefghij12" });
    expect(parseInvoiceEvent(JSON.stringify({ ...event, type: "charge.refunded" }))).toBeNull();
    expect(parseInvoiceEvent("not json")).toBeNull();
    // A hint that isn't a Selestial customer id is not a hint.
    expect(parseInvoiceEvent(JSON.stringify(invoiceEvent("invoice.paid", null, { metadata: { autumn_id: "cus_somebody" } })))?.customerHint).toBeNull();
  });
});

const HOUR_MS = 3_600_000;
