/**
 * Corrective work, coordinated, not duplicated.
 *
 * Quality prepares the correction's scope (the areas, targeted or full, why it fits the reviewed findings,
 * what evidence must exist afterwards, how time-sensitive it is, crew constraints, and an estimated cost with
 * its basis). The correction itself is a Retention remedy on the recovery episode: Retention arranges it with
 * the customer, the Owner sets the crew's pay (which books it), Dispatch staffs it as an ordinary visit with
 * `jobs.recovery`, and Finance handles any money. Quality then verifies the work against its own criteria.
 *
 * States stay apart: proposed, approved, scheduled, crew accepted, completed, quality verified (or not), and,
 * separately, what the customer said. Nothing here is "resolved".
 *
 * A correction is revalidated: if the findings it rests on are revised or rejected before it is scheduled,
 * it is blocked and the remedy on Retention's case is withdrawn.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { userError } from "../errors";
import { recordEvent, type Actor } from "../events";
import { notifyMembers } from "../notify/route";
import { correctionCost, correctionSlots, prepareAction, submitAction } from "../retention/actions";
import { addEntry as addRetentionEntry } from "../retention/cases";
import { targetedMinutes } from "../retention/recovery";
import { episodeForQuality } from "../retention/quality";
import { addEntry, closeCase, moveCase } from "./cases";
import { findingsOf } from "./findings";
import type { CorrectionState, CustomerAnswer, QualitySource } from "./schema";
import { CORRECTION_WORDS, DAY, QUALITY, SYSTEM } from "./words";

type Ctx = QueryCtx | MutationCtx;
type Correction = Doc<"qualityCorrections">;

export async function correctionsOf(ctx: Ctx, row: Pick<Doc<"qualityCases">, "_id" | "companyId">): Promise<Correction[]> {
  return ctx.db
    .query("qualityCorrections")
    .withIndex("by_company_case", (q) => q.eq("companyId", row.companyId).eq("caseId", row._id))
    .take(20);
}

async function findingStamp(ctx: Ctx, row: Doc<"qualityCases">, findingIds: Id<"qualityFindings">[]): Promise<string> {
  const parts: string[] = [];
  for (const id of findingIds) {
    const f = await ctx.db.get(id);
    parts.push(`${id}:${f?.revision ?? 0}:${f?.state ?? "gone"}`);
  }
  return parts.join(",");
}

export type CorrectionInput = {
  findingIds: Id<"qualityFindings">[];
  areas: string[];
  scope: "targeted" | "full";
  minutes?: number;
  afterPhotos: number;
  checklistLabels: string[];
  inspection: boolean;
  timeSensitive?: { by: number; reason: string };
  crewConstraints: string[];
  avoidCleanerIds: Id<"cleaners">[];
  actor: Actor;
};

/** Prepares a correction on reviewed findings and hands it to Retention as a remedy. Nothing is booked here. */
export async function proposeCorrection(ctx: MutationCtx, company: Doc<"companies">, row: Doc<"qualityCases">, input: CorrectionInput): Promise<Correction> {
  if (row.stage === "closed") throw userError("The case is closed.");
  if (row.serious && !row.serious.decision) throw userError("A serious concern waits for the Owner's decision before any correction is arranged.");
  if (!row.jobId) throw userError("A correction needs the visit it corrects.");
  const job = (await ctx.db.get(row.jobId))!;
  const findings = (await findingsOf(ctx, row)).filter((f) => input.findingIds.includes(f._id));
  if (!findings.length || findings.length !== input.findingIds.length) throw userError("Choose the findings this correction answers.");
  const unreviewed = findings.filter((f) => f.state !== "reviewed");
  if (unreviewed.length) throw userError("A correction rests on findings a person has reviewed. Review the suggested findings first.");
  if (findings.some((f) => f.category === "scope_misunderstanding")) throw userError("Work outside the booked scope is not a correction. Sales can offer to add it.");
  if (!findings.some((f) => f.category === "service_miss")) throw userError("A correction answers a reviewed service miss.");
  const key = `correction:${row._id}:${input.findingIds.slice().sort().join(",")}`;
  const existing = await ctx.db
    .query("qualityCorrections")
    .withIndex("by_company_key", (q) => q.eq("companyId", company._id).eq("key", key))
    .first();
  if (existing && existing.state !== "cancelled" && existing.state !== "blocked") return existing;
  const accepted = (await ctx.db.query("assignments").withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id)).take(30)).filter((a) => a.status === "accepted");
  const durationMinutes = Math.round((job.endsAt - job.startsAt) / 60_000);
  const minutes = input.minutes ?? (input.scope === "full" ? durationMinutes : targetedMinutes(durationMinutes));
  const cost = correctionCost({ crewPayCents: accepted.reduce((s, a) => s + a.payCents, 0), durationMinutes, priceCents: job.priceCents ?? null }, minutes);
  const why = `${findings.map((f) => f.statement).join(" ")} A ${input.scope} correction of ${minutes} minutes covers ${input.areas.join(", ") || "the reported work"}.`;
  const criteria = `The correction visit's record shows ${input.checklistLabels.length ? `${input.checklistLabels.map((l) => `"${l}"`).join(", ")} done` : "the corrected work done"}${input.afterPhotos ? `, with at least ${input.afterPhotos} after ${input.afterPhotos === 1 ? "photo" : "photos"}` : ""}${input.inspection ? ", and a person inspected it" : ""}.`;
  const now = Date.now();
  const id = await ctx.db.insert("qualityCorrections", {
    companyId: company._id,
    caseId: row._id,
    jobId: job._id,
    key,
    areas: input.areas.slice(0, 12),
    scope: input.scope,
    why: why.slice(0, 1200),
    findingIds: input.findingIds,
    acceptance: { criteria, afterPhotos: input.afterPhotos, checklistLabels: input.checklistLabels.slice(0, 12), inspection: input.inspection },
    timeSensitive: input.timeSensitive,
    crewConstraints: input.crewConstraints.slice(0, 6).map((c) => c.slice(0, 200)),
    avoidCleanerIds: input.avoidCleanerIds,
    minutes,
    estimatedCostCents: cost.estimateCents ?? undefined,
    costBasis: cost.basis,
    approvalNeeded: "The Owner sets the crew's pay for each correction visit, which books it (Retention's rule). Any credit or refund is the Owner's in Finance.",
    state: "proposed",
    customer: "not_asked",
    stamp: await findingStamp(ctx, row, input.findingIds),
    createdBy: input.actor,
    createdAt: now,
    updatedAt: now,
  });
  // The remedy on Retention's episode: Retention arranges it, the Owner sets pay and books it, Dispatch staffs it.
  const episode = await episodeForQuality(ctx, { company, job, qualityCaseId: row._id, summary: findings[0].statement, areas: input.areas, category: "quality_miss", actor: input.actor });
  const slots = await correctionSlots(ctx, company, { minutes, crew: 1, like: job.startsAt });
  const slot = input.timeSensitive ? slots.find((s) => s.endsAt <= input.timeSensitive!.by) ?? slots[0] : slots[0];
  const action = await prepareAction(ctx, episode, {
    kind: "correction_visit",
    key: `quality-correction:${id}`,
    summary: `Correction visit for ${input.areas.join(", ") || "the reported work"} (scope from Quality)`,
    reason: `${why} Acceptance: ${criteria}`.slice(0, 1000),
    permission: "retention.remedy_within_limit",
    visit: { areas: input.areas, scope: input.scope, startsAt: slot?.startsAt, endsAt: slot?.endsAt, minutes, crew: 1, payHintCents: cost.payHintCents, avoidCleanerIds: input.avoidCleanerIds },
    estimatedCostCents: cost.estimateCents ?? undefined,
    costBasis: cost.basis,
    dueAt: input.timeSensitive?.by ?? row.dueAt,
    actor: input.actor,
  });
  await ctx.db.patch(id, { retentionCaseId: episode._id, retentionActionId: action._id });
  await submitAction(ctx, company, action._id, input.actor);
  await addRetentionEntry(ctx, episode, { kind: "handoff", text: `Quality prepared the correction's scope and acceptance criteria: ${criteria}`, source: { table: "qualityCases", id: row._id, label: "Quality case" }, actor: input.actor });
  if (!row.retentionCaseId) await ctx.db.patch(row._id, { retentionCaseId: episode._id });
  await addEntry(ctx, row, { kind: "handoff", text: `Correction handed to Retention, which arranges it with the customer; the Owner sets the crew's pay to book it, and Dispatch staffs it. ${slot ? "" : "No open time was found in the next 7 days; Dispatch is asked to find one. "}${cost.estimateCents === null ? cost.basis : `Estimated crew cost: $${(cost.estimateCents / 100).toFixed(2)}. ${cost.basis}`}`, source: { table: "retentionActions", id: action._id, label: "Remedy on Retention's case" }, actor: input.actor });
  await recordEvent(ctx, { companyId: company._id, type: "quality_correction.proposed", actor: input.actor, subject: { table: "qualityCorrections", id }, data: { scope: input.scope, minutes } });
  await moveCase(ctx, (await ctx.db.get(row._id))!, { stage: "action_underway", doing: "A correction is with Retention and the Owner. Quality verifies the work once it is done.", clearNeeds: true }, input.actor);
  return (await ctx.db.get(id))!;
}

