/**
 * Company setup: the owner's guided start. It keeps where they are and what they chose; what it learns
 * about the company goes to the record that owns it (lib/setup/schema.ts), so nothing here goes stale.
 *
 * Only an Owner changes setup. Managers and Office staff can read the company's context, and are never
 * sent through setup. A company made before setup existed has no setup row and is never forced into one.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { isTimezone } from "./lib/availability";
import { companyQuery, ownerMutation } from "./lib/builders";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { isOwner } from "./lib/roles";
import { CATEGORY_CHOICES, FACTS, factsOf, isFactKey, stateFact } from "./lib/setup/facts";
import { checkedNeed } from "./hiringNeeds";
import { allowedQuestions, contextFor, isKnownStep, KEPT_ANSWERS, normalizeStep, progress, stepsFor, unanswered, type Known } from "./lib/setup/path";
import { buildPlan, buildSentence, fromCard, fromTask, leadHeadline, ordered, summarize, type BuildItem } from "./lib/setup/build";
import { safeSetupPath, setupDestination } from "./lib/setup/routes";
import { snapshotOf } from "./lib/activation/snapshot";
import { planFor, type Snapshot } from "./lib/activation/plan";
import { retryTask, startActivation } from "./activation";
import { cardsOf, queueForSetup, requeueChanged, requeueKind } from "./configure";
import { outputKindValidator } from "./lib/configure/schema";
import { servicesToPrepare } from "./lib/configure/catalog";
import { draftOf, normalizeSpec } from "./lib/services/store";
import type { Priority } from "./lib/setup/schema";
import { agentReadiness } from "./lib/setup/readiness";
import { agentMessagesSince, firstDecisionAt, firstWork as firstWorkOf } from "./lib/setup/firstWork";
import { factValueValidator, methodValidator, priorityValidator } from "./lib/setup/schema";
import { businessSettingsOf } from "./lib/settings/business";
import { text } from "./lib/text";
import { createExperience } from "./bookingExperiences";
import { createAgreement } from "./lib/agreements/store";
import { experienceKindValidator } from "./lib/booking/definition";
import { createDraft, writeDraft } from "./lib/services/workflow";
import { wakeActivation } from "./lib/activation/wake";
import { TEMPLATES } from "./lib/services/templates";

const STALE = "Your setup was changed somewhere else, on another tab or device. Nothing was lost: load the latest, then check it and continue.";

export async function setupOf(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">): Promise<Doc<"companySetups"> | null> {
  return ctx.db
    .query("companySetups")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .first();
}

/** Starts setup for a company. Called once when the company is created; asking again finds the same row. */
export async function startSetup(ctx: MutationCtx, companyId: Id<"companies">): Promise<Id<"companySetups">> {
  const existing = await setupOf(ctx, companyId);
  if (existing) return existing._id;
  const now = Date.now();
  return ctx.db.insert("companySetups", { companyId, status: "in_progress", step: "outcome", methods: [], secondary: [], answers: {}, skipped: [], revision: 0, milestones: { startedAt: now }, updatedAt: now });
}

/** What the company already has that answers setup's questions: earlier answers, confirmed facts and records. */
export async function knownOf(ctx: QueryCtx | MutationCtx, company: Doc<"companies">, setup: Doc<"companySetups"> | null): Promise<{ known: Known; snapshot: Snapshot }> {
  const snapshot = await snapshotOf(ctx, company, Date.now());
  const facts: Known["facts"] = {};
  for (const row of await factsOf(ctx, company._id)) if (row.state === "confirmed" && isFactKey(row.key)) facts[row.key] = row.value;
  return {
    snapshot,
    known: {
      answers: setup?.answers ?? {},
      facts,
      records: {
        upcomingJobs: snapshot.dispatch.upcomingJobs,
        readyCleaners: snapshot.dispatch.readyCleaners,
        customers: snapshot.retention.customers,
        completedJobs: snapshot.retention.completedJobs,
        activeServices: snapshot.sales.activeServices,
        openInquiries: snapshot.sales.openInquiries,
        hiringInbox: snapshot.recruiter.inbox,
        openRoles: snapshot.recruiter.openNeeds,
      },
    },
  };
}

