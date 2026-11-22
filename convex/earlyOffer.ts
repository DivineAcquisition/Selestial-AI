/**
 * The early-user offer: $199 a month for the first 12 months, for the first 15 companies whose first plan
 * payment succeeds, then $299 (convex/lib/billing/earlyOffer.ts has the exact rule; docs/billing/README.md,
 * "Early-user offer").
 *
 * This file keeps it running on its own:
 *   - reservations whose payment page can no longer be paid are released;
 *   - about 30 days before the 12 months end, the Owner gets one email and one in-app notice;
 *   - in the 12th billing period, Autumn is asked to move the company to "operate" at the end of that period,
 *     once, under one Idempotency-Key, and Autumn's record is read back to confirm it was scheduled. A failure
 *     is retried and shown to staff as an incident (convex/lib/operations/detectors.ts), never left silent.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { accountFor, billingState, customerIdFor } from "./lib/billing/access";
import { attach, attachBody } from "./lib/billing/autumn";
import { AUTUMN, EARLY_OFFER, PLANS } from "./lib/billing/catalog";
import { offerFor, ownerOffer, PERIOD_SLACK_MS, placesUsed, releasePlace, REMINDER_BEFORE_MS } from "./lib/billing/earlyOffer";
import { syncAccount } from "./lib/billing/reserve";
import { ownerQuery, staffMutation, staffQuery } from "./lib/builders";
import { notFound, userError } from "./lib/errors";
import { recordEvent } from "./lib/events";
import { appOrigin } from "./lib/invitations";
import { notifyMembers } from "./lib/notify/route";
import { text } from "./lib/text";

const HOUR = 3_600_000;
/** After a refusal, the move is asked again after these waits; then it waits for staff, every 6 hours. */
const SWITCH_BACKOFF = [1, 3, 6].map((hours) => hours * HOUR);
/** After a request Autumn accepted, its record is read back; if the move is not on it after this, it is asked again. */
const SWITCH_VERIFY_MS = 6 * HOUR;

const fmtDate = (at: number) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(new Date(at));
const dollars = (cents: number) => `$${Math.round(cents / 100)}`;

/** Whether the month-12 move is due now: the plan is still $199 and the current billing period ends at (or after) the end of month 12. */
export function switchDue(row: Doc<"earlyOffers">, account: Doc<"billingAccounts"> | null, now: number): boolean {
  if (row.state !== "claimed" || !row.offerEndsAt || row.switchConfirmedAt) return false;
  if (!account || account.autumnPlanId !== AUTUMN.earlyPlan || account.subscription.endsAt !== null) return false;
  const periodEnd = account.subscription.periodEnd;
  // Only in the 12th period (or later, if it was missed): end_of_cycle then takes effect at month 12, never before.
  if (periodEnd === null || periodEnd < row.offerEndsAt - PERIOD_SLACK_MS) return false;
  return (row.switchNextAt ?? 0) <= now;
}

