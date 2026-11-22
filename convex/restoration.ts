/**
 * Restoring the record safely (docs/operations/05-recovery-runbook.md). Run from the command line against
 * the restored deployment, never from a browser:
 *
 *   npx convex run restoration:lockDown '{"reason":"Restored from the 03:00 backup"}'
 *   npx convex run restoration:status
 *   npx convex run restoration:verify
 *   npx convex run restoration:release '{"lockdownId":"…","note":"Reconciled outbox, charges, numbers"}'
 *
 * A restore must never replay what already happened outside: a message sent, a card charged, a number
 * bought, an agent's action. Restored rows can say "queued" or "sending" for things that went out after the
 * backup was taken. So the first step suspends every company's outbound sending and pauses every agent, and
 * nothing is released until what the providers did has been reconciled with what the rows say.
 *
 * Suspension and pausing are the same controls the product enforces everywhere (the sending policy is asked
 * again as each message goes; agents check their pause), so nothing new can slip past them.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { deploymentName, environment } from "./lib/environment";
import { QUEUED_STUCK, stuckQueued } from "./lib/operations/detectors";
import { AGENTS } from "./lib/statuses";
import { EXPORT_TABLES } from "./lib/trust/exportTables";

const PAGE = 500;

/** Suspends sending and pauses every agent for every company, remembering what each had. Run it again until `done`. */
export const lockDown = internalMutation({
  args: { reason: v.string(), lockdownId: v.optional(v.id("lockdowns")), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    let lockdownId = args.lockdownId;
    if (!lockdownId) {
      const open = (await ctx.db.query("lockdowns").withIndex("by_started").order("desc").take(5)).find((row) => row.releasedAt === undefined);
      lockdownId = open?._id ?? (await ctx.db.insert("lockdowns", { reason: args.reason.slice(0, 500), startedAt: now }));
    }
    const page = await ctx.db.query("companies").paginate({ numItems: PAGE, cursor: args.cursor ?? null });
    let locked = 0;
    for (const company of page.page) {
      const recorded = await ctx.db
        .query("lockdownCompanies")
        .withIndex("by_lockdown_company", (q) => q.eq("lockdownId", lockdownId).eq("companyId", company._id))
        .first();
      if (recorded) continue;
      // What the lock-down itself writes is recorded, so release can undo exactly that and nothing set since.
      await ctx.db.insert("lockdownCompanies", { lockdownId, companyId: company._id, priorSuspendedAt: company.suspendedAt, priorPausedAgents: company.pausedAgents, ...(company.suspendedAt === undefined ? { suspendedAtSet: now } : {}) });
      await ctx.db.patch(company._id, { suspendedAt: company.suspendedAt ?? now, pausedAgents: [...AGENTS] });
      locked += 1;
    }
    return { lockdownId, locked, done: page.isDone, cursor: page.isDone ? null : page.continueCursor };
  },
});

