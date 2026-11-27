/**
 * Cancel subscription, and the two retention offers (docs/billing/05-cancellation.md; the rules are in
 * convex/lib/billing/retention.ts).
 *
 * The Owner opens a flow. Opening it, answering its questions and seeing an offer change nothing in billing
 * and use up nothing. The server reads Stripe's subscription itself (never anything the browser sends) and
 * says which offers can be made and their exact terms. Accepting checks those terms again in the accepting
 * mutation, against the same facts the Owner saw, and records the offer once: Convex mutations are
 * serializable, so a second tab or a double click finds it already taken. The billing change then runs in
 * an action under keys derived from that record, and the offer counts as applied only once Stripe's
 * subscription, read back, carries its coupon.
 *
 * Cancelling and reactivating are the existing billing intents (convex/billing.ts cancelPlan, resumePlan):
 * Autumn's `cancel_end_of_cycle` and `uncancel`, idempotent by intent, shown as done only once Autumn's
 * record says so.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { accountFor, billingState, customerIdFor } from "./lib/billing/access";
import type { AutumnEnv } from "./lib/billing/autumn";
import { AUTUMN } from "./lib/billing/catalog";
import { offerFor } from "./lib/billing/earlyOffer";
import { customerHintOfCustomer } from "./lib/billing/lock";
import {
  accountProblem,
  CANCEL_REASON_WORDS,
  CANCEL_REASONS,
  customerWords,
  DETAIL_QUESTIONS,
  hasCoupon,
  INELIGIBLE_WORDS,
  OFFER_IDS,
  OFFER_PLANS,
  OFFERS,
  offerVerdict,
  PREVIEW_TTL_MS,
  remaining,
  RETENTION_POLICY,
  STAY_NEED_WORDS,
  STAY_NEEDS,
  type EligibilityInput,
  type Ineligible,
  type OfferId,
  type OfferVerdict,
  type SubscriptionFacts,
} from "./lib/billing/retention";
import { offerIdValidator } from "./lib/billing/schema";
import { ownerMutation, ownerQuery, staffQuery } from "./lib/builders";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { applyRetentionCoupon, createRetentionCoupon, getPlatformCustomer, getPlatformSubscription, listPlatformSubscriptions, searchPlatformCustomers, stripeConfig, type RawPlatformSubscription } from "./lib/finance/stripe";
import { notifyMembers } from "./lib/notify/route";
import { allow } from "./lib/rateLimit";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Stripe asked again after these waits, under the same Idempotency-Keys, when it didn't answer. */
const RETRY = [1, 5, 15].map((minutes) => minutes * MINUTE);
/** An offer Stripe never confirmed is checked hourly; after this long it is closed as failed and shown to staff. */
const GIVE_UP_MS = 2 * DAY;

/** Where a person can get real help with setup or reliability. The same address the tutorials use. */
export const SUPPORT_EMAIL = "support@selestial.io";

/**
 * Retention offers are made only once switched on: RETENTION_OFFERS=on on the Convex deployment. Off by
 * default, so nothing is offered until the sandbox checks in docs/billing/05-cancellation.md pass. While off,
 * cancelling works exactly the same and no offer is shown.
 */
export function offersOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.RETENTION_OFFERS?.trim().toLowerCase() === "on";
}
/** Offers that run past the end of an early-user year: off until the month-12 move is verified with a discount on. */
export function acrossPriceChangeOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.RETENTION_ACROSS_PRICE_CHANGE?.trim().toLowerCase() === "on";
}

// ── The facts, read from Stripe by the server ────────────────────────────────────────────────────

const idOf = (value: string | { id: string } | null | undefined): string | null => (typeof value === "string" ? value : (value?.id ?? null));

/** Stripe's subscription reduced to what the rules use, whichever API version answered. */
export function subscriptionFacts(sub: RawPlatformSubscription, stripeCustomerId: string, now: number): SubscriptionFacts {
  const items = (sub.items?.data ?? []).filter((item) => item.price && item.price.recurring && item.price.recurring.usage_type !== "metered" && (item.price.unit_amount ?? 0) > 0);
  if (items.length !== 1) return { ok: false, fetchedAt: now, reason: "no_subscription" };
  const item = items[0];
  const price = item.price!;
  const periodEndS = sub.current_period_end ?? item.current_period_end ?? null;
  const discounts = sub.discounts ?? (sub.discount ? [sub.discount] : []);
  const discountIds = discounts.map((row) => idOf(row)).filter((id): id is string => !!id);
  const couponIds = discounts
    .map((row) => (typeof row === "string" ? null : (idOf(row.coupon ?? null) ?? idOf((row as { source?: { coupon?: string | { id: string } | null } | null }).source?.coupon ?? null))))
    .filter((id): id is string => !!id);
  return {
    ok: true,
    fetchedAt: now,
    livemode: sub.livemode === true,
    stripeCustomerId,
    subscriptionId: sub.id,
    status: sub.status,
    currency: (sub.currency ?? price.currency ?? "").toLowerCase(),
    interval: price.recurring?.interval ?? "",
    intervalCount: price.recurring?.interval_count ?? 0,
    baseItemId: item.id,
    basePriceId: price.id,
    baseProductId: idOf(price.product ?? null) ?? "",
    baseCents: (price.unit_amount ?? 0) * (item.quantity ?? 1),
    periodEnd: periodEndS ? periodEndS * 1000 : 0,
    anchorAt: (sub.billing_cycle_anchor ?? periodEndS ?? 0) * 1000,
    discountIds,
    couponIds,
    scheduleId: idOf(sub.schedule ?? null),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    trialEnd: sub.trial_end ? sub.trial_end * 1000 : null,
  };
}

