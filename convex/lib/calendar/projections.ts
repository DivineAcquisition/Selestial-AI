/**
 * Recurring occurrences beyond what is booked. Calendar generates nothing: these come from each plan
 * system's own date rules (servicePlans: seriesDays; Sales plans: cadenceDates with the version in
 * effect), start the day after that plan's own booking boundary, and are always shown as projected,
 * never as booked visits. A date that already has a visit, or that the plan would not book (paused,
 * skipped, ended, a closed weekday), is not projected.
 */
import type { Doc } from "../../_generated/dataModel";
import { addDays, cadenceDates, localInstant, weekdayOf, type Cadence } from "../sales/cadence";
import { instantOn, seriesDays } from "../clients/plans";
import { versionFor } from "../sales/plans";

export type Projection = { date: string; startsAt: number; endsAt: number; arrivalEndsAt: number | null };

const MINUTE = 60_000;

const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);

/** A Clients service plan's days after `bookedThrough`, within [fromDay, throughDay]. */
export function projectServicePlan(plan: Doc<"servicePlans">, fromDay: string, throughDay: string, timezone: string, bookedDays: ReadonlySet<string>): Projection[] {
  if (plan.kind !== "recurring" || plan.state !== "active" || !plan.cadence || plan.migration?.held) return [];
  const after = plan.bookedThrough ? addDays(plan.bookedThrough, 1) : plan.startsOn;
  const start = later(fromDay, after);
  if (start > throughDay) return [];
  return seriesDays(plan, start, throughDay)
    .filter((day) => !bookedDays.has(day))
    .map((date) => {
      const startsAt = instantOn(date, plan.startTime, timezone);
      return { date, startsAt, endsAt: startsAt + Math.max(15, plan.durationMinutes) * MINUTE, arrivalEndsAt: plan.arrivalWindowMinutes > 0 ? startsAt + plan.arrivalWindowMinutes * MINUTE : null };
    });
}

/** A Sales recurring plan's dates after `generatedThrough`, within [fromDay, throughDay], with the version in effect on each. */
export function projectSalesPlan(plan: Doc<"recurringPlans">, versions: Doc<"recurringPlanVersions">[], fromDay: string, throughDay: string, closedWeekdays: ReadonlySet<number>, visitDays: ReadonlySet<string>): Projection[] {
  if (plan.status !== "active" || versions.length === 0) return [];
  const after = plan.generatedThrough ? addDays(plan.generatedThrough, 1) : plan.startDate;
  const start = later(fromDay, after);
  const until = plan.endDate ? earlier(throughDay, plan.endDate) : throughDay;
  if (start > until) return [];
  const dates = new Set<string>();
  for (const version of versions) {
    for (const date of cadenceDates(version.cadence as Cadence, version.effectiveFrom, later(start, version.effectiveFrom), until, 400)) {
      if (versionFor(versions, date)?._id === version._id) dates.add(date);
    }
  }
  const out: Projection[] = [];
  for (const date of [...dates].sort()) {
    if (visitDays.has(date)) continue;
    if (plan.pause && date >= plan.pause.from && (!plan.pause.until || date <= plan.pause.until)) continue;
    if (closedWeekdays.has(weekdayOf(date))) continue;
    const version = versionFor(versions, date)!;
    const first = date === plan.startDate && Boolean(version.first) && version.version === 1;
    const length = first && version.first ? version.first.durationMinutes : version.durationMinutes;
    const startsAt = localInstant(date, version.arrivalMinute, plan.timezone);
    out.push({ date, startsAt, endsAt: startsAt + length * MINUTE, arrivalEndsAt: version.arrivalWindowMinutes > 0 ? startsAt + version.arrivalWindowMinutes * MINUTE : null });
  }
  return out;
}