/** What still has to be reconciled with the providers before release, counted from the records (bounded). */
export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const count = async <T>(rows: Promise<T[]>) => (await rows).length;
    const open = (await ctx.db.query("lockdowns").withIndex("by_started").order("desc").take(5)).find((row) => row.releasedAt === undefined) ?? null;
    const lockedCompanies = open ? await count(ctx.db.query("lockdownCompanies").withIndex("by_lockdown", (q) => q.eq("lockdownId", open._id)).take(10_000)) : 0;
    const messages: Record<string, number> = {};
    for (const status of ["queued", "held", "sending", "unconfirmed"] as const) {
      messages[status] = await count(ctx.db.query("messages").withIndex("by_status_attempted", (q) => q.eq("status", status)).take(1000));
    }
    const settlements: Record<string, number> = {};
    for (const settlement of ["pending_confirm", "pending_release", "unverified"] as const) {
      settlements[`ai_${settlement}`] = await count(ctx.db.query("aiExecutions").withIndex("by_settlement_next", (q) => q.eq("settlement", settlement)).take(1000));
    }
    for (const settlement of ["pending_confirm", "pending_release", "pending_track", "unverified"] as const) {
      settlements[`messaging_${settlement}`] = await count(ctx.db.query("messagingCharges").withIndex("by_settlement_next", (q) => q.eq("settlement", settlement)).take(1000));
    }
    const texting: Record<string, number> = {};
    for (const status of ["approved", "provisioning", "waiting_on_carriers"] as const) {
      texting[status] = await count(ctx.db.query("textingRequests").withIndex("by_status_requested", (q) => q.eq("status", status)).take(1000));
    }
    const googleJobs: Record<string, number> = {};
    for (const status of ["queued", "running", "uncertain"] as const) {
      googleJobs[status] = await count(ctx.db.query("googleJobs").withIndex("by_status_next", (q) => q.eq("status", status)).take(1000));
    }
    const payments: Record<string, number> = {};
    for (const status of PAYMENTS_IN_FLIGHT) payments[`payment_${status}`] = await count(ctx.db.query("payments").withIndex("by_status_updated", (q) => q.eq("status", status)).take(1000));
    for (const status of REFUNDS_IN_FLIGHT) payments[`refund_${status}`] = await count(ctx.db.query("refunds").withIndex("by_status_updated", (q) => q.eq("status", status)).take(1000));
    return {
      deployment: deploymentName(),
      environment: environment(),
      lockdown: open ? { id: open._id, reason: open.reason, startedAt: open.startedAt, lockedCompanies } : null,
      toReconcile: { messages, settlements, texting, googleJobs, payments },
      // Messages whose send timers did not survive: they will not go by themselves, and nothing here sends them.
      stuckMessages: await stuckMessages(ctx, now),
    };
  },
});

const PAYMENTS_IN_FLIGHT = ["awaiting_customer", "processing", "checking"] as const;
const REFUNDS_IN_FLIGHT = ["sending", "pending", "checking"] as const;
const LIST = 100;

type StuckMessage = { id: Id<"messages">; companyId: Id<"companies">; status: "queued" | "held"; purpose: string; queuedAt: number; dueAt: number | null };

/**
 * Queued messages older than two hours, and held (scheduled) messages whose time passed over two hours ago.
 * A restore brings the rows back but not the timers that would have sent them. They are listed for a person
 * to check with the provider and with the company; they are never sent again from here.
 */
async function stuckMessages(ctx: QueryCtx, now: number): Promise<StuckMessage[]> {
  const out: StuckMessage[] = (await stuckQueued(ctx, now, LIST)).map((row) => ({ id: row._id, companyId: row.companyId, status: "queued", purpose: row.purpose, queuedAt: row.queuedAt, dueAt: null }));
  const held = await ctx.db.query("messages").withIndex("by_status_attempted", (q) => q.eq("status", "held")).take(1000);
  for (const row of held) {
    if (out.length >= LIST) break;
    if (row.scheduledFor !== undefined && row.scheduledFor < now - QUEUED_STUCK) out.push({ id: row._id, companyId: row.companyId, status: "held", purpose: row.purpose, queuedAt: row.queuedAt, dueAt: row.scheduledFor });
  }
  return out;
}

/**
 * What happened outside Selestial and may not match these rows: card payments and refunds in progress, and
 * messages that may or may not have gone. Each is looked up at its provider before anything is released.
 * Ids and states only, at most a hundred of each.
 */
