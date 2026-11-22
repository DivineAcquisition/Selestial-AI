/**
 * The texting setup's onboarding case, from the company's side (docs/texting/02-case.md): Evidence & notes,
 * recommendations, exceptions and the number journeys. The same functions serve an Admin Support Session,
 * under the support rules in convex/lib/builders.ts plus the checks here.
 *
 * Who sees what:
 *  - The Owner sees company-visible evidence and notes, and every exception's owner-facing words.
 *  - Staff in a support session also see internal notes and staff-only evidence, but only with the
 *    `onboarding.evidence` capability; opening an evidence file in a session needs content revealed (a
 *    reason and a second factor, listed in the owner's support history), because a screenshot can show a
 *    customer's details.
 *  - Nobody else. Managers and Office do not see the case: it registers the business.
 *
 * Owner-only, never opened to support: approving or confirming a recommendation, approving a public review
 * copy, answering an exception as the owner, choosing a number journey, and anything that submits, buys or
 * charges.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { companyMutation, companyQuery, type MemberAccess } from "./lib/builders";
import { notAllowed, notFound, userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { allow } from "./lib/rateLimit";
import { isOwner } from "./lib/roles";
import { literals } from "./lib/statuses";
import { currentEvidence, evidenceRows, syncRecommendations } from "./lib/texting/case";
import { EVIDENCE_PURPOSE_WORDS, EVIDENCE_PURPOSES, EVIDENCE_STATE_WORDS, NUMBER_ROUTES } from "./lib/texting/caseSchema";
import { checkEvidenceFile, EVIDENCE_ACCEPTED, EVIDENCE_MAX_BYTES, REVIEW_COPY_WORDING, reviewToken, signedEvidenceUrl } from "./lib/texting/evidence";
import { PERMISSION_PLACES } from "./lib/texting/schema";

const HOUR = 3_600_000;
type Ctx = (QueryCtx | MutationCtx) & MemberAccess;

/** The exact words an owner accepts before asking to bring an existing number. */
export const PORT_WORDING =
  "I understand that moving a number to Selestial's provider can interrupt calls and texts on it for a while, that the date is set by my current carrier and isn't guaranteed, that I need the account holder's details, account number and PIN from my current carrier, and that nothing is moved until I sign a separate authorization.";

// ── Access ────────────────────────────────────────────────────────────────────────────────────────

/** Owner, or staff in a support session. Answers whether the caller may see Selestial's internal side. */
function access(ctx: Ctx): { staff: boolean } {
  if (ctx.support) return { staff: ctx.support.capabilities.has("onboarding.evidence") };
  if (!isOwner(ctx.role)) notAllowed();
  return { staff: false };
}

async function setupFor(ctx: Ctx): Promise<Doc<"textingSetups">> {
  const setup = await ctx.db
    .query("textingSetups")
    .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
    .unique();
  if (!setup) throw userError("Open Set up business texting first.");
  return setup;
}

async function evidenceOf(ctx: Ctx, id: Id<"textingEvidence">, staff: boolean): Promise<Doc<"textingEvidence">> {
  const row = await ctx.db.get(id);
  // Another company's item, or a staff-only item asked for by the company, is "Not found." like any other.
  if (!row || row.companyId !== ctx.companyId || (row.visibility === "internal" && !staff)) notFound();
  return row;
}

function author(ctx: Ctx): Doc<"textingNotes">["author"] {
  return ctx.support ? { kind: "member", memberId: ctx.member._id, supportSessionId: ctx.support.session._id, staffId: ctx.support.staff._id } : { kind: "member", memberId: ctx.member._id };
}

const addedByOf = (ctx: Ctx): Doc<"textingEvidence">["addedBy"] => (ctx.support ? { kind: "member", memberId: ctx.member._id, supportSessionId: ctx.support.session._id } : { kind: "member", memberId: ctx.member._id });

function checkUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
  } catch {
    throw userError("That isn't a web address.");
  }
  if (url.protocol !== "https:") throw userError("Evidence links must start with https://.");
  return url.toString().slice(0, 500);
}

const cleanWords = (value: string | undefined, label: string, max: number) => {
  const text = (value ?? "").trim().replace(/\s+\n/g, "\n");
  if (text.length > max) throw userError(`${label} can be up to ${max} characters.`);
  return text;
};

// ── Reading the case ──────────────────────────────────────────────────────────────────────────────

const shapeEvidence = (row: Doc<"textingEvidence">) => ({
  id: row._id,
  key: row.key,
  version: row.version,
  purpose: row.purpose,
  purposeLabel: EVIDENCE_PURPOSE_WORDS[row.purpose].label,
  describes: row.describes,
  kind: row.kind,
  file: row.file ? { name: row.file.name, contentType: row.file.contentType, size: row.file.size } : null,
  url: row.url ?? null,
  links: row.links,
  visibility: row.visibility,
  state: row.state,
  stateLabel: EVIDENCE_STATE_WORDS[row.state],
  stateNote: row.stateNote ?? null,
  addedAt: row.addedAt,
  addedBySupport: row.addedBy.kind === "staff" || row.addedBy.supportSessionId !== undefined,
  reviewedAt: row.reviewedAt ?? null,
  submitted: row.lockedIn,
  replacedAt: row.replacedAt ?? null,
  reviewCopy: row.reviewCopy ? { of: row.reviewCopy.of, exposure: row.reviewCopy.exposure, approvedAt: row.reviewCopy.approval?.at ?? null } : null,
});

/**
 * Everything on the case the caller may see. Internal notes, staff-only evidence and staff words on
 * exceptions are left out entirely for the company: they are not hidden on the screen, they are never sent.
 */
