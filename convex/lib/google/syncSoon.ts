/**
 * Asks for a calendar sync now, after a change made in Selestial, instead of waiting for the ten-minute
 * sweep. Nothing waits on Google: the change is already saved, and without a connection, a granted
 * calendar or a calendar chosen to write to, this does nothing. Changes within the same minute share one
 * sync, so a burst of edits is one run.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { activeConnection } from "./connection";
import { enquire } from "./enquire";
import { enabledFeatures } from "./features";

export async function syncCalendarSoon(ctx: MutationCtx, companyId: Id<"companies">, requestedBy?: Id<"members">): Promise<boolean> {
  const connection = await activeConnection(ctx, companyId, "calendar");
  if (!connection || connection.status !== "connected" || !enabledFeatures(connection.grantedScopes).includes("calendar")) return false;
  const target = (await ctx.db.query("googleResources").withIndex("by_company_kind", (q) => q.eq("companyId", companyId).eq("kind", "calendar_sync")).take(5)).find((row) => row.access !== "lost");
  if (!target) return false;
  await enquire(ctx, companyId, connection._id, "calendar_sync", `calendar_sync:soon:${Math.floor(Date.now() / 60_000)}`, {}, requestedBy);
  return true;
}
