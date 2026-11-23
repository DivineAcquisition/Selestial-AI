/**
 * Quo's webhook events, after the signature checked out (convex/http.ts) and the event id was seen once
 * (convex/quo.ts `ingest`). Every event is checked against the connection it was sent to: its number must be one
 * this company's key sees, and its workspace the one first seen. Anything else is ignored.
 *
 *  - message.received: a reply. It goes through the same path as a text to a Selestial number (convex/inbound.ts):
 *    STOP and HELP, Sales, Recruiter, Dispatch and Retention routing, the client's conversation, a review task.
 *  - message.delivered / failed / undelivered: the outcome of a text. Selestial's own texts are matched by Quo's id;
 *    a report that beats the send's own answer is kept and applied when it settles. An outgoing text Selestial did
 *    not send is someone answering from the Quo app: agents step back from that conversation.
 *  - a2p.registration.updated: the registration is read again.
 */
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { applyReceipt } from "../../messaging";
import { receiveSms } from "../../inbound";
import { normalAddress } from "../compliance/recipients";
import { recordEvent } from "../events";
import type { QuoEvent } from "./api";
import { ensureConversation } from "./route";

const RACE_MS = 2 * 60_000;

export async function applyQuoEvent(ctx: MutationCtx, connection: Doc<"quoConnections">, eventId: string, event: QuoEvent): Promise<string> {
  const context = event.data?.context ?? {};
  const resource = event.data?.resource ?? {};
  if (event.type === "a2p.registration.updated") {
    await ctx.scheduler.runAfter(0, internal.quo.check, { connectionId: connection._id });
    return "registration";
  }
  const number = [...connection.selected, ...connection.available].find((row) => row.id === context.phoneNumberId);
  if (!number) return "not_our_number";
  // The workspace is learned from the first verified event; an event from another workspace is never this company's.
  if (connection.orgId && context.orgId && context.orgId !== connection.orgId) {
    await recordEvent(ctx, { companyId: connection.companyId, type: "quo.event_rejected", actor: { kind: "system" }, subject: { table: "companies", id: connection.companyId }, data: { reason: "workspace" } });
    return "other_workspace";
  }
  await ctx.db.patch(connection._id, { ...(connection.orgId || !context.orgId ? {} : { orgId: context.orgId }), ...(connection.webhook ? { webhook: { ...connection.webhook, lastEventAt: Date.now() } } : {}) });

  if (event.type === "message.received" && resource.direction === "incoming") {
    const from = normalAddress("sms", context.senderIdentifier ?? "");
    // Not a phone number (an internal Quo flow), or one of the company's own numbers (a loop): ignored.
    if (!from || connection.selected.some((row) => row.phoneNumber === from) || connection.available.some((row) => row.phoneNumber === from)) return "ignored";
    const receivedAt = Date.parse(resource.createdAt ?? event.createdAt ?? "") || Date.now();
    // The Owner's test reply proves replies reach Selestial.
    if (connection.test && connection.test.to === from && receivedAt >= connection.test.sentAt - 60_000 && !connection.replyVerifiedAt) {
      await ctx.db.patch(connection._id, { test: { ...connection.test, replyAt: receivedAt }, replyVerifiedAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.quo.refreshStatus, { connectionId: connection._id });
      await recordEvent(ctx, { companyId: connection.companyId, type: "quo.reply_verified", actor: { kind: "system" }, subject: { table: "companies", id: connection.companyId } });
      return "test_reply";
    }
    await receiveSms(ctx, {
      companyId: connection.companyId,
      provider: "quo",
      to: number.phoneNumber,
      from,
      body: resource.text ?? "",
      receivedAt,
      providerId: `quo:${resource.id ?? eventId}`,
      quo: { connectionId: connection._id, senderId: number.id, providerConversationId: context.conversationId, providerMessageId: resource.id },
    });
    return "received";
  }

  if ((event.type === "message.delivered" || event.type === "message.failed" || event.type === "message.undelivered") && resource.id) {
    if (connection.test?.providerMessageId === resource.id) return "test_receipt";
    const to = normalAddress("sms", context.recipientIdentifiers?.[0] ?? "");
    const ours = await ctx.db
      .query("messages")
      .withIndex("by_provider_message", (q) => q.eq("provider", "quo").eq("providerMessageId", resource.id))
      .first();
    // A report for a text of ours still in flight is kept until its send settles (applyReceipt stores it early).
    const inFlight =
      !ours && to
        ? (
            await ctx.db
              .query("messages")
              .withIndex("by_company_to", (q) => q.eq("companyId", connection.companyId).eq("to", to))
              .order("desc")
              .take(10)
          ).some((row) => row.provider === "quo" && (row.status === "sending" || row.status === "unconfirmed") && (row.attemptedAt ?? 0) > Date.now() - RACE_MS)
        : false;
    if (ours || inFlight) {
      const failed = event.type !== "message.delivered";
      await applyReceipt(ctx, {
        provider: "quo",
        eventId: `${eventId}:receipt`,
        providerMessageId: resource.id,
        outcome: failed ? "failed" : "delivered",
        problem: failed ? (event.type === "message.undelivered" ? "The carrier didn't deliver it to the phone." : "Quo couldn't send it.") : undefined,
        errorCode: resource.errorCode ?? undefined,
      });
      return failed ? "failed" : "delivered";
    }
    if (resource.direction === "outgoing" && to) {
      // Someone (a person, or one of Quo's own automations) texted from the Quo app. Agents step back here.
      const conversation = await ensureConversation(ctx, connection.companyId, to, { provider: "quo", sender: number.phoneNumber, connectionId: connection._id, senderId: number.id, providerConversationId: context.conversationId });
      if (conversation.owner.kind !== "member") {
        await ctx.db.patch(conversation._id, { owner: { kind: "external" }, ownerReason: "Someone answered from the Quo app, so agents stepped back until a person returns the conversation to them.", ownerChangedAt: Date.now(), lastExternalAt: Date.now() });
      } else {
        await ctx.db.patch(conversation._id, { lastExternalAt: Date.now() });
      }
      await recordEvent(ctx, { companyId: connection.companyId, type: "quo.external_reply", actor: { kind: "system" }, subject: { table: "companies", id: connection.companyId } });
      return "external";
    }
  }
  return "ignored";
}
