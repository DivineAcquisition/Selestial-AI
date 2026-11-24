/**
 * QuickBooks Online: connecting, keeping the connection working, and disconnecting. Only the Owner
 * connects or disconnects; anyone in the company can see whether it is connected.
 *
 * Connecting: `startConnect` returns Intuit's sign-in address with a one-time state (only its hash is
 * kept, for ten minutes, and it is used once: a missing, unknown, reused or expired state is refused as a
 * possible cross-site request). Intuit returns to /oauth/quickbooks/callback with a code and the company's
 * realmId; the code is exchanged, both tokens are sealed to the connection, and the company's name is read
 * to confirm the connection works.
 *
 * Using it: `withAccess` hands a valid access token to a call. The token is reused until five minutes
 * before it expires, then refreshed, and Intuit's newest refresh token is stored before anything else. If
 * QuickBooks refuses the access token anyway (401), it is refreshed once and the call tried again.
 * Transient failures (network, 429, 5xx) are retried with backoff. If Intuit ends the authorization
 * (invalid_grant: the refresh token expired or was revoked, including when someone disconnects Selestial
 * inside QuickBooks), the connection is marked "needs reconnect" and the Owner is asked to reconnect, on
 * the Connected apps page and on Home (convex/lib/operations).
 *
 * Disconnecting revokes the authorization at Intuit and deletes the stored tokens.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { companyQuery, ownerMutation } from "./lib/builders";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { appOrigin, returnOrigin } from "./lib/invitations";
import { companyName, realWait, withRetry, type Wait } from "./lib/quickbooks/api";
import { authorizeUrl, DEFAULT_ENDPOINTS, DISCOVERY_LIFE, endpoints, exchange, quickbooksApp, quickbooksRedirect, QuickBooksError, refresh, revoke, type Fetcher, type Tokens } from "./lib/quickbooks/oauth";
import { hashToken, randomToken, seal, secretsConfigured, unseal } from "./lib/recruiter/secrets";

const STATE_LIFE = 10 * 60 * 1000;
/** An access token is refreshed when it has less than this long left. */
const REFRESH_MARGIN = 5 * 60 * 1000;

let fetcher: Fetcher | null = null;
let waiter: Wait | null = null;
/** Tests only: requests to Intuit go here instead of the network, and retries don't really wait. */
export function setQuickBooksFetchForTests(next: Fetcher | null, wait: Wait | null = null) {
  fetcher = next;
  waiter = wait;
}
const go: Fetcher = (url, init) => (fetcher ?? fetch)(url, init);
const wait: Wait = (ms) => (waiter ?? realWait)(ms);

/**
 * Writes one QuickBooks error to the deployment's logs as a single JSON line (Convex dashboard › Logs),
 * with Intuit's request id, so it can be found and shared with Intuit support. Never includes a token.
 */
export function logQuickBooksError(context: { companyId?: string; connectionId?: string; step: string }, error: QuickBooksError) {
  console.error(JSON.stringify({ event: "quickbooks_error", ...context, kind: error.kind, status: error.status ?? null, intuitTid: error.intuitTid ?? null, message: error.message, at: new Date().toISOString() }));
}

/** Where the Owner lands after Intuit, with what happened. */
export function afterQuickBooks(outcome: string, origin?: string | null): string {
  return `${returnOrigin(origin) ?? appOrigin() ?? ""}/app/settings/integrations/quickbooks?result=${encodeURIComponent(outcome)}`;
}

async function connectionOf(ctx: { db: QueryCtx["db"] }, companyId: Id<"companies">) {
  return ctx.db
    .query("quickbooksConnections")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .order("desc")
    .first();
}

