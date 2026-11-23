/**
 * Quality's workflows, each started by a keyed run (lib/quality/runs.ts) or by a person.
 *
 *  - reviewVisit: a crew reported a visit done (or evidence arrived): resolve the standard that applied once,
 *    read the record, compare, recommend; ask the crew for what they can supply; open a case only when there
 *    is something beyond documentation; close requests whose evidence arrived.
 *  - onConcern: feedback, a report or a conversation raised a concern about a visit: one case per visit,
 *    suggested findings from the record, statements requested where accounts conflict, Retention linked.
 *  - followCorrection: a correction's visit moved: read it back, verify it when done.
 *  - upkeep: requests past due, corrections and their customer answers, patterns, evaluations.
 *
 * Deterministic rules decide completeness, deadlines and authority. A reader (AI) may add interpretation
 * later; it never decides.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { Actor } from "../events";
import { recordEvent } from "../events";
import { dayName } from "../time";
import { reviewKey } from "../dispatch/live";
import { liveTaskByKey, setTaskState } from "../taskState";
import { areasIn, cleanAreas } from "../retention/cases";
import { addEntry, closeCase, moveCase, openCase, openCaseForJob } from "./cases";
import { correctionsOf, syncCorrection, verifyCorrection } from "./corrections";
import { evidenceStamp, jobFacts, type JobFacts } from "./evidence";
import { recordSuggestions, suggestFindings, findingsOf } from "./findings";
import { evaluateImprovements, scanPatterns } from "./improvements";
import { closeSatisfied, prepareRequest, routeRequest, upkeepRequests, openRequestsFor } from "./requests";
import { reviewFacts, seriousSignal } from "./review";
import { agentState, enqueueQualityRun } from "./runs";
import { qualitySettings } from "./settings";
import { qualityReader } from "./reader";
import type { QualitySource } from "./schema";
import { resolveStandard } from "./standards";
import { DAY, QUALITY, RECOMMENDATION_WORDS, SYSTEM } from "./words";

type Review = Doc<"qualityReviews">;

export type Outcome = { result: string; checked: string[]; found: string[]; next: string[]; reviewId?: Id<"qualityReviews">; caseId?: Id<"qualityCases"> };

async function openConcernAt(ctx: MutationCtx, job: Doc<"jobs">): Promise<boolean> {
  const quality = await ctx.db
    .query("qualityCases")
    .withIndex("by_company_property", (q) => q.eq("companyId", job.companyId).eq("propertyId", job.propertyId))
    .take(30);
  if (quality.some((c) => c.stage !== "closed" && c.jobId !== job._id)) return true;
  const retention = await ctx.db
    .query("retentionCases")
    .withIndex("by_company_property", (q) => q.eq("companyId", job.companyId).eq("propertyId", job.propertyId))
    .take(30);
  return retention.some((c) => c.kind === "recovery" && c.status !== "closed" && c.jobId !== job._id);
}

async function complaintsInComms(ctx: MutationCtx, job: Doc<"jobs">): Promise<QualitySource[]> {
  const comms = await ctx.db
    .query("qualityComms")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .take(50);
  const out: QualitySource[] = [];
  for (const c of comms) {
    const extracts = await ctx.db
      .query("qualityExtracts")
      .withIndex("by_company_comm", (q) => q.eq("companyId", job.companyId).eq("commId", c._id))
      .take(20);
    if (extracts.some((e) => e.kind === "complaint" && e.state !== "rejected" && e.state !== "stale")) out.push({ table: "qualityComms", id: c._id, label: c.kind === "call" ? "Call" : "Text", at: c.occurredAt });
  }
  return out;
}

/** The review row for a visit's current completion round. */
export async function currentReview(ctx: MutationCtx, job: Doc<"jobs">): Promise<Review | null> {
  return ctx.db
    .query("qualityReviews")
    .withIndex("by_company_key", (q) => q.eq("companyId", job.companyId).eq("key", `review:${job._id}:${(job.completionReturns ?? 0) + 1}`))
    .first();
}

