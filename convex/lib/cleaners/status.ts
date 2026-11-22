/**
 * A routine change to a cleaner's engagement (onboarding, active, paused), made by a person in the Cleaners
 * workspace. Both of the workspace's status controls go through here, so they cannot disagree.
 *
 *  - A new hire in Recruiter's open onboarding becomes active through its readiness approval, where every
 *    item is reviewed (lib/recruiter/handoff.ts), not around it.
 *  - Once someone is not active, Dispatch offers them nothing new. Accepted upcoming visits are never cancelled
 *    here: they go to Dispatch for a person to decide, one by one.
 */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { userError } from "../errors";
import { recordEvent, type Actor } from "../events";
import { handOverJobs } from "./personnel";

type Routine = "onboarding" | "ready" | "paused";

export async function changeRoutineStatus(ctx: MutationCtx, company: Doc<"companies">, cleaner: Doc<"cleaners">, to: Routine, actor: Actor): Promise<void> {
  if (cleaner.status === "onboarding" && to === "ready") {
    const open = await ctx.db
      .query("onboardingHandoffs")
      .withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", "open"))
      .take(500);
    if (open.some((row) => row.cleanerId === cleaner._id)) throw userError("Their onboarding is still open in Recruiter. Approve readiness there, where each item is reviewed.");
  }
  await ctx.db.patch(cleaner._id, { status: to, statusChangedAt: Date.now(), updatedAt: Date.now() });
  await recordEvent(ctx, { companyId: company._id, type: "cleaner.status_changed", actor, subject: { table: "cleaners", id: cleaner._id }, data: { from: cleaner.status, to } });
  if (cleaner.status === "ready" && to !== "ready") await handOverJobs(ctx, company, cleaner, to === "paused" ? "paused" : "moved back to onboarding", actor);
}