export const inFlight = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const payments = [];
    for (const status of PAYMENTS_IN_FLIGHT) {
      for (const row of await ctx.db.query("payments").withIndex("by_status_updated", (q) => q.eq("status", status)).order("desc").take(LIST)) {
        // A pay page nobody has opened has nothing at Stripe to reconcile.
        if (status === "awaiting_customer" && !row.stripe?.paymentIntentId) continue;
        payments.push({ id: row._id, companyId: row.companyId, status: row.status, stripePaymentIntent: row.stripe?.paymentIntentId ?? null, updatedAt: row.updatedAt });
      }
    }
    const refunds = [];
    for (const status of REFUNDS_IN_FLIGHT) {
      for (const row of await ctx.db.query("refunds").withIndex("by_status_updated", (q) => q.eq("status", status)).order("desc").take(LIST)) {
        refunds.push({ id: row._id, companyId: row.companyId, status: row.status, stripeRefund: row.stripeRefundId ?? null, updatedAt: row.updatedAt });
      }
    }
    const unconfirmed = [];
    for (const status of ["sending", "unconfirmed"] as const) {
      for (const row of await ctx.db.query("messages").withIndex("by_status_attempted", (q) => q.eq("status", status)).order("desc").take(LIST)) {
        if (row.reviewedAt !== undefined) continue;
        unconfirmed.push({ id: row._id, companyId: row.companyId, status: row.status, channel: row.channel ?? "sms", provider: row.sentVia ?? row.provider ?? null, providerMessageId: row.providerMessageId ?? null, attemptedAt: row.attemptedAt ?? null });
      }
    }
    return { payments: payments.slice(0, LIST), refunds: refunds.slice(0, LIST), unconfirmedMessages: unconfirmed.slice(0, LIST), stuckMessages: await stuckMessages(ctx, now) };
  },
});

/** One table: how many rows (up to the bound) and how many sampled rows point at a company that is not there. */
export const verifyTable = internalQuery({
  args: { table: v.string() },
  handler: async (ctx, args) => {
    const rows = (await ctx.db.query(args.table as TableNames).take(4000)) as unknown as { companyId?: Id<"companies"> }[];
    const companies = new Map<string, boolean>();
    let orphans = 0;
    for (const row of rows.slice(0, 1000)) {
      if (!row.companyId) continue;
      if (!companies.has(row.companyId)) companies.set(row.companyId, (await ctx.db.get(row.companyId)) !== null);
      if (!companies.get(row.companyId)) orphans += 1;
    }
    return { table: args.table, rows: rows.length, capped: rows.length === 4000, sampled: Math.min(rows.length, 1000), orphans };
  },
});

/** Every company table: counts and orphaned rows, to compare against the source before anything is released. */
export const verify = internalAction({
  args: {},
  handler: async (ctx): Promise<{ companies: number; tables: { table: string; rows: number; capped: boolean; sampled: number; orphans: number }[]; problems: string[]; reconcileFirst: InFlight }> => {
    const companies = await ctx.runQuery(internal.restoration.verifyTable, { table: "companies" });
    const tables = [];
    for (const entry of EXPORT_TABLES) {
      try {
        tables.push(await ctx.runQuery(internal.restoration.verifyTable, { table: entry.table }));
      } catch {
        // A table listed for later that is not in this schema yet.
      }
    }
    const problems = tables.filter((row) => row.orphans > 0).map((row) => `${row.table}: ${row.orphans} of ${row.sampled} sampled rows point at a company that is not in this copy.`);
    // What must be looked up at Stripe, Telnyx and Resend before release (docs/operations/05-recovery-runbook.md).
    const reconcileFirst: InFlight = await ctx.runQuery(internal.restoration.inFlight, {});
    const some = (n: number) => (n >= LIST ? `${LIST} or more` : String(n));
    if (reconcileFirst.payments.length) problems.push(`${some(reconcileFirst.payments.length)} card payments are in progress: look each up in Stripe before release.`);
    if (reconcileFirst.refunds.length) problems.push(`${some(reconcileFirst.refunds.length)} refunds are in progress: look each up in Stripe before release.`);
    if (reconcileFirst.unconfirmedMessages.length) problems.push(`${some(reconcileFirst.unconfirmedMessages.length)} messages may or may not have gone: look each up at its provider before release.`);
    if (reconcileFirst.stuckMessages.length) problems.push(`${some(reconcileFirst.stuckMessages.length)} queued or scheduled messages have lost their send timers: they will not go by themselves and are not sent again automatically.`);
    return { companies: companies.rows, tables, problems, reconcileFirst };
  },
});

type InFlight = {
  payments: { id: Id<"payments">; companyId: Id<"companies">; status: string; stripePaymentIntent: string | null; updatedAt: number }[];
  refunds: { id: Id<"refunds">; companyId: Id<"companies">; status: string; stripeRefund: string | null; updatedAt: number }[];
  unconfirmedMessages: { id: Id<"messages">; companyId: Id<"companies">; status: string; channel: string; provider: string | null; providerMessageId: string | null; attemptedAt: number | null }[];
  stuckMessages: StuckMessage[];
};

