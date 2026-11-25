/**
 * A client's message coming in, by text or by email, and what Care makes of it.
 *
 * `receive` runs inside the webhook's own transaction (convex/inbound.ts) or the inbox reader's: it decides
 * whether the message is Care's, keeps the client's words once (by the provider's id), and queues a run. It
 * does no reading and sends nothing, so a slow model or a paused agent never holds up the webhook.
 *
 * A message is Care's only when its address belongs to exactly one active client, as the client or one of
 * its contacts, and to nobody else on record (a cleaner or an applicant sharing the number is a person's to
 * sort out). A first name never identifies anyone, and a shared address never picks a property.
 *
 * `applyReading` (the worker) attaches the reading to the requests it belongs to: an answer to Care's own
 * question, a reply on an open request of the same kind, a resolved request the client says isn't done, or a
 * new request. Thanks and acknowledgments are kept on the request and open nothing.
 */
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { recipientsAt } from "../compliance/recipients";
import { seal } from "../recruiter/secrets";
import { allow } from "../rateLimit";
import { writersAt } from "./context";
import { withholdAccess, type Intent, type Reading } from "./read";
import { addEntry, CARE, isOpen, moveRequest, openRequest, openRequestsFor, recentRequestsFor, reopenRequest, type Request } from "./requests";
import type { Authority, CareCategory } from "./schema";
import { careSettings } from "./settings";
import { advance } from "./workflows";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEEP = 1000;
/** A message older than this when it reaches Care is a replay or an import: it is kept for the record and starts nothing. */
const STALE_AFTER = 2 * DAY;
const UNDONE = /\b(still|again|not (?:fixed|resolved|done|right)|didn'?t (?:work|fix|help)|same (?:problem|issue)|hasn'?t been)\b/i;

export type Incoming = {
  companyId: Id<"companies">;
  channel: "sms" | "email";
  /** The sender's address, already normalized. */
  from: string;
  text: string;
  receivedAt: number;
  /** The provider's own id for this message (a Telnyx event, a Quo message, a Gmail message). */
  providerKey: string;
  conversationId?: Id<"smsConversations">;
  mailbox?: { connectionId: Id<"mailboxConnections">; threadId?: string; subject?: string };
};

export type Received = { taken: true; messageId: Id<"careMessages">; customerId: Id<"customers">; repeated: boolean } | { taken: false; why: string };

