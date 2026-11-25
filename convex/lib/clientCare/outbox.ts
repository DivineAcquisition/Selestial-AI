/**
 * Client Care's messages to a client: an answer, a question, a confirmation, an update, or a step Retention
 * prepared on a case linked to the request. Planned as `messages` rows and sent through the one door
 * (convex/messaging.ts), so the shared sending policy decides suspension, pause, sender readiness, consent,
 * the do-not-contact list, quiet hours and funds, when planned and again when sent.
 *
 * Before anything is planned, and again at the moment it goes (`careReplyClaim`), Care checks the
 * conversation is its to write in: a person who took the thread or the request over, the Quo app, the review
 * queue, agent replies paused in the thread, and Sales working an open inquiry each stop it. An answer drafted
 * before the client wrote again is stale and does not go; a confirmation of a change already made still does.
 */
import { conversationAt, textingProvider } from "../quo/route";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { readProfile } from "../compliance/profile";
import { normalAddress } from "../compliance/recipients";
import { recordEvent, type Actor } from "../events";
import { emailProvider } from "../messaging/email";
import { messageByKey, type SendIntent } from "../messaging/outbox";
import { startingState } from "../messaging/planning";
import { checkSend, type PolicyCode } from "../messaging/policy";
import { careLinkState, careLinkUrl } from "../retention/links";
import { routeFor } from "../inbox/mailboxes";
import type { Request } from "./requests";

type Ctx = QueryCtx | MutationCtx;

/** Who holds the conversation now, if not Care. Null: Care may write. */
export async function heldBy(ctx: Ctx, request: Request, customer: Doc<"customers">): Promise<{ code: string; words: string } | null> {
  if (request.owner.kind === "member") return { code: "request_held", words: "A person took this request over, so Client Care sends nothing until it is handed back." };
  if (customer.conversationHeld) return { code: "conversation_held", words: "A person is handling this client's conversation, so Client Care sends nothing until it is handed back." };
  if (request.conversation.channel === "sms") {
    const thread = await conversationAt(ctx, request.companyId, request.conversation.address);
    if (thread?.agentsPausedAt !== undefined) return { code: "agents_paused_here", words: "Agent replies are paused in this conversation. A person can still send." };
    if (thread?.owner.kind === "member") return { code: "conversation_held", words: "A person took over this conversation, so Client Care sends nothing until it is returned to the agents." };
    if (thread?.owner.kind === "external") return { code: "conversation_external", words: "Someone answered this conversation from Quo, so Client Care stepped back until a person returns it." };
    if (thread?.owner.kind === "review") return { code: "conversation_review", words: "This conversation is in the review queue for a person." };
  }
  const opportunities = await ctx.db
    .query("salesOpportunities")
    .withIndex("by_company_customer", (q) => q.eq("companyId", request.companyId).eq("customerId", customer._id))
    .take(20);
  if (opportunities.some((row) => row.stage !== "won" && row.stage !== "lost" && row.followUps === "on" && row._id !== request.opportunityId)) {
    return { code: "conversation_with_sales", words: "Sales is in conversation with this client about an open inquiry, so Client Care does not write to them at the same time." };
  }
  return null;
}

/** Whether Care may write in this request's conversation now. */
export async function careReplyClaimable(ctx: Ctx, request: Request): Promise<boolean> {
  const customer = await ctx.db.get(request.customerId);
  return Boolean(customer) && (await heldBy(ctx, request, customer!)) === null;
}

/** The client's own address is checked as the client, whose permission is on record; a contact's as whoever is on record with it. */
export function careIntent(customer: Doc<"customers">, request: Request, actor: Actor): SendIntent {
  const own = normalAddress(request.conversation.channel, request.conversation.channel === "sms" ? customer.phone : customer.email) === request.conversation.address;
  return { category: "operational", origin: actor.kind === "agent" ? "agent" : "manual", ...(actor.kind === "agent" ? { agent: "customer-care" as const } : {}), ...(own ? { recipient: { kind: "customer" as const, id: customer._id } } : {}) };
}

