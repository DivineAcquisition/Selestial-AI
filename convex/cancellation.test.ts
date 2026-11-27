/**
 * @vitest-environment edge-runtime
 *
 * Cancel subscription and the retention offers (convex/cancellation.ts), end to end against the stand-ins
 * for Autumn (tests/fakeAutumn.ts) and Stripe (tests/fakeStripe.ts): what is shown, what is accepted, what
 * Stripe is asked, what happens when an answer is lost, and what the Owner is told.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flush, PHONES, setup as dispatchSetup } from "../tests/dispatchHarness";
import { addMember, company, NOW, refusal, start, type T } from "../tests/harness";
import { fakeStripe } from "../tests/fakeStripe";
import { billing } from "../tests/setupBilling";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { NOT_ALLOWED } from "./lib/errors";
import { setStripeTransportForTests, signForTests } from "./lib/finance/stripe";

const DAY = 86_400_000;
const SECRET = "whsec_test_only_billing_secret";
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
let stripe = fakeStripe();

type Owner = Awaited<ReturnType<typeof subscribed>>;

/** A company on a plan in Autumn, with the matching subscription in Stripe underneath. */
async function subscribed(t: T, subject = "owner-a", name = "Alpha Cleaning", plan: "operate" | "operate_early" | "expand" = "operate", stripeFields: Partial<Parameters<typeof stripe.planSubscription>[1]> = {}) {
  const owner = await company(t, subject, name);
  const periodEnd = NOW + 20 * DAY;
  billing.seed(owner.companyId, { plan, periodEnd, grant: 1000 });
  await t.action(internal.billing.syncCompany, { companyId: owner.companyId });
  const cents = { operate: 299_00, operate_early: 199_00, expand: 499_00 }[plan];
  const sub = stripe.planSubscription(owner.companyId, { cents, periodEnd, ...stripeFields });
  return { t, ...owner, sub, periodEnd };
}

async function open(s: Owner) {
  const flowId = await s.as.mutation(api.cancellation.start, { companyId: s.companyId });
  await settle(s.t);
  return flowId;
}
const view = async (s: Owner, flowId: Id<"cancelFlows">) => (await s.as.query(api.cancellation.flow, { companyId: s.companyId, flowId }))!;
const stripeWrites = () => stripe.state.calls.filter((call) => call.method === "POST");
const autumnUpdates = () => billing.state.calls.filter((call) => call.path === "/v1/billing.update");
const notices = (t: T, companyId: Id<"companies">, kind?: string) => t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((row) => row.companyId === companyId && row.notice?.event === "plan_subscription" && (kind === undefined || row.notice.facts?.kind === kind)));
const offerRows = (t: T) => t.run(async (ctx) => ctx.db.query("retentionOffers").collect());

async function acceptFrom(s: Owner, flowId: Id<"cancelFlows">, offerId: "save10_once" | "save15_three") {
  const shown = (await view(s, flowId)).offers[offerId];
  if (!shown.eligible) throw new Error(`${offerId} is not offered`);
  const id = await s.as.mutation(api.cancellation.accept, { companyId: s.companyId, flowId, offerId, version: shown.version });
  await settle(s.t);
  return id;
}

async function deliver(t: T, event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  const signature = await signForTests(SECRET, body, Math.floor(Date.now() / 1000));
  const response = await t.fetch("/webhooks/stripe-billing", { method: "POST", headers: { "stripe-signature": signature, "content-type": "application/json" }, body });
  await settle(t);
  return response.status;
}