/** Everything the setup screens and the workspace's "continue setup" need, for whoever is asking. */
export const state = companyQuery({
  args: {},
  handler: async (ctx) => {
    const setup = await setupOf(ctx, ctx.companyId);
    const owner = isOwner(ctx.role);
    const facts = await factsOf(ctx, ctx.companyId);
    const settings = businessSettingsOf(ctx.company);
    const known: Record<string, { value: string | string[]; state: "found" | "confirmed"; source: string; sourceRef: string | null; conflict: { value: string | string[]; source: string } | null }> = {};
    for (const row of facts) known[row.key] = { value: row.value, state: row.state, source: row.source, sourceRef: row.sourceRef ?? null, conflict: row.conflict ? { value: row.conflict.value, source: row.conflict.source } : null };
    const view = setup
      ? {
          status: setup.status,
          step: normalizeStep(setup.step),
          methods: setup.methods,
          priority: setup.priority ?? null,
          secondary: setup.secondary,
          answers: setup.answers,
          skipped: setup.skipped,
          revision: setup.revision,
          progress: progress({ step: setup.step }),
          steps: stepsFor(),
          contextConfirmed: setup.milestones.contextConfirmedAt !== undefined,
          built: setup.build ? { requestedAt: setup.build.requestedAt, outcome: setup.build.outcome } : null,
          exitedAt: setup.milestones.exitedAt ?? null,
          resumedAt: setup.milestones.resumedAt ?? null,
          handoff: setup.handoff ?? null,
          checklistDismissed: setup.checklistDismissedAt !== undefined,
        }
      : null;
    const prepared = setup?.prepared ? await preparedView(ctx, ctx.companyId, setup.prepared) : { service: null, agreement: null, booking: null, hiringBrief: null };
    return {
      prepared,
      /** Only an Owner who has not yet entered the workspace is taken to setup. Nobody else, ever. */
      required: owner && setup?.status === "in_progress",
      canEdit: owner,
      setup: view,
      company: { name: ctx.company.name, timezone: ctx.company.timezone, postalCodes: settings.serviceAreas, hours: settings.hours.length },
      facts: known,
      agents: await agentReadiness(ctx, ctx.company),
    };
  },
});

/**
 * The questions for the owner's outcome, each with what already answers it (an earlier answer, a confirmed
 * fact, a record), and the record counts behind them. Read only by the setup screens: the gate reads
 * `state` on every page, so the records are counted here instead.
 */
export const questions = companyQuery({
  args: {},
  handler: async (ctx) => {
    const setup = await setupOf(ctx, ctx.companyId);
    if (!setup || !isOwner(ctx.role)) return null;
    const { known } = await knownOf(ctx, ctx.company, setup);
    return {
      priority: setup.priority ?? null,
      questions: contextFor(setup.priority, known).map((row) => ({ id: row.question.id, answeredBy: row.answeredBy })),
      stillNeeded: unanswered(setup.priority, known).map((question) => question.id),
      records: known.records,
    };
  },
});

/** For a company made before setup existed: the Owner chooses to go through it. It never starts by itself. */
export const begin = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await setupOf(ctx, ctx.companyId);
    if (existing) return null;
    const id = await startSetup(ctx, ctx.companyId);
    // They are already working in the product, so setup is something they visit, not a gate.
    const now = Date.now();
    await ctx.db.patch(id, { status: "entered", optedIn: true, milestones: { startedAt: now, enteredAt: now } });
    return null;
  },
});

/**
 * Saves the owner's edits on one stage: where they are, what they chose, and any facts they stated. The
 * screen autosaves through this, so it is quiet when nothing changed. Every save names the revision it
 * started from; an older one is refused rather than overwriting a newer save from another tab or device.
 */
