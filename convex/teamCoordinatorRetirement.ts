/**
 * Retiring Team Coordinator (November 22, 2026; docs/foundation/01-navigation.md). Team Coordinator was never
 * a running agent: its queue was a label on tasks a person worked. This moves any open task still carrying
 * that label to the agent that owns the work now, keeping its company, subject, state, history and key, so
 * dedupe and retries behave as before. Closed tasks keep the label as history.
 *
 * It sends nothing, charges nothing and changes no worker. Running it again changes nothing. A task it cannot
 * place is left as it is and reported for a person to classify.
 *
 *   npx convex run teamCoordinatorRetirement:run '{"dryRun": true}'
 */
import { v } from "convex/values";

import { internalMutation } from "./_generated/server";

const OPEN = ["open", "waiting", "needs_decision"] as const;

/** Where each kind of task belongs now, by the key it was opened with. */
function ownerOf(key: string | undefined): "recruiter" | "dispatch" | null {
  if (!key) return null;
  if (key.startsWith("recruiter.onboarding:")) return "recruiter";
  if (key.startsWith("team_coordinator.contact:")) return "dispatch";
  // A follow-up that ran out of reminders: the agent that ran the follow-up keeps it.
  if (key.endsWith(":person")) return key.includes("onboarding") ? "recruiter" : "dispatch";
  return null;
}

export const run = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const moved: { taskId: string; to: string }[] = [];
    const unclassified: { taskId: string; title: string; key: string | null }[] = [];
    let checked = 0;
    for (const status of OPEN) {
      const rows = await ctx.db
        .query("tasks")
        .filter((q) => q.and(q.eq(q.field("status"), status), q.eq(q.field("handoffTo"), "team_coordinator")))
        .take(1000);
      for (const task of rows) {
        checked += 1;
        const owner = ownerOf(task.key);
        if (!owner) {
          unclassified.push({ taskId: task._id, title: task.title, key: task.key ?? null });
          continue;
        }
        moved.push({ taskId: task._id, to: owner });
        // The task was already filed under its owning agent; only the retired queue label goes.
        if (!args.dryRun) await ctx.db.patch(task._id, { handoffTo: undefined, ...(task.agent === owner ? {} : { agent: owner }) });
      }
    }
    return { dryRun: Boolean(args.dryRun), checked, moved, unclassified };
  },
});
