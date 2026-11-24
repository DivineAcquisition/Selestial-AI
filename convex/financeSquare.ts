/**
 * Finance's Square connection: each company authorizes its own Square account through Square OAuth, the
 * Owner confirms the business Square answered for, and chooses the location payments are taken at
 * (docs/finance/square.md).
 *
 *   Connect Square → authorize in Square → back to Selestial → confirm the business → choose a location → ready
 *
 * The callback from Square carries no session: it proves only which authorization was started, not whose
 * browser came back. So nothing is connected there. The tokens are sealed to the one-time state and wait
 * until the signed-in Owner who started confirms the business (`confirmConnect`); unconfirmed, they are
 * discarded and the grant ended after fifteen minutes.
 *
 * Tokens are sealed (AES-GCM under MAILBOX_TOKEN_KEY) and bound to their row, so a copy of the database
 * can't use them and a token can't be moved to another company. They never leave the backend.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { ownerMutation, ownerQuery } from "./lib/builders";
import { userError } from "./lib/errors";
import { byMember, recordEvent, type Actor } from "./lib/events";
import { requireFinance } from "./lib/finance/authority";
import { settingsOf, settingsRow } from "./lib/finance/settings";
import {
  authLost,
  authorizeUrl,
  listLocations,
  locationFacts,
  obtainToken,
  refreshToken,
  retrieveMerchant,
  revokeToken,
  squareBlockers,
  squareConfig,
  tokensFrom,
  type SquareConfig,
  type SquareEnvironment,
} from "./lib/finance/square";
import { currentSquareConnection, squareState } from "./lib/finance/squareState";
import { appOrigin, returnOrigin } from "./lib/invitations";
import { allow } from "./lib/rateLimit";
import { hashToken, randomToken, seal, secretsConfigured, unseal } from "./lib/recruiter/secrets";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SYSTEM: Actor = { kind: "system" };
/** How long a started authorization stays usable, and how long Square's answer waits for the Owner's confirmation. */
const STATE_LIFE = 10 * MINUTE;
const PENDING_LIFE = 15 * MINUTE;
/** Square access tokens last 30 days. They are refreshed once 7 or fewer days remain (Square recommends at least weekly). */
const REFRESH_WITHIN = 7 * DAY;
/** A refresh holds this long, so two can't run at once. */
const REFRESH_LEASE = 2 * MINUTE;

/** What a sealed token is bound to: the row it belongs to, so it can't be read for any other. */
export function connectionBinding(connectionId: Id<"squareConnections">, which: "access" | "refresh"): string {
  return `square:${which}:${connectionId}`;
}
export function pendingBinding(stateId: Id<"squareOAuthStates">, which: "access" | "refresh"): string {
  return `square-pending:${which}:${stateId}`;
}

const LIVE: readonly Doc<"squareConnections">["status"][] = ["needs_location", "ready", "needs_reconnect"];

/** Whether a Square account is live on any company in this environment. Revoking it would end that connection too. */
async function merchantInUse(ctx: QueryCtx | MutationCtx, environment: SquareEnvironment, merchantId: string): Promise<Doc<"squareConnections"> | null> {
  const rows = await ctx.db
    .query("squareConnections")
    .withIndex("by_merchant", (q) => q.eq("environment", environment).eq("merchantId", merchantId))
    .take(20);
  return rows.find((row) => LIVE.includes(row.status)) ?? null;
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────

/** The Owner's view of the company's Square connection. */
export const status = ownerQuery({
  args: {},
  handler: async (ctx) => {
    requireFinance(ctx, "read");
    return squareState(ctx, ctx.companyId, await secretsConfigured());
  },
});

// ── Connecting ───────────────────────────────────────────────────────────────────────────────────

/** The Owner starts Square's authorization. Answers with Square's address; the state is stored only as its hash. */
export const startConnect = ownerMutation({
  args: { returnTo: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireFinance(ctx, "edit");
    if (ctx.support) throw userError("Support access can't connect a company's Square account.");
    const config = squareConfig();
    const blockers = squareBlockers(config, await secretsConfigured());
    if (!config || blockers.length) throw userError(blockers[0]?.words ?? "Square isn't available on Selestial yet.");
    if (!(await allow(ctx, `square-connect:${ctx.companyId}`, 10, 10 * MINUTE))) throw userError("Too many tries. Wait a few minutes and try again.");
    const state = await randomToken();
    const now = Date.now();
    await ctx.db.insert("squareOAuthStates", {
      companyId: ctx.companyId,
      memberId: ctx.member._id,
      environment: config.environment,
      stateHash: await hashToken(state),
      returnOrigin: returnOrigin(args.returnTo) ?? undefined,
      expiresAt: now + STATE_LIFE,
    });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "square.connect_started", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { environment: config.environment } });
    return { url: authorizeUrl(config, state) };
  },
});