/** Hourly (convex/crons.ts). Each step is idempotent: running it twice changes nothing twice. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const env of ["sandbox", "production"] as const) {
      // 1. Reservations nobody paid for in time give their place back.
      const reserved = await ctx.db
        .query("earlyOffers")
        .withIndex("by_env_state", (q) => q.eq("env", env).eq("state", "reserved"))
        .take(200);
      for (const row of reserved) {
        if (row.reservedUntil > now) continue;
        if (await releasePlace(ctx, row, "The payment was not completed in time, so the place was given back.", "system", now)) {
          await recordEvent(ctx, { companyId: row.companyId, type: "billing.early_offer_released", actor: { kind: "system" }, subject: { table: "companies", id: row.companyId }, data: { reason: "expired" } });
        }
      }
      // 2. Companies paying $199: the one reminder, and the month-12 move.
      const claimed = await ctx.db
        .query("earlyOffers")
        .withIndex("by_env_state", (q) => q.eq("env", env).eq("state", "claimed"))
        .take(200);
      for (const row of claimed) {
        if (!row.offerEndsAt) continue;
        const account = await accountFor(ctx, row.companyId, env);
        if (!row.reminderSentAt && now >= row.offerEndsAt - REMINDER_BEFORE_MS && account?.plan && account.autumnPlanId === AUTUMN.earlyPlan && account.subscription.endsAt === null) await remind(ctx, row, account, now);
        if (switchDue(row, account, now)) {
          // Claimed before Autumn is asked, so the next sweep does not ask again while this one is running.
          await ctx.db.patch(row._id, { switchRequestedAt: row.switchRequestedAt ?? now, switchNextAt: now + SWITCH_VERIFY_MS, updatedAt: now });
          await ctx.scheduler.runAfter(0, internal.earlyOffer.scheduleSwitch, { offerId: row._id });
        }
      }
    }
  },
});

async function remind(ctx: MutationCtx, row: Doc<"earlyOffers">, account: Doc<"billingAccounts">, now: number) {
  const endsAt = row.offerEndsAt!;
  const full = dollars(PLANS[EARLY_OFFER.plan].monthlyCents);
  const words = `Your early-user price of ${dollars(EARLY_OFFER.monthlyCents)} a month ends on ${fmtDate(endsAt)}. From then, Operate is ${full} a month. Nothing else changes, and you don't need to do anything.`;
  await ctx.db.patch(row._id, { reminderSentAt: now, updatedAt: now });
  // The in-app notice, on Plan & Usage. Owner notices are part of the plan: they never use the messaging balance.
  await ctx.db.patch(account._id, { notices: [{ kind: "price_change" as const, at: now, text: words }, ...account.notices].slice(0, 10) });
  // The email, through the notice system: one per Owner, kept once by its key however often this runs.
  await notifyMembers(ctx, { companyId: row.companyId, event: "plan_price_change", ref: row._id, key: "month12", now });
  await recordEvent(ctx, { companyId: row.companyId, type: "billing.early_offer_reminder", actor: { kind: "system" }, subject: { table: "companies", id: row.companyId }, data: { offerEndsAt: endsAt } });
}

export const switchContext = internalQuery({
  args: { offerId: v.id("earlyOffers") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.offerId);
    if (!row || row.state !== "claimed" || row.switchConfirmedAt) return null;
    const state = billingState();
    if (!state.connected || state.env !== row.env) return null;
    return { companyId: row.companyId, customerId: customerIdFor(row.companyId), attempts: row.switchAttempts ?? 0 };
  },
});

/**
 * Asks Autumn to move the company from "operate_early" to "operate" at the end of the current (12th)
 * billing period. Operate costs more, so without `plan_schedule: "end_of_cycle"` Autumn would treat it as an
 * upgrade and charge the difference now; the end-of-cycle schedule is what keeps month 12 at $199.
 * Not yet exercised against Autumn: that `plan_schedule: "end_of_cycle"` holds back an upgrade within the
 * group until the period ends (the API reference lists it for attach; the lifecycle guide only describes
 * the default behaviour), and that the scheduled plan then shows as a `scheduled` subscription.
 */
export const scheduleSwitch = internalAction({
  args: { offerId: v.id("earlyOffers") },
  handler: async (ctx, args): Promise<void> => {
    const target = await ctx.runQuery(internal.earlyOffer.switchContext, { offerId: args.offerId });
    if (!target) return;
    const body = attachBody({ customerId: target.customerId, planId: AUTUMN.plans.operate, successUrl: `${appOrigin() ?? "https://app.selestial.io"}/app/settings/billing`, schedule: "end_of_cycle" });
    // One key per attempt after a refusal; a lost answer is asked again under the same key, so it is one change.
    const answer = await attach(body, `early-switch:${args.offerId}:${target.attempts}`);
    if ((answer.kind === "ok" && !answer.data.payment_url) || answer.kind === "replayed") {
      await ctx.runMutation(internal.earlyOffer.switchAnswered, { offerId: args.offerId, outcome: "sent" });
      // The move counts only once Autumn's record shows it scheduled (convex/lib/billing/earlyOffer.ts, onAccountSynced).
      await syncAccount(ctx, target.companyId);
      return;
    }
    const problem = answer.kind === "ok" ? "Autumn asked for a payment page instead of scheduling the move." : answer.kind === "refused" || answer.kind === "unavailable" ? answer.message : "Autumn did not confirm the move.";
    await ctx.runMutation(internal.earlyOffer.switchAnswered, { offerId: args.offerId, outcome: answer.kind === "refused" || answer.kind === "ok" ? "refused" : "unavailable", problem });
  },
});

