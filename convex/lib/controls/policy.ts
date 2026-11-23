/**
 * The agent policy as one versioned thing (docs/foundation/07-agent-controls.md §Changes).
 *
 * The settings stay in `permissions` and `companies.pausedAgents`, the same rows the playbooks edit and
 * execution reads. Every change goes through here: it is validated against the catalog and what the code
 * can do, applied in one transaction, given the next revision, recorded with the whole policy before and
 * after (controlChanges), and logged as events with the exact old and new values. A change made against
 * an older revision than the company's is refused, so two owners or two tabs never overwrite each other.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { userError } from "../errors";
import { recordEvent, type Actor } from "../events";
import { ACTIONS, actionDef, initialLevel, PERSON_ONLY, rank, type ActionDef, type Level } from "../permissionCatalog";
import type { Agent } from "../statuses";
import { capabilityOf } from "./capabilities";
import { CHANGE_KINDS, type Approver, type PermissionSnapshot, type PolicySnapshot } from "./schema";

type Ctx = QueryCtx | MutationCtx;

export const STALE = "These settings changed since you opened them. Review the current settings and try again.";

export function revisionOf(company: Pick<Doc<"companies">, "controlsRevision">): number {
  return company.controlsRevision ?? 0;
}

export async function permissionRows(ctx: Ctx, companyId: Id<"companies">): Promise<Map<string, Doc<"permissions">>> {
  const rows = await ctx.db
    .query("permissions")
    .withIndex("by_company_action", (q) => q.eq("companyId", companyId))
    .collect();
  return new Map(rows.map((row) => [row.action, row]));
}

export function snapshotOf(def: ActionDef, row: Doc<"permissions"> | undefined): PermissionSnapshot {
  return {
    action: def.key,
    level: row?.level ?? initialLevel(def),
    ...(row?.perActionCents !== undefined ? { perActionCents: row.perActionCents } : {}),
    ...(row?.perDayCents !== undefined ? { perDayCents: row.perDayCents } : {}),
    ...(row?.approver ? { approver: row.approver } : {}),
    ...(row?.backupMemberId ? { backupMemberId: row.backupMemberId } : {}),
    ...(row?.until !== undefined ? { until: row.until } : {}),
  };
}

/** The whole policy as it stands: every catalog action (stored or starting value) and the paused agents. */
export async function policyOf(ctx: Ctx, company: Doc<"companies">): Promise<PolicySnapshot> {
  const rows = await permissionRows(ctx, company._id);
  return { paused: [...company.pausedAgents], permissions: ACTIONS.map((def) => snapshotOf(def, rows.get(def.key))) };
}

export type PermissionInput = { level: Level; perActionCents?: number; perDayCents?: number; until?: number | null; approver?: Approver | null; backupMemberId?: Id<"members"> | null };

/**
 * Why this setting cannot be saved, or null. The same rules for a single change, a preset and a restore:
 * nothing past the ceiling, nothing above Off for what the code cannot do, no money without both limits.
 */
export function refusal(def: ActionDef, input: Pick<PermissionInput, "level" | "perActionCents" | "perDayCents" | "until">, now: number): string | null {
  if (PERSON_ONLY.some((entry) => entry.key === def.key)) return "This always needs a person. It cannot be handed to an agent.";
  const capability = capabilityOf(def.key);
  if (!capability.implemented && input.level !== "off") return capability.unavailable ?? "This isn't something an agent can do yet.";
  if (rank(input.level) > rank(def.ceiling)) return def.ceiling === "propose" ? "This action needs a person's approval every time, so it can't be set above Ask me first." : `This action can't be set above ${LEVEL_WORDS[def.ceiling]}.`;
  const hasLimits = input.perActionCents !== undefined || input.perDayCents !== undefined;
  if (hasLimits && !def.money) return "Limits apply only to actions that move money.";
  if (input.perActionCents !== undefined && input.perDayCents !== undefined && input.perActionCents > input.perDayCents) return "The limit per action cannot be more than the limit per day.";
  if (def.money && rank(input.level) > rank("propose") && (input.perActionCents === undefined || input.perDayCents === undefined)) return "Set a limit per action and per day before letting an agent do this without approval.";
  if (input.until !== undefined && input.until !== null) {
    if (rank(input.level) <= rank("propose")) return "Only a level above Ask me first can be temporary.";
    if (input.until <= now) return "Choose an end time in the future.";
  }
  return null;
}

export const LEVEL_WORDS: Record<Level, string> = { off: "Off", propose: "Ask me first", execute_and_report: "Act and notify me", execute: "Act automatically" };