const ALL_PAUSED = [...AGENTS].sort().join(",");

/**
 * Undoes what the lock-down itself set, and only that. Only after reconciling: the note says what was
 * checked, and it is kept on the lock-down.
 *
 *  - Suspension is lifted only where the lock-down suspended the company and nobody has suspended or
 *    unsuspended it since. A company staff suspended before or during the lock-down stays suspended.
 *  - Agents go back to the Owner's own pauses only where they are still exactly as the lock-down left them.
 *  - A company locked for an unpaid plan (convex/billingLock.ts) keeps every agent paused. If that lock began
 *    during the lock-down, it remembered the lock-down's pauses as the Owner's; it is given the real ones,
 *    so paying puts back what the Owner chose.
 *
 * Companies left alone are counted in `skipped`, with why.
 */
export const release = internalMutation({
  args: { lockdownId: v.id("lockdowns"), note: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const lockdown = await ctx.db.get(args.lockdownId);
    if (!lockdown) throw new Error("No such lock-down.");
    if (args.note.trim().length < 20) throw new Error("Say what was reconciled (outbox, charges, numbers, Google writes) before releasing.");
    const page = await ctx.db
      .query("lockdownCompanies")
      .withIndex("by_lockdown", (q) => q.eq("lockdownId", args.lockdownId))
      .paginate({ numItems: PAGE, cursor: args.cursor ?? null });
    let restored = 0;
    const skipped: { companyId: Id<"companies">; why: string }[] = [];
    for (const row of page.page) {
      const company = await ctx.db.get(row.companyId);
      if (!company) continue;
      const why: string[] = [];
      const patch: { suspendedAt?: undefined; pausedAgents?: (typeof AGENTS)[number][] } = {};
      const prior = row.priorPausedAgents.filter((agent): agent is (typeof AGENTS)[number] => (AGENTS as readonly string[]).includes(agent));

      // Suspension: only the one the lock-down wrote, and only if staff have not decided anything since.
      const wrote = row.suspendedAtSet ?? (row.priorSuspendedAt === undefined ? row._creationTime : undefined);
      if (row.priorSuspendedAt === undefined && company.suspendedAt !== undefined) {
        const since = await ctx.db
          .query("events")
          .withIndex("by_company_at", (q) => q.eq("companyId", company._id).gte("at", row._creationTime))
          .take(2000);
        const decided = since.some((event) => event.type === "company.suspended" || event.type === "company.unsuspended");
        const same = wrote !== undefined && Math.abs(company.suspendedAt - wrote) < (row.suspendedAtSet !== undefined ? 1 : 60_000);
        if (decided || !same) why.push("suspension changed since the lock-down; left suspended");
        else patch.suspendedAt = undefined;
      }

      // Agents: only while they are still exactly as the lock-down left them.
      const untouched = [...company.pausedAgents].sort().join(",") === ALL_PAUSED;
      if (company.billingLockedAt !== undefined) {
        if (company.billingLockedAt > row._creationTime) {
          const holder = (await ctx.db.query("billingDunning").withIndex("by_company_resolved", (q) => q.eq("companyId", company._id).eq("resolvedAt", undefined)).take(20)).find((other) => other.lockedAt !== undefined && other.priorPausedAgents !== undefined);
          if (holder) await ctx.db.patch(holder._id, { priorPausedAgents: prior });
        }
        why.push("locked for an unpaid plan; agents stay paused until it is paid");
      } else if (!untouched) why.push("agent pauses changed since the lock-down; left as they are");
      else patch.pausedAgents = prior;

      if (Object.keys(patch).length > 0) await ctx.db.patch(company._id, patch);
      if (why.length > 0) skipped.push({ companyId: company._id, why: why.join("; ") });
      else restored += 1;
    }
    if (page.isDone) await ctx.db.patch(lockdown._id, { releasedAt: Date.now(), releaseNote: args.note.trim().slice(0, 1000) });
    return { restored, skipped, done: page.isDone, cursor: page.isDone ? null : page.continueCursor };
  },
});