export const workspace = companyQuery({
  args: {},
  handler: async (ctx) => {
    const { staff } = access(ctx);
    const setup = await ctx.db
      .query("textingSetups")
      .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
      .unique();
    if (!setup) return null;
    const rows = (await evidenceRows(ctx, setup._id)).filter((row) => staff || row.visibility === "company");
    const notes = (await ctx.db.query("textingNotes").withIndex("by_setup_created", (q) => q.eq("setupId", setup._id)).take(300))
      .filter((note) => (staff || note.audience === "company") && (note.status === "posted" || (note.author.kind === "member" && note.author.memberId === ctx.member._id && (!ctx.support || note.author.supportSessionId === ctx.support.session._id))))
      .map((note) => ({
        id: note._id,
        audience: note.audience,
        body: note.body,
        status: note.status,
        mine: note.author.kind === "member" && note.author.memberId === ctx.member._id && (ctx.support ? note.author.supportSessionId === ctx.support.session._id : true),
        // The company sees "Selestial Support" for anything written in a session; staff see who it was.
        by: note.author.kind === "staff" || note.author.supportSessionId ? "Selestial" : "Owner",
        edited: note.revisions.length > 0,
        locked: note.lockedAt !== undefined,
        links: note.links,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      }));
    const exceptions = (await ctx.db.query("textingExceptions").withIndex("by_setup_updated", (q) => q.eq("setupId", setup._id)).order("desc").take(100)).map((row) => ({
      id: row._id,
      category: row.category,
      severity: row.severity,
      field: row.field ?? null,
      evidenceKey: row.evidenceKey ?? null,
      submissionVersion: row.submissionVersion ?? null,
      assignee: row.assignee.kind === "staff" ? "Selestial" : row.assignee.kind === "agent" ? row.assignee.agent : "You",
      ownerWords: row.ownerWords,
      internalWords: staff ? (row.internalWords ?? null) : null,
      ask: row.ask ?? null,
      response: row.response ? { words: row.response.words, evidenceKey: row.response.evidenceKey ?? null, at: row.response.at } : null,
      blocker: row.blocker,
      canContinue: row.canContinue,
      nextAction: row.nextAction,
      followUpAt: row.followUpAt ?? null,
      state: row.state,
      assisted: row.assisted ?? null,
      resolution: row.resolution ?? null,
      reopened: row.reopened,
      history: row.history.map((entry) => ({ at: entry.at, state: entry.state, words: entry.words })),
      updatedAt: row.updatedAt,
    }));
    const recommendations = (await ctx.db.query("textingRecommendations").withIndex("by_setup_key", (q) => q.eq("setupId", setup._id)).take(300))
      .filter((row) => row.status !== "resolved")
      .map((row) => ({
        id: row._id,
        key: row.key,
        responsible: row.responsible,
        stage: row.stage,
        field: row.field ?? null,
        issue: row.issue,
        basisWords: row.basisWords,
        proposal: row.proposal,
        proposalWords: row.proposalWords,
        effect: row.effect,
        approval: row.approval,
        status: row.status,
        nextAction: row.nextAction,
        revision: row.revision,
        fingerprint: row.fingerprint,
        stale: row.revision < setup.revision && row.status === "stale",
        clarification: row.clarification ? { question: row.clarification.question, at: row.clarification.at } : null,
        updatedAt: row.updatedAt,
      }));
    return {
      viewer: ctx.support ? { kind: "support" as const, manage: ctx.support.session.mode === "manage", staff, revealed: ctx.support.revealed } : { kind: "owner" as const, manage: true, staff: false, revealed: true },
      revision: setup.revision,
      route: setup.numberRoute ?? "new_local",
      evidence: currentEvidence(rows).map(shapeEvidence),
      history: rows.filter((row) => row.replacedAt !== undefined).map(shapeEvidence),
      notes,
      exceptions,
      recommendations,
      catalog: { purposes: EVIDENCE_PURPOSES.map((key) => ({ key, ...EVIDENCE_PURPOSE_WORDS[key] })), places: PERMISSION_PLACES, accepted: EVIDENCE_ACCEPTED, maxBytes: EVIDENCE_MAX_BYTES, reviewCopyWording: REVIEW_COPY_WORDING, portWording: PORT_WORDING },
    };
  },
});

/**
 * A short-lived address for one evidence file. In a support session the file opens only while content is
 * revealed (a reason and a second factor, in the owner's history). The address is returned to the caller
 * and never logged. A deployment that cannot sign answers that the file can't be opened, never a lasting link.
 */
export const fileLink = companyQuery({
  args: { evidenceId: v.id("textingEvidence") },
  handler: async (ctx, args) => {
    const { staff } = access(ctx);
    if (ctx.support && !staff) notAllowed();
    if (ctx.support && !ctx.support.revealed) throw userError("Evidence can show a customer's details. Reveal content with a reason first; the owner sees it in their support history.", "not_allowed");
    const row = await evidenceOf(ctx, args.evidenceId, staff);
    if (row.kind !== "file" || !row.file) throw userError("This item has no file.");
    const signed = await signedEvidenceUrl(row._id, Date.now());
    if (!signed) throw userError("Files can't be opened on this deployment yet: secure links aren't configured.");
    return { ...signed, name: row.file.name, contentType: row.file.contentType };
  },
});

// ── Evidence ──────────────────────────────────────────────────────────────────────────────────────

export const uploadUrl = companyMutation({
  args: {},
  handler: async (ctx) => {
    access(ctx);
    if (!(await allow(ctx, `texting-evidence-upload:${ctx.companyId}`, 30, HOUR))) throw userError("That's a lot of uploads in an hour. Try again a little later.", "limit");
    return ctx.storage.generateUploadUrl();
  },
});

