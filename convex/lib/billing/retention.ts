/**
 * Cancellation and retention offers (docs/billing/05-cancellation.md). The pure rules, in one place, so the
 * screen, the accepting mutation and the billing action all decide the same way:
 *
 *   - the reason codes people pick (stable ids, apart from the words shown);
 *   - the two offers, 10% off one monthly payment and 15% off three, which are alternatives, never combined;
 *   - who may see an offer, and why not, decided only from Selestial's copy of Autumn's record and Stripe's
 *     own subscription read back by the server (never from anything the browser sends);
 *   - the payment schedule an offer produces, in whole cents, renewal by renewal, from the base price each
 *     renewal will actually have (an early-user year that ends inside the offer is priced at $299 from then).
 *
 * Where the discount lives: on Stripe's subscription underneath Autumn (Autumn's API applies discounts only
 * when a plan is attached, and its customer record does not report them). One Stripe coupon per accepted
 * offer, limited to the subscription's own base product and redeemable once, so it never discounts SMS,
 * email, credit top-ups or other usage lines (docs/billing/05-cancellation.md, sandbox check 4).
 */
import { AUTUMN, PLANS } from "./catalog";

const DAY = 86_400_000;
/** Autumn's and Stripe's period ends may differ by rounding; this much is the same renewal. */
export const PERIOD_SLACK_MS = DAY;
/** A preview is good for this long. After it, accepting asks Stripe again and shows the new terms if anything changed. */
export const PREVIEW_TTL_MS = 15 * 60_000;
/** One accepted offer per company in any rolling 12 months. */
export const OFFER_COOLDOWN_MS = 365 * DAY;
/** The rules version recorded with every flow and offer, so a report can tell old terms from new ones. */
export const RETENTION_POLICY = "retention-2026-11";

// ── What people answer ───────────────────────────────────────────────────────────────────────────

export const CANCEL_REASONS = ["price_too_high", "not_enough_value", "setup_time", "not_reliable", "missing_feature", "business_slowing", "switching_platform", "other"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];
export const CANCEL_REASON_WORDS: Record<CancelReason, string> = {
  price_too_high: "The price is too high.",
  not_enough_value: "I haven’t seen enough value yet.",
  setup_time: "Getting set up has taken too much time.",
  not_reliable: "Something isn’t working reliably.",
  missing_feature: "It’s missing something my business needs.",
  business_slowing: "My business is slowing down or pausing.",
  switching_platform: "I’m switching to another platform.",
  other: "Something else.",
};

export const STAY_NEEDS = ["lower_price", "setup_help", "clearer_results", "feature_or_integration", "reliability", "nothing"] as const;
export type StayNeed = (typeof STAY_NEEDS)[number];
export const STAY_NEED_WORDS: Record<StayNeed, string> = {
  lower_price: "A lower price for the next few months.",
  setup_help: "Help getting my agents and workflows running.",
  clearer_results: "Clearer results from the platform.",
  feature_or_integration: "A specific feature or integration.",
  reliability: "More reliable performance.",
  nothing: "Nothing right now—I need to cancel.",
};

/** Reasons a discount does not fix. The screen says so plainly and points to people who can help. */
export const SUPPORT_REASONS: readonly CancelReason[] = ["setup_time", "not_reliable"];

// ── The offers ───────────────────────────────────────────────────────────────────────────────────

export const OFFER_IDS = ["save10_once", "save15_three"] as const;
export type OfferId = (typeof OFFER_IDS)[number];
export const OFFERS: Record<OfferId, { percent: number; renewals: number }> = {
  save10_once: { percent: 10, renewals: 1 },
  save15_three: { percent: 15, renewals: 3 },
};

/**
 * The monthly subscriptions an offer may apply to, by Autumn's plan id, with the base price Stripe must show
 * for it. Anything else (annual, trial, custom, legacy, a price that doesn't match) can still cancel, never
 * gets an offer.
 */
export const OFFER_PLANS: Record<string, { cents: number; name: string }> = {
  [AUTUMN.plans.operate]: { cents: PLANS.operate.monthlyCents, name: "Operate" },
  [AUTUMN.earlyPlan]: { cents: 199_00, name: "Operate (early-user price)" },
  [AUTUMN.plans.expand]: { cents: PLANS.expand.monthlyCents, name: "Expand" },
};

/**
 * Stripe's subscription, as the server read it back, reduced to what the rules need. `ok: false` when it
 * could not be read or found; the offers are then hidden and cancellation still works.
 */
