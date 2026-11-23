/**
 * Quality's background work. Each piece is a `qualityRuns` row named by an idempotency key, so the same
 * event delivered twice, a webhook replayed or a schedule that fires again finds the first and does nothing.
 *
 * A run is leased while a worker holds it; a lease that runs out is picked up by the sweep. A run that throws
 * changes nothing (its transaction rolls back) and is retried with backoff a bounded number of times, then
 * failed and put in front of a person. A run that cannot go ahead (Quality paused, not on the plan, the
 * company suspended) is `blocked` with the reason in words, and resumes when the reason clears. Nothing is
 * hidden: every state is shown in Quality's overview.
 */
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { agentVerdict } from "../billing/access";
import type { RunKind } from "./schema";
import { MINUTE } from "./words";

export const MAX_ATTEMPTS = 4;
export const LEASE_MS = 3 * MINUTE;
/** Minutes to wait before attempt n (1-based). */
export const BACKOFF_MINUTES = [0, 1, 5, 20, 60];

export type AgentState = { ok: true } | { ok: false; code: "suspended" | "paused" | "plan" | "not_released"; reason: string };

/** Whether Quality's agent work may run for this company right now. People keep the workspace either way. */
export function agentState(company: Doc<"companies">): AgentState {
  if (company.suspendedAt || company.closingAt) return { ok: false, code: "suspended", reason: "The company's account is suspended, so Quality does nothing until it is restored." };
  if (company.pausedAgents.includes("quality")) return { ok: false, code: "paused", reason: "Quality is paused. People can still review visits and work cases." };
  const verdict = agentVerdict(company, "quality");
  if (!verdict.ok) return { ok: false, code: verdict.block === "not_released" ? "not_released" : "plan", reason: `${verdict.message} People can still review visits and work cases by hand.` };
  return { ok: true };
}

export type NewRun = {
  companyId: Id<"companies">;
  kind: RunKind;
  key: string;
  jobId?: Id<"jobs">;
  caseId?: Id<"qualityCases">;
  reviewId?: Id<"qualityReviews">;
  commId?: Id<"qualityComms">;
  connectionId?: Id<"qualityConnections">;
  payload?: Record<string, string | number | boolean | null>;
  historical?: boolean;
  delayMs?: number;
};

/** Queues one piece of work once. Asked again with the same key, nothing is queued and the first is returned. */
export async function enqueueQualityRun(ctx: MutationCtx, input: NewRun): Promise<{ runId: Id<"qualityRuns">; created: boolean }> {
  const existing = await ctx.db
    .query("qualityRuns")
    .withIndex("by_company_key", (q) => q.eq("companyId", input.companyId).eq("key", input.key))
    .first();
  if (existing) return { runId: existing._id, created: false };
  const now = Date.now();
  const runId = await ctx.db.insert("qualityRuns", {
    companyId: input.companyId,
    kind: input.kind,
    key: input.key,
    status: "queued",
    attempts: 0,
    nextAttemptAt: now + (input.delayMs ?? 0),
    jobId: input.jobId,
    caseId: input.caseId,
    reviewId: input.reviewId,
    commId: input.commId,
    connectionId: input.connectionId,
    payload: input.payload ? JSON.stringify(input.payload).slice(0, 2000) : undefined,
    checked: [],
    found: [],
    next: [],
    historical: input.historical,
    queuedAt: now,
  });
  await ctx.scheduler.runAfter(input.delayMs ?? 0, internal.qualityWork.run, { runId });
  return { runId, created: true };
}

/** Takes a run for a worker: counts the attempt and sets the lease. Null when it is not this worker's to run. */
export async function leaseRun(ctx: MutationCtx, runId: Id<"qualityRuns">): Promise<Doc<"qualityRuns"> | null> {
  const run = await ctx.db.get(runId);
  if (!run) return null;
  const now = Date.now();
  if (run.status === "running" && run.leaseUntil !== undefined && run.leaseUntil > now) return null;
  if (run.status !== "queued" && run.status !== "running" && run.status !== "blocked") return null;
  if (run.nextAttemptAt !== undefined && run.nextAttemptAt > now + 1000) return null;
  await ctx.db.patch(run._id, { status: "running", leaseUntil: now + LEASE_MS, startedAt: run.startedAt ?? now, attempts: run.attempts + 1, blockedReason: undefined });
  return (await ctx.db.get(run._id))!;
}

export type RunEnd = { status: "done" | "skipped" | "blocked" | "failed" | "cancelled"; result: string; checked?: string[]; found?: string[]; next?: string[]; blockedReason?: string; caseId?: Id<"qualityCases">; reviewId?: Id<"qualityReviews"> };

export async function finishRun(ctx: MutationCtx, run: Pick<Doc<"qualityRuns">, "_id">, end: RunEnd): Promise<void> {
  const terminal = end.status !== "blocked";
  await ctx.db.patch(run._id, {
    status: end.status,
    result: end.result.slice(0, 600),
    checked: (end.checked ?? []).slice(0, 20).map((s) => s.slice(0, 300)),
    found: (end.found ?? []).slice(0, 20).map((s) => s.slice(0, 300)),
    next: (end.next ?? []).slice(0, 10).map((s) => s.slice(0, 300)),
    blockedReason: end.blockedReason,
    leaseUntil: undefined,
    ...(end.caseId ? { caseId: end.caseId } : {}),
    ...(end.reviewId ? { reviewId: end.reviewId } : {}),
    ...(terminal ? { finishedAt: Date.now() } : {}),
  });
}

/** After a thrown attempt the sweep schedules the next one, or fails the run for good. */
export function nextAttemptAfter(attempts: number, now: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return now + (BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)] ?? 60) * MINUTE;
}

/** Ends the runs still waiting on a case that closed: they would act on something already decided. */
export async function cancelRunsFor(ctx: MutationCtx, companyId: Id<"companies">, caseId: Id<"qualityCases">, why: string): Promise<number> {
  const rows = await ctx.db
    .query("qualityRuns")
    .withIndex("by_company_case", (q) => q.eq("companyId", companyId).eq("caseId", caseId))
    .take(100);
  let n = 0;
  for (const row of rows) {
    if (row.status === "queued" || row.status === "blocked") {
      await ctx.db.patch(row._id, { status: "cancelled", result: why, finishedAt: Date.now(), leaseUntil: undefined });
      n += 1;
    }
  }
  return n;
}
