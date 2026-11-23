/**
 * The private pages a cleaner or customer opens from a Quality request: give an account of what happened,
 * answer focused questions, add photos or files, save progress, and send a supplement later.
 *
 * The link's token is the only authorization (salesLinkQuery / salesLinkMutation, kind "quality"). No id in
 * the arguments is trusted: everything hangs off the request's own row, which names one company, one person
 * and one visit. Opening the page changes nothing and is not recorded. A link that expired, was withdrawn,
 * or whose request closed does nothing. An account submission asks the person to confirm who they are (the
 * last four digits of their phone, or the property's ZIP code); five wrong tries close the link.
 *
 * A submission is evidence, not a finding. It is kept as written and never changed: a correction is a new
 * version marked as a supplement. Everything typed is kept as words and never treated as an instruction.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { salesLinkMutation, salesLinkQuery } from "./lib/builders";
import { readProfile } from "./lib/compliance/profile";
import { recordEvent } from "./lib/events";
import { allow } from "./lib/rateLimit";
import { discardUpload } from "./lib/uploads";
import { addEntry } from "./lib/quality/cases";
import { qualityOnEvidence } from "./lib/quality/hooks";
import { requestLinkState } from "./lib/quality/outbox";
import { enqueueQualityRun } from "./lib/quality/runs";
import { PURPOSE_WORDS } from "./lib/quality/words";
import { dayName } from "./lib/time";

type Access = { request: Doc<"qualityRequests">; company: Doc<"companies"> };
type Result = { ok: true; words: string } | { ok: false; why: string };
const no = (why: string): Result => ({ ok: false, why });

async function resolve(ctx: QueryCtx | MutationCtx, publicId: string): Promise<Access | null> {
  const request = await ctx.db.query("qualityRequests").withIndex("by_publicId", (q) => q.eq("publicId", publicId)).first();
  if (!request) return null;
  const company = await ctx.db.get(request.companyId);
  return company ? { request, company } : null;
}

/** Refuses with words, so a refused attempt still counts toward the limit. */
async function gate(ctx: MutationCtx, access: Access, action: string): Promise<string | null> {
  const { request, company } = access;
  const state = requestLinkState(request, Date.now());
  if (state === "expired") return "This link has expired. Ask the office for a new one.";
  if (state !== "active") return "This link is no longer active.";
  if (company.suspendedAt) return "This page is not available right now.";
  if (!request.allowed.includes(action)) return "This link cannot be used for that.";
  if (!(await allow(ctx, `quality-link:${request._id}`, 30, 10 * 60_000))) return "Too many changes in a short time. Wait a few minutes and try again.";
  return null;
}

const first = (name: string) => name.trim().split(/\s+/)[0] || name;
const clean = (text: string, max: number) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);

export const view = salesLinkQuery({
  kind: "quality",
  resolve,
  args: {},
  handler: async (ctx) => {
    if (!ctx.link) return null;
    const { request, company } = ctx.link;
    const job = await ctx.db.get(request.jobId);
    const property = job ? await ctx.db.get(job.propertyId) : null;
    const profile = await readProfile(ctx, company._id);
    const who = request.recipient.kind === "cleaner" ? await ctx.db.get(request.recipient.cleanerId) : await ctx.db.get(request.recipient.customerId);
    const submissions = await ctx.db.query("qualitySubmissions").withIndex("by_company_request", (q) => q.eq("companyId", company._id).eq("requestId", request._id)).take(20);
    const files = await ctx.db.query("qualityFiles").withIndex("by_company_request", (q) => q.eq("companyId", company._id).eq("requestId", request._id)).take(40);
    const photos = job ? await ctx.db.query("evidence").withIndex("by_company_job", (q) => q.eq("companyId", company._id).eq("jobId", job._id)).take(500) : [];
    const state = requestLinkState(request, Date.now());
    return {
      state,
      purpose: request.purpose,
      purposeWords: PURPOSE_WORDS[request.purpose],
      recipient: request.recipient.kind,
      firstName: who ? first(who.name) : null,
      company: { name: profile.messaging.senderName ?? company.name, phone: profile.identity.supportPhone ?? null, email: profile.identity.supportEmail ?? null },
      // Which visit, in the fewest words: the day and the town. Nothing anyone said about it.
      visit: job ? { day: dayName(job.startsAt, company.timezone), city: property?.address.city ?? null, service: job.serviceSnapshot?.name ?? job.serviceType } : null,
      questions: request.questions,
      evidence: request.evidence.map((e) => ({ id: e.id, label: e.label, photoKind: e.photoKind ?? null, uploaded: e.photoKind ? photos.filter((p) => p.kind === e.photoKind && p.uploadedAt >= request.createdAt).length : 0 })),
      draft: request.draft ?? null,
      files: files.filter((f) => f.submittedAt === undefined).map((f) => ({ id: f._id, name: f.name, size: f.size })),
      submitted: submissions.map((s) => ({ version: s.version, kind: s.kind, at: s.submittedAt, answers: s.answers.length, files: s.fileIds.length })),
      verification: request.verification,
      dueAt: request.dueAt,
      expiresAt: request.expiresAt ?? null,
      allowed: state === "active" ? request.allowed : [],
      timezone: company.timezone,
      note: request.purpose === "statement" || request.purpose === "supplement" ? "Nothing has been decided. Your account is kept as you write it, and anything you add later is kept alongside it, not in place of it." : null,
    };
  },
});

