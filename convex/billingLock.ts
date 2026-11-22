/**
 * An unpaid Selestial plan: told after the first failed payment, locked after the second, canceled after
 * 30 days locked, and reinstated the moment it's paid. The rules and their reasons are in
 * convex/lib/billing/lock.ts; docs/billing/04-unpaid-plan.md explains it for people.
 *
 * What a lock does, and what it leaves alone:
 *  - The team can't open the workspace (convex/lib/builders.ts refuses company functions not marked
 *    `whileLocked`). The Owner sees what's owed and pays; everyone else is told who can.
 *  - Every agent is paused through the company's own pause list, so every place that honors a pause honors
 *    the lock. The Owner's earlier choices are kept and put back when it lifts.
 *  - Booking pages, quote and payment links, the cleaner portal, delivery reports and the records keep
 *    working. Nothing is deleted.
 *
 * Stripe's signed invoice events say what happened (/webhooks/stripe-billing). The company is found from
 * the Autumn customer id Autumn puts on the invoice or on the Stripe customer, then checked against
 * Selestial's own billing record, so an event can only ever touch the company that record names.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { billingState, customerIdFor } from "./lib/billing/access";
import { updateSubscription } from "./lib/billing/autumn";
import { customerHintOfCustomer, DUNNING_EVENTS, lockDeadlines, locksAt, type InvoiceEvent } from "./lib/billing/lock";
import { companyQuery, staffMutation, staffQuery } from "./lib/builders";
import { notFound, userError } from "./lib/errors";
import { recordEvent } from "./lib/events";
import { getPlatformCustomer, getPlatformInvoice } from "./lib/finance/stripe";
import { notifyMembers } from "./lib/notify/route";
import { isOwner } from "./lib/roles";
import { AGENTS } from "./lib/statuses";
import { openPlanCancelledWork } from "./lib/texting/offboarding";

const HOUR = 3_600_000;

const eventValidator = v.object({
  eventId: v.string(),
  type: v.union(...DUNNING_EVENTS.map((type) => v.literal(type))),
  invoiceId: v.string(),
  stripeCustomerId: v.union(v.string(), v.null()),
  subscription: v.boolean(),
  attempts: v.number(),
  amountCents: v.number(),
  currency: v.string(),
  hostedUrl: v.union(v.string(), v.null()),
  nextAttemptAt: v.union(v.number(), v.null()),
  failure: v.union(v.string(), v.null()),
  customerHint: v.union(v.string(), v.null()),
  at: v.number(),
});

type Outcome = "applied" | "duplicate" | "ignored" | "unmatched";

/** How a failed plan payment that no company could be found for is kept in billingWebhooks. */
export const UNMATCHED_FAILURE = "stripe.invoice.payment_failed.unmatched";

// ── Receiving Stripe's events ────────────────────────────────────────────────────────────────────

/**
 * A verified Stripe invoice event. When the invoice itself doesn't say which company it's for, the Stripe
 * customer is read for Autumn's id and the event is applied with that. An event no company can be found
 * for is kept for Selestial staff (billingWebhooks) and changes nothing.
 */
export const received = internalAction({
  args: { event: eventValidator },
  handler: async (ctx, args): Promise<Outcome> => {
    const first: Outcome = await ctx.runMutation(internal.billingLock.apply, { event: args.event as InvoiceEvent, customerHint: args.event.customerHint });
    if (first !== "unmatched") return first;
    const customer = args.event.stripeCustomerId ? await getPlatformCustomer(args.event.stripeCustomerId) : null;
    const hint = customer?.kind === "ok" ? customerHintOfCustomer(customer.data) : null;
    if (hint) {
      const second: Outcome = await ctx.runMutation(internal.billingLock.apply, { event: args.event as InvoiceEvent, customerHint: hint });
      if (second !== "unmatched") return second;
    }
    await ctx.runMutation(internal.billingLock.unmatched, { event: args.event as InvoiceEvent });
    return "unmatched";
  },
});

