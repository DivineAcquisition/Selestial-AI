/**
 * Requests for evidence, an answer or an account, each with its own private link.
 *
 * One open request per person per visit: new gaps join a request that has not gone yet, and nothing more is
 * asked while one is out. A request closes by itself when what it asked for arrives another way. A request
 * nobody answers becomes "unanswered" after one reminder at most, which is a fact about the request and never
 * an admission of anything.
 *
 * Wording never states an allegation or a conclusion: a cleaner is told which visit and what is needed, not
 * what anyone said about them. Imported (historical) visits never produce a request.
 *
 * Cleaners are written to by Quality, under its own permission. A customer question is handed to Retention,
 * which owns the conversation and sends it under its own permission, carrying Quality's link.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { requestApproval } from "../approvalQueue";
import { userError } from "../errors";
import { recordEvent, type Actor } from "../events";
import { newLinkId } from "../sales/links";
import { prepareAction, submitAction, careChannel } from "../retention/actions";
import { RETENTION } from "../retention/cases";
import { dayName } from "../time";
import { addEntry } from "./cases";
import { blameIn } from "./findings";
import { permitQuality } from "./authority";
import { queueQualityMessage } from "./outbox";
import type { RequestPurpose, RequirementResult } from "./schema";
import { qualitySettings } from "./settings";
import { DAY, HOUR, PURPOSE_WORDS, QUALITY, SYSTEM } from "./words";

type Ctx = QueryCtx | MutationCtx;
type Request = Doc<"qualityRequests">;

const OPEN: Request["status"][] = ["prepared", "awaiting_approval", "sent"];

/** Words a request may not carry: an allegation, a conclusion, or a consequence. */
const ALLEGATION = /\b(complain\w*|accus\w*|alleg\w*|report(?:ed)? (?:that )?you|you (?:failed|didn'?t|did not)|caught|violat\w*|investigat\w*)\b/i;

export function wordingProblem(text: string): string | null {
  const blamed = blameIn(text);
  if (blamed) return `A request may not say "${blamed}". Ask for what is needed, not who is at fault.`;
  const alleged = ALLEGATION.exec(text);
  if (alleged) return `A request may not say "${alleged[0]}". Say which visit and what is needed, without what anyone said.`;
  return null;
}

export const ALLOWED: Record<RequestPurpose, string[]> = {
  missing_evidence: ["save_draft", "submit", "upload"],
  question: ["save_draft", "submit", "upload"],
  statement: ["save_draft", "submit", "upload"],
  supplement: ["save_draft", "submit", "upload"],
  correction_outcome: ["confirm_outcome"],
};

export async function openRequestsFor(ctx: Ctx, companyId: Id<"companies">, jobId: Id<"jobs">): Promise<Request[]> {
  const rows = await ctx.db
    .query("qualityRequests")
    .withIndex("by_company_job", (q) => q.eq("companyId", companyId).eq("jobId", jobId))
    .take(100);
  return rows;
}

const sameRecipient = (a: Request["recipient"], b: Request["recipient"]) => (a.kind === "cleaner" && b.kind === "cleaner" ? a.cleanerId === b.cleanerId : a.kind === "customer" && b.kind === "customer" ? a.customerId === b.customerId : false);

/** What a request depends on. If it differs when it is about to go, it is not sent as prepared. */
export async function requestStamp(ctx: Ctx, job: Doc<"jobs">, caseId?: Id<"qualityCases">): Promise<string> {
  const photos = await ctx.db
    .query("evidence")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .take(500);
  const items = await ctx.db
    .query("checklistItems")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .take(300);
  const row = caseId ? await ctx.db.get(caseId) : null;
  return [job.status, job.completionReturns ?? 0, photos.length, items.filter((i) => i.state !== "pending").length, row ? `${row.stage}:${row.heldBy ? "held" : ""}:${row.serious ? "serious" : ""}` : "-"].join("|");
}

export type NewRequest = {
  job: Doc<"jobs">;
  recipient: Request["recipient"];
  purpose: RequestPurpose;
  questions: { id: string; text: string }[];
  evidence: Request["evidence"];
  reviewId?: Id<"qualityReviews">;
  caseId?: Id<"qualityCases">;
  /** Names what this request is for, so the same gap never makes a second request. */
  key: string;
  historical?: boolean;
  actor: Actor;
};

export type Prepared = { request: Request; created: boolean } | { request: null; why: string };

/** Prepares (or joins) one request. Nothing is sent here. */
export async function prepareRequest(ctx: MutationCtx, company: Doc<"companies">, input: NewRequest): Promise<Prepared> {
  if (input.historical) return { request: null, why: "This visit was imported from another system, so nobody is contacted about it." };
  for (const q of input.questions) {
    const problem = wordingProblem(q.text);
    if (problem) throw userError(problem);
  }
  const existing = await ctx.db
    .query("qualityRequests")
    .withIndex("by_company_key", (q) => q.eq("companyId", company._id).eq("key", input.key))
    .first();
  if (existing) return { request: existing, created: false };
  const all = (await openRequestsFor(ctx, company._id, input.job._id)).filter((r) => sameRecipient(r.recipient, input.recipient));
  const open = all.find((r) => OPEN.includes(r.status) && (r.caseId ?? null) === (input.caseId ?? null));
  if (open) {
    // Joins a request that has not gone yet; one already out or waiting for approval is not added to.
    if (open.status === "prepared") {
      const evidence = [...open.evidence, ...input.evidence.filter((e) => !open.evidence.some((x) => x.id === e.id))].slice(0, 20);
      const questions = [...open.questions, ...input.questions.filter((q) => !open.questions.some((x) => x.id === q.id))].slice(0, 8);
      await ctx.db.patch(open._id, { evidence, questions, stamp: await requestStamp(ctx, input.job, input.caseId), updatedAt: Date.now() });
      return { request: (await ctx.db.get(open._id))!, created: false };
    }
    return { request: open, created: false };
  }
  const settings = qualitySettings(company);
  const counted = all.filter((r) => r.status !== "cancelled" && !(r.status === "satisfied" && !r.messageIds.length)).length;
  if (counted >= settings.maxRequestsPerVisit) return { request: null, why: `${settings.maxRequestsPerVisit} requests have already gone to this person about this visit. A person decides whether to ask again.` };
  const now = Date.now();
  const verification: Request["verification"] = input.purpose === "statement" || input.purpose === "supplement" ? (input.recipient.kind === "cleaner" ? "phone_last4" : "zip") : input.purpose === "correction_outcome" ? "zip" : "none";
  const id = await ctx.db.insert("qualityRequests", {
    companyId: company._id,
    caseId: input.caseId,
    reviewId: input.reviewId,
    jobId: input.job._id,
    purpose: input.purpose,
    recipient: input.recipient,
    key: input.key,
    questions: input.questions.map((q) => ({ id: q.id, text: q.text.trim().slice(0, 300) })),
    evidence: input.evidence.slice(0, 20),
    status: "prepared",
    conversationOwner: input.recipient.kind === "customer" ? "retention" : "quality",
    permission: input.recipient.kind === "customer" ? "quality.customer_clarification" : "quality.request_cleaner_evidence",
    messageIds: [],
    allowed: ALLOWED[input.purpose],
    verification,
    verifyFailures: 0,
    reminders: 0,
    dueAt: now + (input.recipient.kind === "cleaner" ? settings.cleanerAnswerHours : 72) * HOUR,
    stamp: await requestStamp(ctx, input.job, input.caseId),
    historical: input.historical,
    createdBy: input.actor,
    createdAt: now,
    updatedAt: now,
  });
  await recordEvent(ctx, { companyId: company._id, type: "quality_request.prepared", actor: input.actor, subject: { table: "qualityRequests", id }, data: { purpose: input.purpose, recipient: input.recipient.kind } });
  const request = (await ctx.db.get(id))!;
  if (request.caseId) {
    const row = await ctx.db.get(request.caseId);
    if (row) await addEntry(ctx, row, { kind: "request", text: `Prepared: ${PURPOSE_WORDS[request.purpose].toLowerCase()} for ${await recipientName(ctx, request)}.`, source: { table: "qualityRequests", id, label: "Request" }, actor: input.actor });
  }
  return { request, created: true };
}

export async function recipientName(ctx: Ctx, request: Pick<Request, "recipient">): Promise<string> {
  if (request.recipient.kind === "cleaner") return (await ctx.db.get(request.recipient.cleanerId))?.name ?? "the cleaner";
  return (await ctx.db.get(request.recipient.customerId))?.name ?? "the customer";
}

const first = (name: string) => name.trim().split(/\s+/)[0] || name;

function cleanerBody(company: Doc<"companies">, cleaner: Doc<"cleaners">, job: Doc<"jobs">, property: Doc<"properties"> | null, request: Request): string {
  const when = dayName(job.startsAt, company.timezone);
  const where = property ? property.address.city : "the property";
  const due = `${dayName(request.dueAt, company.timezone)}`;
  if (request.purpose === "statement" || request.purpose === "supplement") return `Hi ${first(cleaner.name)}, ${company.name} is reviewing the visit in ${where} on ${when} and would like your account of it. Nothing has been decided. Please answer by ${due}: {link}`;
  const n = request.evidence.length + request.questions.length;
  return `Hi ${first(cleaner.name)}, ${company.name} needs ${n === 1 ? "one more thing" : `${n} more things`} from the visit in ${where} on ${when}. It takes a minute: {link}`;
}

/** Routes a prepared request by the Owner's authority: sent now, put in the approvals queue, or not sent. */
export async function routeRequest(ctx: MutationCtx, company: Doc<"companies">, request: Request, actor: Actor): Promise<{ status: Request["status"]; detail: string }> {
  if (request.status !== "prepared") return { status: request.status, detail: request.result ?? "Already routed." };
  if (request.historical) {
    await ctx.db.patch(request._id, { status: "cancelled", result: "Imported visit: nobody is contacted.", updatedAt: Date.now() });
    return { status: "cancelled", detail: "Imported visit: nobody is contacted." };
  }
  if (request.recipient.kind === "customer") return handToRetention(ctx, company, request, actor);
  const row = request.caseId ? await ctx.db.get(request.caseId) : null;
  if (actor.kind === "agent" && row && (row.heldBy || row.serious)) {
    await ctx.db.patch(request._id, { status: "blocked", result: "A person is handling this case, so Quality sends nothing until it is handed back.", updatedAt: Date.now() });
    return { status: "blocked", detail: "A person is handling this case." };
  }
  // A person asking by hand is their own decision; the agent goes through the Owner's authority.
  if (actor.kind === "member") return carryOutRequest(ctx, company, request, actor, `${request.permission}: sent by a person`);
  const permit = await permitQuality(ctx, company, request.permission);
  if (permit.mode === "refuse") {
    await ctx.db.patch(request._id, { status: "blocked", result: permit.why, authorization: permit.label, updatedAt: Date.now() });
    return { status: "blocked", detail: permit.why };
  }
  if (permit.mode === "ask") {
    const cleaner = request.recipient.kind === "cleaner" ? await ctx.db.get(request.recipient.cleanerId) : null;
    const job = (await ctx.db.get(request.jobId))!;
    const items = [...request.evidence.map((e) => e.label), ...request.questions.map((q) => q.text)];
    const approvalId = await requestApproval(ctx, {
      companyId: company._id,
      action: request.permission,
      summary: `Ask ${cleaner?.name ?? "the cleaner"} for ${PURPOSE_WORDS[request.purpose].toLowerCase()} about the visit on ${dayName(job.startsAt, company.timezone)}`,
      reason: `Quality's review found what the standard asks for is not on record: ${items.slice(0, 4).join("; ")}.`,
      authorizes: `Text ${cleaner?.name ?? "the cleaner"} one private link that asks only for: ${items.join("; ")}. Nothing else. It is not sent if the evidence arrives first.`,
      ifWaiting: "Nothing is sent. The review stays open and the gap stays on record.",
      decideBy: Math.max(Date.now() + HOUR, request.dueAt),
      proposal: { kind: "quality_request", requestId: request._id, stamp: request.stamp },
      about: { table: "jobs", id: request.jobId },
    });
    await ctx.db.patch(request._id, { status: "awaiting_approval", approvalId, authorization: permit.label, result: permit.why, updatedAt: Date.now() });
    return { status: "awaiting_approval", detail: permit.why };
  }
  return carryOutRequest(ctx, company, request, actor, permit.label);
}

/** Sends one request, after every check runs again against the record as it is now. */
export async function carryOutRequest(ctx: MutationCtx, company: Doc<"companies">, request: Request, actor: Actor, authorization: string): Promise<{ status: Request["status"]; detail: string }> {
  const job = await ctx.db.get(request.jobId);
  const blocked = async (detail: string, status: Request["status"] = "blocked") => {
    await ctx.db.patch(request._id, { status, result: detail, updatedAt: Date.now() });
    return { status, detail };
  };
  if (!job) return blocked("The visit no longer exists.");
  if (request.historical) return blocked("Imported visit: nobody is contacted.", "cancelled");
  if ((await requestStamp(ctx, job, request.caseId)) !== request.stamp) return blocked("The visit's record changed after this was prepared (evidence arrived, the report was sent back, or the case moved). It was not sent; review it again.", "cancelled");
  if (request.recipient.kind !== "cleaner") return blocked("Only a request to a cleaner is sent by Quality.");
  const cleaner = await ctx.db.get(request.recipient.cleanerId);
  if (!cleaner || cleaner.companyId !== company._id) return blocked("The cleaner is no longer on record.");
  if (cleaner.status === "ended") return blocked("The cleaner's engagement has ended. A person decides whether to contact them.");
  const property = await ctx.db.get(job.propertyId);
  const settings = qualitySettings(company);
  const now = Date.now();
  const publicId = request.publicId ?? newLinkId();
  await ctx.db.patch(request._id, { status: "sent", publicId, expiresAt: request.expiresAt ?? now + settings.linkDays * DAY, authorization, updatedAt: now });
  const fresh = (await ctx.db.get(request._id))!;
  const message = await queueQualityMessage(ctx, { company, request: fresh, cleaner, purpose: "quality_request", body: cleanerBody(company, cleaner, job, property, fresh), dedupeKey: `quality:${request._id}`, actor: actor.kind === "member" ? actor : QUALITY });
  await ctx.db.patch(request._id, { messageIds: [...fresh.messageIds, message._id] });
  if (message.status === "not_sent") return blocked(`The text was not sent: ${message.problem ?? "it could not be sent"}`);
  await recordEvent(ctx, { companyId: company._id, type: "quality_request.sent", actor, subject: { table: "qualityRequests", id: request._id }, data: { purpose: request.purpose } });
  if (request.caseId) {
    const row = await ctx.db.get(request.caseId);
    if (row) await addEntry(ctx, row, { kind: "request", text: `${message.status === "held" ? "Planned (quiet hours)" : "Sent"}: ${PURPOSE_WORDS[request.purpose].toLowerCase()} to ${cleaner.name}. Delivery is shown as the provider reports it.`, source: { table: "messages", id: message._id, label: "Message" }, actor });
  }
  return { status: "sent", detail: message.status === "held" ? `Planned. ${message.problem ?? "It goes when quiet hours end."}` : "Handed to the sender. Delivery is shown on the request." };
}

/**
 * A customer question goes to Retention, which owns the conversation: a message action on its case,
 * carrying Quality's link, sent under Retention's own permission. Retention sees it and sends nothing twice.
 */
async function handToRetention(ctx: MutationCtx, company: Doc<"companies">, request: Request, actor: Actor): Promise<{ status: Request["status"]; detail: string }> {
  const row = request.caseId ? await ctx.db.get(request.caseId) : null;
  const retentionCaseId = row?.retentionCaseId;
  const retention = retentionCaseId ? await ctx.db.get(retentionCaseId) : null;
  if (!retention || retention.status === "closed") {
    await ctx.db.patch(request._id, { status: "blocked", result: "There is no open Retention case for this customer, so the question waits. Retention owns customer conversations.", updatedAt: Date.now() });
    return { status: "blocked", detail: "No open Retention case to carry the question." };
  }
  const customer = request.recipient.kind === "customer" ? await ctx.db.get(request.recipient.customerId) : null;
  if (!customer) return { status: "blocked", detail: "The customer is no longer on record." };
  const channel = await careChannel(ctx, customer);
  if (!channel) {
    await ctx.db.patch(request._id, { status: "blocked", result: "There is no way to reach this customer that they agreed to.", updatedAt: Date.now() });
    return { status: "blocked", detail: "No permitted channel." };
  }
  const now = Date.now();
  await ctx.db.patch(request._id, { publicId: request.publicId ?? newLinkId(), expiresAt: request.expiresAt ?? now + qualitySettings(company).linkDays * DAY });
  const questions = request.questions.map((q) => q.text).join(" ");
  const action = await prepareAction(ctx, retention, {
    kind: "message",
    key: `quality-question:${request._id}`,
    summary: `Ask ${customer.name} a question for Quality's review`,
    reason: `Quality needs the customer's view to review the visit: ${questions}`.slice(0, 900),
    permission: "retention.send_case_message",
    message: { channel, subject: channel === "email" ? "A quick question about your recent service" : undefined, body: `Hi ${first(customer.name)}, thank you for your patience. To look into your recent service properly, could you help with a quick question? ${questions} You can answer, and add photos if you have them, here: {qualityLink} - ${company.name}` },
    actor: RETENTION,
  });
  await ctx.db.patch(request._id, { status: "handed_to_retention", retentionActionId: action._id, result: "With Retention, which owns the conversation with this customer.", updatedAt: now });
  const routed = await submitAction(ctx, company, action._id, actor.kind === "member" ? actor : RETENTION);
  if (row) await addEntry(ctx, row, { kind: "handoff", text: `Handed to Retention: a question for ${customer.name}. Retention sends it under its own permission (${routed.status.replace(/_/g, " ")}).`, source: { table: "retentionActions", id: action._id, label: "Retention action" }, actor });
  return { status: "handed_to_retention", detail: routed.detail };
}

/** Closes open requests whose items are now on record. Returns how many closed. */
export async function closeSatisfied(ctx: MutationCtx, companyId: Id<"companies">, jobId: Id<"jobs">, results: RequirementResult[], pendingMarks: Set<string>): Promise<number> {
  const open = (await openRequestsFor(ctx, companyId, jobId)).filter((r) => OPEN.includes(r.status) && r.questions.length === 0 && r.evidence.length > 0);
  let closed = 0;
  for (const r of open) {
    const done = r.evidence.every((e) => {
      if (e.id.startsWith("mark:")) return !pendingMarks.has(e.id.slice(5));
      const result = results.find((x) => x.requirementId === e.requirementId);
      return result ? result.outcome === "met" : false;
    });
    if (!done) continue;
    const now = Date.now();
    await ctx.db.patch(r._id, { status: "satisfied", result: "What was asked for is now on record, so nothing more is asked.", revokedAt: r.publicId ? now : undefined, revokeReason: r.publicId ? "What was asked for arrived." : undefined, updatedAt: now });
    await recordEvent(ctx, { companyId, type: "quality_request.satisfied", actor: SYSTEM, subject: { table: "qualityRequests", id: r._id }, data: {} });
    closed += 1;
  }
  return closed;
}

/**
 * A sent request past its due time: one reminder, if the Owner's authority allows it; otherwise, or after
 * the reminder, it is recorded as unanswered. That is never read as an admission, and changes nothing else.
 */
export async function upkeepRequests(ctx: MutationCtx, company: Doc<"companies">, now: number): Promise<{ reminded: number; unanswered: number; expired: number }> {
  const due = await ctx.db
    .query("qualityRequests")
    .withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", "sent").lt("dueAt", now))
    .take(100);
  let reminded = 0;
  let unanswered = 0;
  let expired = 0;
  for (const r of due) {
    if (r.expiresAt !== undefined && r.expiresAt <= now) {
      await ctx.db.patch(r._id, { status: "expired", result: "The link expired with no answer.", updatedAt: now });
      expired += 1;
      continue;
    }
    const row = r.caseId ? await ctx.db.get(r.caseId) : null;
    const held = row && (row.heldBy || row.serious || row.stage === "closed");
    if (r.reminders === 0 && !held && r.recipient.kind === "cleaner") {
      const permit = await permitQuality(ctx, company, "quality.remind_outstanding");
      const cleaner = await ctx.db.get(r.recipient.cleanerId);
      if (permit.mode === "act" && cleaner && cleaner.status !== "ended") {
        const job = await ctx.db.get(r.jobId);
        const message = await queueQualityMessage(ctx, { company, request: r, cleaner, purpose: "quality_reminder", body: `Hi ${first(cleaner.name)}, a reminder from ${company.name} about the visit on ${job ? dayName(job.startsAt, company.timezone) : "your recent visit"}: {link}`, dedupeKey: `quality:${r._id}:reminder`, actor: QUALITY });
        await ctx.db.patch(r._id, { reminders: 1, dueAt: now + qualitySettings(company).cleanerAnswerHours * HOUR, messageIds: [...r.messageIds, message._id], updatedAt: now });
        reminded += 1;
        continue;
      }
    }
    await ctx.db.patch(r._id, { status: "unanswered", result: "No answer by the due time. That is not an admission of anything.", updatedAt: now });
    if (row && row.stage !== "closed") await addEntry(ctx, row, { kind: "request", basis: "missing", text: `No answer from ${await recipientName(ctx, r)} by the due time. An unanswered request is not an admission of anything, and nothing about them changes because of it.`, source: { table: "qualityRequests", id: r._id, label: "Request" }, actor: SYSTEM });
    await recordEvent(ctx, { companyId: company._id, type: "quality_request.unanswered", actor: SYSTEM, subject: { table: "qualityRequests", id: r._id }, data: {} });
    unanswered += 1;
  }
  return { reminded, unanswered, expired };
}

export { OPEN as OPEN_REQUEST_STATUSES };
