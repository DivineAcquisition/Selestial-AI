/**
 * Reading the hiring inbox. One run for one connection: list headers after the saved cursor, pass each
 * through the recruiting boundary (lib/recruiter/boundary.ts), open only what it lets through, file each
 * one, then save the cursor. The cursor is saved after the page is filed, never before, so a crash replays
 * the page and filing ignores what it already has. Nothing here sends, deletes or marks a message.
 *
 * Every way a read starts (the first scan, the timer, Gmail push, a reconnect, a manual refresh, the next
 * run after a failure) is this one run, so they all apply the same boundary.
 *
 * Internal only. A browser cannot start a run or hand it a message.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { recordEvent } from "./lib/events";
import { discoveryOf, gate, POSSIBLE_DAYS, type Gate, type Known } from "./lib/recruiter/boundary";
import { checked, headerEvidence, interpretByRule, REPLY_INTENTS, type Interpretation } from "./lib/recruiter/interpret";
import { applicantForSender, ingestMessage, type IngestInput } from "./lib/recruiter/intake";
import { addressOf, oneLine, plainText, type MessageBody, type MessageHeader } from "./lib/recruiter/mail";
import { accessToken, gmailConnector, googleApp } from "./lib/recruiter/gmail";
import { connectorFor, MailboxAuthError, type MailboxConnector } from "./lib/recruiter/mailbox";
import { unseal } from "./lib/recruiter/secrets";
import { hiringModel, type HiringModel } from "./lib/recruiter/model";
import { finishExecution, openExecution } from "./lib/billing/executions";
import { reserveExecution } from "./lib/billing/reserve";
import { classificationValidator, contactEvidenceValidator, sourceValidator, type Classification, type Source } from "./lib/recruiter/schema";
import { DAY, HOUR } from "./lib/recruiter/settings";
import { liveTaskByKey, openTask, setTaskState } from "./lib/taskState";
import { inboxBroke } from "./lib/inbox/events";
import { purposesOf } from "./lib/inbox/mailboxes";

const LEASE = 3 * 60 * 1000;

const PAGE = 25;
const MAX_PAGES = 8;
const EXCERPT = 6000;

const headerValidator = v.object({ id: v.string(), threadId: v.optional(v.string()), from: v.string(), replyTo: v.optional(v.string()), subject: v.string(), receivedAt: v.number() });
const evidenceValidator = v.object({ address: contactEvidenceValidator.fields.address, kind: contactEvidenceValidator.fields.kind, where: contactEvidenceValidator.fields.where });
const readValidator = v.object({
  classification: classificationValidator,
  source: sourceValidator,
  reason: v.string(),
  name: v.optional(v.string()),
  role: v.optional(v.string()),
  sourceApplicationId: v.optional(v.string()),
  phone: v.optional(v.string()),
  location: v.optional(v.string()),
  experience: v.optional(v.string()),
  availability: v.optional(v.string()),
  resume: v.optional(v.string()),
  addresses: v.array(evidenceValidator),
  replyIntent: v.optional(v.union(...REPLY_INTENTS.map((intent) => v.literal(intent)))),
  forwarded: v.boolean(),
  readBy: v.optional(v.union(v.literal("rule"), v.literal("model"))),
});

/** What a run needs to start. Null when the connection is not one to read. */
export const begin = internalQuery({
  args: { connectionId: v.id("mailboxConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status === "disconnected" || connection.status === "expired") return null;
    // Recruiter reads only an inbox connected for hiring (or one connected before purposes existed).
    if (!purposesOf(connection).includes("hiring")) return null;
    const company = await ctx.db.get(connection.companyId);
    if (!company || company.pausedAgents.includes("recruiter")) return null;
    const members = await ctx.db
      .query("members")
      .withIndex("by_company", (q) => q.eq("companyId", connection.companyId))
      .take(200);
    return {
      provider: connection.provider,
      scope: { address: connection.address, folder: connection.folder, after: connection.processFrom, mode: discoveryOf(connection) },
      cursor: connection.cursor ?? null,
      sources: connection.sources,
      // Our own addresses are never an applicant's.
      ours: [connection.address, ...members.map((member) => member.email)].map((value) => value.toLowerCase()),
    };
  },
});

/**
 * Which of these messages are new, and what Selestial already knows about each sender and thread. Reads
 * no message: only the addresses and thread ids the mailbox listed.
 */
export const triage = internalQuery({
  args: { connectionId: v.id("mailboxConnections"), messages: v.array(v.object({ id: v.string(), from: v.optional(v.string()), replyTo: v.optional(v.string()), threadId: v.optional(v.string()) })) },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) return [];
    const companyId = connection.companyId;
    // The company's working cleaners, by address: their mail about jobs and supplies is not hiring mail.
    const cleaners = new Set<string>();
    // Onboarding is left out: someone still onboarding may well write about their hiring.
    for (const status of ["ready", "paused", "suspended"] as const) {
      for (const row of await ctx.db
        .query("cleaners")
        .withIndex("by_company_status", (q) => q.eq("companyId", companyId).eq("status", status))
        .take(1000)) {
        if (row.email) cleaners.add(row.email.trim().toLowerCase());
      }
    }
    const out: { id: string; seen: boolean; known: Known }[] = [];
    for (const message of args.messages) {
      const seen = await ctx.db
        .query("sourceMessages")
        .withIndex("by_connection_message", (q) => q.eq("connectionId", connection._id).eq("providerMessageId", message.id))
        .first();
      // Their own address, or the job board's forwarding address one of their applications came with.
      const applicant = (await applicantForSender(ctx, companyId, message.from ?? null)) ?? (await applicantForSender(ctx, companyId, message.replyTo ?? null));
      const thread = message.threadId
        ? (await ctx.db
            .query("sourceMessages")
            .withIndex("by_connection_thread", (q) => q.eq("connectionId", connection._id).eq("threadId", message.threadId))
            .take(20)).some((row) => row.applicationId !== undefined && row.redactedAt === undefined)
        : false;
      const customer = message.from ? (await ctx.db.query("customers").withIndex("by_company_email", (q) => q.eq("companyId", companyId).eq("email", message.from)).first()) !== null : false;
      out.push({ id: message.id, seen: seen !== null, known: { applicant: applicant !== null, thread, customer: customer && applicant === null, cleaner: applicant === null && Boolean(message.from && cleaners.has(message.from)) } });
    }
    return out;
  },
});

