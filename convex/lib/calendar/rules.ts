/**
 * What stands in the way of a Calendar event, checked against the people it actually takes. A cleaner's
 * visits, time off and other events are hard conflicts: a cleaner cannot be in two places. A member's
 * own time is a warning unless they marked themselves unavailable, because a member may choose to
 * double-book themselves. A private owner appointment never blocks a cleaner, and a meeting never blocks
 * anyone who is not on it.
 *
 * Checked when the form is filled in (calendarEvents.preview) and again inside the save, so two people
 * saving at once cannot both get the same person.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { localParts } from "../availability";
import { exceptionSpan } from "../cleaners/schedule";
import { clock, dayName } from "../time";
import { BUSY_WARNING, calendarBusy } from "../google/busy";

type Ctx = (QueryCtx | MutationCtx) & { companyId: Id<"companies">; company: Doc<"companies"> };

export type EventPeople = { memberIds: Id<"members">[]; cleanerIds: Id<"cleaners">[]; leadMemberId?: Id<"members">; leadCleanerId?: Id<"cleaners"> };
export type Check = { hard: string[]; warnings: string[]; notes: string[] };

const DAY = 86_400_000;
const overlap = (a: { startsAt: number; endsAt: number }, b: { startsAt: number; endsAt: number }) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/** The members and cleaners whose time an event takes, without repeats. */
export function peopleOf(event: EventPeople): { members: Id<"members">[]; cleaners: Id<"cleaners">[] } {
  return {
    members: [...new Set([...event.memberIds, ...(event.leadMemberId ? [event.leadMemberId] : [])])],
    cleaners: [...new Set([...event.cleanerIds, ...(event.leadCleanerId ? [event.leadCleanerId] : [])])],
  };
}