/** Finds the company's plan subscription in Stripe: through its Stripe customer, checked against Autumn's id. */
async function readFacts(target: { env: AutumnEnv; customerId: string; stripeCustomerId: string | null }, now: number): Promise<SubscriptionFacts> {
  const config = stripeConfig();
  if (!config) return { ok: false, fetchedAt: now, reason: "stripe_off" };
  // A sandbox (Autumn test key) never touches live Stripe, and production never touches test mode.
  if (config.livemode !== (target.env === "production")) return { ok: false, fetchedAt: now, reason: "stripe_env_mismatch" };
  let stripeCustomerId = target.stripeCustomerId;
  if (stripeCustomerId) {
    const customer = await getPlatformCustomer(stripeCustomerId);
    if (customer.kind === "unavailable") return { ok: false, fetchedAt: now, reason: "stripe_unavailable" };
    if (customer.kind !== "ok" || customer.data.deleted || customerHintOfCustomer(customer.data) !== target.customerId) stripeCustomerId = null;
  }
  if (!stripeCustomerId) {
    const found = await searchPlatformCustomers(target.customerId);
    if (found.kind === "unavailable") return { ok: false, fetchedAt: now, reason: "stripe_unavailable" };
    if (found.kind !== "ok") return { ok: false, fetchedAt: now, reason: "no_customer" };
    // The metadata must name this company exactly; a search is only a pointer.
    const matches = found.data.data.filter((row) => !row.deleted && customerHintOfCustomer(row) === target.customerId);
    if (matches.length !== 1) return { ok: false, fetchedAt: now, reason: "no_customer" };
    stripeCustomerId = matches[0].id;
  }
  const list = await listPlatformSubscriptions(stripeCustomerId);
  if (list.kind === "unavailable") return { ok: false, fetchedAt: now, reason: "stripe_unavailable" };
  if (list.kind !== "ok") return { ok: false, fetchedAt: now, reason: "no_subscription" };
  const live = list.data.data.filter((row) => !["canceled", "incomplete_expired", "incomplete"].includes(row.status));
  if (live.length === 0) return { ok: false, fetchedAt: now, reason: "no_subscription" };
  if (live.length > 1) return { ok: false, fetchedAt: now, reason: "several_subscriptions" };
  return subscriptionFacts(live[0], stripeCustomerId, now);
}

// ── Eligibility, from Selestial's records and the facts ──────────────────────────────────────────

async function eligibilityInput(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">, env: AutumnEnv, facts: SubscriptionFacts | null, now: number, ignore?: Id<"retentionOffers">): Promise<EligibilityInput> {
  const account = await accountFor(ctx, companyId, env);
  const company = await ctx.db.get(companyId);
  const early = await offerFor(ctx, companyId, env);
  const recent = (
    await ctx.db
      .query("retentionOffers")
      .withIndex("by_company_accepted", (q) => q.eq("companyId", companyId))
      .order("desc")
      .take(20)
  ).filter((row) => row.env === env && row._id !== ignore);
  const counted = recent.filter((row) => row.state !== "failed");
  return {
    now,
    billingConnected: billingState().connected,
    account: account ? { plan: account.plan, autumnPlanId: account.autumnPlanId ?? null, pastDue: account.subscription.pastDue, periodEnd: account.subscription.periodEnd, endsAt: account.subscription.endsAt, scheduledAutumnPlanId: account.subscription.scheduledAutumnPlanId ?? null } : null,
    locked: company?.billingLockedAt !== undefined,
    earlyEndsAt: early?.state === "claimed" && early.offerEndsAt ? early.offerEndsAt : null,
    facts,
    lastAcceptedAt: counted[0]?.acceptedAt ?? null,
    inFlight: recent.some((row) => row.state === "pending"),
    acrossPriceChange: acrossPriceChangeOn(),
  };
}

function verdicts(input: EligibilityInput): Record<OfferId, OfferVerdict> {
  if (!offersOn()) return { save10_once: { eligible: false, reason: "billing_off" }, save15_three: { eligible: false, reason: "billing_off" } };
  return { save10_once: offerVerdict("save10_once", input), save15_three: offerVerdict("save15_three", input) };
}

async function flowOf(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">, flowId: Id<"cancelFlows">): Promise<Doc<"cancelFlows">> {
  const flow = await ctx.db.get(flowId);
  if (!flow || flow.companyId !== companyId) throw userError("That cancellation wasn't found. Close this and start again.", "not_found");
  return flow;
}

// ── The Owner's flow ─────────────────────────────────────────────────────────────────────────────

/** Opens "Cancel subscription". Records that it started, asks Stripe for the facts, changes nothing in billing. */
export const start = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const state = billingState();
    if (!state.connected) throw userError("Billing isn’t available yet.", "limit");
    if (!(await allow(ctx, `cancel-flow:${ctx.companyId}`, 12, 10 * MINUTE))) throw userError("That is a lot of tries in a few minutes. Wait a moment and try again.", "limit");
    const account = await accountFor(ctx, ctx.companyId, state.env);
    if (!account?.plan) throw userError("There is no active plan to cancel.");
    const now = Date.now();
    const autumnPlanId = account.autumnPlanId ?? account.plan;
    const flowId = await ctx.db.insert("cancelFlows", { companyId: ctx.companyId, env: state.env, memberId: ctx.member._id, policy: RETENTION_POLICY, autumnPlanId, planCents: OFFER_PLANS[autumnPlanId]?.cents ?? null, offers: [], startedAt: now, updatedAt: now });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "billing.cancel_flow_started", actor: byMember(ctx), subject: { table: "cancelFlows", id: flowId }, data: { autumnPlanId } });
    // Stripe is read only when an offer could follow; a company that can't get one goes straight on.
    const early = accountProblem(await eligibilityInput(ctx, ctx.companyId, state.env, { ok: false, fetchedAt: now, reason: "stripe_unavailable" }, now));
    if (offersOn() && (early === "stripe_unavailable" || early === null)) {
      await ctx.db.patch(flowId, { factsAskedAt: now });
      await ctx.scheduler.runAfter(0, internal.cancellation.loadFacts, { flowId });
    } else {
      await ctx.db.patch(flowId, { eligible: false, ineligible: offersOn() ? (early ?? undefined) : "billing_off" });
    }
    return flowId;
  },
});

