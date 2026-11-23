/**
 * Quality's background work: the runs that follow events (a visit reported done, evidence added, feedback,
 * a correction completed, a customer outcome), the check before a visit, and the sweep that keeps everything
 * moving without anyone's browser open.
 *
 * Every run is a keyed `qualityRuns` row (convex/lib/quality/runs.ts). A run that throws changes nothing
 * and is retried with backoff by the sweep, then failed and put in front of a person. A run that cannot go
 * ahead because Quality is paused, not on the plan or the company is suspended is `blocked` with the reason,
 * and resumes when it clears. People keep the workspace throughout.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { finishExecution, openExecution } from "./lib/billing/executions";
import { reserveExecution } from "./lib/billing/reserve";
import { addEntry } from "./lib/quality/cases";
import { assembleEvidence } from "./lib/quality/evidence";
import { checkedReaderFindings, recordSuggestions } from "./lib/quality/findings";
import { citable, qualityReader } from "./lib/quality/reader";
import { liveTaskByKey, openTask, setTaskState } from "./lib/taskState";
import { moveCase } from "./lib/quality/cases";
import { agentState, enqueueQualityRun, finishRun, leaseRun, MAX_ATTEMPTS, nextAttemptAfter } from "./lib/quality/runs";
import { resolveStandard } from "./lib/quality/standards";
import { followCorrection, onConcern, onRetentionOutcome, reviewVisit, upkeep } from "./lib/quality/workflow";
import { DAY, HOUR, MINUTE, QUALITY, SYSTEM } from "./lib/quality/words";
import { isHistorical } from "./lib/quality/evidence";

/** Runs that only record (they send nothing and open nothing) go ahead even while agent work is blocked. */
const RECORD_ONLY = new Set<Doc<"qualityRuns">["kind"]>(["correction_completed", "case_outcome", "financial_settled", "statement_submitted", "upkeep"]);

/**
 * Before a visit: is there a clear scope, a checklist, the property's instructions, and nothing unresolved
 * at the property? Opens one task listing genuine gaps. It never holds an ordinary visit for optional records.
 */
async function preService(ctx: MutationCtx, company: Doc<"companies">, job: Doc<"jobs">): Promise<{ result: string; found: string[] }> {
  if (job.status !== "scheduled" || job.startsAt < Date.now()) return { result: "The visit is no longer ahead.", found: [] };
  if (await isHistorical(ctx, job)) return { result: "Imported visit: not checked.", found: [] };
  const gaps: string[] = [];
  const scopeLines = job.scope.split("\n").filter((l) => l.trim().startsWith("- ")).length;
  if (!scopeLines) gaps.push("The visit's scope lists no individual tasks.");
  const items = await ctx.db.query("checklistItems").withIndex("by_company_job", (q) => q.eq("companyId", company._id).eq("jobId", job._id)).take(5);
  const standard = await resolveStandard(ctx, company, job);
  const needsChecklist = standard.requirements.some((r) => r.requirement.kind === "checklist_completion" && r.requirement.level === "required");
  if (needsChecklist && !items.length) gaps.push("The standard asks for every checklist item to be marked, and this visit has no checklist.");
  const property = await ctx.db.get(job.propertyId);
  const earlier = await ctx.db.query("jobs").withIndex("by_company_property_start", (q) => q.eq("companyId", company._id).eq("propertyId", job.propertyId).lt("startsAt", job.startsAt)).take(1);
  if (property && !earlier.length && !property.accessInstructions?.trim()) gaps.push("A first visit to this property, with no access instructions on record.");
  const open = await ctx.db.query("qualityCases").withIndex("by_company_property", (q) => q.eq("companyId", company._id).eq("propertyId", job.propertyId)).take(20);
  const unresolved = open.filter((c) => c.stage !== "closed" && !c.restricted);
  if (unresolved.length) gaps.push(`${unresolved.length} open quality ${unresolved.length === 1 ? "case is" : "cases are"} at this property: "${unresolved[0].title}".`);
  if (!gaps.length) return { result: "Nothing missing before the visit.", found: [] };
  const key = `quality.pre:${job._id}`;
  if (!(await liveTaskByKey(ctx, company._id, key))) {
    const taskId = await openTask(ctx, { companyId: company._id, agent: "quality", title: `Before the visit on ${new Date(job.startsAt).toISOString().slice(0, 10)}: ${gaps.length} ${gaps.length === 1 ? "gap" : "gaps"} to look at`, nextAction: gaps.join(" ").slice(0, 500), dueAt: Math.max(Date.now() + HOUR, job.startsAt - 2 * HOUR), completionCondition: "Each gap is filled or a person decided it does not matter for this visit. The visit goes ahead either way.", about: { table: "jobs", id: job._id }, key, actor: QUALITY });
    await setTaskState(ctx, (await ctx.db.get(taskId))!, "needs_decision", { openQuestion: gaps.join(" ").slice(0, 1000), dueAt: Math.max(Date.now() + HOUR, job.startsAt - 2 * HOUR), withPersonSince: Date.now() }, QUALITY);
  }
  return { result: `${gaps.length} gap(s) before the visit; a task lists them. The visit is not held.`, found: gaps };
}

