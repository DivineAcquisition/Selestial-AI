/**
 * Google for a company, one tool at a time. Drive (with Docs and Sheets), Calendar, Business Profile,
 * Google Ads and Conversions each have their own connection: their own sign-in, Google account, grant,
 * stored token, chosen resources and disconnect. Only the Owner connects, chooses resources or
 * disconnects; anyone in the company can see what is connected.
 *
 * Connecting a tool:
 *  1. `startConnect` makes a one-time state (only its hash is kept, for ten minutes) and returns Google's
 *     consent address for that tool's scopes only.
 *  2. Google returns to /oauth/google/callback (shared with the Gmail inbox). The state is used once and the
 *     code exchanged, but NOTHING IS CONNECTED YET: that request carries no session, so it cannot know the
 *     browser belongs to the Owner who started (an Owner's link could otherwise attach someone else's Google
 *     account to the company). The authorization is sealed onto the state record as pending (`holdPending`).
 *  3. The browser goes on to the app with a one-time value only it has. There the signed-in Owner who
 *     started sees the Google account and confirms it (`confirmConnect`) within fifteen minutes; otherwise it
 *     is deleted and Google's grant ended unless that account is already in use. A reconnect must be the
 *     same Google account unless the Owner chose a different one.
 *  4. The tool is on only if Google granted all of its scopes. Partial consent is recorded as partial.
 *
 * Disconnecting a tool stops that tool's Google steps at once, cancels its queued work, removes what was
 * chosen for it and deletes its token. Google's grant is revoked only when no other connected tool uses
 * the same Google account, because Google revokes per account, not per tool.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { companyQuery, ownerMutation } from "./lib/builders";
import { notFound, userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { activeConnection } from "./lib/google/connection";
import { enabledFeatures, FEATURE_INFO, FEATURES, missingScopes, scopesFor, type Feature } from "./lib/google/features";
import { GoogleError } from "./lib/google/http";
import { gmailInboxOn } from "./lib/inbox/mailboxes";
import { consentUrl, googleApp, redirectUri, refresh, revoke } from "./lib/google/oauth";
import { featureValidator, resourceKindValidator } from "./lib/google/schema";
import { appOrigin, returnOrigin } from "./lib/invitations";
import { hashToken, randomToken, seal, secretsConfigured, unseal } from "./lib/recruiter/secrets";

const STATE_LIFE = 10 * 60 * 1000;

export function afterGoogle(outcome: string, origin?: string | null, feature?: string | null, confirm?: string): string {
  // "confirm" carries the one-time value the app page needs to show the Google account and finish.
  const pending = outcome === "confirm" && confirm ? `&pending=${encodeURIComponent(confirm)}` : "";
  return `${returnOrigin(origin) ?? appOrigin() ?? ""}/app/settings/integrations?${feature ? `tool=${encodeURIComponent(feature)}&` : ""}result=${encodeURIComponent(outcome)}${pending}`;
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

export const status = companyQuery({
  args: {},
  handler: async (ctx) => {
    const tools = [];
    const allResources = [];
    for (const feature of FEATURES) {
      const connection = await activeConnection(ctx, ctx.companyId, feature);
      const resources = connection ? await ctx.db.query("googleResources").withIndex("by_connection", (q) => q.eq("connectionId", connection._id)).take(200) : [];
      const shaped = resources.map((r) => ({ id: r._id, kind: r.kind, externalId: r.externalId, label: r.label, purpose: r.purpose ?? null, detail: r.detail ?? null, access: r.access, accessNote: r.accessNote ?? null, verifiedAt: r.verifiedAt ?? null }));
      allResources.push(...shaped);
      tools.push({
        feature,
        label: FEATURE_INFO[feature].label,
        does: FEATURE_INFO[feature].does,
        connection: connection ? { id: connection._id, email: connection.email, status: connection.status, problem: connection.problem ?? null, connectedAt: connection.connectedAt, lastRefreshAt: connection.lastRefreshAt ?? null } : null,
        granted: connection?.status === "connected" && enabledFeatures(connection.grantedScopes).includes(feature),
        missing: connection ? missingScopes(feature, connection.grantedScopes) : [...FEATURE_INFO[feature].scopes],
        resources: shaped,
      });
    }
    return {
      canManage: ctx.role === "owner",
      ready: googleApp() !== null && redirectUri() !== null && (await secretsConfigured()),
      tools,
      resources: allResources,
    };
  },
});

// ── Connecting ──────────────────────────────────────────────────────────────────────────────────

export const startConnect = ownerMutation({
  args: { feature: featureValidator, differentAccount: v.optional(v.boolean()), returnTo: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const app = googleApp();
    const redirect = redirectUri();
    if (!app || !redirect) throw userError("Connecting Google isn’t available yet. Please try again a little later.");
    if (!(await secretsConfigured())) throw userError("Connecting Google isn’t available yet. Please try again a little later.");
    const existing = await activeConnection(ctx, ctx.companyId, args.feature);
    // Reconnecting keeps the same Google account; "a different account" replaces it.
    const same = existing && !args.differentAccount ? existing : null;
    const state = await randomToken();
    await ctx.db.insert("googleOAuthStates", { companyId: ctx.companyId, memberId: ctx.member._id, stateHash: await hashToken(state), features: [args.feature], connectionId: same?._id, returnOrigin: returnOrigin(args.returnTo) ?? undefined, expiresAt: Date.now() + STATE_LIFE });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "google.connect_started", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { feature: args.feature, differentAccount: Boolean(args.differentAccount) } });
    return { url: consentUrl(app, { redirectUri: redirect, state, scopes: scopesFor([args.feature]), loginHint: same?.email, selectAccount: !same }) };
  },
});

/** Uses a state once. `unknown` lets the shared callback hand it to the Gmail inbox flow instead. */
export const takeState = internalMutation({
  args: { stateHash: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("googleOAuthStates").withIndex("by_stateHash", (q) => q.eq("stateHash", args.stateHash)).unique();
    if (!row) return { kind: "unknown" as const };
    if (row.usedAt !== undefined || row.expiresAt <= Date.now()) {
      await ctx.db.patch(row._id, { usedAt: row.usedAt ?? Date.now() });
      return { kind: "expired" as const, returnOrigin: row.returnOrigin ?? null, feature: row.features[0] ?? null };
    }
    await ctx.db.patch(row._id, { usedAt: Date.now() });
    const member = await ctx.db.get(row.memberId);
    if (!member || member.companyId !== row.companyId || member.status !== "active" || member.role !== "owner") return { kind: "expired" as const, returnOrigin: row.returnOrigin ?? null, feature: row.features[0] ?? null };
    return { kind: "ok" as const, stateId: row._id, companyId: row.companyId, memberId: row.memberId, features: row.features, connectionId: row.connectionId ?? null, returnOrigin: row.returnOrigin ?? null };
  },
});

