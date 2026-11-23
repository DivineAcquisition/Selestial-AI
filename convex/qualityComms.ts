/**
 * Quality's connection to a phone platform (Quo), and what it does with what arrives.
 *
 * Connecting: the Owner pastes a Quo API key; it is sealed at rest and checked. The check reads the workspace's
 * numbers and a few recent calls, looks for a transcript, and registers a signed webhook. Each capability is
 * recorded as checked (available / unavailable / unknown), never assumed. Reading is off until the Owner turns
 * it on in Quality's Playbook, and nothing before the chosen start date is read.
 *
 * Arriving: signed webhooks (deduplicated by delivery id, in any order) and a bounded poll every ten minutes
 * catch calls, texts, summaries and transcripts, including transcripts that arrive after the call and
 * revisions. Each item becomes a keyed run that links it to a visit only on evidence, reads it by rules, and
 * hands a concern to the visit's quality case. An expired key, a refused request or an outage is shown on the
 * connection with what to do, and reading resumes when it clears.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { managerMutation, managerQuery, ownerMutation } from "./lib/builders";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { owned } from "./lib/access";
import { seal, secretsConfigured, unseal } from "./lib/recruiter/secrets";
import { newLinkId, publicIdFor } from "./lib/sales/links";
import { applySummary, applyTranscripts, ingestCall, ingestMessage, LOOKBACK, markUnavailable } from "./lib/quality/comms/ingest";
import { decideAssociation } from "./lib/quality/comms/match";
import { extractFromMessage, extractFromSegments, extractFromSummary, isRepeat, type Extract } from "./lib/quality/comms/extract";
import { parseQuoEvent, QUO_EVENTS, QuoError, quoClient } from "./lib/quality/comms/quo";
import { agentState, finishRun, leaseRun } from "./lib/quality/runs";
import { qualitySettings } from "./lib/quality/settings";
import { onConcern, reviewVisit } from "./lib/quality/workflow";
import { addEntry } from "./lib/quality/cases";
import { DAY, MINUTE, QUALITY, SYSTEM } from "./lib/quality/words";

const UNKNOWN_CAPABILITIES = { readMessages: "unknown", readThreads: "not_used", readCallMetadata: "unknown", readTranscripts: "unknown", readSummaries: "unknown", recordings: "not_used", webhooks: "unknown", send: "not_used" } as const;

/** A call as stored: Quo's own web link to it is not kept. */
function withoutLink<T extends { link?: unknown }>(call: T): Omit<T, "link"> {
  const copy = { ...call };
  delete copy.link;
  return copy;
}

// ── Connecting ───────────────────────────────────────────────────────────────────────────────────

export const connectQuo = ownerMutation({
  args: { apiKey: v.string(), readDays: v.number() },
  handler: async (ctx, args) => {
    const key = args.apiKey.trim();
    if (key.length < 16 || key.length > 200 || /\s/.test(key)) throw userError("Paste the API key exactly as Quo shows it (Workspace Settings → API).");
    if (![0, 7, 30].includes(args.readDays)) throw userError("Choose to read from now, or from 7 or 30 days back.");
    if (!(await secretsConfigured())) throw userError("Keys can't be stored safely on this deployment yet, so Quo can't be connected.");
    const existing = await ctx.db.query("qualityConnections").withIndex("by_company_provider", (q) => q.eq("companyId", ctx.companyId).eq("provider", "quo")).take(5);
    if (existing.some((c) => c.status !== "disconnected")) throw userError("Quo is already connected. Disconnect it first to use a different key.");
    const now = Date.now();
    const connectionId = await ctx.db.insert("qualityConnections", { companyId: ctx.companyId, provider: "quo", publicId: newLinkId(), label: "Quo", status: "checking", numbers: [], capabilities: { ...UNKNOWN_CAPABILITIES }, readFrom: now - args.readDays * DAY, failures: 0, connectedBy: ctx.member._id, connectedAt: now });
    const sealed = await seal(key, connectionId);
    if (!sealed) throw userError("Keys can't be stored safely on this deployment yet, so Quo can't be connected.");
    await ctx.db.insert("qualityCredentials", { companyId: ctx.companyId, connectionId, sealedKey: sealed, createdAt: now });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quality_connection.added", actor: byMember(ctx), subject: { table: "qualityConnections", id: connectionId }, data: { provider: "quo" } });
    await ctx.scheduler.runAfter(0, internal.qualityComms.check, { connectionId });
    return { connectionId };
  },
});

