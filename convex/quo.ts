/**
 * The company's Quo connection (docs/quo/00-architecture.md): connecting with an API key, checking it, choosing
 * numbers and agents, the Owner's test text and its reply, rotating and disconnecting, and Quo's webhook.
 *
 * Only an Owner manages the connection. The API key and webhook secret are sealed the moment they arrive
 * (lib/recruiter/secrets.ts, bound to the connection) and only internal functions ever unseal them; no query
 * returns them, no log or error carries them, and no model prompt sees them.
 *
 * An accepted key is not proof texting works. "Ready" needs: a selected number, Quo's webhook in place, carrier
 * registration shown by Quo (or confirmed by the Owner where Quo can't show it, labelled as such), and a test
 * text whose reply came back to Selestial.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { companyQuery, ownerMutation } from "./lib/builders";
import { normalAddress } from "./lib/compliance/recipients";
import { addSuppression } from "./lib/compliance/permissions";
import { userError } from "./lib/errors";
import { recordEvent } from "./lib/events";
import { notifyMembers } from "./lib/notify/route";
import { allow } from "./lib/rateLimit";
import { seal, unseal } from "./lib/recruiter/secrets";
import { createWebhook, deleteWebhook, listNumbers, registration as readRegistration, sendMessage, updateWebhook, type QuoFailure, type QuoNumber, QUO_EVENTS } from "./lib/quo/api";
import { QUO_CALL_EVENTS } from "./lib/quality/comms/quoBridge";
import { readinessOf } from "./lib/quo/readiness";
import { ensureConversation, quoConnectionOf } from "./lib/quo/route";
import { QUO_AGENTS, type QuoProblem, type QuoStatus } from "./lib/quo/schema";
import { applyQuoEvent } from "./lib/quo/events";

const MAX_ERRORS = 10;

function hintOf(key: string): string {
  return key.slice(-4);
}

function cleanKey(raw: string): string {
  const key = raw.trim();
  if (key.length < 16 || key.length > 300 || /\s/.test(key)) throw userError("That doesn't look like a Quo API key. Copy it exactly as Quo shows it, with no spaces.");
  return key;
}

/** The status, from the facts. Disconnected stays until the Owner connects again. */
export function statusOf(c: Pick<Doc<"quoConnections">, "status" | "problem" | "selected" | "webhook" | "replyVerifiedAt" | "registration">): QuoStatus {
  if (c.status === "disconnected") return "disconnected";
  if (c.problem?.kind === "key_rejected") return "disconnected";
  if (c.problem && c.problem.kind !== "rate_limited") return "degraded";
  const registered = c.registration.status === "approved" || c.registration.confirmedAt !== undefined;
  return c.selected.length > 0 && c.webhook && c.replyVerifiedAt !== undefined && registered ? "ready" : "setup_incomplete";
}

async function save(ctx: MutationCtx, connection: Doc<"quoConnections">, patch: Partial<Doc<"quoConnections">>) {
  const next = { ...connection, ...patch };
  const status = statusOf(next);
  await ctx.db.patch(connection._id, { ...patch, status, updatedAt: Date.now() });
  if (status !== connection.status) {
    await recordEvent(ctx, { companyId: connection.companyId, type: "quo.status_changed", actor: { kind: "system" }, subject: { table: "companies", id: connection.companyId }, data: { from: connection.status, to: status } });
    // The Owner hears when it stops working, once per kind of problem.
    if ((status === "degraded" || status === "disconnected") && next.problem) {
      await notifyMembers(ctx, { companyId: connection.companyId, event: "quo_attention", ref: connection._id, key: `${next.problem.kind}:${Math.floor(Date.now() / 86_400_000)}`, facts: { kind: next.problem.kind } });
    }
  }
}