/** Takes a state once. Unknown, used or expired states connect nothing. */
export const takeState = internalMutation({
  args: { stateHash: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("squareOAuthStates")
      .withIndex("by_hash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (!row) return { kind: "unknown" as const };
    if (row.usedAt || row.expiresAt <= Date.now()) return { kind: "expired" as const, returnOrigin: row.returnOrigin ?? null };
    await ctx.db.patch(row._id, { usedAt: Date.now() });
    return { kind: "ok" as const, stateId: row._id, environment: row.environment, returnOrigin: row.returnOrigin ?? null };
  },
});

export const holdPending = internalMutation({
  args: {
    stateId: v.id("squareOAuthStates"),
    merchantId: v.string(),
    businessName: v.optional(v.string()),
    country: v.optional(v.string()),
    sealedAccessToken: v.string(),
    sealedRefreshToken: v.string(),
    accessExpiresAt: v.number(),
    confirmHash: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.stateId);
    if (!row || row.pending) return false;
    const { stateId, ...pending } = args;
    await ctx.db.patch(stateId, { pending: { ...pending, until: Date.now() + PENDING_LIFE } });
    return true;
  },
});

function afterSquare(result: "confirm" | "declined" | "failed" | "expired", origin: string | null, confirm?: string): string {
  const base = origin ?? appOrigin() ?? "https://app.selestial.io";
  const params = new URLSearchParams({ square: result, ...(confirm ? { t: confirm } : {}) });
  return `${base}/app/finance/setup?${params.toString()}#square`;
}

/**
 * GET /oauth/square/callback. Square sends the Owner's browser back with a one-time code (or a refusal).
 * The code is exchanged here, on the backend; the tokens are sealed to the state at once and held for the
 * signed-in Owner to confirm. Nothing about the tokens reaches the browser.
 */
export async function squareCallback(ctx: ActionCtx, params: URLSearchParams): Promise<string> {
  const state = params.get("state");
  if (!state || state.length > 200) return afterSquare("failed", null);
  const taken = await ctx.runMutation(internal.financeSquare.takeState, { stateHash: await hashToken(state) });
  if (taken.kind === "unknown") return afterSquare("failed", null);
  if (taken.kind === "expired") return afterSquare("expired", taken.returnOrigin);
  const code = params.get("code");
  if (params.get("error")) return afterSquare(params.get("error") === "access_denied" ? "declined" : "failed", taken.returnOrigin);
  const config = squareConfig();
  // The deployment's Square environment must still be the one the authorization was started in.
  if (!code || code.length > 500 || !config?.secret || config.environment !== taken.environment) return afterSquare("failed", taken.returnOrigin);
  const answer = await obtainToken(config, code);
  const tokens = answer.kind === "ok" ? tokensFrom(answer.data) : null;
  if (!tokens) return afterSquare("failed", taken.returnOrigin);
  const merchant = await retrieveMerchant(config, tokens.accessToken);
  const facts = merchant.kind === "ok" ? merchant.data.merchant : undefined;
  if (facts?.id && facts.id !== tokens.merchantId) return afterSquare("failed", taken.returnOrigin);
  const sealedAccessToken = await seal(tokens.accessToken, pendingBinding(taken.stateId, "access"));
  const sealedRefreshToken = await seal(tokens.refreshToken, pendingBinding(taken.stateId, "refresh"));
  if (!sealedAccessToken || !sealedRefreshToken) return afterSquare("failed", taken.returnOrigin);
  const confirm = await randomToken();
  const held = await ctx.runMutation(internal.financeSquare.holdPending, {
    stateId: taken.stateId,
    merchantId: tokens.merchantId,
    businessName: typeof facts?.business_name === "string" ? facts.business_name.slice(0, 120) : undefined,
    country: typeof facts?.country === "string" ? facts.country.slice(0, 4) : undefined,
    sealedAccessToken,
    sealedRefreshToken,
    accessExpiresAt: tokens.accessExpiresAt,
    confirmHash: await hashToken(confirm),
  });
  return afterSquare(held ? "confirm" : "failed", taken.returnOrigin, held ? confirm : undefined);
}