export const unmatched = internalMutation({
  args: { event: eventValidator },
  handler: async (ctx, args) => {
    const state = billingState();
    if (!state.connected) return;
    const seen = await ctx.db
      .query("billingWebhooks")
      .withIndex("by_env_delivery", (q) => q.eq("env", state.env).eq("deliveryId", args.event.eventId))
      .first();
    // A failure nobody can be told about is the one that matters: it is kept where the billing check finds it
    // for staff (convex/lib/operations/detectors.ts). A paid or voided invoice for a stranger needs nothing.
    if (args.event.type !== "invoice.payment_failed") return;
    if (!seen) await ctx.db.insert("billingWebhooks", { env: state.env, deliveryId: args.event.eventId, type: UNMATCHED_FAILURE, customerId: args.event.stripeCustomerId ?? undefined, receivedAt: Date.now() });
    console.warn(`billingLock: no company for Stripe invoice ${args.event.invoiceId} (${args.event.type})`);
  },
});

export const apply = internalMutation({
  args: { event: eventValidator, customerHint: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<Outcome> => {
    const state = billingState();
    if (!state.connected) return "ignored";
    const event = args.event;
    if (!event.subscription) return "ignored";
    let row = await ctx.db
      .query("billingDunning")
      .withIndex("by_invoice", (q) => q.eq("invoiceId", event.invoiceId))
      .first();
    if (row?.events.includes(event.eventId)) return "duplicate";

    if (!row) {
      if (event.type === "invoice.marked_uncollectible") return "ignored";
      const account = args.customerHint
        ? await ctx.db
            .query("billingAccounts")
            .withIndex("by_env_customer", (q) => q.eq("env", state.env).eq("customerId", args.customerHint!))
            .first()
        : null;
      // The hint is only a pointer: the account must be Selestial's own record, under the id derived from its company.
      if (!account || account.customerId !== customerIdFor(account.companyId)) return "unmatched";
      const now = Date.now();
      if (event.type !== "invoice.payment_failed") {
        // Paid or voided before any failure was seen. Stripe's events can arrive out of order, so the invoice
        // is recorded as settled: a failure for it that arrives late finds this and locks nothing.
        await ctx.db.insert("billingDunning", {
          companyId: account.companyId,
          env: state.env,
          invoiceId: event.invoiceId,
          stripeCustomerId: event.stripeCustomerId ?? undefined,
          attempts: 0,
          amountCents: event.amountCents,
          currency: event.currency,
          hostedUrl: event.hostedUrl,
          firstFailedAt: event.at,
          lastFailedAt: event.at,
          nextAttemptAt: null,
          resolvedAt: now,
          resolution: event.type === "invoice.paid" ? "paid" : "voided",
          events: [event.eventId],
          updatedAt: now,
        });
        return "applied";
      }
      const id = await ctx.db.insert("billingDunning", {
        companyId: account.companyId,
        env: state.env,
        invoiceId: event.invoiceId,
        stripeCustomerId: event.stripeCustomerId ?? undefined,
        attempts: 0,
        amountCents: event.amountCents,
        currency: event.currency,
        hostedUrl: event.hostedUrl,
        firstFailedAt: event.at,
        lastFailedAt: event.at,
        nextAttemptAt: event.nextAttemptAt,
        events: [],
        updatedAt: now,
      });
      row = (await ctx.db.get(id))!;
    }

    await ctx.db.patch(row._id, { events: [...row.events, event.eventId].slice(-30), updatedAt: Date.now() });
    if (row.resolvedAt !== undefined) return "applied";

    if (event.type === "invoice.payment_failed") await failed(ctx, row, event);
    else if (event.type === "invoice.paid") await resolve(ctx, row._id, "paid");
    else if (event.type === "invoice.voided") await resolve(ctx, row._id, "voided");
    // marked_uncollectible: Stripe has stopped retrying. It's still owed, so the lock stays until paid or 30 days pass.
    return "applied";
  },
});

async function failed(ctx: MutationCtx, row: Doc<"billingDunning">, event: InvoiceEvent) {
  // Events can arrive out of order: the count only ever goes up, and the newest failure's details win.
  const attempts = Math.max(row.attempts, event.attempts);
  const newer = event.at >= row.lastFailedAt;
  await ctx.db.patch(row._id, {
    attempts,
    ...(newer ? { lastFailedAt: event.at, nextAttemptAt: event.nextAttemptAt, amountCents: event.amountCents, currency: event.currency, hostedUrl: event.hostedUrl ?? row.hostedUrl, ...(event.failure ? { lastFailure: event.failure } : {}) } : {}),
    firstFailedAt: Math.min(row.firstFailedAt, event.at),
  });
  if (attempts > row.attempts) {
    await recordEvent(ctx, { companyId: row.companyId, type: "billing.plan_payment_failed", actor: { kind: "system" }, subject: { table: "billingDunning", id: row._id }, data: { attempt: attempts, amountCents: event.amountCents } });
  }
  const fresh = (await ctx.db.get(row._id))!;
  if (locksAt(attempts)) await lock(ctx, fresh);
  else if (row.attempts === 0 && attempts > 0) {
    await notifyMembers(ctx, { companyId: row.companyId, event: "plan_access", ref: row._id, key: "first_failure", facts: { kind: "first_failure" } });
  }
}

/** Locks the workspace and pauses every agent, keeping the Owner's own pause choices to put back later. */
async function lock(ctx: MutationCtx, row: Doc<"billingDunning">) {
  if (row.lockedAt !== undefined) return;
  const company = await ctx.db.get(row.companyId);
  if (!company) return;
  const now = Date.now();
  // Another unpaid invoice may already hold the lock; then this one only records that it's locked too.
  const alreadyLocked = company.billingLockedAt !== undefined;
  await ctx.db.patch(row._id, { lockedAt: now, ...(alreadyLocked ? {} : { priorPausedAgents: company.pausedAgents }) });
  if (!alreadyLocked) await ctx.db.patch(company._id, { billingLockedAt: now, pausedAgents: [...AGENTS] });
  await recordEvent(ctx, { companyId: company._id, type: "billing.account_locked", actor: { kind: "system" }, subject: { table: "billingDunning", id: row._id }, data: { attempts: row.attempts, amountCents: row.amountCents } });
  await notifyMembers(ctx, { companyId: company._id, event: "plan_access", ref: row._id, key: "locked", facts: { kind: "locked" } });
  // A second look, at Stripe itself: if the invoice is in fact paid (its "paid" event was lost or could not be
  // matched), the lock lifts straight away instead of waiting for someone to notice.
  await ctx.scheduler.runAfter(0, internal.billingLock.recheck, { companyId: company._id });
}

type Resolution = NonNullable<Doc<"billingDunning">["resolution"]>;

/** The invoice is no longer owed (paid, voided, lifted by Selestial) or the plan was canceled: the lock ends. */
async function resolve(ctx: MutationCtx, rowId: Id<"billingDunning">, resolution: Resolution, note?: string) {
  const row = await ctx.db.get(rowId);
  if (!row || row.resolvedAt !== undefined) return;
  const now = Date.now();
  await ctx.db.patch(row._id, { resolvedAt: now, resolution, updatedAt: now });
  const company = await ctx.db.get(row.companyId);
  if (!company) return;
  // The lock stays while any other unpaid invoice for this company is also locked.
  const others = await ctx.db
    .query("billingDunning")
    .withIndex("by_company_resolved", (q) => q.eq("companyId", company._id).eq("resolvedAt", undefined))
    .take(20);
  const stillLocked = others.filter((other) => other._id !== row._id && other.lockedAt !== undefined);
  if (company.billingLockedAt !== undefined && stillLocked.length === 0) {
    const holder = row.priorPausedAgents ? row : await priorHolder(ctx, company._id);
    const prior = (holder?.priorPausedAgents ?? []).filter((agent): agent is (typeof AGENTS)[number] => (AGENTS as readonly string[]).includes(agent));
    await ctx.db.patch(company._id, { billingLockedAt: undefined, pausedAgents: prior });
    await recordEvent(ctx, { companyId: company._id, type: "billing.account_reinstated", actor: { kind: "system" }, subject: { table: "billingDunning", id: row._id }, data: { resolution, ...(note ? { note } : {}) } });
    if (resolution === "paid" || resolution === "voided" || resolution === "lifted") {
      await notifyMembers(ctx, { companyId: company._id, event: "plan_access", ref: row._id, key: "reinstated", facts: { kind: "reinstated" } });
    }
  }
  // The plan's state (past due, canceled) is read back from Autumn rather than assumed.
  await ctx.scheduler.runAfter(0, internal.billing.syncCompany, { companyId: company._id });
}

/** The locked invoice that kept the Owner's pause choices, when the one being resolved joined the lock later. */
async function priorHolder(ctx: MutationCtx, companyId: Id<"companies">) {
  const rows = await ctx.db
    .query("billingDunning")
    .withIndex("by_company_resolved", (q) => q.eq("companyId", companyId))
    .order("desc")
    .take(20);
  return rows.find((row) => row.priorPausedAgents !== undefined) ?? null;
}

// ── Asking Stripe directly ───────────────────────────────────────────────────────────────────────

export const unpaidFor = internalQuery({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("billingDunning")
      .withIndex("by_company_resolved", (q) => q.eq("companyId", args.companyId).eq("resolvedAt", undefined))
      .take(5);
    return rows.map((row) => ({ rowId: row._id, invoiceId: row.invoiceId, stripeCustomerId: row.stripeCustomerId ?? null }));
  },
});