async function ready(): Promise<boolean> {
  return quickbooksApp() !== null && quickbooksRedirect() !== null && (await secretsConfigured());
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

/** Where the connection stands. Anyone in the company may see it; only the Owner may change it. */
export const status = companyQuery({
  args: {},
  handler: async (ctx) => {
    const row = await connectionOf(ctx, ctx.companyId);
    const app = quickbooksApp();
    return {
      available: await ready(),
      environment: app?.environment ?? null,
      canManage: ctx.role === "owner",
      connection:
        row && row.status !== "disconnected"
          ? {
              status: row.status,
              companyName: row.companyName ?? null,
              environment: row.environment,
              realmId: ctx.role === "owner" ? row.realmId : null,
              problem: row.problem ?? null,
              connectedAt: row.connectedAt,
              lastCheckedAt: row.lastCheckedAt ?? null,
              // The last error, until a later check succeeds (markChecked clears it).
              lastError: row.lastError ?? null,
            }
          : null,
    };
  },
});

// ── Connecting ──────────────────────────────────────────────────────────────────────────────────

/** Intuit's sign-in address for this company's Owner. Also how a connection that needs it is reconnected. */
export const startConnect = ownerMutation({
  args: { returnTo: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const app = quickbooksApp();
    const redirect = quickbooksRedirect();
    if (!app || !redirect || !(await secretsConfigured())) throw userError("Connecting QuickBooks isn’t available yet.");
    const state = await randomToken();
    await ctx.db.insert("quickbooksStates", {
      companyId: ctx.companyId,
      memberId: ctx.member._id,
      stateHash: await hashToken(state),
      returnOrigin: returnOrigin(args.returnTo) ?? undefined,
      expiresAt: Date.now() + STATE_LIFE,
    });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quickbooks.connect_started", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId } });
    // The sign-in address comes from Intuit's discovery document as last read. A mutation can't make a
    // network call, so a stale copy is refreshed in the background for next time.
    const stored = await ctx.db
      .query("quickbooksDiscovery")
      .withIndex("by_environment", (q) => q.eq("environment", app.environment))
      .first();
    if (!stored || Date.now() - stored.fetchedAt > DISCOVERY_LIFE) await ctx.scheduler.runAfter(0, internal.quickbooks.refreshDiscovery, {});
    const found = stored ? { authorization: stored.authorization, token: stored.token, revocation: stored.revocation } : DEFAULT_ENDPOINTS;
    return { url: authorizeUrl(app, found, redirect, state) };
  },
});

/** Reads Intuit's discovery document and keeps it for the sign-in address. */
export const refreshDiscovery = internalAction({
  args: {},
  handler: async (ctx) => {
    const app = quickbooksApp();
    if (!app) return null;
    const found = await endpoints(app.environment, go);
    await ctx.runMutation(internal.quickbooks.saveDiscovery, { environment: app.environment, ...found });
    return found;
  },
});

export const saveDiscovery = internalMutation({
  args: { environment: v.union(v.literal("sandbox"), v.literal("production")), authorization: v.string(), token: v.string(), revocation: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("quickbooksDiscovery")
      .withIndex("by_environment", (q) => q.eq("environment", args.environment))
      .first();
    const next = { ...args, fetchedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, next);
    else await ctx.db.insert("quickbooksDiscovery", next);
    return null;
  },
});

/** Uses a state once, and only for someone who is still the company's Owner. */
export const takeState = internalMutation({
  args: { stateHash: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("quickbooksStates")
      .withIndex("by_stateHash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (!row) return { kind: "unknown" as const };
    const fresh = row.usedAt === undefined && row.expiresAt > Date.now();
    await ctx.db.patch(row._id, { usedAt: row.usedAt ?? Date.now() });
    const member = await ctx.db.get(row.memberId);
    if (!fresh || !member || member.companyId !== row.companyId || member.status !== "active" || member.role !== "owner") return { kind: "expired" as const, returnOrigin: row.returnOrigin ?? null };
    return { kind: "ok" as const, companyId: row.companyId, memberId: row.memberId, returnOrigin: row.returnOrigin ?? null };
  },
});

/** Records the connection and its sealed tokens together, replacing any earlier connection of the company. */
export const saveConnection = internalMutation({
  args: {
    companyId: v.id("companies"),
    memberId: v.id("members"),
    realmId: v.string(),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    refreshToken: v.string(),
    accessToken: v.string(),
    accessExpiresAt: v.number(),
    refreshExpiresAt: v.number(),
  },
  handler: async (ctx, args): Promise<{ ok: true; connectionId: Id<"quickbooksConnections">; replaced: { sealedRefreshToken: string; connectionId: Id<"quickbooksConnections"> } | null } | { ok: false }> => {
    const before = await connectionOf(ctx, args.companyId);
    let replaced: { sealedRefreshToken: string; connectionId: Id<"quickbooksConnections"> } | null = null;
    // Reconnecting the same QuickBooks company keeps the connection's history; a different one replaces it.
    const same = before && before.status !== "disconnected" && before.realmId === args.realmId ? before : null;
    if (before && before.status !== "disconnected" && !same) {
      const credential = await credentialOf(ctx, before._id);
      if (credential) replaced = { sealedRefreshToken: credential.sealedRefreshToken, connectionId: before._id };
      await dropConnection(ctx, before, "disconnected", "Replaced by another QuickBooks company.");
    }
    const now = Date.now();
    let connectionId: Id<"quickbooksConnections">;
    if (same) {
      connectionId = same._id;
      await ctx.db.patch(same._id, { status: "connected", problem: undefined, environment: args.environment, connectedBy: args.memberId, lastRefreshAt: now, refreshExpiresAt: args.refreshExpiresAt });
    } else {
      connectionId = await ctx.db.insert("quickbooksConnections", { companyId: args.companyId, realmId: args.realmId, environment: args.environment, status: "connected", connectedBy: args.memberId, connectedAt: now, lastRefreshAt: now, refreshExpiresAt: args.refreshExpiresAt });
    }
    const stored = await storeTokens(ctx, args.companyId, connectionId, { refreshToken: args.refreshToken, accessToken: args.accessToken, accessExpiresAt: args.accessExpiresAt });
    if (!stored) {
      await ctx.db.patch(connectionId, { status: "disconnected", disconnectedAt: now, problem: "The connection could not be stored safely." });
      return { ok: false };
    }
    await recordEvent(ctx, { companyId: args.companyId, type: same ? "quickbooks.reconnected" : "quickbooks.connected", actor: { kind: "member", memberId: args.memberId }, subject: { table: "companies", id: args.companyId }, data: { environment: args.environment } });
    return { ok: true, connectionId, replaced };
  },
});

async function credentialOf(ctx: { db: QueryCtx["db"] }, connectionId: Id<"quickbooksConnections">) {
  return ctx.db
    .query("quickbooksCredentials")
    .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
    .first();
}

/** Seals both tokens to the connection and replaces whatever was stored. */
async function storeTokens(ctx: MutationCtx, companyId: Id<"companies">, connectionId: Id<"quickbooksConnections">, tokens: { refreshToken: string; accessToken: string; accessExpiresAt: number }): Promise<boolean> {
  const sealedRefreshToken = await seal(tokens.refreshToken, connectionId);
  const sealedAccessToken = await seal(tokens.accessToken, connectionId);
  if (!sealedRefreshToken || !sealedAccessToken) return false;
  for (const row of await ctx.db.query("quickbooksCredentials").withIndex("by_connection", (q) => q.eq("connectionId", connectionId)).take(10)) await ctx.db.delete(row._id);
  await ctx.db.insert("quickbooksCredentials", { companyId, connectionId, sealedRefreshToken, sealedAccessToken, accessExpiresAt: tokens.accessExpiresAt, updatedAt: Date.now() });
  return true;
}

/** Deletes the stored tokens. The connection row stays, so its history does. */
async function dropConnection(ctx: MutationCtx, connection: Doc<"quickbooksConnections">, status: "disconnected" | "needs_reconnect", problem?: string) {
  for (const row of await ctx.db.query("quickbooksCredentials").withIndex("by_connection", (q) => q.eq("connectionId", connection._id)).take(10)) await ctx.db.delete(row._id);
  await ctx.db.patch(connection._id, { status, problem, ...(status === "disconnected" ? { disconnectedAt: Date.now() } : {}) });
}

/** Where Intuit sends the Owner back. Returns the address to send them on to. */
export async function quickbooksCallback(ctx: ActionCtx, params: URLSearchParams): Promise<string> {
  const state = params.get("state");
  // No state, or one Selestial never issued: possibly a forged request. Nothing is exchanged.
  if (!state || state.length > 200) return afterQuickBooks("failed");
  const taken = await ctx.runMutation(internal.quickbooks.takeState, { stateHash: await hashToken(state) });
  if (taken.kind === "unknown") return afterQuickBooks("failed");
  if (taken.kind === "expired") return afterQuickBooks("expired", taken.returnOrigin);
  const app = quickbooksApp();
  const redirect = quickbooksRedirect();
  const code = params.get("code");
  const realmId = params.get("realmId");
  if (params.get("error")) return afterQuickBooks(params.get("error") === "access_denied" ? "declined" : "failed", taken.returnOrigin);
  if (!code || !realmId || !/^\d{1,32}$/.test(realmId) || !app || !redirect) return afterQuickBooks("failed", taken.returnOrigin);
  let tokens: Tokens;
  try {
    tokens = await withRetry(() => exchange(app, code, redirect, go), wait);
  } catch (error) {
    if (error instanceof QuickBooksError) logQuickBooksError({ companyId: taken.companyId, step: "exchange" }, error);
    return afterQuickBooks("failed", taken.returnOrigin);
  }
  const saved = await ctx.runMutation(internal.quickbooks.saveConnection, { companyId: taken.companyId, memberId: taken.memberId, realmId, environment: app.environment, ...tokens });
  if (!saved.ok) {
    await revoke(app, tokens.refreshToken, go);
    return afterQuickBooks("failed", taken.returnOrigin);
  }
  if (saved.replaced) await ctx.scheduler.runAfter(0, internal.quickbooks.revokeSealed, saved.replaced);
  // Confirm it works by reading the company's name. A failure here doesn't undo the connection.
  await checkConnection(ctx, saved.connectionId);
  return afterQuickBooks("connected", taken.returnOrigin);
}

// ── Using the connection ────────────────────────────────────────────────────────────────────────

export const credentialFor = internalQuery({
  args: { connectionId: v.id("quickbooksConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status !== "connected") return null;
    const credential = await credentialOf(ctx, args.connectionId);
    return credential ? { connection, credential } : null;
  },
});

/** Stores refreshed tokens. Intuit may have retired the old refresh token, so this happens before any other use. */
export const rotate = internalMutation({
  args: { connectionId: v.id("quickbooksConnections"), refreshToken: v.string(), accessToken: v.string(), accessExpiresAt: v.number(), refreshExpiresAt: v.number() },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status !== "connected") return false;
    const stored = await storeTokens(ctx, connection.companyId, connection._id, args);
    if (stored) await ctx.db.patch(connection._id, { lastRefreshAt: Date.now(), refreshExpiresAt: args.refreshExpiresAt });
    return stored;
  },
});

/** Intuit ended the authorization: only the Owner reconnecting helps. The tokens are deleted. */
export const markNeedsReconnect = internalMutation({
  args: { connectionId: v.id("quickbooksConnections"), problem: v.string() },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status !== "connected") return null;
    await dropConnection(ctx, connection, "needs_reconnect", args.problem.slice(0, 300));
    await recordEvent(ctx, { companyId: connection.companyId, type: "quickbooks.needs_reconnect", actor: { kind: "system" }, subject: { table: "companies", id: connection.companyId } });
    return null;
  },
});