function withError(connection: Doc<"quoConnections">, words: string) {
  return [...connection.errors, { at: Date.now(), words }].slice(-MAX_ERRORS);
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────────

/** The connection as every member may see it: status, numbers, agents, readiness. Never a secret. */
export const connection = companyQuery({
  args: {},
  handler: async (ctx) => {
    const c = await quoConnectionOf(ctx, ctx.companyId);
    const readiness = await readinessOf(ctx, ctx.company, c);
    if (!c) return { state: "not_connected" as const, readiness, canManage: ctx.role === "owner" };
    return {
      state: c.status,
      canManage: ctx.role === "owner",
      keyHint: `…${c.keyHint}`,
      keySetAt: c.keySetAt,
      checkedAt: c.checkedAt ?? null,
      available: c.available,
      selected: c.selected,
      useForNew: c.useForNew,
      registration: { status: c.registration.status, checkedAt: c.registration.checkedAt ?? null, confirmedByOwner: c.registration.confirmedAt !== undefined },
      webhook: c.webhook ? { since: c.webhook.createdAt, lastEventAt: c.webhook.lastEventAt ?? null } : null,
      test: c.test ? { to: c.test.to, sentAt: c.test.sentAt, sent: c.test.providerMessageId !== undefined, problem: c.test.problem ?? null, replyAt: c.test.replyAt ?? null } : null,
      replyVerifiedAt: c.replyVerifiedAt ?? null,
      agents: c.agents,
      problem: c.problem ?? null,
      errors: c.errors.slice(-5).reverse(),
      disconnectedAt: c.disconnectedAt ?? null,
      readiness,
    };
  },
});

// ── Connecting, rotating, disconnecting ──────────────────────────────────────────────────────────────

/** The Owner pastes a dedicated Quo API key. It is sealed at once and checked in the background. */
export const connect = ownerMutation({
  args: { apiKey: v.string() },
  handler: async (ctx, args) => {
    const key = cleanKey(args.apiKey);
    const existing = await quoConnectionOf(ctx, ctx.companyId);
    if (existing && existing.status !== "disconnected") throw userError("Quo is already connected. To use a different key, replace it from the connection's settings.");
    const now = Date.now();
    let id: Id<"quoConnections">;
    if (existing) {
      // Reconnecting keeps the Owner's choices, but proves the reply route again before agents text.
      id = existing._id;
      await ctx.db.patch(id, { status: "setup_incomplete", keyHint: hintOf(key), keySetAt: now, keySetBy: ctx.member._id, problem: undefined, disconnectedAt: undefined, disconnectedBy: undefined, replyVerifiedAt: undefined, test: undefined, webhook: undefined, updatedAt: now });
    } else {
      id = await ctx.db.insert("quoConnections", {
        companyId: ctx.companyId,
        status: "setup_incomplete",
        keyHint: hintOf(key),
        keySetAt: now,
        keySetBy: ctx.member._id,
        available: [],
        selected: [],
        useForNew: false,
        registration: { status: "unknown" },
        agents: [],
        errors: [],
        updatedAt: now,
      });
    }
    const sealed = await seal(key, id);
    if (!sealed) throw userError("Selestial can't store keys safely on this backend yet, so nothing was saved.");
    const secret = await ctx.db
      .query("quoSecrets")
      .withIndex("by_connection", (q) => q.eq("connectionId", id))
      .first();
    if (secret) await ctx.db.patch(secret._id, { sealedKey: sealed, sealedWebhookSecret: undefined, updatedAt: now });
    else await ctx.db.insert("quoSecrets", { connectionId: id, sealedKey: sealed, updatedAt: now });
    await recordEvent(ctx, { companyId: ctx.companyId, type: existing ? "quo.reconnected" : "quo.connected", actor: { kind: "member", memberId: ctx.member._id }, subject: { table: "companies", id: ctx.companyId }, data: { keyHint: hintOf(key) } });
    await ctx.scheduler.runAfter(0, internal.quo.check, { connectionId: id });
    return null;
  },
});

/** A new key for the same Quo workspace. It replaces the old one only once Quo accepts it and shows Selestial's webhook. */
export const rotateKey = ownerMutation({
  args: { apiKey: v.string() },
  handler: async (ctx, args) => {
    const key = cleanKey(args.apiKey);
    const c = await quoConnectionOf(ctx, ctx.companyId);
    if (!c || c.status === "disconnected") throw userError("Connect Quo first.");
    const sealed = await seal(key, `${c._id}:pending`);
    if (!sealed) throw userError("Selestial can't store keys safely on this backend yet, so nothing was saved.");
    await ctx.scheduler.runAfter(0, internal.quo.checkRotation, { connectionId: c._id, sealedPending: sealed, hint: hintOf(key), memberId: ctx.member._id });
    return null;
  },
});

/**
 * Disconnecting stops every send through Quo at once. History and conversations are kept; texts waiting to go are
 * not sent later (they would be stale). Quo's webhook is removed where Quo allows, then the key is forgotten.
 */
export const disconnect = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const c = await quoConnectionOf(ctx, ctx.companyId);
    if (!c || c.status === "disconnected") return { affected: [] as string[] };
    await ctx.db.patch(c._id, { status: "disconnected", disconnectedAt: Date.now(), disconnectedBy: ctx.member._id, useForNew: false, updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quo.disconnected", actor: { kind: "member", memberId: ctx.member._id }, subject: { table: "companies", id: ctx.companyId }, data: { agents: c.agents.join(",") } });
    await notifyMembers(ctx, { companyId: ctx.companyId, event: "quo_attention", ref: c._id, key: `disconnected:${Date.now()}`, facts: { kind: "disconnected" }, except: [ctx.member._id] });
    await ctx.scheduler.runAfter(0, internal.quo.cleanup, { connectionId: c._id });
    return { affected: c.agents.map((agent) => agent) };
  },
});