export const switchAnswered = internalMutation({
  args: { offerId: v.id("earlyOffers"), outcome: v.union(v.literal("sent"), v.literal("refused"), v.literal("unavailable")), problem: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.offerId);
    if (!row || row.state !== "claimed") return;
    const now = Date.now();
    if (args.outcome === "sent") {
      await ctx.db.patch(row._id, { switchProblem: undefined, switchNextAt: now + SWITCH_VERIFY_MS, updatedAt: now });
      await recordEvent(ctx, { companyId: row.companyId, type: "billing.early_offer_switch_requested", actor: { kind: "system" }, subject: { table: "companies", id: row.companyId }, data: { offerEndsAt: row.offerEndsAt ?? null } });
      return;
    }
    const attempts = (row.switchAttempts ?? 0) + (args.outcome === "refused" ? 1 : 0);
    const wait = args.outcome === "refused" ? (SWITCH_BACKOFF[attempts - 1] ?? 6 * HOUR) : HOUR;
    await ctx.db.patch(row._id, { switchAttempts: attempts, switchProblem: (args.problem ?? "Autumn could not be reached.").slice(0, 300), switchNextAt: now + wait, updatedAt: now });
    await recordEvent(ctx, { companyId: row.companyId, type: "billing.early_offer_switch_failed", actor: { kind: "system" }, subject: { table: "companies", id: row.companyId }, data: { outcome: args.outcome, attempts } });
  },
});

// ── The Owner ────────────────────────────────────────────────────────────────────────────────────

/** Plan & Usage: whether the early-user price applies to this company, and what it says. Never $199 when it won't be honored. */
export const mine = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const state = billingState();
    if (!state.connected) return { kind: "none" as const };
    const account = await accountFor(ctx, ctx.companyId, state.env);
    return ownerOffer(ctx, ctx.companyId, state.env, account, Date.now());
  },
});

// ── Selestial staff ──────────────────────────────────────────────────────────────────────────────

/** Staff › Operations › Billing: places used out of 15, which companies hold them, and when each moves to $299. */
export const overview = staffQuery({
  args: {},
  handler: async (ctx) => {
    const state = billingState();
    const env = state.connected ? state.env : "sandbox";
    const now = Date.now();
    const rows: Doc<"earlyOffers">[] = [];
    for (const s of ["reserved", "claimed", "ended", "released"] as const) {
      rows.push(
        ...(await ctx.db
          .query("earlyOffers")
          .withIndex("by_env_state", (q) => q.eq("env", env).eq("state", s))
          .order("desc")
          .take(s === "released" ? 20 : 200)),
      );
    }
    const companies = new Map<Id<"companies">, string>();
    for (const row of rows) if (!companies.has(row.companyId)) companies.set(row.companyId, (await ctx.db.get(row.companyId))?.name ?? "Deleted company");
    const used = await placesUsed(ctx, env, now);
    return {
      env,
      places: EARLY_OFFER.places,
      used,
      claimed: rows.filter((row) => row.state === "claimed" || row.state === "ended").length,
      rows: rows.map((row) => ({
        id: row._id,
        company: companies.get(row.companyId) ?? "",
        state: row.state === "reserved" && row.reservedUntil <= now ? ("expired" as const) : row.state,
        reservedAt: row.reservedAt,
        reservedUntil: row.reservedUntil,
        claimedAt: row.claimedAt ?? null,
        offerEndsAt: row.offerEndsAt ?? null,
        switch: row.switchConfirmedAt ? ("scheduled" as const) : row.switchProblem ? ("failing" as const) : row.switchRequestedAt ? ("requested" as const) : ("not_yet" as const),
        switchProblem: row.switchProblem ?? null,
        reminderSentAt: row.reminderSentAt ?? null,
        endedAt: row.endedAt ?? null,
        endReason: row.endReason ?? null,
        releaseReason: row.releaseReason ?? null,
      })),
    };
  },
});

/**
 * Gives back a place that was reserved and never paid (for example an Owner who said they won't pay). A
 * claimed place is never released: it was paid for, and stays used after cancellation. If the company
 * pays later anyway, Autumn's record is honored and the place is claimed again.
 */
export const release = staffMutation({
  capability: "billing.adjust",
  args: { offerId: v.id("earlyOffers"), reason: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.offerId);
    if (!row) notFound();
    if (row.state !== "reserved") throw userError(row.state === "released" ? "That place was already released." : "Only a place that was reserved and never paid can be released. A paid place stays used.");
    const reason = text(args.reason, "The reason", 300);
    if (reason.length < 5) throw userError("Say why the place is being released.");
    const now = Date.now();
    // Who released it, and why, stays on the row (releasedBy, releaseReason) for the staff view.
    await releasePlace(ctx, row, reason, ctx.staff._id, now);
    await recordEvent(ctx, { companyId: row.companyId, type: "billing.early_offer_released", actor: { kind: "system" }, subject: { table: "companies", id: row.companyId }, data: { reason: "staff", staffId: ctx.staff._id } });
    return null;
  },
});

/** For tests and the staff view: the row for one company. */
export const offerOf = internalQuery({
  args: { companyId: v.id("companies"), env: v.union(v.literal("sandbox"), v.literal("production")) },
  handler: async (ctx, args) => offerFor(ctx, args.companyId, args.env),
});
