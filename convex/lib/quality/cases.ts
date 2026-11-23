/**
 * A quality case: one investigation, with an owner, a next step, a deadline and a timeline. Its stage, its
 * findings, its remedy and the customer's answer are four separate things and are never collapsed.
 *
 * A serious incident (safety, damage, theft, injury, conduct) is restricted to the Owner from the moment it
 * is recognised, the Owner is told at once, and the evidence on the visit is preserved. Nothing is done
 * automatically: no admission, no accusation, no contact with an insurer or authority, no promise of
 * compensation, no change to a worker's status or pay. A person records the decision, and may let ordinary
 * operational work (a correction, a reschedule) continue under control.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { recordEvent, type Actor } from "../events";
import { notifyMembers } from "../notify/route";
import { isOwner, type Role } from "../roles";
import { liveTaskByKey, openTask, setTaskState } from "../taskState";
import { areasIn, cleanAreas } from "../retention/cases";
import type { CaseClosure, CaseOrigin, CaseStage, EvidenceBasis, QualitySource } from "./schema";
import { CLOSURE_WORDS, DAY, HOUR, QUALITY, SYSTEM } from "./words";
import { seriousSignal } from "./review";

type Ctx = QueryCtx | MutationCtx;
type Case = Doc<"qualityCases">;

const taskKey = (caseId: Id<"qualityCases">) => `quality.case:${caseId}`;

// ── Who may see what ─────────────────────────────────────────────────────────────────────────────

/** A restricted (serious) case: the Owner, and the manager it was escalated to by name. Nobody else. */
export function maySee(row: Pick<Case, "restricted" | "escalated" | "ownerId">, viewer: { role: Role; memberId: Id<"members"> }): boolean {
  if (!row.restricted) return true;
  if (isOwner(viewer.role)) return true;
  return row.escalated?.toMemberId === viewer.memberId || row.ownerId === viewer.memberId;
}

/** Cleaner statements and customer submissions: managers and the Owner. Office staff see that one exists. */
export function maySeeStatements(role: Role): boolean {
  return role === "owner" || role === "manager";
}

// ── History ──────────────────────────────────────────────────────────────────────────────────────

export type EntryInput = { kind: Doc<"qualityEntries">["kind"]; text: string; basis?: EvidenceBasis; source?: QualitySource; actor?: Actor; quote?: string; at?: number };

export async function addEntry(ctx: MutationCtx, row: Pick<Case, "_id" | "companyId">, entry: EntryInput): Promise<void> {
  await ctx.db.insert("qualityEntries", {
    companyId: row.companyId,
    caseId: row._id,
    at: entry.at ?? Date.now(),
    kind: entry.kind,
    basis: entry.basis,
    text: entry.text.slice(0, 1200),
    source: entry.source,
    actor: entry.actor ?? QUALITY,
    quote: entry.quote?.slice(0, 2000),
  });
}

export async function entriesOf(ctx: Ctx, row: Pick<Case, "_id" | "companyId">) {
  return ctx.db
    .query("qualityEntries")
    .withIndex("by_company_case", (q) => q.eq("companyId", row.companyId).eq("caseId", row._id))
    .take(500);
}

// ── The case's one task ──────────────────────────────────────────────────────────────────────────

async function syncTask(ctx: MutationCtx, row: Case, actor: Actor): Promise<void> {
  const existing = row.taskId ? await ctx.db.get(row.taskId) : await liveTaskByKey(ctx, row.companyId, taskKey(row._id));
  if (row.stage === "closed") {
    if (existing && existing.status !== "done" && existing.status !== "cancelled") await setTaskState(ctx, existing, "done", { outcome: row.outcome ? CLOSURE_WORDS[row.outcome.code] : "Closed.", closedAt: Date.now(), withPersonSince: null }, actor);
    return;
  }
  let task = existing && existing.status !== "done" && existing.status !== "cancelled" ? existing : null;
  const about = row.jobId ? { table: "jobs" as const, id: row.jobId } : row.customerId ? { table: "customers" as const, id: row.customerId } : undefined;
  if (!task) {
    const taskId = await openTask(ctx, { companyId: row.companyId, agent: "quality", title: row.title, nextAction: row.doing.slice(0, 500), dueAt: Math.max(row.dueAt, Date.now() + 60_000), completionCondition: "The case's findings are reviewed by a person, any correction is verified, and the case is closed with what actually happened.", about, key: taskKey(row._id), actor });
    await ctx.db.patch(taskId, { trigger: row.happened.slice(0, 500), escalation: "If the deadline passes, the case is raised as overdue in Quality and stays open." });
    await ctx.db.patch(row._id, { taskId });
    task = (await ctx.db.get(taskId))!;
  }
  const dueAt = Math.max(row.dueAt, Date.now() + 60_000);
  const held = row.heldBy !== undefined || row.serious !== undefined;
  if (row.stage === "needs_decision" || row.stage === "needs_context") await setTaskState(ctx, task, "needs_decision", { openQuestion: (row.needs ?? row.doing).slice(0, 1000), dueAt, withPersonSince: task.withPersonSince ?? Date.now() }, actor, { sameStatus: true });
  else if (row.stage === "verifying") await setTaskState(ctx, task, "waiting", { waitingOn: "other", followUpAt: dueAt, dueAt, withPersonSince: held ? (task.withPersonSince ?? Date.now()) : null }, actor, { sameStatus: true });
  else await setTaskState(ctx, task, "open", { nextAction: row.doing.slice(0, 500), dueAt, withPersonSince: held ? (task.withPersonSince ?? Date.now()) : null }, actor, { sameStatus: true });
}

