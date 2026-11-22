/**
 * Money allowances for agents acting without asking (docs/foundation/07-agent-controls.md §Allowances).
 *
 * - The window is the company's local calendar day: it resets at midnight in the company's time zone, and
 *   the reset time is shown on the screen.
 * - Totals are exact. Each company, action and day has one counter row holding what is committed and what
 *   is reserved; nothing is summed from a list that a query limit could cut short.
 * - A spend is reserved before the work runs, inside the same transaction as the check, so two agents
 *   acting at once cannot both fit under the limit (Convex serializes conflicting writes to the counter).
 * - Each reservation is keyed by the work it pays for. A retry finds it and does not reserve again.
 * - It moves once: reserved → committed when the work is done, or reserved → released when it fails, is
 *   cancelled or declined. Work whose outcome is uncertain keeps its reservation, so it keeps counting.
 * - The first time a day's counter is made, anything Retention already carried out without asking that
 *   day (before the ledger existed) is counted in, so switching to the ledger grants no extra authority.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { addLocalDays, startOfLocalDay } from "../time";

type Ctx = QueryCtx | MutationCtx;

/** YYYY-MM-DD on the company's clock. */
export function localDay(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** When today's allowance resets: the next local midnight. */
export function resetsAt(at: number, timezone: string): number {
  return addLocalDays(startOfLocalDay(at, timezone), 1, timezone);
}

async function dayRow(ctx: Ctx, companyId: Id<"companies">, action: string, day: string) {
  return ctx.db
    .query("allowanceDays")
    .withIndex("by_company_action_day", (q) => q.eq("companyId", companyId).eq("action", action).eq("day", day))
    .unique();
}

/**
 * What Retention carried out without asking today before the ledger existed. Conservative on purpose: any
 * autonomous underway or done action under this permission that changed since local midnight counts.
 * Read in full (no limit), so the seed is exact.
 */
async function legacySpend(ctx: Ctx, company: Doc<"companies">, action: string, since: number): Promise<number> {
  if (!action.startsWith("retention.")) return 0;
  let total = 0;
  for (const status of ["underway", "done"] as const) {
    const rows = ctx.db
      .query("retentionActions")
      .withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", status).gte("updatedAt", since));
    for await (const row of rows) {
      if (row.permission !== action || !row.authorization?.includes("without asking")) continue;
      const reserved = await ctx.db
        .query("allowanceReservations")
        .withIndex("by_company_key", (q) => q.eq("companyId", company._id).eq("key", `retentionActions:${row._id}`))
        .unique();
      if (reserved) continue;
      total += row.estimatedCostCents ?? row.money?.amountCents ?? 0;
    }
  }
  return total;
}

export type AllowanceState = { day: string; committedCents: number; reservedCents: number; usedCents: number; resetsAt: number };

/** Today's use of one action's allowance, for the screen and for "Test these rules". Never writes. */
export async function allowanceToday(ctx: Ctx, company: Doc<"companies">, action: string, now: number): Promise<AllowanceState> {
  const day = localDay(now, company.timezone);
  const row = await dayRow(ctx, company._id, action, day);
  const seed = row ? 0 : await legacySpend(ctx, company, action, startOfLocalDay(now, company.timezone));
  const committedCents = (row?.committedCents ?? 0) + seed;
  const reservedCents = row?.reservedCents ?? 0;
  return { day, committedCents, reservedCents, usedCents: committedCents + reservedCents, resetsAt: resetsAt(now, company.timezone) };
}

export type Reserved = { ok: true; reservationId: Id<"allowanceReservations">; repeated: boolean } | { ok: false; usedCents: number; resetsAt: number };

/**
 * Reserves `amountCents` of today's allowance for one piece of work, or says why not. A reservation that
 * already exists for this key is returned as it is, whatever its state: a retry never reserves twice.
 */
export async function reserve(
  ctx: MutationCtx,
  company: Doc<"companies">,
  input: { action: string; key: string; amountCents: number; perDayCents: number; source: { table: string; id: string } },
  now = Date.now(),
): Promise<Reserved> {
  const existing = await ctx.db
    .query("allowanceReservations")
    .withIndex("by_company_key", (q) => q.eq("companyId", company._id).eq("key", input.key))
    .unique();
  // A retry of work already reserved or spent finds it. Work whose earlier attempt was released may try again.
  if (existing && existing.state !== "released") return { ok: true, reservationId: existing._id, repeated: true };
  const day = localDay(now, company.timezone);
  let row = await dayRow(ctx, company._id, input.action, day);
  if (!row) {
    const seeded = await legacySpend(ctx, company, input.action, startOfLocalDay(now, company.timezone));
    const id = await ctx.db.insert("allowanceDays", { companyId: company._id, action: input.action, day, committedCents: seeded, reservedCents: 0, updatedAt: now });
    row = (await ctx.db.get(id))!;
  }
  const used = row.committedCents + row.reservedCents;
  if (used + input.amountCents > input.perDayCents) return { ok: false, usedCents: used, resetsAt: resetsAt(now, company.timezone) };
  await ctx.db.patch(row._id, { reservedCents: row.reservedCents + input.amountCents, updatedAt: now });
  if (existing) {
    await ctx.db.patch(existing._id, { day, amountCents: input.amountCents, state: "reserved", settledAt: undefined });
    return { ok: true, reservationId: existing._id, repeated: false };
  }
  const reservationId = await ctx.db.insert("allowanceReservations", { companyId: company._id, action: input.action, day, key: input.key, amountCents: input.amountCents, state: "reserved", source: input.source, createdAt: now });
  return { ok: true, reservationId, repeated: false };
}

/** Moves a reservation to committed or released, exactly once. A second call, or a call for a key with no reservation, does nothing. */
export async function settle(ctx: MutationCtx, companyId: Id<"companies">, key: string, to: "committed" | "released", now = Date.now()): Promise<boolean> {
  const row = await ctx.db
    .query("allowanceReservations")
    .withIndex("by_company_key", (q) => q.eq("companyId", companyId).eq("key", key))
    .unique();
  if (!row || row.state !== "reserved") return false;
  const day = await dayRow(ctx, companyId, row.action, row.day);
  if (day) {
    await ctx.db.patch(day._id, {
      reservedCents: Math.max(0, day.reservedCents - row.amountCents),
      committedCents: day.committedCents + (to === "committed" ? row.amountCents : 0),
      updatedAt: now,
    });
  }
  await ctx.db.patch(row._id, { state: to, settledAt: now });
  return true;
}