export type SubscriptionFacts =
  | {
      ok: true;
      fetchedAt: number;
      livemode: boolean;
      stripeCustomerId: string;
      subscriptionId: string;
      status: string;
      currency: string;
      interval: string;
      intervalCount: number;
      baseItemId: string;
      basePriceId: string;
      baseProductId: string;
      baseCents: number;
      /** When the current paid period ends: the next renewal. */
      periodEnd: number;
      /** Stripe's billing cycle anchor: renewals fall on its day of the month. */
      anchorAt: number;
      /** Discounts already on the subscription (a promotion, or an earlier retention coupon). */
      discountIds: string[];
      /** Coupons behind those discounts, when Stripe expanded them. */
      couponIds: string[];
      scheduleId: string | null;
      cancelAtPeriodEnd: boolean;
      trialEnd: number | null;
    }
  | { ok: false; fetchedAt: number; reason: FactsProblem };

export type FactsProblem = "stripe_off" | "stripe_env_mismatch" | "stripe_unavailable" | "no_customer" | "no_subscription" | "several_subscriptions";

/** What Selestial's copy of Autumn's record says about the plan (billingAccounts). */
export type AccountFacts = {
  plan: string | null;
  autumnPlanId: string | null;
  pastDue: boolean;
  periodEnd: number | null;
  endsAt: number | null;
  scheduledAutumnPlanId: string | null;
};

export type EligibilityInput = {
  now: number;
  billingConnected: boolean;
  account: AccountFacts | null;
  /** The account is locked for an unpaid plan invoice (convex/billingLock.ts). */
  locked: boolean;
  /** The early-user year, when the company holds a place: the first renewal at the full price. */
  earlyEndsAt: number | null;
  facts: SubscriptionFacts | null;
  /** The most recent accepted offer (any state but failed), for the 12-month rule. */
  lastAcceptedAt: number | null;
  /** An offer is being applied right now (another tab, a retry). */
  inFlight: boolean;
  /** Whether an offer may run across the end of the early-user year (RETENTION_ACROSS_PRICE_CHANGE=on). */
  acrossPriceChange: boolean;
};

export type Ineligible =
  | "billing_off"
  | "no_plan"
  | "ending"
  | "past_due"
  | "locked"
  | "unsupported_plan"
  | "scheduled_change"
  | "used_recently"
  | "in_progress"
  | "checking"
  | FactsProblem
  | "not_active"
  | "trial"
  | "not_monthly"
  | "currency"
  | "price_mismatch"
  | "period_mismatch"
  | "existing_discount"
  | "provider_schedule"
  | "crosses_price_change";

/** Words for staff and the report. Customers see a simpler line (`customerWords`). */
export const INELIGIBLE_WORDS: Record<Ineligible, string> = {
  billing_off: "Billing isn't connected on this deployment.",
  no_plan: "No active plan.",
  ending: "The plan is already set to end.",
  past_due: "The last plan payment didn't go through.",
  locked: "The account is locked for an unpaid invoice.",
  unsupported_plan: "This kind of plan has no retention policy yet.",
  scheduled_change: "A plan change is scheduled.",
  used_recently: "A retention offer was accepted in the last 12 months.",
  in_progress: "An offer is being applied right now.",
  checking: "Billing details are still being read.",
  stripe_off: "Stripe isn't configured for Selestial's own billing.",
  stripe_env_mismatch: "Stripe's mode doesn't match Autumn's environment.",
  stripe_unavailable: "Stripe couldn't be reached.",
  no_customer: "No Stripe customer was found for this company.",
  no_subscription: "No matching monthly Stripe subscription was found.",
  several_subscriptions: "More than one matching Stripe subscription was found.",
  not_active: "The Stripe subscription isn't active.",
  trial: "The subscription is in a trial.",
  not_monthly: "The subscription isn't billed monthly.",
  currency: "The subscription isn't billed in US dollars.",
  price_mismatch: "Stripe's base price doesn't match the plan.",
  period_mismatch: "Autumn's and Stripe's renewal dates disagree.",
  existing_discount: "A promotion is already on the subscription.",
  provider_schedule: "Stripe has a scheduled change on the subscription.",
  crosses_price_change: "The offer would run past the end of the early-user year, which isn't verified yet.",
};

export type Renewal = { at: number; baseCents: number; discountCents: number; totalCents: number };
export type OfferPreview = {
  offerId: OfferId;
  percent: number;
  currency: string;
  renewals: Renewal[];
  totalCents: number;
  savingsCents: number;
  /** The first renewal back at the normal price, and that price. */
  resumesAt: number;
  resumesCents: number;
  version: string;
  expiresAt: number;
};

export type OfferVerdict = { eligible: true; preview: OfferPreview } | { eligible: false; reason: Ineligible };

/** Whole cents of `percent`% of `cents`, rounded half up (Stripe rounds a percentage discount to the nearest cent). */
export function percentOf(cents: number, percent: number): number {
  if (!Number.isInteger(cents) || !Number.isInteger(percent)) throw new Error("Money is whole cents and whole percents.");
  return Math.floor((cents * percent + 50) / 100);
}