/** Reads back where the correction stands from the records that hold it. Returns true if anything changed. */
export async function syncCorrection(ctx: MutationCtx, correction: Correction): Promise<boolean> {
  if (correction.state === "quality_verified" || correction.state === "verification_failed" || correction.state === "cancelled") return syncCustomer(ctx, correction);
  const action = correction.retentionActionId ? await ctx.db.get(correction.retentionActionId) : null;
  let state: CorrectionState = correction.state;
  let jobId = correction.correctionJobId;
  let result = correction.result;
  if (!action) state = "blocked";
  else if (action.status === "declined" || action.status === "cancelled") {
    state = "cancelled";
    result = action.result ?? "Withdrawn on Retention's case.";
  } else if (action.status === "failed" || action.status === "blocked") {
    state = "blocked";
    result = action.result ?? "Not carried out.";
  } else if (action.visit?.jobId) {
    jobId = action.visit.jobId;
    const job = await ctx.db.get(jobId);
    const crew = job ? (await ctx.db.query("assignments").withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id)).take(30)).filter((a) => a.status === "accepted") : [];
    if (!job) state = "blocked";
    else if (job.status === "cancelled") {
      state = "cancelled";
      result = `The correction visit was cancelled${job.cancelReason ? `: ${job.cancelReason}` : ""}.`;
    } else if (job.status === "completed") state = "completed";
    else if (crew.length) state = "crew_accepted";
    else state = "scheduled";
  } else if (action.visit?.payBasisCents !== undefined || action.status === "underway") state = "approved";
  else state = "proposed";
  const changed = state !== correction.state || jobId !== correction.correctionJobId || result !== correction.result;
  if (changed) {
    await ctx.db.patch(correction._id, { state, correctionJobId: jobId, result, updatedAt: Date.now() });
    const row = await ctx.db.get(correction.caseId);
    if (row) await addEntry(ctx, row, { kind: "handoff", text: `Correction: ${CORRECTION_WORDS[state]}${result && result !== correction.result ? `. ${result}` : "."}`, source: jobId ? { table: "jobs", id: jobId, label: "Correction visit" } : undefined, actor: SYSTEM });
  }
  const customerChanged = await syncCustomer(ctx, (await ctx.db.get(correction._id))!);
  return changed || customerChanged;
}