/**
 * Adds an evidence item, or a new version of one. A file's declared type and size are checked now and its
 * own first bytes right after (`inspect`); a file that isn't what it says is removed. Replacing an item adds
 * a version: the one it replaces stays exactly as it was, so a submission that filed it still points at it.
 */
export const addEvidence = companyMutation({
  support: { capability: "records.edit", summary: "added evidence to your texting setup" },
  args: {
    purpose: literals(EVIDENCE_PURPOSES),
    describes: v.string(),
    storageId: v.optional(v.id("_storage")),
    name: v.optional(v.string()),
    url: v.optional(v.string()),
    placeholder: v.optional(v.boolean()),
    field: v.optional(v.string()),
    place: v.optional(v.string()),
    exceptionId: v.optional(v.id("textingExceptions")),
    /** The item this is a new version of. */
    replaces: v.optional(v.string()),
    /** The original this is a blank or redacted copy of. */
    reviewCopyOf: v.optional(v.id("textingEvidence")),
    /** Staff in a session may keep an item to Selestial only. */
    internal: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { staff } = access(ctx);
    if (args.internal && !staff) notAllowed();
    const setup = await setupFor(ctx);
    const kinds = [args.storageId, args.url, args.placeholder].filter(Boolean).length;
    if (kinds !== 1) throw userError("Add a file, a link, or a placeholder for evidence still to come.");
    const describes = cleanWords(args.describes, "What it shows", 600) || EVIDENCE_PURPOSE_WORDS[args.purpose].proves;
    if (args.place && !(PERMISSION_PLACES as readonly string[]).includes(args.place)) throw userError("Choose where people agree to texts.");
    if (args.field && args.field.length > 60) throw userError("That field name is too long.");
    if (args.exceptionId) {
      const exception = await ctx.db.get(args.exceptionId);
      if (!exception || exception.companyId !== ctx.companyId) notFound();
    }
    let reviewCopy: Doc<"textingEvidence">["reviewCopy"];
    if (args.reviewCopyOf) {
      const original = await evidenceOf(ctx, args.reviewCopyOf, staff);
      if (original.reviewCopy) throw userError("Make the review copy from the original, not from another copy.");
      if (!args.storageId) throw userError("A review copy is a file: a blank or redacted screenshot or PDF.");
      reviewCopy = { of: original._id, exposure: "private" };
    }
    let file: Doc<"textingEvidence">["file"];
    if (args.storageId) {
      const meta = await ctx.db.system.get(args.storageId);
      if (!meta) throw userError("That upload was not found. Try again.");
      const taken = await ctx.db.query("textingEvidence").withIndex("by_storage", (q) => q.eq("file.storageId", args.storageId!)).first();
      if (taken) throw userError("That file was already added.");
      const name = (args.name ?? "").trim().slice(0, 200) || "Evidence";
      // Contents are checked in `inspect`; an obviously wrong type or size is refused now.
      const early = checkEvidenceFile({ name, contentType: meta.contentType ?? "", size: meta.size, head: new Uint8Array(16) });
      if (!early.ok && !/contents do not match|binary/.test(early.why)) {
        await ctx.storage.delete(args.storageId);
        throw userError(early.why);
      }
      file = { storageId: args.storageId, name, contentType: meta.contentType ?? "application/octet-stream", size: meta.size, sha256: meta.sha256 };
    }
    let key = `ev-${setup._id.slice(-6)}-${Date.now().toString(36)}`;
    let version = 1;
    let links: Doc<"textingEvidence">["links"] = { field: args.field, place: args.place, exceptionId: args.exceptionId };
    if (args.replaces) {
      const versions = await ctx.db
        .query("textingEvidence")
        .withIndex("by_company_key_version", (q) => q.eq("companyId", ctx.companyId).eq("key", args.replaces!))
        .order("desc")
        .take(50);
      const current = versions.find((row) => row.replacedAt === undefined);
      if (!current || (current.visibility === "internal" && !staff)) notFound();
      key = current.key;
      version = versions[0].version + 1;
      links = { field: args.field ?? current.links.field, place: args.place ?? current.links.place, exceptionId: args.exceptionId ?? current.links.exceptionId };
      if (current.reviewCopy && !reviewCopy) reviewCopy = { of: current.reviewCopy.of, exposure: "private" };
      // Nothing about the old version changes but that it is no longer current. A public review copy stops being served.
      await ctx.db.patch(current._id, { replacedAt: Date.now(), ...(current.reviewCopy?.exposure === "approved" ? { reviewCopy: { ...current.reviewCopy, exposure: "withdrawn" as const } } : {}) });
    }
    const now = Date.now();
    const id = await ctx.db.insert("textingEvidence", {
      companyId: ctx.companyId,
      setupId: setup._id,
      key,
      version,
      purpose: args.purpose,
      describes,
      kind: file ? "file" : args.url ? "url" : "placeholder",
      ...(file ? { file } : {}),
      ...(args.url ? { url: checkUrl(args.url) } : {}),
      links,
      visibility: args.internal ? "internal" : "company",
      state: args.placeholder ? "missing" : "submitted",
      addedBy: addedByOf(ctx),
      addedAt: now,
      lockedIn: [],
      ...(reviewCopy ? { reviewCopy } : {}),
    });
    if (file) await ctx.scheduler.runAfter(0, internal.textingCase.inspect, { evidenceId: id });
    if (args.exceptionId && !args.placeholder) {
      const exception = await ctx.db.get(args.exceptionId);
      if (exception && exception.state === "waiting_owner" && exception.ask?.kind === "evidence") await ctx.db.patch(exception._id, { evidenceKey: key, updatedAt: now });
    }
    // The event says an item was added, and what for. Never the file's name, contents or address.
    await recordEvent(ctx, { companyId: ctx.companyId, type: "texting.evidence_added", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { purpose: args.purpose, version } });
    await syncRecommendations(ctx, setup._id);
    return { evidenceId: id, key, version };
  },
});

