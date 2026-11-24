/**
 * Instant Shine's crew pay, reproduced from its database function compute_crew_pay
 * (instant-shine-dash: supabase/migrations/20260830191957_texas_crew_pay_rates.sql). Pure.
 *
 * Used to check stored pay snapshots and to compare with Selestial's pay rule for new work. Never used to
 * rewrite a snapshot: imported assignments keep the share they were locked (or provisionally set) at.
 *
 * Source rule: crew size is the number of distinct cleaners; the rate comes from the bracket for that crew
 * size in the cleaner's pay tier; each share is floor(jobValue × rate% ÷ crew), in whole cents; the job value
 * is the booking's total after discounts (est_price), not the list price.
 */
export type RateBracket = { minCrew: number; maxCrew: number | null; tier: string; ratePercent: number };

export function rateFor(brackets: readonly RateBracket[], tier: string, crew: number): number {
  const mine = brackets.filter((b) => b.tier === tier.toLowerCase());
  const exact = mine.find((b) => crew >= b.minCrew && (b.maxCrew === null || crew <= b.maxCrew));
  if (exact) return exact.ratePercent;
  const solo = mine.find((b) => b.minCrew <= 1 && (b.maxCrew === null || b.maxCrew >= 1));
  if (solo) return solo.ratePercent;
  return mine.length ? Math.min(...mine.map((b) => b.ratePercent)) : 40;
}

export function sourceShareCents(jobValueCents: number, ratePercent: number, crew: number): number {
  return Math.floor((jobValueCents * ratePercent) / 100 / Math.max(1, crew));
}

/** Every cleaner's share for a job, as the source computes it, and whether the pool ceiling holds. */
export function sourceCrewPay(jobValueCents: number, cleaners: { id: string; tier: string }[], brackets: readonly RateBracket[]): { shares: Record<string, number>; poolCents: number; withinPool: boolean } {
  const ids = [...new Set(cleaners.map((c) => c.id))];
  const crew = ids.length;
  const shares: Record<string, number> = {};
  for (const id of ids) {
    const tier = cleaners.find((c) => c.id === id)!.tier;
    shares[id] = sourceShareCents(jobValueCents, rateFor(brackets, tier, crew), crew);
  }
  const maxRate = Math.max(...ids.map((id) => rateFor(brackets, cleaners.find((c) => c.id === id)!.tier, crew)), 0);
  const pool = Math.ceil((jobValueCents * maxRate) / 100);
  return { shares, poolCents: pool, withinPool: Object.values(shares).reduce((a, b) => a + b, 0) <= pool };
}

/**
 * Selestial's equivalent setting for a single rate across crew sizes: a share in basis points, split by crew.
 * Null when the brackets differ by crew size, which Selestial's single share can't express; the Owner then
 * chooses. Selestial rounds the final amount to the nearest cent; the source rounds each share down, so a new
 * visit's pay can differ by at most one cent per cleaner. Imported snapshots are kept exactly.
 */
export function selestialPayRule(brackets: readonly RateBracket[], tier: string): { shareBps: number; mode: "split_by_crew" } | null {
  const rates = [...new Set(brackets.filter((b) => b.tier === tier.toLowerCase()).map((b) => b.ratePercent))];
  if (rates.length !== 1) return null;
  return { shareBps: Math.round(rates[0] * 100), mode: "split_by_crew" };
}