export const save = ownerMutation({
  args: {
    expectedRevision: v.number(),
    step: v.string(),
    methods: v.optional(v.array(methodValidator)),
    priority: v.optional(priorityValidator),
    secondary: v.optional(v.array(priorityValidator)),
    answers: v.optional(v.record(v.string(), factValueValidator)),
    skip: v.optional(v.string()),
    company: v.optional(v.object({ name: v.optional(v.string()), timezone: v.optional(v.string()) })),
    facts: v.optional(v.record(v.string(), factValueValidator)),
    /** The owner looked at the summary of their company and said it is right. */
    confirmContext: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const setup = await setupOf(ctx, ctx.companyId);
    if (!setup) throw userError("Setup has not been started for this company.");
    if (args.expectedRevision !== setup.revision) throw userError(STALE);

    // Everything is checked before anything is written.
    const priority = args.priority ?? setup.priority;
    const secondary = [...new Set(args.secondary ?? setup.secondary)].filter((value) => value !== priority).slice(0, 5);
    // Older screens may still send an earlier step id; it is saved as the stage that now holds it.
    if (!isKnownStep(args.step)) throw userError("That step is not part of your setup.");
    const step = normalizeStep(args.step);
    const allowed = new Set<string>([...allowedQuestions(priority, secondary).filter((question) => !question.fact).map((question) => question.id), ...KEPT_ANSWERS]);
    const answers: Record<string, string | string[]> = { ...setup.answers };
    for (const [id, value] of Object.entries(args.answers ?? {})) {
      if (!allowed.has(id)) throw userError("That question is not part of your setup.");
      answers[id] = Array.isArray(value) ? [...new Set(value)].slice(0, 20).map((item) => text(item, "The answer", 80)) : text(value, "The answer", 80);
    }
    const stated: [keyof typeof FACTS, string | string[]][] = [];
    for (const [key, value] of Object.entries(args.facts ?? {})) {
      if (!isFactKey(key)) throw userError("That is not something setup records.");
      if (FACTS[key].many !== Array.isArray(value)) throw userError(`${FACTS[key].label} was not given in the right form.`);
      stated.push([key, Array.isArray(value) ? [...new Set(value.map((item) => item.trim()).filter(Boolean))].slice(0, 20).map((item) => text(item, FACTS[key].label, 80)) : value.trim() === "" ? "" : text(value, FACTS[key].label, 300)]);
    }
    const name = args.company?.name !== undefined ? text(args.company.name, "Company name", 160) : undefined;
    const timezone = args.company?.timezone;
    if (timezone !== undefined && !isTimezone(timezone)) throw userError("Choose a time zone from the list.");
    if (args.confirmContext && !(name ?? ctx.company.name).trim()) throw userError("Give your company a name first.");

    // The company's name and clock live on the company, where every schedule already reads them.
    const companyChanged = (name !== undefined && name !== ctx.company.name) || (timezone !== undefined && timezone !== ctx.company.timezone);
    if (companyChanged) {
      await ctx.db.patch(ctx.companyId, { ...(name !== undefined ? { name } : {}), ...(timezone !== undefined ? { timezone } : {}), settingsRevision: (ctx.company.settingsRevision ?? 0) + 1 });
      await recordEvent(ctx, { companyId: ctx.companyId, type: "company.updated", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId } });
    }
    let factsChanged = false;
    for (const [key, value] of stated) {
      const before = await ctx.db
        .query("companyFacts")
        .withIndex("by_company_key", (q) => q.eq("companyId", ctx.companyId).eq("key", key))
        .first();
      await stateFact(ctx, ctx.companyId, ctx.member._id, key, value);
      const after = await ctx.db
        .query("companyFacts")
        .withIndex("by_company_key", (q) => q.eq("companyId", ctx.companyId).eq("key", key))
        .first();
      if (JSON.stringify([before?.value, before?.state]) !== JSON.stringify([after?.value, after?.state])) factsChanged = true;
    }

    const now = Date.now();
    const steps = stepsFor();
    const skipped = args.skip && steps.some((row) => row.id === normalizeStep(args.skip!) && row.optional) ? [...new Set([...setup.skipped, normalizeStep(args.skip)])] : setup.skipped;
    const methods = args.methods ? [...new Set(args.methods)] : setup.methods;
    const firstOutcome = priority !== undefined && setup.milestones.outcomeSelectedAt === undefined;
    // Answers to questions that are no longer on the path are kept: changing outcome back finds them again.
    const next = {
      step,
      methods,
      priority,
      secondary,
      answers,
      skipped,
      milestones: {
        ...setup.milestones,
        ...(args.confirmContext && setup.milestones.contextConfirmedAt === undefined ? { contextConfirmedAt: now } : {}),
        ...(firstOutcome ? { outcomeSelectedAt: now } : {}),
      },
      ...(setup.entry === undefined && methods.length ? { entry: methods.includes("website") ? ("website" as const) : ("manual" as const) } : {}),
    };
    const answersChanged = JSON.stringify(answers) !== JSON.stringify(setup.answers);
    const changed = (Object.keys(next) as (keyof typeof next)[]).some((key) => JSON.stringify(next[key]) !== JSON.stringify(setup[key]));
    if (!changed && !factsChanged && !companyChanged) return { revision: setup.revision };
    await ctx.db.patch(setup._id, { ...next, revision: setup.revision + 1, updatedAt: now });
    // A confirmed answer can unblock first agent work that was waiting for it (lib/activation/wake.ts).
    if (factsChanged) await wakeActivation(ctx, ctx.companyId);
    // After the workspace was built, changed answers update the drafts nobody has edited (configure.ts).
    if (setup.build && (factsChanged || answersChanged)) await requeueChanged(ctx);
    if (firstOutcome) await recordEvent(ctx, { companyId: ctx.companyId, type: "setup.outcome_selected", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { priority: priority ?? "none", entry: next.entry ?? setup.entry ?? "manual" } });
    if (args.confirmContext && setup.milestones.contextConfirmedAt === undefined) {
      await recordEvent(ctx, { companyId: ctx.companyId, type: "setup.context_confirmed", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { priority: priority ?? "none" } });
    }
    return { revision: setup.revision + 1 };
  },
});