// ── Choices ──────────────────────────────────────────────────────────────────────────────────────────

export const selectNumbers = ownerMutation({
  args: { numberIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const c = await quoConnectionOf(ctx, ctx.companyId);
    if (!c || c.status === "disconnected") throw userError("Connect Quo first.");
    const ids = [...new Set(args.numberIds)];
    const selected = ids.map((id) => c.available.find((row) => row.id === id));
    if (selected.some((row) => !row)) throw userError("Choose from the numbers Quo shows for this key.");
    // Another company already texting from one of these numbers would be ambiguous for replies: refused.
    const others = await ctx.db.query("quoConnections").take(5000);
    for (const row of selected as QuoNumber[]) {
      if (others.some((other) => other._id !== c._id && other.status !== "disconnected" && other.selected.some((n) => n.phoneNumber === row.phoneNumber))) throw userError(`${row.phoneNumber} is already connected to another company in Selestial.`);
    }
    await save(ctx, c, { selected: selected as QuoNumber[] });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quo.numbers_selected", actor: { kind: "member", memberId: ctx.member._id }, subject: { table: "companies", id: ctx.companyId }, data: { count: ids.length } });
    if (ids.length > 0) await ctx.scheduler.runAfter(0, internal.quo.syncWebhook, { connectionId: c._id });
    return null;
  },
});

export const setAgents = ownerMutation({
  args: { agents: v.array(v.union(...QUO_AGENTS.map((agent) => v.literal(agent)))) },
  handler: async (ctx, args) => {
    const c = await quoConnectionOf(ctx, ctx.companyId);
    if (!c || c.status === "disconnected") throw userError("Connect Quo first.");
    await save(ctx, c, { agents: [...new Set(args.agents)] });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quo.agents_changed", actor: { kind: "member", memberId: ctx.member._id }, subject: { table: "companies", id: ctx.companyId }, data: { agents: args.agents.join(",") } });
    return null;
  },
});

/**
 * Whether new conversations use Quo. Turning it on first pins every conversation the company already has on its own
 * Selestial number to that number, so nobody is moved without a person deciding.
 */