/** Reads Stripe again for this flow: the preview expired, or the terms changed. */
export const recheck = ownerMutation({
  args: { flowId: v.id("cancelFlows") },
  handler: async (ctx, args) => {
    const flow = await flowOf(ctx, ctx.companyId, args.flowId);
    if (!offersOn()) return null;
    if (flow.factsAskedAt && Date.now() - flow.factsAskedAt < 10_000) return null;
    await ctx.db.patch(flow._id, { factsAskedAt: Date.now(), updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.cancellation.loadFacts, { flowId: flow._id });
    return null;
  },
});

/** The answers. Every question is optional: nothing is required to cancel. */
export const answer = ownerMutation({
  args: {
    flowId: v.id("cancelFlows"),
    step: v.union(v.literal("reason"), v.literal("need"), v.literal("detail"), v.literal("skip")),
    code: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const flow = await flowOf(ctx, ctx.companyId, args.flowId);
    const note = args.note?.trim().slice(0, 1000) || undefined;
    const now = Date.now();
    if (args.step === "skip") {
      await ctx.db.patch(flow._id, { skipped: true, updatedAt: now });
      return null;
    }
    if (args.step === "detail") {
      if (!flow.reason || !DETAIL_QUESTIONS[flow.reason]) throw userError("There is no follow-up question for this answer.");
      await ctx.db.patch(flow._id, { reasonDetail: note, updatedAt: now });
      return null;
    }
    if (args.step === "reason") {
      if (args.code !== undefined && !(CANCEL_REASONS as readonly string[]).includes(args.code)) throw userError("Choose one of the listed reasons.");
      await ctx.db.patch(flow._id, { reason: args.code as Doc<"cancelFlows">["reason"], reasonNote: note, updatedAt: now });
    } else {
      if (args.code !== undefined && !(STAY_NEEDS as readonly string[]).includes(args.code)) throw userError("Choose one of the listed answers.");
      await ctx.db.patch(flow._id, { need: args.code as Doc<"cancelFlows">["need"], needNote: note, updatedAt: now });
    }
    await recordEvent(ctx, { companyId: ctx.companyId, type: `billing.cancel_flow_${args.step}`, actor: byMember(ctx), subject: { table: "cancelFlows", id: flow._id }, data: { code: args.code ?? null } });
    return null;
  },
});

/** An offer was shown, or the Owner went on without it. Neither uses eligibility. */
export const offerSeen = ownerMutation({
  args: { flowId: v.id("cancelFlows"), offerId: offerIdValidator, outcome: v.union(v.literal("viewed"), v.literal("declined")) },
  handler: async (ctx, args) => {
    const flow = await flowOf(ctx, ctx.companyId, args.flowId);
    if (flow.offers.some((row) => row.offerId === args.offerId && (row.outcome === args.outcome || row.outcome === "accepted"))) return null;
    await ctx.db.patch(flow._id, { offers: [...flow.offers, { offerId: args.offerId, at: Date.now(), outcome: args.outcome }].slice(-10), updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: ctx.companyId, type: `billing.retention_offer_${args.outcome}`, actor: byMember(ctx), subject: { table: "cancelFlows", id: flow._id }, data: { offerId: args.offerId } });
    return null;
  },
});

/** "Keep my subscription": the flow ends with nothing changed. */
export const keep = ownerMutation({
  args: { flowId: v.id("cancelFlows") },
  handler: async (ctx, args) => {
    const flow = await flowOf(ctx, ctx.companyId, args.flowId);
    if (!flow.outcome) {
      await ctx.db.patch(flow._id, { outcome: "kept", updatedAt: Date.now() });
      await recordEvent(ctx, { companyId: ctx.companyId, type: "billing.cancel_flow_kept", actor: byMember(ctx), subject: { table: "cancelFlows", id: flow._id } });
    }
    return null;
  },
});

/**
 * Accepts an offer at exactly the terms shown (`version`). The terms are worked out again here from the facts
 * the server read; if they differ, or are older than the preview allows, nothing is accepted and the Owner
 * sees the current terms. Two tabs, or a double click: the second finds the first already recorded.
 */
export const accept = ownerMutation({
  args: { flowId: v.id("cancelFlows"), offerId: offerIdValidator, version: v.string() },
  handler: async (ctx, args) => {
    const flow = await flowOf(ctx, ctx.companyId, args.flowId);
    const now = Date.now();
    if (!offersOn()) throw userError("This offer isn’t available.");
    const existing = (
      await ctx.db
        .query("retentionOffers")
        .withIndex("by_company_accepted", (q) => q.eq("companyId", ctx.companyId))
        .order("desc")
        .take(5)
    ).find((row) => row.flowId === flow._id && row.state !== "failed");
    // The same flow accepting again (a second click, a retry after a lost answer) gets the same offer back.
    if (existing) {
      if (existing.offerId !== args.offerId) throw userError("You’ve already accepted an offer. The two offers can’t be combined.");
      return existing._id;
    }
    const facts = (flow.facts ?? null) as SubscriptionFacts | null;
    // Too old to rely on: nothing is accepted. (A refusal discards this mutation's writes, so the screen asks
    // for a fresh read itself, through `recheck`, whenever the terms it shows are stale.)
    if (!facts || !facts.ok || now - facts.fetchedAt > PREVIEW_TTL_MS) throw userError("We’re checking your billing details again. Review the terms once they update, then accept.", "invalid");
    const input = await eligibilityInput(ctx, ctx.companyId, flow.env, facts, now);
    const verdict = offerVerdict(args.offerId, input);
    if (!verdict.eligible) throw userError(customerWords(verdict.reason) ?? "This offer isn’t available for your subscription any more. You can still keep or cancel your subscription.");
    if (verdict.preview.version !== args.version) throw userError("Your billing details changed, so the terms changed. Review the updated terms before you accept.", "invalid");
    const preview = verdict.preview;
    const rowId = await ctx.db.insert("retentionOffers", {
      companyId: ctx.companyId,
      env: flow.env,
      flowId: flow._id,
      memberId: ctx.member._id,
      offerId: args.offerId,
      policy: RETENTION_POLICY,
      version: preview.version,
      percent: preview.percent,
      autumnPlanId: input.account!.autumnPlanId!,
      currency: preview.currency,
      renewals: preview.renewals,
      resumesAt: preview.resumesAt,
      resumesCents: preview.resumesCents,
      state: "pending",
      stripeCustomerId: facts.stripeCustomerId,
      stripeSubscriptionId: facts.subscriptionId,
      stripeProductId: facts.baseProductId,
      attempts: 0,
      acceptedAt: now,
      invoices: [],
      events: [],
      updatedAt: now,
    });
    await ctx.db.patch(flow._id, { offers: [...flow.offers, { offerId: args.offerId, at: now, outcome: "accepted" as const }].slice(-10), outcome: "offer_accepted", updatedAt: now });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "billing.retention_offer_accepted", actor: byMember(ctx), subject: { table: "retentionOffers", id: rowId }, data: { offerId: args.offerId, version: preview.version, savingsCents: preview.savingsCents } });
    await ctx.scheduler.runAfter(0, internal.cancellation.applyOffer, { offerRowId: rowId });
    return rowId;
  },
});