/** How long a Google tool authorization waits to be confirmed in the app before it is thrown away. */
export const PENDING_LIFE = 15 * 60 * 1000;

/** What a pending tool authorization is sealed to: its state record, so it opens nowhere else. */
export function pendingBinding(stateId: Id<"googleOAuthStates">): string {
  return `google-pending:${stateId}`;
}

type ConnectInput = { companyId: Id<"companies">; memberId: Id<"members">; feature: Feature; connectionId: Id<"googleConnections"> | null; googleSub: string; email: string; scopes: string[] };

/** Why connecting this account for this tool cannot go ahead, before anything is recorded. Null when it can. */
async function connectRefusal(ctx: MutationCtx, args: Pick<ConnectInput, "companyId" | "feature" | "connectionId" | "googleSub">): Promise<string | null> {
  if (!args.connectionId) return null;
  const target = await ctx.db.get(args.connectionId);
  if (!target || target.companyId !== args.companyId || target.status === "disconnected" || target.feature !== args.feature) return "expired";
  if (target.googleSub !== args.googleSub) return "different_account";
  return null;
}

/**
 * Records what Google granted for one tool. Reconnecting must be the same Google account; a different
 * account replaces the tool's connection only when the Owner chose "use a different account", and the old
 * connection's resources and work stop. Other tools are not touched. Reached only through `confirmConnect`.
 */
