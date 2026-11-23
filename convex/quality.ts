/**
 * Quality's screens and the person actions behind them: Overview, Reviews, Cases, Corrections, Standards,
 * Insights and the Playbook, and Quality's panel on jobs, clients, properties, cleaners and Retention cases.
 *
 * What each person sees follows their role: a restricted (serious) case only for the Owner and the manager it
 * was escalated to by name; cleaner statements and customer submissions for managers and the Owner; prices,
 * pay and correction costs for the Owner. Everything is read through the company's own indexes.
 *
 * People keep the whole workspace when Quality's agent work is paused or not on the plan: reviewing visits,
 * working cases, recording findings and asking for statements by hand all work. Nothing a person does here
 * closes a visit, approves pay or decides anything about a cleaner.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { owned } from "./lib/access";
import { dayName } from "./lib/time";
import { authorityFor } from "./lib/authority";
import { companyMutation, companyQuery, managerMutation, managerQuery, ownerMutation, ownerQuery, type MemberAccess } from "./lib/builders";
import { signedPhotoUrl, photoLinksReady, signingTime } from "./lib/dispatch/photoLinks";
import { userError } from "./lib/errors";
import { byMember, recordEvent, type Actor } from "./lib/events";
import { ACTIONS } from "./lib/permissionCatalog";
import { isOwner } from "./lib/roles";
import { addEntry, closeCase, entriesOf, markSerious, maySee, maySeeStatements, moveCase, openCase, preserveJobEvidence } from "./lib/quality/cases";
import { communicationSources } from "./lib/quality/comms/capabilities";
import { correctionsOf, invalidateCorrections, proposeCorrection, syncCorrection, verifyCorrection } from "./lib/quality/corrections";
import { assembleEvidence, type Viewer } from "./lib/quality/evidence";
import { blameIn, findingsOf, reviewFinding } from "./lib/quality/findings";
import { signedQualityFileUrl } from "./lib/quality/fileLinks";
import { submitImprovement, visitsDoneSince } from "./lib/quality/improvements";
import { prepareRequest, recipientName, routeRequest, wordingProblem } from "./lib/quality/requests";
import { agentState } from "./lib/quality/runs";
import { CASE_CLOSURES, CASE_STAGES, FINDING_CATEGORIES, qualitySettingsValidator, requirementValidator, remedyPolicyValidator, STANDARD_LEVELS, STANDARD_TEMPLATES, type CaseStage } from "./lib/quality/schema";
import { checkedQualitySettings, qualitySettings } from "./lib/quality/settings";
import { checkedRequirements, publishStandard, resolveStandard, standardKey, TEMPLATES, versionsOf } from "./lib/quality/standards";
import { reviewVisit } from "./lib/quality/workflow";
import { CLOSURE_WORDS, CORRECTION_WORDS, CUSTOMER_WORDS, DAY, FINDING_WORDS, IMPROVEMENT_WORDS, LEVEL_WORDS, ORIGIN_WORDS, PURPOSE_WORDS, RECOMMENDATION_WORDS, REQUEST_WORDS, REVIEW_WORDS, STAGE_WORDS, TEMPLATE_WORDS } from "./lib/quality/words";
import { literals } from "./lib/statuses";

type Ctx = (QueryCtx | MutationCtx) & MemberAccess;
type Case = Doc<"qualityCases">;

const viewerOf = (ctx: MemberAccess): Viewer => ({ kind: "member", role: ctx.role, memberId: ctx.member._id });
const day = (at: number, tz: string) => dayName(at, tz);
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function jobLine(ctx: QueryCtx | MutationCtx, jobId: Id<"jobs"> | undefined, tz: string) {
  const job = jobId ? await ctx.db.get(jobId) : null;
  if (!job) return null;
  const customer = await ctx.db.get(job.customerId);
  const property = await ctx.db.get(job.propertyId);
  return { id: job._id, service: job.serviceSnapshot?.name ?? job.serviceType, startsAt: job.startsAt, day: day(job.startsAt, tz), status: job.status, operational: job.completionReview ? (job.completionReview.decision === "closed" ? "Closed by a manager" : "Closed without a review") : job.completionReportedAt ? "Reported done; waiting for a manager" : job.status === "completed" ? "Completed" : job.status.replace(/_/g, " "), customer: customer ? { id: customer._id, name: customer.name } : null, property: property ? { id: property._id, name: property.label?.trim() || property.address.line1, city: property.address.city } : null, isCorrection: job.recovery !== undefined };
}

async function caseCard(ctx: Ctx, row: Case) {
  const findings = await findingsOf(ctx, row);
  const corrections = await correctionsOf(ctx, row);
  const retention = row.retentionCaseId ? await ctx.db.get(row.retentionCaseId) : null;
  const owner = row.ownerId ? await ctx.db.get(row.ownerId) : null;
  return {
    id: row._id,
    title: row.title,
    stage: row.stage,
    stageWords: STAGE_WORDS[row.stage],
    origin: ORIGIN_WORDS[row.origin],
    urgency: row.urgency,
    happened: row.happened,
    doing: row.doing,
    needs: row.needs ?? null,
    serious: row.serious !== undefined,
    restricted: row.restricted,
    held: row.heldBy !== undefined,
    escalated: row.escalated !== undefined,
    dueAt: row.dueAt,
    overdue: row.stage !== "closed" && row.dueAt < Date.now(),
    job: await jobLine(ctx, row.jobId, ctx.company.timezone),
    findings: { suggested: findings.filter((f) => f.state === "suggested").length, reviewed: findings.filter((f) => f.state === "reviewed").length },
    correction: corrections[0] ? { state: corrections[0].state, words: CORRECTION_WORDS[corrections[0].state], customer: CUSTOMER_WORDS[corrections[0].customer] } : null,
    customerOutcome: retention?.outcome ? retention.outcome.code.replace(/_/g, " ") : retention ? "Open with Retention" : null,
    owner: owner ? { id: owner._id, name: owner.name ?? owner.email ?? "A member" } : null,
    closed: row.outcome ? { code: row.outcome.code, words: CLOSURE_WORDS[row.outcome.code], at: row.outcome.at } : null,
    createdAt: row.createdAt,
  };
}

async function visibleCase(ctx: Ctx, caseId: Id<"qualityCases">): Promise<Case> {
  const row = await owned(ctx, caseId);
  if (!maySee(row, { role: ctx.role, memberId: ctx.member._id })) throw userError("Not found.");
  return row;
}

async function liveCase(ctx: MutationCtx & MemberAccess, caseId: Id<"qualityCases">): Promise<Case> {
  const row = await visibleCase(ctx, caseId);
  if (row.stage === "closed") throw userError("This case is closed.");
  return row;
}

const member = (ctx: MemberAccess): Actor => byMember(ctx);

// ── Overview ─────────────────────────────────────────────────────────────────────────────────────

export const overview = companyQuery({
  args: { asOf: v.optional(v.number()) },
  handler: async (ctx) => {
    const company = ctx.company;
    const state = agentState(company);
    const now = Date.now();
    const visible = (row: Case) => maySee(row, { role: ctx.role, memberId: ctx.member._id });
    const open: Case[] = [];
    for (const stage of CASE_STAGES.filter((s) => s !== "closed")) open.push(...(await ctx.db.query("qualityCases").withIndex("by_company_stage", (q) => q.eq("companyId", company._id).eq("stage", stage)).take(100)));
    const shown = open.filter(visible);
    const decisions = shown.filter((c) => c.stage === "needs_decision" || c.stage === "needs_context");
    const reviewsNeeding = await ctx.db.query("qualityReviews").withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", "needs_decision")).order("desc").take(50);
    const waiting = [...(await ctx.db.query("qualityRequests").withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", "sent")).take(50)), ...(await ctx.db.query("qualityRequests").withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", "awaiting_approval")).take(50))];
    const closed = (await ctx.db.query("qualityCases").withIndex("by_company_created", (q) => q.eq("companyId", company._id).gte("createdAt", now - 30 * DAY)).take(300)).filter((c) => c.stage === "closed" && (c.closedAt ?? 0) >= now - 14 * DAY && visible(c));
    const runs = await ctx.db.query("qualityRuns").withIndex("by_company_kind", (q) => q.eq("companyId", company._id)).order("desc").take(40);
    const recentRuns = [...runs].sort((a, b) => (b.finishedAt ?? b.startedAt ?? b.queuedAt) - (a.finishedAt ?? a.startedAt ?? a.queuedAt)).filter((r) => r.kind !== "upkeep" || r.status !== "done").slice(0, 12);
    const counts = { queued: 0, running: 0, blocked: 0, failed: 0 };
    for (const status of ["queued", "running", "blocked", "failed"] as const) counts[status] = (await ctx.db.query("qualityRuns").withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", status)).take(200)).length;
    const blockedReason = (await ctx.db.query("qualityRuns").withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", "blocked")).first())?.blockedReason ?? null;
    const sources = await communicationSources(ctx, company);
    const associations = (await ctx.db.query("qualityAssociations").withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", "needs_review")).take(100)).length;
    const standards = (await ctx.db.query("qualityStandards").withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", "published")).take(5)).length;
    const pendingApprovals = (await ctx.db.query("approvals").withIndex("by_company_status_decideBy", (q) => q.eq("companyId", company._id).eq("status", "pending")).take(200)).filter((a) => a.agent === "quality").length;
    const cards = [];
    for (const row of [...decisions].sort((a, b) => (a.urgency === "urgent" ? -1 : 0) - (b.urgency === "urgent" ? -1 : 0) || a.dueAt - b.dueAt).slice(0, 8)) cards.push(await caseCard(ctx, row));
    const reviewCards = [];
    for (const r of reviewsNeeding.slice(0, 6)) reviewCards.push({ id: r._id, summary: r.summary, recommendation: r.recommendation ?? null, words: r.recommendation ? RECOMMENDATION_WORDS[r.recommendation] : null, job: await jobLine(ctx, r.jobId, company.timezone), reopened: r.reopened ?? null });
    const waitingRows = [];
    for (const r of waiting.sort((a, b) => a.dueAt - b.dueAt).slice(0, 8)) waitingRows.push({ id: r._id, purpose: PURPOSE_WORDS[r.purpose], status: r.status, statusWords: REQUEST_WORDS[r.status], who: await recipientName(ctx, r), dueAt: r.dueAt, overdue: r.dueAt < now, job: await jobLine(ctx, r.jobId, company.timezone) });
    const outcomes = [];
    for (const row of closed.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 6)) outcomes.push(await caseCard(ctx, row));
    return {
      agent: { ok: state.ok, reason: state.ok ? null : state.reason, code: state.ok ? null : state.code, paused: company.pausedAgents.includes("quality") },
      readiness: { standards, baseline: standards === 0, sources: sources.map((s) => ({ id: s.id, name: s.name, state: s.state })) },
      counts: { decisions: decisions.length + reviewsNeeding.length, cases: shown.length, waiting: waiting.length, serious: shown.filter((c) => c.serious && !c.serious.decision).length, associations, approvals: pendingApprovals, restrictedHidden: open.length - shown.length, verifiedRecently: closed.length },
      needsAttention: cards,
      reviews: reviewCards,
      waiting: waitingRows,
      outcomes,
      work: { counts, blockedReason, recent: recentRuns.map((r) => ({ id: r._id, kind: r.kind, status: r.status, result: r.result ?? null, checked: r.checked, found: r.found, next: r.next, blockedReason: r.blockedReason ?? null, at: r.finishedAt ?? r.startedAt ?? r.queuedAt, attempts: r.attempts, jobId: r.jobId ?? null, caseId: r.caseId ?? null })) },
      problems: [
        ...sources.filter((s) => s.state === "needs_attention").map((s) => ({ kind: "source" as const, words: `${s.name}: ${s.detail}`, action: s.action })),
        ...(counts.failed ? [{ kind: "runs" as const, words: `${counts.failed} piece${counts.failed === 1 ? "" : "s"} of Quality's work could not be finished after several tries. Each has a task in front of a person.`, action: null }] : []),
        ...(counts.blocked && blockedReason ? [{ kind: "blocked" as const, words: `${counts.blocked} piece${counts.blocked === 1 ? "" : "s"} of work waiting: ${blockedReason}`, action: null }] : []),
      ],
    };
  },
});

// ── Reviews ──────────────────────────────────────────────────────────────────────────────────────

export const reviews = companyQuery({
  args: { status: v.optional(v.union(v.literal("open"), v.literal("all"))) },
  handler: async (ctx, args) => {
    const rows: Doc<"qualityReviews">[] = [];
    const statuses = args.status === "all" ? (["needs_decision", "waiting_on_evidence", "ready", "case_opened", "approved", "queued"] as const) : (["needs_decision", "waiting_on_evidence", "ready", "case_opened"] as const);
    for (const status of statuses) rows.push(...(await ctx.db.query("qualityReviews").withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", status)).order("desc").take(60)));
    const out = [];
    for (const r of rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 120)) {
      const job = await jobLine(ctx, r.jobId, ctx.company.timezone);
      out.push({ id: r._id, status: r.status, statusWords: REVIEW_WORDS[r.status], recommendation: r.recommendation ?? null, words: r.recommendation ? RECOMMENDATION_WORDS[r.recommendation] : null, completeness: r.completeness, flags: r.flags.map((f) => ({ code: f.code, text: f.text })).slice(0, 4), summary: r.summary, job, round: r.round, decided: r.decision ? { outcome: r.decision.outcome, at: r.decision.at } : null, reopened: r.reopened ?? null, historical: r.historical === true, updatedAt: r.updatedAt });
    }
    return out;
  },
});

async function photosOf(ctx: QueryCtx & MemberAccess, job: Doc<"jobs">, asOf: number | undefined) {
  const at = signingTime(asOf);
  const rows = await ctx.db.query("evidence").withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id)).take(200);
  const out = [];
  for (const p of rows.sort((a, b) => a.uploadedAt - b.uploadedAt)) out.push({ id: p._id, kind: p.kind, uploadedAt: p.uploadedAt, url: (await signedPhotoUrl(p._id, at)) ?? (await ctx.storage.getUrl(p.storageId)), expiring: photoLinksReady(), checklistItemId: p.checklistItemId ?? null });
  return out;
}

async function requestsView(ctx: QueryCtx & MemberAccess, rows: Doc<"qualityRequests">[], asOf: number | undefined) {
  const statements = maySeeStatements(ctx.role);
  const out = [];
  for (const r of rows.sort((a, b) => b.createdAt - a.createdAt)) {
    const submissions = await ctx.db.query("qualitySubmissions").withIndex("by_company_request", (q) => q.eq("companyId", r.companyId).eq("requestId", r._id)).take(20);
    const messages = [];
    for (const id of r.messageIds) {
      const m = await ctx.db.get(id);
      if (m) messages.push({ id: m._id, status: m.status, problem: m.problem ?? null, at: m.sentAt ?? m.queuedAt });
    }
    const subs = [];
    for (const s of submissions) {
      const files = [];
      if (statements) for (const fid of s.fileIds) {
        const f = await ctx.db.get(fid);
        if (f) files.push({ id: f._id, name: f.name, contentType: f.contentType, uploadedAt: f.uploadedAt, statedCapturedAt: f.statedCapturedAt ?? null, url: await signedQualityFileUrl(f._id, signingTime(asOf)) });
      }
      subs.push({ id: s._id, version: s.version, kind: s.kind, at: s.submittedAt, answers: statements ? s.answers : [], account: statements ? (s.account ?? null) : null, files, hidden: !statements });
    }
    out.push({ id: r._id, purpose: r.purpose, purposeWords: PURPOSE_WORDS[r.purpose], status: r.status, statusWords: REQUEST_WORDS[r.status], who: await recipientName(ctx, r), recipient: r.recipient.kind, owner: r.conversationOwner, questions: r.questions, evidence: r.evidence, dueAt: r.dueAt, reminders: r.reminders, result: r.result ?? null, authorization: r.authorization ?? null, messages, submissions: subs, createdAt: r.createdAt, linkOpen: r.publicId !== undefined && r.revokedAt === undefined && (r.expiresAt ?? Infinity) > Date.now() });
  }
  return out;
}

export const review = companyQuery({
  args: { reviewId: v.id("qualityReviews"), asOf: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const r = await owned(ctx, args.reviewId);
    const job = (await ctx.db.get(r.jobId))!;
    const assembled = await assembleEvidence(ctx, ctx.company, job, viewerOf(ctx));
    const requests = await ctx.db.query("qualityRequests").withIndex("by_company_job", (q) => q.eq("companyId", ctx.companyId).eq("jobId", job._id)).take(30);
    const row = r.caseId ? await ctx.db.get(r.caseId) : null;
    const decidedBy = r.decision ? await ctx.db.get(r.decision.by) : null;
    return {
      id: r._id,
      status: r.status,
      statusWords: REVIEW_WORDS[r.status],
      round: r.round,
      recommendation: r.recommendation ?? null,
      words: r.recommendation ? RECOMMENDATION_WORDS[r.recommendation] : null,
      summary: r.summary,
      checked: r.checked,
      found: r.found,
      next: r.next,
      standard: { asOf: r.standard.asOf, sources: r.standard.sources.map((s) => ({ ...s, levelWords: LEVEL_WORDS[s.level] })), waived: r.standard.waived, baseline: r.standard.sources.every((s) => s.level !== "company") },
      results: r.results.map((x) => ({ ...x, fromWords: x.from ? `${LEVEL_WORDS[x.from.level]}: ${x.from.name} v${x.from.version}` : "Rules on record" })),
      completeness: r.completeness,
      flags: r.flags,
      decision: r.decision ? { ...r.decision, by: decidedBy?.name ?? "A member" } : null,
      reopened: r.reopened ?? null,
      historical: r.historical === true,
      job: await jobLine(ctx, job._id, ctx.company.timezone),
      evidence: assembled.sections,
      photos: await photosOf(ctx, job, args.asOf),
      requests: await requestsView(ctx, requests, args.asOf),
      case: row && maySee(row, { role: ctx.role, memberId: ctx.member._id }) ? { id: row._id, title: row.title, stage: STAGE_WORDS[row.stage] } : null,
      canClose: job.status === "in_progress" && job.completionReportedAt !== undefined && (ctx.role === "owner" || ctx.role === "manager"),
      crew: assembled.facts.crew.filter((c) => c.status === "accepted").map((c) => ({ cleanerId: c.cleanerId, name: c.name })),
    };
  },
});

/** A person asks for a review now (for example while Quality's agent work is paused). It records; it sends nothing on its own. */
export const reviewNow = managerMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args.jobId);
    const out = await reviewVisit(ctx, ctx.company, job, { act: false, actor: member(ctx), reason: "Reviewed at a person's request: nothing was sent and no case was opened on its own." });
    return { reviewId: out.reviewId ?? null, result: out.result };
  },
});

