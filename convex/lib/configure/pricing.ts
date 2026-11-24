/**
 * Suggested prices for a template service, from the owner's own costs. Pure and deterministic: the same
 * spec and costs always give the same prices. Nothing here is market research, a competitor's price or a
 * promised margin; every assumption is written down beside the result.
 *
 * How: price a typical job with the template, ask profitability() for the price that reaches the owner's
 * target margin on that job (and their minimum job), and scale every amount in the template by that ratio,
 * rounded to a sensible step. The shape of the template's pricing stays (what a bedroom adds compared with
 * a bathroom); only its level moves to the owner's costs.
 *
 * Without the costs that decide a price (what cleaners are paid, and a target margin), the template's own
 * amounts are kept and stay marked as examples. A service quoted after an assessment gets no price.
 */
import { quote } from "../services/engine";
import { profitability, type Costs } from "../services/profit";
import type { Spec } from "../services/spec";
import { sampleInputs } from "../services/store";
import { formatCents } from "../services/words";

export type Suggestion = {
  spec: Spec;
  /** costs: worked out from the owner's costs; template: example amounts kept; assessment: no price. */
  basis: "costs" | "template" | "assessment";
  /** Plain sentences: what the suggestion assumed. Shown with the draft. */
  assumptions: string[];
  /** What a typical job now costs the customer, and the margin it leaves, when known. */
  typical: { label: string; priceCents: number; marginPercent: number | null } | null;
};

/** Prices from $50 up round to $5; smaller amounts to $1. A zero stays zero. */
export function roundPrice(cents: number): number {
  if (cents <= 0) return 0;
  const step = cents >= 5000 ? 500 : 100;
  return Math.max(step, Math.round(cents / step) * step);
}

/** Every money amount in a pricing structure or add-on list, scaled. Rates in millicents keep their precision. */
function scaleMoney<T>(value: T, factor: number): T {
  if (Array.isArray(value)) return value.map((item) => scaleMoney(item, factor)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === "number" && key.endsWith("Millicents")) out[key] = Math.max(0, Math.round(item * factor));
      else if (typeof item === "number" && key.endsWith("Cents")) out[key] = roundPrice(item * factor);
      else out[key] = scaleMoney(item, factor);
    }
    return out as T;
  }
  return value;
}

function payWords(costs: Costs): string | null {
  const pay = costs.pay;
  if (!pay) return null;
  if (pay.model === "hourly") return `Cleaners are paid ${formatCents(pay.hourlyCents)} an hour${pay.burdenPercent ? `, plus ${pay.burdenPercent}% payroll costs` : ""}.`;
  if (pay.model === "per_visit") return `Cleaners are paid ${formatCents(pay.amountCents)} per visit.`;
  return `Cleaners are paid ${pay.sharePercent}% of the price.`;
}

/** The middle example job when there are several (a 3-bed, 2-bath home rather than the smallest). */
export function typicalJob(spec: Spec) {
  const samples = sampleInputs(spec);
  return samples[Math.min(1, samples.length - 1)] ?? null;
}

export function suggestPricing(template: Spec, costs: Costs | null): Suggestion {
  if (template.pricing.method === "custom_quote") {
    return { spec: { ...template, illustrative: false }, basis: "assessment", assumptions: ["Quoted after you see the site, so no price is set. Customers ask for an assessment."], typical: null };
  }
  const job = typicalJob(template);
  const before = job ? quote(template, job.input) : null;
  const pay = costs ? payWords(costs) : null;
  const margin = costs?.targetMarginPercent ?? null;
  if (!costs || !pay || margin === null || !job || !before || before.totalCents === null || before.totalCents <= 0) {
    const missing = [!pay ? "what you pay cleaners" : null, margin === null ? "the margin you aim for" : null].filter(Boolean).join(" and ");
    return {
      spec: template,
      basis: "template",
      assumptions: [`Example prices from a template${missing ? `: tell us ${missing} to work out prices from your costs` : ""}.`],
      typical: before && before.totalCents !== null && job ? { label: job.label, priceCents: before.totalCents, marginPercent: null } : null,
    };
  }
  const profit = profitability(before, costs);
  const target = profit?.targetCents ?? null;
  if (target === null || target <= 0) {
    return { spec: template, basis: "template", assumptions: ["Example prices from a template: your costs leave no price that reaches your margin, so check your costs before setting prices."], typical: { label: job.label, priceCents: before.totalCents, marginPercent: profit?.contributionMarginPercent ?? null } };
  }
  const desired = Math.max(target, costs.minimumJobCents ?? 0);
  const factor = desired / before.totalCents;
  const scaled: Spec = {
    ...template,
    pricing: scaleMoney(template.pricing, factor),
    addOns: scaleMoney(template.addOns, factor),
    modifiers: { ...template.modifiers, minimumCents: Math.max(template.modifiers.minimumCents ?? 0, costs.minimumJobCents ?? 0) || null },
    illustrative: false,
  };
  const after = quote(scaled, job.input);
  const afterProfit = after.totalCents !== null ? profitability(after, costs) : null;
  const hours = Math.round((before.time.laborMinutes / 60) * 10) / 10;
  const assumptions = [
    `A typical job here is ${job.label}, about ${hours} labor-hour${hours === 1 ? "" : "s"} (the template's estimate; adjust the times if yours differ).`,
    pay,
    `Prices aim for a ${margin}% margin after direct costs.`,
    ...(costs.suppliesPerVisitCents ? [`Supplies cost ${formatCents(costs.suppliesPerVisitCents)} a visit.`] : []),
    ...(costs.travelPerVisitCents ? [`Travel costs ${formatCents(costs.travelPerVisitCents)} a visit.`] : []),
    ...(costs.minimumJobCents ? [`No job is charged less than ${formatCents(costs.minimumJobCents)}.`] : []),
    "Every amount in the template was scaled to match and rounded. Taxes are not included. This is a suggestion, not market research.",
  ];
  return {
    spec: scaled,
    basis: "costs",
    assumptions,
    typical: after.totalCents !== null ? { label: job.label, priceCents: after.totalCents, marginPercent: afterProfit?.contributionMarginPercent ?? null } : null,
  };
}