/**
 * Reviews one visit's current round. Unchanged evidence is not reviewed again. `act` is false when the
 * agent may not act (a person asked, or Quality is paused or not on the plan): the review is recorded and
 * nothing is sent or opened on its own.
 */
export async function reviewVisit(ctx: MutationCtx, company: Doc<"companies">, job: Doc<"jobs">, opts: { act: boolean; actor: Actor; reason?: string }): Promise<Outcome> {
  if (job.status === "cancelled") return { result: "The visit was cancelled.", checked: [], found: [], next: [] };
  if (job.completionReportedAt === undefined && job.status !== "completed") return { result: "The crew has not reported the visit done yet.", checked: [], found: [], next: [] };
  const round = (job.completionReturns ?? 0) + 1;
  const key = `review:${job._id}:${round}`;
  const facts = await jobFacts(ctx, job);
  const complaints = await complaintsInComms(ctx, job);
  const stamp = evidenceStamp(facts, complaints.length);
  let review = await ctx.db
    .query("qualityReviews")
    .withIndex("by_company_key", (q) => q.eq("companyId", company._id).eq("key", key))
    .first();
  // Unchanged evidence is not read again, unless the agent has yet to act on it (a person reviewed it while Quality was paused).
  if (review && review.evidenceStamp === stamp && (review.acted || !opts.act)) return { result: "Nothing changed since the last review.", checked: review.checked, found: review.found, next: review.next, reviewId: review._id, caseId: review.caseId };
  // Earlier rounds were superseded by this submission. The visit still happened; their record stays.
  const rounds = await ctx.db
    .query("qualityReviews")
    .withIndex("by_company_job", (q) => q.eq("companyId", company._id).eq("jobId", job._id))
    .take(20);
  for (const r of rounds) if (r.round < round && r.status !== "superseded") await ctx.db.patch(r._id, { status: "superseded", updatedAt: Date.now() });
  const resolved = review?.standard ?? (await resolveStandard(ctx, company, job));
  const standard = review?.standard ?? { asOf: resolved.asOf, resolvedAt: Date.now(), sources: resolved.sources.filter((s) => s.version > 0), requirements: resolved.requirements, waived: resolved.waived };
  const baseline = "baseline" in resolved ? resolved.baseline : standard.sources.every((s) => s.level !== "company");
  const out = reviewFacts({ requirements: standard.requirements, waived: standard.waived, baseline, baselineWords: baseline ? "No Quality standard is published yet, so this visit was reviewed against the rules already on record: the checklist, and Dispatch's photo counts." : null }, facts, { openConcernAtProperty: await openConcernAt(ctx, job), complaintsInComms: complaints });
  const now = Date.now();
  const next: string[] = [];
  const decided = review?.decision !== undefined;
  const reopened = decided && review!.evidenceStamp !== stamp && (complaints.length > 0 || out.recommendation !== "approve") ? { at: now, reason: complaints.length ? "A conversation linked to this visit arrived after it was reviewed." : "New evidence arrived after the review was decided.", source: complaints[0] } : review?.reopened;
  let status: Review["status"] = out.recommendation === "approve" ? "ready" : out.recommendation === "request_information" ? "waiting_on_evidence" : "needs_decision";
  if (decided && !reopened) status = review!.status;
  if (decided && reopened) status = "needs_decision";
  const fields = {
    status,
    results: out.results,
    completeness: out.completeness,
    flags: out.flags,
    recommendation: out.recommendation,
    recommendedBy: "rules",
    summary: out.summary.slice(0, 1200),
    checked: [`The standard that applied (${standard.sources.length ? standard.sources.map((s) => `${s.name} v${s.version}`).join(", ") : "the rules on record"})`, ...out.checked],
    found: out.found,
    evidenceStamp: stamp,
    reopened,
    historical: facts.historical || undefined,
    updatedAt: now,
  };
  if (!review) {
    const reviewId = await ctx.db.insert("qualityReviews", { companyId: company._id, jobId: job._id, customerId: job.customerId, propertyId: job.propertyId, round, key, standard, next: [], createdAt: now, ...fields });
    review = (await ctx.db.get(reviewId))!;
    await recordEvent(ctx, { companyId: company._id, type: "quality_review.created", actor: opts.actor, subject: { table: "qualityReviews", id: reviewId }, data: { recommendation: out.recommendation, round } });
  } else {
    await ctx.db.patch(review._id, fields);
    review = (await ctx.db.get(review._id))!;
    await recordEvent(ctx, { companyId: company._id, type: "quality_review.updated", actor: opts.actor, subject: { table: "qualityReviews", id: review._id }, data: { recommendation: out.recommendation, reopened: reopened !== undefined } });
  }
  // Evidence that arrived closes what asked for it, whoever may act.
  const pending = new Set(facts.checklist.filter((c) => c.state === "pending" || (c.state === "skipped" && !c.skipReason)).map((c) => c.id as string));
  const satisfied = await closeSatisfied(ctx, company._id, job._id, out.results, pending);
  if (satisfied) next.push(`Closed ${satisfied} request${satisfied === 1 ? "" : "s"}: what was asked for is now on record.`);

  let caseId = review.caseId;
  if (!opts.act) next.push(opts.reason ?? "Quality's agent work is not running, so nothing was sent and no case was opened. A person decides.");
  else if (facts.historical) next.push("Imported visit: recorded only. Nobody is contacted.");
  else if (out.serious || out.recommendation === "investigate" || out.recommendation === "correct" || reopened) {
    const flagged = out.flags.filter((f) => f.code !== "historical" && f.code !== "open_concern_here").map((f) => f.text);
    const skippedAreas = facts.checklist.filter((c) => c.state === "skipped" || c.state === "pending").flatMap((c) => areasIn(c.label));
    const opened = await openCase(ctx, {
      companyId: company._id,
      key: `review:${job._id}:${round}`,
      origin: "completion_review",
      originRef: { table: "qualityReviews", id: review._id, label: "Completion review" },
      title: `${facts.customer?.name ?? "Visit"}: ${[...new Set(skippedAreas)].join(", ") || (out.serious ? "a serious concern" : "the visit's record")} (${job.serviceSnapshot?.name ?? job.serviceType}, ${dayName(job.startsAt, company.timezone)})`,
      happened: out.summary.slice(0, 600),
      doing: "Reading the visit's record against the standard and preparing findings for a person to review.",
      stage: "investigating",
      job,
      reviewId: review._id,
      reportWords: flagged.join(" ").slice(0, 2000) || undefined,
      areas: cleanAreas(skippedAreas),
      actor: QUALITY,
    });
    caseId = opened.row._id;
    await ctx.db.patch(review._id, { caseId, status: decided ? review.status : "case_opened" });
    if (opened.created && !opened.row.serious) {
      const suggestions = suggestFindings({ facts, areas: opened.row.areas, words: flagged.join(" "), report: { table: "qualityReviews", id: review._id, label: "Completion review" }, serious: null });
      const added = await recordSuggestions(ctx, opened.row, suggestions, "rules");
      await askReader(ctx, company, opened.row, opts.act);
      await moveCase(ctx, (await ctx.db.get(caseId))!, { stage: "needs_decision", doing: `${added} suggested ${added === 1 ? "finding is" : "findings are"} ready for a person to review.`, needs: "Review the suggested findings against the evidence. Confirm, revise or reject each one.", dueAt: now + 2 * DAY }, QUALITY);
    }
    next.push(opened.row.serious ? "A serious signal: the case is restricted to the Owner and its evidence preserved." : opened.created ? "Opened a case with suggested findings for a person to review." : "Added to the case already open for this visit.");
  } else if (out.recommendation === "request_information" && out.askable.items.length) {
    const lead = facts.crew.find((c) => c.status === "accepted" && c.role === "lead") ?? facts.crew.find((c) => c.status === "accepted");
    if (lead) {
      const prepared = await prepareRequest(ctx, company, { job, recipient: { kind: "cleaner", cleanerId: lead.cleanerId }, purpose: "missing_evidence", questions: [], evidence: out.askable.items.map((i) => ({ id: i.id, label: i.label, photoKind: i.photoKind, requirementId: i.requirementId })), reviewId: review._id, key: `evidence:${job._id}:${round}:${lead.cleanerId}`, actor: QUALITY });
      if (prepared.request) {
        const routed = prepared.created ? await routeRequest(ctx, company, prepared.request, QUALITY) : { status: prepared.request.status, detail: prepared.request.result ?? "" };
        next.push(routed.status === "sent" ? `Asked ${lead.name} for what is missing, in one request.` : routed.status === "awaiting_approval" ? `A request to ${lead.name} is waiting for approval.` : `A request to ${lead.name} was ${routed.status.replace(/_/g, " ")}: ${routed.detail}`);
        if (routed.status !== "sent") await ctx.db.patch(review._id, { status: "needs_decision" });
      } else {
        next.push(prepared.why);
        await ctx.db.patch(review._id, { status: "needs_decision" });
      }
    }
  } else if (out.recommendation === "approve") next.push("A manager can close the visit. Quality's review does not close it or approve pay.");
  await ctx.db.patch(review._id, { next, caseId, acted: review.acted || opts.act });
  // The person-worked review task now carries Quality's recommendation.
  const task = await liveTaskByKey(ctx, company._id, reviewKey(job._id));
  if (task && task.status !== "done" && task.status !== "cancelled") await setTaskState(ctx, task, "needs_decision", { openQuestion: `Quality: ${RECOMMENDATION_WORDS[out.recommendation]}. ${out.summary}`.slice(0, 1000), dueAt: task.dueAt, withPersonSince: task.withPersonSince ?? now }, QUALITY, { sameStatus: true });
  return { result: `${RECOMMENDATION_WORDS[out.recommendation]}.`, checked: (await ctx.db.get(review._id))!.checked, found: out.found, next, reviewId: review._id, caseId };
}

