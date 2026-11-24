/**
 * Selestial's own texts (docs/sms/00-architecture.md §4.6): sign-in codes Clerk asks Selestial to deliver,
 * notices to the people who use Selestial, and alerts to Selestial staff. Never a company's text, never
 * charged to a company, never sent from a company's number (convex/lib/platform/*).
 *
 *   codeRequested   Clerk's sms.created arrived: dedupe, check the code sender and the limits, record it
 *   queueNotice     a notice or alert to one number, sent from the notice sender
 *   deliverNotice   sends a queued notice once, settles it (a timeout is left unconfirmed, never resent)
 *   settle          what Telnyx answered
 *   answerNoReply   someone texted a Selestial number: at most one "this number takes no replies" a day
 *
 * Sign-in codes don't depend on any company's balance, registration, agents or queues: they have their
 * own sender, their own lane, and Selestial pays for them.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type ActionCtx, type MutationCtx } from "./_generated/server";
import { countSegments } from "./lib/messagingBilling/segments";
import { codeRefusal, phoneKey, REFUSAL_WORDS } from "./lib/platform/guard";
import { NO_REPLY_ANSWER, platformSender, type SenderConfig } from "./lib/platform/senders";
import { platformKindValidator, type PlatformSender } from "./lib/platform/schema";
import { messagingProvider } from "./lib/messaging/provider";
import { allow } from "./lib/rateLimit";

const DAY = 24 * 60 * 60 * 1000;
const NOTICE_ATTEMPTS = 3;

const resultValidator = v.union(
  v.object({ ok: v.literal(true), providerMessageId: v.string(), delivered: v.boolean(), parts: v.optional(v.number()), replayed: v.optional(v.boolean()) }),
  v.object({ ok: v.literal(false), retryable: v.boolean(), problem: v.string(), uncertain: v.optional(v.boolean()), providerBlock: v.optional(v.boolean()) }),
);
type SendResult = typeof resultValidator.type;

const last4 = (phone: string) => phone.replace(/\D/g, "").slice(-4);

/** Clerk asked for an SMS (a sign-in or verification code). Decides whether Selestial texts it now. */
export const codeRequested = internalMutation({
  args: { deliveryId: v.string(), to: v.string(), userId: v.optional(v.string()), reason: v.string(), segments: v.number() },
  handler: async (ctx, args): Promise<{ decision: "duplicate" } | { decision: "refused"; id: Id<"platformMessages">; refusal: string } | { decision: "send"; id: Id<"platformMessages">; sender: SenderConfig }> => {
    const dedupeKey = `clerk:${args.deliveryId}`;
    const seen = await ctx.db
      .query("platformMessages")
      .withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey))
      .first();
    if (seen) return { decision: "duplicate" };
    const now = Date.now();
    const toKey = await phoneKey(args.to);
    const sender = platformSender("codes");
    const refusal = sender ? await codeRefusal(ctx, { to: args.to, toKey, userId: args.userId }) : "sender_not_ready";
    const id = await ctx.db.insert("platformMessages", {
      kind: "auth_code",
      sender: "codes",
      reason: args.reason.slice(0, 80),
      dedupeKey,
      ...(args.userId ? { userId: args.userId } : {}),
      toKey,
      toLast4: last4(args.to),
      segments: args.segments,
      status: refusal ? "not_sent" : "queued",
      ...(refusal ? { refusal, problem: refusal === "sender_not_ready" ? "Selestial's code sender isn't set up, so Clerk should still be delivering codes itself." : REFUSAL_WORDS[refusal] } : {}),
      attempts: 0,
      queuedAt: now,
    });
    if (refusal || !sender) return { decision: "refused", id, refusal: refusal ?? "sender_not_ready" };
    return { decision: "send", id, sender };
  },
});

/** A notice or alert to one person's verified number, from the notice sender. One per key. */
export const queueNotice = internalMutation({
  args: { kind: platformKindValidator, reason: v.string(), dedupeKey: v.string(), to: v.string(), body: v.string(), userId: v.optional(v.string()), staffId: v.optional(v.id("staff")), transient: v.optional(v.boolean()) },
  handler: async (ctx, args) => queueNoticeIn(ctx, args),
});