export const decideReview = managerMutation({
  args: { reviewId: v.id("qualityReviews"), outcome: v.union(v.literal("approved"), v.literal("no_action")), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const r = await owned(ctx, args.reviewId);
    if (r.status === "superseded") throw userError("A later submission replaced this review.");
    const note = args.note?.trim().slice(0, 600) || undefined;
    if (r.recommendation && r.recommendation !== "approve" && args.outcome === "approved" && (!note || note.length < 5)) throw userError("Quality recommended something other than approval. Say why you are approving it.");
    await ctx.db.patch(r._id, { status: "approved", decision: { outcome: args.outcome, by: ctx.member._id, at: Date.now(), note }, reopened: undefined, updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quality_review.decided", actor: member(ctx), subject: { table: "qualityReviews", id: r._id }, data: { outcome: args.outcome } });
    return null;
  },
});

/** An inspection or a site confirmation a person did, recorded against the requirement it satisfies. */
export const recordCheck = managerMutation({
  args: { reviewId: v.id("qualityReviews"), requirementId: v.string(), note: v.string() },
  handler: async (ctx, args) => {
    const r = await owned(ctx, args.reviewId);
    const note = args.note.trim();
    if (note.length < 5) throw userError("Say what you checked.");
    const results = r.results.map((x) => (x.requirementId === args.requirementId && (x.outcome === "unverifiable" || x.outcome === "missing") ? { ...x, outcome: "met" as const, detail: `Checked by a person: ${note.slice(0, 300)}` } : x));
    const required = results.filter((x) => x.level === "required" && x.outcome !== "not_applicable" && x.outcome !== "waived");
    await ctx.db.patch(r._id, { results, completeness: { ...r.completeness, met: required.filter((x) => x.outcome === "met").length, missing: required.filter((x) => x.outcome === "missing").length, unverifiable: required.filter((x) => x.outcome === "unverifiable").length }, updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quality_review.checked", actor: member(ctx), subject: { table: "qualityReviews", id: r._id }, data: { requirementId: args.requirementId } });
    return null;
  },
});

// ── Requests (by a person) ───────────────────────────────────────────────────────────────────────

export const requestFromCleaner = managerMutation({
  args: { jobId: v.id("jobs"), cleanerId: v.id("cleaners"), purpose: v.union(v.literal("missing_evidence"), v.literal("question"), v.literal("statement"), v.literal("supplement")), questions: v.array(v.string()), photos: v.optional(v.array(v.object({ label: v.string(), photoKind: v.union(v.literal("before"), v.literal("after"), v.literal("item"), v.literal("issue")) }))), caseId: v.optional(v.id("qualityCases")) },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args.jobId);
    const cleaner = await owned(ctx, args.cleanerId);
    const row = args.caseId ? await liveCase(ctx, args.caseId) : null;
    if (row?.serious && !isOwner(ctx.role)) throw userError("On a serious concern, the Owner decides who is asked what.");
    const crew = (await ctx.db.query("assignments").withIndex("by_company_job", (q) => q.eq("companyId", ctx.companyId).eq("jobId", job._id)).take(30)).some((a) => a.cleanerId === cleaner._id && a.status === "accepted");
    if (!crew) throw userError("Only a cleaner who worked this visit is asked about it.");
    const questions = args.questions.map((q) => q.trim()).filter((q) => q.length >= 5).slice(0, 6);
    for (const q of questions) {
      const problem = wordingProblem(q);
      if (problem) throw userError(problem);
    }
    if (!questions.length && !args.photos?.length) throw userError("Ask at least one question, or ask for a photo.");
    const prepared = await prepareRequest(ctx, ctx.company, { job, recipient: { kind: "cleaner", cleanerId: cleaner._id }, purpose: args.purpose, questions: questions.map((text, i) => ({ id: `q${i + 1}`, text })), evidence: (args.photos ?? []).slice(0, 6).map((p, i) => ({ id: `p${i + 1}:${Date.now()}`, label: p.label.slice(0, 120), photoKind: p.photoKind })), caseId: row?._id, key: `manual:${job._id}:${cleaner._id}:${Date.now()}`, actor: member(ctx) });
    if (!prepared.request) throw userError(prepared.why);
    const routed = await routeRequest(ctx, ctx.company, prepared.request, member(ctx));
    return routed;
  },
});

/** A focused question for the customer: handed to Retention, which owns the conversation and sends it. */
export const askCustomer = managerMutation({
  args: { caseId: v.id("qualityCases"), question: v.string() },
  handler: async (ctx, args) => {
    const row = await liveCase(ctx, args.caseId);
    if (row.serious) throw userError("On a serious concern, the Owner contacts the customer directly.");
    if (!row.jobId || !row.customerId) throw userError("This case has no customer visit.");
    const question = args.question.trim();
    if (question.length < 8) throw userError("Write the question you want answered.");
    const problem = wordingProblem(question);
    if (problem) throw userError(problem);
    const job = (await ctx.db.get(row.jobId))!;
    const prepared = await prepareRequest(ctx, ctx.company, { job, recipient: { kind: "customer", customerId: row.customerId }, purpose: "question", questions: [{ id: "q1", text: question.slice(0, 300) }], evidence: [], caseId: row._id, key: `customer:${row._id}:${Date.now()}`, actor: member(ctx) });
    if (!prepared.request) throw userError(prepared.why);
    return routeRequest(ctx, ctx.company, prepared.request, member(ctx));
  },
});

export const withdrawRequest = managerMutation({
  args: { requestId: v.id("qualityRequests"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const r = await owned(ctx, args.requestId);
    if (r.status === "answered" || r.status === "cancelled" || r.status === "revoked") return null;
    await ctx.db.patch(r._id, { status: "revoked", revokedAt: Date.now(), revokeReason: args.reason?.slice(0, 200) ?? "Withdrawn by a person.", updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quality_request.withdrawn", actor: member(ctx), subject: { table: "qualityRequests", id: r._id }, data: {} });
    return null;
  },
});

// ── Cases ────────────────────────────────────────────────────────────────────────────────────────

export const cases = companyQuery({
  args: { stage: v.optional(v.union(literals(CASE_STAGES), v.literal("open"))), urgency: v.optional(v.union(v.literal("urgent"), v.literal("normal"), v.literal("low"))), ownerId: v.optional(v.id("members")), service: v.optional(v.string()), propertyId: v.optional(v.id("properties")) },
  handler: async (ctx, args) => {
    const stages: CaseStage[] = !args.stage || args.stage === "open" ? CASE_STAGES.filter((s) => s !== "closed") : [args.stage];
    const rows: Case[] = [];
    for (const stage of stages) rows.push(...(await ctx.db.query("qualityCases").withIndex("by_company_stage", (q) => q.eq("companyId", ctx.companyId).eq("stage", stage)).order("desc").take(150)));
    const out = [];
    let hidden = 0;
    for (const row of rows) {
      if (!maySee(row, { role: ctx.role, memberId: ctx.member._id })) {
        hidden += 1;
        continue;
      }
      if (args.urgency && row.urgency !== args.urgency) continue;
      if (args.ownerId && row.ownerId !== args.ownerId) continue;
      if (args.propertyId && row.propertyId !== args.propertyId) continue;
      const card = await caseCard(ctx, row);
      if (args.service && card.job?.service.toLowerCase() !== args.service.toLowerCase()) continue;
      out.push(card);
    }
    return { cases: out.sort((a, b) => (a.urgency === "urgent" ? 0 : 1) - (b.urgency === "urgent" ? 0 : 1) || a.dueAt - b.dueAt).slice(0, 150), hidden };
  },
});

export const caseDetail = companyQuery({
  args: { caseId: v.id("qualityCases"), asOf: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const row = await visibleCase(ctx, args.caseId);
    const job = row.jobId ? await ctx.db.get(row.jobId) : null;
    const assembled = job ? await assembleEvidence(ctx, ctx.company, job, viewerOf(ctx)) : null;
    const findings = await findingsOf(ctx, row);
    const entries = await entriesOf(ctx, row);
    const pinned = await ctx.db.query("qualityEvidence").withIndex("by_company_case", (q) => q.eq("companyId", ctx.companyId).eq("caseId", row._id)).take(300);
    const requests = await ctx.db.query("qualityRequests").withIndex("by_company_case", (q) => q.eq("companyId", ctx.companyId).eq("caseId", row._id)).take(40);
    const corrections = await correctionsOf(ctx, row);
    const retention = row.retentionCaseId ? await ctx.db.get(row.retentionCaseId) : null;
    const runs = await ctx.db.query("qualityRuns").withIndex("by_company_case", (q) => q.eq("companyId", ctx.companyId).eq("caseId", row._id)).order("desc").take(5);
    const lastRun = runs.find((r) => r.status === "done" || r.status === "blocked");
    const crew = [];
    for (const id of row.cleanerIds) {
      const c = await ctx.db.get(id);
      if (c) crew.push({ id: c._id, name: c.name });
    }
    const customer = row.customerId ? await ctx.db.get(row.customerId) : null;
    const owner = row.ownerId ? await ctx.db.get(row.ownerId) : null;
    const holder = row.heldBy ? await ctx.db.get(row.heldBy.memberId) : null;
    const comms = job ? await ctx.db.query("qualityComms").withIndex("by_company_job", (q) => q.eq("companyId", ctx.companyId).eq("jobId", job._id)).take(30) : [];
    const commViews = [];
    for (const c of comms) {
      const extracts = await ctx.db.query("qualityExtracts").withIndex("by_company_comm", (q) => q.eq("companyId", ctx.companyId).eq("commId", c._id)).take(30);
      commViews.push({ id: c._id, kind: c.kind, direction: c.direction, occurredAt: c.occurredAt, ingestedAt: c.ingestedAt, durationSec: c.durationSec ?? null, body: c.body ?? null, providerSummary: c.providerSummary ?? null, transcript: c.transcript ? { status: c.transcript.status, version: c.transcript.version, revisedAt: c.transcript.revisedAt ?? null, segments: c.transcript.segments.slice(0, 200) } : null, unavailable: c.unavailableAt !== undefined, extracts: extracts.map((e) => ({ id: e._id, kind: e.kind, text: e.text, quote: e.quote ?? null, segments: e.segments, speakerUncertain: e.speakerUncertain, fromSummary: e.fromSummary, state: e.state, version: e.version })) });
    }
    const correctionViews = [];
    for (const c of corrections) {
      const visit = c.correctionJobId ? await jobLine(ctx, c.correctionJobId, ctx.company.timezone) : null;
      correctionViews.push({ id: c._id, state: c.state, stateWords: CORRECTION_WORDS[c.state], customer: c.customer, customerWords: CUSTOMER_WORDS[c.customer], areas: c.areas, scope: c.scope, why: c.why, acceptance: c.acceptance, minutes: c.minutes, timeSensitive: c.timeSensitive ?? null, crewConstraints: c.crewConstraints, approvalNeeded: c.approvalNeeded, estimatedCostCents: isOwner(ctx.role) ? (c.estimatedCostCents ?? null) : null, actualCostCents: isOwner(ctx.role) ? (c.actualCostCents ?? null) : null, costBasis: isOwner(ctx.role) ? c.costBasis : "Costs are shown to the Owner.", verification: c.verification ?? null, visit, result: c.result ?? null });
    }
    return {
      card: await caseCard(ctx, row),
      reportWords: row.reportWords ?? null,
      areas: row.areas,
      serious: row.serious ? { reason: row.serious.reason, at: row.serious.at, preservedAt: row.serious.preservedAt ?? null, decision: row.serious.decision ? { ...row.serious.decision, by: (await ctx.db.get(row.serious.decision.memberId))?.name ?? "The Owner" } : null } : null,
      escalated: row.escalated ? { ...row.escalated, to: row.escalated.toMemberId ? ((await ctx.db.get(row.escalated.toMemberId))?.name ?? null) : null } : null,
      heldBy: holder ? { name: holder.name ?? holder.email ?? "A member", since: row.heldBy!.since } : null,
      job: job ? await jobLine(ctx, job._id, ctx.company.timezone) : null,
      evidence: assembled?.sections ?? [],
      photos: job ? await photosOf(ctx, job, args.asOf) : [],
      pinned: pinned.map((p) => ({ id: p._id, kind: p.kind, source: p.source, access: p.access, preserved: p.preserved, note: p.note ?? null, addedAt: p.addedAt })),
      findings: findings.map((f) => ({ id: f._id, category: f.category, categoryWords: FINDING_WORDS[f.category], statement: f.statement, areas: f.areas, state: f.state, supporting: f.supporting, conflicting: f.conflicting, missing: f.missing, suggestedBy: f.suggestedBy, reviewedAt: f.reviewedAt ?? null, revision: f.revision, history: f.history.map((h) => ({ at: h.at, change: h.change, statement: h.statement ?? null })) })),
      timeline: entries.map((e) => ({ id: e._id, at: e.at, kind: e.kind, basis: e.basis ?? null, text: e.text, source: e.source ?? null, quote: e.quote ?? null, actor: e.actor.kind })),
      requests: await requestsView(ctx, requests, args.asOf),
      corrections: correctionViews,
      comms: commViews,
      people: { customer: customer ? { id: customer._id, name: customer.name } : null, crew, owner: owner ? { id: owner._id, name: owner.name ?? owner.email ?? "A member" } : null, retention: retention ? { id: retention._id, title: retention.title, status: retention.status, outcome: retention.outcome?.code ?? null, customerAnswer: retention.verification?.customerAnswer?.answer ?? null } : null },
      run: lastRun ? { at: lastRun.finishedAt ?? lastRun.queuedAt, checked: lastRun.checked, found: lastRun.found, next: lastRun.next, blockedReason: lastRun.blockedReason ?? null } : null,
      can: { manage: ctx.role !== "office", owner: isOwner(ctx.role), statements: maySeeStatements(ctx.role) },
    };
  },
});

export const reportConcern = companyMutation({
  args: { jobId: v.id("jobs"), words: v.string(), origin: v.optional(v.union(v.literal("owner_report"), v.literal("cleaner_report"))) },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args.jobId);
    const words = args.words.trim();
    if (words.length < 8) throw userError("Describe what was reported in a sentence.");
    const { row } = await openCase(ctx, { companyId: ctx.companyId, key: `report:${job._id}:${Date.now()}`, origin: args.origin ?? "owner_report", title: `Reported: ${job.serviceSnapshot?.name ?? job.serviceType}, ${day(job.startsAt, ctx.company.timezone)}`, happened: "Reported by the office. A report is not a finding.", doing: "Comparing the report with the visit's record.", job, reportWords: words.slice(0, 2000), actor: member(ctx) });
    return { caseId: row._id };
  },
});

export const reviewFindingAction = managerMutation({
  args: { findingId: v.id("qualityFindings"), action: v.union(v.literal("confirm"), v.literal("reject"), v.literal("revise")), statement: v.optional(v.string()), category: v.optional(literals(FINDING_CATEGORIES)), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const finding = await owned(ctx, args.findingId);
    const row = await liveCase(ctx, finding.caseId);
    if (finding.category === "serious_incident" && !isOwner(ctx.role)) throw userError("The Owner reviews a serious-incident finding.");
    await reviewFinding(ctx, finding, { action: args.action, statement: args.statement, category: args.category, note: args.note?.slice(0, 300), memberId: ctx.member._id });
    // A correction resting on a finding that changed is withdrawn before it is scheduled.
    if (args.action !== "confirm") await invalidateCorrections(ctx, (await ctx.db.get(row._id))!, `A finding was ${args.action === "reject" ? "rejected" : "revised"} after the correction was prepared.`);
    return null;
  },
});

export const addFinding = managerMutation({
  args: { caseId: v.id("qualityCases"), category: literals(FINDING_CATEGORIES), statement: v.string(), areas: v.optional(v.array(v.string())), missing: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const row = await liveCase(ctx, args.caseId);
    const statement = args.statement.trim();
    if (statement.length < 10) throw userError("Write the finding as one sentence that says what the evidence shows.");
    const blamed = blameIn(statement);
    if (blamed) throw userError(`A finding says what the evidence shows, not who is at fault. Remove "${blamed}".`);
    const now = Date.now();
    const id = await ctx.db.insert("qualityFindings", { companyId: ctx.companyId, caseId: row._id, category: args.category, statement: statement.slice(0, 400), areas: (args.areas ?? []).slice(0, 6), state: "reviewed", supporting: [], conflicting: [], missing: (args.missing ?? []).slice(0, 6), suggestedBy: "person", reviewedBy: ctx.member._id, reviewedAt: now, revision: 1, history: [{ at: now, by: member(ctx), change: "Recorded by a person" }], createdAt: now, updatedAt: now });
    await addEntry(ctx, row, { kind: "finding", basis: "fact", text: `Finding recorded by a person (${FINDING_WORDS[args.category]}): ${statement.slice(0, 300)}`, source: { table: "qualityFindings", id, label: "Finding" }, actor: member(ctx) });
    await moveCase(ctx, row, {}, member(ctx));
    return { findingId: id };
  },
});

export const takeOver = companyMutation({
  args: { caseId: v.id("qualityCases") },
  handler: async (ctx, args) => {
    const row = await liveCase(ctx, args.caseId);
    if (row.heldBy) return null;
    await moveCase(ctx, row, { heldBy: { memberId: ctx.member._id, since: Date.now() }, ownerId: row.ownerId ?? ctx.member._id, doing: "A person is handling this case. Quality sends nothing until it is handed back." }, member(ctx));
    // The agent's own unsent requests stop: the person decides who is asked what.
    for (const r of await ctx.db.query("qualityRequests").withIndex("by_company_case", (q) => q.eq("companyId", ctx.companyId).eq("caseId", row._id)).take(40)) if ((r.status === "prepared" || r.status === "awaiting_approval") && r.createdBy.kind === "agent") await ctx.db.patch(r._id, { status: "cancelled", result: "A person took over the case.", updatedAt: Date.now() });
    await addEntry(ctx, row, { kind: "note", text: "Taken over by a person. Quality prepares nothing more for anyone outside until it is handed back.", actor: member(ctx) });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quality_case.taken_over", actor: member(ctx), subject: { table: "qualityCases", id: row._id }, data: {} });
    return null;
  },
});

export const handBack = companyMutation({
  args: { caseId: v.id("qualityCases") },
  handler: async (ctx, args) => {
    const row = await liveCase(ctx, args.caseId);
    if (!row.heldBy) return null;
    if (row.serious && !row.serious.decision) throw userError("A serious concern stays with a person until the Owner records a decision.");
    await moveCase(ctx, row, { clearHeld: true, doing: "Handed back to Quality." }, member(ctx));
    await addEntry(ctx, row, { kind: "note", text: "Handed back to Quality.", actor: member(ctx) });
    return null;
  },
});

export const escalate = companyMutation({
  args: { caseId: v.id("qualityCases"), reason: v.string(), toMemberId: v.optional(v.id("members")) },
  handler: async (ctx, args) => {
    const row = await liveCase(ctx, args.caseId);
    const reason = args.reason.trim();
    if (reason.length < 5) throw userError("Say why this needs escalating.");
    if (args.toMemberId) {
      const to = await owned(ctx, args.toMemberId);
      if (to.status !== "active") throw userError("Escalate to an active member.");
    }
    await ctx.db.patch(row._id, { escalated: { at: Date.now(), by: member(ctx), reason: reason.slice(0, 300), toMemberId: args.toMemberId }, urgency: "urgent", ownerId: args.toMemberId ?? row.ownerId, updatedAt: Date.now(), revision: row.revision + 1 });
    await addEntry(ctx, row, { kind: "note", text: `Escalated: ${reason.slice(0, 300)}`, actor: member(ctx) });
    await moveCase(ctx, (await ctx.db.get(row._id))!, { stage: "needs_decision", needs: `Escalated: ${reason.slice(0, 300)}` }, member(ctx));
    return null;
  },
});

export const addNote = companyMutation({
  args: { caseId: v.id("qualityCases"), text: v.string() },
  handler: async (ctx, args) => {
    const row = await visibleCase(ctx, args.caseId);
    const text = args.text.trim();
    if (text.length < 2) throw userError("Write the note.");
    await addEntry(ctx, row, { kind: "note", text: text.slice(0, 1200), actor: member(ctx) });
    if (row.firstActionAt === undefined) await ctx.db.patch(row._id, { firstActionAt: Date.now() });
    return null;
  },
});

export const assign = managerMutation({
  args: { caseId: v.id("qualityCases"), memberId: v.id("members") },
  handler: async (ctx, args) => {
    const row = await liveCase(ctx, args.caseId);
    const to = await owned(ctx, args.memberId);
    if (to.status !== "active") throw userError("Assign the case to an active member.");
    if (row.restricted && to.role !== "owner" && row.escalated?.toMemberId !== to._id) throw userError("A restricted case can only be given to the Owner or the person it was escalated to.");
    await moveCase(ctx, row, { ownerId: to._id }, member(ctx));
    return null;
  },
});

export const close = managerMutation({
  args: { caseId: v.id("qualityCases"), code: literals(CASE_CLOSURES), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await liveCase(ctx, args.caseId);
    if (row.serious && (!isOwner(ctx.role) || !row.serious.decision)) throw userError("A serious concern is closed by the Owner, after the decision is recorded.");
    const suggested = (await findingsOf(ctx, row)).filter((f) => f.state === "suggested");
    if (suggested.length && args.code !== "duplicate" && args.code !== "handled_by_person") throw userError(`${suggested.length} suggested ${suggested.length === 1 ? "finding is" : "findings are"} not reviewed yet. Confirm, revise or reject ${suggested.length === 1 ? "it" : "them"} first.`);
    await closeCase(ctx, row, args.code, member(ctx), args.note);
    return null;
  },
});

/** The Owner's recorded decision on a serious concern. It decides nothing automatically; it says what a person decided. */
export const recordSeriousDecision = ownerMutation({
  args: { caseId: v.id("qualityCases"), text: v.string(), continueOperations: v.boolean() },
  handler: async (ctx, args) => {
    const row = await liveCase(ctx, args.caseId);
    if (!row.serious) throw userError("This case is not marked serious.");
    const text = args.text.trim();
    if (text.length < 10) throw userError("Record what was decided, in a sentence or two.");
    await ctx.db.patch(row._id, { serious: { ...row.serious, decision: { memberId: ctx.member._id, at: Date.now(), text: text.slice(0, 1500), continueOperations: args.continueOperations } }, updatedAt: Date.now(), revision: row.revision + 1 });
    await addEntry(ctx, row, { kind: "outcome", basis: "fact", text: `The Owner recorded a decision: ${text.slice(0, 600)}${args.continueOperations ? " Ordinary operational work (a correction or a reschedule) may continue under control." : " Operational follow-up stays with a person."}`, actor: member(ctx) });
    await moveCase(ctx, (await ctx.db.get(row._id))!, { stage: args.continueOperations ? "investigating" : "needs_decision", doing: args.continueOperations ? "The Owner decided; operational follow-up may continue." : "The Owner decided; a person handles what follows.", clearNeeds: args.continueOperations }, member(ctx));
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quality_case.serious_decided", actor: member(ctx), subject: { table: "qualityCases", id: row._id }, data: { continueOperations: args.continueOperations } });
    return null;
  },
});

export const markSeriousByPerson = managerMutation({
  args: { caseId: v.id("qualityCases"), reason: v.string() },
  handler: async (ctx, args) => {
    const row = await liveCase(ctx, args.caseId);
    const reason = args.reason.trim();
    if (reason.length < 5) throw userError("Say what makes this serious.");
    await markSerious(ctx, row, `Marked serious by a person: ${reason.slice(0, 300)}`, member(ctx));
    return null;
  },
});

export const preserve = managerMutation({
  args: { caseId: v.id("qualityCases") },
  handler: async (ctx, args) => {
    const row = await visibleCase(ctx, args.caseId);
    const n = await preserveJobEvidence(ctx, row, member(ctx));
    await addEntry(ctx, row, { kind: "evidence", text: `The visit's evidence is preserved on this case (${n} new item${n === 1 ? "" : "s"} pinned). Routines will not delete it.`, actor: member(ctx) });
    return { pinned: n };
  },
});

// ── Corrections ──────────────────────────────────────────────────────────────────────────────────

export const proposeCorrectionAction = managerMutation({
  args: { caseId: v.id("qualityCases"), findingIds: v.array(v.id("qualityFindings")), areas: v.array(v.string()), scope: v.union(v.literal("targeted"), v.literal("full")), minutes: v.optional(v.number()), afterPhotos: v.number(), checklistLabels: v.array(v.string()), inspection: v.boolean(), timeSensitiveBy: v.optional(v.number()), timeSensitiveReason: v.optional(v.string()), crewConstraints: v.optional(v.array(v.string())), avoidCleanerIds: v.optional(v.array(v.id("cleaners"))) },
  handler: async (ctx, args) => {
    const row = await liveCase(ctx, args.caseId);
    if (args.minutes !== undefined && (!Number.isInteger(args.minutes) || args.minutes < 15 || args.minutes > 600)) throw userError("A correction is from 15 minutes to 10 hours.");
    if (!Number.isInteger(args.afterPhotos) || args.afterPhotos < 0 || args.afterPhotos > 20) throw userError("Ask for 0 to 20 after photos.");
    const correction = await proposeCorrection(ctx, ctx.company, row, { findingIds: args.findingIds, areas: args.areas.map((a) => a.trim().toLowerCase()).filter(Boolean).slice(0, 8), scope: args.scope, minutes: args.minutes, afterPhotos: args.afterPhotos, checklistLabels: args.checklistLabels.map((l) => l.trim()).filter(Boolean).slice(0, 8), inspection: args.inspection, timeSensitive: args.timeSensitiveBy ? { by: args.timeSensitiveBy, reason: (args.timeSensitiveReason ?? "A deadline at the property.").slice(0, 200) } : undefined, crewConstraints: args.crewConstraints ?? [], avoidCleanerIds: args.avoidCleanerIds ?? [], actor: member(ctx) });
    return { correctionId: correction._id };
  },
});

export const recordCorrectionInspection = managerMutation({
  args: { correctionId: v.id("qualityCorrections"), note: v.string() },
  handler: async (ctx, args) => {
    const correction = await owned(ctx, args.correctionId);
    const row = await liveCase(ctx, correction.caseId);
    if (args.note.trim().length < 5) throw userError("Say what the inspection found.");
    await syncCorrection(ctx, correction);
    await addEntry(ctx, row, { kind: "verification", basis: "fact", text: `Inspection recorded: ${args.note.trim().slice(0, 600)}`, actor: member(ctx) });
    await verifyCorrection(ctx, ctx.company, (await ctx.db.get(correction._id))!, member(ctx), true);
    return null;
  },
});

export const corrections = companyQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("qualityCorrections").withIndex("by_company_state", (q) => q.eq("companyId", ctx.companyId)).order("desc").take(150);
    const out = [];
    for (const c of rows) {
      const row = await ctx.db.get(c.caseId);
      if (!row || !maySee(row, { role: ctx.role, memberId: ctx.member._id })) continue;
      const action = c.retentionActionId ? await ctx.db.get(c.retentionActionId) : null;
      const visit = c.correctionJobId ? await jobLine(ctx, c.correctionJobId, ctx.company.timezone) : null;
      out.push({ id: c._id, caseId: c.caseId, caseTitle: row.title, state: c.state, stateWords: CORRECTION_WORDS[c.state], customer: c.customer, customerWords: CUSTOMER_WORDS[c.customer], areas: c.areas, scope: c.scope, minutes: c.minutes, acceptance: c.acceptance.criteria, original: await jobLine(ctx, c.jobId, ctx.company.timezone), visit, remedy: action ? { status: action.status, payNeeded: action.kind === "correction_visit" && action.visit?.payBasisCents === undefined, result: action.result ?? null } : null, verification: c.verification ? { outcome: c.verification.outcome, detail: c.verification.detail, at: c.verification.at } : null, estimatedCostCents: isOwner(ctx.role) ? (c.estimatedCostCents ?? null) : null, actualCostCents: isOwner(ctx.role) ? (c.actualCostCents ?? null) : null, costBasis: isOwner(ctx.role) ? c.costBasis : null, updatedAt: c.updatedAt });
    }
    return out;
  },
});