async function pendingFor(ctx: QueryCtx | MutationCtx, token: string) {
  if (!token || token.length > 200) return null;
  const confirmHash = await hashToken(token);
  const row = await ctx.db
    .query("squareOAuthStates")
    .withIndex("by_confirm", (q) => q.eq("pending.confirmHash", confirmHash))
    .unique();
  return row?.pending ? (row as Doc<"squareOAuthStates"> & { pending: NonNullable<Doc<"squareOAuthStates">["pending"]> }) : null;
}

/** What Square answered, for the Owner to confirm. Only for the member who started. */
export const pendingConnect = ownerQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    requireFinance(ctx, "edit");
    const row = await pendingFor(ctx, args.token);
    if (!row || row.companyId !== ctx.companyId || row.memberId !== ctx.member._id) return null;
    const current = await currentSquareConnection(ctx, ctx.companyId, row.environment);
    const live = current && current.status !== "disconnected" ? current : null;
    const elsewhere = await merchantInUse(ctx, row.environment, row.pending.merchantId);
    return {
      businessName: row.pending.businessName ?? null,
      country: row.pending.country ?? null,
      environment: row.environment,
      expired: row.pending.until <= Date.now(),
      // Another company's connection is never named, only that the account is taken.
      takenElsewhere: Boolean(elsewhere && elsewhere.companyId !== ctx.companyId),
      reconnect: Boolean(live && live.merchantId === row.pending.merchantId),
      otherAccountConnected: live && live.merchantId !== row.pending.merchantId ? (live.businessName ?? "another Square account") : null,
    };
  },
});

/**
 * The signed-in Owner who started confirms the Square business. A Square account connected to another
 * company is refused and never shared. Reconnecting the same account keeps the chosen location. A
 * different account needs the current one disconnected first, so its payments aren't left unwatched.
 */