export const toInspect = internalQuery({
  args: { evidenceId: v.id("textingEvidence") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.evidenceId);
    return row?.file && row.state === "submitted" ? { storageId: row.file.storageId, name: row.file.name, contentType: row.file.contentType, size: row.file.size } : null;
  },
});

/** Reads the stored file's first bytes: a file that isn't what it says is removed and the item asks for a replacement. */
export const inspect = internalAction({
  args: { evidenceId: v.id("textingEvidence") },
  handler: async (ctx, args): Promise<null> => {
    const file = await ctx.runQuery(internal.textingCase.toInspect, args);
    if (!file) return null;
    const blob = await ctx.storage.get(file.storageId);
    const head = blob ? new Uint8Array(await blob.slice(0, 16).arrayBuffer()) : new Uint8Array();
    const checked = blob ? checkEvidenceFile({ name: file.name, contentType: file.contentType, size: file.size, head }) : { ok: false as const, why: "The file could not be read from storage." };
    if (!checked.ok) await ctx.runMutation(internal.textingCase.rejectFile, { evidenceId: args.evidenceId, why: checked.why });
    return null;
  },
});

export const rejectFile = internalMutation({
  args: { evidenceId: v.id("textingEvidence"), why: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.evidenceId);
    if (!row?.file || row.lockedIn.length) return null;
    await ctx.storage.delete(row.file.storageId).catch(() => undefined);
    await ctx.db.patch(row._id, { kind: "placeholder", file: undefined, state: "needs_replacement", stateNote: args.why.slice(0, 300) });
    return null;
  },
});

/** Changes what an item says it shows, or what it is linked to. A filed version is never changed: add a new version. */
export const describeEvidence = companyMutation({
  support: { capability: "records.edit", summary: "edited the description of texting evidence" },
  args: { evidenceId: v.id("textingEvidence"), describes: v.optional(v.string()), field: v.optional(v.string()), place: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { staff } = access(ctx);
    const row = await evidenceOf(ctx, args.evidenceId, staff);
    if (row.lockedIn.length || row.replacedAt) throw userError("This version was filed with a submission, so it stays as filed. Add a new version instead.");
    if (args.place && !(PERMISSION_PLACES as readonly string[]).includes(args.place)) throw userError("Choose where people agree to texts.");
    await ctx.db.patch(row._id, {
      ...(args.describes !== undefined ? { describes: cleanWords(args.describes, "What it shows", 600) || row.describes } : {}),
      links: { ...row.links, ...(args.field !== undefined ? { field: args.field.slice(0, 60) || undefined } : {}), ...(args.place !== undefined ? { place: args.place || undefined } : {}) },
    });
    return null;
  },
});

/** Removes an item that was never filed or reviewed. Anything filed or reviewed is kept for the record. */
export const removeEvidence = companyMutation({
  args: { evidenceId: v.id("textingEvidence") },
  handler: async (ctx, args) => {
    access(ctx);
    const row = await evidenceOf(ctx, args.evidenceId, false);
    if (row.lockedIn.length || row.reviewedAt || row.replacedAt) throw userError("This item was filed or reviewed, so it's kept for the record. Add a new version instead.");
    const versions = await ctx.db.query("textingEvidence").withIndex("by_company_key_version", (q) => q.eq("companyId", ctx.companyId).eq("key", row.key)).take(50);
    if (versions.length > 1) throw userError("Earlier versions of this item are kept for the record. Add a new version instead.");
    if (row.file) await ctx.storage.delete(row.file.storageId).catch(() => undefined);
    await ctx.db.delete(row._id);
    await syncRecommendations(ctx, row.setupId);
    return null;
  },
});

/**
 * The owner approves showing a review copy publicly, in the exact words shown, or withdraws it. It is served
 * only once Selestial has also accepted the copy for review, and never the original.
 */
export const setReviewExposure = companyMutation({
  args: { evidenceId: v.id("textingEvidence"), approve: v.boolean(), wording: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (ctx.support || !isOwner(ctx.role)) notAllowed();
    const row = await evidenceOf(ctx, args.evidenceId, false);
    if (!row.reviewCopy || row.replacedAt) throw userError("Only the current review copy can be shown outside Selestial.");
    const now = Date.now();
    if (!args.approve) {
      await ctx.db.patch(row._id, { reviewCopy: { ...row.reviewCopy, exposure: "withdrawn", token: undefined } });
      await recordEvent(ctx, { companyId: ctx.companyId, type: "texting.review_copy_withdrawn", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId } });
      return null;
    }
    if (args.wording !== REVIEW_COPY_WORDING) throw userError("Read and accept the statement to approve showing this copy.");
    if (row.state !== "accepted_internal") throw userError("Selestial checks a review copy for personal details before it can be shown. It hasn't been accepted yet.");
    await ctx.db.patch(row._id, { reviewCopy: { ...row.reviewCopy, exposure: "approved", approval: { wording: args.wording, by: ctx.member._id, at: now }, token: row.reviewCopy.token ?? reviewToken() } });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "texting.review_copy_approved", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId } });
    return null;
  },
});

/** The stored file of an approved, current review copy, for the public address. Nothing else is ever served there. */
export const reviewCopyFile = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    if (!/^[A-Za-z0-9_-]{32}$/.test(args.token)) return null;
    const row = await ctx.db.query("textingEvidence").withIndex("by_token", (q) => q.eq("reviewCopy.token", args.token)).first();
    if (!row?.file || !row.reviewCopy || row.reviewCopy.exposure !== "approved" || row.replacedAt || row.state !== "accepted_internal" || row.visibility !== "company") return null;
    return row.file.storageId;
  },
});