/** When the Owner turned the reader on and one is connected, it reads the case's evidence once per evidence state. */
async function askReader(ctx: MutationCtx, company: Doc<"companies">, row: Doc<"qualityCases">, act: boolean): Promise<void> {
  if (!act || row.serious || row.historical || !qualitySettings(company).reader || !qualityReader()) return;
  await enqueueQualityRun(ctx, { companyId: company._id, kind: "interpret", key: `interpret:${row._id}:${row.revision}`, caseId: row._id, jobId: row.jobId });
}

/** A report was sent back: the round's open requests end with it. A new submission is a new round. */
export async function onReturned(ctx: MutationCtx, job: Doc<"jobs">): Promise<void> {
  const prior = await ctx.db
    .query("qualityReviews")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .take(20);
  for (const r of prior) if (r.status !== "superseded" && r.round <= (job.completionReturns ?? 0)) await ctx.db.patch(r._id, { status: "superseded", updatedAt: Date.now() });
  for (const r of await openRequestsFor(ctx, job.companyId, job._id)) {
    if ((r.status === "prepared" || r.status === "awaiting_approval") && r.purpose === "missing_evidence") await ctx.db.patch(r._id, { status: "cancelled", result: "The report was sent back to the crew, which asks for the same things.", updatedAt: Date.now() });
  }
}