async function recordConnect(ctx: MutationCtx, args: ConnectInput): Promise<{ ok: true; connectionId: Id<"googleConnections">; enabled: Feature[] } | { ok: false; reason: string }> {
  const now = Date.now();
  const enabled = missingScopes(args.feature, args.scopes).length === 0 ? [args.feature] : [];
  const refused = await connectRefusal(ctx, args);
  if (refused) return { ok: false, reason: refused };
  if (args.connectionId) {
    await ctx.db.patch(args.connectionId, { grantedScopes: args.scopes, status: "connected", problem: undefined, lastRefreshAt: now });
    await recordEvent(ctx, { companyId: args.companyId, type: "google.reconnected", actor: { kind: "member", memberId: args.memberId }, subject: { table: "companies", id: args.companyId }, data: { feature: args.feature, granted: enabled.length > 0 } });
    return { ok: true, connectionId: args.connectionId, enabled };
  }
  const current = await activeConnection(ctx, args.companyId, args.feature);
  if (current) await stopConnection(ctx, current, "Replaced by a connection to a different Google account.");
  const connectionId = await ctx.db.insert("googleConnections", { companyId: args.companyId, feature: args.feature, googleSub: args.googleSub, email: args.email.toLowerCase(), status: "connected", grantedScopes: args.scopes, connectedBy: args.memberId, connectedAt: now, lastRefreshAt: now });
  await recordEvent(ctx, { companyId: args.companyId, type: "google.connected", actor: { kind: "member", memberId: args.memberId }, subject: { table: "companies", id: args.companyId }, data: { feature: args.feature, partial: enabled.length === 0 } });
  return { ok: true, connectionId, enabled };
}

async function storeSealed(ctx: MutationCtx, connectionId: Id<"googleConnections">, sealedRefreshToken: string) {
  const connection = await ctx.db.get(connectionId);
  if (!connection || connection.status === "disconnected") return;
  for (const row of await ctx.db.query("googleCredentials").withIndex("by_connection", (q) => q.eq("connectionId", connectionId)).take(10)) await ctx.db.delete(row._id);
  await ctx.db.insert("googleCredentials", { companyId: connection.companyId, connectionId: connection._id, sealedRefreshToken, createdAt: Date.now() });
}

/** Whether ending Google's grant for this account would also end something in use: a tool connection or a Gmail inbox. */
async function accountInUse(ctx: MutationCtx, googleSub: string, email: string): Promise<boolean> {
  return (await ctx.db.query("googleConnections").withIndex("by_sub", (q) => q.eq("googleSub", googleSub)).take(100)).some((row) => row.status !== "disconnected") || (await gmailInboxOn(ctx, email));
}

/**
 * Google answered for this state. The callback carries no session: the state proves who STARTED, not whose
 * browser came back from Google. So nothing is connected here. The authorization waits, sealed to the state
 * record, for the member who started to see the Google account and confirm it in the app (`confirmConnect`).
 * Says why not when the answer cannot be used at all (another account on a reconnect, no lasting access).
 */