export const confirmConnect = ownerMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    requireFinance(ctx, "edit");
    const row = await pendingFor(ctx, args.token);
    if (!row || row.companyId !== ctx.companyId) throw userError("That Square authorization isn't waiting any more, so nothing was connected. Please start again.");
    if (ctx.support || row.memberId !== ctx.member._id) throw userError("Only the person who started connecting Square can finish it. Nothing was connected.");
    if (row.pending.until <= Date.now()) {
      await discardPending(ctx, row);
      return { result: "expired" as const };
    }
    const config = squareConfig();
    if (!config || config.environment !== row.environment) {
      await discardPending(ctx, row);
      throw userError("Square's setup on Selestial changed while you were away. Nothing was connected. Please start again.");
    }
    const elsewhere = await merchantInUse(ctx, row.environment, row.pending.merchantId);
    if (elsewhere && elsewhere.companyId !== ctx.companyId) {
      // The grant isn't ended: it is the same grant the other company relies on.
      await ctx.db.patch(row._id, { pending: undefined });
      await recordEvent(ctx, { companyId: ctx.companyId, type: "square.connect_refused", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { reason: "connected_to_another_company" } });
      return { result: "taken" as const };
    }
    const current = await currentSquareConnection(ctx, ctx.companyId, row.environment);
    const live = current && current.status !== "disconnected" ? current : null;
    if (live && live.merchantId !== row.pending.merchantId) {
      await discardPending(ctx, row);
      return { result: "other_account" as const };
    }
    const access = await unseal(row.pending.sealedAccessToken, pendingBinding(row._id, "access"));
    const refresh = await unseal(row.pending.sealedRefreshToken, pendingBinding(row._id, "refresh"));
    if (!access || !refresh) throw userError("Connecting Square isn't available right now. Please try again a little later.");
    const now = Date.now();
    let connectionId: Id<"squareConnections">;
    if (live) {
      connectionId = live._id;
      await ctx.db.patch(live._id, { status: live.location ? "ready" : "needs_location", problem: undefined, businessName: row.pending.businessName ?? live.businessName, confirmedAt: now, connectedBy: ctx.member._id, openLinksAtLoss: undefined, updatedAt: now });
    } else {
      connectionId = await ctx.db.insert("squareConnections", {
        companyId: ctx.companyId,
        environment: row.environment,
        status: "needs_location",
        merchantId: row.pending.merchantId,
        businessName: row.pending.businessName,
        country: row.pending.country,
        // Replaced just below, once the row's id exists to bind them to.
        sealedAccessToken: "",
        sealedRefreshToken: "",
        accessExpiresAt: row.pending.accessExpiresAt,
        tokenVersion: 0,
        scopes: [],
        connectedBy: ctx.member._id,
        confirmedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    const sealedAccessToken = await seal(access, connectionBinding(connectionId, "access"));
    const sealedRefreshToken = await seal(refresh, connectionBinding(connectionId, "refresh"));
    if (!sealedAccessToken || !sealedRefreshToken) throw userError("Connecting Square isn't available right now. Please try again a little later.");
    const before = (await ctx.db.get(connectionId))!;
    await ctx.db.patch(connectionId, { sealedAccessToken, sealedRefreshToken, accessExpiresAt: row.pending.accessExpiresAt, tokenVersion: before.tokenVersion + 1, refreshingUntil: undefined, refreshedAt: now });
    await ctx.db.patch(row._id, { pending: undefined });
    await recordEvent(ctx, { companyId: ctx.companyId, type: live ? "square.reconnected" : "square.connected", actor: byMember(ctx), subject: { table: "squareConnections", id: connectionId }, data: { environment: row.environment } });
    await ctx.scheduler.runAfter(0, internal.financeSquare.syncLocations, { connectionId });
    // Reconnected: payments that were waiting while access was lost are read again now.
    if (live) await ctx.scheduler.runAfter(0, internal.financeSquarePay.recheckConnection, { connectionId });
    return { result: live ? ("reconnected" as const) : ("connected" as const) };
  },
});

/** "Not this business": the Owner throws the waiting authorization away now. */
export const cancelConnect = ownerMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const row = await pendingFor(ctx, args.token);
    if (!row || row.companyId !== ctx.companyId || row.memberId !== ctx.member._id) return null;
    await discardPending(ctx, row);
    return null;
  },
});

/** Throws a waiting authorization away, and ends Square's grant unless that Square account is in use. */
async function discardPending(ctx: MutationCtx, row: Doc<"squareOAuthStates">) {
  if (!row.pending) return;
  if (!(await merchantInUse(ctx, row.environment, row.pending.merchantId))) {
    await ctx.scheduler.runAfter(0, internal.financeSquare.revokeMerchant, { environment: row.environment, merchantId: row.pending.merchantId });
  }
  await ctx.db.patch(row._id, { pending: undefined });
}

/** Ends Selestial's access to a Square account. Asked again later only through the sweep; Selestial stops using it at once either way. */
export const revokeMerchant = internalAction({
  args: { environment: v.union(v.literal("sandbox"), v.literal("production")), merchantId: v.string() },
  handler: async (ctx, args) => {
    const config = squareConfig();
    if (!config?.secret || config.environment !== args.environment) return { revoked: false };
    if (await ctx.runQuery(internal.financeSquare.inUse, args)) return { revoked: false };
    const answer = await revokeToken(config, args.merchantId);
    return { revoked: answer.kind === "ok" };
  },
});

