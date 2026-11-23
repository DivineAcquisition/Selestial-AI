/**
 * Where other parts of Selestial tell Quality something happened. Each call queues one keyed run; a repeat
 * queues nothing. These are the event contracts listed in docs/quality/00-architecture.md.
 */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { enqueueQualityRun } from "./runs";
import { qualitySettings } from "./settings";
import { MINUTE } from "./words";

/** Every crew member on the visit reported it done (convex/lib/dispatch/live.ts `submitCompletion`). */
export async function qualityOnCompletionReported(ctx: MutationCtx, job: Doc<"jobs">): Promise<void> {
  await enqueueQualityRun(ctx, { companyId: job.companyId, kind: "completion_submitted", key: `completed:${job._id}:${(job.completionReturns ?? 0) + 1}`, jobId: job._id });
}

/**
 * Evidence or a checklist mark arrived for a visit (convex/links.ts). During the visit nothing is asked; after
 * the crew reported it done, one re-review per short window reads several uploads together.
 */
export async function qualityOnEvidence(ctx: MutationCtx, job: Doc<"jobs">): Promise<void> {
  if (job.completionReportedAt === undefined && job.status !== "completed") return;
  const company = await ctx.db.get(job.companyId);
  if (!company) return;
  const minutes = Math.max(1, qualitySettings(company).combineMinutes);
  const window = Math.floor(Date.now() / (minutes * MINUTE));
  await enqueueQualityRun(ctx, { companyId: job.companyId, kind: "evidence_added", key: `evidence:${job._id}:${window}`, jobId: job._id, delayMs: minutes * MINUTE });
}