// ── Opening, moving, closing ─────────────────────────────────────────────────────────────────────

export type NewCase = {
  companyId: Id<"companies">;
  key: string;
  origin: CaseOrigin;
  originRef?: QualitySource;
  title: string;
  happened: string;
  doing: string;
  needs?: string;
  stage?: CaseStage;
  job?: Doc<"jobs"> | null;
  customerId?: Id<"customers">;
  propertyId?: Id<"properties">;
  reviewId?: Id<"qualityReviews">;
  retentionCaseId?: Id<"retentionCases">;
  reportWords?: string;
  areas?: string[];
  urgency?: Case["urgency"];
  dueAt?: number;
  historical?: boolean;
  actor: Actor;
};

export async function caseByKey(ctx: Ctx, companyId: Id<"companies">, key: string): Promise<Case | null> {
  return ctx.db
    .query("qualityCases")
    .withIndex("by_company_key", (q) => q.eq("companyId", companyId).eq("key", key))
    .first();
}

/** The open case about a visit, if there is one. A second report about the same visit joins it. */
export async function openCaseForJob(ctx: Ctx, companyId: Id<"companies">, jobId: Id<"jobs">): Promise<Case | null> {
  const rows = await ctx.db
    .query("qualityCases")
    .withIndex("by_company_job", (q) => q.eq("companyId", companyId).eq("jobId", jobId))
    .take(20);
  return rows.find((r) => r.stage !== "closed") ?? null;
}

async function crewOf(ctx: Ctx, job: Doc<"jobs">): Promise<Id<"cleaners">[]> {
  const rows = await ctx.db
    .query("assignments")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .take(30);
  return [...new Set(rows.filter((r) => r.status === "accepted").map((r) => r.cleanerId))];
}