export const inUse = internalQuery({
  args: { environment: v.union(v.literal("sandbox"), v.literal("production")), merchantId: v.string() },
  handler: async (ctx, args) => Boolean(await merchantInUse(ctx, args.environment, args.merchantId)),
});

// ── Using the company's authorization ────────────────────────────────────────────────────────────

export const connectionFor = internalQuery({
  args: { connectionId: v.id("squareConnections") },
  handler: async (ctx, args) => ctx.db.get(args.connectionId),
});

export type Access = { kind: "ok"; config: SquareConfig; token: string; connection: Doc<"squareConnections"> } | { kind: "lost"; connection: Doc<"squareConnections"> | null } | { kind: "unavailable" };

/**
 * The company's access token, for an action that calls Square for it. Refreshed first when it is close to
 * expiring. A connection that was disconnected, or a token that can't be unsealed, is never used.
 */
export async function squareAccess(ctx: ActionCtx, connectionId: Id<"squareConnections">): Promise<Access> {
  const config = squareConfig();
  let connection = await ctx.runQuery(internal.financeSquare.connectionFor, { connectionId });
  if (!config || !connection || connection.environment !== config.environment) return { kind: "unavailable" };
  if (connection.status === "disconnected" || connection.status === "needs_reconnect") return { kind: "lost", connection };
  if (connection.accessExpiresAt - Date.now() < DAY) {
    await ctx.runAction(internal.financeSquare.refreshTokens, { connectionId });
    connection = await ctx.runQuery(internal.financeSquare.connectionFor, { connectionId });
    if (!connection || connection.status === "needs_reconnect" || connection.status === "disconnected") return { kind: "lost", connection };
    if (connection.accessExpiresAt <= Date.now()) return { kind: "unavailable" };
  }
  const token = await unseal(connection.sealedAccessToken, connectionBinding(connection._id, "access"));
  if (!token) return { kind: "unavailable" };
  return { kind: "ok", config, token, connection };
}

/** Takes the refresh lease. Null when another refresh holds it or the connection is no longer usable. */
export const beginRefresh = internalMutation({
  args: { connectionId: v.id("squareConnections") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    const now = Date.now();
    if (!row || row.status === "disconnected" || row.status === "needs_reconnect") return null;
    if (row.refreshingUntil && row.refreshingUntil > now) return null;
    await ctx.db.patch(row._id, { refreshingUntil: now + REFRESH_LEASE });
    return { sealedRefreshToken: row.sealedRefreshToken, tokenVersion: row.tokenVersion };
  },
});

/**
 * Stores refreshed tokens only if nothing newer was stored since the refresh began (a reconnect or a
 * faster refresh). An older answer never replaces newer credentials.
 */
export const tokensRefreshed = internalMutation({
  args: { connectionId: v.id("squareConnections"), tokenVersion: v.number(), sealedAccessToken: v.string(), sealedRefreshToken: v.string(), accessExpiresAt: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (!row || row.tokenVersion !== args.tokenVersion || row.status === "disconnected" || row.status === "needs_reconnect") return false;
    const now = Date.now();
    await ctx.db.patch(row._id, { sealedAccessToken: args.sealedAccessToken, sealedRefreshToken: args.sealedRefreshToken, accessExpiresAt: args.accessExpiresAt, tokenVersion: row.tokenVersion + 1, refreshingUntil: undefined, refreshedAt: now, updatedAt: now });
    return true;
  },
});

export const endRefresh = internalMutation({
  args: { connectionId: v.id("squareConnections") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row?.refreshingUntil) await ctx.db.patch(row._id, { refreshingUntil: undefined });
  },
});

