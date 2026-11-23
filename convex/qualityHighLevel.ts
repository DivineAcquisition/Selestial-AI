/**
 * Quality reading HighLevel (GoHighLevel / LeadConnector) through Selestial's Marketplace app.
 *
 * The Owner installs the app on their HighLevel sub-account (OAuth, read-only scopes). Selestial keeps the
 * tokens sealed (`qualityCredentials`), checks what the location actually allows (conversations, call
 * transcriptions) and records each capability as checked. New texts, emails and calls arrive as the app's
 * signed webhooks (/webhooks/highlevel, Ed25519) and a bounded poll every ten minutes catches what was missed
 * and fetches transcriptions, which HighLevel finishes after the call and announces with no event.
 *
 * Everything read is evidence, never instructions: it goes through the same matching (a visit only on
 * evidence, a review queue otherwise) and reading as Quo's calls and texts. Selestial never sends through
 * HighLevel and never fetches a call recording. Until the app is registered and configured on this deployment
 * (HIGHLEVEL_CLIENT_ID, HIGHLEVEL_CLIENT_SECRET, HIGHLEVEL_INSTALL_URL), connecting says it isn't available.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { ownerMutation } from "./lib/builders";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { appOrigin, returnOrigin } from "./lib/invitations";
import { hashToken, randomToken, seal, secretsConfigured, unseal } from "./lib/recruiter/secrets";
import { exchangeCode, highLevelApp, highLevelClient, HighLevelError, highLevelRedirect, installUrlFor, parseHighLevelMessage, refreshTokens, type HighLevelTokens } from "./lib/quality/comms/highlevel";
import { applyHighLevelTranscription, ingestHighLevel, markUnavailable } from "./lib/quality/comms/ingest";
import { qualitySettings } from "./lib/quality/settings";
import { DAY, MINUTE, SYSTEM } from "./lib/quality/words";

const STATE_LIFE = 15 * MINUTE;
const UNKNOWN = { readMessages: "unknown", readThreads: "not_used", readCallMetadata: "unknown", readTranscripts: "unknown", readSummaries: "not_used", recordings: "not_used", webhooks: "unknown", send: "not_used" } as const;

function afterHighLevel(outcome: string, origin?: string | null): string {
  return `${returnOrigin(origin) ?? appOrigin() ?? ""}/app/agents/quality/playbook?highlevel=${encodeURIComponent(outcome)}`;
}

// ── Installing ───────────────────────────────────────────────────────────────────────────────────

/** Starts the install: a one-time state, then HighLevel's own page where the Owner picks the sub-account. */
export const start = ownerMutation({
  args: { returnTo: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const app = highLevelApp();
    const redirect = highLevelRedirect();
    if (!app || !redirect || !(await secretsConfigured())) throw userError("Connecting HighLevel isn't available on Selestial yet. The Selestial app has to be registered in HighLevel's Marketplace first.");
    const state = await randomToken();
    await ctx.db.insert("connectorStates", { companyId: ctx.companyId, memberId: ctx.member._id, stateHash: await hashToken(state), returnOrigin: returnOrigin(args.returnTo) ?? undefined, expiresAt: Date.now() + STATE_LIFE });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quality_connection.install_started", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { provider: "highlevel" } });
    return { url: installUrlFor(app, redirect, state) };
  },
});