export const credentialFor = internalQuery({
  args: { connectionId: v.id("qualityConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status === "disconnected") return null;
    const credential = await ctx.db.query("qualityCredentials").withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId)).first();
    return credential ? { connection, sealedKey: credential.sealedKey, sealedWebhookKey: credential.sealedWebhookKey ?? null } : null;
  },
});

/** Checks the key and what this workspace actually allows. Each capability is recorded as checked, never assumed. */
export const check = internalAction({
  args: { connectionId: v.id("qualityConnections") },
  handler: async (ctx, args): Promise<null> => {
    const found = await ctx.runQuery(internal.qualityComms.credentialFor, args);
    if (!found) return null;
    const key = await unseal(found.sealedKey, args.connectionId);
    if (!key) {
      await ctx.runMutation(internal.qualityComms.checked, { connectionId: args.connectionId, ok: false, problem: "The key could not be read back. Paste it again." });
      return null;
    }
    const api = quoClient(key);
    try {
      let numbers: { id: string; number: string; name?: string }[] = [];
      try {
        numbers = await api.numbers();
      } catch (error) {
        if (error instanceof QuoError && error.kind === "unauthorized") throw error;
      }
      const page = await api.calls({ since: Date.now() - 14 * DAY, limit: 10 });
      let transcripts: "available" | "unavailable" | "unknown" = "unknown";
      for (const call of page.calls.filter((c) => (c.duration ?? 0) > 0).slice(0, 3)) {
        const t = await api.transcripts(call.id);
        if (t.some((x) => x.status === "completed")) {
          transcripts = "available";
          break;
        }
        if (t.length && t.every((x) => x.status === "absent")) transcripts = "unavailable";
      }
      const summaries = page.calls.some((c) => c.summary?.status === "completed") ? "available" : page.calls.length && page.calls.every((c) => !c.summary || c.summary.status === "absent") ? "unavailable" : "unknown";
      const site = process.env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
      let webhook: { id: string; key: string } | null = null;
      if (site && !found.connection.webhookId) webhook = await api.createWebhook(`${site}/webhooks/quo/${found.connection.publicId}`, QUO_EVENTS);
      const sealedWebhookKey = webhook ? await seal(webhook.key, args.connectionId) : null;
      await ctx.runMutation(internal.qualityComms.checked, {
        connectionId: args.connectionId,
        ok: true,
        numbers,
        capabilities: { readMessages: webhook || found.connection.webhookId ? "available" : "unavailable", readThreads: "not_used", readCallMetadata: "available", readTranscripts: transcripts, readSummaries: summaries, recordings: "not_used", webhooks: webhook || found.connection.webhookId ? "available" : site ? "unavailable" : "unknown", send: "not_used" },
        ...(webhook ? { webhookId: webhook.id } : {}),
        ...(sealedWebhookKey ? { sealedWebhookKey } : {}),
      });
    } catch (error) {
      const problem = error instanceof QuoError ? error.message : "Quo could not be reached. Try again in a few minutes.";
      await ctx.runMutation(internal.qualityComms.checked, { connectionId: args.connectionId, ok: false, problem, expired: error instanceof QuoError && error.kind === "unauthorized" });
    }
    return null;
  },
});

const capabilityValidator = v.union(v.literal("available"), v.literal("unavailable"), v.literal("unknown"), v.literal("not_used"));