/**
 * `transient`: the words carry a code. They are not stored on the record; they travel only in the scheduled
 * call that sends them, and a send that fails is not tried again (the person asks for a new code).
 */
export async function queueNoticeIn(ctx: MutationCtx, args: { kind: Doc<"platformMessages">["kind"]; reason: string; dedupeKey: string; to: string; body: string; userId?: string; staffId?: Id<"staff">; transient?: boolean; sender?: PlatformSender; notBefore?: number }): Promise<Id<"platformMessages">> {
  if (args.kind === "auth_code") throw new Error("Sign-in codes come only from Clerk (codeRequested).");
  const existing = await ctx.db
    .query("platformMessages")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", args.dedupeKey))
    .first();
  if (existing) return existing._id;
  // Codes a person asked for (confirming their phone) go from the code sender, everything else from the notice sender.
  const which: PlatformSender = args.sender ?? "notices";
  const sender = platformSender(which);
  const id = await ctx.db.insert("platformMessages", {
    kind: args.kind,
    sender: which,
    reason: args.reason.slice(0, 80),
    dedupeKey: args.dedupeKey,
    ...(args.userId ? { userId: args.userId } : {}),
    ...(args.staffId ? { staffId: args.staffId } : {}),
    toKey: await phoneKey(args.to),
    toLast4: last4(args.to),
    to: args.to,
    ...(args.transient ? {} : { body: args.body.slice(0, 1600) }),
    segments: countSegments(args.body).segments,
    status: sender ? "queued" : "not_sent",
    ...(sender ? {} : { refusal: "sender_not_ready", problem: `Selestial's ${which === "codes" ? "code" : "notice"} sender isn't set up.` }),
    attempts: 0,
    queuedAt: Date.now(),
  });
  // A notice that should wait (a person's quiet hours) is sent at that time; nothing else holds it.
  if (sender) await ctx.scheduler.runAfter(Math.max(0, (args.notBefore ?? 0) - Date.now()), internal.platformSms.deliverNotice, { id, ...(args.transient ? { body: args.body.slice(0, 1600) } : {}) });
  return id;
}

export const claimNotice = internalMutation({
  args: { id: v.id("platformMessages"), body: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    const body = row?.body ?? args.body;
    if (!row || row.status !== "queued" || !row.to || !body) return null;
    const sender = platformSender(row.sender as PlatformSender);
    if (!sender) {
      await ctx.db.patch(row._id, { status: "not_sent", refusal: "sender_not_ready", problem: "Selestial's notice sender isn't set up.", to: undefined });
      return null;
    }
    await ctx.db.patch(row._id, { status: "sending", attempts: row.attempts + 1 });
    return { to: row.to, body, sender, attempt: row.attempts + 1 };
  },
});

export const deliverNotice = internalAction({
  args: { id: v.id("platformMessages"), body: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const claimed = await ctx.runMutation(internal.platformSms.claimNotice, { id: args.id, ...(args.body ? { body: args.body } : {}) });
    if (!claimed) return null;
    await sendPlatformText(ctx, { id: args.id, to: claimed.to, body: claimed.body, sender: claimed.sender, attempt: claimed.attempt });
    return null;
  },
});

/**
 * Sends one platform text through the configured provider. Called with a code's words straight from the
 * webhook, so they are never stored. A send that throws or times out may have gone: it is left
 * unconfirmed, never sent again by itself.
 */
export async function sendPlatformText(ctx: ActionCtx, input: { id: Id<"platformMessages">; to: string; body: string; sender: SenderConfig; attempt?: number }) {
  const provider = messagingProvider();
  let result: SendResult;
  if (!provider) result = { ok: false, retryable: false, problem: "Text messaging is not connected on this backend." };
  else {
    try {
      result = await provider.send({ to: input.to, from: input.sender.from, messagingProfileId: input.sender.messagingProfileId, body: input.body, idempotencyKey: `platform-${input.id}`, attempt: input.attempt ?? 1 });
    } catch {
      result = { ok: false, retryable: false, uncertain: true, problem: "The provider didn't answer, so it isn't known whether the text went. It was not sent again." };
    }
  }
  await ctx.runMutation(internal.platformSms.settle, { id: input.id, result, provider: provider?.name ?? "none" });
}

