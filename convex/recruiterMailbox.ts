/**
 * Connecting a company's Gmail as the hiring inbox, and the steps that use its stored authorization.
 *
 * 1. The Owner asks to connect (`startGmailConnect`). A random state is made, its hash is kept for ten
 *    minutes with the company and the Owner it belongs to, and the Owner is sent to Google.
 * 2. Google sends a browser back to `/oauth/google/callback` with the state and a code. The state is used
 *    once and the code is exchanged, but NOTHING IS CONNECTED YET: that endpoint carries no session, so it
 *    cannot know the browser belongs to the Owner who started. (An Owner could otherwise send their Google
 *    link to someone else and have that person's mailbox connected to their own company.) The
 *    authorization is sealed onto the state record as "pending", where nothing reads it.
 * 3. The browser is sent on to the app with a one-time value only it has. There the signed-in member sees
 *    the mailbox ADDRESS and confirms (`confirmConnect`). Only the member who started, still an active
 *    Owner of that company, can: then the connection is recorded, reading starts and waiting mail goes.
 * 4. Not confirmed within fifteen minutes: the pending authorization is deleted and Google's grant ended.
 *
 * Nothing about the token is ever returned to a browser.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { companyQuery, ownerMutation } from "./lib/builders";
import { userError } from "./lib/errors";
import { appOrigin, returnOrigin } from "./lib/invitations";
import { byMember, recordEvent } from "./lib/events";
import { redirectUri } from "./lib/google/oauth";
import { authorizationUrl, googleApp, revokeToken } from "./lib/recruiter/gmail";
import { sourceValidator, type InboxPurpose, type Source } from "./lib/recruiter/schema";
import { inboxBroke, resumeWaiting } from "./lib/inbox/events";
import { purposesOf, PURPOSE_INFO, sharesGoogleGrant } from "./lib/inbox/mailboxes";
import { notifyMembers } from "./lib/notify/route";
import { DAY } from "./lib/recruiter/settings";
import { hashToken, randomToken, seal, secretsConfigured, unseal } from "./lib/recruiter/secrets";
import { optionalText } from "./lib/text";

const STATE_LIFE = 10 * 60 * 1000;
/** How long a mailbox Google answered for waits to be confirmed in the app before it is thrown away. */
export const PENDING_LIFE = 15 * 60 * 1000;

/** What a pending authorization is sealed to: its state record, so it opens nowhere else. */
export function pendingBinding(stateId: Id<"oauthStates">): string {
  return `pending:${stateId}`;
}

/** The same address the company's Google tools use (convex/lib/google/oauth.ts): one OAuth client, one return. */
export function googleRedirectUri(): string | null {
  return redirectUri();
}

/**
 * Where the Owner lands after Google, saying how it went: Recruiting settings for a hiring inbox
 * connected there, Connected apps for an inbox connected with purposes.
 */
export function afterConnect(outcome: "confirm" | "failed" | "expired", origin?: string | null, shared = false, confirm?: string): string {
  const base = returnOrigin(origin) ?? appOrigin() ?? "";
  // "confirm" carries the one-time value the app page needs to show the address and finish.
  const pending = outcome === "confirm" && confirm ? `&pending=${encodeURIComponent(confirm)}` : "";
  return shared ? `${base}/app/settings/integrations?tool=gmail&result=${outcome}${pending}` : `${base}/app/agents/recruiter/hiring-setup?mailbox=${outcome}${pending}`;
}

/** Starts connecting a Gmail mailbox. Answers with the Google address to send the Owner to. */
export const startGmailConnect = ownerMutation({
  args: {
    folder: v.optional(v.string()),
    sources: v.optional(v.array(sourceValidator)),
    processFrom: v.optional(v.number()),
    /** Also allow applicant email to be sent from this mailbox. */
    canSend: v.optional(v.boolean()),
    /** The app address the Owner is on, so Google's answer comes back there. */
    returnTo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const app = googleApp();
    const redirectUri = googleRedirectUri();
    if (!app || !redirectUri) throw userError("Connecting Gmail isn’t available yet. Please try again a little later.");
    if (!(await secretsConfigured())) throw userError("Connecting Gmail isn’t available yet. Please try again a little later.");
    const now = Date.now();
    const processFrom = args.processFrom ?? now;
    if (processFrom < now - 180 * DAY) throw userError("A historical import can go back at most 180 days.");
    const state = await randomToken();
    await ctx.db.insert("oauthStates", {
      companyId: ctx.companyId,
      memberId: ctx.member._id,
      provider: "gmail",
      stateHash: await hashToken(state),
      folder: optionalText(args.folder, "The label", 200),
      sources: args.sources ?? [],
      processFrom,
      canSend: args.canSend ?? true,
      returnOrigin: returnOrigin(args.returnTo) ?? undefined,
      expiresAt: now + STATE_LIFE,
    });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "mailbox.connect_started", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { provider: "gmail" } });
    return { url: authorizationUrl(app, { redirectUri, state, loginHint: ctx.member.email, canSend: args.canSend ?? true }) };
  },
});

