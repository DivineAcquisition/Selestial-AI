/**
 * The retention offers' arithmetic and rules (convex/lib/billing/retention.ts), without any database or
 * provider: the exact cents for $199, $299 and $499, an early-user year ending inside an offer, and every
 * reason an offer is not made.
 */
import { describe, expect, it } from "vitest";

import { accountProblem, offerVerdict, percentOf, renewalAt, retentionInvoiceOf, schedule, type EligibilityInput, type SubscriptionFacts } from "./retention";

const DAY = 86_400_000;
const NOW = Date.UTC(2027, 2, 1, 12, 0);
const PERIOD_END = Date.UTC(2027, 2, 15, 12, 0);

function facts(fields: Partial<Extract<SubscriptionFacts, { ok: true }>> = {}): SubscriptionFacts {
  return { ok: true, fetchedAt: NOW, livemode: false, stripeCustomerId: "cus_1", subscriptionId: "sub_1", status: "active", currency: "usd", interval: "month", intervalCount: 1, baseItemId: "si_1", basePriceId: "price_1", baseProductId: "prod_1", baseCents: 299_00, periodEnd: PERIOD_END, anchorAt: PERIOD_END, discountIds: [], couponIds: [], scheduleId: null, cancelAtPeriodEnd: false, trialEnd: null, ...fields };
}

function input(fields: Partial<EligibilityInput> = {}, account: Partial<NonNullable<EligibilityInput["account"]>> = {}, sub: Partial<Extract<SubscriptionFacts, { ok: true }>> = {}): EligibilityInput {
  return {
    now: NOW,
    billingConnected: true,
    account: { plan: "operate", autumnPlanId: "operate", pastDue: false, periodEnd: PERIOD_END, endsAt: null, scheduledAutumnPlanId: null, ...account },
    locked: false,
    earlyEndsAt: null,
    facts: facts(sub),
    lastAcceptedAt: null,
    inFlight: false,
    acrossPriceChange: false,
    ...fields,
  };
}