export const holdPending = internalMutation({
  args: { stateId: v.id("googleOAuthStates"), googleSub: v.string(), email: v.string(), scopes: v.array(v.string()), sealedRefreshToken: v.union(v.string(), v.null()), confirmHash: v.string() },
  handler: async (ctx, args): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const row = await ctx.db.get(args.stateId);
    if (!row || row.usedAt === undefined || row.pending) return { ok: false, reason: "expired" };
    const feature = row.features[0];
    const refused = (await connectRefusal(ctx, { companyId: row.companyId, feature, connectionId: row.connectionId ?? null, googleSub: args.googleSub })) ?? (args.sealedRefreshToken ? null : "no_refresh_token");
    if (refused || !args.sealedRefreshToken) {
      // Unusable: the access Google gave is ended at once, unless that account is already in use here.
      if (args.sealedRefreshToken && !(await accountInUse(ctx, args.googleSub, args.email))) await ctx.scheduler.runAfter(0, internal.google.revokePending, { sealed: args.sealedRefreshToken, boundTo: pendingBinding(row._id) });
      return { ok: false, reason: refused ?? "no_refresh_token" };
    }
    await ctx.db.patch(row._id, { pending: { googleSub: args.googleSub, email: args.email.trim().toLowerCase(), scopes: args.scopes, sealedRefreshToken: args.sealedRefreshToken, until: Date.now() + PENDING_LIFE }, confirmHash: args.confirmHash });
    await ctx.scheduler.runAfter(PENDING_LIFE, internal.google.expirePending, { stateId: row._id });
    return { ok: true };
  },
});

type PendingRow = Doc<"googleOAuthStates"> & { pending: NonNullable<Doc<"googleOAuthStates">["pending"]> };

async function pendingFor(ctx: QueryCtx | MutationCtx, token: string): Promise<PendingRow | null> {
  if (!token || token.length > 200) return null;
  const confirmHash = await hashToken(token);
  const row = await ctx.db.query("googleOAuthStates").withIndex("by_confirmHash", (q) => q.eq("confirmHash", confirmHash)).unique();
  return row?.pending ? { ...row, pending: row.pending } : null;
}

/**
 * The Google account waiting to be confirmed for a tool, for the page Google's answer lands on. Only for the
 * member who started it; to anyone else it does not exist.
 */
export const pendingConnect = companyQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const row = await pendingFor(ctx, args.token);
    if (!row || ctx.support || ctx.role !== "owner" || row.companyId !== ctx.companyId || row.memberId !== ctx.member._id || row.pending.until <= Date.now()) return null;
    const feature = row.features[0];
    const current = row.connectionId ? null : await activeConnection(ctx, row.companyId, feature);
    return {
      feature,
      label: FEATURE_INFO[feature].label,
      email: row.pending.email,
      does: FEATURE_INFO[feature].does,
      complete: missingScopes(feature, row.pending.scopes).length === 0,
      replaces: current && current.googleSub !== row.pending.googleSub ? current.email : null,
      until: row.pending.until,
    };
  },
});

/**
 * The signed-in member confirms the Google account Google answered for. Only the member who started the
 * sign-in, still an active Owner of this company (ownerMutation checks that now, again), can. Anyone else, in
 * any company, is refused and nothing is connected.
 */
export const confirmConnect = ownerMutation({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<{ connected: boolean; feature: Feature; email: string; result: string }> => {
    const row = await pendingFor(ctx, args.token);
    if (!row || row.companyId !== ctx.companyId) throw userError("That Google sign-in isn’t waiting any more, so nothing was connected. Please start again.");
    if (ctx.support || ctx.role !== "owner" || row.memberId !== ctx.member._id) throw userError("Only the person who started connecting this Google tool can finish it. Nothing was connected.");
    const feature = row.features[0];
    if (row.pending.until <= Date.now()) {
      await discardPending(ctx, row);
      return { connected: false, feature, email: row.pending.email, result: "expired" };
    }
    const refreshToken = await unseal(row.pending.sealedRefreshToken, pendingBinding(row._id));
    if (!refreshToken) throw userError("Connecting Google isn’t available right now. Please try again a little later.");
    const done = await recordConnect(ctx, { companyId: row.companyId, memberId: row.memberId, feature, connectionId: row.connectionId ?? null, googleSub: row.pending.googleSub, email: row.pending.email, scopes: row.pending.scopes });
    if (!done.ok) {
      await discardPending(ctx, row);
      return { connected: false, feature, email: row.pending.email, result: done.reason };
    }
    // Sealed again, this time to the connection it now belongs to.
    const sealed = await seal(refreshToken, done.connectionId);
    if (!sealed) throw userError("Connecting Google isn’t available right now. Please try again a little later.");
    await storeSealed(ctx, done.connectionId, sealed);
    await ctx.db.patch(row._id, { pending: undefined, confirmHash: undefined });
    // Partial consent is kept as it is: only what Google actually granted is switched on.
    return { connected: true, feature, email: row.pending.email, result: done.enabled.includes(feature) ? "connected" : `partial:${feature}` };
  },
});

