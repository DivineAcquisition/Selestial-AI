/**
 * Authority settings (brief, section 7; docs/foundation/07-agent-controls.md). Only the Owner changes them.
 * Agent Controls and every agent's playbook edit these same rows through these same functions.
 *
 * Every change goes through convex/lib/controls/policy.ts: validated against the catalog and what the code
 * can do, applied in one transaction against the revision the owner saw, and recorded with the whole policy
 * before and after. A level can never go past the action's ceiling, something the code cannot do can never
 * be switched on, and the things that always need a person are not settings at all.
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { companyQuery, managerQuery, ownerMutation, ownerQuery } from "./lib/builders";
import { notFound, userError } from "./lib/errors";
import { byMember } from "./lib/events";
import { capabilityOf } from "./lib/controls/capabilities";
import { applyPolicy, LEVEL_WORDS, policyOf, refusal, revisionOf, STALE } from "./lib/controls/policy";
import { approversFor, effective, factsFor, OWNER_DECIDES } from "./lib/controls/readiness";
import { approverValidator, type PermissionSnapshot, type PolicySnapshot } from "./lib/controls/schema";
import { ACTIONS, actionDef, levelValidator, PERSON_ONLY, rank, type ActionDef, type Level } from "./lib/permissionCatalog";
import { roleOf } from "./lib/roles";
import { cents } from "./lib/text";

export const list = companyQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const policy = await policyOf(ctx, ctx.company);
    const facts = await factsFor(ctx, ctx.company, now);
    const members = await ctx.db
      .query("members")
      .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
      .collect();
    const stored = new Set(
      (
        await ctx.db
          .query("permissions")
          .withIndex("by_company_action", (q) => q.eq("companyId", ctx.companyId))
          .collect()
      ).map((row) => row.action),
    );
    const actions = [];
    for (const def of ACTIONS) {
      const snap = policy.permissions.find((row) => row.action === def.key)!;
      const capability = capabilityOf(def.key);
      const status = await effective(ctx, def, snap, facts);
      actions.push({
        key: def.key,
        agent: def.agent,
        label: def.label,
        level: snap.level,
        changed: stored.has(def.key),
        standard: def.standard,
        ceiling: def.ceiling,
        money: def.money,
        perActionCents: snap.perActionCents ?? null,
        perDayCents: snap.perDayCents ?? null,
        until: snap.until ?? null,
        implemented: capability.implemented,
        unavailable: capability.unavailable ?? null,
        note: capability.note ?? null,
        measures: capability.measures ?? null,
        status: { status: status.status, words: status.words, reason: status.reason, next: status.next, expired: status.expired },
        allowance: status.allowance,
        approvers: await approversFor(ctx, ctx.company, snap, members),
        ownerDecides: OWNER_DECIDES.has(def.key),
      });
    }
    return { revision: revisionOf(ctx.company), pausedAgents: ctx.company.pausedAgents, actions, personOnly: PERSON_ONLY };
  },
});

function snapshotFor(policy: PolicySnapshot, key: string): PermissionSnapshot {
  return policy.permissions.find((row) => row.action === key)!;
}

/**
 * One action's level and limits. Omitted limits keep what is stored; `null` clears them. `until` makes a
 * level above Ask me first temporary. `expectedRevision`, when given, refuses a change made against an older
 * view of the settings.
 */
