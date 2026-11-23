/**
 * Agent Controls (docs/foundation/07-agent-controls.md). The policy itself stays where it always was:
 * `permissions` rows and `companies.pausedAgents`. These tables add what supervising it needs:
 *
 *  - controlChanges        every change to the policy, with the whole policy before and after it, the person
 *                          and the revision, so history is complete and "restore" has an exact target
 *  - allowanceDays         one row per company, money action and local calendar day: what has been
 *                          committed and what is reserved, kept exactly (never summed from a truncated list)
 *  - allowanceReservations one row per spend: reserved when an agent acts without asking, committed when
 *                          the work is done, released when it fails or is cancelled. Each moves once.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

import { levelValidator } from "../permissionCatalog";
import { agentValidator, literals } from "../statuses";

export const approverValidator = v.union(v.object({ kind: v.literal("owner") }), v.object({ kind: v.literal("member"), memberId: v.id("members") }));
export type Approver = typeof approverValidator.type;

/** One permission as it stood. Absent fields mean the catalog's starting value. */
export const permissionSnapshotValidator = v.object({
  action: v.string(),
  level: levelValidator,
  perActionCents: v.optional(v.number()),
  perDayCents: v.optional(v.number()),
  approver: v.optional(approverValidator),
  backupMemberId: v.optional(v.id("members")),
  until: v.optional(v.number()),
});
export type PermissionSnapshot = typeof permissionSnapshotValidator.type;

export const policySnapshotValidator = v.object({ paused: v.array(agentValidator), permissions: v.array(permissionSnapshotValidator) });
export type PolicySnapshot = typeof policySnapshotValidator.type;

export const CHANGE_KINDS = ["permission", "routing", "preset", "restore", "pause", "resume", "expired"] as const;

export const controlsTables = {
  controlChanges: defineTable({
    companyId: v.id("companies"),
    /** The policy revision this change produced. Revisions only go up. */
    revision: v.number(),
    kind: literals(CHANGE_KINDS),
    /** The actions it touched (empty for a pause of a whole agent). */
    actions: v.array(v.string()),
    agents: v.array(agentValidator),
    summary: v.string(),
    before: policySnapshotValidator,
    after: policySnapshotValidator,
    /** Who made it: a member, Selestial Support (its members row), or the system (an expired temporary level). */
    by: v.optional(v.id("members")),
    at: v.number(),
  })
    .index("by_company_revision", ["companyId", "revision"])
    .index("by_company_at", ["companyId", "at"]),

  allowanceDays: defineTable({
    companyId: v.id("companies"),
    action: v.string(),
    /** The company's local calendar day, YYYY-MM-DD in its time zone. */
    day: v.string(),
    committedCents: v.number(),
    reservedCents: v.number(),
    updatedAt: v.number(),
  }).index("by_company_action_day", ["companyId", "action", "day"]),

  allowanceReservations: defineTable({
    companyId: v.id("companies"),
    action: v.string(),
    day: v.string(),
    /** Names the one spend (for example retentionActions:<id>), so a retry finds it instead of reserving twice. */
    key: v.string(),
    amountCents: v.number(),
    state: literals(["reserved", "committed", "released"] as const),
    source: v.object({ table: v.string(), id: v.string() }),
    createdAt: v.number(),
    settledAt: v.optional(v.number()),
  })
    .index("by_company_key", ["companyId", "key"])
    .index("by_company_action_day", ["companyId", "action", "day"]),
};
