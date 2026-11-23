/**
 * Moving a visit from Calendar (docs/calendar/00-architecture.md, phase 4). It is Dispatch's own move
 * (convex/lib/dispatch/reschedule.ts: planMove and commitMove) with what Calendar's confirmation adds:
 * the company's area and hours, the customer's commitments, the recurring plan the visit belongs to,
 * and who will be told, each of which the person may turn off before saving where that is safe.
 *
 * Every role moves visits here, as in Dispatch (the owner's decision of November 23, 2026: Office can
 * reschedule). A recurring series is changed only by Owners and Managers, through the plan's own steps.
 * The preview names
 * the state it was made from; the move is refused if the visit changed in between.
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { owned } from "./lib/access";
import { companyMutation, companyQuery, type MemberAccess } from "./lib/builders";
import { noticeBody, noticePlan, queueMoveNotice } from "./lib/calendar/customerNotice";
import { commitMove, planMove } from "./lib/dispatch/reschedule";
import { dispatchSettings } from "./lib/dispatch/settings";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { syncCalendarSoon } from "./lib/google/syncSoon";
import { localParts } from "./lib/availability";
import { businessSettingsOf, checkArea, checkHours } from "./lib/settings/business";
import { instant, optionalText } from "./lib/text";
import { clock, dayName } from "./lib/time";

type Ctx = (QueryCtx | MutationCtx) & MemberAccess;

const DAY = 86_400_000;

function span(startsAt: number, endsAt: number) {
  const start = instant(startsAt, "The start time");
  const end = instant(endsAt, "The end time");
  if (start >= end) throw userError("A visit must start before it ends.");
  if (end - start > DAY) throw userError("A visit cannot be longer than a day.");
  return { startsAt: start, endsAt: end };
}

/** The company's own rules for where and when it works, as words instead of a refusal. */
function businessProblems(ctx: Ctx, property: Doc<"properties"> | null, move: { startsAt: number; endsAt: number }): string[] {
  const out: string[] = [];
  const settings = businessSettingsOf(ctx.company);
  for (const check of [() => property && checkArea(settings, property.address.postalCode), () => checkHours(settings, move, ctx.company.timezone)]) {
    try {
      check();
    } catch (error) {
      out.push((error as { data?: { message?: string } }).data?.message ?? "It breaks one of the company's scheduling rules.");
    }
  }
  return out;
}

/** The recurring plan a visit belongs to, in whichever of the two plan systems made it. */
async function seriesOf(ctx: Ctx, job: Doc<"jobs">, newStart: number) {
  const timezone = ctx.company.timezone;
  const sameWeekday = localParts(job.startsAt, timezone).weekday === localParts(newStart, timezone).weekday;
  const time = clock(newStart, timezone);
  if (job.planId) {
    const plan = await ctx.db.get(job.planId);
    if (!plan || plan.kind !== "recurring") return null;
    const parts = localParts(newStart, timezone);
    return {
      system: "service" as const,
      planId: plan._id,
      revision: plan.revision,
      running: plan.state === "active",
      date: job.planDate ?? localParts(job.startsAt, timezone).day,
      today: localParts(Date.now(), timezone).day,
      startTime: `${String(Math.floor(parts.minute / 60)).padStart(2, "0")}:${String(parts.minute % 60).padStart(2, "0")}`,
      sameWeekday,
      time,
    };
  }
  const visit = await ctx.db
    .query("planVisits")
    .withIndex("by_company_job", (q) => q.eq("companyId", ctx.companyId).eq("jobId", job._id))
    .first();
  if (!visit) return null;
  const plan = await ctx.db.get(visit.planId);
  if (!plan) return null;
  const parts = localParts(newStart, plan.timezone);
  return { system: "sales" as const, planId: plan._id, revision: plan.updatedAt, running: plan.status === "active", date: visit.date, today: localParts(Date.now(), plan.timezone).day, arrivalMinute: parts.minute, sameWeekday, time };
}

/**
 * Everything a move would touch, before anything is done: who is asked again, whose place reopens and
 * why, the company's rules, the customer's commitments, the plan the visit belongs to, and the notices
 * that would go. Changes nothing.
 */