export const ingest = internalMutation({
  args: {
    connectionId: v.id("mailboxConnections"),
    header: headerValidator,
    verdict: v.object({ classification: classificationValidator, classifiedBy: v.union(v.literal("rule"), v.literal("model")), reason: v.string(), source: v.optional(sourceValidator), expiresAt: v.optional(v.number()) }),
    read: v.optional(readValidator),
    excerpt: v.optional(v.string()),
    attachments: v.optional(v.array(v.object({ name: v.string(), contentType: v.string(), size: v.number(), read: v.boolean() }))),
    headerEvidence: v.optional(v.array(evidenceValidator)),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status === "disconnected") return "gone";
    const input: IngestInput = { header: args.header, verdict: args.verdict, read: args.read, excerpt: args.excerpt, attachments: args.attachments, headerEvidence: args.headerEvidence };
    return ingestMessage(ctx, connection, input);
  },
});

/**
 * One read at a time per inbox: a push notification and the timer arriving together start one run, not
 * two. A run that crashes lets go when its lease lapses.
 */
export const lease = internalMutation({
  args: { connectionId: v.id("mailboxConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    const now = Date.now();
    if (!connection || (connection.syncLeaseUntil ?? 0) > now) return false;
    await ctx.db.patch(connection._id, { syncLeaseUntil: now + LEASE });
    return true;
  },
});

export const release = internalMutation({
  args: { connectionId: v.id("mailboxConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (connection) await ctx.db.patch(connection._id, { syncLeaseUntil: undefined });
    return null;
  },
});

/** A page was filed. Saves where it ended and clears any earlier trouble. */
export const commit = internalMutation({
  args: { connectionId: v.id("mailboxConnections"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    // A person disconnected it while this run was reading. The run must not bring it back.
    if (!connection || connection.status === "disconnected") return null;
    await ctx.db.patch(connection._id, { cursor: args.cursor ?? connection.cursor, lastSyncAt: Date.now(), failures: 0, status: "connected", problem: undefined });
    const task = await liveTaskByKey(ctx, connection.companyId, `recruiter.mailbox:${connection._id}`);
    if (task) await setTaskState(ctx, task, "done", { outcome: "The hiring inbox is being read again.", closedAt: Date.now() }, { kind: "system" });
    return null;
  },
});

/** A run failed. The cursor is untouched, so the next run starts where this one did. */
export const failed = internalMutation({
  args: { connectionId: v.id("mailboxConnections"), kind: v.union(v.literal("auth"), v.literal("provider"), v.literal("not_built")) },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    // Disconnected on purpose while this run was reading: of course it failed. No status, notice or task.
    if (!connection || connection.status === "disconnected") return null;
    const failures = connection.failures + 1;
    const auth = args.kind === "auth";
    const problem = auth
      ? "The mailbox's authorization has ended. Reconnect the hiring inbox."
      : args.kind === "not_built"
        ? "This mailbox provider is not connected yet."
        : "The mailbox provider did not answer. Recruiter will try again.";
    const status = auth ? "expired" : args.kind === "not_built" || failures >= 3 ? "error" : connection.status;
    await ctx.db.patch(connection._id, { failures, status, problem });
    await recordEvent(ctx, { companyId: connection.companyId, type: "mailbox.sync_failed", actor: { kind: "system" }, subject: { table: "mailboxConnections", id: connection._id }, data: { kind: args.kind, failures } });
    // It just stopped working: the Owner and whoever connected it are told by email, once.
    if (connection.status === "connected" && status !== "connected") await inboxBroke(ctx, (await ctx.db.get(connection._id))!);
    if (status === connection.status && status === "connected") return null;
    // New applications are not being seen. That is a person's problem to know about, once.
    const key = `recruiter.mailbox:${connection._id}`;
    if (await liveTaskByKey(ctx, connection.companyId, key)) return null;
    const dueAt = Date.now() + 4 * HOUR;
    const taskId = await openTask(ctx, { companyId: connection.companyId, agent: "recruiter", title: `The hiring inbox ${connection.address} is not being read`, nextAction: problem, dueAt, completionCondition: "The hiring inbox is connected and read again", about: { table: "mailboxConnections", id: connection._id }, key, actor: { kind: "system" } });
    await setTaskState(ctx, (await ctx.db.get(taskId))!, "needs_decision", { openQuestion: `${problem} Until then, new applications are not seen.`, dueAt, withPersonSince: Date.now() }, { kind: "system" });
    return null;
  },
});

export const startRun = internalMutation({
  args: { connectionId: v.id("mailboxConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) return null;
    return ctx.db.insert("inboxRuns", { companyId: connection.companyId, connectionId: connection._id, startedAt: Date.now(), filed: 0, opened: 0, possible: 0 });
  },
});

export const finishRun = internalMutation({
  args: { runId: v.id("inboxRuns"), outcome: v.union(v.literal("read"), v.literal("partial"), v.literal("failed")), filed: v.number(), opened: v.number(), possible: v.number(), problem: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.finishedAt) return null;
    await ctx.db.patch(run._id, { finishedAt: Date.now(), outcome: args.outcome, filed: args.filed, opened: args.opened, possible: args.possible, problem: args.problem });
    return null;
  },
});

/** Run on a schedule: drops run records older than 30 days. */
export const pruneRuns = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query("inboxRuns")
      .withIndex("by_started", (q) => q.lt("startedAt", Date.now() - 30 * DAY))
      .take(500);
    for (const row of old) await ctx.db.delete(row._id);
    return old.length;
  },
});