/** A new access token from the company's refresh token. A refused refresh means the company must reconnect. */
export const refreshTokens = internalAction({
  args: { connectionId: v.id("squareConnections") },
  handler: async (ctx, args): Promise<{ refreshed: boolean }> => {
    const config = squareConfig();
    if (!config?.secret) return { refreshed: false };
    const lease: { sealedRefreshToken: string; tokenVersion: number } | null = await ctx.runMutation(internal.financeSquare.beginRefresh, args);
    if (!lease) return { refreshed: false };
    const refresh = await unseal(lease.sealedRefreshToken, connectionBinding(args.connectionId, "refresh"));
    if (!refresh) {
      await ctx.runMutation(internal.financeSquare.endRefresh, args);
      return { refreshed: false };
    }
    const answer = await refreshToken(config, refresh);
    if (answer.kind === "ok") {
      const tokens = tokensFrom(answer.data, refresh);
      const sealedAccessToken = tokens ? await seal(tokens.accessToken, connectionBinding(args.connectionId, "access")) : null;
      const sealedRefreshToken = tokens ? await seal(tokens.refreshToken, connectionBinding(args.connectionId, "refresh")) : null;
      if (tokens && sealedAccessToken && sealedRefreshToken) {
        const stored: boolean = await ctx.runMutation(internal.financeSquare.tokensRefreshed, { connectionId: args.connectionId, tokenVersion: lease.tokenVersion, sealedAccessToken, sealedRefreshToken, accessExpiresAt: tokens.accessExpiresAt });
        if (!stored) await ctx.runMutation(internal.financeSquare.endRefresh, args);
        return { refreshed: stored };
      }
    } else if (answer.kind === "refused" && (authLost(answer) || answer.status === 400)) {
      // Square no longer honors the refresh token: the seller revoked access, or the authorization ended.
      await ctx.runMutation(internal.financeSquarePay.authorizationLost, { connectionId: args.connectionId, reason: "Square stopped accepting Selestial's access to this account." });
      return { refreshed: false };
    }
    await ctx.runMutation(internal.financeSquare.endRefresh, args);
    return { refreshed: false };
  },
});

// ── Locations ────────────────────────────────────────────────────────────────────────────────────

/** Reads the business and its locations from Square, and whether each can take online card payments. */
export const syncLocations = internalAction({
  args: { connectionId: v.id("squareConnections") },
  handler: async (ctx, args) => {
    const access = await squareAccess(ctx, args.connectionId);
    if (access.kind !== "ok") return;
    const answer = await listLocations(access.config, access.token);
    if (answer.kind === "ok") {
      const locations = (answer.data.locations ?? []).map(locationFacts).filter((row): row is NonNullable<typeof row> => row !== null).slice(0, 100);
      const merchant = await retrieveMerchant(access.config, access.token);
      const businessName = merchant.kind === "ok" && typeof merchant.data.merchant?.business_name === "string" ? merchant.data.merchant.business_name.slice(0, 120) : undefined;
      await ctx.runMutation(internal.financeSquare.locationsRead, { connectionId: args.connectionId, locations, businessName });
    } else if (authLost(answer)) {
      await ctx.runMutation(internal.financeSquarePay.authorizationLost, { connectionId: args.connectionId, reason: "Square stopped accepting Selestial's access to this account." });
    } else {
      await ctx.runMutation(internal.financeSquare.noteChecked, { connectionId: args.connectionId, problem: "Square didn't answer when Selestial asked for your locations. Try again in a minute." });
    }
  },
});

const locationValidator = v.object({ id: v.string(), name: v.string(), currency: v.union(v.string(), v.null()), eligible: v.boolean(), why: v.union(v.string(), v.null()) });

export const locationsRead = internalMutation({
  args: { connectionId: v.id("squareConnections"), locations: v.array(locationValidator), businessName: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (!row || row.status === "disconnected" || row.status === "needs_reconnect") return;
    const now = Date.now();
    const chosen = row.location ? args.locations.find((l) => l.id === row.location!.id) : null;
    const eligible = args.locations.filter((l) => l.eligible);
    let status = row.status;
    let locationProblem: string | undefined;
    if (row.location && (!chosen || !chosen.eligible)) {
      // The chosen location can't take payments any more: new payments stop until the Owner chooses again.
      status = "needs_location";
      locationProblem = chosen?.why ?? `${row.location.name} is no longer one of this business's locations in Square.`;
    } else if (!row.location) {
      status = "needs_location";
      locationProblem = eligible.length ? undefined : "None of this business's Square locations can take online card payments in US dollars yet.";
    }
    await ctx.db.patch(row._id, { locations: args.locations, businessName: args.businessName ?? row.businessName, status, location: status === "needs_location" && row.location && (!chosen || !chosen.eligible) ? undefined : row.location, locationProblem, problem: undefined, checkedAt: now, updatedAt: now });
    if (status !== row.status) await recordEvent(ctx, { companyId: row.companyId, type: "square.updated", actor: SYSTEM, subject: { table: "squareConnections", id: row._id }, data: { status } });
  },
});

