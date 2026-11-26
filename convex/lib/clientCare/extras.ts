/**
 * A published extra added to one upcoming visit, at its current price, once the client accepted it.
 *
 * The price is the pricing engine's, never Care's: the visit's own saved quote inputs are quoted again with the
 * add-on, and the extra costs exactly the difference. Nothing else about the accepted price changes. An extra
 * that adds time lengthens the visit through Dispatch's own move (its crew is asked again for the longer visit).
 * A visit that wasn't priced from a published service, one already invoiced, or an add-on the service doesn't
 * publish is a person's to handle (or Sales', for a custom scope).
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { money } from "../dispatch/pay";
import { commitMove, planMove } from "../dispatch/reschedule";
import { recordEvent, type Actor } from "../events";
import { quote, type QuoteInput } from "../services/engine";
import { saveQuote } from "../services/operations";
import type { AddOn } from "../services/spec";

type Ctx = QueryCtx | MutationCtx;
const MINUTE = 60_000;
const STOP = new Set(["the", "a", "an", "of", "and", "to", "in", "on", "for", "please", "add", "also", "clean", "cleaning", "my", "our", "your", "this", "that", "with", "inside"]);

export type ExtraOffer = { addOnId: string; label: string; quantity: number; extraCents: number; extraMinutes: number; newPriceCents: number; included: boolean };
export type Priced = { ok: true; offer: ExtraOffer } | { ok: false; why: string; route: "owner" | "sales"; candidates?: string[] };

const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

/** The published add-ons that the client's words name: every meaningful word of the label, or the item word. */
export function matchAddOns(addOns: readonly AddOn[], text: string): AddOn[] {
  const said = new Set(words(text));
  const stem = (w: string) => w.replace(/s$/, "");
  const saidStems = new Set([...said].map(stem));
  return addOns.filter((a) => {
    const label = words(a.label);
    const item = a.itemWord ? stem(a.itemWord.toLowerCase()) : null;
    return (label.length > 0 && label.every((w) => saidStems.has(stem(w)))) || (item !== null && saidStems.has(item));
  });
}

function quantityIn(text: string, addOn: AddOn): number {
  if (addOn.per !== "item" || !addOn.itemWord) return 1;
  const match = new RegExp(`\\b(\\d{1,2})\\s+${addOn.itemWord.replace(/s$/, "")}`, "i").exec(text);
  return Math.max(1, Math.min(addOn.maxQuantity || 1, match ? Number(match[1]) : 1));
}

async function loaded(ctx: Ctx, job: Doc<"jobs">) {
  const snap = job.serviceSnapshot;
  if (!snap?.quoteId || !snap.versionId) return null;
  const saved = await ctx.db.get(snap.quoteId);
  const version = await ctx.db.get(snap.versionId);
  const service = version ? await ctx.db.get(version.serviceId) : null;
  if (!saved || !version || !service || saved.companyId !== job.companyId) return null;
  let input: QuoteInput;
  try {
    input = JSON.parse(saved.input) as QuoteInput;
  } catch {
    return null;
  }
  return { saved, version, service, input };
}