// ── Build my workspace ──────────────────────────────────────────────────────────────────────────────

/** The activation templates setup leaves out for this company, beyond what configuration already makes. */
function setupExclusions(outcome: Priority, known: Known): string[] {
  const out: string[] = [];
  // No inquiries yet: Sales doesn't pretend to have leads to follow through on.
  if (known.records.openInquiries === 0) out.push("sales.inquiry_follow_through");
  // The inbox is read only when the owner said applicants email them, or it is already connected.
  const sources = known.answers["hiring.sources"];
  if (outcome === "recruiter" && known.records.hiringInbox === "none" && !(Array.isArray(sources) && sources.includes("email"))) out.push("recruiter.applicant_review");
  return out;
}

/**
 * The one "Build my workspace" action. It coordinates the existing workers and nothing else:
 * business configuration queues the drafts this outcome needs, and activation starts the agents' first
 * internal work. Both already refuse to repeat work that is up to date, running or planned from the same
 * context, so pressing Build twice, refreshing, or building from a second tab prepares nothing twice.
 *
 * It authorizes preparation only. Nothing is published, sent, priced or charged, and no permission changes:
 * anything that would reach a customer or cleaner still goes through the agent's own permission, approval
 * and consent checks at the moment it would happen.
 */
export const build = ownerMutation({
  args: { expectedRevision: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const setup = await setupOf(ctx, ctx.companyId);
    if (!setup) throw userError("Setup has not been started for this company.");
    if (args.expectedRevision !== undefined && args.expectedRevision !== setup.revision) throw userError(STALE);
    const outcome = setup.priority;
    if (!outcome) throw userError("Choose what you'd like Selestial to help with first.");
    const { known } = await knownOf(ctx, ctx.company, setup);
    const categories = known.facts["services.categories"];
    const plan = buildPlan(outcome, Array.isArray(categories) && categories.length > 0);
    const now = Date.now();
    const already = setup.build !== undefined && setup.build.outcome === outcome;

    const queued = await queueForSetup(ctx, ctx.company, ctx.member._id, plan.configure);
    const exclude = [...plan.exclude, ...setupExclusions(outcome, known)];
    const started = await startActivation(ctx, { source: "setup", focus: outcome, secondary: setup.secondary, exclude, trimBlocked: true });
    const activationId = started.kind === "empty" ? undefined : started.activationId;

    const fresh = (await ctx.db.get(setup._id))!;
    await ctx.db.patch(setup._id, {
      step: "result",
      build: {
        requestedAt: fresh.build?.requestedAt ?? now,
        requestedBy: ctx.member._id,
        outcome,
        configure: plan.configure,
        exclude,
        ...(activationId ? { activationId } : (fresh.build?.activationId ? { activationId: fresh.build.activationId } : {})),
        ...(started.kind === "empty" ? { activationNote: "No agent work was needed for this outcome yet." } : {}),
        updatedAt: now,
      },
      milestones: {
        ...fresh.milestones,
        ...(fresh.milestones.contextConfirmedAt === undefined ? { contextConfirmedAt: now } : {}),
        ...(fresh.milestones.buildStartedAt === undefined ? { buildStartedAt: now } : {}),
      },
      revision: fresh.revision + 1,
      updatedAt: now,
    });
    if (setup.milestones.contextConfirmedAt === undefined) await recordEvent(ctx, { companyId: ctx.companyId, type: "setup.context_confirmed", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { priority: outcome } });
    await recordEvent(ctx, {
      companyId: ctx.companyId,
      type: already ? "setup.build_requested_again" : "setup.build_started",
      actor: byMember(ctx),
      subject: { table: "companies", id: ctx.companyId },
      data: { priority: outcome, entry: setup.entry ?? "manual", configure: queued.join(", "), activation: started.kind, minutes: Math.round((now - setup.milestones.startedAt) / 60_000) },
    });
    return { queued, activation: started.kind, activationId: activationId ?? null, revision: fresh.revision + 1 };
  },
});

