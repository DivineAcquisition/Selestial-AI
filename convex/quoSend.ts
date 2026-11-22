/**
 * The parts of a Quo send that need the database (lib/quo/send.ts): which texts are Selestial's own, a text sent
 * from the Quo app, and settling a send whose answer never came.
 *
 * Reconciling an unconfirmed text: Quo's message list for the number and the person, around the moment it was
 * sent, is read. Exactly one outgoing text there that isn't already one of Selestial's settles it as sent (with
 * Quo's id, so its delivery report finds it). None after a few checks: it was not sent, and it is left for a
 * person (an old follow-up or an expired offer is never sent again on its own). More than one: a person decides.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { keyFor } from "./quo";
import { recordEvent } from "./lib/events";
import { recentMessages } from "./lib/quo/api";
import { MESSAGE_CHANGES } from "./lib/statuses";

const WINDOW_BEFORE_MS = 30_000;
const WINDOW_AFTER_MS = 2 * 60_000;
const CHECKS = 3;

/** Quo's ids for Selestial's own texts to this person in the last day. */
export const ourIds = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message?.to) return [];
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_company_to", (q) => q.eq("companyId", message.companyId).eq("to", message.to!).gt("queuedAt", Date.now() - 86_400_000))
      .take(200);
    return rows.filter((row) => row.provider === "quo" && row.providerMessageId).map((row) => row.providerMessageId!);
  },
});

/** Someone texted this person from the Quo app: agents step back from the conversation. */
export const externalSeen = internalMutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message?.to) return null;
    const conversation = await ctx.db
      .query("smsConversations")
      .withIndex("by_company_address", (q) => q.eq("companyId", message.companyId).eq("address", message.to!))
      .first();
    if (!conversation) return null;
    if (conversation.owner.kind !== "member") await ctx.db.patch(conversation._id, { owner: { kind: "external" }, ownerReason: "Someone answered from the Quo app, so agents stepped back until a person returns the conversation to them.", ownerChangedAt: Date.now(), lastExternalAt: Date.now() });
    await recordEvent(ctx, { companyId: message.companyId, type: "quo.external_reply", actor: { kind: "system" }, subject: { table: "companies", id: message.companyId } });
    return null;
  },
});

export const toReconcile = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.provider !== "quo" || message.status !== "unconfirmed" || !message.to) return null;
    const conversation = await ctx.db
      .query("smsConversations")
      .withIndex("by_company_address", (q) => q.eq("companyId", message.companyId).eq("address", message.to!))
      .first();
    if (!conversation?.connectionId || !conversation.senderId) return null;
    return { to: message.to, attemptedAt: message.attemptedAt ?? message.queuedAt, connectionId: conversation.connectionId, senderId: conversation.senderId };
  },
});

export const reconcile = internalAction({
  args: { messageId: v.id("messages"), check: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const target = await ctx.runQuery(internal.quoSend.toReconcile, { messageId: args.messageId });
    if (!target) return null;
    const found = await keyFor(ctx, target.connectionId);
    if (!found) return null;
    const listed = await recentMessages(fetch, found.key, { numberId: target.senderId, participant: target.to, since: target.attemptedAt - WINDOW_BEFORE_MS, direction: "outgoing" });
    const check = (args.check ?? 0) + 1;
    if (!listed.ok) {
      if (check < CHECKS) await ctx.scheduler.runAfter(check * 2 * 60_000, internal.quoSend.reconcile, { messageId: args.messageId, check });
      return null;
    }
    const ours = await ctx.runQuery(internal.quoSend.ourIds, { messageId: args.messageId });
    const candidates = listed.data.filter((row) => !ours.includes(row.id) && Date.parse(row.createdAt) <= target.attemptedAt + WINDOW_AFTER_MS);
    if (candidates.length === 1) {
      await ctx.runMutation(internal.quoSend.settleReconciled, { messageId: args.messageId, providerMessageId: candidates[0].id, delivered: candidates[0].status === "delivered" });
      return null;
    }
    if (candidates.length > 1) {
      await ctx.runMutation(internal.quoSend.leaveForPerson, { messageId: args.messageId, words: "Checked with Quo: more than one text to this person was sent around that time, so a person has to decide whether this one went." });
      return null;
    }
    if (check < CHECKS) {
      await ctx.scheduler.runAfter(check * 2 * 60_000, internal.quoSend.reconcile, { messageId: args.messageId, check });
      return null;
    }
    await ctx.runMutation(internal.quoSend.notSent, { messageId: args.messageId });
    return null;
  },
});

export const settleReconciled = internalMutation({
  args: { messageId: v.id("messages"), providerMessageId: v.string(), delivered: v.boolean() },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.status !== "unconfirmed") return null;
    const status = args.delivered ? "delivered" : "sent";
    if (!MESSAGE_CHANGES.unconfirmed.includes(status)) return null;
    await ctx.db.patch(message._id, { status, providerMessageId: args.providerMessageId, problem: undefined, ...(args.delivered ? { deliveredAt: Date.now() } : {}) });
    await recordEvent(ctx, { companyId: message.companyId, type: "message.reconciled", actor: { kind: "system" }, subject: { table: "companies", id: message.companyId }, data: { messageId: message._id, status } });
    return null;
  },
});

export const notSent = internalMutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.status !== "unconfirmed") return null;
    await ctx.db.patch(message._id, { status: "not_sent", problem: "Checked with Quo: it has no record of this text, so it wasn't sent. It isn't sent again on its own; a person can send it if it's still needed." });
    await recordEvent(ctx, { companyId: message.companyId, type: "message.not_sent", actor: { kind: "system" }, subject: { table: "companies", id: message.companyId }, data: { messageId: message._id, reason: "reconciled_absent" } });
    return null;
  },
});

export const leaveForPerson = internalMutation({
  args: { messageId: v.id("messages"), words: v.string() },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.status !== "unconfirmed") return null;
    await ctx.db.patch(message._id, { problem: args.words });
    return null;
  },
});