describe("cancellation and retention offers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stripe = fakeStripe();
    process.env.STRIPE_SECRET_KEY = "sk_test_only_key";
    process.env.STRIPE_BILLING_WEBHOOK_SECRET = SECRET;
    process.env.RETENTION_OFFERS = "on";
    setStripeTransportForTests(stripe.fetch);
  });
  afterEach(() => {
    vi.useRealTimers();
    setStripeTransportForTests(null);
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_BILLING_WEBHOOK_SECRET;
    delete process.env.RETENTION_OFFERS;
    delete process.env.RETENTION_ACROSS_PRICE_CHANGE;
  });

  it("keeps every billing change to the Owner", async () => {
    const t = start();
    const s = await subscribed(t);
    const manager = await addMember(t, s.as, s.companyId, "mgr", "manager");
    const flowId = await open(s);
    const shown = (await view(s, flowId)).offers.save10_once;
    expect(shown.eligible).toBe(true);
    expect(await refusal(manager.mutation(api.cancellation.start, { companyId: s.companyId }))).toBe(NOT_ALLOWED);
    expect(await refusal(manager.query(api.cancellation.flow, { companyId: s.companyId, flowId }))).toBe(NOT_ALLOWED);
    expect(await refusal(manager.mutation(api.cancellation.accept, { companyId: s.companyId, flowId, offerId: "save10_once", version: shown.eligible ? shown.version : "" }))).toBe(NOT_ALLOWED);
    expect(await refusal(manager.mutation(api.billing.cancelPlan, { companyId: s.companyId, flowId }))).toBe(NOT_ALLOWED);
    expect(await refusal(manager.mutation(api.billing.resumePlan, { companyId: s.companyId }))).toBe(NOT_ALLOWED);
    // Another company can't read or act on this flow.
    const other = await subscribed(t, "owner-b", "Beta Cleaning");
    expect(await other.as.query(api.cancellation.flow, { companyId: other.companyId, flowId })).toBeNull();
    expect(await refusal(other.as.mutation(api.cancellation.accept, { companyId: other.companyId, flowId, offerId: "save10_once", version: "x" }))).toMatch(/wasn't found/);
    expect(stripeWrites()).toHaveLength(0);
  });

  it("changes nothing in billing for opening, answering, viewing, declining or closing", async () => {
    const t = start();
    const s = await subscribed(t);
    const flowId = await open(s);
    await s.as.mutation(api.cancellation.answer, { companyId: s.companyId, flowId, step: "reason", code: "price_too_high", note: "Too much for a two-person team." });
    // The follow-up question belongs to setup and reliability reasons only.
    expect((await view(s, flowId)).detail).toBeNull();
    expect(await refusal(s.as.mutation(api.cancellation.answer, { companyId: s.companyId, flowId, step: "detail", note: "x" }))).toMatch(/no follow-up/);
    await s.as.mutation(api.cancellation.offerSeen, { companyId: s.companyId, flowId, offerId: "save10_once", outcome: "viewed" });
    await s.as.mutation(api.cancellation.offerSeen, { companyId: s.companyId, flowId, offerId: "save10_once", outcome: "declined" });
    await s.as.mutation(api.cancellation.answer, { companyId: s.companyId, flowId, step: "need", code: "lower_price" });
    await s.as.mutation(api.cancellation.offerSeen, { companyId: s.companyId, flowId, offerId: "save15_three", outcome: "viewed" });
    await s.as.mutation(api.cancellation.keep, { companyId: s.companyId, flowId });
    await settle(t);
    expect(stripeWrites()).toHaveLength(0);
    expect(autumnUpdates()).toHaveLength(0);
    expect(await notices(t, s.companyId)).toHaveLength(0);
    expect(await offerRows(t)).toHaveLength(0);
    const plan = await s.as.query(api.billing.planAndUsage, { companyId: s.companyId });
    expect(plan.connected && plan.account?.subscription.endsAt).toBeNull();
    // Viewing used no eligibility: a later flow still gets both offers.
    const again = await view(s, await open(s));
    expect([again.offers.save10_once.eligible, again.offers.save15_three.eligible]).toEqual([true, true]);
    // A reason that isn't on the list is refused; an answer is never required.
    expect(await refusal(s.as.mutation(api.cancellation.answer, { companyId: s.companyId, flowId, step: "reason", code: "made_up" }))).toMatch(/listed/);
    await s.as.mutation(api.cancellation.answer, { companyId: s.companyId, flowId, step: "reason" });
  });

  it("applies 10% off the next $299 payment in Stripe, limited to the subscription, and says so only once Stripe shows it", async () => {
    const t = start();
    const s = await subscribed(t);
    const flowId = await open(s);
    const shown = (await view(s, flowId)).offers.save10_once;
    expect(shown).toMatchObject({ eligible: true, percent: 10, renewals: [{ at: s.periodEnd - (s.periodEnd % 1000), baseCents: 299_00, discountCents: 29_90, totalCents: 269_10 }], resumesCents: 299_00 });
    const rowId = await acceptFrom(s, flowId, "save10_once");
    const [coupon] = [...stripe.state.platform.coupons.values()];
    expect(coupon).toMatchObject({ percent_off: 10, duration: "once", duration_in_months: null, applies_to: { products: ["prod_29900"] }, max_redemptions: 1 });
    expect(stripe.state.platform.subscriptions.get(s.sub.id)!.discounts).toEqual([{ id: expect.any(String), coupon: coupon.id }]);
    // No proration, no invoice now: the discount starts with the next renewal.
    const apply = stripe.state.calls.find((call) => call.method === "POST" && call.path === `/v1/subscriptions/${s.sub.id}`)!;
    expect(apply.key).toBe(`retention-apply:${rowId}`);
    const flow = await view(s, flowId);
    expect(flow.accepted).toMatchObject({ state: "applied", percent: 10 });
    expect(flow.outcome).toBe("offer_accepted");
    expect(await notices(t, s.companyId, "offer_applied")).toHaveLength(1);
    const status = await s.as.query(api.cancellation.status, { companyId: s.companyId });
    expect(status).toMatchObject({ offer: { percent: 10, renewalsLeft: 1 }, next: { cents: 269_10, discounted: true } });
    // The plan is untouched in Autumn: still active, still renewing.
    expect(autumnUpdates()).toHaveLength(0);
  });

  it("applies 15% off three $199 payments without touching the early-user price or its year", async () => {
    const t = start();
    const s = await subscribed(t, "owner-a", "Alpha Cleaning", "operate_early");
    const endsAt = NOW + 200 * DAY;
    // The sync claimed the place; its year ends well after the three discounted payments.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("earlyOffers").first())!;
      await ctx.db.patch(row._id, { state: "claimed", offerEndsAt: endsAt });
    });
    const flowId = await open(s);
    const shown = (await view(s, flowId)).offers.save15_three;
    expect(shown).toMatchObject({ eligible: true, totalCents: 507_45, savingsCents: 89_55, resumesCents: 199_00 });
    await acceptFrom(s, flowId, "save15_three");
    const [coupon] = [...stripe.state.platform.coupons.values()];
    expect(coupon).toMatchObject({ percent_off: 15, duration: "repeating", duration_in_months: 3, applies_to: { products: ["prod_19900"] } });
    expect((await offerRows(t))[0]).toMatchObject({ state: "applied", autumnPlanId: "operate_early" });
    // The early-user record is unchanged: same end of the year, nothing moved.
    const early = await t.run(async (ctx) => ctx.db.query("earlyOffers").first());
    expect(early).toMatchObject({ state: "claimed", offerEndsAt: endsAt });
    expect(billing.state.calls.filter((call) => call.path === "/v1/billing.attach")).toHaveLength(0);
  });

  it("accepts one offer once: a second click, a second tab, and the other offer are all refused or the same one", async () => {
    const t = start();
    const s = await subscribed(t);
    const tabA = await open(s);
    const tabB = await open(s);
    const a = (await view(s, tabA)).offers.save10_once;
    const b = (await view(s, tabB)).offers.save15_three;
    if (!a.eligible || !b.eligible) throw new Error("both offered");
    const results = await Promise.allSettled([
      s.as.mutation(api.cancellation.accept, { companyId: s.companyId, flowId: tabA, offerId: "save10_once", version: a.version }),
      s.as.mutation(api.cancellation.accept, { companyId: s.companyId, flowId: tabB, offerId: "save15_three", version: b.version }),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    // The same tab clicking again gets the same offer back.
    const winner = results[0].status === "fulfilled" ? tabA : tabB;
    const winnerOffer = winner === tabA ? "save10_once" : "save15_three";
    const again = await s.as.mutation(api.cancellation.accept, { companyId: s.companyId, flowId: winner, offerId: winnerOffer, version: winner === tabA ? a.version : b.version });
    expect(again).toBe(results[0].status === "fulfilled" ? results[0].value : (results[1] as PromiseFulfilledResult<Id<"retentionOffers">>).value);
    await settle(t);
    expect(stripe.state.platform.coupons.size).toBe(1);
    expect(await offerRows(t)).toHaveLength(1);
    // The other offer can't be added on top: never combined.
    expect(await refusal(s.as.mutation(api.cancellation.accept, { companyId: s.companyId, flowId: winner, offerId: winnerOffer === "save10_once" ? "save15_three" : "save10_once", version: "x" }))).toMatch(/can’t be combined/);
    // And a new flow within 12 months offers neither.
    const later = await view(s, await open(s));
    expect([later.offers.save10_once.eligible, later.offers.save15_three.eligible]).toEqual([false, false]);
    expect(later.offers.save10_once.eligible === false && later.offers.save10_once.words).toMatch(/last 12 months/);
  });

  it("refuses terms that changed since they were shown, and terms that are too old", async () => {
    const t = start();
    const s = await subscribed(t);
    const flowId = await open(s);
    expect(await refusal(s.as.mutation(api.cancellation.accept, { companyId: s.companyId, flowId, offerId: "save10_once", version: "not-the-terms-shown" }))).toMatch(/terms changed/);
    vi.setSystemTime(NOW + 20 * 60_000);
    const shown = (await view(s, flowId)).offers.save10_once;
    expect(shown.eligible && shown.stale).toBe(true);
    expect(await refusal(s.as.mutation(api.cancellation.accept, { companyId: s.companyId, flowId, offerId: "save10_once", version: shown.eligible ? shown.version : "" }))).toMatch(/checking your billing details again/);
    // The screen asks for a fresh read when what it shows is stale.
    await s.as.mutation(api.cancellation.recheck, { companyId: s.companyId, flowId });
    await settle(t);
    // Read again: fresh terms can be accepted.
    const fresh = (await view(s, flowId)).offers.save10_once;
    expect(fresh.eligible && fresh.stale).toBe(false);
    await acceptFrom(s, flowId, "save10_once");
    expect((await offerRows(t))[0].state).toBe("applied");
  });

  it("re-checks Stripe before applying: a promotion that appeared in between is never replaced", async () => {
    const t = start();
    const s = await subscribed(t);
    const flowId = await open(s);
    const shown = (await view(s, flowId)).offers.save10_once;
    // Someone added a promotion after the preview was read.
    s.sub.discounts = [{ id: "di_promo", coupon: "PARTNER20" }];
    await s.as.mutation(api.cancellation.accept, { companyId: s.companyId, flowId, offerId: "save10_once", version: shown.eligible ? shown.version : "" });
    await settle(t);
    expect(s.sub.discounts).toEqual([{ id: "di_promo", coupon: "PARTNER20" }]);
    expect(stripe.state.platform.coupons.size).toBe(0);
    const row = (await offerRows(t))[0];
    expect(row).toMatchObject({ state: "failed" });
    // A failure uses nothing up; the flow is open again (and now shows no offer, because of the promotion).
    const after = await view(s, flowId);
    expect(after.outcome).toBeNull();
    expect(after.accepted).toMatchObject({ state: "failed" });
  });

  it("makes no offer, but still cancels, for a promotion already on the subscription and for an unsupported plan", async () => {
    const t = start();
    const promo = await subscribed(t, "owner-a", "Alpha Cleaning", "operate", { discounts: [{ id: "di_1", coupon: "LAUNCH" }] });
    const annual = await subscribed(t, "owner-b", "Beta Cleaning", "operate", { interval: "year" });
    for (const s of [promo, annual]) {
      const flowId = await open(s);
      const flow = await view(s, flowId);
      expect([flow.offers.save10_once.eligible, flow.offers.save15_three.eligible]).toEqual([false, false]);
      await s.as.mutation(api.billing.cancelPlan, { companyId: s.companyId, flowId });
      await settle(t);
      expect((await view(s, flowId)).cancel).toMatchObject({ stage: "done" });
    }
    expect(stripe.state.platform.coupons.size).toBe(0);
    const ineligible = await t.run(async (ctx) => (await ctx.db.query("cancelFlows").collect()).map((row) => row.ineligible));
    expect(ineligible).toEqual(["existing_discount", "not_monthly"]);
  });

  it("makes no offer to a past-due account, and never calls Stripe for one that is locked or already ending", async () => {
    const t = start();
    const s = await subscribed(t);
    billing.customerFor(`company_${s.companyId}`).pastDue = true;
    await t.action(internal.billing.syncCompany, { companyId: s.companyId });
    const flow = await view(s, await open(s));
    expect(flow.offers.save10_once.eligible).toBe(false);
    expect(flow.offers.save10_once.eligible === false && flow.offers.save10_once.words).toMatch(/payment didn’t go through/);
    expect(stripe.state.calls).toHaveLength(0);
  });

  it("survives Stripe's answers being lost: the same coupon and the same update, never a second discount", async () => {
    const t = start();
    const s = await subscribed(t);
    const flowId = await open(s);
    // The coupon is made but its answer is lost, then the update goes through and its answer is lost too.
    stripe.state.losses.push({ path: /^POST \/v1\/coupons$/, when: "after" }, { path: new RegExp(`^POST /v1/subscriptions/${s.sub.id}$`), when: "after" });
    await acceptFrom(s, flowId, "save10_once");
    const row = (await offerRows(t))[0];
    expect(row.state).toBe("applied");
    expect(stripe.state.platform.coupons.size).toBe(1);
    expect(s.sub.discounts).toHaveLength(1);
    const couponCalls = stripe.state.calls.filter((call) => call.method === "POST" && call.path === "/v1/coupons");
    expect(new Set(couponCalls.map((call) => call.key))).toEqual(new Set([`retention-coupon:${row._id}`]));
    expect(await notices(t, s.companyId, "offer_applied")).toHaveLength(1);
  });

  it("leaves an offer Stripe never answers about as unconfirmed, then settles it from Stripe's own record", async () => {
    const t = start();
    const s = await subscribed(t);
    const flowId = await open(s);
    stripe.state.losses.push({ path: /^POST \/v1\/coupons$/, when: "before", times: 10 });
    await acceptFrom(s, flowId, "save10_once");
    expect((await offerRows(t))[0]).toMatchObject({ state: "unconfirmed" });
    expect((await view(s, flowId)).accepted).toMatchObject({ state: "unconfirmed", problem: expect.stringMatching(/never be applied twice/) });
    // Stripe is back; the hourly sweep asks again under the same keys.
    stripe.state.losses = [];
    vi.setSystemTime(NOW + 2 * 60 * 60_000);
    await t.mutation(internal.cancellation.sweep, {});
    await settle(t);
    expect((await offerRows(t))[0]).toMatchObject({ state: "applied" });
    expect(s.sub.discounts).toHaveLength(1);
  });

  it("cancels at the end of the paid period, tells the Owner once, and reactivates without a charge", async () => {
    const t = start();
    const s = await subscribed(t);
    const flowId = await open(s);
    await s.as.mutation(api.cancellation.answer, { companyId: s.companyId, flowId, step: "skip" });
    const first = await s.as.mutation(api.billing.cancelPlan, { companyId: s.companyId, flowId });
    // A double click is the same request, not a second one.
    expect(await s.as.mutation(api.billing.cancelPlan, { companyId: s.companyId, flowId })).toBe(first);
    await settle(t);
    expect(autumnUpdates().map((call) => call.body)).toEqual([expect.objectContaining({ cancel_action: "cancel_end_of_cycle", plan_id: "operate" })]);
    const flow = await view(s, flowId);
    expect(flow.cancel).toMatchObject({ stage: "done" });
    expect(flow.outcome).toBe("canceled");
    // Paid access continues to the end of the period.
    expect(flow.plan).toMatchObject({ active: true, endsAt: billing.customerFor(`company_${s.companyId}`).periodEnd });
    // Duplicate and late webhooks re-read Autumn: still one confirmation.
    await t.action(internal.billing.syncCompany, { companyId: s.companyId });
    await t.action(internal.billing.syncCompany, { companyId: s.companyId });
    expect(await notices(t, s.companyId, "cancel_scheduled")).toHaveLength(1);
    // Reactivate before the period ends: the cancellation is removed, nothing is attached or charged.
    await s.as.mutation(api.billing.resumePlan, { companyId: s.companyId, flowId });
    await settle(t);
    expect(autumnUpdates().map((call) => call.body.cancel_action)).toEqual(["cancel_end_of_cycle", "uncancel"]);
    expect(billing.state.calls.filter((call) => call.path === "/v1/billing.attach")).toHaveLength(0);
    expect((await view(s, flowId)).plan.endsAt).toBeNull();
    expect(await notices(t, s.companyId, "reactivated")).toHaveLength(1);
  });

  it("keeps the flow's progress when cancelling fails, and shows the reason", async () => {
    const t = start();
    const s = await subscribed(t);
    const flowId = await open(s);
    await s.as.mutation(api.cancellation.answer, { companyId: s.companyId, flowId, step: "reason", code: "not_reliable" });
    billing.state.refuseOnce.push("/v1/billing.update");
    await s.as.mutation(api.billing.cancelPlan, { companyId: s.companyId, flowId });
    await settle(t);
    const flow = await view(s, flowId);
    expect(flow.cancel).toMatchObject({ stage: "failed", problem: expect.any(String) });
    expect(flow.outcome).toBeNull();
    expect(flow.reason).toBe("not_reliable");
    expect(flow.support).toEqual({ email: "support@selestial.io" });
    expect(flow.detail).toEqual({ question: "What wasn’t working reliably?", answer: null });
    await s.as.mutation(api.cancellation.answer, { companyId: s.companyId, flowId, step: "detail", note: "Texts to cleaners went out twice." });
    expect((await view(s, flowId)).detail).toEqual({ question: "What wasn’t working reliably?", answer: "Texts to cleaners went out twice." });
    expect(flow.plan.endsAt).toBeNull();
    expect(await notices(t, s.companyId, "cancel_scheduled")).toHaveLength(0);
  });

  it("ends access at the period end with one notice, after one cancellation notice", async () => {
    const t = start();
    const s = await subscribed(t);
    await s.as.mutation(api.billing.cancelPlan, { companyId: s.companyId });
    await settle(t);
    billing.renew(s.companyId);
    await t.action(internal.billing.syncCompany, { companyId: s.companyId });
    await t.action(internal.billing.syncCompany, { companyId: s.companyId });
    expect(await notices(t, s.companyId, "ended")).toHaveLength(1);
    expect(await notices(t, s.companyId, "cancel_scheduled")).toHaveLength(1);
  });

  it("blocks plan changes while a discount is running, so the discount can't silently end", async () => {
    const t = start();
    const s = await subscribed(t, "owner-a", "Alpha Cleaning", "expand");
    const flowId = await open(s);
    expect((await view(s, flowId)).offers.save15_three).toMatchObject({ eligible: true, totalCents: 1272_45 });
    await acceptFrom(s, flowId, "save15_three");
    expect(await refusal(s.as.mutation(api.billing.startPlanChange, { companyId: s.companyId, plan: "operate" }))).toMatch(/discount applies to your current plan/);
  });

  it("records what Stripe actually discounted and collected, once per event, and reports it apart from projections", async () => {
    const t = start();
    const s = await subscribed(t);
    await acceptFrom(s, await open(s), "save10_once");
    const paid = { id: "evt_paid_1", type: "invoice.paid", created: Math.floor((NOW + 21 * DAY) / 1000), data: { object: { id: "in_ret_1", customer: s.sub.customer, subscription: s.sub.id, billing_reason: "subscription_cycle", subtotal: 299_00, amount_paid: 269_10, amount_due: 269_10, amount_remaining: 0, currency: "usd", total_discount_amounts: [{ amount: 29_90 }] } } };
    vi.setSystemTime(NOW + 21 * DAY);
    expect(await deliver(t, paid)).toBe(200);
    expect(await deliver(t, paid)).toBe(200);
    const row = (await offerRows(t))[0];
    expect(row.invoices).toEqual([expect.objectContaining({ invoiceId: "in_ret_1", status: "paid", discountCents: 29_90, paidCents: 269_10, refundedCents: 0 })]);
    await deliver(t, { id: "evt_refund_1", type: "charge.refunded", created: Math.floor(Date.now() / 1000), data: { object: { invoice: "in_ret_1", amount_refunded: 100_00 } } });
    process.env.STAFF_BOOTSTRAP_EMAIL = "staff@selestial.example";
    const staff = t.withIdentity({ subject: "user_staff", email: "staff@selestial.example", emailVerified: true, name: "Staff" });
    const report = await staff.query(api.cancellation.report, {});
    expect(report.flowsStarted).toBe(1);
    expect(report.offers.find((row) => row.offerId === "save10_once")).toMatchObject({ accepted: 1, applied: 1 });
    expect(report.money).toMatchObject({ discountsAppliedCents: 29_90, collectedCents: 169_10, refundedCents: 100_00, projectedCents: 0 });
    delete process.env.STAFF_BOOTSTRAP_EMAIL;
  });
});

describe("agents after access ends", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("refuses an agent's message at send time once the plan has ended, but lets a person send", async () => {
    const s = await dispatchSetup(["Lena"]);
    const check = (origin: "dispatch" | "manual") =>
      s.as.query(api.consent.check, { companyId: s.companyId, channel: "sms", to: PHONES.Lena, recipient: { kind: "cleaner", id: s.cleaners.Lena as string }, category: "operational", origin, agent: origin === "dispatch" ? "dispatch" : undefined });
    billing.seed(s.companyId, { plan: "operate" });
    await s.t.action(internal.billing.syncCompany, { companyId: s.companyId });
    expect(await check("dispatch")).toEqual({ ok: true });
    billing.customerFor(`company_${s.companyId}`).plan = null;
    await s.t.action(internal.billing.syncCompany, { companyId: s.companyId });
    await flush(s.t);
    expect(await check("dispatch")).toMatchObject({ ok: false, code: "no_plan" });
    expect(await check("manual")).toEqual({ ok: true });
  });
});