/**
 * Reads each unpaid plan invoice of a company from Stripe and ends its lock when Stripe itself says the
 * invoice is paid or voided. Run when an account locks and when the Owner says they've paid. What the
 * browser says is never the reason: only Stripe's own record of the invoice Selestial already holds is.
 */
export const recheck = internalAction({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args): Promise<void> => {
    const rows = await ctx.runQuery(internal.billingLock.unpaidFor, { companyId: args.companyId });
    for (const row of rows) {
      const answer = await getPlatformInvoice(row.invoiceId);
      if (answer.kind !== "ok" || answer.data.id !== row.invoiceId) continue;
      const customer = typeof answer.data.customer === "string" ? answer.data.customer : (answer.data.customer?.id ?? null);
      // The invoice must still belong to the Stripe customer the failure named.
      if (row.stripeCustomerId && customer !== row.stripeCustomerId) continue;
      const resolution = answer.data.status === "paid" ? ("paid" as const) : answer.data.status === "void" ? ("voided" as const) : null;
      if (resolution) await ctx.runMutation(internal.billingLock.settled, { rowId: row.rowId, resolution });
    }
  },
});

export const settled = internalMutation({
  args: { rowId: v.id("billingDunning"), resolution: v.union(v.literal("paid"), v.literal("voided")) },
  handler: async (ctx, args) => {
    await resolve(ctx, args.rowId, args.resolution, "Read from Stripe's record of the invoice.");
  },
});