export const set = ownerMutation({
  args: {
    action: v.string(),
    level: levelValidator,
    perActionCents: v.optional(v.union(v.number(), v.null())),
    perDayCents: v.optional(v.union(v.number(), v.null())),
    until: v.optional(v.union(v.number(), v.null())),
    expectedRevision: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (PERSON_ONLY.some((entry) => entry.key === args.action)) throw userError("This always needs a person. It cannot be handed to an agent.");
    const def = actionDef(args.action);
    if (!def) throw userError("That is not an action an agent can take.");
    const policy = await policyOf(ctx, ctx.company);
    const current = snapshotFor(policy, def.key);
    const pick = (given: number | null | undefined, kept: number | undefined, label: string) => (given === null ? undefined : given === undefined ? kept : cents(given, label));
    const perActionCents = pick(args.perActionCents, current.perActionCents, "The limit per action");
    const perDayCents = pick(args.perDayCents, current.perDayCents, "The limit per day");
    // A temporary level is only for a level above Ask me first; choosing Ask me first or Off ends it.
    const until = args.until === null || rank(args.level) <= rank("propose") ? undefined : (args.until ?? current.until);
    const next: PermissionSnapshot = { ...current, level: args.level, perActionCents, perDayCents, until };
    if (perActionCents === undefined) delete next.perActionCents;
    if (perDayCents === undefined) delete next.perDayCents;
    if (until === undefined) delete next.until;
    const why = refusal(def, next, Date.now());
    if (why) throw userError(why);
    await applyPolicy(ctx, ctx.company, { kind: "permission", summary: `${def.label}: ${LEVEL_WORDS[current.level]} → ${LEVEL_WORDS[args.level]}`, permissions: [next], expectedRevision: args.expectedRevision, by: ctx.member._id, actor: byMember(ctx) });
    return null;
  },
});

/**
 * Who decides one action's approvals. Absent approver: any Owner or Manager (the default). "owner": Owners
 * only. A member: that Owner or Manager, an optional backup, and always any Owner. It can never let anyone
 * decide what only an Owner decides, and never lets an Office member decide.
 */
export const setRouting = ownerMutation({
  args: { action: v.string(), approver: v.union(approverValidator, v.null()), backupMemberId: v.optional(v.union(v.id("members"), v.null())), expectedRevision: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const def = actionDef(args.action);
    if (!def) throw userError("That is not an action an agent can take.");
    if (OWNER_DECIDES.has(def.key) && args.approver?.kind !== "owner" && args.approver !== null) throw userError("Only an Owner decides this action. That can't be changed.");
    const eligible = async (id: Doc<"members">["_id"] | null | undefined) => {
      if (!id) return;
      const member = await ctx.db.get(id);
      if (!member || member.companyId !== ctx.companyId || member.status !== "active" || !["owner", "manager"].includes(roleOf(member.role))) throw userError("Choose an active Owner or Manager.");
    };
    if (args.approver?.kind === "member") await eligible(args.approver.memberId);
    await eligible(args.backupMemberId);
    if (args.backupMemberId && args.approver?.kind !== "member") throw userError("A backup only applies when one person is chosen to decide.");
    const policy = await policyOf(ctx, ctx.company);
    const current = snapshotFor(policy, def.key);
    const next: PermissionSnapshot = { ...current };
    if (args.approver) next.approver = args.approver;
    else delete next.approver;
    if (args.backupMemberId && args.approver?.kind === "member") next.backupMemberId = args.backupMemberId;
    else delete next.backupMemberId;
    await applyPolicy(ctx, ctx.company, { kind: "routing", summary: `${def.label}: who decides changed`, permissions: [next], expectedRevision: args.expectedRevision, by: ctx.member._id, actor: byMember(ctx) });
    return null;
  },
});

// ── Presets ──────────────────────────────────────────────────────────────────────────────────────

export type Preset = "review_first" | "routine";
const presetValidator = v.union(v.literal("review_first"), v.literal("routine"));

/** What a preset would set each action to, and why anything it touches is left as it is. Pure: it reads the policy only. */
function presetPlan(preset: Preset, policy: PolicySnapshot, now: number) {
  const changes: { action: string; label: string; agent: string; from: Level; to: Level }[] = [];
  const kept: { action: string; label: string; agent: string; level: Level; why: string }[] = [];
  const next: PermissionSnapshot[] = [];
  for (const def of ACTIONS) {
    const snap = snapshotFor(policy, def.key);
    const capability = capabilityOf(def.key);
    let to = snap.level;
    let why: string | null = null;
    if (preset === "review_first") {
      if (def.outsider && rank(snap.level) > rank("propose")) to = "propose";
    } else if (capability.routine) {
      const target: Level = rank(def.standard) > rank(def.ceiling) ? def.ceiling : def.standard;
      if (!capability.implemented) why = capability.unavailable ?? "Not something the agent can do.";
      else if (snap.level === "off") why = "You switched this off. Turn it on by itself if you want it.";
      else if (def.money) why = "Money is never delegated by a preset. Set its limits and level by itself.";
      else if (rank(snap.level) < rank(target)) {
        const refused = refusal(def, { level: target, perActionCents: snap.perActionCents, perDayCents: snap.perDayCents }, now);
        if (refused) why = refused;
        else to = target;
      }
    }
    if (why) kept.push({ action: def.key, label: def.label, agent: def.agent, level: snap.level, why });
    if (to !== snap.level) {
      changes.push({ action: def.key, label: def.label, agent: def.agent, from: snap.level, to });
      const changed: PermissionSnapshot = { ...snap, level: to };
      if (rank(to) <= rank("propose")) delete changed.until;
      next.push(changed);
    }
  }
  return { changes, kept, next };
}

