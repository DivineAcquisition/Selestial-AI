/** Reads what an agent may do with one action right now. Every agent tool asks this before it runs. */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { capabilityOf } from "./controls/capabilities";
import { actionDef, initialLevel, PERSON_ONLY, rank, type Level } from "./permissionCatalog";

export type Authority =
  | { kind: "person_only" }
  | { kind: "unknown" }
  /** In the catalog, but no execution path does it: nothing can turn it on (convex/lib/controls/capabilities.ts). */
  | { kind: "unavailable"; why: string }
  | { kind: "paused" }
  /** `expired`: a temporary level above Ask me first ran out, so this is Ask me first now. */
  | { kind: "level"; level: Level; perActionCents?: number; perDayCents?: number; expired?: true };

export async function authorityFor(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">, action: string, now = Date.now()): Promise<Authority> {
  if (PERSON_ONLY.some((entry) => entry.key === action)) return { kind: "person_only" };
  const def = actionDef(action);
  // An action that is not in the catalog is never allowed. It is not treated as Off, which an owner could change.
  if (!def) return { kind: "unknown" };
  const capability = capabilityOf(action);
  if (!capability.implemented) return { kind: "unavailable", why: capability.unavailable ?? "This isn't something an agent can do." };
  const company = await ctx.db.get(companyId);
  if (!company) return { kind: "unknown" };
  if (company.pausedAgents.includes(def.agent)) return { kind: "paused" };
  const row = await ctx.db
    .query("permissions")
    .withIndex("by_company_action", (q) => q.eq("companyId", companyId).eq("action", action))
    .unique();
  if (!row) return { kind: "level", level: initialLevel(def) };
  // A temporary level is enforced here, for every caller, the moment it runs out.
  if (row.until !== undefined && now >= row.until && rank(row.level) > rank("propose")) return { kind: "level", level: "propose", perActionCents: row.perActionCents, perDayCents: row.perDayCents, expired: true };
  return { kind: "level", level: row.level, perActionCents: row.perActionCents, perDayCents: row.perDayCents };
}
