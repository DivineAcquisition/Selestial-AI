import { describe, expect, it } from "vitest";

import { emptyCosts } from "../services/profit";
import { templateById } from "../services/templates";
import { agreementsFor, modeFor, servicesToPrepare, standardsFor } from "./catalog";
import { roundPrice, suggestPricing } from "./pricing";

const costs = { ...emptyCosts(), pay: { model: "hourly" as const, hourlyCents: 2200, burdenPercent: 10 }, suppliesPerVisitCents: 800, targetMarginPercent: 40, floorMarginPercent: 25, minimumJobCents: 12000 };

describe("suggested pricing", () => {
  it("works out prices from the owner's costs that reach their margin on a typical job, with every assumption stated", () => {
    const standard = templateById("res-standard")!.spec;
    const result = suggestPricing(standard, costs);
    expect(result.basis).toBe("costs");
    expect(result.spec.illustrative).toBe(false);
    expect(result.typical?.marginPercent).toBeGreaterThanOrEqual(38);
    expect(result.typical?.priceCents).toBeGreaterThanOrEqual(12000);
    expect(result.assumptions.join(" ")).toMatch(/\$22\.00 an hour/);
    expect(result.assumptions.join(" ")).toMatch(/40% margin/);
    expect(result.assumptions.join(" ")).toMatch(/not market research/);
    expect(result.spec.modifiers.minimumCents).toBe(12000);
    // Same inputs, same prices.
    expect(suggestPricing(standard, costs).spec).toEqual(result.spec);
  });

  it("keeps template amounts marked as examples without pay and a margin, and never prices an assessment", () => {
    const standard = templateById("res-standard")!.spec;
    const none = suggestPricing(standard, { ...emptyCosts() });
    expect(none.basis).toBe("template");
    expect(none.spec.illustrative).toBe(true);
    expect(none.assumptions[0]).toMatch(/what you pay cleaners and the margin you aim for/);
    expect(suggestPricing(standard, null).basis).toBe("template");
    const warehouse = suggestPricing(templateById("com-warehouse")!.spec, costs);
    expect(warehouse.basis).toBe("assessment");
    expect(warehouse.typical).toBeNull();
  });

  it("scales area rates and add-ons too, and rounds to sensible steps", () => {
    const office = suggestPricing(templateById("com-office")!.spec, costs);
    expect(office.basis).toBe("costs");
    expect(roundPrice(4321)).toBe(4300);
    expect(roundPrice(12340)).toBe(12500);
    expect(roundPrice(0)).toBe(0);
  });
});

describe("what gets prepared", () => {
  it("prepares the owner's own picks that fit what they clean, or a small default set, in catalog order", () => {
    expect(servicesToPrepare(["residential"], [])).toEqual(["res-standard", "res-deep", "res-move"]);
    expect(servicesToPrepare(["residential"], ["res-move", "res-standard", "com-office"])).toEqual(["res-standard", "res-move"]);
    expect(servicesToPrepare(["residential", "short_term_rental"], [])).toEqual(["res-standard", "res-deep", "res-move", "str-turnover"]);
    expect(servicesToPrepare([], [])).toEqual([]);
  });

  it("chooses an honest booking outcome and matching agreements and standards", () => {
    expect(modeFor("residential", ["res-standard"], true).mode).toBe("instant");
    expect(modeFor("residential", ["res-standard"], false).mode).toBe("estimate_request");
    expect(modeFor("commercial", ["com-office"], true).mode).toBe("walkthrough_request");
    expect(modeFor("commercial", ["com-warehouse"], true).mode).toBe("walkthrough_request");
    expect(agreementsFor(["res-standard", "res-move", "str-turnover", "str-linen"])).toEqual(["one_time_residential", "move_in_out", "str_turnover"]);
    expect(standardsFor(["res-deep", "res-move", "com-office"])).toEqual(["deep_move_out", "office"]);
  });
});