/** Before Build: the one sentence of what it will prepare, and what it will not do. */
async function buildPreview(ctx: QueryCtx, company: Doc<"companies">, setup: Doc<"companySetups">, outcome: Priority) {
  const { known, snapshot } = await knownOf(ctx, company, setup);
  const categories = known.facts["services.categories"];
  const plan = buildPlan(outcome, Array.isArray(categories) && categories.length > 0);
  const exclude = [...plan.exclude, ...setupExclusions(outcome, known)];
  const tasks = planFor(outcome, setup.secondary, snapshot).filter((t) => !exclude.includes(t.template) && (t.priority === 1 || t.state === "queued"));
  return { plan, sentence: buildSentence(outcome, plan, tasks.map((t) => t.title)), tasks: tasks.map((t) => ({ template: t.template, agent: t.agent, title: t.title, startsBlocked: t.state !== "queued", blocker: t.blocker?.words ?? null })) };
}

/**
 * One picture of everything Build started: the drafts configuration made and the agents' first work, each
 * in one truthful state, with real counts, the result to lead with for the owner's outcome, and the rest.
 */
export const buildStatus = companyQuery({
  args: {},
  handler: async (ctx) => {
    const setup = await setupOf(ctx, ctx.companyId);
    if (!setup || !setup.priority) return null;
    const outcome = setup.priority;
    if (!setup.build) {
      const preview = await buildPreview(ctx, ctx.company, setup, outcome);
      return { started: false as const, outcome, sentence: preview.sentence, tasks: preview.tasks, configure: preview.plan.configure };
    }
    const kinds = setup.build.configure;
    const cards = (await cardsOf(ctx, ctx.company)).filter((card) => (kinds as string[]).includes(card.kind));
    const items: BuildItem[] = [];
    for (const card of cards) {
      const item = fromCard(card);
      if (item) items.push(item);
    }
    const activation = setup.build.activationId ? await ctx.db.get(setup.build.activationId) : null;
    if (activation && activation.companyId === ctx.companyId) {
      const tasks = await ctx.db
        .query("activationTasks")
        .withIndex("by_activation", (q) => q.eq("activationId", activation._id))
        .take(20);
      for (const task of tasks.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)) {
        items.push(fromTask({ id: task._id, template: task.template, agent: task.agent, title: task.title, state: task.state, statusLine: task.statusLine, outputs: task.outputs, blocker: task.blocker ?? null }));
      }
    }
    const { lead, rest } = ordered(outcome, items);
    return {
      started: true as const,
      outcome,
      requestedAt: setup.build.requestedAt,
      outdated: setup.build.outcome !== outcome || cards.some((card) => card.changed),
      headline: leadHeadline(outcome, lead),
      counts: summarize(items),
      lead,
      rest,
      activation: activation ? { id: activation._id, status: activation.status } : null,
      note: setup.build.activationNote ?? null,
    };
  },
});

/** Tries one failed or blocked item of the build again, through the worker that owns it. Finished work is never redone. */
export const retryBuildItem = ownerMutation({
  args: { configureKind: v.optional(outputKindValidator), taskId: v.optional(v.id("activationTasks")) },
  handler: async (ctx, args) => {
    const setup = await setupOf(ctx, ctx.companyId);
    if (!setup?.build) throw userError("Build your workspace first.");
    if (args.configureKind) {
      if (!setup.build.configure.includes(args.configureKind)) throw userError("That isn't part of your workspace build.");
      await requeueKind(ctx, args.configureKind);
    } else if (args.taskId) {
      await retryTask(ctx, args.taskId);
    } else {
      throw userError("Choose what to try again.");
    }
    await recordEvent(ctx, { companyId: ctx.companyId, type: "setup.build_retried", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { item: args.configureKind ?? "agent_task", priority: setup.priority ?? "none" } });
    return null;
  },
});

/**
 * The owner opened a prepared output from setup to review it. Recorded once, as the first review, for the
 * funnel; opening it changes nothing about the output itself.
 */
export const opened = ownerMutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const setup = await setupOf(ctx, ctx.companyId);
    if (!setup || setup.milestones.firstOpenedAt !== undefined) return null;
    const now = Date.now();
    await ctx.db.patch(setup._id, { milestones: { ...setup.milestones, firstOpenedAt: now } });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "setup.first_output_opened", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { item: args.key.slice(0, 60), priority: setup.priority ?? "none", minutes: Math.round((now - setup.milestones.startedAt) / 60_000) } });
    return null;
  },
});

// ── Handoffs, leaving and coming back ───────────────────────────────────────────────────────────────

/**
 * Setup sent the owner to another page (an integration, an import, an approval) and they came back, or the
 * connection finished or failed there. The address must be a page setup allows (lib/setup/routes.ts), so
 * this can never record, or later offer, a link to anywhere else.
 */