/** Everything the modal shows, worked out on the server. */
export const flow = ownerQuery({
  args: { flowId: v.id("cancelFlows") },
  handler: async (ctx, args) => {
    const flow = await ctx.db.get(args.flowId);
    if (!flow || flow.companyId !== ctx.companyId) return null;
    const now = Date.now();
    const account = await accountFor(ctx, ctx.companyId, flow.env);
    const facts = (flow.facts ?? null) as SubscriptionFacts | null;
    const input = await eligibilityInput(ctx, ctx.companyId, flow.env, facts, now);
    const offers = verdicts(input);
    const accepted = (
      await ctx.db
        .query("retentionOffers")
        .withIndex("by_company_accepted", (q) => q.eq("companyId", ctx.companyId))
        .order("desc")
        .take(5)
    ).find((row) => row.flowId === flow._id);
    const intents = (
      await ctx.db
        .query("billingIntents")
        .withIndex("by_company_created", (q) => q.eq("companyId", ctx.companyId).gte("createdAt", flow.startedAt))
        .order("desc")
        .take(10)
    ).filter((row) => row.flowId === flow._id);
    const cancel = intents.find((row) => row.kind === "cancel") ?? null;
    const uncancel = intents.find((row) => row.kind === "uncancel") ?? null;
    const plan = account?.autumnPlanId ? OFFER_PLANS[account.autumnPlanId] : null;
    const early = await offerFor(ctx, ctx.companyId, flow.env);
    const offerView = (id: OfferId) => {
      const verdict = offers[id];
      return verdict.eligible ? { eligible: true as const, ...verdict.preview, stale: now > verdict.preview.expiresAt } : { eligible: false as const, words: customerWords(verdict.reason) };
    };
    return {
      id: flow._id,
      reason: flow.reason ?? null,
      reasonNote: flow.reasonNote ?? null,
      need: flow.need ?? null,
      needNote: flow.needNote ?? null,
      outcome: flow.outcome ?? null,
      /** Stripe is still being read: the offers aren't decided yet. */
      checking: offersOn() && flow.factsAskedAt !== undefined && (!facts || facts.fetchedAt < flow.factsAskedAt),
      support: { email: SUPPORT_EMAIL },
      /** The follow-up question for setup or reliability reasons, shown beside the offer, and its answer so far. */
      detail: flow.reason && DETAIL_QUESTIONS[flow.reason] ? { question: DETAIL_QUESTIONS[flow.reason]!, answer: flow.reasonDetail ?? null } : null,
      plan: {
        name: plan?.name ?? (account?.plan === "expand" ? "Expand" : "Operate"),
        monthlyCents: plan?.cents ?? null,
        periodEnd: account?.subscription.periodEnd ?? null,
        endsAt: account?.subscription.endsAt ?? null,
        pastDue: account?.subscription.pastDue ?? false,
        active: !!account?.plan,
        earlyEndsAt: early?.state === "claimed" && account?.autumnPlanId === AUTUMN.earlyPlan ? (early.offerEndsAt ?? null) : null,
      },
      offers: { save10_once: offerView("save10_once"), save15_three: offerView("save15_three") },
      accepted: accepted
        ? { id: accepted._id, offerId: accepted.offerId, state: accepted.state, percent: accepted.percent, renewals: accepted.renewals, resumesAt: accepted.resumesAt, resumesCents: accepted.resumesCents, termsChanged: accepted.termsChanged ?? false, problem: accepted.state === "failed" || accepted.state === "unconfirmed" ? (accepted.problem ?? null) : null }
        : null,
      cancel: cancel ? { id: cancel._id, stage: cancel.stage, problem: cancel.problem ?? null } : null,
      uncancel: uncancel ? { id: uncancel._id, stage: uncancel.stage, problem: uncancel.problem ?? null } : null,
    };
  },
});