// ── Standards ────────────────────────────────────────────────────────────────────────────────────

export const standards = companyQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("qualityStandards").withIndex("by_company_level", (q) => q.eq("companyId", ctx.companyId)).take(400);
    const byKey = new Map<string, Doc<"qualityStandards">[]>();
    for (const r of rows) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
    const groups = [];
    for (const [key, versions] of byKey) {
      versions.sort((a, b) => b.version - a.version);
      const current = versions.find((x) => x.status === "published") ?? null;
      const draft = versions.find((x) => x.status === "draft") ?? null;
      const head = versions[0];
      let target: string | null = null;
      if (head.level === "service") target = head.serviceKey ?? key.slice(8);
      else if (head.customerId) target = (await ctx.db.get(head.customerId))?.name ?? null;
      else if (head.propertyId) {
        const p = await ctx.db.get(head.propertyId);
        target = p ? p.label?.trim() || p.address.line1 : null;
      } else if (head.jobId) target = "One visit";
      groups.push({ key, level: head.level, levelWords: LEVEL_WORDS[head.level], target, name: (current ?? head).name, current: current ? { id: current._id, version: current.version, publishedAt: current.publishedAt ?? null, requirements: current.requirements.length } : null, draft: draft ? { id: draft._id, version: draft.version, updatedAt: draft.updatedAt, changeNote: draft.changeNote ?? null } : null, history: versions.map((x) => ({ id: x._id, version: x.version, status: x.status, publishedAt: x.publishedAt ?? null, endedAt: x.endedAt ?? null, changeNote: x.changeNote ?? null })) });
    }
    const rank = { company: 0, service: 1, account: 2, property: 3, visit: 4 } as const;
    return {
      groups: groups.sort((a, b) => rank[a.level] - rank[b.level]),
      templates: STANDARD_TEMPLATES.map((t) => ({ id: t, name: TEMPLATE_WORDS[t], lead: TEMPLATES[t].lead, requirements: TEMPLATES[t].requirements })),
      precedence: STANDARD_LEVELS.map((l) => LEVEL_WORDS[l]),
    };
  },
});