export async function receive(ctx: MutationCtx, input: Incoming): Promise<Received> {
  const company = await ctx.db.get(input.companyId);
  if (!company || company.closingAt || company.deletedAt) return { taken: false, why: "The company is not active." };
  const seen = await ctx.db
    .query("careMessages")
    .withIndex("by_company_provider", (q) => q.eq("companyId", input.companyId).eq("providerKey", input.providerKey.slice(0, 300)))
    .first();
  if (seen) return { taken: true, messageId: seen._id, customerId: seen.customerId, repeated: true };
  const writers = await writersAt(ctx, input.companyId, input.channel, input.from);
  if (writers.length !== 1) return { taken: false, why: writers.length ? "The address is on more than one client's record." : "The address is on no client's record." };
  const others = (await recipientsAt(ctx, input.companyId, input.channel, input.from)).filter((row) => row.kind !== "customer");
  if (others.length) return { taken: false, why: "The address is also a cleaner's or an applicant's." };
  const { customer, authority } = writers[0];
  // A stream of messages cannot become a stream of requests.
  if (!(await allow(ctx, `care-in:${input.companyId}:${input.from}`, 30, HOUR))) return { taken: false, why: "Too many messages from this address in an hour." };
  const kept = withholdAccess(input.text.slice(0, KEEP));
  const stale = Date.now() - input.receivedAt > STALE_AFTER;
  const messageId = await ctx.db.insert("careMessages", {
    companyId: input.companyId,
    customerId: customer._id,
    contactId: authority.contactId,
    channel: input.channel,
    from: input.from,
    providerKey: input.providerKey.slice(0, 300),
    text: kept.text,
    withheld: kept.withheld,
    receivedAt: input.receivedAt,
    status: stale ? "skipped" : "queued",
    requestIds: [],
    ...(stale ? { note: "Received more than two days after it was sent (a replay or an import). Kept for the record; Client Care started nothing." } : {}),
    conversationId: input.conversationId,
    mailbox: input.mailbox,
  });
  // New access details are kept only sealed, bound to this message, to be written to the property's restricted field.
  if (kept.withheld) {
    const sealed = await seal(input.text.slice(0, KEEP), messageId);
    if (sealed) await ctx.db.patch(messageId, { sealed });
  }
  if (!stale) {
    const runId = await ctx.db.insert("careRuns", { companyId: input.companyId, kind: "read", key: `read:${messageId}`, messageId, status: "queued", attempts: 0, queuedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.clientCareWork.read, { runId });
  }
  return { taken: true, messageId, customerId: customer._id, repeated: false };
}

function urgencyOf(intent: Intent, reading: Reading): { urgency: Request["urgency"]; reason?: string } {
  if (reading.serious || intent.ask.serious) return { urgency: "urgent", reason: reading.serious ?? intent.ask.serious };
  if (intent.category === "complaint") return { urgency: "high", reason: "A client reported a problem with a visit." };
  const soon = intent.ask.target?.day && Date.parse(`${intent.ask.target.day}T12:00:00Z`) - Date.now() < 2 * DAY;
  if ((intent.category === "reschedule" || intent.category === "cancellation" || intent.category === "access") && soon) return { urgency: "high", reason: "It is about a visit in the next two days." };
  return { urgency: "normal" };
}

const SUMMARY: Record<CareCategory, string> = {
  appointment: "Asked about a visit",
  preference: "Gave a preference",
  access: "Sent new access details",
  reschedule: "Asked to move a visit",
  cancellation: "Asked to cancel",
  complaint: "Reported a problem",
  billing: "Asked about an invoice or payment",
  extra: "Asked for an extra service",
  new_service: "Asked about new service",
  general: "Sent a message",
};

const OUTCOME: Record<CareCategory, string> = {
  appointment: "A verified answer about their visit.",
  preference: "The preference recorded where it applies, and the crew able to see it.",
  access: "The property's access instructions updated.",
  reschedule: "The visit moved to a time the team can cover.",
  cancellation: "The visit or service changed exactly as they asked.",
  complaint: "The concern reviewed by Quality, any remedy arranged, and the client kept informed.",
  billing: "The invoice's verified status and its payment link.",
  extra: "The extra added at its published price, once accepted.",
  new_service: "A quote from Sales.",
  general: "An answer from the team.",
};

function summaryOf(intent: Intent, authority: Authority): string {
  const words = intent.ask.detail ?? intent.words;
  return `${SUMMARY[intent.category]}: "${words.replace(/\s+/g, " ").slice(0, 140)}"${authority.as === "contact" ? ` (${authority.name})` : ""}`;
}

/** Puts one reading on the requests it belongs to and works each forward. Called once per message. */
export async function applyReading(ctx: MutationCtx, company: Doc<"companies">, message: Doc<"careMessages">, reading: Reading, options: { recordOnly: string | null }): Promise<string> {
  if (message.status !== "queued") return "Already read.";
  const customer = await ctx.db.get(message.customerId);
  if (!customer) return "The client no longer exists.";
  const writers = await writersAt(ctx, company._id, message.channel, message.from);
  const writer = writers.find((row) => row.customer._id === customer._id);
  if (!writer) {
    await ctx.db.patch(message._id, { status: "skipped", note: "The address no longer belongs to this client.", reader: reading.reader });
    return "The address no longer belongs to this client.";
  }
  const authority = writer.authority;
  const conversation = { channel: message.channel, address: message.from, smsConversationId: message.conversationId, mailboxConnectionId: message.mailbox?.connectionId, threadId: message.mailbox?.threadId, subject: message.mailbox?.subject };
  const open = (await openRequestsFor(ctx, company._id, customer._id)).filter((row) => row.conversation.address === message.from);
  const touched = new Map<string, { request: Request; text: string; answer: boolean }>();
  const received = async (request: Request, words: string) => {
    await addEntry(ctx, request, { kind: "received", text: `${authority.name} wrote: "${message.text.slice(0, 400)}"`, source: { table: "careMessages", id: message._id, label: message.channel === "sms" ? "Text" : "Email" }, at: message.receivedAt });
    return moveRequest(ctx, request, { lastCustomerAt: message.receivedAt, summary: request.summary, ...(words ? {} : {}) });
  };

  // An answer to the question Care asked on this thread.
  const asking = open.find((row) => row.pending);
  if (asking && reading.answer && !touched.has(asking._id)) {
    const request = await received(asking, message.text);
    touched.set(request._id, { request, text: message.text, answer: true });
  }
  if (reading.ack && reading.intents.length === 0) {
    const latest = open[0];
    if (latest) await received(latest, message.text);
    await ctx.db.patch(message._id, { status: "read", requestIds: latest ? [latest._id] : [], note: "Thanks or an acknowledgment. Nothing new was opened.", reader: reading.reader });
    return "An acknowledgment; nothing new opened.";
  }
  const recent = await recentRequestsFor(ctx, company._id, customer._id, Date.now() - 14 * DAY);
  for (const intent of reading.intents) {
    if (asking && touched.has(asking._id) && asking.category === intent.category) continue;
    const same = open.find((row) => row.category === intent.category && !touched.has(row._id));
    if (same) {
      // A reply on a request already open: its ask is updated with what is new, and anything prepared on the old one is checked again.
      const updated = await moveRequest(ctx, await received(same, intent.words), { ask: { ...same.ask, ...intent.ask }, material: true, clear: ["pending"], status: "in_progress" });
      touched.set(updated._id, { request: updated, text: intent.words, answer: false });
      continue;
    }
    const resolved = recent.find((row) => !isOpen(row) && row.category === intent.category && row.conversation.address === message.from);
    if (resolved && (intent.category === "complaint" || UNDONE.test(message.text))) {
      const reopened = await reopenRequest(ctx, await received(resolved, intent.words), `${authority.name} wrote again: "${intent.words.slice(0, 160)}"`);
      touched.set(reopened._id, { request: reopened, text: intent.words, answer: false });
      continue;
    }
    const urgency = urgencyOf(intent, reading);
    const request = await openRequest(ctx, {
      companyId: company._id,
      customerId: customer._id,
      authority,
      conversation,
      category: intent.category,
      summary: summaryOf(intent, authority),
      requestedOutcome: OUTCOME[intent.category],
      ask: { ...intent.ask, ...(reading.serious && !intent.ask.serious && intent.category === "complaint" ? { serious: reading.serious } : {}) },
      urgency: urgency.urgency,
      urgencyReason: urgency.reason,
      reader: reading.reader,
      origin: message.channel,
      lastCustomerAt: message.receivedAt,
      nextCheckAt: Date.now() + careSettings(company).respondWithinMinutes * 60_000,
    });
    await addEntry(ctx, request, { kind: "received", text: `${authority.name} wrote: "${message.text.slice(0, 400)}"`, source: { table: "careMessages", id: message._id, label: message.channel === "sms" ? "Text" : "Email" }, at: message.receivedAt });
    if (authority.as === "contact") await addEntry(ctx, request, { kind: "found", text: `${authority.name} is a contact for ${customer.name} (${authority.roles.join(", ") || "no role"})${authority.propertyIds.length ? `, for ${authority.propertyIds.length} ${authority.propertyIds.length === 1 ? "property" : "properties"} only` : ""}. Care acts only within that.` });
    touched.set(request._id, { request, text: intent.words, answer: false });
  }
  // Words that raise nothing Care recognises: a reply on the open request waiting for the client, or a message for a person.
  if (touched.size === 0) {
    const waiting = open.find((row) => row.status === "waiting_customer") ?? open[0];
    if (waiting) {
      const request = await moveRequest(ctx, await received(waiting, message.text), { status: "in_progress", material: true });
      touched.set(request._id, { request, text: message.text, answer: false });
    } else {
      const request = await openRequest(ctx, { companyId: company._id, customerId: customer._id, authority, conversation, category: "general", summary: `Sent a message: "${message.text.replace(/\s+/g, " ").slice(0, 140)}"`, requestedOutcome: OUTCOME.general, ask: {}, urgency: reading.serious ? "urgent" : "normal", urgencyReason: reading.serious ?? undefined, reader: reading.reader, origin: message.channel, lastCustomerAt: message.receivedAt });
      await addEntry(ctx, request, { kind: "received", text: `${authority.name} wrote: "${message.text.slice(0, 400)}"`, source: { table: "careMessages", id: message._id, label: message.channel === "sms" ? "Text" : "Email" }, at: message.receivedAt });
      touched.set(request._id, { request, text: message.text, answer: false });
    }
  }
  await ctx.db.patch(message._id, { status: "read", requestIds: [...touched.keys()] as Id<"careRequests">[], reader: reading.reader });
  if (options.recordOnly) {
    for (const { request } of touched.values()) {
      const fresh = (await ctx.db.get(request._id))!;
      if (isOpen(fresh)) await moveRequest(ctx, fresh, { status: "waiting_owner", waiting: { on: "owner", reason: options.recordOnly, since: Date.now() }, blocker: options.recordOnly, nextAction: "Answer the client yourself from the conversation." }, CARE);
    }
    return `Recorded ${touched.size} ${touched.size === 1 ? "request" : "requests"} for a person: ${options.recordOnly}`;
  }
  for (const { request, text, answer } of touched.values()) await advance(ctx, company, request._id, { text, answer: answer ? reading.answer : null });
  return `${touched.size} ${touched.size === 1 ? "request" : "requests"} worked.`;
}
