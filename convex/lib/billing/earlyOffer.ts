/**
 * The early-user offer (the Owner's approval of November 22, 2026; docs/billing/README.md, "Early-user offer").
 *
 *   $199 a month for the first 12 months, for the first 25 companies whose FIRST plan payment succeeds.
 *   Then $299, moved automatically at the end of the 12th billing period. A company that ever held a place
 *   never gets the price again, and its place is never handed to anyone else: 15 means 15 ever granted.
 *
 * How a place is used, exactly:
 *
 *   1. Preview. An Owner with no plan, whose company never had a paid plan and never held a place, opens the
 *      purchase while fewer than 25 places are used: the purchase is previewed as Autumn's "operate_early"
 *      plan ($199). Otherwise it is previewed as "operate" ($299). Nothing is reserved yet.
 *   2. Confirm. When the Owner confirms, the confirming mutation reserves a place. Convex runs mutations
 *      serializably, so this is the one point where two companies racing for the last place are decided:
 *      the second finds 15 used, its purchase is NOT sent at $199, and it is previewed again at $299 with
 *      words saying the last place was just taken. Nobody is charged a price they were not shown.
 *   3. Pay. Only a reserved purchase is attached as "operate_early". The place is CLAIMED when Autumn's record
 *      (read by storeAccount after the purchase, a webhook or a refresh) shows "operate_early" active. Autumn
 *      activates a plan on payment by default, so active means the first payment succeeded.
 *   4. Abandon. A reservation whose purchase failed is released at once. One that went to a payment page and
 *      was never paid is released once that page can no longer be paid (RESERVE_MS), or by staff.
 *
 * Used places = claimed + ended + reserved-and-not-expired. A payment that Autumn reports for "operate_early"
 * is always honored (the company pays what it was charged), even if staff released its reservation early.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { AutumnEnv } from "./autumn";
import { AUTUMN, EARLY_BONUS_AGENTS, EARLY_OFFER, PLANS } from "./catalog";
import type { Projection } from "./projection";

const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/**
 * How long a reserved place waits for its payment. Matches the 24 hours a payment page stays open
 * (PAYMENT_WINDOW in convex/billing.ts). Not yet exercised against Autumn: that Autumn's Stripe checkout
 * session expires within 24 hours is Stripe's default, not something Autumn documents.
 */
export const RESERVE_MS = 24 * HOUR;
/** The one reminder goes this long before the price changes. */
export const REMINDER_BEFORE_MS = 30 * DAY;
/** Autumn's period end and Selestial's 12-month date may differ by rounding; this much is the same day. */
export const PERIOD_SLACK_MS = DAY;

/** `at` plus `months` calendar months in UTC, kept to the last day of a shorter month (Stripe's own rule). */
export function addMonthsUTC(at: number, months: number): number {
  const date = new Date(at);
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.getTime();
}

export async function offerFor(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">, env: AutumnEnv): Promise<Doc<"earlyOffers"> | null> {
  return ctx.db
    .query("earlyOffers")
    .withIndex("by_company_env", (q) => q.eq("companyId", companyId).eq("env", env))
    .unique();
}

/** Places used in this environment: claimed, ended, and reservations still waiting for their payment. */
export async function placesUsed(ctx: QueryCtx | MutationCtx, env: AutumnEnv, now: number): Promise<number> {
  let used = 0;
  for (const state of ["claimed", "ended"] as const) {
    used += (
      await ctx.db
        .query("earlyOffers")
        .withIndex("by_env_state", (q) => q.eq("env", env).eq("state", state))
        .take(200)
    ).length;
  }
  const reserved = await ctx.db
    .query("earlyOffers")
    .withIndex("by_env_state", (q) => q.eq("env", env).eq("state", "reserved"))
    .take(200);
  return used + reserved.filter((row) => row.reservedUntil > now).length;
}

export type Eligibility = { eligible: boolean; placesLeft: number; reason: "eligible" | "off" | "full" | "held_before" | "paid_before" | "has_plan" };

/**
 * The offer is sold only once it is switched on: EARLY_OFFER=on on the Convex deployment. Off by default,
 * because the "operate_early" plan must exist in Autumn first (cd billing && npx atmn push); attaching a plan
 * Autumn does not know would fail the purchase. While off, every company is offered Operate at $299, nothing
 * shows the offer, and places already held keep working (claims, the month-12 move and reminders still run).
 */