/** Uses a state once. Null when it is unknown, used or expired. */
export const takeState = internalMutation({
  args: { stateHash: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_stateHash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (!row || row.usedAt !== undefined) return null;
    await ctx.db.patch(row._id, { usedAt: Date.now() });
    if (row.expiresAt <= Date.now()) return null;
    const member = await ctx.db.get(row.memberId);
    // Only someone who is still this company's Owner can finish connecting its mailbox.
    if (!member || member.companyId !== row.companyId || member.status !== "active" || member.role !== "owner") return null;
    return { stateId: row._id, companyId: row.companyId, memberId: row.memberId, folder: row.folder, sources: row.sources, processFrom: row.processFrom, canSend: row.canSend, returnOrigin: row.returnOrigin ?? null, purposes: row.purposes ?? null };
  },
});

/**
 * Google answered for this state. The authorization waits, sealed to the state record, for the member who
 * started to confirm it in the app. Nothing reads it meanwhile: no connection exists, so nothing is read,
 * watched or sent.
 */
export const holdPending = internalMutation({
  args: { stateId: v.id("oauthStates"), address: v.string(), sealedRefreshToken: v.string(), scopes: v.array(v.string()), confirmHash: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.stateId);
    if (!row || row.usedAt === undefined || row.pending) return false;
    await ctx.db.patch(row._id, { pending: { address: args.address.trim().toLowerCase(), sealedRefreshToken: args.sealedRefreshToken, scopes: args.scopes, until: Date.now() + PENDING_LIFE }, confirmHash: args.confirmHash });
    await ctx.scheduler.runAfter(PENDING_LIFE, internal.recruiterMailbox.expirePending, { stateId: row._id });
    return true;
  },
});

async function pendingFor(ctx: QueryCtx | MutationCtx, token: string): Promise<(Doc<"oauthStates"> & { pending: NonNullable<Doc<"oauthStates">["pending"]> }) | null> {
  if (!token || token.length > 200) return null;
  const confirmHash = await hashToken(token);
  const row = await ctx.db
    .query("oauthStates")
    .withIndex("by_confirmHash", (q) => q.eq("confirmHash", confirmHash))
    .unique();
  return row?.pending ? { ...row, pending: row.pending } : null;
}

/** What a mailbox started from Recruiting settings is for. Connected apps states its own purposes. */
const FROM_RECRUITING: InboxPurpose[] = ["hiring"];

/**
 * The mailbox waiting to be confirmed, for the page Google's answer lands on: its address above all, so
 * the person sees exactly which mailbox they are about to connect. Only for the member who started it;
 * to anyone else it does not exist.
 */
export const pendingConnect = companyQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const row = await pendingFor(ctx, args.token);
    if (!row || ctx.support || ctx.role !== "owner" || row.companyId !== ctx.companyId || row.memberId !== ctx.member._id || row.pending.until <= Date.now()) return null;
    return {
      address: row.pending.address,
      purposes: (row.purposes ?? FROM_RECRUITING).map((p) => PURPOSE_INFO[p].label),
      canSend: row.canSend && row.pending.scopes.includes("https://www.googleapis.com/auth/gmail.send"),
      label: row.folder ?? null,
      readsFrom: row.processFrom,
      until: row.pending.until,
    };
  },
});

/**
 * The signed-in member confirms the mailbox Google answered for. Only the member who started the sign-in,
 * who must still be an active Owner of this company (ownerMutation checks that now, again), can. Anyone
 * else, in any company, is refused and nothing is connected.
 */