export const evidenceFile = internalQuery({
  args: { evidenceId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("textingEvidence", args.evidenceId);
    const row = id ? await ctx.db.get(id) : null;
    return row?.file?.storageId ?? null;
  },
});

// ── Notes ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A note on the case. The owner's notes are seen by the owner and Selestial. Staff in a support session may
 * also write internal notes, which the company never receives.
 */
export const addNote = companyMutation({
  support: { capability: "records.edit", summary: "added a note to your texting setup" },
  args: { body: v.string(), internal: v.optional(v.boolean()), draft: v.optional(v.boolean()), field: v.optional(v.string()), evidenceKey: v.optional(v.string()), exceptionId: v.optional(v.id("textingExceptions")) },
  handler: async (ctx, args) => {
    const { staff } = access(ctx);
    if (args.internal && !staff) notAllowed();
    const setup = await setupFor(ctx);
    const body = cleanWords(args.body, "A note", 4000);
    if (!body) throw userError("Write the note first.");
    if (!(await allow(ctx, `texting-note:${ctx.companyId}`, 120, HOUR))) throw userError("That's a lot of notes in an hour. Try again a little later.", "limit");
    if (args.exceptionId) {
      const exception = await ctx.db.get(args.exceptionId);
      if (!exception || exception.companyId !== ctx.companyId) notFound();
    }
    const now = Date.now();
    const id = await ctx.db.insert("textingNotes", { companyId: ctx.companyId, setupId: setup._id, audience: args.internal ? "internal" : "company", body, status: args.draft ? "draft" : "posted", author: author(ctx), links: { field: args.field?.slice(0, 60), exceptionId: args.exceptionId }, revisions: [], createdAt: now, updatedAt: now });
    return id;
  },
});

/** Edits a note its author wrote. Every earlier wording is kept; a note filed with a submission is locked. */
export const editNote = companyMutation({
  support: { capability: "records.edit", summary: "edited a note on your texting setup" },
  args: { noteId: v.id("textingNotes"), body: v.string(), post: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { staff } = access(ctx);
    const note = await ctx.db.get(args.noteId);
    if (!note || note.companyId !== ctx.companyId || (note.audience === "internal" && !staff)) notFound();
    const mine = note.author.kind === "member" && note.author.memberId === ctx.member._id && (ctx.support ? note.author.supportSessionId === ctx.support.session._id : !note.author.supportSessionId);
    if (!mine) throw userError("Only the person who wrote a note can change it.", "not_allowed");
    if (note.lockedAt) throw userError("This note was part of a submission, so it stays as it was. Add a new note instead.");
    const body = cleanWords(args.body, "A note", 4000);
    if (!body) throw userError("A note can't be empty.");
    const now = Date.now();
    await ctx.db.patch(note._id, { body, revisions: body === note.body ? note.revisions : [...note.revisions, { body: note.body, at: note.updatedAt }].slice(-50), status: args.post ? "posted" : note.status, updatedAt: now });
    return null;
  },
});

// ── Recommendations ───────────────────────────────────────────────────────────────────────────────

/**
 * Acts on one recommendation. The caller names the fingerprint they reviewed: if the facts changed since,
 * nothing is done and the recommendation is shown again as it is now. Approving applies only to exactly
 * this proposal at exactly these facts, and never submits, buys or charges anything.
 */