export const saveDraft = salesLinkMutation({
  kind: "quality",
  resolve,
  args: { answers: v.array(v.object({ questionId: v.string(), text: v.string() })), account: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Result> => {
    const refused = await gate(ctx, ctx.link, "save_draft");
    if (refused) return no(refused);
    const { request } = ctx.link;
    const answers = args.answers.filter((a) => request.questions.some((q) => q.id === a.questionId)).slice(0, 10).map((a) => ({ questionId: a.questionId, text: clean(a.text, 4000) }));
    await ctx.db.patch(request._id, { draft: { answers, account: args.account ? clean(args.account, 8000) : undefined, savedAt: Date.now() } });
    return { ok: true, words: "Saved. You can come back to this link to finish." };
  },
});

export const uploadUrl = salesLinkMutation({
  kind: "quality",
  resolve,
  args: {},
  handler: async (ctx): Promise<{ ok: true; url: string } | { ok: false; why: string }> => {
    const refused = await gate(ctx, ctx.link, "upload");
    if (refused) return { ok: false, why: refused };
    return { ok: true, url: await ctx.storage.generateUploadUrl() };
  },
});

const PHOTO_TYPES = /^image\/(jpeg|png|webp|heic|heif)$/;
const FILE_TYPES = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf|video\/(mp4|quicktime))$/;

/**
 * Keeps an uploaded file. A photo for a missing-evidence request goes on the visit's own record (as a crew
 * photo would), so the review sees it; anything else is kept on the request. A time the device reported is
 * kept as the person's statement, never as a fact.
 */