export const checked = internalMutation({
  args: {
    connectionId: v.id("qualityConnections"),
    ok: v.boolean(),
    problem: v.optional(v.string()),
    expired: v.optional(v.boolean()),
    numbers: v.optional(v.array(v.object({ id: v.string(), number: v.string(), name: v.optional(v.string()) }))),
    capabilities: v.optional(v.object({ readMessages: capabilityValidator, readThreads: capabilityValidator, readCallMetadata: capabilityValidator, readTranscripts: capabilityValidator, readSummaries: capabilityValidator, recordings: capabilityValidator, webhooks: capabilityValidator, send: capabilityValidator })),
    webhookId: v.optional(v.string()),
    sealedWebhookKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status === "disconnected") return null;
    if (!args.ok) {
      await ctx.db.patch(connection._id, { status: args.expired ? "expired" : "error", problem: args.problem, failures: connection.failures + 1, lastSyncAt: Date.now() });
      return null;
    }
    await ctx.db.patch(connection._id, { status: "connected", problem: undefined, failures: 0, numbers: args.numbers ?? connection.numbers, capabilities: args.capabilities ?? connection.capabilities, webhookId: args.webhookId ?? connection.webhookId, lastSyncAt: Date.now(), lastSuccessAt: Date.now() });
    if (args.sealedWebhookKey) {
      const credential = await ctx.db.query("qualityCredentials").withIndex("by_connection", (q) => q.eq("connectionId", connection._id)).first();
      if (credential) await ctx.db.patch(credential._id, { sealedWebhookKey: args.sealedWebhookKey });
    }
    return null;
  },
});

export const recheck = ownerMutation({
  args: { connectionId: v.id("qualityConnections") },
  handler: async (ctx, args) => {
    const connection = await owned(ctx, args.connectionId);
    if (connection.status === "disconnected") throw userError("Connect Quo again with a new key.");
    await ctx.db.patch(connection._id, { status: "checking" });
    await ctx.scheduler.runAfter(0, internal.qualityComms.check, { connectionId: connection._id });
    return null;
  },
});

export const disconnect = ownerMutation({
  args: { connectionId: v.id("qualityConnections") },
  handler: async (ctx, args) => {
    const connection = await owned(ctx, args.connectionId);
    if (connection.status === "disconnected") return null;
    const credential = await ctx.db.query("qualityCredentials").withIndex("by_connection", (q) => q.eq("connectionId", connection._id)).first();
    if (credential && connection.webhookId) await ctx.scheduler.runAfter(0, internal.qualityComms.removeWebhook, { sealedKey: credential.sealedKey, connectionId: connection._id, webhookId: connection.webhookId });
    if (credential) await ctx.db.delete(credential._id);
    await ctx.db.patch(connection._id, { status: "disconnected", disconnectedAt: Date.now(), problem: undefined });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quality_connection.removed", actor: byMember(ctx), subject: { table: "qualityConnections", id: connection._id }, data: { provider: "quo" } });
    return null;
  },
});

/** Best effort: the webhook at Quo is removed. If it cannot be, deliveries are refused anyway (no key is kept). */
export const removeWebhook = internalAction({
  args: { sealedKey: v.string(), connectionId: v.id("qualityConnections"), webhookId: v.string() },
  handler: async (_ctx, args): Promise<null> => {
    const key = await unseal(args.sealedKey, args.connectionId);
    if (key) await quoClient(key).deleteWebhook(args.webhookId).catch(() => undefined);
    return null;
  },
});

// ── Webhooks ─────────────────────────────────────────────────────────────────────────────────────

export const webhookKey = internalQuery({
  args: { publicId: v.string() },
  handler: async (ctx, args) => {
    if (args.publicId.length > 64) return null;
    const connection = await ctx.db.query("qualityConnections").withIndex("by_publicId", (q) => q.eq("publicId", args.publicId)).first();
    if (!connection || connection.status === "disconnected") return null;
    const credential = await ctx.db.query("qualityCredentials").withIndex("by_connection", (q) => q.eq("connectionId", connection._id)).first();
    return credential?.sealedWebhookKey ? { connectionId: connection._id, sealedWebhookKey: credential.sealedWebhookKey } : null;
  },
});

async function applyEvent(ctx: MutationCtx, connection: Doc<"qualityConnections">, body: string): Promise<string> {
  const event = parseQuoEvent(body);
  if (!event) return "unreadable";
  const company = await ctx.db.get(connection.companyId);
  if (!company || !qualitySettings(company).readPhonePlatform) return "reading is off";
  if (event.kind === "call") return (await ingestCall(ctx, connection, event.call)) ? "call" : "before the start date";
  if (event.kind === "message") return (await ingestMessage(ctx, connection, event.message)) ? "message" : "before the start date";
  const comm = event.kind === "transcript" || event.kind === "summary" ? await ctx.db.query("qualityComms").withIndex("by_connection_provider_id", (q) => q.eq("connectionId", connection._id).eq("providerId", event.callId)).first() : null;
  // A transcript can arrive before its call: the poll fetches the call and the transcript together later.
  if (!comm) return "call not seen yet";
  if (event.kind === "transcript") return applyTranscripts(ctx, connection, comm, [event.transcript]);
  if (event.kind === "summary") {
    await applySummary(ctx, comm, event.summary);
    return "summary";
  }
  return "ignored";
}