/** Plan & usage: the retention offer in force, and what the next subscription payment will be. */
export const status = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const state = billingState();
    if (!state.connected) return null;
    const now = Date.now();
    const account = await accountFor(ctx, ctx.companyId, state.env);
    const rows = (
      await ctx.db
        .query("retentionOffers")
        .withIndex("by_company_accepted", (q) => q.eq("companyId", ctx.companyId))
        .order("desc")
        .take(5)
    ).filter((row) => row.env === state.env);
    const current = rows.find((row) => row.state === "applied" || row.state === "pending" || row.state === "unconfirmed") ?? null;
    const left = current ? remaining(current.renewals, now) : [];
    const plan = account?.autumnPlanId ? OFFER_PLANS[account.autumnPlanId] : null;
    const early = await offerFor(ctx, ctx.companyId, state.env);
    const earlyEndsAt = early?.state === "claimed" && account?.autumnPlanId === AUTUMN.earlyPlan ? (early.offerEndsAt ?? null) : null;
    const nextAt = account?.subscription.periodEnd ?? null;
    const discounted = current?.state === "applied" ? left.find((row) => nextAt !== null && Math.abs(row.at - nextAt) <= DAY) : undefined;
    const nextBase = plan && nextAt !== null ? (earlyEndsAt !== null && nextAt >= earlyEndsAt - DAY ? OFFER_PLANS[AUTUMN.plans.operate].cents : plan.cents) : null;
    return {
      offer: current && left.length ? { state: current.state, percent: current.percent, renewalsLeft: left.length, renewals: left, resumesAt: current.resumesAt, resumesCents: current.resumesCents } : null,
      /** The next subscription payment before tax, when the plan renews. Usage is billed apart. */
      next: account?.plan && !account.subscription.endsAt && nextAt !== null && nextBase !== null ? { at: nextAt, cents: discounted ? discounted.totalCents : nextBase, discounted: !!discounted } : null,
      earlyEndsAt,
      endsAt: account?.subscription.endsAt ?? null,
    };
  },
});

// ── Reading Stripe, applying the offer ───────────────────────────────────────────────────────────

export const factsTarget = internalQuery({
  args: { companyId: v.id("companies"), env: v.union(v.literal("sandbox"), v.literal("production")) },
  handler: async (ctx, args) => {
    const account = await accountFor(ctx, args.companyId, args.env);
    return { env: args.env, customerId: customerIdFor(args.companyId), stripeCustomerId: account?.stripeCustomerId ?? null };
  },
});

export const flowTarget = internalQuery({
  args: { flowId: v.id("cancelFlows") },
  handler: async (ctx, args) => {
    const flow = await ctx.db.get(args.flowId);
    return flow ? { companyId: flow.companyId, env: flow.env } : null;
  },
});

export const loadFacts = internalAction({
  args: { flowId: v.id("cancelFlows") },
  handler: async (ctx, args): Promise<void> => {
    const flow = await ctx.runQuery(internal.cancellation.flowTarget, { flowId: args.flowId });
    if (!flow) return;
    const target = await ctx.runQuery(internal.cancellation.factsTarget, flow);
    const facts = await readFacts(target, Date.now());
    await ctx.runMutation(internal.cancellation.factsLoaded, { flowId: args.flowId, facts });
  },
});

export const factsLoaded = internalMutation({
  args: { flowId: v.id("cancelFlows"), facts: v.any() },
  handler: async (ctx, args) => {
    const flow = await ctx.db.get(args.flowId);
    if (!flow) return;
    const facts = args.facts as SubscriptionFacts;
    const now = Date.now();
    await ctx.db.patch(flow._id, { facts, updatedAt: now });
    if (facts.ok) {
      const account = await accountFor(ctx, flow.companyId, flow.env);
      if (account && account.stripeCustomerId !== facts.stripeCustomerId) await ctx.db.patch(account._id, { stripeCustomerId: facts.stripeCustomerId });
    }
    // Whether an offer could be made, recorded once, for the report.
    if (flow.eligible === undefined) {
      const input = await eligibilityInput(ctx, flow.companyId, flow.env, facts, now);
      const verdict = verdicts(input);
      const anyOk = verdict.save10_once.eligible || verdict.save15_three.eligible;
      const why = (verdict.save10_once.eligible ? null : verdict.save10_once.reason) ?? (verdict.save15_three.eligible ? null : verdict.save15_three.reason);
      await ctx.db.patch(flow._id, { eligible: anyOk, ineligible: anyOk ? undefined : (why ?? undefined) });
    }
  },
});

export const offerRow = internalQuery({
  args: { offerRowId: v.id("retentionOffers") },
  handler: async (ctx, args) => ctx.db.get(args.offerRowId),
});

/**
 * Whether the terms accepted still hold on Stripe's subscription as it is now. Anything different (a new
 * renewal date, a price, a discount that appeared) means the Owner must see and accept the new terms.
 */
export const stillHolds = internalQuery({
  args: { offerRowId: v.id("retentionOffers"), facts: v.any() },
  handler: async (ctx, args): Promise<{ ok: true } | { ok: false; reason: Ineligible | "terms_changed" }> => {
    const row = (await ctx.db.get(args.offerRowId))!;
    const facts = args.facts as SubscriptionFacts;
    const input = await eligibilityInput(ctx, row.companyId, row.env, facts, Date.now(), row._id);
    const verdict = offerVerdict(row.offerId, input);
    if (!verdict.eligible) return { ok: false, reason: verdict.reason };
    if (verdict.preview.version !== row.version) return { ok: false, reason: "terms_changed" };
    return { ok: true };
  },
});

export const couponMade = internalMutation({
  args: { offerRowId: v.id("retentionOffers"), couponId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.offerRowId);
    if (row && !row.stripeCouponId) await ctx.db.patch(row._id, { stripeCouponId: args.couponId.slice(0, 100), updatedAt: Date.now() });
  },
});