export function earlyOfferOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.EARLY_OFFER?.trim().toLowerCase() === "on";
}

/**
 * Whether this company would be offered $199 now. A company that reserved a place itself and has not paid
 * yet keeps its own reservation (it is not counted against it).
 */
export async function eligibility(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">, env: AutumnEnv, account: Doc<"billingAccounts"> | null, now: number): Promise<Eligibility> {
  const used = await placesUsed(ctx, env, now);
  const row = await offerFor(ctx, companyId, env);
  const mine = row?.state === "reserved" && row.reservedUntil > now;
  const placesLeft = Math.max(0, EARLY_OFFER.places - used);
  const no = (reason: Eligibility["reason"]): Eligibility => ({ eligible: false, placesLeft, reason });
  // Claimed or ended: the company held a place. A reservation that was never paid (released or expired) is not holding one.
  if (row && (row.state === "claimed" || row.state === "ended")) return no("held_before");
  // Switched off: no new place is offered, though a reservation already made is still honoured.
  if (!earlyOfferOn() && !mine) return no("off");
  if (account?.plan) return no("has_plan");
  // A company that ever paid for a plan is not a first payment. Top-ups need a plan, so any paid invoice means one.
  if (account?.invoices.some((invoice) => invoice.status === "paid" && invoice.cents > 0)) return no("paid_before");
  if (!mine && placesLeft <= 0) return no("full");
  return { eligible: true, placesLeft, reason: "eligible" };
}

/**
 * Reserves a place for this company's confirmed purchase. Must run inside the confirming mutation: that
 * transaction is the single point where the last place is decided. True when the company holds a place.
 */
export async function reservePlace(ctx: MutationCtx, input: { companyId: Id<"companies">; env: AutumnEnv; intentId: Id<"billingIntents">; account: Doc<"billingAccounts"> | null; now: number }): Promise<boolean> {
  const verdict = await eligibility(ctx, input.companyId, input.env, input.account, input.now);
  if (!verdict.eligible) return false;
  const row = await offerFor(ctx, input.companyId, input.env);
  const fields = { state: "reserved" as const, intentId: input.intentId, reservedAt: input.now, reservedUntil: input.now + RESERVE_MS, releasedAt: undefined, releaseReason: undefined, releasedBy: undefined, updatedAt: input.now };
  if (row) await ctx.db.patch(row._id, fields);
  else await ctx.db.insert("earlyOffers", { companyId: input.companyId, env: input.env, ...fields });
  return true;
}

/** Gives back a place that was reserved and never paid. A claimed place is never released. */
export async function releasePlace(ctx: MutationCtx, row: Doc<"earlyOffers">, reason: string, by: Id<"staff"> | "system", now: number): Promise<boolean> {
  if (row.state !== "reserved") return false;
  await ctx.db.patch(row._id, { state: "released", releasedAt: now, releaseReason: reason.slice(0, 300), releasedBy: by, updatedAt: now });
  return true;
}

/**
 * Called whenever Selestial's copy of Autumn's record is refreshed (storeAccount). Claims a place when the
 * $199 plan shows active, notices the month-12 move once Autumn shows it scheduled, and ends the offer when
 * the company moved to the full price or cancelled. Returns what changed, for the event log.
 */
/**
 * Gives a company that claimed an early-user place its bonus agents, once. It is never taken back by the
 * offer ending: early users keep Quality after their 12 months (the Owner's decision of November 23, 2026).
 */
export async function grantEarlyBonus(ctx: MutationCtx, companyId: Id<"companies">, since: number): Promise<boolean> {
  const company = await ctx.db.get(companyId);
  if (!company) return false;
  const have = company.agentBonuses ?? [];
  const add = EARLY_BONUS_AGENTS.filter((agent) => !have.some((bonus) => bonus.agent === agent));
  if (!add.length) return false;
  await ctx.db.patch(companyId, { agentBonuses: [...have, ...add.map((agent) => ({ agent, reason: "early_user" as const, since }))] });
  return true;
}