export const noteChecked = internalMutation({
  args: { connectionId: v.id("squareConnections"), problem: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row) await ctx.db.patch(row._id, { checkedAt: Date.now(), problem: args.problem });
  },
});

/** The Owner asks Selestial to read the business and its locations from Square again. */
export const refreshLocations = ownerMutation({
  args: {},
  handler: async (ctx) => {
    requireFinance(ctx, "read");
    const row = await currentSquareConnection(ctx, ctx.companyId);
    if (!row || row.status === "disconnected" || row.status === "needs_reconnect") return { ok: false };
    if (!(await allow(ctx, `square-locations:${ctx.companyId}`, 20, 10 * MINUTE))) return { ok: false };
    await ctx.scheduler.runAfter(0, internal.financeSquare.syncLocations, { connectionId: row._id });
    return { ok: true };
  },
});

/** The Owner chooses where payments are taken. Only a location Square said can take online card payments in dollars. */
export const chooseLocation = ownerMutation({
  args: { locationId: v.string() },
  handler: async (ctx, args) => {
    requireFinance(ctx, "edit");
    const row = await currentSquareConnection(ctx, ctx.companyId);
    if (!row || (row.status !== "needs_location" && row.status !== "ready")) throw userError("Connect Square first.");
    const location = row.locations?.find((l) => l.id === args.locationId);
    if (!location) throw userError("That location isn't one Square listed for this business. Refresh the list and try again.");
    if (!location.eligible || !location.currency) throw userError(location.why ?? "That location can't take online card payments.");
    const now = Date.now();
    await ctx.db.patch(row._id, { location: { id: location.id, name: location.name, currency: location.currency }, status: "ready", locationProblem: undefined, updatedAt: now });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "square.location_chosen", actor: byMember(ctx), subject: { table: "squareConnections", id: row._id }, data: { location: location.name } });
    return { ok: true };
  },
});

// ── Disconnecting ────────────────────────────────────────────────────────────────────────────────

async function disconnectFacts(ctx: QueryCtx | MutationCtx, row: Doc<"squareConnections">) {
  const of = async (status: Doc<"payments">["status"]) =>
    (
      await ctx.db
        .query("payments")
        .withIndex("by_company_status", (q) => q.eq("companyId", row.companyId).eq("status", status))
        .take(1000)
    ).filter((p) => p.square?.connectionId === row._id);
  const inFlight = (await of("processing")).length + (await of("checking")).length;
  const openLinks = (await of("awaiting_customer")).length;
  // Refunds still moving money on this connection's payments. Few at any time, so read by status.
  const refunds = [];
  for (const status of ["sending", "pending", "checking"] as const) {
    const rows = await ctx.db
      .query("refunds")
      .withIndex("by_status_updated", (q) => q.eq("status", status))
      .take(1000);
    for (const r of rows) {
      if (r.companyId !== row.companyId) continue;
      const payment = await ctx.db.get(r.paymentId);
      if (payment?.square?.connectionId === row._id) refunds.push(r);
    }
  }
  const settings = settingsOf(await settingsRow(ctx, row.companyId));
  return { inFlight, openLinks, refundsInFlight: refunds.length, preferred: settings.paymentProvider === "square", status: row.status };
}