export type Concern = { job: Doc<"jobs">; words?: string; areas?: string[]; origin: Doc<"qualityCases">["origin"]; source?: QualitySource; retentionCaseId?: Id<"retentionCases">; historical?: boolean; actor: Actor; act: boolean };

/** A concern about a visit: one case per visit, findings suggested from the record, statements asked where accounts conflict. */
export async function onConcern(ctx: MutationCtx, company: Doc<"companies">, concern: Concern): Promise<Outcome> {
  const { job } = concern;
  const facts: JobFacts = await jobFacts(ctx, job);
  const customer = facts.customer;
  const areas = cleanAreas([...(concern.areas ?? []), ...areasIn(concern.words)]);
  const opened = await openCase(ctx, {
    companyId: company._id,
    key: concern.retentionCaseId ? `retention:${concern.retentionCaseId}` : `concern:${job._id}:${concern.source?.id ?? Date.now()}`,
    origin: concern.origin,
    originRef: concern.source,
    title: `${customer?.name ?? "A customer"}: ${areas.join(", ") || (seriousSignal(concern.words) ? "a serious concern" : "a concern")} (${job.serviceSnapshot?.name ?? job.serviceType}, ${dayName(job.startsAt, company.timezone)})`,
    happened: `${concern.origin === "cleaner_report" ? "A cleaner" : customer?.name ?? "A customer"} reported ${areas.length ? `a concern about the ${areas.join(", ")} on this visit` : "a concern about this visit"}. A report is not a finding.`,
    doing: "Gathering the visit's record and comparing it with what was reported.",
    job,
    retentionCaseId: concern.retentionCaseId,
    reportWords: concern.words,
    areas,
    historical: concern.historical || facts.historical,
    actor: concern.actor,
  });
  let row = opened.row;
  const next: string[] = [];
  if (row.serious) return { result: "A serious concern: restricted to the Owner, evidence preserved.", checked: ["The words of the report"], found: [row.serious.reason], next: ["The Owner decides what happens next."], caseId: row._id };
  const suggestions = suggestFindings({ facts, areas: row.areas, words: concern.words, report: concern.source, serious: seriousSignal(concern.words) });
  const added = await recordSuggestions(ctx, row, suggestions, "rules");
  next.push(`${added} suggested ${added === 1 ? "finding" : "findings"} for a person to review.`);
  // Where the crew's record and the report disagree, each crew member is asked for their account. Not only the lead.
  const conflicting = suggestions.some((s) => s.conflicting.length > 0 || s.category === "service_miss");
  if (conflicting && concern.act && !row.historical) {
    for (const member of facts.crew.filter((c) => c.status === "accepted")) {
      const prepared = await prepareRequest(ctx, company, { job, recipient: { kind: "cleaner", cleanerId: member.cleanerId }, purpose: "statement", questions: [{ id: "account", text: `In your own words, how did the visit go${row.areas.length ? `, including ${row.areas.join(" and ")}` : ""}?` }, { id: "anything", text: "Is there anything about the visit the office should know (access, supplies, time, the property's condition)?" }], evidence: [], caseId: row._id, key: `statement:${row._id}:${member.cleanerId}`, actor: QUALITY });
      if (prepared.request && prepared.created) {
        const routed = await routeRequest(ctx, company, prepared.request, QUALITY);
        next.push(`Account requested from ${member.name}: ${routed.status.replace(/_/g, " ")}.`);
      } else if (!prepared.request) next.push(prepared.why);
    }
  }
  row = (await ctx.db.get(row._id))!;
  await askReader(ctx, company, row, concern.act);
  await moveCase(ctx, row, { stage: "needs_decision", doing: "Suggested findings are ready. Accounts are requested where the record and the report disagree.", needs: "Review the suggested findings against the evidence.", dueAt: Date.now() + 2 * DAY }, concern.actor);
  return { result: opened.created ? "Opened a case for the concern." : "Added the concern to the visit's open case.", checked: ["The visit's scope, checklist, photos and crew reports", "Earlier cases at the property"], found: suggestions.map((s) => s.statement).slice(0, 4), next, caseId: row._id };
}