export async function onAccountSynced(ctx: MutationCtx, input: { companyId: Id<"companies">; env: AutumnEnv; projection: Projection; now: number }): Promise<"claimed" | "switch_confirmed" | "ended" | null> {
  const { projection, now } = input;
  const row = await offerFor(ctx, input.companyId, input.env);
  // A place claimed before the bonus existed gets it on the next sync.
  if (row?.claimedAt !== undefined) await grantEarlyBonus(ctx, input.companyId, row.claimedAt);
  const onEarly = projection.plan !== null && projection.autumnPlanId === AUTUMN.earlyPlan;
  if (onEarly) {
    if (!row || row.state === "reserved" || row.state === "released") {
      // The first plan payment succeeded. Autumn's subscription start is used when it is plausible for a
      // purchase that just happened; otherwise now. Not yet exercised against Autumn: that `started_at` is
      // the start of the first paid period.
      const started = projection.subscription.startedAt;
      const startedAt = started !== null && started <= now && started > now - 40 * DAY ? started : now;
      const fields = { state: "claimed" as const, claimedAt: now, startedAt, offerEndsAt: addMonthsUTC(startedAt, EARLY_OFFER.months), updatedAt: now };
      if (row) await ctx.db.patch(row._id, fields);
      else await ctx.db.insert("earlyOffers", { companyId: input.companyId, env: input.env, reservedAt: now, reservedUntil: now, ...fields });
      await grantEarlyBonus(ctx, input.companyId, now);
      return "claimed";
    }
    if (row.state === "claimed" && !row.switchConfirmedAt && projection.subscription.scheduledAutumnPlanId === AUTUMN.plans.operate) {
      await ctx.db.patch(row._id, { switchConfirmedAt: now, switchProblem: undefined, switchNextAt: undefined, updatedAt: now });
      return "switch_confirmed";
    }
    if (row.state === "claimed" && row.switchConfirmedAt && projection.subscription.endsAt === null && projection.subscription.scheduledAutumnPlanId !== AUTUMN.plans.operate) {
      // The move that was scheduled is no longer on Autumn's record (for example a cancellation that was taken
      // back cleared it). It is asked for again, under a new key, by the next sweep.
      await ctx.db.patch(row._id, { switchConfirmedAt: undefined, switchRequestedAt: undefined, switchNextAt: undefined, switchAttempts: (row.switchAttempts ?? 0) + 1, updatedAt: now });
      return null;
    }
    return null;
  }
  if (row?.state === "claimed") {
    const reason = projection.plan === null ? ("cancelled" as const) : ("moved_to_full_price" as const);
    await ctx.db.patch(row._id, { state: "ended", endedAt: now, endReason: reason, updatedAt: now });
    return "ended";
  }
  return null;
}

/** What the Owner is told about the offer, in one place, so the screen never shows $199 when it won't be honored. */
export type OwnerOffer =
  | { kind: "none" }
  | { kind: "available"; placesLeft: number; places: number; monthlyCents: number; fullCents: number; months: number }
  | { kind: "reserved"; until: number; monthlyCents: number; fullCents: number; months: number }
  | { kind: "active"; endsAt: number; monthlyCents: number; fullCents: number; switchScheduled: boolean; ending: boolean };

export async function ownerOffer(ctx: QueryCtx, companyId: Id<"companies">, env: AutumnEnv, account: Doc<"billingAccounts"> | null, now: number): Promise<OwnerOffer> {
  const base = { monthlyCents: EARLY_OFFER.monthlyCents, fullCents: PLANS[EARLY_OFFER.plan].monthlyCents };
  const row = await offerFor(ctx, companyId, env);
  if (row?.state === "claimed" && row.offerEndsAt && account?.autumnPlanId === AUTUMN.earlyPlan) {
    return { kind: "active", endsAt: row.offerEndsAt, ...base, switchScheduled: row.switchConfirmedAt !== undefined, ending: account.subscription.endsAt !== null };
  }
  if (account?.plan) return { kind: "none" };
  if (row?.state === "reserved" && row.reservedUntil > now) return { kind: "reserved", until: row.reservedUntil, ...base, months: EARLY_OFFER.months };
  const verdict = await eligibility(ctx, companyId, env, account, now);
  if (!verdict.eligible) return { kind: "none" };
  return { kind: "available", placesLeft: verdict.placesLeft, places: EARLY_OFFER.places, ...base, months: EARLY_OFFER.months };
}
