/**
 * Client Care's background work, in separate steps so a crash between any two is recoverable and nothing
 * is done twice (docs/care/00-architecture.md):
 *
 *   begin   (a mutation) takes a queued run under a lease, checks the company, the pause and the plan, and,
 *           when an AI reader is connected, opens the credit execution for this one reading.
 *   read    (the action) holds the credits and has the reader read the message. Without a verified hold, or if
 *           the reader fails, the company's rules read it and nothing is charged.
 *   apply   (a mutation) attaches the reading to requests and works each forward through the step engine.
 *           Everything it writes is one transaction; the run is marked done in the same one.
 *
 * A run whose worker died is found by the sweep when its lease lapses and is tried again, up to three times,
 * then a person is told. Requests due a follow-up are checked by the sweep too. Nothing here calls a messaging
 * provider: every message goes through the outbox (convex/messaging.ts).
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { agentVerdict } from "./lib/billing/access";
import { finishExecution, openExecution } from "./lib/billing/executions";
import { reserveExecution } from "./lib/billing/reserve";
import { AGENT_PROFILES } from "./lib/departments";
import { applyReading } from "./lib/clientCare/intake";
import { careModel } from "./lib/clientCare/model";
import { checkedReading, readByRule, type Reading } from "./lib/clientCare/read";
import { isOpen } from "./lib/clientCare/requests";
import { followThrough } from "./lib/clientCare/workflows";
import { liveTaskByKey, openTask } from "./lib/taskState";

const MINUTE = 60_000;
const LEASE = 3 * MINUTE;
const MAX_ATTEMPTS = 3;
const SYSTEM = { kind: "system" } as const;

/** The reading arrives as data and is checked again here; a malformed one is replaced by the rules'. */
const readingArg = v.any();

function stopped(company: Doc<"companies"> | null): string | null {
  if (!company || company.closingAt || company.deletedAt) return "The company is not active.";
  if (company.suspendedAt) return "The company is suspended.";
  return null;
}

/**
 * Why Care only records requests for this company, if it does: its plan doesn't include Client Care. Like every
 * agent's rules-based work, Care's runs before a plan is chosen; its AI reading is the plan's (openExecution).
 */
function recordOnly(company: Doc<"companies">): string | null {
  if (!company.plan) return null;
  const verdict = agentVerdict(company, "customer-care");
  return verdict.ok ? null : `${verdict.message} Client Care recorded the request; a person answers it.`;
}

async function finish(ctx: MutationCtx, run: Doc<"careRuns">, status: "done" | "skipped" | "failed", result: string) {
  await ctx.db.patch(run._id, { status, result: result.slice(0, 400), finishedAt: Date.now(), leaseUntil: undefined });
}