export const run = internalMutation({
  args: { runId: v.id("qualityRuns") },
  handler: async (ctx, args) => {
    const run = await leaseRun(ctx, args.runId);
    if (!run) return null;
    const company = await ctx.db.get(run.companyId);
    if (!company) return finishRun(ctx, run, { status: "skipped", result: "The company no longer exists." });
    const state = agentState(company);
    if (!state.ok && !RECORD_ONLY.has(run.kind)) return finishRun(ctx, run, { status: "blocked", result: "Waiting: Quality's agent work is not running.", blockedReason: state.reason });
    const payload = run.payload ? (JSON.parse(run.payload) as Record<string, unknown>) : {};
    const job = run.jobId ? await ctx.db.get(run.jobId) : null;
    switch (run.kind) {
      case "completion_submitted":
      case "evidence_added": {
        if (!job) return finishRun(ctx, run, { status: "skipped", result: "The visit no longer exists." });
        const out = await reviewVisit(ctx, company, job, { act: state.ok, actor: QUALITY });
        return finishRun(ctx, run, { status: "done", ...out });
      }
      case "feedback_submitted": {
        const retentionCaseId = typeof payload.retentionCaseId === "string" ? ctx.db.normalizeId("retentionCases", payload.retentionCaseId) : null;
        const retention = retentionCaseId ? await ctx.db.get(retentionCaseId) : null;
        if (!retention || !retention.jobId) return finishRun(ctx, run, { status: "skipped", result: "The concern is not about one visit." });
        // An episode Quality opened itself is already Quality's case.
        if (retention.key.startsWith("quality:")) return finishRun(ctx, run, { status: "skipped", result: "Opened from Quality; nothing to add." });
        const visit = await ctx.db.get(retention.jobId);
        if (!visit) return finishRun(ctx, run, { status: "skipped", result: "The visit no longer exists." });
        const out = await onConcern(ctx, company, { job: visit, words: retention.customerWords, areas: retention.areas, origin: retention.origin === "conversation" ? "sms" : "customer_feedback", source: { table: "retentionCases", id: retention._id, label: "Customer concern (Retention)", at: retention.createdAt }, retentionCaseId: retention._id, actor: QUALITY, act: state.ok });
        return finishRun(ctx, run, { status: "done", ...out });
      }
      case "correction_completed": {
        if (!job) return finishRun(ctx, run, { status: "skipped", result: "The visit no longer exists." });
        const out = await followCorrection(ctx, company, job._id);
        return finishRun(ctx, run, { status: "done", ...out });
      }
      case "case_outcome":
      case "financial_settled": {
        const retentionCaseId = typeof payload.retentionCaseId === "string" ? ctx.db.normalizeId("retentionCases", payload.retentionCaseId) : null;
        if (!retentionCaseId) return finishRun(ctx, run, { status: "skipped", result: "No case named." });
        const out = await onRetentionOutcome(ctx, company, retentionCaseId);
        return finishRun(ctx, run, { status: "done", ...out });
      }
      case "statement_submitted": {
        const row = run.caseId ? await ctx.db.get(run.caseId) : null;
        if (!row || row.stage === "closed") return finishRun(ctx, run, { status: "skipped", result: "The case is closed." });
        await moveCase(ctx, row, { stage: "needs_decision", needs: "A new account or answer arrived. Read it against the findings: an account is evidence, not a finding.", doing: "Waiting for a person to read the new account." }, SYSTEM);
        return finishRun(ctx, run, { status: "done", result: "The case is waiting for a person to read the new account.", caseId: row._id });
      }
      case "pre_service": {
        if (!job) return finishRun(ctx, run, { status: "skipped", result: "The visit no longer exists." });
        const out = await preService(ctx, company, job);
        return finishRun(ctx, run, { status: "done", result: out.result, found: out.found, checked: ["Scope, checklist, property instructions, open concerns at the property"] });
      }
      case "upkeep": {
        const out = await upkeep(ctx, company, Date.now());
        // Visits in the coming day get their check before service, once each.
        if (state.ok) {
          const soon = await ctx.db.query("jobs").withIndex("by_company_status_start", (q) => q.eq("companyId", company._id).eq("status", "scheduled").gte("startsAt", Date.now()).lte("startsAt", Date.now() + DAY)).take(100);
          for (const visit of soon) if (!visit.recovery) await enqueueQualityRun(ctx, { companyId: company._id, kind: "pre_service", key: `pre:${visit._id}`, jobId: visit._id });
        }
        return finishRun(ctx, run, { status: "done", ...out });
      }
      case "interpret": {
        // The AI reading runs as begin (here) → read (an action) → apply. Nothing is read twice for unchanged evidence.
        await ctx.db.patch(run._id, { status: "queued", leaseUntil: undefined });
        await ctx.scheduler.runAfter(0, internal.qualityWork.interpret, { runId: run._id });
        return null;
      }
      default:
        // Communications runs are carried out in convex/qualityComms.ts.
        if (run.kind === "message_received" || run.kind === "transcript_available" || run.kind === "comms_sync") {
          await ctx.scheduler.runAfter(0, internal.qualityComms.processRun, { runId: run._id });
          await ctx.db.patch(run._id, { status: "queued", leaseUntil: undefined });
          return null;
        }
        return finishRun(ctx, run, { status: "skipped", result: "Not a run this worker carries out." });
    }
  },
});