/**
 * The renewal `k` periods after `periodEnd` (k = 0 is periodEnd itself), on the anchor's day of the month,
 * kept to the last day of a shorter month: Stripe's rule for monthly renewals.
 */
export function renewalAt(periodEnd: number, k: number, anchorAt: number): number {
  if (k === 0) return periodEnd;
  const end = new Date(periodEnd);
  const day = new Date(anchorAt).getUTCDate();
  const first = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + k, 1, end.getUTCHours(), end.getUTCMinutes(), end.getUTCSeconds());
  const target = new Date(first);
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.getTime();
}

/** The base price of the renewal at `at`: the plan's own, or the full Operate price once the early-user year is over. */
export function baseAt(planCents: number, at: number, earlyEndsAt: number | null): number {
  if (earlyEndsAt !== null && at >= earlyEndsAt - PERIOD_SLACK_MS) return PLANS.operate.monthlyCents;
  return planCents;
}

/** A short, stable fingerprint of the terms, so accepting proves the person saw exactly these. */
export function fingerprint(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/** The schedule an offer produces for this subscription. Pure: the same facts always give the same terms. */
export function schedule(offerId: OfferId, input: { planCents: number; periodEnd: number; anchorAt: number; earlyEndsAt: number | null; currency: string; subscriptionId: string; fetchedAt: number }): OfferPreview {
  const offer = OFFERS[offerId];
  const renewals: Renewal[] = [];
  for (let k = 0; k < offer.renewals; k += 1) {
    const at = renewalAt(input.periodEnd, k, input.anchorAt);
    const baseCents = baseAt(input.planCents, at, input.earlyEndsAt);
    const discountCents = percentOf(baseCents, offer.percent);
    renewals.push({ at, baseCents, discountCents, totalCents: baseCents - discountCents });
  }
  const resumesAt = renewalAt(input.periodEnd, offer.renewals, input.anchorAt);
  const resumesCents = baseAt(input.planCents, resumesAt, input.earlyEndsAt);
  const terms = [offerId, RETENTION_POLICY, input.subscriptionId, input.currency, ...renewals.map((row) => `${row.at}:${row.baseCents}:${row.discountCents}`), `${resumesAt}:${resumesCents}`].join("|");
  return {
    offerId,
    percent: offer.percent,
    currency: input.currency,
    renewals,
    totalCents: renewals.reduce((sum, row) => sum + row.totalCents, 0),
    savingsCents: renewals.reduce((sum, row) => sum + row.discountCents, 0),
    resumesAt,
    resumesCents,
    version: fingerprint(terms),
    expiresAt: input.fetchedAt + PREVIEW_TTL_MS,
  };
}

/** Why no offer can be made to this company at all, before looking at a particular offer. Null: offers may be made. */
export function accountProblem(input: EligibilityInput): Ineligible | null {
  const account = input.account;
  if (!input.billingConnected) return "billing_off";
  if (!account?.plan || !account.autumnPlanId) return "no_plan";
  if (account.endsAt !== null) return "ending";
  if (input.locked) return "locked";
  if (account.pastDue) return "past_due";
  if (!OFFER_PLANS[account.autumnPlanId]) return "unsupported_plan";
  if (input.inFlight) return "in_progress";
  if (input.lastAcceptedAt !== null && input.now - input.lastAcceptedAt < OFFER_COOLDOWN_MS) return "used_recently";
  // A scheduled change other than the early-user move would change the base product under the discount.
  if (account.scheduledAutumnPlanId && !(account.autumnPlanId === AUTUMN.earlyPlan && account.scheduledAutumnPlanId === AUTUMN.plans.operate)) return "scheduled_change";
  const facts = input.facts;
  if (!facts) return "checking";
  if (!facts.ok) return facts.reason;
  if (facts.status === "trialing" || (facts.trialEnd !== null && facts.trialEnd > input.now)) return "trial";
  if (facts.status !== "active") return "not_active";
  if (facts.interval !== "month" || facts.intervalCount !== 1) return "not_monthly";
  if (facts.currency !== "usd") return "currency";
  if (facts.baseCents !== OFFER_PLANS[account.autumnPlanId].cents) return "price_mismatch";
  if (facts.cancelAtPeriodEnd) return "ending";
  if (facts.discountIds.length > 0) return "existing_discount";
  if (account.periodEnd === null || Math.abs(account.periodEnd - facts.periodEnd) > PERIOD_SLACK_MS) return "period_mismatch";
  if (facts.periodEnd <= input.now) return "period_mismatch";
  return null;
}

/** Whether this offer can be made, and its exact terms. */
export function offerVerdict(offerId: OfferId, input: EligibilityInput): OfferVerdict {
  const problem = accountProblem(input);
  if (problem) return { eligible: false, reason: problem };
  const facts = input.facts as Extract<SubscriptionFacts, { ok: true }>;
  const account = input.account!;
  const early = account.autumnPlanId === AUTUMN.earlyPlan ? input.earlyEndsAt : null;
  // An early-user subscription without a known end of its year can't be priced honestly.
  if (account.autumnPlanId === AUTUMN.earlyPlan && early === null) return { eligible: false, reason: "unsupported_plan" };
  const preview = schedule(offerId, { planCents: facts.baseCents, periodEnd: facts.periodEnd, anchorAt: facts.anchorAt, earlyEndsAt: early, currency: facts.currency, subscriptionId: facts.subscriptionId, fetchedAt: facts.fetchedAt });
  const crosses = preview.renewals.some((row) => row.baseCents !== facts.baseCents);
  // The move to $299 happens through Autumn, which swaps the subscription's product; a coupon limited to the
  // $199 product would not follow it. Until that is verified in the sandbox the offer is not made then.
  if (crosses && !input.acrossPriceChange) return { eligible: false, reason: "crosses_price_change" };
  // Stripe's own schedule on the subscription (the early-user move, once requested) could replace its discounts.
  if (facts.scheduleId !== null && !(crosses && input.acrossPriceChange)) return { eligible: false, reason: "provider_schedule" };
  return { eligible: true, preview };
}

/** The renewals of an accepted offer still to come, and what the next subscription payment will be. */
export function remaining(renewals: readonly Renewal[], now: number): Renewal[] {
  return renewals.filter((row) => row.at > now - PERIOD_SLACK_MS);
}

/** Whether the subscription's discount behind an accepted offer is this offer's own coupon. */
export function hasCoupon(facts: SubscriptionFacts, couponId: string): boolean {
  return facts.ok && facts.couponIds.includes(couponId);
}

/** One line for the customer about why no offer is shown: never internal terms. */
export function customerWords(reason: Ineligible): string | null {
  if (reason === "used_recently") return "You’ve already used a retention offer in the last 12 months, so we can’t offer another one right now.";
  if (reason === "past_due" || reason === "locked") return "Your last payment didn’t go through, so we can’t offer a discount right now.";
  if (reason === "checking") return null;
  return null;
}

// ── Stripe's invoice events, for the report ──────────────────────────────────────────────────────

export type RetentionInvoice = { eventId: string; type: string; invoiceId: string; subscriptionId: string | null; status: string; subtotalCents: number; discountCents: number; paidCents: number; refundedCents: number; at: number };

const REPORTED = ["invoice.paid", "invoice.payment_failed", "invoice.voided", "invoice.marked_uncollectible", "charge.refunded"];

/**
 * A verified Stripe event on Selestial's own account, read into what the retention report keeps: for a plan
 * invoice, its subtotal, the discount Stripe actually took off and what was paid; for a refund, how much of
 * the invoice's charge went back. Null for anything else.
 */
export function retentionInvoiceOf(body: string): RetentionInvoice | null {
  let event: { id?: unknown; type?: unknown; created?: unknown; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(body) as typeof event;
  } catch {
    return null;
  }
  const type = typeof event.type === "string" ? event.type : "";
  const object = event.data?.object;
  if (!REPORTED.includes(type) || typeof event.id !== "string" || !object) return null;
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0);
  const at = typeof event.created === "number" ? event.created * 1000 : Date.now();
  if (type === "charge.refunded") {
    if (typeof object.invoice !== "string") return null;
    return { eventId: event.id.slice(0, 100), type, invoiceId: object.invoice.slice(0, 100), subscriptionId: null, status: "refunded", subtotalCents: 0, discountCents: 0, paidCents: 0, refundedCents: n(object.amount_refunded), at };
  }
  if (typeof object.id !== "string") return null;
  const parent = object.parent as { subscription_details?: { subscription?: unknown } } | undefined;
  const sub = typeof object.subscription === "string" ? object.subscription : (object.subscription as { id?: unknown } | undefined)?.id ?? parent?.subscription_details?.subscription;
  const discounts = Array.isArray(object.total_discount_amounts) ? (object.total_discount_amounts as { amount?: unknown }[]).reduce((sum, row) => sum + n(row.amount), 0) : 0;
  const status = type === "invoice.payment_failed" ? "payment_failed" : type === "invoice.voided" ? "void" : type === "invoice.marked_uncollectible" ? "uncollectible" : "paid";
  return { eventId: event.id.slice(0, 100), type, invoiceId: object.id.slice(0, 100), subscriptionId: typeof sub === "string" ? sub.slice(0, 100) : null, status, subtotalCents: n(object.subtotal), discountCents: discounts, paidCents: status === "paid" ? n(object.amount_paid) : 0, refundedCents: 0, at };
}
