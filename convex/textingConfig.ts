/**
 * Versioned configuration of the texting setup's forms and requirements (docs/texting/02-case.md §3):
 * Draft → Preview → Validate → Publish → Retire, or roll back by publishing an earlier version again.
 *
 * Only staff admins change it. A version that changes requirements (rules, prerequisites, provider
 * requirements, ownership) must be published by a different admin from its author. Publishing reopens, on
 * unfinished setups only, exactly the steps that gained a requirement, and says why. Submitted setups keep
 * the version they were submitted under: nothing already submitted is reinterpreted.
 *
 * Prices and billing are not part of this configuration: they keep their own versioned rate cards and the
 * owner's recorded authorization.
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { staffMutation, staffQuery } from "./lib/builders";
import { notAllowed, notFound, userError } from "./lib/errors";
import { capabilitiesOf } from "./lib/support/catalog";
import { activeConfig, caseConfigProblems, syncRecommendations } from "./lib/texting/case";
import { BUILT_IN, PATTERN_PRESETS, parseConfig, reopenedSteps, TASKS, TEMPLATE_KEYS, type Config } from "./lib/texting/config";

const STEP_WORDS: Record<string, string> = { business: "Your business", activities: "What you'll send", permission: "Permission to text", number: "Your number", review: "Review & submit", progress: "Getting you ready" };

async function versionRow(ctx: QueryCtx, id: Doc<"textingConfigVersions">["_id"]) {
  const row = await ctx.db.get(id);
  if (!row) notFound();
  return row;
}

async function nextVersion(ctx: QueryCtx): Promise<number> {
  const last = await ctx.db.query("textingConfigVersions").withIndex("by_version").order("desc").first();
  return (last?.version ?? 0) + 1;
}

/** Setups whose answers can still change: no request, or one sent back to the owner. Submitted ones are left alone. */
async function unfinished(ctx: QueryCtx): Promise<Doc<"textingSetups">[]> {
  const setups = await ctx.db.query("textingSetups").take(2000);
  const out: Doc<"textingSetups">[] = [];
  for (const setup of setups) {
    const request = setup.requestId ? await ctx.db.get(setup.requestId) : null;
    if (!request || (["needs_you", "rejected", "cancelled"].includes(request.status) && request.needs?.kind !== "code")) out.push(setup);
  }
  return out;
}

async function affectedBy(ctx: QueryCtx, before: Config, after: Config) {
  const out: { setup: Doc<"textingSetups">; company: string; steps: { step: string; words: string }[] }[] = [];
  for (const setup of await unfinished(ctx)) {
    const steps = reopenedSteps(await caseConfigProblems(ctx, setup, before), await caseConfigProblems(ctx, setup, after));
    if (steps.length) out.push({ setup, company: (await ctx.db.get(setup.companyId))?.name ?? "A company", steps });
  }
  return out;
}

export const list = staffQuery({
  args: {},
  handler: async (ctx) => {
    if (!capabilitiesOf(ctx.staff).has("onboarding.evidence")) notAllowed();
    const rows = await ctx.db.query("textingConfigVersions").withIndex("by_version").order("desc").take(100);
    const active = await activeConfig(ctx);
    const names = new Map<string, string>();
    const nameOf = async (id: Doc<"staff">["_id"] | undefined) => {
      if (!id) return null;
      if (!names.has(id)) names.set(id, (await ctx.db.get(id))?.name ?? "Staff");
      return names.get(id)!;
    };
    return {
      active: active.version,
      canEdit: ctx.staff.role === "admin",
      me: ctx.staff._id,
      reference: { tasks: TASKS, templates: TEMPLATE_KEYS, presets: Object.keys(PATTERN_PRESETS), builtIn: JSON.stringify(BUILT_IN, null, 2) },
      versions: await Promise.all(rows.map(async (row) => ({ id: row._id, version: row.version, status: row.status, body: row.body, reason: row.reason, author: await nameOf(row.author), authorId: row.author, reviewer: await nameOf(row.reviewer), basedOn: row.basedOn ?? null, validation: row.validation ?? null, effectiveAt: row.effectiveAt ?? null, publishedAt: row.publishedAt ?? null, retiredAt: row.retiredAt ?? null, affected: row.affected ?? null, updatedAt: row.updatedAt }))),
    };
  },
});

