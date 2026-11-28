/**
 * Instant Shine's prices, reproduced exactly from the source's single pricing module
 * (instant-shine-dash: supabase/functions/_shared/booking-pricing.ts, buildQuote). Pure.
 *
 * Used for three things, never to change a customer's commitment:
 *  1. Building Selestial service drafts whose size bands carry the same list prices and durations.
 *  2. Parity tests: the Selestial quote for each size equals the source's list price, sizes the source
 *     prices only after a walkthrough are walkthroughs in Selestial too (never $0), and the discount is
 *     applied exactly once.
 *  3. Checking each imported booking's stored price against what the source would have charged, to flag
 *     (not fix) a booking whose stored numbers disagree. A booking keeps its stored totals.
 *
 * Verified in code, not in live settings: the source has no pricing table, so these constants are what it
 * charges. State multipliers for CA and NY exist in the source; Bay Area serves Texas ZIP codes only.
 */
import type { Spec } from "../../../services/spec";

export type OfferType = "standard" | "deep_clean" | "move_in_out" | "recurring";

export type Tier = { id: string; label: string; minSqft: number; maxSqft: number; deepCents: number; maintenanceCents: number; oneTimeCents: number; requiresEstimate?: boolean; requiresDeepEstimate?: boolean };

export const TIERS: readonly Tier[] = [
  { id: "under_1000", label: "Under 1,000 sq ft", minSqft: 0, maxSqft: 1000, deepCents: 30505, maintenanceCents: 17126, oneTimeCents: 22531 },
  { id: "1001_1400", label: "1,001 – 1,400 sq ft", minSqft: 1001, maxSqft: 1400, deepCents: 32777, maintenanceCents: 18659, oneTimeCents: 23509 },
  { id: "1401_1800", label: "1,401 – 1,800 sq ft", minSqft: 1401, maxSqft: 1800, deepCents: 35594, maintenanceCents: 22573, oneTimeCents: 25527 },
  { id: "1801_2400", label: "1,801 – 2,400 sq ft", minSqft: 1801, maxSqft: 2400, deepCents: 38513, maintenanceCents: 23487, oneTimeCents: 26541 },
  { id: "2401_2800", label: "2,401 – 2,800 sq ft", minSqft: 2401, maxSqft: 2800, deepCents: 40501, maintenanceCents: 24576, oneTimeCents: 28528 },
  { id: "2801_3300", label: "2,801 – 3,300 sq ft", minSqft: 2801, maxSqft: 3300, deepCents: 0, maintenanceCents: 28792, oneTimeCents: 29746, requiresDeepEstimate: true },
  { id: "3301_3900", label: "3,301 – 3,900 sq ft", minSqft: 3301, maxSqft: 3900, deepCents: 0, maintenanceCents: 30781, oneTimeCents: 34634, requiresDeepEstimate: true },
  { id: "3901_4500", label: "3,901 – 4,500 sq ft", minSqft: 3901, maxSqft: 4500, deepCents: 0, maintenanceCents: 36869, oneTimeCents: 37867, requiresDeepEstimate: true },
  { id: "4501_5100", label: "4,501 – 5,100 sq ft", minSqft: 4501, maxSqft: 5100, deepCents: 0, maintenanceCents: 42817, oneTimeCents: 46137, requiresDeepEstimate: true },
  { id: "5101_plus", label: "5,100+ sq ft", minSqft: 5101, maxSqft: 999999, deepCents: 0, maintenanceCents: 0, oneTimeCents: 0, requiresEstimate: true },
];

export const STATE_MULTIPLIERS: Record<string, number> = { TX: 1.0, CA: 1.1, NY: 1.15 };
export const WELCOME_DISCOUNT: Record<OfferType, number> = { standard: 0.1, deep_clean: 0.2, recurring: 0.1, move_in_out: 0 };
export const REFERRAL_CREDIT_CENTS = 5000;
export const DEPOSIT_RATE = 0.5;
export const DURATION_HOURS: Record<OfferType, number> = { standard: 2, recurring: 2, deep_clean: 4, move_in_out: 4 };
export const OFFER_NAMES: Record<OfferType, string> = { standard: "Standard Clean", deep_clean: "Deep Clean", move_in_out: "Move-In / Move-Out Clean", recurring: "Recurring Maintenance" };

export function moveInOutCents(tier: Tier): number {
  if (tier.deepCents > 0) return Math.round(tier.deepCents * 1.05);
  if (tier.oneTimeCents > 0) return Math.round(tier.oneTimeCents * 1.4);
  return 0;
}

export function listCents(tier: Tier, offer: OfferType): number {
  return offer === "standard" ? tier.oneTimeCents : offer === "deep_clean" ? tier.deepCents : offer === "move_in_out" ? moveInOutCents(tier) : tier.maintenanceCents;
}

export function tierForSqft(sqft: number): Tier {
  return TIERS.find((tier) => sqft >= tier.minSqft && sqft <= tier.maxSqft) ?? TIERS[TIERS.length - 1];
}

