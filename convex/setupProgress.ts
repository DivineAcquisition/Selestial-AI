/**
 * Setup after setup: the milestones that happen later, the setup funnel for Selestial staff, and the compact
 * checklist an Owner sees on Home until the remaining setup items are done or they close it.
 *
 * Milestones. Started, context confirmed, first artifact and entered are recorded where they happen. The
 * first decision on agent work and the first message an agent sent happen elsewhere in the product, often
 * after the Owner has entered the workspace, so a sweep records them from the events and messages
 * themselves, at the time they happened.
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { companyQuery, ownerMutation, staffQuery } from "./lib/builders";
import { agentMessagesSince, firstDecisionAt, firstPublishedAt, firstWork } from "./lib/setup/firstWork";
import { setupOf } from "./setup";

const DAY = 86_400_000;
/** A setup is followed for this long after it starts; after that a missing milestone stays missing. */
const FOLLOW_DAYS = 60;

/** Hourly: fills the first decision, first action and first publish for setups that have them now, at their real times. */
export const catchUp = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let updated = 0;
    for (const setup of await ctx.db.query("companySetups").take(5000)) {
      const { milestones } = setup;
      if (milestones.startedAt < now - FOLLOW_DAYS * DAY) continue;
      if (milestones.firstReviewedAt !== undefined && milestones.firstActionAt !== undefined && milestones.firstPublishedAt !== undefined) continue;
      const reviewedAt = milestones.firstReviewedAt ?? (await firstDecisionAt(ctx, setup.companyId, milestones.startedAt)) ?? undefined;
      const actedAt = milestones.firstActionAt ?? (await agentMessagesSince(ctx, setup.companyId, milestones.startedAt))[0]?.queuedAt;
      const publishedAt = milestones.firstPublishedAt ?? (await firstPublishedAt(ctx, setup.companyId, milestones.startedAt)) ?? undefined;
      if (reviewedAt === milestones.firstReviewedAt && actedAt === milestones.firstActionAt && publishedAt === milestones.firstPublishedAt) continue;
      // Milestones only: the revision is for the Owner's own edits, so a sweep never makes their save stale.
      await ctx.db.patch(setup._id, { milestones: { ...milestones, ...(reviewedAt !== undefined ? { firstReviewedAt: reviewedAt } : {}), ...(actedAt !== undefined ? { firstActionAt: actedAt } : {}), ...(publishedAt !== undefined ? { firstPublishedAt: publishedAt } : {}) } });
      updated += 1;
    }
    return updated;
  },
});