/** What the customer said, read from Retention's case. Quality never records it from anywhere else. */
async function syncCustomer(ctx: MutationCtx, correction: Correction): Promise<boolean> {
  const episode = correction.retentionCaseId ? await ctx.db.get(correction.retentionCaseId) : null;
  if (!episode) return false;
  const answer = episode.verification?.customerAnswer?.answer;
  const customer: CustomerAnswer = answer === "resolved" ? "confirmed" : answer === "not_resolved" ? "dissatisfied" : episode.outcome?.code === "no_response" || episode.outcome?.code === "correction_done_unconfirmed" ? "no_response" : episode.verification?.customerAsked ? "asked" : "not_asked";
  if (customer === correction.customer) return false;
  await ctx.db.patch(correction._id, { customer, updatedAt: Date.now() });
  return true;
}

/**
 * Checks the completed correction visit's record against the acceptance criteria. This is Quality's
 * verification of the work, and says nothing about whether the customer is satisfied.
 */
export async function verifyCorrection(ctx: MutationCtx, company: Doc<"companies">, correction: Correction, actor: Actor, inspected = false): Promise<Correction> {
  if (correction.state !== "completed" || !correction.correctionJobId) return correction;
  const job = (await ctx.db.get(correction.correctionJobId))!;
  const photos = await ctx.db.query("evidence").withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id)).take(200);
  const items = await ctx.db.query("checklistItems").withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id)).take(100);
  const unmet: string[] = [];
  const after = photos.filter((p) => p.kind === "after").length;
  if (after < correction.acceptance.afterPhotos) unmet.push(`${after} after ${after === 1 ? "photo" : "photos"}; ${correction.acceptance.afterPhotos} asked for`);
  for (const label of correction.acceptance.checklistLabels) {
    const item = items.find((i) => i.label.toLowerCase().includes(label.toLowerCase()));
    if (!item) unmet.push(`No checklist item for "${label}" on the correction visit`);
    else if (item.state !== "done") unmet.push(`"${item.label}" is ${item.state === "skipped" ? `skipped${item.skipReason ? ` (${item.skipReason})` : ""}` : "not marked"}`);
  }
  if (correction.acceptance.inspection && !inspected) {
    const row = await ctx.db.get(correction.caseId);
    if (row && row.stage !== "closed") await moveCase(ctx, row, { stage: "needs_decision", needs: "The correction visit is done. Its acceptance criteria include an inspection: record it to verify the correction.", doing: "Waiting for a person to record the inspection." }, SYSTEM);
    return correction;
  }
  const sources: QualitySource[] = [{ table: "jobs", id: job._id, label: "Correction visit", at: job.startsAt }];
  const outcome = unmet.length ? "not_verified" : "verified";
  await ctx.db.patch(correction._id, { state: outcome === "verified" ? "quality_verified" : "verification_failed", verification: { outcome, detail: outcome === "verified" ? "The correction visit's record meets the acceptance criteria." : `Not met: ${unmet.join("; ")}.`, unmet, sources, by: actor, at: Date.now() }, updatedAt: Date.now() });
  const fresh = (await ctx.db.get(correction._id))!;
  const row = await ctx.db.get(correction.caseId);
  await recordEvent(ctx, { companyId: company._id, type: `quality_correction.${outcome}`, actor, subject: { table: "qualityCorrections", id: correction._id }, data: {} });
  if (row && row.stage !== "closed") {
    await addEntry(ctx, row, { kind: "verification", basis: "fact", text: outcome === "verified" ? `Correction verified against its acceptance criteria. That is the work's record; the customer's answer is Retention's and is shown separately.` : `The correction was not verified: ${unmet.join("; ")}.`, source: sources[0], actor });
    if (outcome === "verified") {
      // Quality's part is done. While Retention's episode with the customer is still open, the case waits for its outcome.
      const episode = fresh.retentionCaseId ? await ctx.db.get(fresh.retentionCaseId) : null;
      if (episode && episode.status !== "closed") await moveCase(ctx, row, { stage: "verifying", doing: "Quality verified the correction. Retention has the conversation with the customer; their answer is recorded there.", clearNeeds: true, dueAt: Date.now() + 7 * DAY }, actor);
      else await closeCase(ctx, row, "correction_verified", actor, episode?.outcome ? `Customer outcome on Retention's case: ${episode.outcome.code.replace(/_/g, " ")}.` : undefined);
    } else {
      await moveCase(ctx, row, { stage: "needs_decision", needs: `The correction did not meet its acceptance criteria: ${unmet.join("; ")}. Decide the next step.`, doing: "Waiting for a person to decide the next step." }, actor);
      await notifyMembers(ctx, { companyId: company._id, event: "quality_attention", ref: row._id, key: `quality_verification:${correction._id}`, facts: { kind: "verification" } });
    }
  }
  return fresh;
}