/** What adding the named extra to this visit would cost and take, from the engine. Changes nothing. */
export async function priceExtra(ctx: Ctx, job: Doc<"jobs">, text: string): Promise<Priced> {
  if (job.status !== "scheduled") return { ok: false, why: "The visit has started or is no longer booked.", route: "owner" };
  const base = await loaded(ctx, job);
  if (!base) return { ok: false, why: "This visit wasn't priced from a published service, so the office prices any extra on it.", route: "owner" };
  const matches = matchAddOns(base.version.spec.addOns, text);
  if (matches.length === 0) return { ok: false, why: "That isn't one of the extras this service publishes, so it's a custom scope for Sales to quote.", route: "sales" };
  if (matches.length > 1) return { ok: false, why: "The words could mean more than one published extra.", route: "owner", candidates: matches.map((m) => m.label) };
  const addOn = matches[0];
  const quantity = quantityIn(text, addOn);
  const before = quote(base.version.spec, base.input);
  const added = (base.input.addOns ?? []).filter((a) => a.id !== addOn.id);
  const current = (base.input.addOns ?? []).find((a) => a.id === addOn.id)?.quantity ?? 0;
  const after = quote(base.version.spec, { ...base.input, addOns: [...added, { id: addOn.id, quantity: Math.min(addOn.maxQuantity || quantity + current, current + quantity) }] });
  if (before.totalCents === null || after.totalCents === null || after.outcome !== "firm" || before.per !== "visit") return { ok: false, why: "The engine can't give a firm price for this extra on this visit.", route: "owner" };
  const included = after.extras.some((e) => e.id === addOn.id && e.included);
  const extraCents = Math.max(0, after.totalCents - before.totalCents);
  const extraMinutes = Math.max(0, after.time.elapsedMinutes - before.time.elapsedMinutes);
  const invoice = await ctx.db
    .query("invoices")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .first();
  if (invoice && invoice.status !== "void" && invoice.status !== "draft" && extraCents > 0) return { ok: false, why: "The visit's invoice is already issued, so Finance adjusts it before an extra is added.", route: "owner" };
  if (extraMinutes > 0) {
    const company = (await ctx.db.get(job.companyId))!;
    const plan = await planMove(ctx, company, job, { startsAt: job.startsAt, endsAt: job.endsAt + extraMinutes * MINUTE });
    if (plan.plan.problems.length) return { ok: false, why: `The visit can't be made longer: ${plan.plan.problems[0]}`, route: "owner" };
  }
  return { ok: true, offer: { addOnId: addOn.id, label: addOn.label, quantity, extraCents, extraMinutes, newPriceCents: (job.priceCents ?? before.totalCents) + extraCents, included } };
}

/** Adds the extra exactly as offered, after pricing it again. A different price or time stops it. */
export async function addExtra(ctx: MutationCtx, company: Doc<"companies">, job: Doc<"jobs">, text: string, expected: { extraCents: number; extraMinutes: number; addOnId: string }, actor: Actor): Promise<{ ok: boolean; detail: string }> {
  const priced = await priceExtra(ctx, job, text);
  if (!priced.ok) return { ok: false, detail: priced.why };
  const offer = priced.offer;
  if (offer.addOnId !== expected.addOnId || offer.extraCents !== expected.extraCents || offer.extraMinutes !== expected.extraMinutes) return { ok: false, detail: "The extra's price or time changed since the client accepted it, so it was not added." };
  const base = (await loaded(ctx, job))!;
  const current = (base.input.addOns ?? []).find((a) => a.id === offer.addOnId)?.quantity ?? 0;
  const input: QuoteInput = { ...base.input, addOns: [...(base.input.addOns ?? []).filter((a) => a.id !== offer.addOnId), { id: offer.addOnId, quantity: current + offer.quantity }] };
  const result = quote(base.version.spec, input);
  let moved = job;
  if (offer.extraMinutes > 0) {
    const move = { startsAt: job.startsAt, endsAt: job.endsAt + offer.extraMinutes * MINUTE };
    const plan = await planMove(ctx, company, job, move);
    await commitMove(ctx, company, job, move, plan.plan.version, actor);
    moved = (await ctx.db.get(job._id))!;
  }
  const quoteId: Id<"serviceQuotes"> = await saveQuote(ctx, { companyId: company._id, service: base.service, version: base.version, quoteInput: input, result, purpose: "visit", actor, jobId: job._id });
  const line = `Extra: ${offer.label}${offer.quantity > 1 ? ` × ${offer.quantity}` : ""}${offer.extraMinutes ? ` (adds about ${offer.extraMinutes} minutes)` : ""}`;
  await ctx.db.patch(job._id, { priceCents: offer.newPriceCents, scope: `${moved.scope}\n${line}`.slice(0, 2000), serviceSnapshot: { ...moved.serviceSnapshot!, quoteId, priceSource: "quote" } });
  await recordEvent(ctx, { companyId: company._id, type: "job.extra_added", actor, subject: { table: "jobs", id: job._id }, data: { addOn: offer.addOnId, quantity: offer.quantity, extraCents: offer.extraCents, extraMinutes: offer.extraMinutes } });
  return { ok: true, detail: `Added ${offer.label} to the visit for ${money(offer.extraCents)}${offer.extraMinutes ? `, ${offer.extraMinutes} minutes longer; Dispatch asks the crew again for the longer visit` : ""}.` };
}