export const setUseForNew = ownerMutation({
  args: { use: v.boolean() },
  handler: async (ctx, args) => {
    const c = await quoConnectionOf(ctx, ctx.companyId);
    if (!c || c.status === "disconnected") throw userError("Connect Quo first.");
    if (args.use && c.selected.length === 0) throw userError("Choose at least one Quo number first.");
    let pinned = 0;
    if (args.use) {
      const profile = await ctx.db
        .query("complianceProfiles")
        .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
        .first();
      const own = profile?.messaging.smsNumber;
      if (own) {
        const sent = await ctx.db
          .query("messages")
          .withIndex("by_company_queued", (q) => q.eq("companyId", ctx.companyId))
          .order("desc")
          .take(5000);
        for (const message of sent) {
          if ((message.channel ?? "sms") !== "sms" || !message.to || message.provider === "quo") continue;
          const before = await ctx.db
            .query("smsConversations")
            .withIndex("by_company_address", (q) => q.eq("companyId", ctx.companyId).eq("address", message.to!))
            .first();
          if (before) continue;
          await ensureConversation(ctx, ctx.companyId, message.to, { provider: "native", sender: own });
          pinned += 1;
        }
      }
    }
    await save(ctx, c, { useForNew: args.use });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quo.default_changed", actor: { kind: "member", memberId: ctx.member._id }, subject: { table: "companies", id: ctx.companyId }, data: { use: args.use, pinned } });
    return { pinned };
  },
});

/**
 * Quo shows carrier registration for the workspace when there is one. Where it can't (none on file, as with a toll-free
 * number, or no answer), the Owner may confirm it themselves; the screens say it was confirmed by the Owner, not by Quo.
 */
export const confirmRegistration = ownerMutation({
  args: { confirm: v.literal(true) },
  handler: async (ctx) => {
    const c = await quoConnectionOf(ctx, ctx.companyId);
    if (!c || c.status === "disconnected") throw userError("Connect Quo first.");
    if (c.registration.status === "pending" || c.registration.status === "rejected" || c.registration.status === "failed") throw userError(`Quo shows the registration as ${c.registration.status}. It can't be confirmed over that.`);
    await save(ctx, c, { registration: { ...c.registration, confirmedBy: ctx.member._id, confirmedAt: Date.now() } });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quo.registration_confirmed_by_owner", actor: { kind: "member", memberId: ctx.member._id }, subject: { table: "companies", id: ctx.companyId } });
    return null;
  },
});

/** Check the key, numbers and registration again; clears a problem a check shows is gone. */
export const recheck = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const c = await quoConnectionOf(ctx, ctx.companyId);
    if (!c || c.status === "disconnected") throw userError("Connect Quo first.");
    if (!(await allow(ctx, `quo-recheck:${c._id}`, 10, 60 * 60_000))) throw userError("Checked many times in the last hour. Try again later.");
    await ctx.scheduler.runAfter(0, internal.quo.check, { connectionId: c._id, clear: true });
    return null;
  },
});

/**
 * The Owner's explicit test: one text from a selected number to a number they control. Its reply, arriving through
 * Quo's webhook, proves replies reach Selestial; until then agents don't text through Quo.
 */
export const sendTest = ownerMutation({
  args: { to: v.string(), fromNumberId: v.string(), ownNumber: v.literal(true) },
  handler: async (ctx, args) => {
    const c = await quoConnectionOf(ctx, ctx.companyId);
    if (!c || c.status === "disconnected") throw userError("Connect Quo first.");
    if (!c.selected.some((row) => row.id === args.fromNumberId)) throw userError("Send the test from one of the numbers you chose.");
    if (!c.webhook) throw userError("Selestial is still setting up Quo's delivery of replies. Try again in a moment.");
    const to = normalAddress("sms", args.to);
    if (!to) throw userError("Enter a US mobile number, like (512) 555-0142.");
    if (c.selected.some((row) => row.phoneNumber === to)) throw userError("Use your own mobile, not one of the Quo numbers.");
    if (!(await allow(ctx, `quo-test:${c._id}`, 5, 60 * 60_000))) throw userError("Five tests in an hour is the limit. Try again later.");
    await save(ctx, c, { test: { to, fromNumberId: args.fromNumberId, sentAt: Date.now() }, replyVerifiedAt: undefined });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quo.test_requested", actor: { kind: "member", memberId: ctx.member._id }, subject: { table: "companies", id: ctx.companyId } });
    await ctx.scheduler.runAfter(0, internal.quo.sendTestText, { connectionId: c._id });
    return null;
  },
});