/** The findings a correction rests on changed: a correction not yet scheduled is blocked and its remedy withdrawn. */
export async function invalidateCorrections(ctx: MutationCtx, row: Doc<"qualityCases">, why: string): Promise<number> {
  let n = 0;
  for (const c of await correctionsOf(ctx, row)) {
    if (c.state !== "proposed" && c.state !== "approved") continue;
    if ((await findingStamp(ctx, row, c.findingIds)) === c.stamp) continue;
    const action = c.retentionActionId ? await ctx.db.get(c.retentionActionId) : null;
    if (action && (action.status === "proposed" || action.status === "awaiting_approval")) {
      await ctx.db.patch(action._id, { status: "cancelled", result: `Withdrawn: ${why}`, approvalId: undefined, updatedAt: Date.now(), doneAt: Date.now() });
      const episode = await ctx.db.get(action.caseId);
      if (episode) await addRetentionEntry(ctx, episode, { kind: "action", text: `Withdrawn by Quality: "${action.summary}". ${why}`, actor: QUALITY });
    }
    // Scheduled work is Dispatch's: once booked it is not undone here; the case says the evidence changed.
    await ctx.db.patch(c._id, { state: "blocked", result: `The findings it rested on changed: ${why}`, updatedAt: Date.now() });
    await addEntry(ctx, row, { kind: "action", text: `Correction withdrawn before it was scheduled: ${why}`, actor: QUALITY });
    n += 1;
  }
  return n;
}