export const standard = companyQuery({
  args: { standardId: v.id("qualityStandards") },
  handler: async (ctx, args) => {
    const s = await owned(ctx, args.standardId);
    return { id: s._id, key: s.key, level: s.level, levelWords: LEVEL_WORDS[s.level], version: s.version, status: s.status, name: s.name, template: s.template ?? null, requirements: s.requirements, remedy: s.remedy ?? null, agreement: s.agreement ?? null, changeNote: s.changeNote ?? null, publishedAt: s.publishedAt ?? null, endedAt: s.endedAt ?? null };
  },
});

/** Which requirements would apply to a visit, and where each came from. */
export const standardPreview = companyQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args.jobId);
    const resolved = await resolveStandard(ctx, ctx.company, job);
    return { asOf: resolved.asOf, baseline: resolved.baseline, baselineWords: resolved.baselineWords, sources: resolved.sources.map((s) => ({ ...s, levelWords: LEVEL_WORDS[s.level] })), requirements: resolved.requirements.map((r) => ({ ...r.requirement, from: r.from.version === 0 ? "Rules on record" : `${LEVEL_WORDS[r.from.level]}: ${r.from.name} v${r.from.version}` })), waived: resolved.waived };
  },
});

export const createDraft = managerMutation({
  args: { level: literals(STANDARD_LEVELS), ref: v.optional(v.string()), template: v.optional(literals(STANDARD_TEMPLATES)), name: v.string(), agreementNote: v.optional(v.string()) },
  handler: async (ctx, args) => {
    let ref: string | undefined;
    let fields: Partial<Doc<"qualityStandards">> = {};
    if (args.level === "service") {
      ref = args.ref?.trim();
      if (!ref) throw userError("Name the service this standard is for.");
      fields = { serviceKey: ref.toLowerCase().replace(/\s+/g, " ") };
    } else if (args.level === "account") {
      const id = args.ref ? ctx.db.normalizeId("customers", args.ref) : null;
      const c = id ? await ctx.db.get(id) : null;
      if (!c || c.companyId !== ctx.companyId) throw userError("Choose the client this standard is for.");
      ref = c._id;
      fields = { customerId: c._id };
    } else if (args.level === "property") {
      const id = args.ref ? ctx.db.normalizeId("properties", args.ref) : null;
      const p = id ? await ctx.db.get(id) : null;
      if (!p || p.companyId !== ctx.companyId) throw userError("Choose the property this standard is for.");
      ref = p._id;
      fields = { propertyId: p._id };
    } else if (args.level === "visit") {
      const id = args.ref ? ctx.db.normalizeId("jobs", args.ref) : null;
      const j = id ? await ctx.db.get(id) : null;
      if (!j || j.companyId !== ctx.companyId) throw userError("Choose the visit this exception is for.");
      if (!args.agreementNote || args.agreementNote.trim().length < 5) throw userError("Say what was agreed for this visit, and with whom.");
      ref = j._id;
      fields = { jobId: j._id, agreement: { with: "customer", note: args.agreementNote.trim().slice(0, 500) } };
    }
    const key = standardKey(args.level, ref);
    const versions = await versionsOf(ctx, ctx.companyId, key);
    if (versions.some((x) => x.status === "draft")) throw userError("A draft of this standard is already open. Edit it, or publish or discard it first.");
    const latest = versions.find((x) => x.status === "published");
    const requirements = args.template ? TEMPLATES[args.template].requirements : (latest?.requirements ?? []);
    const name = args.name.trim().slice(0, 80) || (args.template ? TEMPLATE_WORDS[args.template] : "Standard");
    const now = Date.now();
    const id = await ctx.db.insert("qualityStandards", { companyId: ctx.companyId, level: args.level, key, version: (versions[0]?.version ?? 0) + 1, status: "draft", name, template: args.template, requirements: checkedRequirements(requirements, args.level), remedy: latest?.remedy, createdBy: member(ctx), createdAt: now, updatedAt: now, ...fields });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quality_standard.drafted", actor: member(ctx), subject: { table: "qualityStandards", id }, data: { level: args.level } });
    return { standardId: id };
  },
});