// ── Internal: secrets, checks, webhook, test ────────────────────────────────────────────────────────

/** The sealed key, for internal actions only. */
export const sealedFor = internalQuery({
  args: { connectionId: v.id("quoConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    const secret = await ctx.db
      .query("quoSecrets")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .first();
    return connection && secret ? { connection, sealedKey: secret.sealedKey, sealedWebhookSecret: secret.sealedWebhookSecret ?? null } : null;
  },
});

export async function keyFor(ctx: { runQuery: (ref: typeof internal.quo.sealedFor, args: { connectionId: Id<"quoConnections"> }) => Promise<{ connection: Doc<"quoConnections">; sealedKey: string; sealedWebhookSecret: string | null } | null> }, connectionId: Id<"quoConnections">) {
  const row = await ctx.runQuery(internal.quo.sealedFor, { connectionId });
  if (!row) return null;
  const key = await unseal(row.sealedKey, connectionId);
  return key ? { connection: row.connection, key } : null;
}

export const check = internalAction({
  args: { connectionId: v.id("quoConnections"), clear: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const found = await keyFor(ctx, args.connectionId);
    if (!found) return null;
    const numbers = await listNumbers(fetch, found.key);
    if (!numbers.ok) {
      await ctx.runMutation(internal.quo.recordProblem, { connectionId: args.connectionId, failure: failureOf(numbers) });
      return null;
    }
    const reg = await readRegistration(fetch, found.key);
    await ctx.runMutation(internal.quo.recordCheck, { connectionId: args.connectionId, available: numbers.data, registration: reg.ok ? reg.data.status : "unknown", clear: args.clear ?? false });
    if (found.connection.selected.length > 0) await ctx.runAction(internal.quo.syncWebhook, { connectionId: args.connectionId });
    return null;
  },
});

function failureOf(f: { kind: QuoFailure["kind"]; words: string }) {
  return { kind: f.kind, words: f.words };
}

const PROBLEM_KINDS: Record<string, QuoProblem | null> = {
  key_rejected: "key_rejected",
  no_credits: "no_credits",
  subscription_expired: "subscription_expired",
  registration: "registration",
  rate_limited: "rate_limited",
  outage: "outage",
  uncertain: "outage",
  daily_cap: "registration",
};

export const recordCheck = internalMutation({
  args: { connectionId: v.id("quoConnections"), available: v.array(v.object({ id: v.string(), phoneNumber: v.string(), name: v.optional(v.string()), usMessaging: v.optional(v.union(v.literal("restricted"), v.literal("unrestricted"))) })), registration: v.string(), clear: v.boolean() },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.connectionId);
    if (!c || c.status === "disconnected") return null;
    // A number no longer on the key stays selected, but its conversations are reported blocked (never re-routed).
    const gone = c.selected.filter((row) => !args.available.some((n) => n.id === row.id));
    const status = (["approved", "pending", "rejected", "failed", "none"] as const).find((s) => s === args.registration) ?? "unknown";
    const problem = gone.length > 0 ? { kind: "number_removed" as const, words: `Quo no longer shows ${gone.map((row) => row.phoneNumber).join(", ")} for this key.`, at: Date.now() } : args.clear || c.problem?.kind === "key_rejected" ? undefined : c.problem;
    await save(ctx, c, { available: args.available, checkedAt: Date.now(), registration: { ...c.registration, status, checkedAt: Date.now() }, problem });
    return null;
  },
});