export type PlannedCareReply = {
  company: Doc<"companies">;
  request: Request;
  step: Doc<"careSteps">;
  body: string;
  subject?: string;
  /** The invoice whose own pay link the body carries as "{link}". Finance makes the link at send time. */
  invoiceId?: Id<"invoices">;
  dedupeKey: string;
  actor: Actor;
};

/** Plans one message and hands it to the sender. Asked twice with the same key, it answers with the first. */
export async function queueCareReply(ctx: MutationCtx, planned: PlannedCareReply): Promise<Doc<"messages">> {
  const existing = await messageByKey(ctx, planned.company._id, planned.dedupeKey);
  if (existing) return existing;
  const { company, request } = planned;
  const customer = (await ctx.db.get(request.customerId))!;
  const channel = request.conversation.channel;
  const email = channel === "email";
  const to = request.conversation.address;
  const provider = email ? ((await routeFor(ctx, company._id, "care")).kind === "gmail" ? { name: "gmail" } : emailProvider()) : await textingProvider(ctx, company._id, to);
  const intent = careIntent(customer, request, planned.actor);
  const now = Date.now();
  let problem: string | null = null;
  let code: PolicyCode | string | null = null;
  let retryAt: number | undefined;
  if (!provider) problem = email ? "Email isn't connected for Selestial yet." : "Texting isn't connected for Selestial yet.";
  if (!problem && planned.actor.kind === "agent") {
    const held = await heldBy(ctx, request, customer);
    if (held) {
      problem = held.words;
      code = held.code;
    }
  }
  if (!problem) {
    const answer = await checkSend(ctx, { companyId: company._id, channel, to, now, ...intent });
    if (!answer.ok) {
      problem = answer.words.replace(/\bwork (emails|texts)\b/, "service $1");
      code = answer.code;
      retryAt = answer.retryAt;
    }
  }
  const start = startingState({ problem, code, retryAt, now });
  const status = start.status;
  const signature = email && (company.clientCare?.signature?.trim() ?? "");
  const messageId = await ctx.db.insert("messages", {
    companyId: company._id,
    purpose: "client_care_reply",
    channel,
    subject: email ? (planned.subject ?? (request.conversation.subject ? `Re: ${request.conversation.subject.replace(/^re:\s*/i, "")}` : "About your request")) : undefined,
    ...(email ? { replyTo: (await readProfile(ctx, company._id)).identity.supportEmail ?? undefined } : {}),
    customerId: customer._id,
    contactId: request.authority.contactId,
    jobId: request.jobId,
    invoiceId: planned.invoiceId,
    careRequestId: request._id,
    careStepId: planned.step._id,
    agent: "customer-care",
    draftedBy: planned.actor.kind === "agent" ? "agent" : "person",
    ...(planned.actor.kind === "member" ? { authorId: planned.actor.memberId } : {}),
    about: { table: "careRequests", id: request._id, label: request.summary.slice(0, 120) },
    to: status === "not_sent" ? undefined : to,
    body: signature ? `${planned.body}\n\n${signature}` : planned.body,
    dedupeKey: planned.dedupeKey,
    status,
    attempts: 0,
    provider: provider?.name,
    problem: problem ?? undefined,
    ...start.fields,
    queuedAt: now,
  });
  if (status !== "not_sent") await ctx.db.insert("sendIntents", { companyId: company._id, messageId, channel, address: to, at: now, ...intent });
  await recordEvent(ctx, { companyId: company._id, type: `message.${status}`, actor: planned.actor, subject: { table: "messages", id: messageId }, data: { purpose: "client_care_reply", channel, ...(code ? { policy: String(code) } : {}) } });
  if (status === "queued") await ctx.scheduler.runAfter(0, internal.messaging.deliver, { messageId });
  if (status === "held") await ctx.scheduler.runAt(retryAt!, internal.messaging.deliver, { messageId });
  return (await ctx.db.get(messageId))!;
}