export const sync = internalAction({
  args: { connectionId: v.id("mailboxConnections") },
  handler: async (ctx, args): Promise<{ filed: number; opened: number } | null> => {
    const start = await ctx.runQuery(internal.recruiterInbox.begin, { connectionId: args.connectionId });
    if (!start) return null;
    if (!(await ctx.runMutation(internal.recruiterInbox.lease, { connectionId: args.connectionId }))) return null;
    // What this run did, recorded whatever happens: the screens show real runs, never a guess.
    const runId = await ctx.runMutation(internal.recruiterInbox.startRun, { connectionId: args.connectionId });
    const report = { outcome: "failed" as "read" | "partial" | "failed", filed: 0, opened: 0, possible: 0, problem: undefined as string | undefined };
    try {
      const opened = await openConnector(ctx, args.connectionId, start.provider);
      if ("failure" in opened) {
        report.problem = opened.failure === "auth" ? "The mailbox's authorization has ended." : opened.failure === "not_built" ? "This mailbox provider is not connected." : "The mailbox provider did not answer.";
        await ctx.runMutation(internal.recruiterInbox.failed, { connectionId: args.connectionId, kind: opened.failure });
        return null;
      }
      const connector = opened.connector;
      const aiModel = hiringModel();
      let cursor = start.cursor;
      let filed = 0;
      let bodies = 0;
      try {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const listed = await connector.list(start.scope, cursor, PAGE);
          const marks = await ctx.runQuery(internal.recruiterInbox.triage, {
            connectionId: args.connectionId,
            messages: listed.headers.map((header) => ({ id: header.id, from: addressOf(header.from) ?? undefined, replyTo: addressOf(header.replyTo) ?? undefined, threadId: header.threadId })),
          });
          for (const header of listed.headers) {
            const mark = marks.find((row) => row.id === header.id);
            if (mark?.seen) continue;
            const known = mark?.known ?? { applicant: false, thread: false, customer: false, cleaner: false };
            const input = await decide(header, gate({ header, mode: start.scope.mode, own: start.scope.address, sources: start.sources, known }));
            await ctx.runMutation(internal.recruiterInbox.ingest, { connectionId: args.connectionId, ...input });
            filed += 1;
            if (input.verdict.classification === "possibly_hiring") report.possible += 1;
          }
          cursor = listed.cursor;
          await ctx.runMutation(internal.recruiterInbox.commit, { connectionId: args.connectionId, cursor });
          report.filed = filed;
          report.opened = bodies;
          if (!listed.more) {
            report.outcome = "read";
            break;
          }
          // The page limit with mail still waiting: the next run carries on from the saved cursor.
          report.outcome = "partial";
        }
      } catch (error) {
        report.problem = error instanceof MailboxAuthError ? "The mailbox's authorization has ended." : "The mailbox provider did not answer.";
        report.outcome = "failed";
        await ctx.runMutation(internal.recruiterInbox.failed, { connectionId: args.connectionId, kind: error instanceof MailboxAuthError ? "auth" : "provider" });
        return null;
      }
      return { filed, opened: bodies };

      /** What the boundary said, carried out: nothing fetched for "skip" and "possible", the body for "read". */
      async function decide(header: MessageHeader, decided: Gate): Promise<IngestInput> {
        if (decided.verdict === "skip") return { header, verdict: { classification: decided.classification, classifiedBy: "rule", reason: "", source: decided.source } };
        if (decided.verdict === "possible") return { header, verdict: { classification: "possibly_hiring", classifiedBy: "rule", reason: decided.reason, source: decided.source, expiresAt: Date.now() + POSSIBLE_DAYS * DAY } };
        const message = await connector!.fetch(start!.scope, header.id, { attachments: decided.attachments });
        if (!message) return { header, verdict: { classification: "unrelated", classifiedBy: "rule", reason: "" } };
        bodies += 1;
        return readMessage(ctx, args.connectionId, aiModel, header, message, decided, start!.ours);
      }
    } finally {
      if (runId) await ctx.runMutation(internal.recruiterInbox.finishRun, { runId, ...report, filed: report.filed, opened: report.opened });
      await ctx.runMutation(internal.recruiterInbox.release, { connectionId: args.connectionId });
    }
  },
});