export const saveDraft = managerMutation({
  args: { standardId: v.id("qualityStandards"), name: v.string(), requirements: v.array(requirementValidator), remedy: v.optional(remedyPolicyValidator), changeNote: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const s = await owned(ctx, args.standardId);
    if (s.status !== "draft") throw userError("Only a draft can be edited. Start a new draft from the published version.");
    const remedy = args.remedy;
    if (remedy?.guaranteeDays !== undefined && (!Number.isInteger(remedy.guaranteeDays) || remedy.guaranteeDays < 0 || remedy.guaranteeDays > 90)) throw userError("A guarantee is 0 to 90 days.");
    await ctx.db.patch(s._id, { name: args.name.trim().slice(0, 80) || s.name, requirements: checkedRequirements(args.requirements, s.level), remedy: remedy ? { ...remedy, guaranteeText: remedy.guaranteeText?.trim().slice(0, 600) } : undefined, changeNote: args.changeNote?.trim().slice(0, 400), updatedAt: Date.now() });
    return null;
  },
});

/** Publishing changes what applies to visits scheduled from now on. It never redefines a visit already reviewed. */
export const publish = ownerMutation({
  args: { standardId: v.id("qualityStandards") },
  handler: async (ctx, args) => {
    const s = await owned(ctx, args.standardId);
    if (!s.requirements.length && s.level === "company") throw userError("A company standard needs at least one requirement.");
    const published = await publishStandard(ctx, s, ctx.member._id);
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quality_standard.published", actor: member(ctx), subject: { table: "qualityStandards", id: s._id }, data: { level: s.level, version: s.version } });
    return { version: published.version };
  },
});