export async function checkEvent(ctx: Ctx, span: { startsAt: number; endsAt: number }, people: EventPeople, options: { ignore?: Id<"calendarEvents">; kind: Doc<"calendarEvents">["kind"] }): Promise<Check> {
  const out: Check = { hard: [], warnings: [], notes: [] };
  const timezone = ctx.company.timezone;
  const at = (row: { startsAt: number; endsAt: number }) => `${dayName(row.startsAt, timezone)}, ${clock(row.startsAt, timezone)} to ${clock(row.endsAt, timezone)}`;
  const { members, cleaners } = peopleOf(people);
  const name = async (id: Id<"members"> | Id<"cleaners">) => ((await ctx.db.get(id)) as { name?: string } | null)?.name ?? "Someone";

  // Other Calendar events in the window, read once.
  const events = (
    await ctx.db
      .query("calendarEvents")
      .withIndex("by_company_start", (q) => q.eq("companyId", ctx.companyId).gte("startsAt", span.startsAt - 15 * DAY).lt("startsAt", span.endsAt))
      .take(500)
  ).filter((row) => row._id !== options.ignore && row.status !== "cancelled" && overlap(row, span));

  // ── Cleaners: hard ──
  if (cleaners.length > 0) {
    const jobs = (
      await ctx.db
        .query("jobs")
        .withIndex("by_company_start", (q) => q.eq("companyId", ctx.companyId).gte("startsAt", span.startsAt - DAY).lt("startsAt", span.endsAt))
        .take(500)
    ).filter((job) => (job.status === "scheduled" || job.status === "in_progress") && overlap(job, span));
    for (const cleanerId of cleaners) {
      const who = await name(cleanerId);
      for (const job of jobs) {
        const mine = await ctx.db
          .query("assignments")
          .withIndex("by_company_job", (q) => q.eq("companyId", ctx.companyId).eq("jobId", job._id))
          .take(50);
        const held = mine.find((row) => row.cleanerId === cleanerId && (row.status === "accepted" || row.status === "offered"));
        if (held) out.hard.push(`${who} ${held.status === "accepted" ? "is on a visit" : "has an offer out for a visit"} then (${at(job)}).`);
      }
      const off = await ctx.db
        .query("timeOff")
        .withIndex("by_company_cleaner_end", (q) => q.eq("companyId", ctx.companyId).eq("cleanerId", cleanerId).gt("endsAt", span.startsAt))
        .take(50);
      if (off.some((row) => row.startsAt < span.endsAt)) out.hard.push(`${who} has time off then.`);
      const first = localParts(span.startsAt, timezone).day;
      const last = localParts(span.endsAt - 1, timezone).day;
      const exceptions = await ctx.db
        .query("availabilityExceptions")
        .withIndex("by_company_cleaner_date", (q) => q.eq("companyId", ctx.companyId).eq("cleanerId", cleanerId).gte("date", first).lte("date", last))
        .take(20);
      if (exceptions.some((row) => row.kind === "unavailable" && overlap(exceptionSpan(row, timezone), span))) out.hard.push(`${who} marked themselves unavailable then.`);
      for (const row of events) if (peopleOf(row).cleaners.includes(cleanerId)) out.hard.push(`${who} is already at "${row.title}" then (${at(row)}).`);
      const windows = await ctx.db
        .query("availabilityWindows")
        .withIndex("by_company_cleaner", (q) => q.eq("companyId", ctx.companyId).eq("cleanerId", cleanerId))
        .take(100);
      const start = localParts(span.startsAt, timezone);
      const end = localParts(span.endsAt, timezone);
      const fits = start.day === end.day && windows.some((row) => row.weekday === start.weekday && row.startMinute <= start.minute && end.minute <= row.endMinute);
      if (!fits) out.warnings.push(windows.length === 0 ? `${who} has no working hours on record.` : `${who} said they work other hours that day.`);
    }
  }

  // ── Members: warnings, except time they marked themselves away ──
  for (const memberId of members) {
    const who = await name(memberId);
    for (const row of events) {
      if (!peopleOf(row).members.includes(memberId)) continue;
      if (row.kind === "unavailable" && options.kind !== "unavailable") out.hard.push(`${who} is unavailable then (${at(row)}).`);
      // A private event is named only as busy: its title is not this person's to read.
      else out.warnings.push(`${who} already has ${row.private ? "something private" : `"${row.title}"`} then (${at(row)}).`);
    }
    const interviews = await ctx.db
      .query("interviews")
      .withIndex("by_company_start", (q) => q.eq("companyId", ctx.companyId).gte("startsAt", span.startsAt - DAY).lt("startsAt", span.endsAt))
      .take(200);
    for (const row of interviews) if (row.interviewerId === memberId && (row.status === "confirmed" || row.status === "reserving") && row.startsAt !== undefined && row.endsAt !== undefined && overlap({ startsAt: row.startsAt, endsAt: row.endsAt }, span)) out.warnings.push(`${who} is interviewing then.`);
    const walkthroughs = await ctx.db
      .query("assessments")
      .withIndex("by_company_scheduled", (q) => q.eq("companyId", ctx.companyId).gte("scheduledAt", span.startsAt - DAY).lt("scheduledAt", span.endsAt))
      .take(200);
    for (const row of walkthroughs) if (row.assessorMemberId === memberId && row.status === "scheduled" && row.scheduledAt !== undefined && overlap({ startsAt: row.scheduledAt, endsAt: row.scheduledAt + row.durationMinutes * 60_000 }, span)) out.warnings.push(`${who} has a walkthrough then.`);
    if (options.kind !== "unavailable") {
      const hours = await ctx.db
        .query("memberHours")
        .withIndex("by_company_member", (q) => q.eq("companyId", ctx.companyId).eq("memberId", memberId))
        .take(50);
      const start = localParts(span.startsAt, timezone);
      const end = localParts(span.endsAt, timezone);
      if (hours.length > 0 && !(start.day === end.day && hours.some((row) => row.weekday === start.weekday && row.startMinute <= start.minute && end.minute <= row.endMinute))) out.warnings.push(`It is outside ${who}'s working hours.`);
    }
  }
  if (members.length > 0 && options.kind !== "unavailable" && (await calendarBusy(ctx, ctx.companyId, span.startsAt, span.endsAt)).length > 0) out.warnings.push(BUSY_WARNING);

  if (options.kind === "inspection" || options.kind === "appointment") out.notes.push("Travel time is not looked up, so whether anyone can get there from their previous stop is not checked.");
  return { hard: [...new Set(out.hard)], warnings: [...new Set(out.warnings)], notes: out.notes };
}