export const actOnRecommendation = companyMutation({
  support: { capability: "records.edit", summary: "applied a suggested draft change to your texting setup" },
  args: {
    recommendationId: v.id("textingRecommendations"),
    fingerprint: v.string(),
    action: v.union(v.literal("apply"), v.literal("edit"), v.literal("dismiss"), v.literal("clarify"), v.literal("approve")),
    text: v.optional(v.string()),
    question: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    access(ctx);
    const rec = await ctx.db.get(args.recommendationId);
    if (!rec || rec.companyId !== ctx.companyId) notFound();
    const setup = await ctx.db.get(rec.setupId);
    if (!setup) notFound();
    // Bring it up to date first, so a decision is never made on old facts.
    await syncRecommendations(ctx, setup._id);
    const fresh = (await ctx.db.get(rec._id))!;
    if (fresh.status === "resolved") throw userError("This suggestion no longer applies: the details changed.");
    if (fresh.fingerprint !== args.fingerprint) throw userError("This suggestion was made for an earlier version of your details. It's been checked again; review it as it is now.");
    // Support may apply a draft change for the owner to review. Decisions and attestations stay the owner's.
    if (ctx.support && !(args.action === "apply" || args.action === "edit") ) throw userError("Only the owner can decide on a suggestion.", "not_allowed");
    if (ctx.support && fresh.proposal.kind !== "draft_text" && fresh.proposal.kind !== "add_evidence") throw userError("Only the owner can confirm this.", "not_allowed");
    const now = Date.now();
    const decided = { decidedAt: now, decidedBy: ctx.member._id, updatedAt: now };
    const request = setup.requestId ? await ctx.db.get(setup.requestId) : null;
    const editable = !request || ((["needs_you", "rejected", "cancelled"] as string[]).includes(request.status) && request.needs?.kind !== "code");
    switch (args.action) {
      case "dismiss":
        await ctx.db.patch(fresh._id, { status: "dismissed", nextAction: "Dismissed. It comes back only if the details change.", ...decided });
        return null;
      case "clarify": {
        const question = cleanWords(args.question, "Your question", 1000);
        if (!question) throw userError("Say what you'd like clarified.");
        await ctx.db.patch(fresh._id, { status: "clarification", clarification: { question, at: now, by: ctx.member._id }, nextAction: "Selestial will answer in Evidence & notes.", updatedAt: now });
        await ctx.db.insert("textingNotes", { companyId: ctx.companyId, setupId: setup._id, audience: "company", body: `Question about "${fresh.issue}": ${question}`, status: "posted", author: author(ctx), links: { field: fresh.field }, revisions: [], createdAt: now, updatedAt: now });
        return null;
      }
      case "approve":
        if (fresh.approval === "none") throw userError("This suggestion doesn't need an approval: apply it or dismiss it.");
        if (fresh.proposal.kind === "confirm_field") {
          if (!editable) throw userError("Your details are with Selestial and the carriers now, so they can't be changed here.");
          const field = fresh.proposal.field;
          await ctx.db.patch(setup._id, { sources: setup.sources.some((row) => row.field === field) ? setup.sources.map((row) => (row.field === field ? { ...row, confirmed: true } : row)) : [...setup.sources, { field, source: "owner" as const, confirmed: true }], revision: setup.revision + 1, updatedAt: now, updatedBy: ctx.member._id });
          await ctx.db.patch(fresh._id, { status: "applied", nextAction: "Confirmed by you.", ...decided });
          await syncRecommendations(ctx, setup._id);
          return { revision: setup.revision + 1 };
        }
        await ctx.db.patch(fresh._id, { status: "approved", approvedAt: now, approvedBy: ctx.member._id, nextAction: fresh.approval === "owner_and_charges" ? "Approved. Submit the change when you're ready; its fee is authorized only at submission." : "Approved.", updatedAt: now });
        return null;
      case "apply":
      case "edit": {
        if (fresh.proposal.kind === "add_evidence") {
          await ctx.db.insert("textingEvidence", { companyId: ctx.companyId, setupId: setup._id, key: `ev-${setup._id.slice(-6)}-${now.toString(36)}`, version: 1, purpose: fresh.proposal.purpose, describes: EVIDENCE_PURPOSE_WORDS[fresh.proposal.purpose].proves, kind: "placeholder", links: { place: fresh.proposal.place }, visibility: "company", state: "missing", addedBy: addedByOf(ctx), addedAt: now, lockedIn: [] });
          await ctx.db.patch(fresh._id, { status: "applied", nextAction: "Fill in the placeholder in Evidence & notes.", ...decided });
          await syncRecommendations(ctx, setup._id);
          return null;
        }
        if (fresh.proposal.kind !== "draft_text") throw userError("This suggestion is done on its step. Open it there.");
        if (!editable) throw userError("Your details are with Selestial and the carriers now, so they can't be changed here.");
        const key = fresh.proposal.draftKey;
        const text = args.action === "edit" ? cleanWords(args.text, "The wording", 12000) : fresh.proposal.text;
        if (!text) throw userError("Write the wording first.");
        await ctx.db.patch(setup._id, { drafts: { ...setup.drafts, [key]: { text, edited: args.action === "edit", at: now } }, revision: setup.revision + 1, updatedAt: now, updatedBy: ctx.member._id });
        await ctx.db.patch(fresh._id, { status: "applied", nextAction: "Applied to your draft. Publish your pages to use it.", ...decided });
        await syncRecommendations(ctx, setup._id);
        return { revision: setup.revision + 1 };
      }
    }
  },
});

// ── Exceptions: the owner's answer ────────────────────────────────────────────────────────────────

/** The owner answers what Selestial asked, in the same place: words, and optionally an evidence item. */
export const respond = companyMutation({
  args: { exceptionId: v.id("textingExceptions"), words: v.string(), evidenceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (ctx.support || !isOwner(ctx.role)) notAllowed();
    const row = await ctx.db.get(args.exceptionId);
    if (!row || row.companyId !== ctx.companyId) notFound();
    if (row.state === "resolved") throw userError("This was already resolved.");
    const words = cleanWords(args.words, "Your answer", 2000);
    if (!words) throw userError("Write your answer first.");
    if (args.evidenceKey) {
      const item = await ctx.db.query("textingEvidence").withIndex("by_company_key_version", (q) => q.eq("companyId", ctx.companyId).eq("key", args.evidenceKey!)).first();
      if (!item || item.visibility !== "company") notFound();
    }
    const now = Date.now();
    await ctx.db.patch(row._id, { response: { words, evidenceKey: args.evidenceKey, at: now, by: ctx.member._id }, state: "waiting_selestial", nextAction: "Selestial reviews your answer.", history: [...row.history, { at: now, state: "waiting_selestial", words: "The owner answered.", by: "owner" }].slice(-100), updatedAt: now });
    return null;
  },
});

// ── Number journeys ───────────────────────────────────────────────────────────────────────────────

/** Chooses the number journey. A new local number keeps the guided registration; the others are assisted. */
export const setNumberRoute = companyMutation({
  args: { revision: v.number(), route: literals(NUMBER_ROUTES) },
  handler: async (ctx, args) => {
    if (ctx.support || !isOwner(ctx.role)) notAllowed();
    const setup = await setupFor(ctx);
    if (setup.revision !== args.revision) throw userError("This setup was changed in another window. The latest is shown now; make your change again.");
    const request = setup.requestId ? await ctx.db.get(setup.requestId) : null;
    if (request && !["rejected", "cancelled", "failed"].includes(request.status) && args.route !== (setup.numberRoute ?? "new_local")) throw userError("Your registration for a local number is already with Selestial. Write in Evidence & notes to change the kind of number.");
    const now = Date.now();
    // Choosing a journey keeps the chosen local number, in case the owner comes back to it.
    await ctx.db.patch(setup._id, { numberRoute: args.route, revision: setup.revision + 1, updatedAt: now, updatedBy: ctx.member._id });
    return { revision: setup.revision + 1 };
  },
});