/** Estimate-only, as the source decides it. Its quote then has every amount 0: that is "call us", not free. */
export function needsEstimate(tier: Tier, offer: OfferType): boolean {
  if (tier.requiresEstimate) return true;
  const intensive = offer === "deep_clean" || offer === "move_in_out";
  if (intensive && (tier.requiresDeepEstimate || listCents(tier, offer) <= 0)) return true;
  return listCents(tier, offer) <= 0;
}

export type SourceQuote =
  | { estimate: true; tierId: string; offer: OfferType }
  | { estimate: false; tierId: string; offer: OfferType; listCents: number; welcomeCents: number; referralCents: number; discountCents: number; totalCents: number; depositCents: number; balanceCents: number; durationHours: number };

/** The source's buildQuote, step for step, in integer cents. The discount is taken once. */
export function sourceQuote(input: { tierId: string; offer: OfferType; state?: string | null; referral?: string | null }): SourceQuote {
  const tier = TIERS.find((t) => t.id === input.tierId);
  if (!tier) throw new Error(`Unknown home size: ${input.tierId}`);
  if (needsEstimate(tier, input.offer)) return { estimate: true, tierId: tier.id, offer: input.offer };
  const list = Math.round(listCents(tier, input.offer) * (STATE_MULTIPLIERS[(input.state || "TX").toUpperCase()] ?? 1));
  const welcome = Math.round(list * WELCOME_DISCOUNT[input.offer]);
  const referral = input.referral && input.referral.trim() && input.offer !== "recurring" ? REFERRAL_CREDIT_CENTS : 0;
  const discount = Math.min(welcome + referral, list);
  const total = Math.max(list - discount, 0);
  const deposit = Math.round(total * DEPOSIT_RATE);
  return { estimate: false, tierId: tier.id, offer: input.offer, listCents: list, welcomeCents: welcome, referralCents: referral, discountCents: discount, totalCents: total, depositCents: deposit, balanceCents: total - deposit, durationHours: DURATION_HOURS[input.offer] };
}

/**
 * Size bands with the source's list prices. Selestial bands include `from` and exclude `to`, so the source's
 * inclusive 1,001–1,400 becomes [1001, 1401). Sizes the source prices only after a walkthrough are left out of
 * the bands: Selestial then asks for a walkthrough above the largest band, exactly as the source does. A
 * walkthrough is never a $0 price.
 */
export function bandsFor(offer: OfferType): { from: number; to: number | null; amountCents: number; laborMinutes: number }[] {
  const out: { from: number; to: number | null; amountCents: number; laborMinutes: number }[] = [];
  for (const tier of TIERS) {
    if (needsEstimate(tier, offer)) break;
    out.push({ from: tier.minSqft, to: tier.maxSqft + 1, amountCents: listCents(tier, offer), laborMinutes: DURATION_HOURS[offer] * 60 });
  }
  return out;
}

/**
 * The four services as Selestial drafts, priced like the source at list price. The source's "new customer"
 * discount is applied to every quote without checking that the customer is new, so it is not carried into the
 * catalog silently: it is a decision for the Owner (a promotion they approve), listed in the review.
 */
export function serviceDrafts(base: (category: "residential") => Spec): { offer: OfferType; spec: Spec; recurring: boolean }[] {
  const offers: OfferType[] = ["standard", "deep_clean", "move_in_out", "recurring"];
  return offers.map((offer) => {
    const blank = base("residential");
    const spec: Spec = {
      ...blank,
      name: OFFER_NAMES[offer],
      summary: `Imported from Instant Shine. List prices by home size, as Instant Shine charges them before any discount.`,
      pricing: { method: "size_bands", unit: "sq_ft", bands: bandsFor(offer) },
      illustrative: false,
    };
    return { offer, spec, recurring: offer === "recurring" };
  });
}

/**
 * A stored booking checked against the source's own arithmetic. Nothing is changed: a mismatch is a note for
 * review, and the booking keeps the totals the customer accepted.
 */
export function checkStoredPrice(booking: { offer_type?: unknown; home_size?: unknown; est_price?: unknown; base_price?: unknown; deposit_amount?: unknown; balance_due?: unknown; promo_code?: unknown; promo_discount_cents?: unknown; pricing_breakdown?: unknown }): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  const cents = (value: unknown) => (value === null || value === undefined || value === "" ? null : Math.round(Number(value) * 100));
  const total = cents(booking.est_price);
  const deposit = cents(booking.deposit_amount);
  const balance = cents(booking.balance_due);
  if (total !== null && deposit !== null && balance !== null && deposit + balance !== total) notes.push(`Deposit (${deposit}¢) and balance (${balance}¢) don't add up to the total (${total}¢).`);
  const breakdown = (booking.pricing_breakdown ?? null) as { listPriceCents?: number; discountCents?: number; totalCents?: number } | null;
  if (breakdown && typeof breakdown.listPriceCents === "number" && typeof breakdown.discountCents === "number" && typeof breakdown.totalCents === "number") {
    if (breakdown.listPriceCents - breakdown.discountCents !== breakdown.totalCents) notes.push("The stored price breakdown doesn't subtract its discount exactly once.");
    if (total !== null && breakdown.totalCents !== total) notes.push(`The stored total (${total}¢) differs from its price breakdown (${breakdown.totalCents}¢), probably a staff override.`);
  }
  return { ok: notes.length === 0, notes };
}