export const begin = internalMutation({
  args: { runId: v.id("careRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    const now = Date.now();
    if (!run || run.kind !== "read" || (run.status !== "queued" && !(run.status === "running" && (run.leaseUntil ?? 0) < now))) return null;
    const company = await ctx.db.get(run.companyId);
    const stop = stopped(company);
    if (stop) {
      await finish(ctx, run, "skipped", stop);
      return null;
    }
    // Paused: the message is kept, unread, and shown on Care's screens. The sweep picks it up when Care is resumed.
    if (company!.pausedAgents.includes("customer-care")) return null;
    const message = run.messageId ? await ctx.db.get(run.messageId) : null;
    if (!message || message.status !== "queued") {
      await finish(ctx, run, "skipped", "There was nothing to read.");
      return null;
    }
    await ctx.db.patch(run._id, { status: "running", attempts: run.attempts + 1, startedAt: now, leaseUntil: now + LEASE });
    let executionId: Id<"aiExecutions"> | null = null;
    let billingNote: string | null = null;
    // An AI reading is one billable unit, opened here and held in the action. A retry of the same run reuses it.
    if (careModel().name !== "rules" && !recordOnly(company!)) {
      const opened = await openExecution(ctx, { company: company!, key: `care-read:${run._id}`, agent: "customer-care", task: "care_message_reading", units: 1, autonomous: true, origin: "automatic", source: { table: "careMessages", id: message._id }, link: { label: "Client Care", path: "/app/agents/customer-care/requests" } });
      if (opened.ok) executionId = opened.executionId;
      else billingNote = opened.message;
      if (executionId) await ctx.db.patch(run._id, { executionId });
    }
    return { text: message.text, timezone: company!.timezone, receivedAt: message.receivedAt, executionId, billingNote };
  },
});

export const apply = internalMutation({
  args: { runId: v.id("careRuns"), reading: readingArg, read: v.boolean(), notes: v.array(v.string()) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "running") return null;
    const company = await ctx.db.get(run.companyId);
    const message = run.messageId ? await ctx.db.get(run.messageId) : null;
    if (!company || !message) {
      await finish(ctx, run, "skipped", "The message or the company is gone.");
      return null;
    }
    // Whatever came back is checked against the message and the rules again here, inside the transaction.
    const rules = readByRule(message.text, message.receivedAt, company.timezone);
    const given = args.reading as Reading | null;
    const reading = given && Array.isArray(given.intents) && given.reader !== "rules" ? checkedReading(given, rules, message.text) : rules;
    const result = await applyReading(ctx, company, message, reading, { recordOnly: recordOnly(company) });
    await ctx.db.patch(run._id, { reader: reading.reader });
    await finish(ctx, (await ctx.db.get(run._id))!, "done", [result, ...args.notes].join(" "));
    // Charged only when the AI reader actually read the message. Anything else releases the hold.
    if (run.executionId) await finishExecution(ctx, run.executionId, args.read ? { completedUnits: 1 } : { ended: "failed" });
    return null;
  },
});

export const failed = internalMutation({
  args: { runId: v.id("careRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status === "done" || run.status === "skipped") return null;
    if (run.executionId) await finishExecution(ctx, run.executionId, { ended: "failed" });
    if (run.attempts < MAX_ATTEMPTS) {
      await ctx.db.patch(run._id, { status: "queued", leaseUntil: undefined, executionId: undefined, result: "This attempt did not finish. Client Care tries again." });
      await ctx.scheduler.runAfter(run.attempts * 30_000, internal.clientCareWork.read, { runId: run._id });
      return null;
    }
    await finish(ctx, run, "failed", "Client Care could not read this message after three tries. Nothing was sent.");
    await giveUp(ctx, run);
    return null;
  },
});

async function giveUp(ctx: MutationCtx, run: Doc<"careRuns">) {
  const message = run.messageId ? await ctx.db.get(run.messageId) : null;
  const key = `care.run_failed:${run._id}`;
  if (await liveTaskByKey(ctx, run.companyId, key)) return;
  await openTask(ctx, { companyId: run.companyId, agent: "customer-care", title: "Client Care could not read a client's message", nextAction: "Open the client's conversation and answer the message yourself.", dueAt: Date.now() + 60 * MINUTE, completionCondition: "A person read the message and dealt with it", about: message ? { table: "customers", id: message.customerId } : undefined, key, actor: SYSTEM });
}

export const read = internalAction({
  args: { runId: v.id("careRuns") },
  handler: async (ctx, args) => {
    try {
      const started = await ctx.runMutation(internal.clientCareWork.begin, { runId: args.runId });
      if (!started) return null;
      const notes: string[] = [];
      let model = careModel();
      if (model.name !== "rules") {
        const held = started.executionId ? await reserveExecution(ctx, started.executionId) : null;
        if (!held?.ok) {
          const why = held && !held.ok ? held.message : started.billingNote;
          if (why) notes.push(`Read by the company's rules instead of AI: ${why}`);
          model = careModel("rules");
        }
      }
      let reading: Reading | null = null;
      let read = false;
      try {
        reading = await model.read({ text: started.text, now: started.receivedAt, timezone: started.timezone });
        read = model.name !== "rules" && reading.reader !== "rules";
      } catch {
        notes.push("The AI reader did not answer, so the company's rules read the message.");
        reading = null;
      }
      await ctx.runMutation(internal.clientCareWork.apply, { runId: args.runId, reading, read, notes });
    } catch (error) {
      if (process.env.CARE_DEBUG) console.error("care run failed", error);
      await ctx.runMutation(internal.clientCareWork.failed, { runId: args.runId });
    }
    return null;
  },
});

/** Looks at one request on its own: a follow-up, a promised update, linked work that finished. */
export const check = internalMutation({
  args: { requestId: v.id("careRequests"), at: v.number() },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request || !isOpen(request)) return null;
    const company = await ctx.db.get(request.companyId);
    if (stopped(company) || company!.pausedAgents.includes("customer-care")) return null;
    // Another check already ran for this moment.
    if (request.nextCheckAt !== args.at) return null;
    await ctx.db.patch(request._id, { nextCheckAt: undefined });
    if (recordOnly(company!)) return null;
    const result = await followThrough(ctx, company!, request._id);
    await ctx.db.insert("careRuns", { companyId: request.companyId, kind: "check", key: `check:${request._id}:${args.at}`, requestId: request._id, status: "done", attempts: 1, result: result.slice(0, 400), queuedAt: args.at, startedAt: Date.now(), finishedAt: Date.now() });
    return null;
  },
});