export const discardDraft = managerMutation({
  args: { standardId: v.id("qualityStandards") },
  handler: async (ctx, args) => {
    const s = await owned(ctx, args.standardId);
    if (s.status !== "draft") throw userError("Only a draft can be discarded.");
    await ctx.db.delete(s._id);
    return null;
  },
});

export const retire = ownerMutation({
  args: { standardId: v.id("qualityStandards") },
  handler: async (ctx, args) => {
    const s = await owned(ctx, args.standardId);
    if (s.status !== "published") throw userError("Only the published version can be retired.");
    if (s.level === "company") throw userError("The company default can be replaced by a new version, not retired.");
    await ctx.db.patch(s._id, { status: "retired", endedAt: Date.now(), updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quality_standard.retired", actor: member(ctx), subject: { table: "qualityStandards", id: s._id }, data: {} });
    return null;
  },
});

// ── Insights ─────────────────────────────────────────────────────────────────────────────────────

export const insights = companyQuery({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const days = args.days && [30, 90].includes(args.days) ? args.days : 90;
    const since = Date.now() - days * DAY;
    const casesInWindow = (await ctx.db.query("qualityCases").withIndex("by_company_created", (q) => q.eq("companyId", ctx.companyId).gte("createdAt", since)).take(1000)).filter((c) => !c.historical && maySee(c, { role: ctx.role, memberId: ctx.member._id }));
    const findings = (await ctx.db.query("qualityFindings").withIndex("by_company_category", (q) => q.eq("companyId", ctx.companyId)).take(3000)).filter((f) => f.state === "reviewed" && (f.reviewedAt ?? 0) >= since);
    const completed = await visitsDoneSince(ctx, ctx.companyId, since);
    const reviewsIn = (await ctx.db.query("qualityReviews").withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId)).take(3000)).filter((r) => r.createdAt >= since && r.status !== "superseded" && !r.historical);
    const reviewed = new Set(reviewsIn.map((r) => r.jobId as string));
    const fullyDocumented = reviewsIn.filter((r) => r.completeness.missing === 0 && r.completeness.contradictory === 0).length;
    const patterns = new Map<string, { category: string; area: string | null; cases: Set<string>; properties: Set<string> }>();
    for (const f of findings) {
      const row = casesInWindow.find((c) => c._id === f.caseId) ?? (await ctx.db.get(f.caseId));
      if (!row || !maySee(row, { role: ctx.role, memberId: ctx.member._id })) continue;
      for (const area of f.areas.length ? f.areas : [null]) {
        const key = `${f.category}:${area ?? "-"}`;
        const g = patterns.get(key) ?? { category: f.category, area, cases: new Set(), properties: new Set() };
        g.cases.add(f.caseId);
        if (row.propertyId) g.properties.add(row.propertyId);
        patterns.set(key, g);
      }
    }
    const corrections = (await ctx.db.query("qualityCorrections").withIndex("by_company_state", (q) => q.eq("companyId", ctx.companyId)).take(1000)).filter((c) => c.createdAt >= since);
    const firstAction = median(casesInWindow.filter((c) => c.firstActionAt).map((c) => c.firstActionAt! - c.createdAt));
    const toVerify = median(corrections.filter((c) => c.verification).map((c) => c.verification!.at - c.createdAt));
    const repeats = [...patterns.values()].filter((g) => g.properties.size > 0 && g.cases.size > g.properties.size);
    const improvements = await ctx.db.query("qualityImprovements").withIndex("by_company_state", (q) => q.eq("companyId", ctx.companyId)).order("desc").take(50);
    const small = completed.length < 20;
    return {
      days,
      note: small ? `Only ${completed.length} ${completed.length === 1 ? "visit was" : "visits were"} reported done in this window: too few to read trends. Counts are shown as they are.` : "Counts and medians from reviewed records. Nothing here is a score or a prediction.",
      coverage: { completedVisits: completed.length, reviewed: completed.filter((j) => reviewed.has(j._id)).length, fullyDocumented, reviewsCounted: reviewsIn.length, words: `${fullyDocumented} of ${reviewsIn.length} reviewed visits had every required item on record. That is documentation, not how the service looked.` },
      patterns: [...patterns.values()].map((g) => ({ category: g.category, categoryWords: FINDING_WORDS[g.category as keyof typeof FINDING_WORDS], area: g.area, cases: g.cases.size, properties: g.properties.size, denominator: completed.length })).sort((a, b) => b.cases - a.cases).slice(0, 12),
      corrections: { count: corrections.length, verified: corrections.filter((c) => c.state === "quality_verified").length, notVerified: corrections.filter((c) => c.state === "verification_failed").length, customerConfirmed: corrections.filter((c) => c.customer === "confirmed").length, customerDissatisfied: corrections.filter((c) => c.customer === "dissatisfied").length, noResponse: corrections.filter((c) => c.customer === "no_response").length, estimatedCents: isOwner(ctx.role) ? corrections.reduce((s, c) => s + (c.estimatedCostCents ?? 0), 0) : null, actualCents: isOwner(ctx.role) ? corrections.reduce((s, c) => s + (c.actualCostCents ?? 0), 0) : null, unknownCost: corrections.filter((c) => c.estimatedCostCents === undefined).length },
      timing: { firstActionMs: firstAction, firstActionCount: casesInWindow.filter((c) => c.firstActionAt).length, verificationMs: toVerify, verificationCount: corrections.filter((c) => c.verification).length },
      repeats: repeats.map((g) => ({ category: FINDING_WORDS[g.category as keyof typeof FINDING_WORDS], area: g.area, cases: g.cases.size, properties: g.properties.size })).slice(0, 8),
      improvements: improvements.map((i) => ({ id: i._id, kind: i.kind, kindWords: IMPROVEMENT_WORDS[i.kind], title: i.title, change: i.proposedChange, evidence: i.evidence, affects: i.affects, expected: i.expectedBenefit, owner: i.owner, evaluation: i.evaluation, state: i.state, result: i.result ?? null, createdAt: i.createdAt })),
    };
  },
});