export const confirmConnect = ownerMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const row = await pendingFor(ctx, args.token);
    if (!row || row.companyId !== ctx.companyId) throw userError("That Gmail sign-in isn't waiting any more, so nothing was connected. Please start again.");
    if (ctx.support || ctx.role !== "owner" || row.memberId !== ctx.member._id) throw userError("Only the person who started connecting this inbox can finish it. Nothing was connected.");
    if (row.pending.until <= Date.now()) {
      await discardPending(ctx, row);
      return { connected: false as const, address: row.pending.address };
    }
    const refreshToken = await unseal(row.pending.sealedRefreshToken, pendingBinding(row._id));
    if (!refreshToken) throw userError("Connecting Gmail isn’t available right now. Please try again a little later.");
    const connectionId = await recordConnection(ctx, { companyId: row.companyId, memberId: row.memberId, address: row.pending.address, folder: row.folder, sources: row.sources, processFrom: row.processFrom, canSend: row.canSend, scopes: row.pending.scopes, purposes: row.purposes ?? null });
    // Sealed again, this time to the connection it now belongs to.
    const sealed = await seal(refreshToken, connectionId);
    if (!sealed) throw userError("Connecting Gmail isn’t available right now. Please try again a little later.");
    await storeSealed(ctx, { companyId: row.companyId, connectionId, sealedRefreshToken: sealed, scopes: row.pending.scopes });
    await ctx.db.patch(row._id, { pending: undefined, confirmHash: undefined });
    return { connected: true as const, address: row.pending.address };
  },
});

/** "Not this one": the member who started throws the pending mailbox away now rather than in fifteen minutes. */
export const cancelConnect = ownerMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const row = await pendingFor(ctx, args.token);
    if (!row || ctx.support || row.companyId !== ctx.companyId || row.memberId !== ctx.member._id) return null;
    await discardPending(ctx, row);
    return null;
  },
});

/** Nobody confirmed in time. The authorization is deleted and, unless something else uses that Google account, the grant is ended. */
export const expirePending = internalMutation({
  args: { stateId: v.id("oauthStates") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.stateId);
    if (row?.pending) await discardPending(ctx, { ...row, pending: row.pending });
    return null;
  },
});

async function discardPending(ctx: MutationCtx, row: Doc<"oauthStates"> & { pending: NonNullable<Doc<"oauthStates">["pending"]> }): Promise<void> {
  await ctx.db.patch(row._id, { pending: undefined, confirmHash: undefined });
  const address = row.pending.address;
  // Ending the grant ends every token of that Google account for Selestial. If the account is already in
  // use here (in any company: the person who signed in at Google may not be the one who started), it is left alone.
  const inUse =
    (await sharesGoogleGrant(ctx, row.companyId, address)) ||
    (await ctx.db.query("googleConnections").take(5000)).some((connection) => connection.status !== "disconnected" && connection.email.trim().toLowerCase() === address);
  if (!inUse) await ctx.scheduler.runAfter(0, internal.recruiterMailbox.revokePending, { sealed: row.pending.sealedRefreshToken, boundTo: pendingBinding(row._id) });
  await recordEvent(ctx, { companyId: row.companyId, type: "mailbox.connect_abandoned", actor: { kind: "system" }, subject: { table: "companies", id: row.companyId }, data: { provider: "gmail", grantKept: inUse } });
}

export const revokePending = internalAction({
  args: { sealed: v.string(), boundTo: v.string() },
  handler: async (_ctx, args) => {
    const token = await unseal(args.sealed, args.boundTo);
    return token ? revokeToken(token).catch(() => false) : false;
  },
});

