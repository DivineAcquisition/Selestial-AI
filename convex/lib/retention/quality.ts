/**
 * Where Quality and Retention meet. Retention owns the customer recovery episode and the conversation; Quality
 * owns the assessment, the correction's scope and its verification. This file is the only place Retention's
 * records are opened or changed on Quality's behalf.
 *
 *  - A Quality case that needs anything customer-facing (a question, a correction visit) uses the open
 *    Retention case for that visit, or opens one, marked as opened from an inspection. Opening it sends
 *    nothing: no automatic plan runs, and the customer is contacted only through Retention's own steps.
 *  - Retention's own events (feedback, a completed correction, a recorded credit, an outcome) queue Quality
 *    runs, so Quality sees them without polling.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { Actor } from "../events";
import { enqueueQualityRun } from "../quality/runs";
import { addEntry, caseByKey, moveCase, openCase } from "./cases";

type Case = Doc<"retentionCases">;

/** The open Retention recovery case about this visit, if there is one. */
export async function openRecoveryForJob(ctx: MutationCtx, companyId: Id<"companies">, jobId: Id<"jobs">): Promise<Case | null> {
  const rows = await ctx.db
    .query("retentionCases")
    .withIndex("by_company_job", (q) => q.eq("companyId", companyId).eq("jobId", jobId))
    .take(20);
  return rows.find((r) => r.kind === "recovery" && r.status !== "closed") ?? null;
}

/**
 * The recovery episode a Quality case uses for anything customer-facing. Joins the open one for the visit,
 * or opens one that waits on a person: nothing is planned or sent by opening it.
 */
export async function episodeForQuality(ctx: MutationCtx, input: { company: Doc<"companies">; job: Doc<"jobs">; qualityCaseId: Id<"qualityCases">; summary: string; areas: string[]; category: "quality_miss" | "scope_misunderstanding" | "insufficient_evidence"; actor: Actor }): Promise<Case> {
  const existing = (await openRecoveryForJob(ctx, input.company._id, input.job._id)) ?? (await caseByKey(ctx, input.company._id, `quality:${input.qualityCaseId}`));
  if (existing && existing.status !== "closed") return existing;
  const customer = (await ctx.db.get(input.job.customerId))!;
  const property = await ctx.db.get(input.job.propertyId);
  const opened = await openCase(ctx, {
    companyId: input.company._id,
    kind: "recovery",
    key: `quality:${input.qualityCaseId}`,
    status: "needs_attention",
    customer,
    property,
    jobId: input.job._id,
    title: `${customer.name}: ${input.areas.join(", ") || "a visit"} (from Quality's review)`,
    happened: `Quality's review of the visit found something that may need the customer: ${input.summary}`.slice(0, 600),
    doing: "Quality prepared this. Nothing has been sent to the customer.",
    needs: "Quality's review needs a customer-facing step. Retention owns the conversation: decide what to tell the customer, if anything.",
    origin: "inspection",
    areas: input.areas,
    dueAt: Date.now() + 2 * 24 * 60 * 60 * 1000,
    actor: input.actor,
  });
  let row = opened.row;
  await addEntry(ctx, row, { kind: "handoff", text: "Opened from a Quality case. The customer has not reported anything about this visit; Quality's review found it. Nothing is sent unless Retention or a person decides to.", source: { table: "qualityCases", id: input.qualityCaseId, label: "Quality case" }, actor: input.actor });
  row = await moveCase(ctx, row, { diagnosis: { category: input.category, basis: "fact", reasons: [input.summary.slice(0, 300)], uncertain: ["How the customer saw the visit"], by: input.actor, reader: "quality", at: Date.now() } }, input.actor);
  return row;
}

/** Retention's events that Quality reacts to. Each is a keyed Quality run, so a repeat queues nothing. */
export async function tellQuality(ctx: MutationCtx, input: { companyId: Id<"companies">; kind: "feedback_submitted" | "correction_completed" | "financial_settled" | "case_outcome"; key: string; jobId?: Id<"jobs">; retentionCaseId: Id<"retentionCases"> }): Promise<void> {
  await enqueueQualityRun(ctx, { companyId: input.companyId, kind: input.kind, key: input.key, jobId: input.jobId, payload: { retentionCaseId: input.retentionCaseId } });
}