export const webhook = internalMutation({
  args: { connectionId: v.id("qualityConnections"), deliveryId: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status === "disconnected") return "disconnected";
    const seen = await ctx.db.query("qualityWebhookEvents").withIndex("by_connection_delivery", (q) => q.eq("connectionId", connection._id).eq("deliveryId", args.deliveryId)).first();
    if (seen) return "duplicate";
    const parsed = parseQuoEvent(args.body);
    await ctx.db.insert("qualityWebhookEvents", { connectionId: connection._id, deliveryId: args.deliveryId, eventId: parsed?.eventId, type: parsed && "type" in parsed ? parsed.type : parsed?.kind ?? "unreadable", receivedAt: Date.now() });
    return applyEvent(ctx, connection, args.body);
  },
});

// ── Polling: bounded, resumable, and honest about outages ────────────────────────────────────────

export const syncBegin = internalMutation({
  args: { connectionId: v.id("qualityConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status === "disconnected" || connection.status === "checking" || connection.status === "expired") return null;
    const company = await ctx.db.get(connection.companyId);
    if (!company || !qualitySettings(company).readPhonePlatform) return null;
    const now = Date.now();
    if (connection.leaseUntil !== undefined && connection.leaseUntil > now) return null;
    await ctx.db.patch(connection._id, { leaseUntil: now + 5 * MINUTE, lastSyncAt: now });
    const credential = await ctx.db.query("qualityCredentials").withIndex("by_connection", (q) => q.eq("connectionId", connection._id)).first();
    const due = await ctx.db.query("qualityComms").withIndex("by_recheck", (q) => q.gt("recheckAt", 0).lte("recheckAt", now)).take(40);
    return credential ? { sealedKey: credential.sealedKey, since: Math.max(connection.readFrom, connection.syncCursor ?? connection.readFrom), recheck: due.filter((c) => c.connectionId === connection._id).slice(0, 15).map((c) => ({ commId: c._id, providerId: c.providerId })) } : null;
  },
});

const callValidator = v.object({ id: v.string(), phoneNumberId: v.optional(v.string()), direction: v.union(v.literal("incoming"), v.literal("outgoing")), status: v.optional(v.string()), participants: v.array(v.string()), createdAt: v.number(), completedAt: v.optional(v.number()), duration: v.optional(v.number()), summary: v.optional(v.object({ status: v.union(v.literal("absent"), v.literal("in_progress"), v.literal("completed"), v.literal("failed")), lines: v.array(v.string()), nextSteps: v.array(v.string()) })) });
const transcriptValidator = v.object({ recordingId: v.optional(v.string()), status: v.union(v.literal("absent"), v.literal("in_progress"), v.literal("completed"), v.literal("failed")), dialogue: v.array(v.object({ content: v.string(), start: v.number(), end: v.number(), identifier: v.union(v.string(), v.null()), actorId: v.union(v.string(), v.null()) })) });

export const syncApply = internalMutation({
  args: { connectionId: v.id("qualityConnections"), calls: v.array(callValidator), transcripts: v.array(v.object({ providerId: v.string(), items: v.array(transcriptValidator), gone: v.optional(v.boolean()) })) },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status === "disconnected") return 0;
    let n = 0;
    for (const call of args.calls) if (await ingestCall(ctx, connection, call)) n += 1;
    for (const t of args.transcripts) {
      const comm = await ctx.db.query("qualityComms").withIndex("by_connection_provider_id", (q) => q.eq("connectionId", connection._id).eq("providerId", t.providerId)).first();
      if (!comm) continue;
      if (t.gone) await markUnavailable(ctx, comm);
      else await applyTranscripts(ctx, connection, comm, t.items);
    }
    return n;
  },
});