// ── 23 and 30 days ───────────────────────────────────────────────────────────────────────────────

/** Hourly: the reminder 7 days before cancellation, and the cancellation itself after 30 days locked. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const locked = await ctx.db
      .query("billingDunning")
      .withIndex("by_resolved_locked", (q) => q.eq("resolvedAt", undefined).gt("lockedAt", 0))
      .take(200);
    for (const row of locked) {
      const { remindAt, cancelAt } = lockDeadlines(row.lockedAt!);
      if (now >= cancelAt) {
        if (row.cancelTriedAt !== undefined && now - row.cancelTriedAt < 6 * HOUR) continue;
        await ctx.db.patch(row._id, { cancelTriedAt: now });
        await ctx.scheduler.runAfter(0, internal.billingLock.cancelUnpaid, { rowId: row._id });
      } else if (now >= remindAt && row.reminderSentAt === undefined) {
        await ctx.db.patch(row._id, { reminderSentAt: now });
        await notifyMembers(ctx, { companyId: row.companyId, event: "plan_access", ref: row._id, key: "cancel_soon", facts: { kind: "cancel_soon" } });
      }
    }
  },
});

export const cancelTarget = internalQuery({
  args: { rowId: v.id("billingDunning") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    if (!row || row.resolvedAt !== undefined || row.lockedAt === undefined) return null;
    const account = await ctx.db
      .query("billingAccounts")
      .withIndex("by_company_env", (q) => q.eq("companyId", row.companyId).eq("env", row.env))
      .unique();
    return { customerId: customerIdFor(row.companyId), planId: account?.plan ?? null };
  },
});

/** Cancels the plan in Autumn after 30 days locked. A failure is retried by a later sweep. */
export const cancelUnpaid = internalAction({
  args: { rowId: v.id("billingDunning") },
  handler: async (ctx, args): Promise<void> => {
    const target = await ctx.runQuery(internal.billingLock.cancelTarget, { rowId: args.rowId });
    if (!target) return;
    if (target.planId) {
      const answer = await updateSubscription({ customerId: target.customerId, planId: target.planId, cancelAction: "cancel_immediately" }, `dunning-cancel:${args.rowId}`);
      // A replay means Autumn already has this exact cancellation: it is done, not failed.
      if (answer.kind !== "ok" && answer.kind !== "replayed") {
        console.warn(`billingLock: canceling the unpaid plan failed (${answer.kind}); a later sweep tries again`);
        return;
      }
    }
    await ctx.runMutation(internal.billingLock.canceled, { rowId: args.rowId });
  },
});