export const attachFile = salesLinkMutation({
  kind: "quality",
  resolve,
  args: { storageId: v.id("_storage"), name: v.string(), contentType: v.string(), clientKey: v.string(), evidenceId: v.optional(v.string()), statedCapturedAt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Result> => {
    const refused = await gate(ctx, ctx.link, "upload");
    if (refused) {
      await discardUpload(ctx, args.storageId);
      return no(refused);
    }
    const { request, company } = ctx.link;
    const meta = await ctx.db.system.get(args.storageId);
    if (!meta) return no("The upload did not arrive. Try again.");
    const used = (await ctx.db.query("evidence").withIndex("by_storage", (q) => q.eq("storageId", args.storageId)).first()) ?? (await ctx.db.query("qualityFiles").withIndex("by_storage", (q) => q.eq("storageId", args.storageId)).first());
    if (used) return no("That file is already on record.");
    const clientKey = args.clientKey.slice(0, 64);
    const item = args.evidenceId ? request.evidence.find((e) => e.id === args.evidenceId) : undefined;
    if (request.purpose === "missing_evidence" && item?.photoKind && request.recipient.kind === "cleaner") {
      if (!PHOTO_TYPES.test(args.contentType) || meta.size > 15 * 1024 * 1024) {
        await discardUpload(ctx, args.storageId);
        return no("Photos must be JPEG, PNG, WebP or HEIC, and under 15 MB.");
      }
      const cleanerId = request.recipient.cleanerId;
      const assignment = (await ctx.db.query("assignments").withIndex("by_company_job", (q) => q.eq("companyId", company._id).eq("jobId", request.jobId)).take(30)).find((a) => a.cleanerId === cleanerId && a.status === "accepted");
      if (!assignment) {
        await discardUpload(ctx, args.storageId);
        return no("This visit no longer lists you on its crew. Contact the office.");
      }
      const duplicate = await ctx.db.query("evidence").withIndex("by_company_assignment_key", (q) => q.eq("companyId", company._id).eq("assignmentId", assignment._id).eq("clientKey", clientKey)).first();
      if (duplicate) return { ok: true, words: "Already added." };
      const checklistItemId = item.id.startsWith("photo:") ? ctx.db.normalizeId("checklistItems", item.id.slice(6)) ?? undefined : undefined;
      await ctx.db.insert("evidence", { companyId: company._id, jobId: request.jobId, assignmentId: assignment._id, cleanerId, kind: item.photoKind, checklistItemId, storageId: args.storageId, clientKey, uploadedAt: Date.now() });
      await ctx.db.patch(request._id, { lastActionAt: Date.now(), lastAction: "upload" });
      await recordEvent(ctx, { companyId: company._id, type: "job.photo_added", actor: { kind: "quality_link", requestId: request._id }, subject: { table: "jobs", id: request.jobId }, data: { kind: item.photoKind, via: "quality_request" } });
      const job = await ctx.db.get(request.jobId);
      if (job) await qualityOnEvidence(ctx, job);
      return { ok: true, words: "Added to the visit. It shows when it was uploaded; when it was taken is not recorded." };
    }
    if (!FILE_TYPES.test(args.contentType) || meta.size > 25 * 1024 * 1024) {
      await discardUpload(ctx, args.storageId);
      return no("Files must be a photo, a PDF or a short video, and under 25 MB.");
    }
    const count = await ctx.db.query("qualityFiles").withIndex("by_company_request", (q) => q.eq("companyId", company._id).eq("requestId", request._id)).take(41);
    if (count.length >= 40) {
      await discardUpload(ctx, args.storageId);
      return no("This request already has 40 files.");
    }
    if (count.some((f) => f.clientKey === clientKey)) return { ok: true, words: "Already added." };
    await ctx.db.insert("qualityFiles", { companyId: company._id, requestId: request._id, storageId: args.storageId, name: clean(args.name, 120) || "file", contentType: args.contentType, size: meta.size, statedCapturedAt: args.statedCapturedAt, uploadedAt: Date.now(), clientKey });
    await ctx.db.patch(request._id, { lastActionAt: Date.now(), lastAction: "upload" });
    return { ok: true, words: "Added. It is sent with your answer." };
  },
});

export const removeFile = salesLinkMutation({
  kind: "quality",
  resolve,
  args: { fileId: v.id("qualityFiles") },
  handler: async (ctx, args): Promise<Result> => {
    const refused = await gate(ctx, ctx.link, "upload");
    if (refused) return no(refused);
    const file = await ctx.db.get(args.fileId);
    // Only a file on this request, not yet sent. A sent file is part of a submission and is never removed here.
    if (!file || file.requestId !== ctx.link.request._id || file.submittedAt !== undefined) return no("That file can't be removed.");
    await ctx.db.delete(file._id);
    await ctx.storage.delete(file.storageId);
    return { ok: true, words: "Removed." };
  },
});

async function verified(ctx: MutationCtx, access: Access, code: string | undefined): Promise<string | null> {
  const { request } = access;
  if (request.verification === "none") return null;
  const given = (code ?? "").replace(/\D/g, "");
  let expected: string | null = null;
  if (request.verification === "phone_last4" && request.recipient.kind === "cleaner") expected = ((await ctx.db.get(request.recipient.cleanerId))?.phone ?? "").replace(/\D/g, "").slice(-4) || null;
  if (request.verification === "zip") {
    const job = await ctx.db.get(request.jobId);
    const property = job ? await ctx.db.get(job.propertyId) : null;
    expected = property?.address.postalCode.replace(/\D/g, "").slice(0, 5) || null;
  }
  if (!expected) return "This can't be confirmed online. Contact the office to give your account.";
  if (given === expected) return null;
  const failures = request.verifyFailures + 1;
  await ctx.db.patch(request._id, { verifyFailures: failures, ...(failures >= 5 ? { revokedAt: Date.now(), revokeReason: "Too many wrong confirmations." } : {}) });
  return failures >= 5 ? "Too many wrong tries. This link is closed; contact the office for a new one." : request.verification === "zip" ? "That ZIP code doesn't match the property." : "Those digits don't match the phone number on record.";
}

export const submit = salesLinkMutation({
  kind: "quality",
  resolve,
  args: { answers: v.array(v.object({ questionId: v.string(), text: v.string() })), account: v.optional(v.string()), code: v.optional(v.string()), clientKey: v.string() },
  handler: async (ctx, args): Promise<Result> => {
    const refused = await gate(ctx, ctx.link, "submit");
    if (refused) return no(refused);
    const { request, company } = ctx.link;
    const clientKey = args.clientKey.slice(0, 64);
    const repeat = await ctx.db.query("qualitySubmissions").withIndex("by_company_clientKey", (q) => q.eq("companyId", company._id).eq("clientKey", clientKey)).first();
    if (repeat) return { ok: true, words: "Already sent. Thank you." };
    const wrong = await verified(ctx, ctx.link, args.code);
    if (wrong) return no(wrong);
    const answers = request.questions.map((q) => ({ questionId: q.id, question: q.text, text: clean(args.answers.find((a) => a.questionId === q.id)?.text ?? "", 4000) })).filter((a) => a.text);
    const account = args.account ? clean(args.account, 8000) : undefined;
    const files = (await ctx.db.query("qualityFiles").withIndex("by_company_request", (q) => q.eq("companyId", company._id).eq("requestId", request._id)).take(40)).filter((f) => f.submittedAt === undefined);
    if (!answers.length && !account && !files.length) return no("Write an answer or add a file before sending.");
    const earlier = await ctx.db.query("qualitySubmissions").withIndex("by_company_request", (q) => q.eq("companyId", company._id).eq("requestId", request._id)).take(50);
    const now = Date.now();
    const submissionId = await ctx.db.insert("qualitySubmissions", { companyId: company._id, requestId: request._id, caseId: request.caseId, jobId: request.jobId, version: earlier.length + 1, kind: earlier.length ? "supplement" : "original", by: request.recipient, answers, account, fileIds: files.map((f) => f._id), clientKey, submittedAt: now });
    for (const f of files) await ctx.db.patch(f._id, { submittedAt: now });
    await ctx.db.patch(request._id, { status: "answered", answeredAt: request.answeredAt ?? now, draft: undefined, lastActionAt: now, lastAction: "submit", updatedAt: now });
    await recordEvent(ctx, { companyId: company._id, type: "quality_request.answered", actor: { kind: "quality_link", requestId: request._id }, subject: { table: "qualitySubmissions", id: submissionId }, data: { version: earlier.length + 1, files: files.length } });
    if (request.caseId) {
      const row = await ctx.db.get(request.caseId);
      if (row) {
        const who = request.recipient.kind === "cleaner" ? (await ctx.db.get(request.recipient.cleanerId))?.name ?? "The cleaner" : (await ctx.db.get(request.recipient.customerId))?.name ?? "The customer";
        await addEntry(ctx, row, { kind: "statement", basis: request.recipient.kind === "cleaner" ? "cleaner_stated" : "customer_stated", text: `${who} sent ${earlier.length ? "a supplement to their account" : "their account"}${files.length ? ` with ${files.length} ${files.length === 1 ? "file" : "files"}` : ""}. An account is evidence, not a finding.`, source: { table: "qualitySubmissions", id: submissionId, label: "Submission", at: now }, actor: { kind: "quality_link", requestId: request._id } });
        await enqueueQualityRun(ctx, { companyId: company._id, kind: "statement_submitted", key: `statement:${submissionId}`, caseId: row._id, jobId: request.jobId });
      }
    }
    return { ok: true, words: earlier.length ? "Your supplement was sent. Your earlier answer is kept as it was." : "Sent. Thank you. You can add to it later from this link if something else comes to mind." };
  },
});

/** The stored file behind a signed address (convex/http.ts /quality-files/). */
export const fileStorage = internalQuery({
  args: { fileId: v.string() },
  handler: async (ctx, args): Promise<Id<"_storage"> | null> => {
    const id = ctx.db.normalizeId("qualityFiles", args.fileId);
    const row = id ? await ctx.db.get(id) : null;
    return row && row.submittedAt !== undefined ? row.storageId : null;
  },
});