export const handoff = ownerMutation({
  args: { href: v.string(), phase: v.union(v.literal("started"), v.literal("returned"), v.literal("completed"), v.literal("failed")) },
  handler: async (ctx, args) => {
    const setup = await setupOf(ctx, ctx.companyId);
    if (!setup) return null;
    const href = safeSetupPath(args.href);
    if (!href) throw userError("That page isn't part of setup.");
    const kind = setupDestination(href) ?? "review";
    const now = Date.now();
    if (args.phase === "started") {
      await ctx.db.patch(setup._id, { handoff: { kind, href, step: normalizeStep(setup.step), at: now } });
    } else if (setup.handoff && setup.handoff.outcome !== args.phase) {
      await ctx.db.patch(setup._id, { handoff: { ...setup.handoff, outcome: args.phase } });
    }
    await recordEvent(ctx, { companyId: ctx.companyId, type: `setup.handoff_${args.phase}`, actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { kind, path: href.split("?")[0], step: normalizeStep(setup.step) } });
    return null;
  },
});

/**
 * "Save and exit": the owner opens the workspace now. What they authorized with Build keeps running in
 * the background; if they leave before building, no agent work is started. Nothing is switched on.
 */
export const exit = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const setup = await setupOf(ctx, ctx.companyId);
    if (!setup) return null;
    const now = Date.now();
    await ctx.db.patch(setup._id, { milestones: { ...setup.milestones, exitedAt: now } });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "setup.exited", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { step: normalizeStep(setup.step), built: Boolean(setup.build), priority: setup.priority ?? "none" } });
    await enterWorkspace(ctx, (await setupOf(ctx, ctx.companyId))!);
    return null;
  },
});

/** The owner came back to setup after leaving it. Recorded once per time they left. */
export const resume = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const setup = await setupOf(ctx, ctx.companyId);
    const left = setup?.milestones.exitedAt;
    if (!setup || left === undefined || (setup.milestones.resumedAt ?? 0) > left) return null;
    const now = Date.now();
    await ctx.db.patch(setup._id, { milestones: { ...setup.milestones, resumedAt: now } });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "setup.resumed", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { step: normalizeStep(setup.step), awayMinutes: Math.round((now - left) / 60_000) } });
    return null;
  },
});

/** Brings the Home setup panel back after the owner closed it. */
export const reopen = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const setup = await setupOf(ctx, ctx.companyId);
    if (setup?.checklistDismissedAt !== undefined) await ctx.db.patch(setup._id, { checklistDismissedAt: undefined });
    return null;
  },
});

/** "Your first work": what is prepared, waiting, started and still blocked, counted from records now. */
export const firstWork = companyQuery({
  args: {},
  handler: async (ctx) => {
    const setup = await setupOf(ctx, ctx.companyId);
    if (!setup) return null;
    return { ...(await firstWorkOf(ctx, ctx.company, setup)), canDecide: ctx.role === "owner" || ctx.role === "manager" };
  },
});

async function enterWorkspace(ctx: MutationCtx & { companyId: Id<"companies">; member: Doc<"members"> }, setup: Doc<"companySetups">) {
  if (setup.status === "entered") return;
  const now = Date.now();
  // The first decision and the first action are recorded as they happened, if they did, from the records.
  const reviewedAt = setup.milestones.firstReviewedAt ?? (await firstDecisionAt(ctx, ctx.companyId, setup.milestones.startedAt)) ?? undefined;
  const actedAt = setup.milestones.firstActionAt ?? (await agentMessagesSince(ctx, ctx.companyId, setup.milestones.startedAt))[0]?.queuedAt;
  await ctx.db.patch(setup._id, { status: "entered", milestones: { ...setup.milestones, enteredAt: now, ...(reviewedAt !== undefined ? { firstReviewedAt: reviewedAt } : {}), ...(actedAt !== undefined ? { firstActionAt: actedAt } : {}) }, revision: setup.revision + 1, updatedAt: now });
  await recordEvent(ctx, { companyId: ctx.companyId, type: "setup.workspace_entered", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { priority: setup.priority ?? "none", contextConfirmed: setup.milestones.contextConfirmedAt !== undefined, built: Boolean(setup.build) } });
}

/**
 * The owner opens the workspace. Setup stops being a gate from this moment and continues inside the
 * product. Nothing is switched on by this: every agent's authority stays exactly as it was.
 */
export const enter = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const setup = await setupOf(ctx, ctx.companyId);
    if (!setup) return null;
    await enterWorkspace(ctx, setup);
    return null;
  },
});