/** The mailbox for one run, with that run's access token. The stored authorization is opened only here. */
export async function openConnector(ctx: ActionCtx, connectionId: Id<"mailboxConnections">, provider: string): Promise<{ connector: MailboxConnector } | { failure: "auth" | "provider" | "not_built" }> {
  if (provider !== "gmail") {
    const connector = connectorFor(provider);
    return connector ? { connector } : { failure: "not_built" };
  }
  const app = googleApp();
  const credential = await ctx.runQuery(internal.recruiterMailbox.credentialFor, { connectionId });
  const refreshToken = credential ? await unseal(credential.sealedRefreshToken, connectionId) : null;
  if (!app || !refreshToken) return { failure: app ? "auth" : "not_built" };
  try {
    return { connector: gmailConnector({ token: await accessToken(app, refreshToken) }) };
  } catch (error) {
    return { failure: error instanceof MailboxAuthError ? "auth" : "provider" };
  }
}

/**
 * Reads one message the boundary let through. A job board's notice is read by the rules first, which costs
 * nothing; the AI reader is used when the rules could not find who applied, and for anything a person
 * wrote (an application, an inquiry, a reply). Whoever reads it, the reading is checked against the message
 * before it is used, and only an answer the AI reader actually gave is charged.
 */
export async function readMessage(
  ctx: ActionCtx,
  connectionId: Id<"mailboxConnections">,
  model: HiringModel,
  header: MessageHeader,
  message: MessageBody,
  decided: { classification: Classification; source?: Source; reason: string },
  ours: string[],
): Promise<IngestInput> {
  const filed = { excerpt: plainText(message.text, EXCERPT), attachments: message.attachments.slice(0, 10).map((file) => ({ name: file.name.slice(0, 160), contentType: file.contentType.slice(0, 100), size: file.size, read: Boolean(file.text) })) };
  const known = decided.classification === "applicant_reply" ? { source: decided.source ?? ("direct" as const), classification: "applicant_reply" as const } : decided.source ? { source: decided.source, classification: decided.classification } : null;
  let read: Interpretation | null = null;
  if (known && known.classification !== "applicant_reply") {
    const byRule = checked(interpretByRule(message, known), message);
    if (byRule.name && (byRule.phone || byRule.addresses.some((entry) => entry.kind === "direct" || entry.kind === "relay"))) read = byRule;
  }
  read ??= await readByModel(ctx, connectionId, model, header.id, message, known);
  if (known) read.classification = known.classification;
  const classifiedBy = read.readBy === "model" ? ("model" as const) : ("rule" as const);
  if (read.classification === "unrelated") return { header, verdict: { classification: "unrelated", classifiedBy, reason: "" } };
  return { header, verdict: { classification: read.classification, classifiedBy, reason: oneLine(decided.reason, 200), source: read.source }, read, ...filed, headerEvidence: headerEvidence(message, ours) };
}