/**
 * Asks Selestial to bring an existing number in, or to set up a toll-free number. These journeys are
 * assisted, not automated: the request is saved and assigned to Selestial with a next action, and nothing
 * is checked, moved, bought or filed by asking. Moving a number needs the owner's explicit acceptance of what
 * can happen to service first.
 */
export const requestAssistance = companyMutation({
  args: { route: v.union(v.literal("port_existing"), v.literal("toll_free")), phoneNumber: v.optional(v.string()), carrier: v.optional(v.string()), words: v.optional(v.string()), acknowledgement: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (ctx.support || !isOwner(ctx.role)) notAllowed();
    const setup = await setupFor(ctx);
    if ((setup.numberRoute ?? "new_local") !== args.route) throw userError("Choose this kind of number first.");
    const open = (await ctx.db.query("textingExceptions").withIndex("by_setup_updated", (q) => q.eq("setupId", setup._id)).take(100)).find((row) => row.assisted?.route === args.route && row.state !== "resolved");
    if (open) throw userError("Selestial already has this request. Its status is shown here.");
    let phoneNumber: string | undefined;
    if (args.route === "port_existing") {
      if (args.acknowledgement !== PORT_WORDING) throw userError("Read and accept what moving a number involves before asking.");
      const digits = (args.phoneNumber ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
      if (digits.length !== 10) throw userError("Enter the US number you want to bring, with its area code.");
      phoneNumber = `+1${digits}`;
    }
    const now = Date.now();
    const id = await ctx.db.insert("textingExceptions", {
      companyId: ctx.companyId,
      setupId: setup._id,
      requestId: setup.requestId,
      category: args.route === "port_existing" ? "number_port" : "toll_free",
      severity: "medium",
      assignee: { kind: "staff" },
      ownerWords: args.route === "port_existing" ? `You asked to bring ${phoneNumber} to Selestial. This is handled with Selestial's help, not automatically.` : "You asked for a toll-free number. Toll-free numbers need their own verification with the carriers, handled with Selestial's help, not automatically.",
      blocker: args.route === "port_existing" ? "The number has to be checked for eligibility and authorized by its account holder before anything moves." : "Toll-free verification is a separate review from local-number registration.",
      canContinue: "You can keep preparing your business details, texts and permission wording. Nothing you've filled in is lost, and your current number keeps working as it does today.",
      nextAction: args.route === "port_existing" ? "Selestial checks whether the number can move and tells you exactly what's needed." : "Selestial reviews what toll-free verification needs from your business and tells you the next step.",
      followUpAt: now + 2 * 24 * HOUR,
      state: "waiting_selestial",
      assisted: { route: args.route, phoneNumber, carrier: args.carrier?.trim().slice(0, 80) || undefined, words: args.words?.trim().slice(0, 1000) || undefined },
      history: [{ at: now, state: "waiting_selestial", words: "Requested by the owner.", by: "owner" }],
      reopened: 0,
      createdAt: now,
      updatedAt: now,
    });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "texting.assistance_requested", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { route: args.route } });
    return id;
  },
});

// ── Support-session exception handling ────────────────────────────────────────────────────────────

/**
 * Staff in a Manage session ask for a correction or an evidence item, or update an exception. The company
 * sees Selestial Support and the owner-facing words; the internal words stay with Selestial.
 */
export const manageException = companyMutation({
  support: { capability: "records.edit", summary: "updated an onboarding item on your texting setup" },
  args: {
    exceptionId: v.optional(v.id("textingExceptions")),
    category: v.optional(v.union(v.literal("business_details"), v.literal("consent_evidence"), v.literal("policy_pages"), v.literal("number"), v.literal("carrier_correction"), v.literal("other"))),
    severity: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"))),
    ownerWords: v.optional(v.string()),
    internalWords: v.optional(v.string()),
    ask: v.optional(v.object({ kind: v.union(v.literal("correction"), v.literal("evidence"), v.literal("information")), field: v.optional(v.string()), purpose: v.optional(literals(EVIDENCE_PURPOSES)) })),
    nextAction: v.optional(v.string()),
    blocker: v.optional(v.string()),
    canContinue: v.optional(v.string()),
    followUpInDays: v.optional(v.number()),
    state: v.optional(v.union(v.literal("waiting_owner"), v.literal("waiting_selestial"), v.literal("waiting_provider"), v.literal("resolved"))),
    resolution: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!ctx.support) notAllowed();
    const { staff } = access(ctx);
    if (!staff) notAllowed();
    const setup = await setupFor(ctx);
    return writeException(ctx, setup, args, { by: "Selestial Support", staffId: ctx.support.staff._id });
  },
});

export type ExceptionArgs = {
  exceptionId?: Id<"textingExceptions">;
  category?: Doc<"textingExceptions">["category"];
  severity?: Doc<"textingExceptions">["severity"];
  ownerWords?: string;
  internalWords?: string;
  ask?: Doc<"textingExceptions">["ask"];
  nextAction?: string;
  blocker?: string;
  canContinue?: string;
  followUpInDays?: number;
  state?: Doc<"textingExceptions">["state"];
  resolution?: string;
  assignTo?: Doc<"textingExceptions">["assignee"];
};

/**
 * Opens or updates an exception (shared with staff review). Resolving needs a resolution; changing a resolved
 * one reopens it and counts it. An exception never changes the request's carrier status and cannot mark
 * anything approved: a correction ask on a request waiting for Selestial review sends it back to the owner,
 * exactly as "Ask for a change" does.
 */