/** "Not this account": the member who started throws the pending authorization away now rather than in fifteen minutes. */
export const cancelConnect = ownerMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const row = await pendingFor(ctx, args.token);
    if (!row || ctx.support || row.companyId !== ctx.companyId || row.memberId !== ctx.member._id) return null;
    await discardPending(ctx, row);
    return null;
  },
});

/** Nobody confirmed in time. The authorization is deleted and, unless that Google account is in use here, the grant is ended. */
export const expirePending = internalMutation({
  args: { stateId: v.id("googleOAuthStates") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.stateId);
    if (row?.pending) await discardPending(ctx, { ...row, pending: row.pending });
    return null;
  },
});

async function discardPending(ctx: MutationCtx, row: PendingRow): Promise<void> {
  await ctx.db.patch(row._id, { pending: undefined, confirmHash: undefined });
  const inUse = await accountInUse(ctx, row.pending.googleSub, row.pending.email);
  if (!inUse) await ctx.scheduler.runAfter(0, internal.google.revokePending, { sealed: row.pending.sealedRefreshToken, boundTo: pendingBinding(row._id) });
  await recordEvent(ctx, { companyId: row.companyId, type: "google.connect_abandoned", actor: { kind: "system" }, subject: { table: "companies", id: row.companyId }, data: { feature: row.features[0], grantKept: inUse } });
}

export const revokePending = internalAction({
  args: { sealed: v.string(), boundTo: v.string() },
  handler: async (_ctx, args) => {
    const token = await unseal(args.sealed, args.boundTo);
    if (token) await revoke(token).catch(() => undefined);
    return null;
  },
});

// ── Disconnecting ───────────────────────────────────────────────────────────────────────────────

async function stopConnection(ctx: MutationCtx, connection: Doc<"googleConnections">, why: string) {
  const db = ctx.db;
  await db.patch(connection._id, { status: "disconnected", disconnectedAt: Date.now(), problem: why });
  // Queued and waiting work for this connection is cancelled, so nothing reaches Google after this.
  for (const status of ["queued", "uncertain"] as const) {
    const rows = await db.query("googleJobs").withIndex("by_company_status", (q) => q.eq("companyId", connection.companyId).eq("status", status)).take(500);
    for (const job of rows) if (job.connectionId === connection._id) await db.patch(job._id, { status: "cancelled", lastError: "Google was disconnected.", updatedAt: Date.now() });
  }
  for (const watch of await db.query("googleWatches").withIndex("by_company", (q) => q.eq("companyId", connection.companyId)).take(100)) if (watch.connectionId === connection._id) await db.delete(watch._id);
  for (const resource of await db.query("googleResources").withIndex("by_connection", (q) => q.eq("connectionId", connection._id)).take(500)) await db.delete(resource._id);
}