/** Records the connection. Reconnecting the same address replaces it and keeps the cursor. Reached only through `confirmConnect`. */
async function recordConnection(
  ctx: MutationCtx,
  args: {
    companyId: Id<"companies">;
    memberId: Id<"members">;
    address: string;
    folder?: string;
    sources: Source[];
    processFrom: number;
    canSend: boolean;
    scopes: string[];
    /** Set when connected from Connected apps. Null: started from Recruiting settings. */
    purposes: InboxPurpose[] | null;
  },
): Promise<Id<"mailboxConnections">> {
  const address = args.address.trim().toLowerCase();
  const existing = (
    await ctx.db
      .query("mailboxConnections")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .take(20)
  ).find((row) => row.provider === "gmail" && row.address === address);
  const fresh = !existing || existing.status === "disconnected";
  // From Recruiting settings, a newly connected inbox is the hiring inbox and nothing else: it does not
  // also become the address Sales and Care mail goes from. An inbox already in use keeps what it is for
  // (including one from before purposes existed, whose meaning does not change), gaining hiring if it lacked it.
  const purposes = args.purposes ?? (fresh ? FROM_RECRUITING : existing.purposes && !existing.purposes.includes("hiring") ? [...existing.purposes, ...FROM_RECRUITING] : null);
  const fields = {
    status: "connected" as const,
    problem: undefined,
    failures: 0,
    folder: args.folder,
    sources: args.sources,
    canSend: args.canSend && args.scopes.includes("https://www.googleapis.com/auth/gmail.send"),
    ...(purposes ? { purposes } : {}),
    disconnectedAt: undefined,
    disconnectedBy: undefined,
    grant: undefined,
  };
  const connectionId = existing
    ? (await ctx.db.patch(existing._id, fields), existing._id)
    : await ctx.db.insert("mailboxConnections", { companyId: args.companyId, provider: "gmail", address, processFrom: args.processFrom, createdBy: args.memberId, createdAt: Date.now(), ...fields });
  const company = await ctx.db.get(args.companyId);
  const row = (await ctx.db.get(connectionId))!;
  // Replies go to the connected inbox unless the Owner already chose another address.
  if (company && !company.recruiter?.replyTo) await ctx.db.patch(company._id, { recruiter: { ...(company.recruiter ?? {}), replyTo: address } });
  await recordEvent(ctx, { companyId: args.companyId, type: "mailbox.connected", actor: { kind: "member", memberId: args.memberId }, subject: { table: "mailboxConnections", id: connectionId }, data: { provider: "gmail", historical: args.processFrom < Date.now() - 60_000, canSend: fields.canSend } });
  // Messages that waited for this inbox go now; the Owner hears about a newly connected inbox.
  await resumeWaiting(ctx, args.companyId);
  if (fresh) {
    const member = await ctx.db.get(args.memberId);
    await notifyMembers(ctx, { companyId: args.companyId, event: "security_change", key: `inbox-connected:${connectionId}:${Date.now()}`, facts: { kind: "inbox_connected", address, purposes: purposesOf(row).map((p) => PURPOSE_INFO[p].label).join(", "), byName: member?.name ?? "Someone in your company", at: Date.now() } });
  }
  return connectionId;
}

async function storeSealed(ctx: MutationCtx, args: { companyId: Id<"companies">; connectionId: Id<"mailboxConnections">; sealedRefreshToken: string; scopes: string[] }): Promise<void> {
  for (const row of await ctx.db
    .query("mailboxCredentials")
    .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
    .take(10)) {
    await ctx.db.delete(row._id);
  }
  await ctx.db.insert("mailboxCredentials", { ...args, createdAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.recruiterInbox.sync, { connectionId: args.connectionId });
  // Push notifications start at once, not at the next daily renewal (it does nothing without a Pub/Sub topic).
  await ctx.scheduler.runAfter(0, internal.recruiterGmailWatch.ensure, { connectionId: args.connectionId });
}

/** The sealed token for a connection, for the inbox run and the sender. Internal only. */
export const credentialFor = internalQuery({
  args: { connectionId: v.id("mailboxConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status === "disconnected") return null;
    const row = await ctx.db
      .query("mailboxCredentials")
      .withIndex("by_connection", (q) => q.eq("connectionId", connection._id))
      .first();
    return row ? { sealedRefreshToken: row.sealedRefreshToken, address: connection.address } : null;
  },
});

/** The mailbox applicant email for this company goes from, if the Owner allowed one. */
export const senderFor = internalQuery({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("mailboxConnections")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .take(20);
    const row = rows.find((connection) => connection.provider === "gmail" && connection.canSend && connection.status === "connected");
    return row ? { connectionId: row._id, address: row.address } : null;
  },
});

/** Sending from the mailbox was refused for lack of authorization. The connection says so and stops sending. */
export const sendRefused = internalMutation({
  args: { connectionId: v.id("mailboxConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    // Disconnected on purpose while a send was in flight: it stays disconnected, with no "reconnect" notice.
    if (!connection || connection.status === "disconnected") return null;
    const wasWorking = connection.status === "connected";
    await ctx.db.patch(connection._id, { status: "expired", problem: "The mailbox's authorization has ended. Reconnect it." });
    await recordEvent(ctx, { companyId: connection.companyId, type: "mailbox.sync_failed", actor: { kind: "system" }, subject: { table: "mailboxConnections", id: connection._id }, data: { kind: "auth", failures: connection.failures + 1 } });
    if (wasWorking) await inboxBroke(ctx, (await ctx.db.get(connection._id))!);
    return null;
  },
});