/** Where HighLevel sends the Owner back (convex/http.ts GET /oauth/highlevel/callback). */
export async function highLevelCallback(ctx: ActionCtx, params: URLSearchParams): Promise<string> {
  const state = params.get("state");
  if (!state || state.length > 200) return afterHighLevel("failed");
  const taken = await ctx.runMutation(internal.connectors.takeState, { stateHash: await hashToken(state) });
  if (taken.kind === "unknown") return afterHighLevel("failed");
  if (taken.kind === "expired") return afterHighLevel("expired", taken.returnOrigin);
  const app = highLevelApp();
  const redirect = highLevelRedirect();
  const code = params.get("code");
  if (!code || params.get("error") || !app || !redirect) return afterHighLevel(params.get("error") === "access_denied" ? "declined" : "failed", taken.returnOrigin);
  let tokens: HighLevelTokens;
  try {
    tokens = await exchangeCode(app, code, redirect);
  } catch {
    return afterHighLevel("failed", taken.returnOrigin);
  }
  // Quality reads one sub-account. An agency-level install names no location, so it reads nothing.
  if (!tokens.locationId) return afterHighLevel("choose_location", taken.returnOrigin);
  const saved = await ctx.runMutation(internal.qualityHighLevel.installed, { companyId: taken.companyId, memberId: taken.memberId, locationId: tokens.locationId, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, accessExpiresAt: tokens.expiresAt });
  return afterHighLevel(saved, taken.returnOrigin);
}

export const installed = internalMutation({
  args: { companyId: v.id("companies"), memberId: v.id("members"), locationId: v.string(), refreshToken: v.string(), accessToken: v.string(), accessExpiresAt: v.number() },
  handler: async (ctx, args): Promise<string> => {
    // One HighLevel location belongs to one company here.
    const taken = (await ctx.db.query("qualityConnections").withIndex("by_provider_external", (q) => q.eq("provider", "highlevel").eq("externalId", args.locationId)).take(5)).find((c) => c.status !== "disconnected" && c.companyId !== args.companyId);
    if (taken) return "location_in_use";
    const now = Date.now();
    const mine = (await ctx.db.query("qualityConnections").withIndex("by_company_provider", (q) => q.eq("companyId", args.companyId).eq("provider", "highlevel")).take(5)).find((c) => c.status !== "disconnected");
    const fields = { externalId: args.locationId, status: "checking" as const, problem: undefined, failures: 0, capabilities: { ...UNKNOWN }, connectedBy: args.memberId, connectedAt: now, readFrom: now, syncCursor: undefined, leaseUntil: undefined };
    const connectionId = mine ? (await ctx.db.patch(mine._id, fields), mine._id) : await ctx.db.insert("qualityConnections", { companyId: args.companyId, provider: "highlevel", label: "HighLevel", numbers: [], ...fields });
    const sealedKey = await seal(args.refreshToken, connectionId);
    const sealedAccess = await seal(args.accessToken, connectionId);
    if (!sealedKey || !sealedAccess) return "failed";
    const prior = await ctx.db.query("qualityCredentials").withIndex("by_connection", (q) => q.eq("connectionId", connectionId)).first();
    if (prior) await ctx.db.patch(prior._id, { sealedKey, sealedAccess, accessExpiresAt: args.accessExpiresAt, updatedAt: now });
    else await ctx.db.insert("qualityCredentials", { companyId: args.companyId, connectionId, sealedKey, sealedAccess, accessExpiresAt: args.accessExpiresAt, createdAt: now });
    await recordEvent(ctx, { companyId: args.companyId, type: "quality_connection.added", actor: { kind: "member", memberId: args.memberId }, subject: { table: "qualityConnections", id: connectionId }, data: { provider: "highlevel" } });
    await ctx.scheduler.runAfter(0, internal.qualityHighLevel.check, { connectionId });
    return "connected";
  },
});

/** Stopping reading forgets the tokens. The app stays installed in HighLevel until the Owner removes it there. */
export const forget = internalMutation({
  args: { connectionId: v.id("qualityConnections") },
  handler: async (ctx, args) => {
    for (const row of await ctx.db.query("qualityCredentials").withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId)).take(5)) await ctx.db.delete(row._id);
    return null;
  },
});

// ── Tokens ───────────────────────────────────────────────────────────────────────────────────────

export const credentialFor = internalQuery({
  args: { connectionId: v.id("qualityConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status === "disconnected" || connection.provider !== "highlevel" || !connection.externalId) return null;
    const credential = await ctx.db.query("qualityCredentials").withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId)).first();
    return credential ? { connection, locationId: connection.externalId, sealedKey: credential.sealedKey, sealedAccess: credential.sealedAccess ?? null, accessExpiresAt: credential.accessExpiresAt ?? 0 } : null;
  },
});