export const disconnect = ownerMutation({
  args: { feature: featureValidator },
  handler: async (ctx, args) => {
    const connection = await activeConnection(ctx, ctx.companyId, args.feature);
    if (!connection) throw userError(`${FEATURE_INFO[args.feature].label} is not connected.`);
    await stopConnection(ctx, connection, "Disconnected by the Owner.");
    const credential = await ctx.db.query("googleCredentials").withIndex("by_connection", (q) => q.eq("connectionId", connection._id)).first();
    // Google revokes a whole account's grant to Selestial, not one tool's. While another connected tool uses
    // the same account, only this tool's token is deleted; the last one to go also revokes at Google.
    // A Gmail inbox connected with the same Google account uses that same grant (the same Google app): it
    // counts as "another tool" here, exactly as convex/inboxes.ts counts these tools when an inbox goes.
    const shared =
      (await ctx.db.query("googleConnections").withIndex("by_sub", (q) => q.eq("googleSub", connection.googleSub)).take(100)).some((row) => row._id !== connection._id && row.status !== "disconnected") ||
      (await gmailInboxOn(ctx, connection.email));
    if (credential) {
      if (!shared) await ctx.scheduler.runAfter(0, internal.google.revokeGrant, { connectionId: connection._id, sealedRefreshToken: credential.sealedRefreshToken });
      await ctx.db.delete(credential._id);
    }
    await recordEvent(ctx, { companyId: ctx.companyId, type: "google.disconnected", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { feature: args.feature, revokedAtGoogle: !shared } });
    return { stopped: true, revokedAtGoogle: !shared };
  },
});

/**
 * Every Google connection of a company being deleted (convex/companyDeletion.ts), the same way the Owner's
 * disconnect does it: work cancelled, token deleted, and Google's grant revoked unless another live tool
 * (in any company) shares the account. Returns how many were connected.
 */
export async function disconnectGoogleForDeletion(ctx: MutationCtx, companyId: Id<"companies">): Promise<number> {
  const rows = await ctx.db.query("googleConnections").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(50);
  let stopped = 0;
  for (const connection of rows) {
    if (connection.status === "disconnected") continue;
    await stopConnection(ctx, connection, "Disconnected because the company is being deleted.");
    const shared =
      (await ctx.db.query("googleConnections").withIndex("by_sub", (q) => q.eq("googleSub", connection.googleSub)).take(100)).some((row) => row._id !== connection._id && row.status !== "disconnected") ||
      (await gmailInboxOn(ctx, connection.email));
    for (const credential of await ctx.db.query("googleCredentials").withIndex("by_connection", (q) => q.eq("connectionId", connection._id)).take(10)) {
      if (!shared) await ctx.scheduler.runAfter(0, internal.google.revokeGrant, { connectionId: connection._id, sealedRefreshToken: credential.sealedRefreshToken });
      await ctx.db.delete(credential._id);
    }
    await recordEvent(ctx, { companyId, type: "google.disconnected", actor: { kind: "system" }, subject: { table: "companies", id: companyId }, data: { feature: connection.feature ?? "legacy", revokedAtGoogle: !shared, reason: "company_deletion" } });
    stopped += 1;
  }
  return stopped;
}

export const revokeGrant = internalAction({
  args: { connectionId: v.id("googleConnections"), sealedRefreshToken: v.string() },
  handler: async (_ctx, args) => {
    const token = await unseal(args.sealedRefreshToken, args.connectionId);
    if (token) await revoke(token);
    return null;
  },
});

// ── Tokens, for Google steps only ───────────────────────────────────────────────────────────────

export const credentialFor = internalQuery({
  args: { connectionId: v.id("googleConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status !== "connected") return null;
    const row = await ctx.db.query("googleCredentials").withIndex("by_connection", (q) => q.eq("connectionId", connection._id)).first();
    return row ? { sealedRefreshToken: row.sealedRefreshToken, companyId: connection.companyId, grantedScopes: connection.grantedScopes } : null;
  },
});

export const markRefreshed = internalMutation({
  args: { connectionId: v.id("googleConnections"), scopes: v.array(v.string()) },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status !== "connected") return null;
    // Google returns the scopes still granted. A scope the account removed in its Google settings is removed here too.
    await ctx.db.patch(connection._id, { lastRefreshAt: Date.now(), ...(args.scopes.length ? { grantedScopes: args.scopes } : {}) });
    return null;
  },
});