export const previewVisit = companyQuery({
  args: { jobId: v.id("jobs"), startsAt: v.number(), endsAt: v.number() },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args.jobId);
    const move = span(args.startsAt, args.endsAt);
    const { plan } = await planMove(ctx, ctx.company, job, move);
    const property = await ctx.db.get(job.propertyId);
    const customer = await ctx.db.get(job.customerId);
    const timezone = ctx.company.timezone;
    const commitments: string[] = [];
    if (job.arrivalWindowMinutes) commitments.push(`The ${job.arrivalWindowMinutes}-minute arrival window moves with the visit.`);
    if (plan.hardDeadlineAt !== null) commitments.push(`It must be finished by ${dayName(plan.hardDeadlineAt, timezone)} at ${clock(plan.hardDeadlineAt, timezone)}${property?.kind === "short_term_rental" ? ", before the next guest" : ""}.`);
    commitments.push(`The client was told ${dayName(job.startsAt, timezone)} at ${clock(job.startsAt, timezone)}.`);
    const series = await seriesOf(ctx, job, move.startsAt);
    const notice = customer ? await noticePlan(ctx, customer) : null;
    return {
      plan,
      blocking: [...plan.problems, ...businessProblems(ctx, property, move)],
      commitments,
      crewNotices: [
        ...plan.offersWithdrawn.map((row) => ({ assignmentId: row.assignmentId, name: row.name, kind: "withdrawn" as const, optional: true, words: `${row.name}'s open offer is withdrawn. They are texted unless you tell them yourself.` })),
        ...plan.crew.map((row) =>
          row.outcome === "asked_again"
            ? { assignmentId: row.assignmentId, name: row.name, kind: "asked_again" as const, optional: false, words: `${row.name} is asked to confirm the new time. The new offer is how they accept, so it always goes.` }
            : { assignmentId: row.assignmentId, name: row.name, kind: "ended" as const, optional: true, words: `${row.name} can't work the new time (${row.reason}). Their place reopens and they are texted unless you tell them yourself.` },
        ),
      ],
      customerNotice: notice ? { ready: notice.ready, words: notice.ready ? `${notice.words}: “${noticeBody(ctx.company, job, job.startsAt, move.startsAt)}”` : `Not possible: ${notice.words}` } : { ready: false, words: "The visit has no client on record." },
      travel: `${dispatchSettings(ctx.company).travelBufferMinutes} minutes are kept between a cleaner's visits. Drive times between properties are not looked up, so whether a cleaner can get there in time is not checked beyond that.`,
      series,
    };
  },
});

/**
 * Moves one visit. The preview's `version` must still match, the company's rules must hold, and the
 * person chooses the client notice and which crew notices to skip. The move is saved first; the notice
 * that follows can fail without undoing it, and its result is returned separately.
 */
export const moveVisit = companyMutation({
  args: { jobId: v.id("jobs"), startsAt: v.number(), endsAt: v.number(), version: v.string(), notifyCustomer: v.boolean(), quiet: v.array(v.id("assignments")), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args.jobId);
    const move = span(args.startsAt, args.endsAt);
    const settings = businessSettingsOf(ctx.company);
    const property = await ctx.db.get(job.propertyId);
    if (property) checkArea(settings, property.address.postalCode);
    checkHours(settings, move, ctx.company.timezone);
    const reason = optionalText(args.reason, "The reason", 500) || undefined;
    const quiet = new Set<string>(args.quiet);
    const plan = await commitMove(ctx, ctx.company, job, move, args.version, byMember(ctx), { quiet });
    const customer = await ctx.db.get(job.customerId);
    const notice = args.notifyCustomer && customer ? await queueMoveNotice(ctx, { company: ctx.company, customer, job: (await ctx.db.get(job._id))!, from: job.startsAt, to: move.startsAt, member: ctx.member, actor: byMember(ctx) }) : null;
    await recordEvent(ctx, {
      companyId: ctx.companyId,
      type: "job.moved_from_calendar",
      actor: byMember(ctx),
      subject: { table: "jobs", id: job._id },
      data: { from: job.startsAt, to: move.startsAt, customerNotice: notice ? notice.status : "not_chosen", crewNoticesSkipped: quiet.size, reason: reason ?? null },
    });
    // The connected calendar follows now rather than at the next sweep. The move does not wait on it.
    await syncCalendarSoon(ctx, ctx.companyId, ctx.member._id);
    return {
      askedAgain: plan.crew.filter((row) => row.outcome === "asked_again").length,
      placesReopened: plan.crew.filter((row) => row.outcome === "place_reopens").length,
      offersWithdrawn: plan.offersWithdrawn.length,
      customerNotice: notice ? { status: notice.status, words: notice.words } : { status: "not_chosen" as const, words: "The client was not told from here." },
    };
  },
});