const STAGES = ["startedAt", "outcomeSelectedAt", "contextConfirmedAt", "buildStartedAt", "firstUsableAt", "firstOpenedAt", "firstPublishedAt", "firstReviewedAt", "firstActionAt", "enteredAt"] as const;
type Stage = (typeof STAGES)[number];
const STAGE_WORDS: Record<Stage, string> = {
  startedAt: "Setup started",
  outcomeSelectedAt: "Primary outcome selected",
  contextConfirmedAt: "Essential context confirmed",
  buildStartedAt: "Preparation started",
  firstUsableAt: "First usable output ready",
  firstOpenedAt: "First output opened for review",
  firstPublishedAt: "First output published or opened",
  firstReviewedAt: "First decision on agent work",
  firstActionAt: "First authorized operational action",
  enteredAt: "Workspace entered (not activation)",
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

const minutesTo = (rows: Doc<"companySetups">[], stage: Stage) => {
  const value = median(rows.filter((row) => row.milestones[stage] !== undefined).map((row) => row.milestones[stage]! - row.milestones.startedAt));
  return value === null ? null : Math.round(value / 60_000);
};

function breakdown(rows: Doc<"companySetups">[], key: (row: Doc<"companySetups">) => string) {
  const groups = new Map<string, Doc<"companySetups">[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return [...groups.entries()].map(([value, group]) => ({
    value,
    setups: group.length,
    usable: group.filter((row) => row.milestones.firstUsableAt !== undefined).length,
    operational: group.filter((row) => row.milestones.firstActionAt !== undefined).length,
    // Time to the first thing the owner can use, and separately to the first real action, never mixed.
    medianMinutesToUsable: minutesTo(group, "firstUsableAt"),
    medianMinutesToOperational: minutesTo(group, "firstActionAt"),
  }));
}

/** Setup events counted for the funnel: handoffs, exits and returns, and preparation failing then recovering. */
const COUNTED = ["setup.handoff_started", "setup.handoff_completed", "setup.handoff_returned", "setup.handoff_failed", "setup.exited", "setup.resumed", "setup.build_retried", "configuration.failed", "activation.task_failed"] as const;

/**
 * The setup funnel, for Selestial staff: of the setups started in the window, how many reached each
 * milestone and the median time from starting, by outcome and by entry path. Entering the workspace is
 * shown but is never counted as activation: the activation measures are the first usable output and the
 * first authorized operational action. Companies that chose setup after already using the product are
 * counted apart. Nothing here reads credentials or customer content: only milestone times and event types.
 */
export const funnel = staffQuery({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const days = Math.min(Math.max(Math.round(args.days ?? 30), 1), 365);
    const since = Date.now() - days * DAY;
    const all = (await ctx.db.query("companySetups").take(10000)).filter((row) => row.milestones.startedAt >= since);
    const optedIn = all.filter((row) => row.optedIn === true);
    const fresh = all.filter((row) => !optedIn.includes(row));
    const events: Record<string, number> = Object.fromEntries(COUNTED.map((type) => [type, 0]));
    let recovered = 0;
    for (const row of fresh.slice(0, 500)) {
      const rows = await ctx.db
        .query("events")
        .withIndex("by_company_at", (q) => q.eq("companyId", row.companyId).gte("at", row.milestones.startedAt))
        .take(2000);
      for (const event of rows) if ((COUNTED as readonly string[]).includes(event.type)) events[event.type] += 1;
      const failed = rows.some((event) => event.type === "configuration.failed" || event.type === "activation.task_failed");
      if (failed && row.milestones.firstUsableAt !== undefined && rows.some((event) => event.type === "setup.build_retried")) recovered += 1;
    }
    return {
      days,
      setups: fresh.length,
      optedInLater: optedIn.length,
      stages: STAGES.map((stage) => ({ stage, words: STAGE_WORDS[stage], reached: fresh.filter((row) => row.milestones[stage] !== undefined).length, medianMinutes: stage === "startedAt" ? 0 : minutesTo(fresh, stage) })),
      byPriority: breakdown(fresh, (row) => row.priority ?? "none").map((row) => ({ ...row, priority: row.value, count: row.setups })),
      byEntry: breakdown(fresh, (row) => row.entry ?? "manual"),
      events,
      preparationRecovered: recovered,
    };
  },
});

/**
 * The compact checklist on Home: what is left from setup, for the Owner, until it is all done or they close
 * it. It reads the same records as "Your first work", so it never shows a step that is already done.
 */
export const checklist = companyQuery({
  args: {},
  handler: async (ctx) => {
    if (ctx.role !== "owner") return null;
    const setup = await setupOf(ctx, ctx.companyId);
    if (!setup || setup.status !== "entered" || setup.checklistDismissedAt !== undefined) return null;
    const work = await firstWork(ctx, ctx.company, setup);
    const items: { words: string; href: string }[] = [];
    if (work.waiting.firstBatch) items.push({ words: `Review the ${work.waiting.firstBatch === 1 ? "message" : `${work.waiting.firstBatch} messages`} Sales prepared`, href: "/app/agents/sales" });
    if (work.waiting.approvals) items.push({ words: `Decide ${work.waiting.approvals === 1 ? "1 approval" : `${work.waiting.approvals} approvals`}`, href: "/app/approvals" });
    for (const gap of work.blockers) items.push({ words: gap.next, href: gap.href });
    // Drafts setup made that still need the Owner: a service to publish, a booking page to publish, a brief to open.
    for (const item of work.prepared) if (/^(Service draft|Booking page|Hiring brief):/.test(item.label) && !/^(Published|Open)/.test(item.detail)) items.push({ words: `Finish ${item.label.toLowerCase()}`, href: item.href });
    const unique = items.filter((item, index) => items.findIndex((other) => other.words === item.words) === index);
    return unique.length ? { items: unique.slice(0, 4), more: Math.max(0, unique.length - 4) } : null;
  },
});

export const dismissChecklist = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const setup = await setupOf(ctx, ctx.companyId);
    if (setup && setup.checklistDismissedAt === undefined) await ctx.db.patch(setup._id, { checklistDismissedAt: Date.now() });
    return null;
  },
});