export const markChecked = internalMutation({
  args: { connectionId: v.id("quickbooksConnections"), companyName: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status !== "connected") return null;
    // A successful check clears the last error from the Owner's screen; the logs keep it.
    await ctx.db.patch(connection._id, { lastCheckedAt: Date.now(), problem: undefined, lastError: undefined, ...(args.companyName ? { companyName: args.companyName } : {}) });
    return null;
  },
});

/** Keeps the last QuickBooks error on the connection, for the Owner's screen and for support. */
export const recordError = internalMutation({
  args: { connectionId: v.id("quickbooksConnections"), kind: v.string(), status: v.optional(v.number()), intuitTid: v.optional(v.string()), message: v.string() },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) return null;
    await ctx.db.patch(connection._id, { lastError: { at: Date.now(), kind: args.kind, status: args.status, intuitTid: args.intuitTid, message: args.message.slice(0, 500) } });
    return null;
  },
});

export type AccessResult<T> = { ok: true; value: T } | { ok: false; kind: "not_connected" | "needs_reconnect" | "transient" | "rejected" | "not_configured"; message: string };

/**
 * Runs `call` with a valid access token for the connection. Refreshes the token when it is about to
 * expire, refreshes once more and retries if QuickBooks refuses it, retries transient failures, and marks
 * the connection "needs reconnect" when Intuit has ended the authorization.
 */