/** Which preset the settings match now, or "custom". */
export function presetOf(policy: PolicySnapshot, now: number): Preset | "custom" {
  if (presetPlan("review_first", policy, now).changes.length === 0 && ACTIONS.every((def) => !def.outsider || rank(snapshotFor(policy, def.key).level) <= rank("propose"))) {
    // Every outside-facing action asks first: that is Review first, unless routine work is also delegated.
    const routineDelegated = ACTIONS.some((def) => capabilityOf(def.key).routine && rank(snapshotFor(policy, def.key).level) > rank("propose"));
    if (!routineDelegated) return "review_first";
  }
  const routine = presetPlan("routine", policy, now);
  const routineMatches = routine.changes.length === 0 && ACTIONS.every((def) => capabilityOf(def.key).routine || !def.outsider || rank(snapshotFor(policy, def.key).level) <= rank("propose"));
  return routineMatches ? "routine" : "custom";
}

export const presetPreview = ownerQuery({
  args: { preset: presetValidator },
  handler: async (ctx, args) => {
    const policy = await policyOf(ctx, ctx.company);
    const plan = presetPlan(args.preset, policy, Date.now());
    return { revision: revisionOf(ctx.company), current: presetOf(policy, Date.now()), changes: plan.changes, kept: plan.kept, unchanged: "Approvals already waiting stay waiting. Money limits, who decides, pauses and what always needs a person are not changed by a preset." };
  },
});

export const applyPreset = ownerMutation({
  args: { preset: presetValidator, expectedRevision: v.number() },
  handler: async (ctx, args) => {
    if (args.expectedRevision !== revisionOf(ctx.company)) throw userError(STALE);
    const policy = await policyOf(ctx, ctx.company);
    const plan = presetPlan(args.preset, policy, Date.now());
    const result = await applyPolicy(ctx, ctx.company, { kind: "preset", summary: args.preset === "review_first" ? "Applied Review first" : "Applied Routine work delegated", permissions: plan.next, expectedRevision: args.expectedRevision, by: ctx.member._id, actor: byMember(ctx) });
    return { changed: result.actions.length, revision: result.revision };
  },
});

// ── Consequences of a change, before it is made ─────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

async function eligibleWork(ctx: QueryCtx, company: Doc<"companies">, def: ActionDef): Promise<{ words: string; count: number; examples: { label: string; href: string }[] }[]> {
  const now = Date.now();
  const out: { words: string; count: number; examples: { label: string; href: string }[] }[] = [];
  if (def.key === "dispatch.request_acceptance" || def.key === "dispatch.send_replacement_offer" || def.key === "dispatch.run_backup_coverage") {
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_company_start", (q) => q.eq("companyId", company._id).gte("startsAt", now).lt("startsAt", now + 7 * DAY))
      .take(500);
    const uncovered = [];
    for (const job of jobs) {
      if (job.status !== "scheduled") continue;
      const accepted = await ctx.db
        .query("assignments")
        .withIndex("by_company_job", (q) => q.eq("companyId", company._id).eq("jobId", job._id))
        .take(20);
      if (!accepted.some((a) => a.status === "accepted" || a.status === "offered")) uncovered.push(job);
    }
    out.push({ words: "Visits in the next 7 days with no cleaner and no open offer. Dispatch looks at these on its next pass.", count: uncovered.length, examples: uncovered.slice(0, 3).map((job) => ({ label: new Date(job.startsAt).toISOString().slice(0, 16).replace("T", " "), href: `/app/schedule?open=job:${job._id}` })) });
  }
  if (def.key === "sales.follow_up") {
    const due = await ctx.db
      .query("salesFollowUps")
      .withIndex("by_company_status_due", (q) => q.eq("companyId", company._id).eq("status", "scheduled"))
      .take(500);
    out.push({ words: "Follow-ups already scheduled. Each is checked again when it is due (the customer replied, a person took over, quiet hours).", count: due.length, examples: [] });
  }
  if (def.agent === "retention") {
    const prepared = await ctx.db
      .query("retentionActions")
      .withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", "proposed"))
      .take(500);
    const mine = prepared.filter((row) => row.permission === def.key);
    if (mine.length) out.push({ words: "Prepared steps not yet sent. They are routed again by the new level only when Retention next submits them.", count: mine.length, examples: [] });
  }
  return out;
}