export const recordProblem = internalMutation({
  args: { connectionId: v.id("quoConnections"), failure: v.object({ kind: v.string(), words: v.string() }) },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.connectionId);
    if (!c || c.status === "disconnected") return null;
    const kind = PROBLEM_KINDS[args.failure.kind] ?? null;
    // A single slow answer isn't an outage; three in ten minutes is.
    const recentOutages = c.errors.filter((row) => row.at > Date.now() - 10 * 60_000 && /didn't answer|problem on its side/.test(row.words)).length;
    const keep = kind === "outage" && recentOutages < 2 ? c.problem : kind && kind !== "rate_limited" ? { kind, words: args.failure.words, at: Date.now() } : c.problem;
    await save(ctx, c, { problem: keep, errors: withError(c, args.failure.words) });
    return null;
  },
});

/** Quo's webhook for the selected numbers: created once, kept in step with the selection. */
export const syncWebhook = internalAction({
  args: { connectionId: v.id("quoConnections") },
  handler: async (ctx, args) => {
    const found = await keyFor(ctx, args.connectionId);
    if (!found || found.connection.status === "disconnected") return null;
    const ids = found.connection.selected.map((row) => row.id);
    if (ids.length === 0) return null;
    // Call events only while Quality reads calls through this connection (convex/qualityComms.ts).
    const events = (await ctx.runQuery(internal.qualityComms.readsCalls, { quoConnectionId: args.connectionId })) ? [...QUO_EVENTS, ...QUO_CALL_EVENTS] : [...QUO_EVENTS];
    if (found.connection.webhook) {
      const answer = await updateWebhook(fetch, found.key, found.connection.webhook.id, ids, events);
      if (!answer.ok && answer.kind !== "not_found") await ctx.runMutation(internal.quo.recordProblem, { connectionId: args.connectionId, failure: { kind: answer.kind === "key_rejected" ? answer.kind : "webhook", words: `Selestial couldn't update Quo's webhook: ${answer.words}` } });
      if (answer.ok || answer.kind !== "not_found") return null;
      // Deleted in Quo: made again below.
    }
    const site = process.env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
    if (!site) return null;
    const created = await createWebhook(fetch, found.key, { url: `${site}/webhooks/quo/${args.connectionId}`, numberIds: ids, events });
    if (!created.ok) {
      await ctx.runMutation(internal.quo.recordProblem, { connectionId: args.connectionId, failure: { kind: created.kind === "key_rejected" ? created.kind : "webhook", words: `Selestial couldn't set up Quo's webhook: ${created.words}` } });
      return null;
    }
    const sealed = await seal(created.data.key, args.connectionId);
    if (!sealed) return null;
    await ctx.runMutation(internal.quo.recordWebhook, { connectionId: args.connectionId, id: created.data.id, events: created.data.events ?? [], sealedSecret: sealed });
    return null;
  },
});

export const recordWebhook = internalMutation({
  args: { connectionId: v.id("quoConnections"), id: v.string(), events: v.array(v.string()), sealedSecret: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.connectionId);
    if (!c) return null;
    const secret = await ctx.db
      .query("quoSecrets")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .first();
    if (secret) await ctx.db.patch(secret._id, { sealedWebhookSecret: args.sealedSecret, updatedAt: Date.now() });
    await save(ctx, c, { webhook: { id: args.id, createdAt: Date.now(), events: args.events }, problem: c.problem?.kind === "webhook" ? undefined : c.problem });
    return null;
  },
});

export const sendTestText = internalAction({
  args: { connectionId: v.id("quoConnections") },
  handler: async (ctx, args) => {
    const found = await keyFor(ctx, args.connectionId);
    const test = found?.connection.test;
    if (!found || !test) return null;
    const company = await ctx.runQuery(internal.quo.companyName, { connectionId: args.connectionId });
    const sent = await sendMessage(fetch, found.key, { fromNumberId: test.fromNumberId, to: test.to, text: `Selestial test for ${company}: reply to this text with anything to confirm replies reach Selestial. No other texts go out through Quo until setup is finished.` });
    await ctx.runMutation(internal.quo.recordTest, { connectionId: args.connectionId, providerMessageId: sent.ok ? sent.data.id : undefined, problem: sent.ok ? undefined : sent.words, failureKind: sent.ok ? undefined : sent.kind });
    return null;
  },
});