describe("retention offer amounts", () => {
  it("takes 10% off one payment: $199 → $179.10, $299 → $269.10", () => {
    const early = schedule("save10_once", { planCents: 199_00, periodEnd: PERIOD_END, anchorAt: PERIOD_END, earlyEndsAt: PERIOD_END + 200 * DAY, currency: "usd", subscriptionId: "sub_1", fetchedAt: NOW });
    expect(early.renewals).toEqual([{ at: PERIOD_END, baseCents: 199_00, discountCents: 19_90, totalCents: 179_10 }]);
    expect(early).toMatchObject({ savingsCents: 19_90, totalCents: 179_10, resumesCents: 199_00 });
    const standard = schedule("save10_once", { planCents: 299_00, periodEnd: PERIOD_END, anchorAt: PERIOD_END, earlyEndsAt: null, currency: "usd", subscriptionId: "sub_1", fetchedAt: NOW });
    expect(standard.renewals[0]).toEqual({ at: PERIOD_END, baseCents: 299_00, discountCents: 29_90, totalCents: 269_10 });
    expect(standard.resumesAt).toBe(Date.UTC(2027, 3, 15, 12, 0));
  });

  it("takes 15% off three payments: $199 → $169.15 each ($507.45, saving $89.55), $299 → $254.15 each ($762.45, saving $134.55)", () => {
    const early = schedule("save15_three", { planCents: 199_00, periodEnd: PERIOD_END, anchorAt: PERIOD_END, earlyEndsAt: PERIOD_END + 200 * DAY, currency: "usd", subscriptionId: "sub_1", fetchedAt: NOW });
    expect(early.renewals.map((row) => row.totalCents)).toEqual([169_15, 169_15, 169_15]);
    expect(early).toMatchObject({ totalCents: 507_45, savingsCents: 89_55, resumesCents: 199_00 });
    const standard = schedule("save15_three", { planCents: 299_00, periodEnd: PERIOD_END, anchorAt: PERIOD_END, earlyEndsAt: null, currency: "usd", subscriptionId: "sub_1", fetchedAt: NOW });
    expect(standard.renewals.map((row) => row.totalCents)).toEqual([254_15, 254_15, 254_15]);
    expect(standard).toMatchObject({ totalCents: 762_45, savingsCents: 134_55, resumesCents: 299_00 });
    expect(standard.renewals.map((row) => new Date(row.at).toISOString().slice(0, 10))).toEqual(["2027-03-15", "2027-04-15", "2027-05-15"]);
    expect(new Date(standard.resumesAt).toISOString().slice(0, 10)).toBe("2027-06-15");
  });

  it("works for the legacy $499 plan too", () => {
    const expand = schedule("save15_three", { planCents: 499_00, periodEnd: PERIOD_END, anchorAt: PERIOD_END, earlyEndsAt: null, currency: "usd", subscriptionId: "sub_1", fetchedAt: NOW });
    expect(expand).toMatchObject({ totalCents: 1272_45, savingsCents: 224_55 });
    expect(schedule("save10_once", { planCents: 499_00, periodEnd: PERIOD_END, anchorAt: PERIOD_END, earlyEndsAt: null, currency: "usd", subscriptionId: "sub_1", fetchedAt: NOW }).renewals[0].totalCents).toBe(449_10);
  });

  it("prices each renewal from its own base: when the early-user year ends inside the offer, later renewals are 15% off $299", () => {
    // The year ends on the second renewal: the first is $199, the next two are $299.
    const endsAt = renewalAt(PERIOD_END, 1, PERIOD_END);
    const preview = schedule("save15_three", { planCents: 199_00, periodEnd: PERIOD_END, anchorAt: PERIOD_END, earlyEndsAt: endsAt, currency: "usd", subscriptionId: "sub_1", fetchedAt: NOW });
    expect(preview.renewals.map((row) => [row.baseCents, row.discountCents, row.totalCents])).toEqual([
      [199_00, 29_85, 169_15],
      [299_00, 44_85, 254_15],
      [299_00, 44_85, 254_15],
    ]);
    expect(preview).toMatchObject({ totalCents: 677_45, savingsCents: 119_55, resumesCents: 299_00 });
  });

  it("rounds a percentage to the nearest cent, half up, in whole cents only", () => {
    expect(percentOf(199_00, 15)).toBe(29_85);
    expect(percentOf(1_05, 10)).toBe(11);
    expect(percentOf(1_15, 10)).toBe(12);
    expect(() => percentOf(19.9, 10)).toThrow();
  });

  it("keeps renewals on the billing day, at the last day of a shorter month (Stripe's rule)", () => {
    const jan31 = Date.UTC(2027, 0, 31, 9, 0);
    expect([1, 2, 3].map((k) => new Date(renewalAt(jan31, k, jan31)).toISOString().slice(0, 10))).toEqual(["2027-02-28", "2027-03-31", "2027-04-30"]);
  });

  it("gives the same terms a different fingerprint when anything about them changes", () => {
    const base = { planCents: 299_00, periodEnd: PERIOD_END, anchorAt: PERIOD_END, earlyEndsAt: null, currency: "usd", subscriptionId: "sub_1", fetchedAt: NOW };
    const a = schedule("save15_three", base).version;
    expect(schedule("save15_three", { ...base, fetchedAt: NOW + 1000 }).version).toBe(a);
    expect(schedule("save15_three", { ...base, periodEnd: PERIOD_END + DAY, anchorAt: PERIOD_END + DAY }).version).not.toBe(a);
    expect(schedule("save15_three", { ...base, planCents: 199_00 }).version).not.toBe(a);
    expect(schedule("save10_once", base).version).not.toBe(a);
  });
});