export const submitImprovementAction = managerMutation({
  args: { improvementId: v.id("qualityImprovements") },
  handler: async (ctx, args) => {
    const imp = await owned(ctx, args.improvementId);
    if (imp.state !== "proposed") throw userError("This proposal was already sent or decided.");
    await submitImprovement(ctx, ctx.company, imp);
    return null;
  },
});

export const withdrawImprovement = managerMutation({
  args: { improvementId: v.id("qualityImprovements") },
  handler: async (ctx, args) => {
    const imp = await owned(ctx, args.improvementId);
    if (imp.state !== "proposed") throw userError("Only a proposal not yet sent can be withdrawn.");
    await ctx.db.patch(imp._id, { state: "withdrawn", updatedAt: Date.now() });
    return null;
  },
});

// ── Playbook ─────────────────────────────────────────────────────────────────────────────────────

export const playbook = companyQuery({
  args: {},
  handler: async (ctx) => {
    const settings = qualitySettings(ctx.company);
    const authority = [];
    for (const def of ACTIONS.filter((a) => a.agent === "quality")) {
      const found = await authorityFor(ctx, ctx.companyId, def.key);
      authority.push({ key: def.key, label: def.label, level: found.kind === "level" ? found.level : found.kind, ceiling: def.ceiling, outsider: def.outsider });
    }
    const quo = (await ctx.db.query("qualityConnections").withIndex("by_company_provider", (q) => q.eq("companyId", ctx.companyId).eq("provider", "quo")).take(5)).find((c) => c.status !== "disconnected") ?? null;
    return { settings, stored: ctx.company.quality ?? {}, authority, sources: await communicationSources(ctx, ctx.company), quo: quo ? { id: quo._id, status: quo.status, problem: quo.problem ?? null, numbers: quo.numbers, capabilities: quo.capabilities, lastSuccessAt: quo.lastSuccessAt ?? null, lastSyncAt: quo.lastSyncAt ?? null, readFrom: quo.readFrom, webhook: quo.webhookId !== undefined, failures: quo.failures } : null, agent: agentState(ctx.company) };
  },
});