export const storeTokens = internalMutation({
  args: { connectionId: v.id("qualityConnections"), refreshToken: v.string(), accessToken: v.string(), accessExpiresAt: v.number() },
  handler: async (ctx, args) => {
    const credential = await ctx.db.query("qualityCredentials").withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId)).first();
    const sealedKey = await seal(args.refreshToken, args.connectionId);
    const sealedAccess = await seal(args.accessToken, args.connectionId);
    if (!credential || !sealedKey || !sealedAccess) return null;
    await ctx.db.patch(credential._id, { sealedKey, sealedAccess, accessExpiresAt: args.accessExpiresAt, updatedAt: Date.now() });
    return null;
  },
});

/** A usable access token. Refreshing rotates the refresh token, so the new one is stored before anything else. */
async function accessFor(ctx: ActionCtx, connectionId: Id<"qualityConnections">): Promise<{ token: string; locationId: string; connection: Doc<"qualityConnections"> } | null> {
  const found = await ctx.runQuery(internal.qualityHighLevel.credentialFor, { connectionId });
  const app = highLevelApp();
  const redirect = highLevelRedirect();
  if (!found || !app || !redirect) return null;
  const access = found.sealedAccess && found.accessExpiresAt > Date.now() + MINUTE ? await unseal(found.sealedAccess, connectionId) : null;
  if (access) return { token: access, locationId: found.locationId, connection: found.connection };
  const refresh = await unseal(found.sealedKey, connectionId);
  if (!refresh) throw new HighLevelError("unauthorized", "The stored HighLevel authorization could not be read. Install the app again.");
  const tokens = await refreshTokens(app, refresh, redirect);
  await ctx.runMutation(internal.qualityHighLevel.storeTokens, { connectionId, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, accessExpiresAt: tokens.expiresAt });
  return { token: tokens.accessToken, locationId: found.locationId, connection: found.connection };
}

// ── Checking what the location allows ────────────────────────────────────────────────────────────

const capabilityValidator = v.union(v.literal("available"), v.literal("unavailable"), v.literal("unknown"), v.literal("not_used"));

export const checked = internalMutation({
  args: { connectionId: v.id("qualityConnections"), ok: v.boolean(), problem: v.optional(v.string()), expired: v.optional(v.boolean()), readTranscripts: v.optional(capabilityValidator), readMessages: v.optional(capabilityValidator) },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status === "disconnected") return null;
    if (!args.ok) {
      await ctx.db.patch(connection._id, { status: args.expired ? "expired" : "error", problem: args.problem, failures: connection.failures + 1, lastSyncAt: Date.now() });
      return null;
    }
    const caps = connection.capabilities;
    await ctx.db.patch(connection._id, { status: "connected", problem: undefined, failures: 0, lastSyncAt: Date.now(), lastSuccessAt: Date.now(), capabilities: { ...caps, readMessages: args.readMessages ?? caps.readMessages, readCallMetadata: args.readMessages ?? caps.readCallMetadata, readTranscripts: args.readTranscripts ?? caps.readTranscripts } });
    return null;
  },
});

