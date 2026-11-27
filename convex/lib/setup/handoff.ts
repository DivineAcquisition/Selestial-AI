/**
 * A connection finished after setup sent the owner to make it (setup.handoff). Called by recordEvent for the
 * events that mean a connection is really in place, never for a page visit, so "completed" is only said
 * when it is true. Only a handoff that is still open and recent is closed.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

export const HANDOFF_CONNECTED = new Set(["google.connected", "google.reconnected", "mailbox.connected", "connector.connected"]);
const OPEN_FOR_MS = 24 * 60 * 60 * 1000;

/** Marks the open handoff completed. Returns what to record, or null when there was none to close. */
export async function closeHandoff(ctx: MutationCtx, companyId: Id<"companies">): Promise<{ kind: string; path: string; step: string } | null> {
  const setup = await ctx.db
    .query("companySetups")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .first();
  const open = setup?.handoff;
  if (!setup || !open || open.outcome === "completed" || Date.now() - open.at > OPEN_FOR_MS) return null;
  if (open.kind !== "integration" && open.kind !== "inbox") return null;
  await ctx.db.patch(setup._id, { handoff: { ...open, outcome: "completed" } });
  return { kind: open.kind, path: open.href.split("?")[0], step: open.step };
}