/**
 * "Yes, use my existing prices": the owner's own first service and its price, as a draft. It starts from
 * Selestial's starting point for what they clean, so the booking form can offer it, and it is saved as
 * the owner's edit, so business configuration keeps it exactly as they wrote it. It is not published:
 * customers see it only after the owner publishes it in Services & Pricing.
 */
export const saveFirstService = ownerMutation({
  args: { name: v.string(), priceCents: v.number() },
  handler: async (ctx, args) => {
    const setup = await setupOf(ctx, ctx.companyId);
    if (!setup) throw userError("Setup has not been started for this company.");
    const name = text(args.name, "The service name", 80);
    if (!Number.isSafeInteger(args.priceCents) || args.priceCents < 100 || args.priceCents > 1_000_000_00) throw userError("Enter the price in dollars, at least $1.");
    const categories = (await factsOf(ctx, ctx.companyId)).find((row) => row.key === "services.categories" && row.state === "confirmed")?.value;
    const templateId = servicesToPrepare(Array.isArray(categories) ? categories : [], [])[0] ?? "res-standard";
    const template = TEMPLATES.find((row) => row.id === templateId) ?? TEMPLATES[0];
    const existing = setup.prepared?.serviceId ? await ctx.db.get(setup.prepared.serviceId) : null;
    const actor = byMember(ctx);
    const spec = (base: typeof template.spec) => normalizeSpec({ ...base, name, illustrative: false, pricing: { method: "fixed", amountCents: args.priceCents, laborMinutes: base.pricing.method === "fixed" ? base.pricing.laborMinutes : 180 } });
    if (existing && existing.companyId === ctx.companyId && existing.status === "draft") {
      const draft = await draftOf(ctx, ctx.companyId, existing._id);
      if (!draft) throw userError("That draft could not be found. Open it in Services & Pricing.");
      await writeDraft(ctx, existing, draft, spec(draft.spec), draft.step, actor, "workspace");
      return { serviceId: existing._id, created: false };
    }
    const { serviceId } = await createDraft(ctx, { category: template.category, spec: template.spec, origin: "template", templateId: template.id, via: "workspace", actor });
    const service = (await ctx.db.get(serviceId))!;
    const draft = (await draftOf(ctx, ctx.companyId, serviceId))!;
    // A second revision marks it as the owner's own, so configuration never rewrites it.
    await writeDraft(ctx, service, draft, spec(template.spec), draft.step, actor, "workspace");
    await markPrepared(ctx, setup, { serviceId });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "setup.first_service_entered", actor, subject: { table: "services", id: serviceId } });
    return { serviceId, created: true };
  },
});

// ── Preparing first drafts ──────────────────────────────────────────────────────────────────────
// Setup prepares through the same paths the workspace uses, and only drafts: nothing here is published,
// approved or sent. Each kind is prepared once; asking again opens the same draft.

type Prepared = NonNullable<Doc<"companySetups">["prepared"]>;

async function preparedView(ctx: QueryCtx, companyId: Id<"companies">, prepared: Prepared) {
  const service = prepared.serviceId ? await ctx.db.get(prepared.serviceId) : null;
  const agreement = prepared.agreementId ? await ctx.db.get(prepared.agreementId) : null;
  const booking = prepared.experienceId ? await ctx.db.get(prepared.experienceId) : null;
  const need = prepared.hiringNeedId ? await ctx.db.get(prepared.hiringNeedId) : null;
  const live = await ctx.db
    .query("services")
    .withIndex("by_company_status", (q) => q.eq("companyId", companyId).eq("status", "active"))
    .take(1);
  return {
    service: service ? { id: service._id, name: service.name, status: service.status, href: `/app/services/${service._id}` } : null,
    agreement: agreement ? { id: agreement._id, title: agreement.title, workflow: agreement.workflow, href: `/app/agreements/${agreement._id}` } : null,
    booking: booking ? { id: booking._id, name: booking.name, status: booking.status, href: `/app/agents/sales/booking-forms/${booking._id}`, canTakeBookings: live.length > 0 } : null,
    hiringBrief: need ? { id: need._id, title: need.title, status: need.status, href: "/app/agents/recruiter/hiring-setup#roles" } : null,
  };
}

async function markPrepared(ctx: MutationCtx, setup: Doc<"companySetups">, patch: Partial<Prepared>) {
  const now = Date.now();
  // Not a change to the owner's answers, so the revision stays: an open setup tab is not made stale by it.
  await ctx.db.patch(setup._id, { prepared: { ...(setup.prepared ?? {}), ...patch }, milestones: { ...setup.milestones, ...(setup.milestones.firstArtifactAt === undefined ? { firstArtifactAt: now } : {}) }, updatedAt: now });
}