export const companyName = internalQuery({
  args: { connectionId: v.id("quoConnections") },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.connectionId);
    const company = c ? await ctx.db.get(c.companyId) : null;
    return company?.name ?? "your company";
  },
});

export const recordTest = internalMutation({
  args: { connectionId: v.id("quoConnections"), providerMessageId: v.optional(v.string()), problem: v.optional(v.string()), failureKind: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.connectionId);
    if (!c?.test) return null;
    const problem = args.failureKind ? PROBLEM_KINDS[args.failureKind] : null;
    await save(ctx, c, {
      test: { ...c.test, providerMessageId: args.providerMessageId, problem: args.problem },
      lastSendAt: args.providerMessageId ? Date.now() : c.lastSendAt,
      ...(args.problem ? { errors: withError(c, `Test text: ${args.problem}`) } : {}),
      ...(problem && problem !== "rate_limited" && problem !== "outage" ? { problem: { kind: problem, words: args.problem ?? "", at: Date.now() } } : {}),
    });
    return null;
  },
});

export const checkRotation = internalAction({
  args: { connectionId: v.id("quoConnections"), sealedPending: v.string(), hint: v.string(), memberId: v.id("members") },
  handler: async (ctx, args) => {
    const key = await unseal(args.sealedPending, `${args.connectionId}:pending`);
    const current = await ctx.runQuery(internal.quo.sealedFor, { connectionId: args.connectionId });
    if (!key || !current) return null;
    const numbers = await listNumbers(fetch, key);
    // The same workspace: the new key sees every number Selestial texts from.
    const same = numbers.ok && current.connection.selected.every((row) => numbers.data.some((n) => n.id === row.id));
    const sealed = same ? await seal(key, args.connectionId) : null;
    await ctx.runMutation(internal.quo.finishRotation, { connectionId: args.connectionId, sealedKey: sealed ?? undefined, hint: args.hint, memberId: args.memberId, words: !numbers.ok ? numbers.words : same ? undefined : "The new key doesn't see the numbers Selestial texts from, so it looks like a different Quo workspace. The old key is still in use." });
    return null;
  },
});

export const finishRotation = internalMutation({
  args: { connectionId: v.id("quoConnections"), sealedKey: v.optional(v.string()), hint: v.string(), memberId: v.id("members"), words: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.connectionId);
    if (!c || c.status === "disconnected") return null;
    if (!args.sealedKey) {
      await save(ctx, c, { errors: withError(c, `Key not replaced: ${args.words ?? "Quo refused it."}`) });
      return null;
    }
    const secret = await ctx.db
      .query("quoSecrets")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .first();
    if (secret) await ctx.db.patch(secret._id, { sealedKey: args.sealedKey, updatedAt: Date.now() });
    await save(ctx, c, { keyHint: args.hint, keySetAt: Date.now(), keySetBy: args.memberId, problem: c.problem?.kind === "key_rejected" ? undefined : c.problem });
    await recordEvent(ctx, { companyId: c.companyId, type: "quo.key_rotated", actor: { kind: "member", memberId: args.memberId }, subject: { table: "companies", id: c.companyId }, data: { keyHint: args.hint } });
    return null;
  },
});

/** After disconnecting: remove Selestial's webhook from Quo where possible, then forget the secrets. */
export const cleanup = internalAction({
  args: { connectionId: v.id("quoConnections") },
  handler: async (ctx, args) => {
    const found = await keyFor(ctx, args.connectionId);
    let removed = false;
    if (found?.connection.webhook) removed = (await deleteWebhook(fetch, found.key, found.connection.webhook.id)).ok;
    await ctx.runMutation(internal.quo.forget, { connectionId: args.connectionId, webhookRemoved: removed });
    return null;
  },
});