export const canceled = internalMutation({
  args: { rowId: v.id("billingDunning") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    if (!row || row.resolvedAt !== undefined) return;
    await recordEvent(ctx, { companyId: row.companyId, type: "billing.plan_canceled_unpaid", actor: { kind: "system" }, subject: { table: "billingDunning", id: row._id }, data: { amountCents: row.amountCents } });
    await notifyMembers(ctx, { companyId: row.companyId, event: "plan_access", ref: row._id, key: "canceled", facts: { kind: "canceled" } });
    // A texting number still set up becomes a work item for Selestial staff. It releases nothing by itself.
    await openPlanCancelledWork(ctx, row.companyId, "unpaid");
    await resolve(ctx, row._id, "canceled");
  },
});

// ── What the people in the company see ───────────────────────────────────────────────────────────

/**
 * The lock, for the locked screen and the billing page. Readable while locked. Only the Owner sees the
 * payment link and the decline reason; everyone else sees who can fix it.
 */
export const status = companyQuery({
  args: {},
  whileLocked: true,
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("billingDunning")
      .withIndex("by_company_resolved", (q) => q.eq("companyId", ctx.companyId).eq("resolvedAt", undefined))
      .take(20);
    const owner = isOwner(ctx.role);
    const ownerMember = await ctx.db
      .query("members")
      .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
      .filter((q) => q.eq(q.field("role"), "owner"))
      .first();
    const locked = rows.filter((row) => row.lockedAt !== undefined).sort((a, b) => a.lockedAt! - b.lockedAt!);
    const warning = rows.filter((row) => row.lockedAt === undefined && row.attempts > 0).sort((a, b) => b.lastFailedAt - a.lastFailedAt)[0] ?? null;
    const head = locked[0] ?? null;
    const amountCents = locked.reduce((sum, row) => sum + row.amountCents, 0);
    return {
      locked: ctx.company.billingLockedAt !== undefined,
      lockedAt: ctx.company.billingLockedAt ?? null,
      owner,
      ownerName: ownerMember?.name ?? null,
      companyName: ctx.company.name,
      timezone: ctx.company.timezone,
      invoices: locked.length,
      amountCents,
      currency: head?.currency ?? "usd",
      attempts: head?.attempts ?? 0,
      firstFailedAt: head?.firstFailedAt ?? null,
      lastFailedAt: head?.lastFailedAt ?? null,
      cancelAt: head ? lockDeadlines(head.lockedAt!).cancelAt : null,
      payUrl: owner ? (head?.hostedUrl ?? null) : null,
      failure: owner ? (head?.lastFailure ?? null) : null,
      warning: warning ? { amountCents: warning.amountCents, currency: warning.currency, failedAt: warning.lastFailedAt, nextAttemptAt: warning.nextAttemptAt, payUrl: owner ? warning.hostedUrl : null } : null,
    };
  },
});

// ── Selestial staff ──────────────────────────────────────────────────────────────────────────────

/** Accounts locked for an unpaid plan, oldest first, with when each would be canceled. */
export const lockedAccounts = staffQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("billingDunning")
      .withIndex("by_resolved_locked", (q) => q.eq("resolvedAt", undefined).gt("lockedAt", 0))
      .take(200);
    return Promise.all(
      rows.map(async (row) => {
        const company = await ctx.db.get(row.companyId);
        return { id: row._id, companyId: row.companyId, company: company?.name ?? "A company", amountCents: row.amountCents, currency: row.currency, attempts: row.attempts, lockedAt: row.lockedAt!, cancelAt: lockDeadlines(row.lockedAt!).cancelAt, reminded: row.reminderSentAt !== undefined };
      }),
    );
  },
});

/** Staff with billing adjustments lift a lock by hand (paid another way, a mistake), saying why. */
export const lift = staffMutation({
  capability: "billing.adjust",
  args: { id: v.id("billingDunning"), note: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) notFound();
    if (row.resolvedAt !== undefined) return null;
    const note = args.note.trim();
    if (note.length < 10) throw userError("Say why, so the next person can tell what happened.");
    await resolve(ctx, row._id, "lifted", `${note.slice(0, 300)} (staff ${ctx.staff._id})`);
    return null;
  },
});