export async function writeException(ctx: MutationCtx, setup: Doc<"textingSetups">, args: ExceptionArgs, who: { by: string; staffId?: Id<"staff"> }): Promise<Id<"textingExceptions">> {
  const now = Date.now();
  const words = (value: string | undefined, label: string, max = 1000) => (value === undefined ? undefined : cleanWords(value, label, max));
  const followUpAt = args.followUpInDays !== undefined ? (args.followUpInDays > 0 && args.followUpInDays <= 60 ? now + Math.round(args.followUpInDays) * 24 * HOUR : (() => { throw userError("A follow-up is 1 to 60 days away."); })()) : undefined;
  let id: Id<"textingExceptions">;
  if (args.exceptionId) {
    const row = await ctx.db.get(args.exceptionId);
    if (!row || row.companyId !== setup.companyId) notFound();
    const reopening = row.state === "resolved" && args.state !== undefined && args.state !== "resolved";
    if (args.state === "resolved" && !args.resolution?.trim()) throw userError("Say how it was resolved.");
    await ctx.db.patch(row._id, {
      ...(args.severity ? { severity: args.severity } : {}),
      ...(args.ownerWords !== undefined ? { ownerWords: words(args.ownerWords, "What the owner reads")! } : {}),
      ...(args.internalWords !== undefined ? { internalWords: words(args.internalWords, "Internal words") } : {}),
      ...(args.ask ? { ask: args.ask } : {}),
      ...(args.nextAction !== undefined ? { nextAction: words(args.nextAction, "The next action", 300)! } : {}),
      ...(args.blocker !== undefined ? { blocker: words(args.blocker, "What's blocked", 300)! } : {}),
      ...(args.canContinue !== undefined ? { canContinue: words(args.canContinue, "What can continue", 300)! } : {}),
      ...(followUpAt ? { followUpAt } : {}),
      ...(args.assignTo ? { assignee: args.assignTo } : {}),
      ...(args.state ? { state: args.state } : {}),
      ...(args.state === "resolved" ? { resolution: words(args.resolution, "The resolution", 1000) } : reopening ? { resolution: undefined, reopened: row.reopened + 1 } : {}),
      history: [...row.history, { at: now, state: args.state ?? row.state, words: args.state === "resolved" ? `Resolved: ${args.resolution!.trim().slice(0, 200)}` : reopening ? "Reopened." : "Updated.", by: who.by }].slice(-100),
      updatedAt: now,
    });
    id = row._id;
  } else {
    if (!args.category || !args.ownerWords?.trim()) throw userError("Say what the item is about, in words the owner will read.");
    const request = setup.requestId ? await ctx.db.get(setup.requestId) : null;
    const submission = request ? await ctx.db.query("textingSubmissions").withIndex("by_request_version", (q) => q.eq("requestId", request._id)).order("desc").first() : null;
    id = await ctx.db.insert("textingExceptions", {
      companyId: setup.companyId,
      setupId: setup._id,
      requestId: setup.requestId,
      category: args.category,
      severity: args.severity ?? "medium",
      field: args.ask?.field?.slice(0, 60),
      submissionVersion: submission?.version,
      assignee: args.assignTo ?? (args.ask ? { kind: "owner" } : { kind: "staff", staffId: who.staffId }),
      internalWords: words(args.internalWords, "Internal words"),
      ownerWords: words(args.ownerWords, "What the owner reads")!,
      ask: args.ask,
      blocker: words(args.blocker, "What's blocked", 300) || (args.ask ? "Selestial review is waiting for this before the registration can go further." : "Nothing is blocked yet."),
      canContinue: words(args.canContinue, "What can continue", 300) || "Everything else in your setup stays as you left it, and you can keep working on it.",
      nextAction: words(args.nextAction, "The next action", 300) || (args.ask?.kind === "evidence" ? "Add the evidence asked for." : args.ask ? "Make the change and answer here." : "Selestial follows up."),
      followUpAt,
      state: args.state ?? (args.ask ? "waiting_owner" : "waiting_selestial"),
      history: [{ at: now, state: args.state ?? (args.ask ? "waiting_owner" : "waiting_selestial"), words: "Opened.", by: who.by }],
      reopened: 0,
      createdAt: now,
      updatedAt: now,
    });
    // A correction asked for before anything is filed puts the request back with the owner, as "Ask for a change" does.
    if (args.ask?.kind === "correction" && request?.status === "requested" && request.setupId) {
      await ctx.db.patch(request._id, { status: "needs_you", needs: { kind: "correction", words: words(args.ownerWords, "What the owner reads")!.slice(0, 500), fields: args.ask.field ? [args.ask.field] : [], at: now }, step: "Selestial review asked for a change.", updatedAt: now });
      await recordEvent(ctx, { companyId: setup.companyId, type: "texting.needs_you", actor: { kind: "system" }, subject: { table: "textingRequests", id: request._id }, data: { kind: "correction", ...(who.staffId ? { staffId: who.staffId } : {}) } });
    }
    if (args.ask?.kind === "evidence" && args.ask.purpose) {
      await ctx.db.insert("textingEvidence", { companyId: setup.companyId, setupId: setup._id, key: `ev-${setup._id.slice(-6)}-${now.toString(36)}`, version: 1, purpose: args.ask.purpose, describes: words(args.ownerWords, "What the owner reads")!.slice(0, 600), kind: "placeholder", links: { field: args.ask.field, exceptionId: id }, visibility: "company", state: "missing", addedBy: who.staffId ? { kind: "staff", staffId: who.staffId } : { kind: "member", memberId: setup.updatedBy! }, addedAt: now, lockedIn: [] });
    }
  }
  await syncRecommendations(ctx, setup._id);
  return id;
}