export const syncFinish = internalMutation({
  args: { connectionId: v.id("qualityConnections"), ok: v.boolean(), cursor: v.optional(v.number()), problem: v.optional(v.string()), expired: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status === "disconnected") return null;
    const now = Date.now();
    if (args.ok) await ctx.db.patch(connection._id, { leaseUntil: undefined, lastSuccessAt: now, failures: 0, problem: undefined, status: "connected", ...(args.cursor !== undefined ? { syncCursor: Math.max(connection.syncCursor ?? 0, args.cursor) } : {}) });
    else await ctx.db.patch(connection._id, { leaseUntil: undefined, failures: connection.failures + 1, problem: args.problem, status: args.expired ? "expired" : "error" });
    return null;
  },
});

export const sync = internalAction({
  args: { connectionId: v.id("qualityConnections") },
  handler: async (ctx, args): Promise<null> => {
    const begun = await ctx.runMutation(internal.qualityComms.syncBegin, args);
    if (!begun) return null;
    const key = await unseal(begun.sealedKey, args.connectionId);
    if (!key) {
      await ctx.runMutation(internal.qualityComms.syncFinish, { connectionId: args.connectionId, ok: false, problem: "The stored key could not be read. Reconnect Quo.", expired: true });
      return null;
    }
    const api = quoClient(key);
    try {
      let after: string | undefined;
      let cursor = begun.since;
      // At most three pages a sync; the rest is read next time. The cursor only moves forward.
      for (let page = 0; page < 3; page += 1) {
        const result = await api.calls({ since: begun.since, after, limit: 50 });
        for (const c of result.calls) cursor = Math.max(cursor, c.createdAt);
        await ctx.runMutation(internal.qualityComms.syncApply, { connectionId: args.connectionId, calls: result.calls.map(withoutLink), transcripts: [] });
        if (!result.next) break;
        after = result.next;
      }
      const transcripts = [];
      for (const r of begun.recheck) {
        try {
          transcripts.push({ providerId: r.providerId, items: await api.transcripts(r.providerId) });
        } catch (error) {
          if (error instanceof QuoError && error.kind === "not_found") transcripts.push({ providerId: r.providerId, items: [], gone: true });
          else throw error;
        }
      }
      if (transcripts.length) await ctx.runMutation(internal.qualityComms.syncApply, { connectionId: args.connectionId, calls: [], transcripts });
      await ctx.runMutation(internal.qualityComms.syncFinish, { connectionId: args.connectionId, ok: true, cursor: Math.max(begun.since, cursor - 10 * MINUTE) });
    } catch (error) {
      const problem = error instanceof QuoError ? error.message : "Quo could not be reached. Reading resumes on the next sync.";
      await ctx.runMutation(internal.qualityComms.syncFinish, { connectionId: args.connectionId, ok: false, problem, expired: error instanceof QuoError && error.kind === "unauthorized" });
    }
    return null;
  },
});