/** Stripe didn't answer: asked again later under the same keys, then left for the hourly reconciliation. */
export const offerRetry = internalMutation({
  args: { offerRowId: v.id("retentionOffers"), problem: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.offerRowId);
    if (!row || (row.state !== "pending" && row.state !== "unconfirmed")) return;
    const now = Date.now();
    const attempts = row.attempts + 1;
    if (row.state === "pending" && attempts <= RETRY.length) {
      await ctx.db.patch(row._id, { attempts, problem: args.problem.slice(0, 300), updatedAt: now });
      await ctx.scheduler.runAfter(RETRY[attempts - 1], internal.cancellation.applyOffer, { offerRowId: row._id });
      return;
    }
    if (now - row.acceptedAt > GIVE_UP_MS) {
      await offerFailed(ctx, row, "Stripe never confirmed the discount, so it was not applied. Nothing was charged differently.", false);
      return;
    }
    await ctx.db.patch(row._id, { state: "unconfirmed", attempts, nextTryAt: now + HOUR, problem: "We couldn’t confirm the discount with billing yet. We’re checking again, and it will never be applied twice.", updatedAt: now });
  },
});

async function offerFailed(ctx: MutationCtx, row: Doc<"retentionOffers">, problem: string, termsChanged: boolean) {
  const now = Date.now();
  await ctx.db.patch(row._id, { state: "failed", problem: problem.slice(0, 300), failedAt: now, nextTryAt: undefined, termsChanged: termsChanged || undefined, updatedAt: now });
  // The flow can offer again: a failure used nothing up.
  const flow = await ctx.db.get(row.flowId);
  if (flow?.outcome === "offer_accepted") await ctx.db.patch(flow._id, { outcome: undefined, updatedAt: now });
  await recordEvent(ctx, { companyId: row.companyId, type: "billing.retention_offer_failed", actor: { kind: "system" }, subject: { table: "retentionOffers", id: row._id }, data: { offerId: row.offerId, termsChanged, problem: problem.slice(0, 200) } });
}

export const offerAnswered = internalMutation({
  args: { offerRowId: v.id("retentionOffers"), outcome: v.union(v.literal("applied"), v.literal("failed")), discountId: v.optional(v.string()), problem: v.optional(v.string()), termsChanged: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.offerRowId);
    if (!row || (row.state !== "pending" && row.state !== "unconfirmed")) return;
    const now = Date.now();
    if (args.outcome === "failed") return offerFailed(ctx, row, args.problem ?? "Billing refused the discount. Nothing changed.", args.termsChanged === true);
    await ctx.db.patch(row._id, { state: "applied", appliedAt: now, stripeDiscountId: args.discountId?.slice(0, 100), problem: undefined, nextTryAt: undefined, updatedAt: now });
    await recordEvent(ctx, { companyId: row.companyId, type: "billing.retention_offer_applied", actor: { kind: "system" }, subject: { table: "retentionOffers", id: row._id }, data: { offerId: row.offerId, source: "stripe" } });
    // One confirmation, keyed by the offer, so a retry or reconciliation that re-runs this sends nothing twice.
    await notifyMembers(ctx, { companyId: row.companyId, event: "plan_subscription", ref: row._id, key: "offer_applied", facts: { kind: "offer_applied" }, now });
  },
});

const discountIdFor = (sub: RawPlatformSubscription, couponId: string): string | undefined => {
  for (const row of sub.discounts ?? []) {
    if (typeof row === "string") continue;
    const coupon = typeof row.coupon === "string" ? row.coupon : (row.coupon?.id ?? (typeof row.source?.coupon === "string" ? row.source.coupon : row.source?.coupon?.id));
    if (coupon === couponId) return row.id;
  }
  return undefined;
};

/**
 * Applies an accepted offer in Stripe. Each step is keyed by the offer's record, so running this again after
 * a lost answer is the same coupon and the same update. Applied means Stripe's subscription, read back,
 * carries this offer's coupon; nothing else counts.
 */
export const applyOffer = internalAction({
  args: { offerRowId: v.id("retentionOffers") },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.runQuery(internal.cancellation.offerRow, args);
    if (!row || (row.state !== "pending" && row.state !== "unconfirmed")) return;
    const retry = async (problem: string): Promise<void> => {
      await ctx.runMutation(internal.cancellation.offerRetry, { offerRowId: row._id, problem });
    };
    const fail = async (problem: string, termsChanged = false): Promise<void> => {
      await ctx.runMutation(internal.cancellation.offerAnswered, { offerRowId: row._id, outcome: "failed", problem, termsChanged });
    };
    const config = stripeConfig();
    if (!config || config.livemode !== (row.env === "production")) return fail("Billing isn’t set up for discounts on this account. Nothing changed.");

    const read = await getPlatformSubscription(row.stripeSubscriptionId);
    if (read.kind === "unavailable") return retry(read.message);
    if (read.kind !== "ok") return fail("Billing couldn’t find your subscription, so no discount was applied.");
    const facts = subscriptionFacts(read.data, row.stripeCustomerId, Date.now());
    // Already there: an earlier try went through and its answer was lost.
    if (row.stripeCouponId && hasCoupon(facts, row.stripeCouponId)) return void (await ctx.runMutation(internal.cancellation.offerAnswered, { offerRowId: row._id, outcome: "applied", discountId: discountIdFor(read.data, row.stripeCouponId) }));
    const holds = await ctx.runQuery(internal.cancellation.stillHolds, { offerRowId: row._id, facts });
    if (!holds.ok) return fail(holds.reason === "terms_changed" ? "Your billing changed before the discount could be applied, so the terms changed. Nothing was applied. Review the updated terms." : (customerWords(holds.reason) ?? "This offer can no longer be applied to your subscription. Nothing changed."), holds.reason === "terms_changed");

    let couponId = row.stripeCouponId;
    if (!couponId) {
      const coupon = await createRetentionCoupon({ offerRowId: row._id, companyId: row.companyId, percent: row.percent, months: OFFERS[row.offerId].renewals, productId: row.stripeProductId });
      if (coupon.kind === "unavailable") return retry(coupon.message);
      if (coupon.kind !== "ok") return fail("Billing refused the discount. Nothing changed.");
      couponId = coupon.data.id;
      await ctx.runMutation(internal.cancellation.couponMade, { offerRowId: row._id, couponId });
    }
    const applied = await applyRetentionCoupon({ offerRowId: row._id, subscriptionId: row.stripeSubscriptionId, couponId });
    if (applied.kind === "unavailable") return retry(applied.message);
    if (applied.kind !== "ok") return fail("Billing refused the discount. Nothing changed.");
    // Read back: only Stripe's own record of the subscription says it is applied.
    const back = await getPlatformSubscription(row.stripeSubscriptionId);
    if (back.kind !== "ok") return retry(back.kind === "unavailable" ? back.message : "The subscription couldn't be read back.");
    if (!hasCoupon(subscriptionFacts(back.data, row.stripeCustomerId, Date.now()), couponId)) return retry("Stripe's subscription doesn't show the discount yet.");
    await ctx.runMutation(internal.cancellation.offerAnswered, { offerRowId: row._id, outcome: "applied", discountId: discountIdFor(back.data, couponId) });
  },
});