/** A correction's visit changed: read it back, and verify it once it is done. */
export async function followCorrection(ctx: MutationCtx, company: Doc<"companies">, correctionJobId: Id<"jobs">): Promise<Outcome> {
  const rows = await ctx.db
    .query("qualityCorrections")
    .withIndex("by_company_correction_job", (q) => q.eq("companyId", company._id).eq("correctionJobId", correctionJobId))
    .take(5);
  // A correction booked after the last sync has no job id yet: look through those under way.
  const underway = rows.length ? rows : (await ctx.db.query("qualityCorrections").withIndex("by_company_state", (q) => q.eq("companyId", company._id)).take(200)).filter((c) => c.state !== "quality_verified" && c.state !== "cancelled");
  const found: string[] = [];
  for (const c of underway) {
    await syncCorrection(ctx, c);
    const fresh = (await ctx.db.get(c._id))!;
    if (fresh.correctionJobId !== correctionJobId) continue;
    if (fresh.state === "completed") {
      const verified = await verifyCorrection(ctx, company, fresh, QUALITY);
      found.push(verified.verification ? verified.verification.detail : "Waiting for a person to record the inspection.");
    }
  }
  return { result: found.length ? found.join(" ") : "Nothing to verify yet.", checked: ["The correction visit's checklist, photos and status"], found, next: [] };
}

