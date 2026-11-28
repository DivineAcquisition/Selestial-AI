import { describe, expect, it } from "vitest";

import { quote } from "../../../services/engine";
import { blankSpec } from "../../../services/spec";
import { payFor } from "../../../dispatch/pay";
import { checkStoredPrice, listCents, needsEstimate, serviceDrafts, sourceQuote, TIERS, type OfferType } from "./pricing";
import { rateFor, selestialPayRule, sourceCrewPay, sourceShareCents } from "./pay";

const OFFERS: OfferType[] = ["standard", "deep_clean", "move_in_out", "recurring"];
const drafts = serviceDrafts(blankSpec);

describe("price parity with Instant Shine", () => {
  it("quotes every tier boundary at the source's list price, and the next size up in the next tier", () => {
    for (const { offer, spec } of drafts) {
      for (const tier of TIERS) {
        for (const sqft of [tier.minSqft, tier.maxSqft]) {
          const ours = quote(spec, { area: sqft });
          if (needsEstimate(tier, offer)) {
            // Estimate-only is a walkthrough, never a zero price.
            expect(ours.totalCents, `${offer} ${sqft}`).toBeNull();
            expect(ours.outcome, `${offer} ${sqft}`).toBe("walkthrough");
            expect(ours.reasons.join(" ")).toMatch(/above the largest size band/);
          } else {
            expect(ours.totalCents, `${offer} ${sqft}`).toBe(listCents(tier, offer));
            const source = sourceQuote({ tierId: tier.id, offer, state: "TX" });
            expect(source.estimate).toBe(false);
            if (!source.estimate) expect(ours.totalCents).toBe(source.listCents);
          }
        }
      }
    }
  });

  it("keeps the source's durations", () => {
    const minutes = Object.fromEntries(drafts.map((d) => [d.offer, d.spec.pricing.method === "size_bands" ? d.spec.pricing.bands[0].laborMinutes : 0]));
    expect(minutes).toEqual({ standard: 120, deep_clean: 240, move_in_out: 240, recurring: 120 });
  });

  it("applies the discount exactly once and splits the deposit and balance to the cent", () => {
    for (const offer of OFFERS) {
      for (const tier of TIERS) {
        for (const referral of [null, "FRIEND"]) {
          const q = sourceQuote({ tierId: tier.id, offer, state: "TX", referral });
          if (q.estimate) continue;
          expect(q.totalCents).toBe(q.listCents - q.discountCents);
          expect(q.discountCents).toBe(Math.min(q.welcomeCents + q.referralCents, q.listCents));
          // The old double-discount bug subtracted the discount from an already discounted price.
          if (q.discountCents > 0) expect(q.totalCents).not.toBe(q.listCents - 2 * q.discountCents);
          expect(q.depositCents + q.balanceCents).toBe(q.totalCents);
          expect(q.depositCents).toBe(Math.round(q.totalCents * 0.5));
          if (offer === "recurring") expect(q.referralCents).toBe(0);
        }
      }
    }
  });

  it("matches known source quotes exactly", () => {
    // 1,001–1,400 sq ft deep clean: $327.77 list, 20% welcome off, $262.22, deposit $131.11.
    expect(sourceQuote({ tierId: "1001_1400", offer: "deep_clean" })).toMatchObject({ listCents: 32777, discountCents: 6555, totalCents: 26222, depositCents: 13111, balanceCents: 13111 });
    // Odd cents: the deposit rounds and the balance takes the rest.
    expect(sourceQuote({ tierId: "under_1000", offer: "standard", referral: "X" })).toMatchObject({ listCents: 22531, discountCents: 2253 + 5000, totalCents: 15278, depositCents: 7639, balanceCents: 7639 });
    // Move-in/out is 5% above deep and has no welcome discount.
    expect(sourceQuote({ tierId: "1401_1800", offer: "move_in_out" })).toMatchObject({ listCents: 37374, discountCents: 0, totalCents: 37374 });
    // Over 5,100 sq ft, or a deep clean over 2,800, is estimate-only.
    expect(sourceQuote({ tierId: "5101_plus", offer: "standard" }).estimate).toBe(true);
    expect(sourceQuote({ tierId: "2801_3300", offer: "deep_clean" }).estimate).toBe(true);
    expect(sourceQuote({ tierId: "2801_3300", offer: "recurring" }).estimate).toBe(false);
  });

  it("flags a stored booking whose numbers don't add up, without changing it", () => {
    expect(checkStoredPrice({ est_price: 262.04, deposit_amount: 131.02, balance_due: 131.02, pricing_breakdown: { listPriceCents: 32755, discountCents: 6551, totalCents: 26204 } })).toEqual({ ok: true, notes: [] });
    expect(checkStoredPrice({ est_price: 200, deposit_amount: 100, balance_due: 90 }).ok).toBe(false);
    expect(checkStoredPrice({ est_price: 196.55, pricing_breakdown: { listPriceCents: 32755, discountCents: 6551, totalCents: 19653 } }).notes.join(" ")).toMatch(/exactly once/);
  });
});

describe("cleaner pay parity with Instant Shine", () => {
  const brackets = [
    { minCrew: 1, maxCrew: 1, tier: "texas", ratePercent: 40 },
    { minCrew: 2, maxCrew: null, tier: "texas", ratePercent: 40 },
  ];

  it("pays the seeded example: a $200 job, an $80 pool, $40 each for two", () => {
    const pay = sourceCrewPay(20000, [{ id: "a", tier: "texas" }, { id: "b", tier: "texas" }], brackets);
    expect(pay).toEqual({ shares: { a: 4000, b: 4000 }, poolCents: 8000, withinPool: true });
    expect(sourceCrewPay(20000, [{ id: "a", tier: "texas" }], brackets).shares.a).toBe(8000);
  });

  it("rounds each share down like the source, and Selestial's same rule is never more than a cent apart", () => {
    const rule = selestialPayRule(brackets, "texas")!;
    expect(rule).toEqual({ shareBps: 4000, mode: "split_by_crew" });
    for (const value of [20278, 26204, 17126, 33333, 19999]) {
      for (const crew of [1, 2, 3]) {
        const source = sourceShareCents(value, rateFor(brackets, "texas", crew), crew);
        const ours = payFor({ pay: { kind: "share", shareBps: rule.shareBps } }, { priceCents: value, startsAt: 0, endsAt: 0, requiredCrew: crew }, { rule: { mode: "split_by_crew", leadPremiumPercent: 0 }, role: "support" });
        expect(ours.ok).toBe(true);
        if (ours.ok) expect(Math.abs(ours.payCents - source), `${value} / ${crew}`).toBeLessThanOrEqual(1);
      }
    }
    expect(sourceShareCents(20278, 40, 1)).toBe(8111);
  });

  it("leaves a crew-size-dependent rate to the Owner instead of flattening it", () => {
    expect(selestialPayRule([...brackets.slice(0, 1), { minCrew: 2, maxCrew: null, tier: "texas", ratePercent: 45 }], "texas")).toBeNull();
  });
});
