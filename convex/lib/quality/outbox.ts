/**
 * Quality's messages to cleaners, through the one sending pipeline (convex/messaging.ts). A message is a
 * row first, checked by the sending policy when planned and again when sent; its link is made at the moment
 * of sending and never stored. Quality writes to cleaners only, about evidence for a visit they worked.
 * Customers are written to by Retention, which owns that conversation.
 *
 * Quality never sends through a different provider because the chosen one failed, and never resends a text
 * whose fate is unknown: an uncertain send is reconciled by the shared pipeline, not retried here.
 */
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { recordEvent, type Actor } from "../events";
import { messageByKey, type SendIntent } from "../messaging/outbox";
import { checkSend, type PolicyCode } from "../messaging/policy";
import { messagingProvider, sendablePhone } from "../messaging/provider";
import { linkToken, linkUrl } from "../sales/links";
import { startingState } from "../messaging/planning";

export type QualityPurpose = "quality_request" | "quality_reminder";

export function qualityIntent(cleaner: Pick<Doc<"cleaners">, "_id">, actor: Actor): SendIntent {
  return { category: "operational", origin: actor.kind === "agent" ? "agent" : "manual", ...(actor.kind === "agent" ? { agent: "quality" as const } : {}), recipient: { kind: "cleaner", id: cleaner._id } };
}

export async function queueQualityMessage(ctx: MutationCtx, planned: { company: Doc<"companies">; request: Doc<"qualityRequests">; cleaner: Doc<"cleaners">; purpose: QualityPurpose; body: string; dedupeKey: string; actor: Actor }): Promise<Doc<"messages">> {
  const existing = await messageByKey(ctx, planned.company._id, planned.dedupeKey);
  if (existing) return existing;
  const { company, cleaner } = planned;
  const to = sendablePhone(cleaner.phone);
  const provider = messagingProvider();
  const intent = qualityIntent(cleaner, planned.actor);
  const now = Date.now();
  let problem: string | null = null;
  let code: PolicyCode | null = null;
  let retryAt: number | undefined;
  if (!to) problem = "There is no valid phone number for this cleaner.";
  else if (!provider) problem = "Texting isn't connected for Selestial yet.";
  if (!problem && to) {
    const answer = await checkSend(ctx, { companyId: company._id, channel: "sms", to, now, ...intent });
    if (!answer.ok) {
      problem = answer.words;
      code = answer.code;
      retryAt = answer.retryAt;
    }
  }
  const start = startingState({ problem, code: code, retryAt, now });
  const status = start.status;
  const messageId = await ctx.db.insert("messages", {
    companyId: company._id,
    purpose: planned.purpose,
    channel: "sms",
    cleanerId: cleaner._id,
    jobId: planned.request.jobId,
    qualityRequestId: planned.request._id,
    agent: "quality",
    draftedBy: planned.actor.kind === "agent" || planned.request.createdBy.kind === "agent" ? "agent" : "person",
    ...(planned.actor.kind === "member" ? { authorId: planned.actor.memberId } : {}),
    to: status === "not_sent" ? undefined : (to ?? undefined),
    body: planned.body,
    dedupeKey: planned.dedupeKey,
    status,
    attempts: 0,
    provider: provider?.name,
    problem: problem ?? undefined,
    ...start.fields,
    queuedAt: now,
  });
  if (status !== "not_sent" && to) await ctx.db.insert("sendIntents", { companyId: company._id, messageId, channel: "sms", address: to, at: now, ...intent });
  await recordEvent(ctx, { companyId: company._id, type: `message.${status}`, actor: planned.actor, subject: { table: "messages", id: messageId }, data: { purpose: planned.purpose, ...(code ? { policy: code } : {}) } });
  if (status === "queued") await ctx.scheduler.runAfter(0, internal.messaging.deliver, { messageId });
  if (status === "held") await ctx.scheduler.runAt(retryAt!, internal.messaging.deliver, { messageId });
  return (await ctx.db.get(messageId))!;
}

/** The address of a request's page, made now and never stored. Null when links are not set up. */
export async function requestUrl(request: Pick<Doc<"qualityRequests">, "publicId">): Promise<string | null> {
  const token = request.publicId ? await linkToken("quality", request.publicId) : null;
  return token ? linkUrl("quality", token) : null;
}

export function requestLinkState(request: Pick<Doc<"qualityRequests">, "expiresAt" | "revokedAt" | "status">, now: number): "active" | "expired" | "revoked" | "closed" {
  if (request.revokedAt !== undefined) return "revoked";
  if (request.expiresAt !== undefined && request.expiresAt <= now) return "expired";
  if (request.status === "cancelled" || request.status === "satisfied" || request.status === "revoked") return "closed";
  return "active";
}

/**
 * At the moment of sending: the request is still open, its case is not held or serious (for a message the
 * agent drafted), and its link is still open. The link's address is made now.
 */
export async function qualityClaim(ctx: MutationCtx, message: Doc<"messages">): Promise<{ problem: string } | { body: string; fromName: string }> {
  const request = message.qualityRequestId ? await ctx.db.get(message.qualityRequestId) : null;
  if (!request || request.companyId !== message.companyId) return { problem: "The request this message belongs to no longer exists." };
  if (request.status !== "sent") return { problem: `The request was ${request.status.replace(/_/g, " ")} before the message went out.` };
  if (request.caseId) {
    const row = await ctx.db.get(request.caseId);
    if (!row || row.stage === "closed") return { problem: "The case was closed before the message went out." };
    if (message.draftedBy === "agent" && (row.heldBy || row.serious)) return { problem: "A person took over this case before the message went out, so Quality did not send it." };
  }
  let body = message.body;
  if (body.includes("{link}")) {
    if (requestLinkState(request, Date.now()) !== "active") return { problem: "The link was closed before the message went out." };
    const url = await requestUrl(request);
    if (!url) return { problem: "Links aren't set up, so there was no link to send." };
    body = body.replaceAll("{link}", url);
  }
  const company = await ctx.db.get(message.companyId);
  return { body, fromName: company?.name ?? "" };
}

/** A message this request sent has a final answer from the provider. A queued message is not a delivered one. */
export async function afterQualityMessage(ctx: MutationCtx, message: Doc<"messages">): Promise<void> {
  const request = message.qualityRequestId ? await ctx.db.get(message.qualityRequestId) : null;
  if (!request) return;
  const now = Date.now();
  if (message.status === "sent" || message.status === "delivered") {
    await ctx.db.patch(request._id, { result: message.status === "delivered" ? "Delivered to the cleaner's phone." : "Sent. Delivery not yet confirmed.", updatedAt: now });
    return;
  }
  if (message.status === "not_sent" || message.status === "failed") {
    if (request.status === "sent") await ctx.db.patch(request._id, { status: "blocked", result: `Not ${message.status === "failed" ? "delivered" : "sent"}: ${message.problem ?? "it could not be sent"}`, updatedAt: now });
    return;
  }
  if (message.status === "unconfirmed") await ctx.db.patch(request._id, { result: "It is not known whether the text went. It was not sent again.", updatedAt: now });
}