export const check = internalAction({
  args: { connectionId: v.id("qualityConnections") },
  handler: async (ctx, args): Promise<null> => {
    const app = highLevelApp();
    try {
      const found = await accessFor(ctx, args.connectionId);
      if (!found || !app) {
        await ctx.runMutation(internal.qualityHighLevel.checked, { connectionId: args.connectionId, ok: false, problem: "HighLevel isn't available on this deployment.", expired: true });
        return null;
      }
      const api = highLevelClient(found.token, app.version);
      const conversations = await api.conversations(found.locationId, Date.now() - 14 * DAY, 10);
      let transcripts: "available" | "unavailable" | "unknown" = "unknown";
      for (const c of conversations.slice(0, 5)) {
        const call = (await api.messages(c.id)).messages.find((m) => m.kind === "call" && (m.callDuration ?? 0) > 0);
        if (!call) continue;
        transcripts = (await api.transcription(found.locationId, call.id)).length ? "available" : "unavailable";
        if (transcripts === "available") break;
      }
      await ctx.runMutation(internal.qualityHighLevel.checked, { connectionId: args.connectionId, ok: true, readMessages: "available", readTranscripts: transcripts });
    } catch (error) {
      const problem = error instanceof HighLevelError ? error.message : "HighLevel could not be reached. Try again in a few minutes.";
      await ctx.runMutation(internal.qualityHighLevel.checked, { connectionId: args.connectionId, ok: false, problem, expired: error instanceof HighLevelError && error.kind === "unauthorized" });
    }
    return null;
  },
});

// ── Webhooks (signed, one URL for the app) ───────────────────────────────────────────────────────

/** One verified delivery (convex/http.ts POST /webhooks/highlevel). Kept by its webhook id, so a retry changes nothing twice. */
export const webhook = internalMutation({
  args: { body: v.string() },
  handler: async (ctx, args): Promise<string> => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(args.body) as Record<string, unknown>;
    } catch {
      return "unreadable";
    }
    const locationId = typeof payload.locationId === "string" ? payload.locationId : null;
    if (!locationId) return "no location";
    const connection = (await ctx.db.query("qualityConnections").withIndex("by_provider_external", (q) => q.eq("provider", "highlevel").eq("externalId", locationId)).take(5)).find((c) => c.status !== "disconnected");
    if (!connection) return "not a connected location";
    const deliveryId = typeof payload.webhookId === "string" ? payload.webhookId : typeof payload.messageId === "string" ? `${payload.type}:${payload.messageId}` : null;
    if (deliveryId) {
      const seen = await ctx.db.query("qualityWebhookEvents").withIndex("by_connection_delivery", (q) => q.eq("connectionId", connection._id).eq("deliveryId", deliveryId)).first();
      if (seen) return "duplicate";
      await ctx.db.insert("qualityWebhookEvents", { connectionId: connection._id, deliveryId, type: String(payload.type ?? "unknown"), receivedAt: Date.now() });
    }
    if (payload.type === "UNINSTALL") {
      await ctx.db.patch(connection._id, { status: "expired", problem: "The Selestial app was removed in HighLevel. Install it again to keep reading." });
      for (const row of await ctx.db.query("qualityCredentials").withIndex("by_connection", (q) => q.eq("connectionId", connection._id)).take(5)) await ctx.db.delete(row._id);
      await recordEvent(ctx, { companyId: connection.companyId, type: "quality_connection.uninstalled", actor: SYSTEM, subject: { table: "qualityConnections", id: connection._id }, data: { provider: "highlevel" } });
      return "uninstalled";
    }
    if (payload.type !== "InboundMessage" && payload.type !== "OutboundMessage") return "ignored";
    const company = await ctx.db.get(connection.companyId);
    if (!company || !qualitySettings(company).readPhonePlatform) return "reading is off";
    const message = parseHighLevelMessage(payload);
    if (!message) return "unreadable";
    if (connection.capabilities.webhooks !== "available") await ctx.db.patch(connection._id, { capabilities: { ...connection.capabilities, webhooks: "available" } });
    return (await ingestHighLevel(ctx, connection, message)) ? message.kind : "not read";
  },
});

// ── Polling: bounded, resumable, and honest about outages ────────────────────────────────────────