/** Hourly: offers Stripe never confirmed are read again (convex/crons.ts). */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("retentionOffers")
      .withIndex("by_state_next", (q) => q.eq("state", "unconfirmed").lte("nextTryAt", now))
      .take(50);
    for (const row of due) {
      await ctx.db.patch(row._id, { nextTryAt: now + HOUR, updatedAt: now });
      await ctx.scheduler.runAfter(0, internal.cancellation.applyOffer, { offerRowId: row._id });
    }
    // A pending offer whose action never ran to the end (a crash between steps) is picked up the same way.
    for (const row of await ctx.db
      .query("retentionOffers")
      .withIndex("by_state_next", (q) => q.eq("state", "pending"))
      .take(50)) {
      if (now - row.updatedAt > 30 * MINUTE) await ctx.db.patch(row._id, { state: "unconfirmed", nextTryAt: now, updatedAt: now });
    }
  },
});

// ── What Stripe collected after an offer ─────────────────────────────────────────────────────────

/**
 * A verified Stripe invoice or refund event on Selestial's own account (/webhooks/stripe-billing). Only plan
 * invoices of a subscription with an accepted offer are kept: what was discounted and what was paid. Usage is
 * never on these invoices; it is billed as Autumn's separate one-off purchases.
 */
export const invoiceEvent = internalMutation({
  args: {
    eventId: v.string(),
    type: v.string(),
    invoiceId: v.string(),
    subscriptionId: v.union(v.string(), v.null()),
    status: v.string(),
    subtotalCents: v.number(),
    discountCents: v.number(),
    paidCents: v.number(),
    refundedCents: v.number(),
    at: v.number(),
  },
  handler: async (ctx, args) => {
    let rows: Doc<"retentionOffers">[] = [];
    if (args.subscriptionId) {
      rows = await ctx.db
        .query("retentionOffers")
        .withIndex("by_subscription", (q) => q.eq("stripeSubscriptionId", args.subscriptionId!))
        .take(20);
    } else {
      // A refund names the invoice, not the subscription: the offer that already holds the invoice.
      for (const env of ["sandbox", "production"] as const) {
        const recent = await ctx.db
          .query("retentionOffers")
          .withIndex("by_env_accepted", (q) => q.eq("env", env))
          .order("desc")
          .take(500);
        rows.push(...recent.filter((row) => row.invoices.some((invoice) => invoice.invoiceId === args.invoiceId)));
      }
    }
    const row = rows.filter((r) => r.state === "applied" && r.acceptedAt <= args.at).sort((a, b) => b.acceptedAt - a.acceptedAt)[0];
    if (!row || row.events.includes(args.eventId)) return;
    const now = Date.now();
    const existing = row.invoices.find((invoice) => invoice.invoiceId === args.invoiceId);
    const next = existing
      ? { ...existing, status: args.type === "charge.refunded" ? existing.status : args.status, refundedCents: Math.max(existing.refundedCents, args.refundedCents), ...(args.type === "charge.refunded" ? {} : { subtotalCents: args.subtotalCents, discountCents: args.discountCents, paidCents: args.paidCents }) }
      : { invoiceId: args.invoiceId.slice(0, 100), status: args.status, subtotalCents: args.subtotalCents, discountCents: args.discountCents, paidCents: args.paidCents, refundedCents: args.refundedCents, at: args.at };
    if (!existing && args.type === "charge.refunded") return;
    await ctx.db.patch(row._id, { invoices: [...row.invoices.filter((invoice) => invoice.invoiceId !== args.invoiceId), next].slice(-24), events: [...row.events, args.eventId].slice(-60), updatedAt: now });
  },
});

// ── Staff: feedback and retention ────────────────────────────────────────────────────────────────

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((100 * part) / whole) : null);

/**
 * Staff › Operations › Cancellations. Counts are what happened; revenue is only what Stripe reported paid,
 * less refunds. Projected amounts are shown apart and never added to collected revenue. A retained company is
 * one whose plan was still active N days after accepting: it says nothing about whether it would otherwise
 * have left.
 */