/** Opens a case once. Asked again with the same key, or for a visit that already has an open case, it answers with that one. */
export async function openCase(ctx: MutationCtx, input: NewCase): Promise<{ row: Case; created: boolean }> {
  const existing = (await caseByKey(ctx, input.companyId, input.key)) ?? (input.job ? await openCaseForJob(ctx, input.companyId, input.job._id) : null);
  if (existing && existing.stage !== "closed") {
    if (input.reportWords) await addEntry(ctx, existing, { kind: "evidence", basis: input.origin === "cleaner_report" ? "cleaner_stated" : "customer_stated", text: "Reported again about the same visit:", quote: input.reportWords, source: input.originRef, actor: input.actor });
    const patch: Partial<Case> = {};
    if (input.retentionCaseId && !existing.retentionCaseId) patch.retentionCaseId = input.retentionCaseId;
    if (input.reviewId && !existing.reviewId) patch.reviewId = input.reviewId;
    const areas = cleanAreas([...existing.areas, ...(input.areas ?? []), ...areasIn(input.reportWords)]);
    if (areas.join() !== existing.areas.join()) patch.areas = areas;
    if (Object.keys(patch).length) await ctx.db.patch(existing._id, { ...patch, revision: existing.revision + 1, updatedAt: Date.now() });
    const fresh = (await ctx.db.get(existing._id))!;
    // A later report can carry the serious signal the first did not.
    if (!fresh.serious) {
      const why = seriousSignal(input.reportWords);
      if (why) return { row: await markSerious(ctx, fresh, why, input.actor), created: false };
    }
    return { row: fresh, created: false };
  }
  if (existing) return { row: existing, created: false };
  const now = Date.now();
  const serious = seriousSignal(input.reportWords);
  const job = input.job ?? null;
  const caseId = await ctx.db.insert("qualityCases", {
    companyId: input.companyId,
    key: input.key,
    stage: serious ? "needs_decision" : (input.stage ?? "investigating"),
    origin: input.origin,
    originRef: input.originRef,
    title: input.title.slice(0, 200),
    happened: input.happened.slice(0, 600),
    doing: serious ? "Organising and preserving the evidence for the Owner. Quality proposes no remedy and contacts nobody." : input.doing.slice(0, 600),
    needs: serious ? "A serious concern: the Owner decides what happens next." : input.needs?.slice(0, 600),
    jobId: job?._id,
    customerId: input.customerId ?? job?.customerId,
    propertyId: input.propertyId ?? job?.propertyId,
    cleanerIds: job ? await crewOf(ctx, job) : [],
    reviewId: input.reviewId,
    retentionCaseId: input.retentionCaseId,
    reportWords: input.reportWords?.slice(0, 2000),
    areas: cleanAreas([...(input.areas ?? []), ...areasIn(input.reportWords)]),
    urgency: serious ? "urgent" : (input.urgency ?? "normal"),
    restricted: false,
    historical: input.historical,
    dueAt: input.dueAt ?? now + 2 * DAY,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  let row = (await ctx.db.get(caseId))!;
  await recordEvent(ctx, { companyId: input.companyId, type: "quality_case.opened", actor: input.actor, subject: { table: "qualityCases", id: caseId }, data: { origin: input.origin, serious: serious !== null } });
  if (input.reportWords) await addEntry(ctx, row, { kind: "evidence", basis: input.origin === "cleaner_report" ? "cleaner_stated" : input.origin === "completion_review" ? "fact" : "customer_stated", text: input.origin === "completion_review" ? "What the completion review found:" : "What was reported (a report, not a finding):", quote: input.reportWords, source: input.originRef, actor: input.actor });
  if (serious) row = await markSerious(ctx, row, serious, input.actor);
  else await syncTask(ctx, row, input.actor);
  return { row: (await ctx.db.get(caseId))!, created: true };
}

export type CaseMove = Partial<Pick<Case, "stage" | "happened" | "doing" | "needs" | "dueAt" | "areas" | "ownerId" | "heldBy" | "retentionCaseId" | "urgency" | "title">> & { clearNeeds?: boolean; clearHeld?: boolean };

/** Changes a case and counts the change, so anything prepared against an older state is recognised as stale. */
export async function moveCase(ctx: MutationCtx, row: Case, move: CaseMove, actor: Actor = QUALITY): Promise<Case> {
  if (row.stage === "closed") return row;
  const { clearNeeds, clearHeld, ...fields } = move;
  // A serious case waits for its decision whatever a workflow proposes.
  if (row.serious && !row.serious.decision && fields.stage && fields.stage !== "needs_decision") delete fields.stage;
  const now = Date.now();
  const patch: Partial<Case> = { ...fields, revision: row.revision + 1, updatedAt: now };
  if (clearNeeds) patch.needs = undefined;
  if (clearHeld) patch.heldBy = undefined;
  if (row.firstActionAt === undefined && actor.kind !== "system") patch.firstActionAt = now;
  await ctx.db.patch(row._id, patch);
  const fresh = (await ctx.db.get(row._id))!;
  if (fields.stage && fields.stage !== row.stage) await recordEvent(ctx, { companyId: row.companyId, type: `quality_case.${fields.stage}`, actor, subject: { table: "qualityCases", id: row._id }, data: { from: row.stage } });
  await syncTask(ctx, fresh, actor);
  return (await ctx.db.get(row._id))!;
}

/** Closes with what actually happened. Open links stop working; prepared steps that never went anywhere end with it. */
export async function closeCase(ctx: MutationCtx, row: Case, code: CaseClosure, actor: Actor, note?: string): Promise<Case> {
  if (row.stage === "closed") return row;
  const now = Date.now();
  await ctx.db.patch(row._id, { stage: "closed", outcome: { code, note: note?.slice(0, 600), by: actor, at: now }, closedAt: now, updatedAt: now, revision: row.revision + 1, needs: undefined, doing: "Closed." });
  const fresh = (await ctx.db.get(row._id))!;
  await addEntry(ctx, fresh, { kind: "outcome", text: `${CLOSURE_WORDS[code]}${note ? ` ${note}` : ""}`, actor });
  await recordEvent(ctx, { companyId: row.companyId, type: "quality_case.closed", actor, subject: { table: "qualityCases", id: row._id }, data: { outcome: code } });
  const requests = await ctx.db
    .query("qualityRequests")
    .withIndex("by_company_case", (q) => q.eq("companyId", row.companyId).eq("caseId", row._id))
    .take(50);
  for (const r of requests) {
    if (r.status === "prepared" || r.status === "awaiting_approval") await ctx.db.patch(r._id, { status: "cancelled", result: "The case was closed first.", updatedAt: now });
    if (r.publicId && r.revokedAt === undefined && r.status !== "answered") await ctx.db.patch(r._id, { revokedAt: now, revokeReason: "The case was closed." });
  }
  await syncTask(ctx, fresh, actor);
  return fresh;
}

// ── Serious incidents ────────────────────────────────────────────────────────────────────────────

/**
 * Restricts the case to the Owner (permanently), preserves the evidence the visit holds, escalates to the
 * Owner at once, and holds the case for a person. Nothing else happens.
 */
export async function markSerious(ctx: MutationCtx, row: Case, reason: string, actor: Actor): Promise<Case> {
  if (row.serious) return row;
  const now = Date.now();
  await ctx.db.patch(row._id, {
    serious: { reason: reason.slice(0, 400), at: now, preservedAt: now },
    restricted: true,
    stage: "needs_decision",
    urgency: "urgent",
    escalated: row.escalated ?? { at: now, by: actor, reason: "Serious concern: escalated to the Owner at once." },
    doing: "Organising and preserving the evidence for the Owner. Quality proposes no remedy and contacts nobody.",
    needs: "A serious concern: the Owner decides what happens next.",
    revision: row.revision + 1,
    updatedAt: now,
  });
  let fresh = (await ctx.db.get(row._id))!;
  await addEntry(ctx, fresh, { kind: "note", text: `${reason} The case is restricted to the Owner, and the visit's photos, checklist and reports are preserved. Nothing has been admitted, nobody has been accused, and no one outside the company has been contacted.`, actor: SYSTEM });
  await preserveJobEvidence(ctx, fresh, actor);
  // Prepared requests to anyone outside stop: a person decides who is asked what.
  const requests = await ctx.db
    .query("qualityRequests")
    .withIndex("by_company_case", (q) => q.eq("companyId", row.companyId).eq("caseId", row._id))
    .take(50);
  for (const r of requests) if (r.status === "prepared" || r.status === "awaiting_approval") await ctx.db.patch(r._id, { status: "cancelled", result: "A serious concern was recognised. A person decides who is asked what.", updatedAt: now });
  await recordEvent(ctx, { companyId: row.companyId, type: "quality_case.serious", actor, subject: { table: "qualityCases", id: row._id }, data: {} });
  await notifyMembers(ctx, { companyId: row.companyId, event: "quality_serious", ref: row._id, key: `quality_serious:${row._id}`, facts: { title: fresh.title } });
  fresh = (await ctx.db.get(row._id))!;
  await syncTask(ctx, fresh, actor);
  return fresh;
}

/** Pins the visit's photos, checklist and reports to the case and marks them preserved. Originals are never changed. */
export async function preserveJobEvidence(ctx: MutationCtx, row: Case, actor: Actor): Promise<number> {
  if (!row.jobId) return 0;
  const job = await ctx.db.get(row.jobId);
  if (!job) return 0;
  let pinned = 0;
  const pin = async (kind: Doc<"qualityEvidence">["kind"], source: QualitySource, receivedAt?: number) => {
    const existing = await ctx.db
      .query("qualityEvidence")
      .withIndex("by_company_source", (q) => q.eq("companyId", row.companyId).eq("source.id", source.id))
      .take(10);
    const here = existing.find((e) => e.caseId === row._id);
    if (here) {
      if (!here.preserved) await ctx.db.patch(here._id, { preserved: true });
      return;
    }
    await ctx.db.insert("qualityEvidence", { companyId: row.companyId, caseId: row._id, kind, source, receivedAt, access: "available", preserved: true, addedBy: actor, addedAt: Date.now() });
    pinned += 1;
  };
  const photos = await ctx.db
    .query("evidence")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .take(500);
  for (const p of photos) await pin("photo", { table: "evidence", id: p._id, label: `${p.kind} photo`, at: p.uploadedAt }, p.uploadedAt);
  const reports = await ctx.db
    .query("jobReports")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .take(50);
  for (const r of reports) await pin("report", { table: "jobReports", id: r._id, label: "Crew report", at: r.createdAt }, r.createdAt);
  await pin("checklist", { table: "jobs", id: job._id, label: "The visit's checklist and record", at: job.startsAt });
  return pinned;
}

/** Whether a stored photo may be deleted by a routine: never while a case preserves it. */
export async function isPreserved(ctx: Ctx, companyId: Id<"companies">, sourceId: string): Promise<boolean> {
  const rows = await ctx.db
    .query("qualityEvidence")
    .withIndex("by_company_source", (q) => q.eq("companyId", companyId).eq("source.id", sourceId))
    .take(10);
  return rows.some((r) => r.preserved);
}

export const DUE = { decision: 2 * DAY, serious: 4 * HOUR };