export const markExpired = internalMutation({
  args: { connectionId: v.id("googleConnections"), why: v.string() },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status !== "connected") return null;
    await ctx.db.patch(connection._id, { status: "expired", problem: args.why.slice(0, 300) });
    await recordEvent(ctx, { companyId: connection.companyId, type: "google.expired", actor: { kind: "system" }, subject: { table: "companies", id: connection.companyId } });
    return null;
  },
});

/** An access token for one connection, or why there is none. For use inside actions only. */
export async function accessTokenFor(ctx: ActionCtx, connectionId: Id<"googleConnections">): Promise<{ ok: true; token: string; companyId: Id<"companies">; scopes: string[] } | { ok: false; why: string; kind: "not_connected" | "auth" | "not_configured" | "server" }> {
  const app = googleApp();
  if (!app) return { ok: false, why: "Google isn’t available right now.", kind: "not_configured" };
  const credential = await ctx.runQuery(internal.google.credentialFor, { connectionId });
  if (!credential) return { ok: false, why: "Google is not connected.", kind: "not_connected" };
  const refreshToken = await unseal(credential.sealedRefreshToken, connectionId);
  if (!refreshToken) return { ok: false, why: "Google needs to be reconnected.", kind: "not_configured" };
  try {
    const fresh = await refresh(app, refreshToken);
    await ctx.runMutation(internal.google.markRefreshed, { connectionId, scopes: fresh.scopes });
    return { ok: true, token: fresh.accessToken, companyId: credential.companyId, scopes: fresh.scopes.length ? fresh.scopes : credential.grantedScopes };
  } catch (error) {
    if (error instanceof GoogleError && error.kind === "auth") {
      await ctx.runMutation(internal.google.markExpired, { connectionId, why: error.message });
      return { ok: false, why: error.message, kind: "auth" };
    }
    return { ok: false, why: error instanceof Error ? error.message : "Google did not answer.", kind: "server" };
  }
}

// ── Resources the Owner authorizes ──────────────────────────────────────────────────────────────

const RESOURCE_FEATURE: Record<Doc<"googleResources">["kind"], Feature> = {
  drive_source: "drive",
  drive_output: "drive",
  calendar_sync: "calendar",
  calendar_busy: "calendar",
  business_location: "business_profile",
  ads_account: "ads",
  conversion_destination: "conversions",
};

export const addResource = ownerMutation({
  args: { kind: resourceKindValidator, externalId: v.string(), label: v.string(), purpose: v.optional(v.string()), detail: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const feature = RESOURCE_FEATURE[args.kind];
    const connection = await activeConnection(ctx, ctx.companyId, feature);
    if (!connection || connection.status !== "connected") throw userError(`Connect ${FEATURE_INFO[feature].label} first.`);
    if (!enabledFeatures(connection.grantedScopes).includes(feature)) throw userError(`${FEATURE_INFO[feature].label} is not granted yet. Reconnect it and allow everything Google asks for.`);
    const externalId = args.externalId.trim();
    if (!externalId || externalId.length > 300 || !/^[\w@.:/\-+=#%]+$/.test(externalId)) throw userError("That is not a Google id Selestial can use.");
    if (args.kind === "calendar_sync") {
      // One calendar receives visits and interviews; choosing another replaces it.
      for (const old of await ctx.db.query("googleResources").withIndex("by_company_kind", (q) => q.eq("companyId", ctx.companyId).eq("kind", "calendar_sync")).take(10)) await ctx.db.delete(old._id);
    }
    const existing = (await ctx.db.query("googleResources").withIndex("by_company_kind", (q) => q.eq("companyId", ctx.companyId).eq("kind", args.kind)).take(200)).find((r) => r.externalId === externalId && (r.purpose ?? "") === (args.purpose ?? ""));
    if (existing) return existing._id;
    const id = await ctx.db.insert("googleResources", { companyId: ctx.companyId, connectionId: connection._id, kind: args.kind, externalId, label: args.label.trim().slice(0, 200) || externalId, purpose: args.purpose?.trim().slice(0, 60) || undefined, detail: args.detail?.trim().slice(0, 200) || undefined, access: "unverified", addedBy: ctx.member._id, createdAt: Date.now() });
    // Choosing something is not proof Selestial can reach it: it is checked against Google straight away.
    await ctx.scheduler.runAfter(0, internal.googleWork.verifyResource, { resourceId: id });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "google.resource_added", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { kind: args.kind } });
    return id;
  },
});