export const forget = internalMutation({
  args: { connectionId: v.id("quoConnections"), webhookRemoved: v.boolean() },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.connectionId);
    if (!c || c.status !== "disconnected") return null;
    const secret = await ctx.db
      .query("quoSecrets")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .first();
    if (secret) await ctx.db.delete(secret._id);
    await ctx.db.patch(c._id, { webhook: undefined, errors: args.webhookRemoved || !c.webhook ? c.errors : withError(c, "Selestial couldn't remove its webhook from Quo. Delete the one labelled \"Selestial\" in Quo's Settings › API › Webhooks."), updatedAt: Date.now() });
    return null;
  },
});

// ── Webhook events ──────────────────────────────────────────────────────────────────────────────────

/** One signed event from Quo, handled once (deduped on Quo's webhook id). Fails as a whole, so Quo retries it. */
export const ingest = internalMutation({
  args: { connectionId: v.id("quoConnections"), eventId: v.string(), event: v.string() },
  handler: async (ctx, args) => {
    const seen = await ctx.db
      .query("providerReceipts")
      .withIndex("by_provider_event", (q) => q.eq("provider", "quo").eq("eventId", args.eventId))
      .first();
    if (seen) return "duplicate";
    await ctx.db.insert("providerReceipts", { provider: "quo", eventId: args.eventId, receivedAt: Date.now() });
    const c = await ctx.db.get(args.connectionId);
    if (!c) return "unknown_connection";
    return applyQuoEvent(ctx, c, args.eventId, JSON.parse(args.event));
  },
});

/** A failure Quo reported while sending: the connection's problem, and a provider opt-out kept as Selestial's own suppression. */
export const sendFailed = internalMutation({
  args: { connectionId: v.id("quoConnections"), kind: v.string(), words: v.string(), to: v.string() },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.connectionId);
    if (!c) return null;
    if (args.kind === "opted_out") {
      const address = normalAddress("sms", args.to);
      if (address) await addSuppression(ctx, { companyId: c.companyId, channel: "sms", address, scope: "all", reason: "stop_keyword", note: "Quo reported this number as opted out.", at: Date.now(), actor: { kind: "system" } });
      return null;
    }
    const kind = PROBLEM_KINDS[args.kind];
    if (!kind) return null;
    const recentOutages = c.errors.filter((row) => row.at > Date.now() - 10 * 60_000 && /problem on its side|didn't answer/.test(row.words)).length;
    const problem = kind === "rate_limited" || (kind === "outage" && recentOutages < 2) ? c.problem : { kind, words: args.words, at: Date.now() };
    await save(ctx, c, { problem, errors: withError(c, args.words) });
    return null;
  },
});

/** After Quo accepted a text: the conversation learns Quo's id for it, and the connection when it last sent. */
export const afterSend = internalMutation({
  args: { messageId: v.id("messages"), providerConversationId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message?.to) return null;
    const conversation = await ctx.db
      .query("smsConversations")
      .withIndex("by_company_address", (q) => q.eq("companyId", message.companyId).eq("address", message.to!))
      .first();
    if (conversation) await ctx.db.patch(conversation._id, { lastOutboundAt: Date.now(), ...(args.providerConversationId && !conversation.providerConversationId ? { providerConversationId: args.providerConversationId } : {}) });
    const c = conversation?.connectionId ? await ctx.db.get(conversation.connectionId) : null;
    if (c) await ctx.db.patch(c._id, { lastSendAt: Date.now() });
    return null;
  },
});

/** The status again from the facts, after something outside `save` changed them (the test reply). */
export const refreshStatus = internalMutation({
  args: { connectionId: v.id("quoConnections") },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.connectionId);
    if (c) await save(ctx, c, {});
    return null;
  },
});