/** Exactly what disconnecting does, before the Owner confirms. */
export const disconnectPreview = ownerQuery({
  args: {},
  handler: async (ctx) => {
    requireFinance(ctx, "edit");
    const row = await currentSquareConnection(ctx, ctx.companyId);
    if (!row || row.status === "disconnected") return null;
    const facts = await disconnectFacts(ctx, row);
    const blocked =
      facts.inFlight > 0
        ? `${facts.inFlight} Square payment${facts.inFlight === 1 ? " is" : "s are"} still being confirmed. Disconnect once ${facts.inFlight === 1 ? "it settles" : "they settle"}, so none goes unrecorded.`
        : facts.refundsInFlight > 0
          ? `${facts.refundsInFlight} Square refund${facts.refundsInFlight === 1 ? " is" : "s are"} still in progress. Disconnect once ${facts.refundsInFlight === 1 ? "it finishes" : "they finish"}.`
          : null;
    const lines = [
      row.status === "needs_reconnect" ? "Selestial can no longer reach this Square account, so this only removes it from Selestial." : "Selestial's access to this Square account ends. Nothing changes in your Square account itself.",
      facts.openLinks ? `${facts.openLinks} unfinished Square checkout${facts.openLinks === 1 ? " is" : "s are"} closed first, so ${facts.openLinks === 1 ? "it" : "they"} can't be paid after you disconnect.` : null,
      facts.preferred ? "New payment requests can't be paid online until you choose another way to take payments in Payments setup." : null,
      "Payments and refunds already recorded stay in Finance, with their Square references.",
    ].filter(Boolean) as string[];
    return { blocked, lines, bindsTo: `${row._id}:${facts.inFlight}:${facts.openLinks}:${facts.refundsInFlight}:${row.status}` };
  },
});

/** Ends the connection after the Owner confirmed the preview. Unfinished checkouts are closed before access ends. */
export const disconnect = ownerMutation({
  args: { bindsTo: v.string() },
  handler: async (ctx, args) => {
    requireFinance(ctx, "edit");
    if (ctx.support) throw userError("Support access can't disconnect a company's Square account.");
    const row = await currentSquareConnection(ctx, ctx.companyId);
    if (!row || row.status === "disconnected") throw userError("Square isn't connected.");
    const facts = await disconnectFacts(ctx, row);
    if (args.bindsTo !== `${row._id}:${facts.inFlight}:${facts.openLinks}:${facts.refundsInFlight}:${row.status}`) throw userError("Something changed since you looked. Review what disconnecting does again.");
    if (facts.inFlight > 0 || facts.refundsInFlight > 0) throw userError("Wait until Square payments and refunds in progress settle, then disconnect.");
    const now = Date.now();
    await ctx.db.patch(row._id, { status: "disconnected", disconnectedAt: now, disconnectedBy: ctx.member._id, refreshingUntil: undefined, updatedAt: now });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "square.disconnected", actor: byMember(ctx), subject: { table: "squareConnections", id: row._id }, data: { openLinksClosed: facts.openLinks } });
    await ctx.scheduler.runAfter(0, internal.financeSquarePay.endAccess, { connectionId: row._id, reachable: row.status !== "needs_reconnect" });
    return { ok: true };
  },
});

/** Clears the sealed tokens once nothing needs them. */
export const forgetTokens = internalMutation({
  args: { connectionId: v.id("squareConnections") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row && row.status === "disconnected") await ctx.db.patch(row._id, { sealedAccessToken: "", sealedRefreshToken: "", updatedAt: Date.now() });
  },
});

// ── Housekeeping ─────────────────────────────────────────────────────────────────────────────────

/** Daily: refresh access tokens that expire within a week; throw away authorizations nobody confirmed. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const status of ["needs_location", "ready"] as const) {
      const due = await ctx.db
        .query("squareConnections")
        .withIndex("by_status_expires", (q) => q.eq("status", status).lt("accessExpiresAt", now + REFRESH_WITHIN))
        .take(100);
      for (const row of due) await ctx.scheduler.runAfter(0, internal.financeSquare.refreshTokens, { connectionId: row._id });
    }
    const old = await ctx.db
      .query("squareOAuthStates")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now - PENDING_LIFE))
      .take(100);
    for (const row of old) {
      if (row.pending && row.pending.until > now) continue;
      await discardPending(ctx, row);
      await ctx.db.delete(row._id);
    }
  },
});