/** Every ten minutes: each company's upkeep once per window; retries with backoff; leases that ran out; blocked work that can go now. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const window = Math.floor(now / (10 * MINUTE));
    let queued = 0;
    const companies = await ctx.db.query("companies").take(500);
    for (const company of companies) {
      if (company.suspendedAt || company.closingAt || company.deletedAt) continue;
      if ((await enqueueQualityRun(ctx, { companyId: company._id, kind: "upkeep", key: `upkeep:${window}` })).created) queued += 1;
    }
    let retried = 0;
    let failed = 0;
    let resumed = 0;
    // A run that threw stays queued: its own attempt count rolled back, so the attempt is counted here.
    const waiting = await ctx.db
      .query("qualityRuns")
      .withIndex("by_status_next", (q) => q.eq("status", "queued").lt("nextAttemptAt", now - 2 * MINUTE))
      .take(200);
    for (const row of waiting) {
      if (row.kind === "upkeep" && row.key !== `upkeep:${window}`) {
        await finishRun(ctx, row, { status: "skipped", result: "Superseded by a later upkeep." });
        continue;
      }
      const attempts = row.attempts + 1;
      const next = nextAttemptAfter(attempts, now);
      if (next === null) {
        await ctx.db.patch(row._id, { status: "failed", attempts, error: "It could not be finished after several tries.", finishedAt: now });
        failed += 1;
        const key = `quality.run_failed:${row._id}`;
        if (!(await liveTaskByKey(ctx, row.companyId, key))) {
          const taskId = await openTask(ctx, { companyId: row.companyId, agent: "quality", title: "Quality could not finish some work", nextAction: "Open Quality and check the visit or case this was about.", dueAt: now + DAY, completionCondition: "A person checked what the work was about and followed it up.", key, about: row.jobId ? { table: "jobs", id: row.jobId } : undefined, actor: SYSTEM });
          await setTaskState(ctx, (await ctx.db.get(taskId))!, "needs_decision", { openQuestion: `Quality tried ${MAX_ATTEMPTS} times to ${row.kind.replace(/_/g, " ")} and could not. Check it by hand.`, dueAt: now + DAY, withPersonSince: now }, SYSTEM);
        }
        continue;
      }
      await ctx.db.patch(row._id, { attempts, nextAttemptAt: next });
      await ctx.scheduler.runAt(next, internal.qualityWork.run, { runId: row._id });
      retried += 1;
    }
    // A worker that took a run and never finished it (an action that died): the run goes back to the queue.
    const running = await ctx.db.query("qualityRuns").withIndex("by_status_next", (q) => q.eq("status", "running")).take(200);
    for (const row of running) {
      if (row.leaseUntil !== undefined && row.leaseUntil > now) continue;
      await ctx.db.patch(row._id, { status: "queued", leaseUntil: undefined, nextAttemptAt: now });
      await ctx.scheduler.runAfter(0, internal.qualityWork.run, { runId: row._id });
      retried += 1;
    }
    // Blocked work goes again once the reason has cleared.
    const blocked = await ctx.db.query("qualityRuns").withIndex("by_status_next", (q) => q.eq("status", "blocked")).take(200);
    for (const row of blocked) {
      const company = await ctx.db.get(row.companyId);
      if (!company || !agentState(company).ok) continue;
      await ctx.db.patch(row._id, { status: "queued", blockedReason: undefined, nextAttemptAt: now });
      await ctx.scheduler.runAfter(0, internal.qualityWork.run, { runId: row._id });
      resumed += 1;
    }
    return { queued, retried, failed, resumed };
  },
});

// ── The optional AI reading of a case's evidence ─────────────────────────────────────────────────

export const interpretBegin = internalMutation({
  args: { runId: v.id("qualityRuns") },
  handler: async (ctx, args) => {
    const run = await leaseRun(ctx, args.runId);
    if (!run || !run.caseId) return null;
    const company = await ctx.db.get(run.companyId);
    const row = await ctx.db.get(run.caseId);
    const job = row?.jobId ? await ctx.db.get(row.jobId) : null;
    if (!company || !row || !job || row.stage === "closed" || row.serious || row.heldBy) {
      await finishRun(ctx, run, { status: "skipped", result: "There was nothing for a reader to add." });
      return null;
    }
    const state = agentState(company);
    if (!state.ok) {
      await finishRun(ctx, run, { status: "blocked", result: "Waiting: Quality's agent work is not running.", blockedReason: state.reason });
      return null;
    }
    const assembled = await assembleEvidence(ctx, company, job, { kind: "agent" });
    // One reading per case and evidence state is one billable unit. Without a hold, the rules' findings stand.
    const opened = await openExecution(ctx, { company, key: `quality-read:${row._id}:${assembled.stamp}`, agent: "quality", task: "quality_review", units: 1, autonomous: true, origin: "automatic", source: { table: "qualityCases", id: row._id }, link: { label: "Quality", path: `/app/agents/quality/cases?case=${row._id}` } });
    if (!opened.ok || opened.repeated) {
      await addEntry(ctx, row, { kind: "agent", text: `Read by the company's rules, not by AI: ${opened.ok ? "this evidence was already read." : opened.message}`, actor: SYSTEM });
      await finishRun(ctx, run, { status: "skipped", result: opened.ok ? "Already read." : opened.message, checked: ["Whether an AI reading can be priced and paid for"], found: [opened.ok ? "Already read" : opened.message] });
      return null;
    }
    await ctx.db.patch(run._id, { executionId: opened.executionId });
    const { lines } = citable(assembled.sections);
    return { executionId: opened.executionId, input: { evidence: lines, report: row.reportWords ?? null } };
  },
});

export const interpretApply = internalMutation({
  args: { runId: v.id("qualityRuns"), output: v.union(v.null(), v.object({ findings: v.any(), summary: v.string() })), reader: v.string(), read: v.boolean(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "running") return null;
    // Charged once, only when the reader actually read. Anything else releases the hold.
    if (run.executionId) await finishExecution(ctx, run.executionId, args.read ? { completedUnits: 1 } : { ended: "failed" });
    const row = run.caseId ? await ctx.db.get(run.caseId) : null;
    const company = await ctx.db.get(run.companyId);
    const job = row?.jobId ? await ctx.db.get(row.jobId) : null;
    if (!row || !company || !job || row.stage === "closed") return finishRun(ctx, run, { status: "skipped", result: "The case closed first." });
    if (!args.read || !args.output) {
      await addEntry(ctx, row, { kind: "agent", text: `Read by the company's rules, not by AI${args.note ? `: ${args.note}` : "."}`, actor: SYSTEM });
      return finishRun(ctx, run, { status: "done", result: args.note ?? "The rules' findings stand." });
    }
    // Only findings that cite evidence that really exists, and blame nobody, are kept, as suggestions.
    const assembled = await assembleEvidence(ctx, company, job, { kind: "agent" });
    const { known } = citable(assembled.sections);
    const checked = checkedReaderFindings(args.output.findings, known);
    const added = await recordSuggestions(ctx, row, checked.kept, args.reader);
    if (args.output.summary) await addEntry(ctx, row, { kind: "agent", basis: "analysis", text: `An AI reader's summary (a suggestion, not a finding): ${args.output.summary.slice(0, 700)}`, actor: QUALITY });
    if (checked.dropped.length) await addEntry(ctx, row, { kind: "agent", text: `${checked.dropped.length} of the reader's suggestions were not kept: ${[...new Set(checked.dropped.map((d) => d.reason))].join("; ")}.`, actor: SYSTEM });
    return finishRun(ctx, run, { status: "done", result: `${added} suggested ${added === 1 ? "finding" : "findings"} added for a person to review.`, checked: ["The visit's evidence, each line by its id"], found: checked.kept.map((k) => k.statement).slice(0, 4), next: added ? ["A person reviews the suggested findings."] : [] });
  },
});

export const interpret = internalAction({
  args: { runId: v.id("qualityRuns") },
  handler: async (ctx, args) => {
    const started = await ctx.runMutation(internal.qualityWork.interpretBegin, { runId: args.runId });
    if (!started) return null;
    const reader = qualityReader();
    const held = reader ? await reserveExecution(ctx, started.executionId) : null;
    if (!reader || !held?.ok) {
      await ctx.runMutation(internal.qualityWork.interpretApply, { runId: args.runId, output: null, reader: "rules", read: false, note: !reader ? "no AI reader is connected" : held && !held.ok ? held.message : undefined });
      return null;
    }
    let output: { findings: unknown; summary: string } | null = null;
    try {
      output = await reader.read(started.input);
    } catch {
      output = null;
    }
    await ctx.runMutation(internal.qualityWork.interpretApply, { runId: args.runId, output, reader: reader.name, read: output !== null, note: output === null ? "the AI reader did not answer" : undefined });
    return null;
  },
});