/** Retention's case for the episode closed: the customer's answer is now known, and a verified case can close. */
export async function onRetentionOutcome(ctx: MutationCtx, company: Doc<"companies">, retentionCaseId: Id<"retentionCases">): Promise<Outcome> {
  const linked = await ctx.db
    .query("qualityCases")
    .withIndex("by_company_retention", (q) => q.eq("companyId", company._id).eq("retentionCaseId", retentionCaseId))
    .take(10);
  const found: string[] = [];
  for (const row of linked) {
    for (const c of await correctionsOf(ctx, row)) await syncCorrection(ctx, c);
    const corrections = await correctionsOf(ctx, row);
    const retention = await ctx.db.get(retentionCaseId);
    if (retention?.outcome) await addEntry(ctx, row, { kind: "outcome", basis: retention.outcome.code === "customer_confirmed" ? "customer_stated" : "fact", text: `Retention recorded the customer outcome: ${retention.outcome.code.replace(/_/g, " ")}. That is the customer's side; Quality's findings and verification are recorded separately.`, source: { table: "retentionCases", id: retentionCaseId, label: "Retention case" }, actor: SYSTEM });
    if (row.stage === "verifying" && corrections.some((c) => c.state === "quality_verified")) {
      await closeCase(ctx, row, "correction_verified", SYSTEM, retention?.outcome ? `Customer outcome on Retention's case: ${retention.outcome.code.replace(/_/g, " ")}.` : undefined);
      found.push(`Closed "${row.title}".`);
    }
  }
  return { result: found.length ? found.join(" ") : "Recorded the customer outcome on linked cases.", checked: ["Linked quality cases"], found, next: [] };
}

/** Everything that keeps Quality's records honest between events. */
export async function upkeep(ctx: MutationCtx, company: Doc<"companies">, now: number): Promise<Outcome> {
  const state = agentState(company);
  const requests = await upkeepRequests(ctx, company, now);
  let synced = 0;
  for (const s of ["proposed", "approved", "scheduled", "crew_accepted", "completed"] as const) {
    const rows = await ctx.db
      .query("qualityCorrections")
      .withIndex("by_company_state", (q) => q.eq("companyId", company._id).eq("state", s))
      .take(100);
    for (const c of rows) {
      if (await syncCorrection(ctx, c)) synced += 1;
      const fresh = (await ctx.db.get(c._id))!;
      if (fresh.state === "completed") await verifyCorrection(ctx, company, fresh, QUALITY);
    }
  }
  const proposed = state.ok ? await scanPatterns(ctx, company, now) : 0;
  const evaluated = await evaluateImprovements(ctx, company, now);
  return { result: `${requests.reminded} reminders, ${requests.unanswered} unanswered, ${requests.expired} expired, ${synced} corrections updated, ${proposed} improvements proposed, ${evaluated} evaluated`, checked: ["Requests past due", "Corrections under way", "Reviewed patterns"], found: [], next: [] };
}

export { findingsOf, openCaseForJob };