export async function withAccess<T>(ctx: ActionCtx, connectionId: Id<"quickbooksConnections">, call: (input: { accessToken: string; realmId: string; environment: "sandbox" | "production" }) => Promise<T>): Promise<AccessResult<T>> {
  const app = quickbooksApp();
  if (!app) return { ok: false, kind: "not_configured", message: "QuickBooks isn't set up for Selestial yet." };
  const found = await ctx.runQuery(internal.quickbooks.credentialFor, { connectionId });
  if (!found) return { ok: false, kind: "not_connected", message: "QuickBooks isn't connected." };
  const { connection, credential } = found;
  const realmId = connection.realmId;
  const environment = connection.environment;
  const refreshNow = async (): Promise<string> => {
    const latest = await ctx.runQuery(internal.quickbooks.credentialFor, { connectionId });
    const refreshToken = latest ? await unseal(latest.credential.sealedRefreshToken, connectionId) : null;
    if (!refreshToken) throw new QuickBooksError("grant_ended", "The stored QuickBooks authorization couldn't be read. Reconnect QuickBooks.");
    const tokens = await withRetry(() => refresh(app, refreshToken, go), wait);
    // Keep Intuit's newest refresh token before using the new access token.
    await ctx.runMutation(internal.quickbooks.rotate, { connectionId, ...tokens });
    return tokens.accessToken;
  };
  try {
    let accessToken = credential.accessExpiresAt - Date.now() > REFRESH_MARGIN ? await unseal(credential.sealedAccessToken, connectionId) : null;
    if (!accessToken) accessToken = await refreshNow();
    try {
      return { ok: true, value: await withRetry(() => call({ accessToken: accessToken!, realmId, environment }), wait) };
    } catch (error) {
      // Refused although it should still be valid (revoked early, or clocks differ): refresh once and try again.
      if (!(error instanceof QuickBooksError) || error.kind !== "access_expired") throw error;
      accessToken = await refreshNow();
      return { ok: true, value: await withRetry(() => call({ accessToken: accessToken!, realmId, environment }), wait) };
    }
  } catch (error) {
    if (error instanceof QuickBooksError) {
      logQuickBooksError({ companyId: connection.companyId, connectionId, step: "api" }, error);
      await ctx.runMutation(internal.quickbooks.recordError, { connectionId, kind: error.kind, status: error.status, intuitTid: error.intuitTid, message: error.message });
      if (error.kind === "grant_ended" || error.kind === "access_expired") {
        await ctx.runMutation(internal.quickbooks.markNeedsReconnect, { connectionId, problem: error.kind === "grant_ended" ? error.message : "QuickBooks keeps refusing Selestial's access. Reconnect QuickBooks." });
        return { ok: false, kind: "needs_reconnect", message: "QuickBooks needs reconnecting." };
      }
      return { ok: false, kind: error.kind, message: error.message + (error.intuitTid ? ` (QuickBooks request ${error.intuitTid})` : "") };
    }
    throw error;
  }
}