/** Every ten minutes: each readable connection is synced once. An expired key waits for the Owner to reconnect. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    let n = 0;
    for (const status of ["connected", "error"] as const) {
      const rows = await ctx.db.query("qualityConnections").withIndex("by_status", (q) => q.eq("status", status)).take(200);
      for (const c of rows) {
        const company = await ctx.db.get(c.companyId);
        if (!company || company.suspendedAt || !qualitySettings(company).readPhonePlatform) continue;
        await ctx.scheduler.runAfter(0, internal.qualityComms.sync, { connectionId: c._id });
        n += 1;
      }
    }
    return n;
  },
});

// ── Processing what arrived ──────────────────────────────────────────────────────────────────────

async function explicitJob(ctx: MutationCtx, companyId: Id<"companies">, text: string): Promise<Id<"jobs"> | undefined> {
  for (const m of text.matchAll(/\/c\/(care|quality)\/([A-Za-z0-9_.-]{10,200})/g)) {
    const kind = m[1] as "care" | "quality";
    const publicId = await publicIdFor(kind, m[2].replace(/\.$/, ""));
    if (!publicId) continue;
    if (kind === "care") {
      const link = await ctx.db.query("retentionLinks").withIndex("by_publicId", (q) => q.eq("publicId", publicId)).first();
      if (link?.companyId === companyId && link.jobId) return link.jobId;
    } else {
      const request = await ctx.db.query("qualityRequests").withIndex("by_publicId", (q) => q.eq("publicId", publicId)).first();
      if (request?.companyId === companyId) return request.jobId;
    }
  }
  return undefined;
}

function wordsOf(comm: Doc<"qualityComms">): string {
  if (comm.transcript?.status === "completed") return comm.transcript.segments.map((s) => s.text).join(" ");
  return comm.body ?? comm.providerSummary?.lines.join(" ") ?? "";
}

export const processRun = internalMutation({
  args: { runId: v.id("qualityRuns") },
  handler: async (ctx, args) => {
    const run = await leaseRun(ctx, args.runId);
    if (!run) return null;
    const comm = run.commId ? await ctx.db.get(run.commId) : null;
    const company = await ctx.db.get(run.companyId);
    if (!comm || !company) return finishRun(ctx, run, { status: "skipped", result: "Nothing to read." });
    if (!qualitySettings(company).readPhonePlatform) return finishRun(ctx, run, { status: "skipped", result: "Reading the phone platform is switched off." });
    const state = agentState(company);
    const checked: string[] = [];
    const found: string[] = [];
    const next: string[] = [];
    let jobId = comm.jobId;
    // 1. Which visit, only on evidence.
    // Decided once, and again only while it waits for review untouched by a person and new words arrived (a late transcript).
    const decided = comm.associationId ? await ctx.db.get(comm.associationId) : null;
    const untouched = decided !== null && decided.status === "needs_review" && decided.history.every((h) => h.by.kind === "system");
    if (!jobId && (!decided || untouched) && (comm.matchedCustomerIds.length || comm.body)) {
      const text = wordsOf(comm);
      const visits = [];
      for (const customerId of comm.matchedCustomerIds) {
        const rows = await ctx.db.query("jobs").withIndex("by_company_customer_start", (q) => q.eq("companyId", company._id).eq("customerId", customerId).gte("startsAt", comm.occurredAt - LOOKBACK.visitsBefore).lte("startsAt", comm.occurredAt + LOOKBACK.visitsAfter)).take(40);
        for (const job of rows) visits.push({ job, property: await ctx.db.get(job.propertyId) });
      }
      const thread = comm.conversationId ? (await ctx.db.query("qualityComms").withIndex("by_company_counterpart", (q) => q.eq("companyId", company._id).eq("counterpart", comm.counterpart)).order("desc").take(30)).find((c) => c._id !== comm._id && c.conversationId === comm.conversationId && c.jobId && c.occurredAt <= comm.occurredAt) : undefined;
      const decision = decideAssociation({ text, occurredAt: comm.occurredAt, timezone: company.timezone, customerIds: comm.matchedCustomerIds, visits, explicitJobId: await explicitJob(ctx, company._id, text), threadJobId: thread?.jobId });
      checked.push(`Who the number belongs to (${comm.matchedCustomerIds.length} client${comm.matchedCustomerIds.length === 1 ? "" : "s"}) and their visits in the two weeks before`);
      const now = Date.now();
      const entry = { at: now, by: SYSTEM, action: decision.status === "linked" ? `Linked (${decision.method.replace(/_/g, " ")})` : decision.status === "needs_review" ? "Sent for review" : "Not linked", jobId: decision.status === "linked" ? decision.jobId : undefined, note: decision.why };
      const fields = { status: decision.status, method: decision.status === "linked" ? decision.method : undefined, jobId: decision.status === "linked" ? decision.jobId : undefined, candidates: decision.candidates.slice(0, 8), why: decision.why, updatedAt: now };
      let associationId: Id<"qualityAssociations">;
      if (decided) {
        await ctx.db.patch(decided._id, { ...fields, history: [...decided.history, entry].slice(-30) });
        associationId = decided._id;
      } else associationId = await ctx.db.insert("qualityAssociations", { companyId: company._id, commId: comm._id, ...fields, history: [entry], createdAt: now });
      await ctx.db.patch(comm._id, { associationId, ...(decision.status === "linked" ? { jobId: decision.jobId } : {}) });
      found.push(decision.why);
      if (decision.status === "linked") jobId = decision.jobId;
      else if (decision.status === "needs_review") next.push("A person decides which visit this conversation is about, in Quality's review queue.");
    }
    // 2. Read it, by rules. Words are data, never instructions.
    const fresh = (await ctx.db.get(comm._id))!;
    const version = fresh.transcript?.status === "completed" ? fresh.transcript.version : 0;
    const prior = await ctx.db.query("qualityExtracts").withIndex("by_company_comm", (q) => q.eq("companyId", company._id).eq("commId", comm._id).eq("version", version)).take(30);
    let extracts: Extract[] = [];
    if (!prior.length) {
      if (fresh.transcript?.status === "completed") extracts = extractFromSegments(fresh.transcript.segments);
      else if (fresh.body) extracts = extractFromMessage(fresh.body, "sms", fresh.direction);
      else if (fresh.providerSummary?.status === "completed") extracts = extractFromSummary(fresh.providerSummary.lines);
      for (const e of extracts) await ctx.db.insert("qualityExtracts", { companyId: company._id, commId: comm._id, version, kind: e.kind, text: e.text, quote: e.quote, segments: e.segments, speakerUncertain: e.speakerUncertain, fromSummary: e.fromSummary, by: "rules", state: "suggested", createdAt: Date.now() });
      checked.push(fresh.transcript?.status === "completed" ? `The transcript (version ${version}, ${fresh.transcript.segments.length} segments)` : fresh.body ? "The text's words" : fresh.providerSummary ? "The provider's summary (not anyone's words)" : "Call details only: no transcript yet");
      if (extracts.length) found.push(`${extracts.length} reading${extracts.length === 1 ? "" : "s"}: ${[...new Set(extracts.map((e) => e.kind.replace(/_/g, " ")))].join(", ")}`);
    }
    // 3. A concern about a linked visit goes to that visit's case (joined, not duplicated).
    const concern = extracts.filter((e) => e.kind === "complaint" || e.kind === "requested_correction");
    if (jobId && concern.length) {
      const job = await ctx.db.get(jobId);
      if (job) {
        const words = concern.map((e) => e.quote ?? e.text).join(" ").slice(0, 1500);
        const cases = await ctx.db.query("qualityCases").withIndex("by_company_job", (q) => q.eq("companyId", company._id).eq("jobId", job._id)).take(10);
        const earlier = cases.map((c) => c.reportWords ?? "");
        if (isRepeat(words, earlier)) {
          found.push("The same words were already reported for this visit: recorded on the case, not a new complaint.");
          const open = cases.find((c) => c.stage !== "closed");
          if (open) await addEntry(ctx, open, { kind: "evidence", basis: comm.kind === "call" ? "customer_stated" : "customer_stated", text: `The same concern came up again in a ${comm.kind === "call" ? "call" : "text"}.`, source: { table: "qualityComms", id: comm._id, label: comm.kind === "call" ? "Call" : "Text", at: comm.occurredAt }, actor: SYSTEM });
        } else {
          const out = await onConcern(ctx, company, { job, words, origin: comm.kind === "sms" ? "sms" : "call", source: { table: "qualityComms", id: comm._id, label: comm.kind === "call" ? "Call" : "Text", at: comm.occurredAt }, historical: run.historical, actor: QUALITY, act: state.ok && !run.historical });
          if (out.caseId) for (const e of await ctx.db.query("qualityExtracts").withIndex("by_company_comm", (q) => q.eq("companyId", company._id).eq("commId", comm._id)).take(30)) if (!e.caseId) await ctx.db.patch(e._id, { caseId: out.caseId });
          next.push(...out.next);
        }
        // A late transcript reopens the visit's quality question; the visit still happened.
        if (job.completionReportedAt !== undefined || job.status === "completed") await reviewVisit(ctx, company, job, { act: state.ok && !run.historical, actor: QUALITY });
      }
    }
    return finishRun(ctx, run, { status: "done", result: jobId ? "Read and linked to its visit." : "Read; not linked to a visit.", checked, found, next });
  },
});

// ── The association review queue (people) ────────────────────────────────────────────────────────

export const associations = managerQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("qualityAssociations").withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", "needs_review")).order("desc").take(50);
    const out = [];
    for (const a of rows) {
      const comm = await ctx.db.get(a.commId);
      if (!comm) continue;
      const candidates = [];
      for (const c of a.candidates) {
        const job = await ctx.db.get(c.jobId);
        const property = await ctx.db.get(c.propertyId);
        const customer = await ctx.db.get(c.customerId);
        candidates.push({ ...c, service: job?.serviceSnapshot?.name ?? job?.serviceType ?? "Visit", property: property?.label?.trim() || property?.address.line1 || "A property", customer: customer?.name ?? "A client" });
      }
      out.push({ id: a._id, why: a.why, kind: comm.kind, direction: comm.direction, occurredAt: comm.occurredAt, excerpt: (comm.body ?? comm.transcript?.segments.slice(0, 2).map((s) => s.text).join(" ") ?? comm.providerSummary?.lines[0] ?? "").slice(0, 240), candidates });
    }
    return out;
  },
});

async function decideLink(ctx: MutationCtx & { companyId: Id<"companies">; member: Doc<"members"> }, associationId: Id<"qualityAssociations">, action: "link" | "unlink" | "dismiss", jobId?: Id<"jobs">, note?: string) {
  const a = await ctx.db.get(associationId);
  if (!a || a.companyId !== ctx.companyId) throw userError("That review is not in this company.");
  const comm = (await ctx.db.get(a.commId))!;
  const now = Date.now();
  const actor = { kind: "member" as const, memberId: ctx.member._id };
  if (action === "link") {
    const job = jobId ? await ctx.db.get(jobId) : null;
    if (!job || job.companyId !== ctx.companyId) throw userError("Choose a visit in this company.");
    await ctx.db.patch(a._id, { status: "linked", method: "person", jobId: job._id, history: [...a.history, { at: now, by: actor, action: "Linked by a person", jobId: job._id, note }].slice(-30), updatedAt: now });
    await ctx.db.patch(comm._id, { jobId: job._id });
    // Read again now that it has a visit: a concern goes to that visit's case.
    await ctx.db.patch(comm._id, { associationId: a._id });
    const run = await ctx.db.insert("qualityRuns", { companyId: ctx.companyId, kind: "message_received", key: `comm:${comm._id}:linked:${now}`, status: "queued", attempts: 0, nextAttemptAt: now, commId: comm._id, jobId: job._id, checked: [], found: [], next: [], queuedAt: now });
    await ctx.scheduler.runAfter(0, internal.qualityComms.processRun, { runId: run });
  } else {
    await ctx.db.patch(a._id, { status: action === "unlink" ? "unlinked" : "dismissed", jobId: undefined, history: [...a.history, { at: now, by: actor, action: action === "unlink" ? "Unlinked by a person" : "Dismissed: not about a visit", note }].slice(-30), updatedAt: now });
    await ctx.db.patch(comm._id, { jobId: undefined });
  }
  await recordEvent(ctx, { companyId: ctx.companyId, type: `quality_association.${action === "link" ? "linked" : action === "unlink" ? "unlinked" : "dismissed"}`, actor, subject: { table: "qualityAssociations", id: a._id }, data: { jobId: jobId ?? null } });
  return null;
}

export const link = managerMutation({ args: { associationId: v.id("qualityAssociations"), jobId: v.id("jobs"), note: v.optional(v.string()) }, handler: (ctx, args) => decideLink(ctx, args.associationId, "link", args.jobId, args.note?.slice(0, 300)) });
export const unlink = managerMutation({ args: { associationId: v.id("qualityAssociations"), note: v.optional(v.string()) }, handler: (ctx, args) => decideLink(ctx, args.associationId, "unlink", undefined, args.note?.slice(0, 300)) });
export const dismiss = managerMutation({ args: { associationId: v.id("qualityAssociations"), note: v.optional(v.string()) }, handler: (ctx, args) => decideLink(ctx, args.associationId, "dismiss", undefined, args.note?.slice(0, 300)) });

/** A link a person corrects later: the comm's association is reopened for review with its history kept. */
export const reopenAssociation = managerMutation({
  args: { commId: v.id("qualityComms") },
  handler: async (ctx, args) => {
    const comm = await owned(ctx, args.commId);
    const a = comm.associationId ? await ctx.db.get(comm.associationId) : null;
    if (!a) throw userError("This conversation has no association to correct.");
    await ctx.db.patch(a._id, { status: "needs_review", history: [...a.history, { at: Date.now(), by: { kind: "member" as const, memberId: ctx.member._id }, action: "Reopened for review", jobId: a.jobId }].slice(-30), updatedAt: Date.now() });
    await ctx.db.patch(comm._id, { jobId: undefined });
    return null;
  },
});