/**
 * What raising (or lowering) one action would change, from the real records: the new effective status,
 * the limits and conditions, the work that may become eligible, what stays blocked, and how waiting
 * approvals and drafts are treated. Applying it is `set` with the revision returned here.
 */
export const previewChange = ownerQuery({
  args: { action: v.string(), level: levelValidator, perActionCents: v.optional(v.number()), perDayCents: v.optional(v.number()), until: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const def = actionDef(args.action);
    if (!def) notFound();
    const now = Date.now();
    const policy = await policyOf(ctx, ctx.company);
    const current = snapshotFor(policy, def.key);
    const next: PermissionSnapshot = { ...current, level: args.level, ...(args.perActionCents !== undefined ? { perActionCents: args.perActionCents } : {}), ...(args.perDayCents !== undefined ? { perDayCents: args.perDayCents } : {}), ...(args.until !== undefined ? { until: args.until } : {}) };
    const refused = refusal(def, next, now);
    const facts = await factsFor(ctx, ctx.company, now);
    const after = await effective(ctx, def, next, facts);
    const pending = (
      await ctx.db
        .query("approvals")
        .withIndex("by_company_status_decideBy", (q) => q.eq("companyId", ctx.companyId).eq("status", "pending"))
        .collect()
    ).filter((row) => row.action === def.key);
    const raising = rank(args.level) > rank(current.level);
    return {
      revision: revisionOf(ctx.company),
      action: def.label,
      from: LEVEL_WORDS[current.level],
      to: LEVEL_WORDS[args.level],
      raising,
      refused,
      enabling: raising ? (args.level === "propose" ? `The agent will prepare "${def.label.toLowerCase()}" and ask before doing it.` : `The agent will ${def.label.charAt(0).toLowerCase()}${def.label.slice(1)} without asking${args.level === "execute_and_report" ? ", and tell you each time" : ""}.`) : null,
      conditions: [
        ...(def.money && next.perActionCents !== undefined && next.perDayCents !== undefined ? [`At most ${(next.perActionCents / 100).toFixed(2)} dollars each and ${(next.perDayCents / 100).toFixed(2)} dollars a day (your local day, resetting at midnight). Anything over goes to approval.`] : []),
        ...(next.until !== undefined && rank(args.level) > rank("propose") ? [`Until ${new Date(next.until).toISOString().slice(0, 16).replace("T", " ")} UTC, then back to Ask me first.`] : []),
        ...(capabilityOf(def.key).note ? [capabilityOf(def.key).note!] : []),
      ],
      after: { status: after.status, words: after.words, reason: after.reason, next: after.next },
      blocked: after.checks.filter((check) => !check.ok).map((check) => check.words),
      eligible: raising ? await eligibleWork(ctx, ctx.company, def) : [],
      pending: {
        count: pending.length,
        words: pending.length ? `${pending.length} ${pending.length === 1 ? "approval is" : "approvals are"} waiting for this. ${raising ? "They stay waiting: a higher level never approves anything already asked." : "They stay waiting for a decision."}` : "Nothing is waiting for approval for this.",
        examples: pending.slice(0, 3).map((row) => ({ label: row.summary.slice(0, 120), href: `/app/approvals?open=approval:${row._id}` })),
      },
      drafts: "Drafts stay drafts until someone sends them. Work the agent prepares after the change follows the new level, and every action is checked again when it runs.",
    };
  },
});

