/**
 * Busy times from the Google calendars the Owner chose for availability ("Respect busy times here"), as
 * Selestial last read them (googleBusy, refreshed every ten minutes by googleCalendar.sweep), for scheduling.
 *
 * How scheduling uses them (docs: convex/lib/google/features.ts promises "busy times on your calendars are
 * respected when scheduling"):
 *  - Times Selestial OFFERS on its own (online booking times, the Sales and Retention agents' suggested times,
 *    interview times offered to applicants) skip a time that overlaps a busy block.
 *  - A time a PERSON chooses is never refused for it: the capacity check carries a warning, and the calendar
 *    card lists visits and interviews that sit on a busy time, so the Owner can decide.
 *
 * Selestial's own visits and interviews on the calendar it writes to are not "busy" for this: when the
 * Owner marks that same calendar for availability, the parts of a busy block that are only Selestial's own
 * events are taken out, or every visit would conflict with itself and with every visit at the same time.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { conflicts, type Busy } from "./calendar";
import { activeConnection } from "./connection";
import { enabledFeatures } from "./features";

type Ctx = QueryCtx | MutationCtx;
type Span = { startsAt: number; endsAt: number };

/** What remains of `block` once the `own` spans are taken out of it. */
export function subtract(block: Busy, own: Span[]): Busy[] {
  let pieces: Busy[] = [block];
  for (const span of own) {
    const next: Busy[] = [];
    for (const piece of pieces) {
      if (span.endsAt <= piece.start || span.startsAt >= piece.end) {
        next.push(piece);
        continue;
      }
      if (span.startsAt > piece.start) next.push({ start: piece.start, end: span.startsAt });
      if (span.endsAt < piece.end) next.push({ start: span.endsAt, end: piece.end });
    }
    pieces = next;
  }
  return pieces;
}

/**
 * The busy blocks between two instants from the calendars chosen for availability. Empty when Calendar is not
 * connected, not granted, or no calendar is chosen for busy times.
 */
export async function calendarBusy(ctx: Ctx, companyId: Id<"companies">, from: number, to: number): Promise<Busy[]> {
  const connection = await activeConnection(ctx, companyId, "calendar");
  if (!connection || connection.status !== "connected" || !enabledFeatures(connection.grantedScopes).includes("calendar")) return [];
  const chosen = (await ctx.db.query("googleResources").withIndex("by_company_kind", (q) => q.eq("companyId", companyId).eq("kind", "calendar_busy")).take(20)).filter((r) => r.access !== "lost" && r.connectionId === connection._id);
  if (chosen.length === 0) return [];
  const syncCalendar = (await ctx.db.query("googleResources").withIndex("by_company_kind", (q) => q.eq("companyId", companyId).eq("kind", "calendar_sync")).take(5)).find((r) => r.access !== "lost")?.externalId ?? null;
  let own: Span[] | null = null;
  const out: Busy[] = [];
  for (const resource of chosen) {
    const row = (await ctx.db.query("googleBusy").withIndex("by_company_calendar", (q) => q.eq("companyId", companyId).eq("calendarId", resource.externalId)).take(1))[0];
    if (!row) continue;
    const blocks = row.busy.filter((b) => b.end > from && b.start < to);
    if (resource.externalId !== syncCalendar) {
      out.push(...blocks);
      continue;
    }
    own ??= await ownSpans(ctx, companyId, from, to);
    for (const block of blocks) out.push(...subtract(block, own));
  }
  return out;
}

/** Selestial's own visits and interviews between two instants: what it writes to the sync calendar. */
async function ownSpans(ctx: Ctx, companyId: Id<"companies">, from: number, to: number): Promise<Span[]> {
  const DAY = 86_400_000;
  const jobs = await ctx.db.query("jobs").withIndex("by_company_start", (q) => q.eq("companyId", companyId).gte("startsAt", from - DAY).lt("startsAt", to)).take(1000);
  const spans: Span[] = jobs.filter((job) => job.status !== "cancelled" && job.endsAt > from).map((job) => ({ startsAt: job.startsAt, endsAt: job.endsAt }));
  const interviews = await ctx.db.query("interviews").withIndex("by_company_application", (q) => q.eq("companyId", companyId)).take(500);
  for (const interview of interviews) if (interview.status === "confirmed" && interview.startsAt && interview.endsAt && interview.endsAt > from && interview.startsAt < to) spans.push({ startsAt: interview.startsAt, endsAt: interview.endsAt });
  return spans;
}

/** Whether a span overlaps any busy block. */
export function isBusy(busy: Busy[], span: Span): boolean {
  return conflicts([span], busy).length > 0;
}

/** The words a person sees when a time they chose sits on a busy time. Never a refusal. */
export const BUSY_WARNING = "Your Google Calendar shows a busy time then. Selestial doesn’t offer this time on its own; you can still choose it.";