describe("who gets an offer", () => {
  it("offers both to an active monthly Operate subscription with nothing else on it", () => {
    expect(accountProblem(input())).toBeNull();
    expect(offerVerdict("save10_once", input())).toMatchObject({ eligible: true, preview: { totalCents: 269_10 } });
    expect(offerVerdict("save15_three", input())).toMatchObject({ eligible: true, preview: { totalCents: 762_45 } });
  });

  it("explains every account it can't make an offer to", () => {
    const cases: [EligibilityInput, string][] = [
      [input({ billingConnected: false }), "billing_off"],
      [input({ account: null }), "no_plan"],
      [input({}, { endsAt: PERIOD_END }), "ending"],
      [input({}, { pastDue: true }), "past_due"],
      [input({ locked: true }), "locked"],
      [input({}, { autumnPlanId: "custom_enterprise" }), "unsupported_plan"],
      [input({}, { scheduledAutumnPlanId: "operate" }), "scheduled_change"],
      [input({ lastAcceptedAt: NOW - 100 * DAY }), "used_recently"],
      [input({ inFlight: true }), "in_progress"],
      [input({ facts: null }), "checking"],
      [input({ facts: { ok: false, fetchedAt: NOW, reason: "stripe_unavailable" } }), "stripe_unavailable"],
      [input({}, {}, { status: "trialing" }), "trial"],
      [input({}, {}, { status: "past_due" }), "not_active"],
      [input({}, {}, { interval: "year" }), "not_monthly"],
      [input({}, {}, { currency: "eur" }), "currency"],
      [input({}, {}, { baseCents: 250_00 }), "price_mismatch"],
      [input({}, {}, { cancelAtPeriodEnd: true }), "ending"],
      [input({}, {}, { discountIds: ["di_promo"] }), "existing_discount"],
      [input({}, { periodEnd: PERIOD_END + 3 * DAY }), "period_mismatch"],
    ];
    for (const [given, reason] of cases) expect([reason, accountProblem(given)]).toEqual([reason, reason]);
  });

  it("allows a new offer once 12 months have passed since the last one", () => {
    expect(accountProblem(input({ lastAcceptedAt: NOW - 366 * DAY }))).toBeNull();
  });

  it("never combines with an existing promotion: a subscription with any discount gets no offer", () => {
    expect(offerVerdict("save15_three", input({}, {}, { discountIds: ["di_1"], couponIds: ["early_promo"] }))).toEqual({ eligible: false, reason: "existing_discount" });
  });

  it("prices the early-user plan from $199 and needs the end of its year", () => {
    const early = input({ earlyEndsAt: PERIOD_END + 200 * DAY }, { autumnPlanId: "operate_early" }, { baseCents: 199_00 });
    expect(offerVerdict("save15_three", early)).toMatchObject({ eligible: true, preview: { totalCents: 507_45 } });
    expect(offerVerdict("save15_three", { ...early, earlyEndsAt: null })).toEqual({ eligible: false, reason: "unsupported_plan" });
  });

  it("holds back an offer that would run past the end of the early-user year until that is verified, and allows it when switched on", () => {
    const crossing = input({ earlyEndsAt: renewalAt(PERIOD_END, 1, PERIOD_END) }, { autumnPlanId: "operate_early" }, { baseCents: 199_00 });
    expect(offerVerdict("save15_three", crossing)).toEqual({ eligible: false, reason: "crosses_price_change" });
    // The 10% offer is on the one renewal before the year ends, so it is still made.
    expect(offerVerdict("save10_once", crossing)).toMatchObject({ eligible: true, preview: { totalCents: 179_10 } });
    expect(offerVerdict("save15_three", { ...crossing, acrossPriceChange: true })).toMatchObject({ eligible: true, preview: { totalCents: 677_45 } });
    // In the 12th period, with the move to $299 already scheduled, the next renewal is at $299.
    const twelfth = input({ earlyEndsAt: PERIOD_END }, { autumnPlanId: "operate_early", scheduledAutumnPlanId: "operate" }, { baseCents: 199_00, scheduleId: "sub_sched_1" });
    expect(offerVerdict("save10_once", twelfth)).toEqual({ eligible: false, reason: "crosses_price_change" });
  });

  it("makes no offer while Stripe has its own scheduled change on the subscription", () => {
    expect(offerVerdict("save10_once", input({}, {}, { scheduleId: "sub_sched_1" }))).toEqual({ eligible: false, reason: "provider_schedule" });
  });
});

describe("Stripe's invoice events for the report", () => {
  it("reads a paid plan invoice's discount and amount paid, and a refund", () => {
    const paid = retentionInvoiceOf(JSON.stringify({ id: "evt_1", type: "invoice.paid", created: 1_800_000_000, data: { object: { id: "in_1", subscription: "sub_1", subtotal: 29900, amount_paid: 26910, total_discount_amounts: [{ amount: 2990, discount: "di_1" }] } } }));
    expect(paid).toMatchObject({ invoiceId: "in_1", subscriptionId: "sub_1", status: "paid", subtotalCents: 29900, discountCents: 2990, paidCents: 26910 });
    const basil = retentionInvoiceOf(JSON.stringify({ id: "evt_2", type: "invoice.payment_failed", data: { object: { id: "in_2", parent: { subscription_details: { subscription: "sub_1" } }, subtotal: 29900, amount_paid: 0 } } }));
    expect(basil).toMatchObject({ subscriptionId: "sub_1", status: "payment_failed", paidCents: 0 });
    expect(retentionInvoiceOf(JSON.stringify({ id: "evt_3", type: "charge.refunded", data: { object: { invoice: "in_1", amount_refunded: 26910 } } }))).toMatchObject({ invoiceId: "in_1", refundedCents: 26910 });
    expect(retentionInvoiceOf(JSON.stringify({ id: "evt_4", type: "customer.updated", data: { object: {} } }))).toBeNull();
    expect(retentionInvoiceOf("not json")).toBeNull();
  });
});