async function checkConnection(ctx: ActionCtx, connectionId: Id<"quickbooksConnections">): Promise<AccessResult<string | null>> {
  const result = await withAccess(ctx, connectionId, (access) => companyName({ ...access, fetcher: go }));
  if (result.ok) await ctx.runMutation(internal.quickbooks.markChecked, { connectionId, companyName: result.value ?? undefined });
  return result;
}

/** Reads the company's name from QuickBooks to show the connection works. */
export const check = internalAction({
  args: { connectionId: v.id("quickbooksConnections") },
  handler: async (ctx, args) => {
    const result = await checkConnection(ctx, args.connectionId);
    return result.ok ? { ok: true as const, companyName: result.value } : { ok: false as const, kind: result.kind, message: result.message };
  },
});

/** The Owner's "Check connection" button. */
export const checkNow = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const connection = await connectionOf(ctx, ctx.companyId);
    if (!connection || connection.status !== "connected") throw userError("QuickBooks isn't connected.");
    await ctx.scheduler.runAfter(0, internal.quickbooks.check, { connectionId: connection._id });
    return null;
  },
});

// ── Disconnecting ───────────────────────────────────────────────────────────────────────────────

export const disconnect = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const connection = await connectionOf(ctx, ctx.companyId);
    if (!connection || connection.status === "disconnected") return null;
    const credential = await credentialOf(ctx, connection._id);
    await dropConnection(ctx, connection, "disconnected");
    if (credential) await ctx.scheduler.runAfter(0, internal.quickbooks.revokeSealed, { sealedRefreshToken: credential.sealedRefreshToken, connectionId: connection._id });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quickbooks.disconnected", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId } });
    return null;
  },
});

/** Revokes a stored authorization at Intuit, so QuickBooks shows Selestial as disconnected too. */
export const revokeSealed = internalAction({
  args: { sealedRefreshToken: v.string(), connectionId: v.id("quickbooksConnections") },
  handler: async (_ctx, args) => {
    const app = quickbooksApp();
    const token = await unseal(args.sealedRefreshToken, args.connectionId);
    if (!app || !token) return false;
    return revoke(app, token, go);
  },
});

/** A company being deleted (convex/companyDeletion.ts): disconnect the same way the Owner does. */
export async function disconnectQuickBooksForDeletion(ctx: MutationCtx, companyId: Id<"companies">): Promise<number> {
  const connection = await connectionOf(ctx, companyId);
  if (!connection || connection.status === "disconnected") return 0;
  const credential = await credentialOf(ctx, connection._id);
  await dropConnection(ctx, connection, "disconnected");
  if (credential) await ctx.scheduler.runAfter(0, internal.quickbooks.revokeSealed, { sealedRefreshToken: credential.sealedRefreshToken, connectionId: connection._id });
  await recordEvent(ctx, { companyId, type: "quickbooks.disconnected", actor: { kind: "system" }, subject: { table: "companies", id: companyId }, data: { reason: "company_deletion" } });
  return 1;
}