/**
 * The AI reader, for one message, once Selestial Credits are held for it. Without a verified hold (no plan,
 * no credits, billing unreachable, the monthly budget for automatic work spent) the rules read it instead,
 * so no application is dropped and nothing is charged.
 */
async function readByModel(ctx: ActionCtx, connectionId: Id<"mailboxConnections">, model: HiringModel, messageId: string, message: MessageBody, known: { source: Source; classification: Classification } | null): Promise<Interpretation> {
  const byRules = () => checked(interpretByRule(message, known), message);
  if (model.name === "rules") return byRules();
  const executionId = await ctx.runMutation(internal.recruiterInbox.openReading, { connectionId, messageId });
  if (!executionId) return byRules();
  const held = await reserveExecution(ctx, executionId);
  if (!held.ok) return byRules();
  try {
    const read = checked(await model.interpret(message, known), message);
    // The AI reader falls back to the rules on its own when it gives no usable answer: that is not charged.
    await ctx.runMutation(internal.recruiterInbox.finishReading, { executionId, read: read.readBy === "model" });
    return read;
  } catch (error) {
    await ctx.runMutation(internal.recruiterInbox.finishReading, { executionId, read: false });
    throw error;
  }
}

/** Opens the execution for one message's AI reading. Null when it cannot be charged, so the rules read it. */
export const openReading = internalMutation({
  args: { connectionId: v.id("mailboxConnections"), messageId: v.string() },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    const company = connection ? await ctx.db.get(connection.companyId) : null;
    if (!connection || !company) return null;
    const opened = await openExecution(ctx, { company, key: `hiring-read:${connection._id}:${args.messageId.slice(0, 200)}`, agent: "recruiter", task: "hiring_message_reading", units: 1, autonomous: true, origin: "automatic", source: { table: "mailboxConnections", id: connection._id }, link: { label: "Hiring inbox", path: "/app/settings/recruiting" } });
    return opened.ok && !opened.repeated ? opened.executionId : null;
  },
});

export const finishReading = internalMutation({
  args: { executionId: v.id("aiExecutions"), read: v.boolean() },
  handler: async (ctx, args) => {
    await finishExecution(ctx, args.executionId, args.read ? { completedUnits: 1 } : { ended: "failed" });
  },
});

/** Run on a schedule: starts a run for every connection that can be read. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    let started = 0;
    for await (const connection of ctx.db.query("mailboxConnections")) {
      if (connection.status === "disconnected" || connection.status === "expired") continue;
      await ctx.scheduler.runAfter(0, internal.recruiterInbox.sync, { connectionId: connection._id });
      started += 1;
    }
    return started;
  },
});