/** Starts a draft: a copy of a version (or the configuration in force), with the reason for the change. */
export const createDraft = staffMutation({
  adminOnly: true,
  args: { reason: v.string(), basedOn: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const reason = args.reason.trim();
    if (reason.length < 10 || reason.length > 500) throw userError("Say why the configuration is changing (10 to 500 characters).");
    let body = JSON.stringify(BUILT_IN, null, 2);
    let basedOn: number | undefined;
    const source = args.basedOn !== undefined ? await ctx.db.query("textingConfigVersions").withIndex("by_version", (q) => q.eq("version", args.basedOn!)).first() : null;
    if (args.basedOn !== undefined && !source) throw userError("That version doesn't exist.");
    if (source) {
      body = source.body;
      basedOn = source.version;
    } else {
      const active = await activeConfig(ctx);
      if (active.version) {
        body = JSON.stringify(active.config, null, 2);
        basedOn = active.version;
      }
    }
    const now = Date.now();
    return ctx.db.insert("textingConfigVersions", { version: await nextVersion(ctx), status: "draft", body, reason, author: ctx.staff._id, basedOn, createdAt: now, updatedAt: now });
  },
});

export const editDraft = staffMutation({
  adminOnly: true,
  args: { versionId: v.id("textingConfigVersions"), body: v.string() },
  handler: async (ctx, args) => {
    const row = await versionRow(ctx, args.versionId);
    if (row.status !== "draft" && row.status !== "validated") throw userError("Only a draft can be edited. Start a new draft from this version instead.");
    if (args.body.length > 50_000) throw userError("The configuration is larger than 50,000 characters.");
    // Any edit needs validating again.
    await ctx.db.patch(row._id, { body: args.body, status: "draft", validation: undefined, updatedAt: Date.now() });
    return null;
  },
});

/** What publishing would do: problems in the draft, and which unfinished setups would have steps reopened. */
export const preview = staffQuery({
  args: { versionId: v.id("textingConfigVersions") },
  handler: async (ctx, args) => {
    if (!capabilitiesOf(ctx.staff).has("onboarding.evidence")) notAllowed();
    const row = await versionRow(ctx, args.versionId);
    const parsed = parseConfig(row.body);
    if (!parsed.config) return { ok: false as const, problems: parsed.problems, affected: [] };
    const active = await activeConfig(ctx);
    const affected = await affectedBy(ctx, active.config, parsed.config);
    return { ok: true as const, problems: [], needsReview: parsed.needsReview, against: active.version, affected: affected.slice(0, 200).map((row) => ({ company: row.company, setupId: row.setup._id, steps: row.steps.map((step) => ({ step: STEP_WORDS[step.step] ?? step.step, words: step.words })) })), affectedCount: affected.length };
  },
});

export const validate = staffMutation({
  adminOnly: true,
  args: { versionId: v.id("textingConfigVersions") },
  handler: async (ctx, args) => {
    const row = await versionRow(ctx, args.versionId);
    if (row.status !== "draft" && row.status !== "validated") throw userError("Only a draft can be validated.");
    const parsed = parseConfig(row.body);
    const ok = parsed.config !== null;
    await ctx.db.patch(row._id, { status: ok ? "validated" : "draft", validation: { ok, problems: parsed.problems.slice(0, 50), needsReview: parsed.needsReview, at: Date.now() }, updatedAt: Date.now() });
    return { ok, problems: parsed.problems };
  },
});