// ── History and restore ──────────────────────────────────────────────────────────────────────────

export const changes = managerQuery({
  args: { action: v.optional(v.string()), limit: v.optional(v.number()), before: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
    const q = ctx.db
      .query("controlChanges")
      .withIndex("by_company_revision", (r) => (args.before !== undefined ? r.eq("companyId", ctx.companyId).lt("revision", args.before) : r.eq("companyId", ctx.companyId)))
      .order("desc");
    const out = [];
    for await (const row of q) {
      if (args.action && !row.actions.includes(args.action)) continue;
      const by = row.by ? await ctx.db.get(row.by) : null;
      out.push({ id: row._id, revision: row.revision, kind: row.kind, summary: row.summary, actions: row.actions, agents: row.agents, at: row.at, by: by ? (by.status === "support" ? "Selestial Support" : by.name) : "Selestial" });
      if (out.length >= limit) break;
    }
    return { revision: revisionOf(ctx.company), rows: out };
  },
});

/** The settings as they were before one change, compared with now: what restoring would set, and what can no longer be restored and why. */
async function restorePlan(ctx: QueryCtx, company: Doc<"companies">, revision: number) {
  const change = await ctx.db
    .query("controlChanges")
    .withIndex("by_company_revision", (q) => q.eq("companyId", company._id).eq("revision", revision))
    .unique();
  if (!change) notFound();
  const now = Date.now();
  const policy = await policyOf(ctx, company);
  const target = change.before;
  const changes: { action: string; label: string; from: string; to: string }[] = [];
  const refusedRows: { action: string; label: string; why: string }[] = [];
  const next: PermissionSnapshot[] = [];
  for (const def of ACTIONS) {
    const want = target.permissions.find((row) => row.action === def.key);
    const have = snapshotFor(policy, def.key);
    if (!want || JSON.stringify(want) === JSON.stringify(have)) continue;
    // A temporary level that has already ended is restored as Ask me first.
    const restored: PermissionSnapshot = want.until !== undefined && want.until <= now && rank(want.level) > rank("propose") ? { ...want, level: "propose", until: undefined } : want;
    if (restored.until === undefined) delete restored.until;
    const why = refusal(def, restored, now);
    if (why) {
      refusedRows.push({ action: def.key, label: def.label, why });
      continue;
    }
    changes.push({ action: def.key, label: def.label, from: describe(have), to: describe(restored) });
    next.push(restored);
  }
  return { change, changes, refused: refusedRows, next };
}

function describe(snap: PermissionSnapshot): string {
  const limits = snap.perActionCents !== undefined && snap.perDayCents !== undefined ? ` (limits ${(snap.perActionCents / 100).toFixed(2)} / ${(snap.perDayCents / 100).toFixed(2)} a day)` : "";
  const who = snap.approver ? (snap.approver.kind === "owner" ? ", Owners decide" : ", one person decides") : "";
  return `${LEVEL_WORDS[snap.level]}${limits}${who}`;
}

export const restorePreview = ownerQuery({
  args: { revision: v.number() },
  handler: async (ctx, args) => {
    const plan = await restorePlan(ctx, ctx.company, args.revision);
    return {
      revision: revisionOf(ctx.company),
      restoring: `The settings as they were before: ${plan.change.summary}`,
      changes: plan.changes,
      refused: plan.refused,
      notes: ["Restoring changes settings only. It does not undo anything an agent already did.", "Pauses are not restored: pause or resume an agent by itself.", "Approvals already waiting stay waiting."],
    };
  },
});

export const restore = ownerMutation({
  args: { revision: v.number(), expectedRevision: v.number() },
  handler: async (ctx, args) => {
    if (args.expectedRevision !== revisionOf(ctx.company)) throw userError(STALE);
    const plan = await restorePlan(ctx, ctx.company, args.revision);
    const result = await applyPolicy(ctx, ctx.company, { kind: "restore", summary: `Restored the settings from before revision ${args.revision}`, permissions: plan.next, expectedRevision: args.expectedRevision, by: ctx.member._id, actor: byMember(ctx) });
    return { changed: result.actions.length, refused: plan.refused.length, revision: result.revision };
  },
});