export const settle = internalMutation({
  args: { id: v.id("platformMessages"), result: resultValidator, provider: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || (row.status !== "queued" && row.status !== "sending")) return null;
    const now = Date.now();
    const result = args.result;
    if (result.ok) {
      await ctx.db.patch(row._id, { status: result.delivered ? "delivered" : "sent", provider: args.provider, providerMessageId: result.providerMessageId, sentAt: now, ...(result.delivered ? { deliveredAt: now } : {}), ...(result.parts ? { segments: result.parts } : {}), to: undefined, problem: undefined });
      return null;
    }
    if (result.uncertain) {
      await ctx.db.patch(row._id, { status: "unconfirmed", provider: args.provider, problem: result.problem, to: undefined });
      return null;
    }
    // A notice may be tried again for Telnyx's own trouble; a sign-in code never is (the person asks for a new one).
    if (result.retryable && row.kind !== "auth_code" && row.body !== undefined && row.attempts < NOTICE_ATTEMPTS) {
      await ctx.db.patch(row._id, { status: "queued", problem: result.problem });
      await ctx.scheduler.runAfter(row.attempts * 30_000, internal.platformSms.deliverNotice, { id: row._id });
      return null;
    }
    await ctx.db.patch(row._id, { status: result.providerBlock ? "not_sent" : "failed", ...(result.providerBlock ? { refusal: "provider_block" } : { failedAt: now }), provider: args.provider, problem: result.problem, to: undefined });
    return null;
  },
});

/**
 * A delivery report for one of Selestial's own texts. Answers false when the provider id isn't one of
 * them, so the company outbox can look (convex/messaging.ts applyReceipt).
 */
export async function applyPlatformReceipt(ctx: MutationCtx, args: { provider: string; providerMessageId: string; outcome: string; providerCost?: number }): Promise<boolean> {
  const row = await ctx.db
    .query("platformMessages")
    .withIndex("by_provider_message", (q) => q.eq("provider", args.provider).eq("providerMessageId", args.providerMessageId))
    .first();
  if (!row) return false;
  const now = Date.now();
  const cost = args.providerCost !== undefined ? { providerCost: args.providerCost } : {};
  if (row.status !== "sent" && row.status !== "unconfirmed") {
    if (args.providerCost !== undefined) await ctx.db.patch(row._id, cost);
    return true;
  }
  if (args.outcome === "delivered") await ctx.db.patch(row._id, { status: "delivered", deliveredAt: now, ...cost });
  else if (args.outcome === "unconfirmed") await ctx.db.patch(row._id, { status: "sent", deliveryUnconfirmedAt: now, ...cost });
  else if (args.outcome === "failed" || args.outcome === "bounced") await ctx.db.patch(row._id, { status: "failed", failedAt: now, ...cost });
  else if (args.providerCost !== undefined) await ctx.db.patch(row._id, cost);
  return true;
}

/**
 * Someone texted one of Selestial's own numbers. They take no replies: one automatic answer pointing to
 * help, at most once a day per number. Never after a STOP (the carriers handle STOP on toll-free numbers).
 */
export async function answerNoReply(ctx: MutationCtx, input: { from: string; keyword: "stop" | "help" | "start" | "plain_stop" | "ignored"; at: number }) {
  if (input.keyword === "stop" || input.keyword === "plain_stop") return { answered: false };
  const key = await phoneKey(input.from);
  if (!(await allow(ctx, `platform-noreply:${key}`, 1, DAY))) return { answered: false };
  await queueNoticeIn(ctx, { kind: "no_reply_answer", reason: "reply to a no-reply number", dedupeKey: `noreply:${key}:${Math.floor(input.at / DAY)}`, to: input.from, body: NO_REPLY_ANSWER });
  return { answered: true };
}