/** The newest message the client sent on this request, from the conversation's own records. */
export async function lastClientMessageAt(ctx: Ctx, request: Pick<Request, "companyId" | "customerId" | "lastCustomerAt">): Promise<number> {
  const latest = await ctx.db
    .query("careMessages")
    .withIndex("by_company_customer", (q) => q.eq("companyId", request.companyId).eq("customerId", request.customerId))
    .order("desc")
    .first();
  return Math.max(request.lastCustomerAt, latest?.receivedAt ?? 0);
}

/**
 * At the moment of sending: the request still open and Care's to write in, the step still the one to carry
 * out, no newer word from the client that would make the draft wrong, and (for a relayed Retention step) its
 * link still open. A link's address is made now and never stored.
 */
export async function careReplyClaim(ctx: MutationCtx, message: Doc<"messages">): Promise<{ problem: string } | { body: string; fromName: string }> {
  const request = message.careRequestId ? await ctx.db.get(message.careRequestId) : null;
  const step = message.careStepId ? await ctx.db.get(message.careStepId) : null;
  if (!request || request.companyId !== message.companyId || !step) return { problem: "The request this message belongs to no longer exists." };
  const customer = await ctx.db.get(request.customerId);
  if (!customer) return { problem: "The client no longer exists." };
  if (step.status === "cancelled") return { problem: "This message was withdrawn before it went out." };
  const confirming = step.payload.staleSafe === true;
  if (!confirming && request.status === "closed_no_action") return { problem: "The request was closed before the message went out." };
  if (message.draftedBy === "agent") {
    const held = await heldBy(ctx, request, customer);
    if (held) return { problem: held.words };
    // An answer written before the client's newest message may no longer answer them. A confirmation of a change already made is still true.
    if (!confirming && (await lastClientMessageAt(ctx, request)) > step.createdAt) return { problem: "The client wrote again before this went out, so Client Care is reading the new message instead of sending an answer that may be out of date." };
  }
  let body = message.body;
  if (step.kind === "relay" && body.includes("{link}")) {
    const action = step.payload.retentionActionId ? await ctx.db.get(step.payload.retentionActionId) : null;
    const link = action?.linkId ? await ctx.db.get(action.linkId) : null;
    if (!link || careLinkState(link, Date.now()) !== "active") return { problem: "The link was closed before the message went out." };
    const url = await careLinkUrl(link);
    if (!url) return { problem: "Links aren't set up, so there was no link to send." };
    body = body.replaceAll("{link}", url);
  }
  const company = await ctx.db.get(message.companyId);
  const profile = await readProfile(ctx, message.companyId);
  return { body, fromName: profile.messaging.senderName?.trim() || company?.name || "" };
}

export function deliveryWords(message: Pick<Doc<"messages">, "status" | "problem" | "deliveryUnconfirmedAt">): { state: "pending" | "accepted" | "delivered" | "failed" | "unknown" | "not_sent"; words: string } {
  switch (message.status) {
    case "queued":
    case "sending":
      return { state: "pending", words: "Queued to send" };
    case "held":
      return { state: "pending", words: message.problem ?? "Held until it can go" };
    case "sent":
      return { state: "accepted", words: message.deliveryUnconfirmedAt ? "Accepted by the provider. Delivery not confirmed." : "Accepted by the provider. Delivery not yet confirmed." };
    case "delivered":
      return { state: "delivered", words: "Delivery confirmed" };
    case "failed":
      return { state: "failed", words: message.problem ?? "Not delivered" };
    case "unconfirmed":
      return { state: "unknown", words: "Not known whether it went. It was not sent again." };
    case "not_sent":
      return { state: "not_sent", words: message.problem ?? "Not sent" };
  }
}
