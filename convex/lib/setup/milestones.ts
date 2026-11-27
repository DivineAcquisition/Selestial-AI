/**
 * Setup milestones that are reached by background work rather than by the owner's own saves: the first
 * output the owner can use, and the first one they published. Recorded at the moment they happen, once,
 * without touching the setup's revision (that counts the owner's edits, so a worker never makes a tab stale).
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { recordEvent } from "../events";

export async function noteMilestone(ctx: MutationCtx, companyId: Id<"companies">, milestone: "firstUsableAt" | "firstPublishedAt", data: Record<string, string | number | boolean> = {}): Promise<boolean> {
  const setup = await ctx.db
    .query("companySetups")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .first();
  if (!setup || setup.milestones[milestone] !== undefined) return false;
  const now = Date.now();
  await ctx.db.patch(setup._id, { milestones: { ...setup.milestones, [milestone]: now, ...(milestone === "firstUsableAt" && setup.milestones.firstArtifactAt === undefined ? { firstArtifactAt: now } : {}) } });
  await recordEvent(ctx, {
    companyId,
    type: milestone === "firstUsableAt" ? "setup.first_usable_output" : "setup.first_output_published",
    actor: { kind: "system" },
    subject: { table: "companies", id: companyId },
    data: { priority: setup.priority ?? "none", entry: setup.entry ?? "manual", minutes: Math.round((now - setup.milestones.startedAt) / 60_000), ...data },
  });
  return true;
}