/** Reopens, on unfinished setups, the steps a configuration change added a requirement to, and says why. */
async function applyChange(ctx: MutationCtx, before: Config, after: Config, version: number): Promise<number> {
  const affected = await affectedBy(ctx, before, after);
  const now = Date.now();
  for (const { setup, steps } of affected) {
    const reopened = [...(setup.reopened ?? []).filter((row) => !steps.some((step) => step.step === row.step)), ...steps.map((step) => ({ step: step.step as Doc<"textingSetups">["step"], words: step.words, configVersion: version, at: now }))];
    const notes = [...setup.notes, ...steps.map((step, i) => ({ key: `config-${version}-${i}`, step: step.step as Doc<"textingSetups">["step"], words: `Selestial's registration requirements changed, so I reopened ${STEP_WORDS[step.step] ?? step.step}: ${step.words} Everything else you filled in is unchanged.`, at: now }))].slice(-40);
    await ctx.db.patch(setup._id, { reopened, notes, configVersion: version });
    await syncRecommendations(ctx, setup._id);
  }
  return affected.length;
}

/** Publishes a validated version now. A change to requirements needs a second admin. */
export const publish = staffMutation({
  adminOnly: true,
  args: { versionId: v.id("textingConfigVersions") },
  handler: async (ctx, args) => {
    const row = await versionRow(ctx, args.versionId);
    if (row.status !== "validated") throw userError("Validate the draft before publishing it.");
    const parsed = parseConfig(row.body);
    if (!parsed.config) throw userError(parsed.problems[0] ?? "The configuration has problems.");
    if (parsed.needsReview && row.author === ctx.staff._id) throw userError("This version changes requirements, so another admin must review and publish it.");
    const before = await activeConfig(ctx);
    const now = Date.now();
    await ctx.db.patch(row._id, { status: "published", reviewer: row.author === ctx.staff._id ? undefined : ctx.staff._id, effectiveAt: now, publishedAt: now, updatedAt: now });
    const affected = await applyChange(ctx, before.config, parsed.config, row.version);
    await ctx.db.patch(row._id, { affected });
    return { affected };
  },
});

/** Retires a published version: the one before it (or the built-in configuration) is in force again. */
export const retire = staffMutation({
  adminOnly: true,
  args: { versionId: v.id("textingConfigVersions") },
  handler: async (ctx, args) => {
    const row = await versionRow(ctx, args.versionId);
    if (row.status !== "published") throw userError("Only a published version can be retired.");
    const before = await activeConfig(ctx);
    const now = Date.now();
    await ctx.db.patch(row._id, { status: "retired", retiredAt: now, updatedAt: now });
    const after = await activeConfig(ctx);
    if (after.version !== before.version) await applyChange(ctx, before.config, after.config, after.version);
    return { active: after.version };
  },
});

/** Rolls back by copying an earlier version into a new, validated version. It is published like any other. */
export const rollback = staffMutation({
  adminOnly: true,
  args: { toVersion: v.number(), reason: v.string() },
  handler: async (ctx, args) => {
    const reason = args.reason.trim();
    if (reason.length < 10) throw userError("Say why you're rolling back (at least 10 characters).");
    const source = await ctx.db.query("textingConfigVersions").withIndex("by_version", (q) => q.eq("version", args.toVersion)).first();
    if (!source) throw userError("That version doesn't exist.");
    const parsed = parseConfig(source.body);
    if (!parsed.config) throw userError("That version no longer passes validation, so it can't be restored as it is.");
    const now = Date.now();
    return ctx.db.insert("textingConfigVersions", { version: await nextVersion(ctx), status: "validated", body: source.body, reason: `Rollback to version ${source.version}: ${reason.slice(0, 450)}`, author: ctx.staff._id, basedOn: source.version, validation: { ok: true, problems: [], needsReview: parsed.needsReview, at: now }, createdAt: now, updatedAt: now });
  },
});