export const syncBegin = internalMutation({
  args: { connectionId: v.id("qualityConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.provider !== "highlevel" || connection.status === "disconnected" || connection.status === "checking" || connection.status === "expired") return null;
    const company = await ctx.db.get(connection.companyId);
    if (!company || !qualitySettings(company).readPhonePlatform) return null;
    const now = Date.now();
    if (connection.leaseUntil !== undefined && connection.leaseUntil > now) return null;
    await ctx.db.patch(connection._id, { leaseUntil: now + 5 * MINUTE, lastSyncAt: now });
    const due = await ctx.db.query("qualityComms").withIndex("by_recheck", (q) => q.gt("recheckAt", 0).lte("recheckAt", now)).take(40);
    return { since: Math.max(connection.readFrom, connection.syncCursor ?? connection.readFrom), recheck: due.filter((c) => c.connectionId === connection._id).slice(0, 15).map((c) => c.providerId) };
  },
});

const messageValidator = v.object({ id: v.string(), kind: v.union(v.literal("call"), v.literal("sms"), v.literal("email"), v.literal("voicemail"), v.literal("other")), direction: v.union(v.literal("incoming"), v.literal("outgoing")), body: v.string(), subject: v.optional(v.string()), contactId: v.optional(v.string()), conversationId: v.optional(v.string()), locationId: v.optional(v.string()), occurredAt: v.number(), callDuration: v.optional(v.number()), callStatus: v.optional(v.string()), from: v.optional(v.string()), to: v.optional(v.string()) });
const sentenceValidator = v.object({ channel: v.union(v.number(), v.null()), start: v.number(), end: v.number(), text: v.string() });

export const syncApply = internalMutation({
  args: { connectionId: v.id("qualityConnections"), messages: v.array(messageValidator), transcripts: v.array(v.object({ providerId: v.string(), sentences: v.array(sentenceValidator), gone: v.optional(v.boolean()) })) },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status === "disconnected") return 0;
    let n = 0;
    for (const m of args.messages) if (await ingestHighLevel(ctx, connection, m)) n += 1;
    for (const t of args.transcripts) {
      const comm = await ctx.db.query("qualityComms").withIndex("by_connection_provider_id", (q) => q.eq("connectionId", connection._id).eq("providerId", t.providerId)).first();
      if (!comm) continue;
      if (t.gone) await markUnavailable(ctx, comm);
      else await applyHighLevelTranscription(ctx, connection, comm, t.sentences);
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
    const begun = await ctx.runMutation(internal.qualityHighLevel.syncBegin, args);
    if (!begun) return null;
    const app = highLevelApp();
    try {
      const found = await accessFor(ctx, args.connectionId);
      if (!found || !app) throw new HighLevelError("unauthorized", "HighLevel isn't available on this deployment.");
      const api = highLevelClient(found.token, app.version);
      let cursor = begun.since;
      // At most 20 conversations and their newest page a sync; the cursor only moves forward.
      for (const c of await api.conversations(found.locationId, begun.since, 20)) {
        const page = await api.messages(c.id);
        const fresh = page.messages.filter((m) => m.occurredAt >= begun.since && m.kind !== "other");
        for (const m of fresh) cursor = Math.max(cursor, m.occurredAt);
        if (fresh.length) await ctx.runMutation(internal.qualityHighLevel.syncApply, { connectionId: args.connectionId, messages: fresh.map((m) => ({ ...m, conversationId: m.conversationId ?? c.id })), transcripts: [] });
      }
      const transcripts = [];
      for (const providerId of begun.recheck) transcripts.push({ providerId, sentences: await api.transcription(found.locationId, providerId) });
      if (transcripts.length) await ctx.runMutation(internal.qualityHighLevel.syncApply, { connectionId: args.connectionId, messages: [], transcripts });
      await ctx.runMutation(internal.qualityHighLevel.syncFinish, { connectionId: args.connectionId, ok: true, cursor: Math.max(begun.since, cursor - 10 * MINUTE) });
    } catch (error) {
      const problem = error instanceof HighLevelError ? error.message : "HighLevel could not be reached. Reading resumes on the next sync.";
      await ctx.runMutation(internal.qualityHighLevel.syncFinish, { connectionId: args.connectionId, ok: false, problem, expired: error instanceof HighLevelError && error.kind === "unauthorized" });
    }
    return null;
  },
});