export const removeResource = ownerMutation({
  args: { resourceId: v.id("googleResources") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.resourceId);
    if (!row || row.companyId !== ctx.companyId) notFound();
    await ctx.db.delete(row._id);
    await recordEvent(ctx, { companyId: ctx.companyId, type: "google.resource_removed", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { kind: row.kind } });
    return null;
  },
});

export const resourceFor = internalQuery({
  args: { resourceId: v.id("googleResources") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.resourceId);
    if (!row) return null;
    const connection = await ctx.db.get(row.connectionId);
    return connection && connection.status === "connected" ? row : null;
  },
});

export const setResourceAccess = internalMutation({
  args: { resourceId: v.id("googleResources"), access: v.union(v.literal("verified"), v.literal("lost")), note: v.optional(v.string()), detail: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.resourceId);
    if (!row) return null;
    await ctx.db.patch(row._id, { access: args.access, accessNote: args.note?.slice(0, 300), verifiedAt: Date.now(), ...(args.detail ? { detail: args.detail.slice(0, 200) } : {}) });
    return null;
  },
});


// ── What the Owner can choose from ──────────────────────────────────────────────────────────────

const choiceKind = v.union(v.literal("calendars"), v.literal("locations"), v.literal("ads_accounts"), v.literal("folder_contents"), v.literal("conversion_actions"));

/** Asks Google, as the company, what can be chosen. The answer lands in `choices`. */
const CHOICE_FEATURE = { calendars: "calendar", locations: "business_profile", ads_accounts: "ads", folder_contents: "drive", conversion_actions: "ads" } as const;

export const refreshChoices = ownerMutation({
  args: { kind: choiceKind, scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const feature = CHOICE_FEATURE[args.kind];
    const connection = await activeConnection(ctx, ctx.companyId, feature);
    if (!connection || connection.status !== "connected") throw userError(`Connect ${FEATURE_INFO[feature].label} first.`);
    await ctx.scheduler.runAfter(0, internal.googleWork.listChoices, { connectionId: connection._id, kind: args.kind, scope: args.scope });
    return null;
  },
});

export const choices = companyQuery({
  args: { kind: choiceKind },
  handler: async (ctx, args) => {
    if (ctx.role !== "owner") return null;
    const row = await ctx.db.query("googleChoices").withIndex("by_company_kind", (q) => q.eq("companyId", ctx.companyId).eq("kind", args.kind)).first();
    return row ? { items: row.items, problem: row.problem ?? null, fetchedAt: row.fetchedAt, scope: row.scope ?? null } : null;
  },
});

/**
 * One-time move from the single shared connection to one per tool: a row made before then becomes the
 * connection of the first tool it fully granted (its token and resources stay with it). Other tools are
 * connected again on their own. Safe to run more than once.
 */
export const migrateToPerTool = internalMutation({
  args: {},
  handler: async (ctx) => {
    let moved = 0;
    for (const row of await ctx.db.query("googleConnections").take(1000)) {
      if (row.feature) continue;
      const feature = enabledFeatures(row.grantedScopes)[0];
      if (feature && !(await activeConnection(ctx, row.companyId, feature))) await ctx.db.patch(row._id, { feature });
      else {
        await stopConnection(ctx, row, "Google is now connected tool by tool. Connect this tool again.");
        for (const credential of await ctx.db.query("googleCredentials").withIndex("by_connection", (q) => q.eq("connectionId", row._id)).take(5)) await ctx.db.delete(credential._id);
      }
      moved += 1;
    }
    return moved;
  },
});