/** Writes one permission row from a snapshot (or input), creating it if needed. */
export async function writePermission(ctx: MutationCtx, companyId: Id<"companies">, def: ActionDef, snap: PermissionSnapshot, by: Id<"members">, existing: Doc<"permissions"> | undefined) {
  const fields = {
    level: snap.level,
    perActionCents: snap.perActionCents,
    perDayCents: snap.perDayCents,
    approver: snap.approver,
    backupMemberId: snap.backupMemberId,
    until: snap.until,
    updatedBy: by,
    updatedAt: Date.now(),
  };
  if (existing) await ctx.db.patch(existing._id, fields);
  else await ctx.db.insert("permissions", { companyId, action: def.key, ...fields });
}

const same = (a: PermissionSnapshot, b: PermissionSnapshot) => JSON.stringify(a) === JSON.stringify(b);

export function changedActions(before: PolicySnapshot, after: PolicySnapshot): string[] {
  const old = new Map(before.permissions.map((row) => [row.action, row]));
  return after.permissions.filter((row) => !old.get(row.action) || !same(old.get(row.action)!, row)).map((row) => row.action);
}

/**
 * Applies a set of permission snapshots and a paused list as one change: validated, written, recorded.
 * Refuses the whole change if any part is refused, or if `expectedRevision` is not the current one.
 */
export async function applyPolicy(
  ctx: MutationCtx,
  company: Doc<"companies">,
  input: {
    kind: (typeof CHANGE_KINDS)[number];
    summary: string;
    permissions?: PermissionSnapshot[];
    paused?: Agent[];
    expectedRevision?: number;
    by?: Id<"members">;
    actor: Actor;
  },
): Promise<{ revision: number; actions: string[] }> {
  if (input.expectedRevision !== undefined && input.expectedRevision !== revisionOf(company)) throw userError(STALE, "invalid");
  const now = Date.now();
  const before = await policyOf(ctx, company);
  const rows = await permissionRows(ctx, company._id);
  for (const snap of input.permissions ?? []) {
    const def = actionDef(snap.action);
    if (!def) throw userError("That is not an action an agent can take.");
    const current = before.permissions.find((row) => row.action === snap.action)!;
    if (same(current, snap)) continue;
    // A setting being turned down or kept as it is never needs re-validating against rules it already met.
    const raising = rank(snap.level) > rank(current.level) || snap.perActionCents !== current.perActionCents || snap.perDayCents !== current.perDayCents || (snap.until ?? null) !== (current.until ?? null);
    const why = raising || snap.level !== "off" ? refusal(def, snap, now) : null;
    if (why) throw userError(`${def.label}: ${why}`);
    await writePermission(ctx, company._id, def, snap, input.by ?? (rows.get(def.key)?.updatedBy as Id<"members">), rows.get(def.key));
  }
  if (input.paused) await ctx.db.patch(company._id, { pausedAgents: [...new Set(input.paused)] });
  const fresh = (await ctx.db.get(company._id))!;
  const after = await policyOf(ctx, fresh);
  const actions = changedActions(before, after);
  const pausedChanged = before.paused.join(",") !== after.paused.join(",");
  if (!actions.length && !pausedChanged) return { revision: revisionOf(company), actions: [] };
  const revision = revisionOf(company) + 1;
  await ctx.db.patch(company._id, { controlsRevision: revision });
  const agents = [...new Set([...actions.map((key) => actionDef(key)!.agent), ...[...before.paused, ...after.paused].filter((a) => before.paused.includes(a) !== after.paused.includes(a))])] as Agent[];
  await ctx.db.insert("controlChanges", { companyId: company._id, revision, kind: input.kind, actions, agents, summary: input.summary.slice(0, 300), before, after, ...(input.by ? { by: input.by } : {}), at: now });
  // Each permission's own event keeps the exact old and new values, limits included.
  for (const key of actions) {
    const from = before.permissions.find((row) => row.action === key)!;
    const to = after.permissions.find((row) => row.action === key)!;
    const id = (await ctx.db
      .query("permissions")
      .withIndex("by_company_action", (q) => q.eq("companyId", company._id).eq("action", key))
      .unique())!._id;
    await recordEvent(ctx, {
      companyId: company._id,
      type: "permission.changed",
      actor: input.actor,
      subject: { table: "permissions", id },
      data: {
        action: key,
        from: from.level,
        to: to.level,
        fromPerActionCents: from.perActionCents ?? null,
        toPerActionCents: to.perActionCents ?? null,
        fromPerDayCents: from.perDayCents ?? null,
        toPerDayCents: to.perDayCents ?? null,
        fromUntil: from.until ?? null,
        toUntil: to.until ?? null,
        approver: to.approver ? (to.approver.kind === "owner" ? "owner" : `member:${to.approver.memberId}`) : "owners_and_managers",
        revision,
        change: input.kind,
      },
    });
  }
  if (pausedChanged) {
    await recordEvent(ctx, { companyId: company._id, type: "company.agents_paused_changed", actor: input.actor, subject: { table: "companies", id: company._id }, data: { paused: after.paused.join(","), before: before.paused.join(","), revision } });
  }
  return { revision, actions };
}