async function ownSetup(ctx: MutationCtx & { companyId: Id<"companies"> }) {
  const setup = await setupOf(ctx, ctx.companyId);
  if (!setup) throw userError("Setup has not been started for this company.");
  return setup;
}

/** Starts one service from a template, named as the owner's website names it when they choose that. Its template prices stay marked as examples. */
export const prepareService = ownerMutation({
  args: { templateId: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const template = TEMPLATES.find((row) => row.id === args.templateId);
    if (!template) throw userError("That starting point is not available.");
    const setup = await ownSetup(ctx);
    if (setup.prepared?.serviceId && (await ctx.db.get(setup.prepared.serviceId))) return { serviceId: setup.prepared.serviceId, already: true };
    const name = args.name?.trim() ? text(args.name, "The service name", 80) : template.spec.name;
    const { serviceId } = await createDraft(ctx, { category: template.category, spec: { ...template.spec, name }, origin: "template", templateId: template.id, via: "workspace", actor: byMember(ctx) });
    await markPrepared(ctx, setup, { serviceId });
    return { serviceId, already: false };
  },
});

/** Starts one agreement from Selestial's starting text. It is a draft: nobody has reviewed or approved it. */
export const prepareAgreement = ownerMutation({
  args: { docType: v.union(v.literal("one_time_residential"), v.literal("recurring_residential"), v.literal("office_janitorial"), v.literal("commercial_msa"), v.literal("str_turnover")) },
  handler: async (ctx, args) => {
    const setup = await ownSetup(ctx);
    if (setup.prepared?.agreementId && (await ctx.db.get(setup.prepared.agreementId))) return { agreementId: setup.prepared.agreementId, already: true };
    const agreementId = await createAgreement(ctx, { docType: args.docType, origin: "manual", note: "Prepared during setup" });
    await markPrepared(ctx, setup, { agreementId });
    return { agreementId, already: false };
  },
});

/** Starts one booking page. It can take bookings only once it is published with a live service. */
export const prepareBooking = ownerMutation({
  args: { kind: experienceKindValidator },
  handler: async (ctx, args) => {
    const setup = await ownSetup(ctx);
    if (setup.prepared?.experienceId && (await ctx.db.get(setup.prepared.experienceId))) return { experienceId: setup.prepared.experienceId, already: true };
    const experienceId = await createExperience(ctx, args.kind);
    await markPrepared(ctx, setup, { experienceId });
    return { experienceId, already: false };
  },
});

/**
 * Prepares a hiring brief from what setup knows (confirmed facts only). It is saved as a draft: it takes no
 * applications and nobody is contacted until the Owner reviews it and opens it. Pay is left for the Owner
 * to approve, as on any role.
 */
export const prepareHiringBrief = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const setup = await ownSetup(ctx);
    if (setup.prepared?.hiringNeedId && (await ctx.db.get(setup.prepared.hiringNeedId))) return { needId: setup.prepared.hiringNeedId, already: true };
    const confirmed = (await factsOf(ctx, ctx.companyId)).filter((fact) => fact.state === "confirmed");
    const value = (key: string) => confirmed.find((fact) => fact.key === key)?.value;
    const list = (key: string) => {
      const found = value(key);
      return Array.isArray(found) ? found : typeof found === "string" && found ? [found] : [];
    };
    const categories = list("services.categories");
    const arrangement = list("workforce.arrangement");
    const location = typeof value("company.location") === "string" && value("company.location") ? (value("company.location") as string) : "To be confirmed";
    const kinds = categories.map((c) => CATEGORY_CHOICES.find((choice) => choice.value === c)?.label.toLowerCase()).filter(Boolean);
    const brief = checkedNeed({
      title: categories.length === 1 && categories[0] === "commercial" ? "Commercial cleaner" : "Cleaner",
      responsibilities: `Clean ${kinds.length ? kinds.join(", ") : "clients' homes and businesses"} for ${ctx.company.name}, following each visit's checklist and leaving every place ready for the client.`,
      serviceTypes: categories,
      location,
      requiredAvailability: "To be confirmed: the days and hours you need covered.",
      engagement: arrangement.includes("contractors") && !arrangement.includes("employees") ? "contractor" : "employee",
      openings: 1,
    });
    const needId = await ctx.db.insert("hiringNeeds", { companyId: ctx.companyId, ...brief, status: "draft", createdBy: ctx.member._id, createdAt: Date.now() });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "hiring_need.prepared", actor: byMember(ctx), subject: { table: "hiringNeeds", id: needId } });
    await markPrepared(ctx, setup, { hiringNeedId: needId });
    return { needId, already: false };
  },
});