/**
 * Every five minutes: runs whose worker died go back in the queue (and after three tries to a person), queued
 * runs that never started are started, and requests due a check are checked. Paused companies are left alone.
 */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (!AGENT_PROFILES["customer-care"].built) return { retried: 0, checked: 0 };
    const now = Date.now();
    let retried = 0;
    const running = await ctx.db
      .query("careRuns")
      .withIndex("by_status_queued", (q) => q.eq("status", "running"))
      .take(100);
    for (const run of running) {
      if ((run.leaseUntil ?? 0) > now) continue;
      const company = await ctx.db.get(run.companyId);
      if (!company || company.pausedAgents.includes("customer-care")) continue;
      if (run.attempts >= MAX_ATTEMPTS) {
        if (run.executionId) await finishExecution(ctx, run.executionId, { ended: "failed" });
        await finish(ctx, run, "failed", "Client Care could not finish reading this message after three tries. Nothing was sent.");
        await giveUp(ctx, run);
        continue;
      }
      await ctx.db.patch(run._id, { status: "queued", leaseUntil: undefined });
      await ctx.scheduler.runAfter(0, internal.clientCareWork.read, { runId: run._id });
      retried += 1;
    }
    const queued = await ctx.db
      .query("careRuns")
      .withIndex("by_status_queued", (q) => q.eq("status", "queued").lt("queuedAt", now - 2 * MINUTE))
      .take(100);
    for (const run of queued) {
      const company = await ctx.db.get(run.companyId);
      if (!company || company.pausedAgents.includes("customer-care") || company.suspendedAt) continue;
      await ctx.scheduler.runAfter(0, internal.clientCareWork.read, { runId: run._id });
      retried += 1;
    }
    let checked = 0;
    const due = await ctx.db
      .query("careRequests")
      .withIndex("by_check", (q) => q.gt("nextCheckAt", 0).lte("nextCheckAt", now))
      .take(50);
    for (const request of due) {
      const company = await ctx.db.get(request.companyId);
      if (!company || company.pausedAgents.includes("customer-care") || company.suspendedAt) continue;
      await ctx.scheduler.runAfter(0, internal.clientCareWork.check, { requestId: request._id, at: request.nextCheckAt! });
      checked += 1;
    }
    return { retried, checked };
  },
});

/** A person resumed Care: what waited unread is read now. */
export const resume = internalMutation({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const queued = await ctx.db
      .query("careRuns")
      .withIndex("by_company_queued", (q) => q.eq("companyId", args.companyId))
      .order("desc")
      .take(100);
    for (const run of queued) if (run.status === "queued") await ctx.scheduler.runAfter(0, internal.clientCareWork.read, { runId: run._id });
    return null;
  },
});