export const report = staffQuery({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const state = billingState();
    const env: AutumnEnv = state.connected ? state.env : "sandbox";
    const now = Date.now();
    const since = now - Math.min(365, Math.max(7, Math.floor(args.days ?? 90))) * DAY;
    const flows = await ctx.db
      .query("cancelFlows")
      .withIndex("by_env_started", (q) => q.eq("env", env).gte("startedAt", since))
      .order("desc")
      .take(2000);
    const offers = await ctx.db
      .query("retentionOffers")
      .withIndex("by_env_accepted", (q) => q.eq("env", env).gte("acceptedAt", since))
      .order("desc")
      .take(1000);
    const count = <K extends string>(keys: readonly K[], pick: (row: Doc<"cancelFlows">) => K | undefined) => keys.map((key) => ({ key, count: flows.filter((row) => pick(row) === key).length }));
    const intents = (
      await Promise.all(
        [...new Set(flows.map((row) => row.companyId))].slice(0, 300).map((companyId) =>
          ctx.db
            .query("billingIntents")
            .withIndex("by_company_created", (q) => q.eq("companyId", companyId).gte("createdAt", since))
            .take(50),
        ),
      )
    )
      .flat()
      .filter((row) => row.env === env);
    const viewed = (id: OfferId) => flows.filter((row) => row.offers.some((o) => o.offerId === id)).length;
    const declined = (id: OfferId) => flows.filter((row) => row.offers.some((o) => o.offerId === id && o.outcome === "declined")).length;
    const applied = offers.filter((row) => row.state === "applied");
    const invoices = applied.flatMap((row) => row.invoices.map((invoice) => ({ ...invoice, offerId: row.offerId })));
    const paid = invoices.filter((invoice) => invoice.status === "paid");
    const retention = await Promise.all(
      [30, 60, 90].map(async (days) => {
        const due = applied.filter((row) => now - row.acceptedAt >= days * DAY);
        let kept = 0;
        for (const row of due) {
          const ended = (
            await ctx.db
              .query("events")
              .withIndex("by_company_at", (q) => q.eq("companyId", row.companyId).gte("at", row.acceptedAt).lte("at", row.acceptedAt + days * DAY))
              .take(200)
          ).some((event) => event.type === "company.plan_changed" && (event.data as { to?: unknown } | undefined)?.to === null);
          if (!ended) kept += 1;
        }
        return { days, eligible: due.length, retained: kept, percent: pct(kept, due.length) };
      }),
    );
    const companies = new Map<Id<"companies">, string>();
    for (const row of flows.slice(0, 50)) if (!companies.has(row.companyId)) companies.set(row.companyId, (await ctx.db.get(row.companyId))?.name ?? "Deleted company");
    return {
      env,
      since,
      flowsStarted: flows.length,
      reasons: count(CANCEL_REASONS, (row) => row.reason).map((row) => ({ ...row, label: CANCEL_REASON_WORDS[row.key] })),
      needs: count(STAY_NEEDS, (row) => row.need).map((row) => ({ ...row, label: STAY_NEED_WORDS[row.key] })),
      skipped: flows.filter((row) => row.skipped).length,
      eligible: flows.filter((row) => row.eligible === true).length,
      ineligible: Object.entries(
        flows.reduce<Record<string, number>>((acc, row) => {
          if (row.eligible === false && row.ineligible) acc[row.ineligible] = (acc[row.ineligible] ?? 0) + 1;
          return acc;
        }, {}),
      ).map(([key, n]) => ({ key, count: n, label: INELIGIBLE_WORDS[key as Ineligible] ?? key })),
      offers: OFFER_IDS.map((id) => ({ offerId: id, percent: OFFERS[id].percent, viewed: viewed(id), declined: declined(id), accepted: offers.filter((row) => row.offerId === id && row.state !== "failed").length, applied: applied.filter((row) => row.offerId === id).length, failed: offers.filter((row) => row.offerId === id && row.state === "failed").length })),
      cancellations: { requested: intents.filter((row) => row.kind === "cancel").length, done: intents.filter((row) => row.kind === "cancel" && row.stage === "done").length, failed: intents.filter((row) => row.kind === "cancel" && row.stage === "failed").length },
      reactivations: { requested: intents.filter((row) => row.kind === "uncancel").length, done: intents.filter((row) => row.kind === "uncancel" && row.stage === "done").length, failed: intents.filter((row) => row.kind === "uncancel" && row.stage === "failed").length },
      failedOperations: offers.filter((row) => row.state === "failed" || row.state === "unconfirmed").length + intents.filter((row) => (row.kind === "cancel" || row.kind === "uncancel") && row.stage === "failed").length,
      money: {
        /** Discounts on paid plan invoices, as Stripe reported them. */
        discountsAppliedCents: paid.reduce((sum, invoice) => sum + invoice.discountCents, 0),
        /** Subscription revenue Stripe reported paid after acceptance, less refunds. */
        collectedCents: paid.reduce((sum, invoice) => sum + invoice.paidCents - invoice.refundedCents, 0),
        refundedCents: invoices.reduce((sum, invoice) => sum + invoice.refundedCents, 0),
        failedInvoices: invoices.filter((invoice) => invoice.status === "uncollectible" || invoice.status === "payment_failed" || invoice.status === "void").length,
        /** Not revenue: the discounted payments still to come on accepted offers, if every one is paid. */
        projectedCents: applied.reduce((sum, row) => sum + remaining(row.renewals, now).reduce((s, r) => s + r.totalCents, 0), 0),
      },
      retention,
      recent: flows.slice(0, 50).map((row) => ({ id: row._id, company: companies.get(row.companyId) ?? "", at: row.startedAt, reason: row.reason ? CANCEL_REASON_WORDS[row.reason] : null, reasonNote: row.reasonNote ?? null, reasonDetail: row.reasonDetail ?? null, need: row.need ? STAY_NEED_WORDS[row.need] : null, needNote: row.needNote ?? null, outcome: row.outcome ?? null, skipped: row.skipped ?? false })),
    };
  },
});