export const saveSettings = ownerMutation({
  args: { settings: qualitySettingsValidator },
  handler: async (ctx, args) => {
    const checked = checkedQualitySettings(args.settings);
    await ctx.db.patch(ctx.companyId, { quality: { ...(ctx.company.quality ?? {}), ...checked } });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quality.settings_changed", actor: member(ctx), subject: { table: "companies", id: ctx.companyId }, data: { fields: Object.keys(checked).join(", ") } });
    return null;
  },
});

// ── Contextual panels ────────────────────────────────────────────────────────────────────────────

export const forJob = companyQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await owned(ctx, args.jobId);
    const reviewsOf = await ctx.db.query("qualityReviews").withIndex("by_company_job", (q) => q.eq("companyId", ctx.companyId).eq("jobId", job._id)).take(10);
    const current = reviewsOf.sort((a, b) => b.round - a.round)[0] ?? null;
    const casesOf = (await ctx.db.query("qualityCases").withIndex("by_company_job", (q) => q.eq("companyId", ctx.companyId).eq("jobId", job._id)).take(10)).filter((c) => maySee(c, { role: ctx.role, memberId: ctx.member._id }));
    const requests = (await ctx.db.query("qualityRequests").withIndex("by_company_job", (q) => q.eq("companyId", ctx.companyId).eq("jobId", job._id)).take(20)).filter((r) => r.status === "sent" || r.status === "awaiting_approval" || r.status === "prepared");
    const correctionOf = job.recovery ? (await ctx.db.query("qualityCorrections").withIndex("by_company_correction_job", (q) => q.eq("companyId", ctx.companyId).eq("correctionJobId", job._id)).first()) : null;
    const cards = [];
    for (const c of casesOf) cards.push(await caseCard(ctx, c));
    return {
      review: current ? { id: current._id, status: current.status, statusWords: REVIEW_WORDS[current.status], recommendation: current.recommendation ?? null, words: current.recommendation ? RECOMMENDATION_WORDS[current.recommendation] : null, completeness: current.completeness, summary: current.summary, reopened: current.reopened ?? null } : null,
      cases: cards,
      waitingOn: await Promise.all(requests.map(async (r) => ({ id: r._id, purpose: PURPOSE_WORDS[r.purpose], status: REQUEST_WORDS[r.status], who: await recipientName(ctx, r), dueAt: r.dueAt }))),
      correction: correctionOf ? { id: correctionOf._id, state: CORRECTION_WORDS[correctionOf.state], acceptance: correctionOf.acceptance.criteria, verification: correctionOf.verification?.detail ?? null } : null,
    };
  },
});

async function casesWhere(ctx: QueryCtx & MemberAccess, rows: Case[]) {
  const out = [];
  for (const c of rows.filter((c) => maySee(c, { role: ctx.role, memberId: ctx.member._id })).slice(0, 10)) out.push(await caseCard(ctx, c));
  return out;
}

export const forCustomer = companyQuery({
  args: { customerId: v.id("customers") },
  handler: async (ctx, args) => {
    const customer = await owned(ctx, args.customerId);
    const rows = await ctx.db.query("qualityCases").withIndex("by_company_customer", (q) => q.eq("companyId", ctx.companyId).eq("customerId", customer._id)).order("desc").take(30);
    return { open: await casesWhere(ctx, rows.filter((c) => c.stage !== "closed")), recent: await casesWhere(ctx, rows.filter((c) => c.stage === "closed").slice(0, 5)) };
  },
});

export const forProperty = companyQuery({
  args: { propertyId: v.id("properties") },
  handler: async (ctx, args) => {
    const property = await owned(ctx, args.propertyId);
    const rows = await ctx.db.query("qualityCases").withIndex("by_company_property", (q) => q.eq("companyId", ctx.companyId).eq("propertyId", property._id)).order("desc").take(30);
    const standardsHere = await versionsOf(ctx, ctx.companyId, standardKey("property", property._id));
    const current = standardsHere.find((s) => s.status === "published");
    return { open: await casesWhere(ctx, rows.filter((c) => c.stage !== "closed")), recent: await casesWhere(ctx, rows.filter((c) => c.stage === "closed").slice(0, 5)), standard: current ? { id: current._id, name: current.name, version: current.version, requirements: current.requirements.length } : null };
  },
});

/**
 * Quality on a cleaner's profile: requests waiting on them and visits under review. Never a score, a ranking
 * or a fault count; statements are shown to managers only, on the case.
 */
export const forCleaner = managerQuery({
  args: { cleanerId: v.id("cleaners") },
  handler: async (ctx, args) => {
    const cleaner = await owned(ctx, args.cleanerId);
    const open = [];
    for (const status of ["sent", "awaiting_approval"] as const) {
      const rows = await ctx.db.query("qualityRequests").withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", status)).take(200);
      open.push(...rows.filter((r) => r.recipient.kind === "cleaner" && r.recipient.cleanerId === cleaner._id));
    }
    const answered = (await ctx.db.query("qualityRequests").withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", "answered")).take(300)).filter((r) => r.recipient.kind === "cleaner" && r.recipient.cleanerId === cleaner._id).length;
    return { waiting: await Promise.all(open.map(async (r) => ({ id: r._id, purpose: PURPOSE_WORDS[r.purpose], status: REQUEST_WORDS[r.status], dueAt: r.dueAt, job: await jobLine(ctx, r.jobId, ctx.company.timezone) }))), answered, note: "Being asked for evidence or an account is not a finding about this cleaner. Quality keeps no score." };
  },
});

export const forRetentionCase = companyQuery({
  args: { caseId: v.id("retentionCases") },
  handler: async (ctx, args) => {
    const retention = await owned(ctx, args.caseId);
    const rows = await ctx.db.query("qualityCases").withIndex("by_company_retention", (q) => q.eq("companyId", ctx.companyId).eq("retentionCaseId", retention._id)).take(5);
    const cards = await casesWhere(ctx, rows);
    const out = [];
    for (const c of rows.filter((r) => maySee(r, { role: ctx.role, memberId: ctx.member._id }))) {
      const findings = (await findingsOf(ctx, c)).filter((f) => f.state === "reviewed");
      const corrections = await correctionsOf(ctx, c);
      out.push({ caseId: c._id, findings: findings.map((f) => ({ category: FINDING_WORDS[f.category], statement: f.statement })), corrections: corrections.map((x) => ({ state: CORRECTION_WORDS[x.state], acceptance: x.acceptance.criteria, verification: x.verification?.detail ?? null })) });
    }
    return { cases: cards, detail: out };
  },
});

/** Sidebar facts for Quality's badges. */
export const sidebar = companyQuery({
  args: {},
  handler: async (ctx) => {
    const needs = (await ctx.db.query("qualityCases").withIndex("by_company_stage", (q) => q.eq("companyId", ctx.companyId).eq("stage", "needs_decision")).take(100)).filter((c) => maySee(c, { role: ctx.role, memberId: ctx.member._id }));
    const reviews = await ctx.db.query("qualityReviews").withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", "needs_decision")).take(100);
    return { serious: needs.filter((c) => c.serious && !c.serious.decision).length, decisions: needs.length, reviews: reviews.length };
  },
});

export const caseStages = ownerQuery({ args: {}, handler: async () => CASE_STAGES.map((s) => ({ id: s, words: STAGE_WORDS[s] })) });

