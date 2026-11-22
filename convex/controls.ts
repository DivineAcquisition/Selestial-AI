/**
 * Agent Controls, the supervision workspace (docs/foundation/07-agent-controls.md).
 *
 *  - workspace      the company overview and one summary per agent, from real records only
 *  - scenarioRecords the real records a test can be run against
 *  - simulate       "Test these rules": what would happen, decided by the same checks live work uses
 *  - actionHistory  one action's settings, who changed them, and what the agent did under them
 *
 * Everything here is a query. Convex queries cannot write, so a test cannot send a message, make an
 * assignment, move money, change a record or queue work: that is enforced by the platform, not by care.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { companyQuery, managerQuery } from "./lib/builders";
import { notFound } from "./lib/errors";
import { authorityFor, type Authority } from "./lib/authority";
import { AGENT_PLAYBOOK, capabilityOf } from "./lib/controls/capabilities";
import { LEVEL_WORDS, policyOf, revisionOf } from "./lib/controls/policy";
import { approversFor, effective, factsFor, reportRecipients, type Effective, type Facts } from "./lib/controls/readiness";
import { ruleFor } from "./lib/controls/rules";
import type { PermissionSnapshot, PolicySnapshot } from "./lib/controls/schema";
import { candidatesFor, coverAction } from "./lib/dispatch/workflow";
import { money } from "./lib/dispatch/pay";
import { ACTIONS, actionDef, rank } from "./lib/permissionCatalog";
import { COLLECT } from "./lib/recruiter/screening";
import { correctionCost } from "./lib/retention/actions";
import { permitFor } from "./lib/retention/cases";
import { gatherEvidence } from "./lib/retention/evidence";
import { targetedMinutes } from "./lib/retention/recovery";
import { salesSettings } from "./lib/sales/settings";
import { AGENTS, type Agent } from "./lib/statuses";
import { presetOf } from "./permissions";

const DAY = 24 * 60 * 60 * 1000;

/** What each agent is responsible for, in one line. */
const RESPONSIBILITY: Record<Agent, string> = {
  dispatch: "Keeps every scheduled visit covered: offers, confirmations, reminders and replacements.",
  sales: "Answers new leads, quotes from your published prices, follows up and books.",
  recruiter: "Answers applicants, collects what's missing, invites and schedules interviews.",
  retention: "Handles concerns after a visit, offers remedies inside your limits and asks for feedback.",
};

const snapshot = (policy: PolicySnapshot, key: string): PermissionSnapshot => policy.permissions.find((row) => row.action === key)!;

// ── Overview and agent summaries ─────────────────────────────────────────────────────────────────

export const workspace = companyQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const company = ctx.company;
    const policy = await policyOf(ctx, company);
    const facts = await factsFor(ctx, company, now);
    const members = await ctx.db
      .query("members")
      .withIndex("by_company", (q) => q.eq("companyId", company._id))
      .collect();
    const pending = await ctx.db
      .query("approvals")
      .withIndex("by_company_status_decideBy", (q) => q.eq("companyId", company._id).eq("status", "pending"))
      .collect();

    const statuses = new Map<string, Effective>();
    for (const def of ACTIONS) statuses.set(def.key, await effective(ctx, def, snapshot(policy, def.key), facts));

    const agents = [];
    for (const agent of AGENTS) {
      const defs = ACTIONS.filter((def) => def.agent === agent);
      const levels = { off: 0, propose: 0, execute_and_report: 0, execute: 0 };
      let unavailable = 0;
      let setup = 0;
      let limited = 0;
      for (const def of defs) {
        const status = statuses.get(def.key)!;
        if (!capabilityOf(def.key).implemented) {
          unavailable++;
          continue;
        }
        levels[snapshot(policy, def.key).level]++;
        if (status.status === "setup_required") setup++;
        if (status.status === "limit_reached") limited++;
      }
      const open = async (status: Doc<"tasks">["status"]) =>
        (
          await ctx.db
            .query("tasks")
            .withIndex("by_company_agent_status", (q) => q.eq("companyId", company._id).eq("agent", agent).eq("status", status))
            .take(500)
        ).length;
      const lastDone = await ctx.db
        .query("tasks")
        .withIndex("by_company_agent_status", (q) => q.eq("companyId", company._id).eq("agent", agent).eq("status", "done"))
        .order("desc")
        .first();
      const nextOpen = await ctx.db
        .query("tasks")
        .withIndex("by_company_agent_status", (q) => q.eq("companyId", company._id).eq("agent", agent).eq("status", "open"))
        .take(200);
      const soonest = nextOpen.sort((a, b) => a.dueAt - b.dueAt)[0];
      agents.push({
        agent,
        responsibility: RESPONSIBILITY[agent],
        playbook: AGENT_PLAYBOOK[agent],
        paused: company.pausedAgents.includes(agent),
        plan: facts.plan[agent],
        levels,
        unavailable,
        setupRequired: setup,
        limitReached: limited,
        work: { open: await open("open"), waiting: await open("waiting"), withPerson: await open("needs_decision") },
        awaitingApproval: pending.filter((row) => row.agent === agent).length,
        lastResult: lastDone ? { title: lastDone.title, outcome: lastDone.outcome ?? null, at: lastDone.closedAt ?? lastDone._creationTime } : null,
        next: soonest ? { title: soonest.nextAction ?? soonest.title, dueAt: soonest.dueAt } : null,
      });
    }

    const rules: Record<string, { words: string; href: string }> = {};
    for (const def of ACTIONS) {
      const rule = ruleFor(def.key, company);
      if (rule) rules[def.key] = rule;
    }

    const all = [...statuses.values()];
    return {
      revision: revisionOf(company),
      canEdit: ctx.role === "owner" && !ctx.support,
      role: ctx.role,
      timezone: company.timezone,
      suspended: company.suspendedAt !== undefined,
      preset: presetOf(policy, now),
      overview: {
        working: AGENTS.filter((agent) => !company.pausedAgents.includes(agent)).length,
        paused: company.pausedAgents.length,
        setupRequired: all.filter((s) => s.status === "setup_required").length,
        limitReached: all.filter((s) => s.status === "limit_reached").length,
        awaitingApproval: pending.length,
        overdueApproval: pending.filter((row) => row.decideBy < now).length,
      },
      agents,
      rules,
      reports: await reportRecipients(ctx, company, members),
      setup: { sms: facts.sms, email: facts.email, links: facts.links, pricing: facts.pricing },
    };
  },
});

// ── Test these rules ─────────────────────────────────────────────────────────────────────────────

const scenarioValidator = v.union(v.literal("cleaner_declines"), v.literal("quote_unanswered"), v.literal("applicant_missing_info"), v.literal("correction_visit"));
type Scenario = typeof scenarioValidator.type;

const SCENARIO_WORDS: Record<Scenario, string> = {
  cleaner_declines: "A cleaner declines tomorrow's visit",
  quote_unanswered: "A lead hasn't answered a quote",
  applicant_missing_info: "An applicant is missing information",
  correction_visit: "A customer asks for a correction visit",
};

const shortWhen = (at: number, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);

/** The real records each scenario can run against. Nothing is changed by listing them. */
export const scenarioRecords = managerQuery({
  args: { scenario: scenarioValidator },
  handler: async (ctx, args) => {
    const company = ctx.company;
    const tz = company.timezone;
    const now = Date.now();
    const out: { id: string; label: string }[] = [];
    if (args.scenario === "cleaner_declines") {
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_company_start", (q) => q.eq("companyId", company._id).gte("startsAt", now).lt("startsAt", now + 3 * DAY))
        .take(200);
      for (const job of jobs) {
        if (job.status !== "scheduled") continue;
        const assignments = await ctx.db
          .query("assignments")
          .withIndex("by_company_job", (q) => q.eq("companyId", company._id).eq("jobId", job._id))
          .take(20);
        const accepted = assignments.find((a) => a.status === "accepted");
        if (!accepted) continue;
        const cleaner = await ctx.db.get(accepted.cleanerId);
        const customer = await ctx.db.get(job.customerId);
        out.push({ id: job._id, label: `${shortWhen(job.startsAt, tz)}: ${customer?.name ?? "Customer"}, ${cleaner?.name ?? "a cleaner"} accepted` });
        if (out.length >= 15) break;
      }
    } else if (args.scenario === "quote_unanswered") {
      const rows = await ctx.db
        .query("salesOpportunities")
        .withIndex("by_company_stage", (q) => q.eq("companyId", company._id).eq("stage", "quoting"))
        .order("desc")
        .take(15);
      for (const row of rows) out.push({ id: row._id, label: `${row.title}${row.followUps !== "on" ? ` (follow-ups ${row.followUps})` : ""}` });
    } else if (args.scenario === "applicant_missing_info") {
      for (const stage of ["screening", "application_submitted", "application_started"] as const) {
        const rows = await ctx.db
          .query("applications")
          .withIndex("by_company_stage", (q) => q.eq("companyId", company._id).eq("stage", stage))
          .take(10);
        for (const row of rows) {
          if (row.redactedAt !== undefined) continue;
          const applicant = await ctx.db.get(row.applicantId);
          out.push({ id: row._id, label: `${applicant?.name ?? "Applicant"} (${stage.replace(/_/g, " ")})` });
        }
      }
    } else {
      for (const status of ["needs_attention", "needs_context", "action_underway", "waiting_on_customer"] as const) {
        const rows = await ctx.db
          .query("retentionCases")
          .withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", status))
          .take(10);
        for (const row of rows) if (row.jobId) out.push({ id: row._id, label: row.title });
      }
    }
    return { scenario: args.scenario, words: SCENARIO_WORDS[args.scenario], records: out.slice(0, 15) };
  },
});

type Decision = "act" | "act_and_notify" | "ask" | "refuse";

type Step = {
  action: string;
  label: string;
  setting: string;
  decision: Decision;
  decisionWords: string;
  rule: { words: string; href: string } | null;
  approvers: string | null;
  missing: { words: string; next: { label: string; href: string } | null }[];
  status: { status: string; words: string; reason: string };
};

/**
 * One action's decision as live execution would reach it: authorityFor (the check every agent tool makes
 * before it runs) for the level, pause, expiry and availability, then the same readiness checks the send
 * path applies. Nothing here can decide differently from execution, because it calls the same code.
 */
async function decide(ctx: QueryCtx, company: Doc<"companies">, policy: PolicySnapshot, facts: Facts, action: string, authority?: Authority, permitWords?: string): Promise<Step> {
  const def = actionDef(action)!;
  const snap = snapshot(policy, action);
  const auth = authority ?? (await authorityFor(ctx, company._id, action, facts.now));
  const status = await effective(ctx, def, snap, facts);
  const missing = status.checks.filter((check) => !check.ok).map((check) => ({ words: check.words, next: check.next ?? null }));
  let decision: Decision;
  let words: string;
  if (auth.kind === "paused") [decision, words] = ["refuse", `${def.agent.charAt(0).toUpperCase()}${def.agent.slice(1)} is paused, so it would do nothing. A person can still act.`];
  else if (auth.kind === "unavailable") [decision, words] = ["refuse", auth.why];
  else if (auth.kind !== "level") [decision, words] = ["refuse", "Only a person does this."];
  else if (auth.level === "off") [decision, words] = ["refuse", `"${def.label}" is switched off, so the agent leaves it to your team.`];
  else if (company.suspendedAt !== undefined) [decision, words] = ["refuse", "Selestial has suspended outbound activity for this company, so nothing would be sent."];
  else if (missing.length) [decision, words] = ["refuse", `It would stop here: ${missing.map((m) => m.words).join(" ")}`];
  else if (permitWords) [decision, words] = ["ask", permitWords];
  else if (auth.level === "propose") [decision, words] = ["ask", auth.expired ? "The temporary level ended, so it would prepare this and ask first." : "It would prepare this and ask first."];
  else if (auth.level === "execute_and_report") [decision, words] = ["act_and_notify", "It would do this without asking and email a report."];
  else [decision, words] = ["act", "It would do this without asking."];
  return {
    action,
    label: def.label,
    setting: LEVEL_WORDS[snap.level],
    decision,
    decisionWords: words,
    rule: ruleFor(action, company),
    approvers: decision === "ask" ? (await approversFor(ctx, company, snap)).words : null,
    missing,
    status: { status: status.status, words: status.words, reason: status.reason },
  };
}

/**
 * "Test these rules". Runs one scenario against a real record or a labeled sample, with the policy as it
 * stands. Every result is hypothetical: nothing is sent, assigned, charged, changed or queued.
 */
export const simulate = managerQuery({
  args: { scenario: scenarioValidator, recordId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const company = ctx.company;
    const tz = company.timezone;
    const now = Date.now();
    const policy = await policyOf(ctx, company);
    const facts = await factsFor(ctx, company, now);
    const steps: Step[] = [];
    let record: { label: string; href: string } | null = null;
    let story: string[] = [];
    let cost: { cents: number | null; words: string } | null = null;
    const sample = args.recordId === undefined;

    if (args.scenario === "cleaner_declines") {
      let action = coverAction([]);
      if (!sample) {
        const job = await ctx.db.get(args.recordId as Id<"jobs">);
        if (!job || job.companyId !== company._id) notFound();
        const customer = await ctx.db.get(job.customerId);
        record = { label: `${customer?.name ?? "Visit"}, ${shortWhen(job.startsAt, tz)}`, href: `/app/schedule?open=job:${job._id}` };
        const ranked = await candidatesFor(ctx, company, job);
        const leaving = ranked.assignments.find((a) => a.status === "accepted");
        // The cleaner who accepted withdraws: the assignment ends as released after a reply, which is what
        // coverAction reads to choose between reassigning a confirmed visit and a first offer.
        const after = ranked.assignments.map((a) => (a._id === leaving?._id ? { ...a, status: "cancelled" as const, endCause: "released" as const, respondedAt: a.respondedAt ?? now } : a));
        action = coverAction(after);
        const leavingName = leaving ? ((await ctx.db.get(leaving.cleanerId))?.name ?? "The cleaner") : "The cleaner";
        const candidates = ranked.candidates.filter((c) => c.cleanerId !== leaving?.cleanerId);
        story = [
          `${leavingName} says they can't do it.`,
          candidates.length ? `${candidates.length} other ${candidates.length === 1 ? "cleaner fits" : "cleaners fit"} by your rules; first in line: ${candidates[0].name} (${candidates[0].reasons.slice(0, 2).join(", ") || "eligible"}).` : "No other cleaner fits by your rules right now, so a person would need to find cover.",
          ...(ranked.excluded.length ? [`${ranked.excluded.length} passed over, for example ${ranked.excluded[0].name}: ${ranked.excluded[0].reason}.`] : []),
        ];
        const pay = candidates[0]?.pay;
        cost = pay ? (pay.ok ? { cents: pay.payCents, words: `${money(pay.payCents)} crew pay for ${candidates[0].name}: ${pay.basis}` } : { cents: null, words: pay.reason }) : null;
      } else {
        story = ["Sample: a cleaner who accepted a visit tomorrow writes that they can't do it.", "With a real visit, the cleaners who fit and the pay are worked out from your records."];
      }
      steps.push(await decide(ctx, company, policy, facts, action));
    } else if (args.scenario === "quote_unanswered") {
      const s = salesSettings(company).followUp;
      if (!sample) {
        const opp = await ctx.db.get(args.recordId as Id<"salesOpportunities">);
        if (!opp || opp.companyId !== company._id) notFound();
        record = { label: opp.title, href: `/app/agents/sales?open=opportunity:${opp._id}` };
        const planned = (
          await ctx.db
            .query("salesFollowUps")
            .withIndex("by_company_opportunity", (q) => q.eq("companyId", company._id).eq("opportunityId", opp._id))
            .take(50)
        ).filter((row) => row.status === "scheduled");
        story = [
          opp.followUps !== "on" ? `Follow-ups for this lead are ${opp.followUps}, so nothing would be sent whatever the setting.` : planned.length ? `The next reminder is planned for ${shortWhen(planned[0].dueAt, tz)} (attempt ${planned[0].attempt + 1} of ${planned[0].maxAttempts}). It is checked again when it is due: a reply or a person taking over stops it.` : "No reminder is planned for this lead now.",
        ];
        if (opp.followUps !== "on") steps.push({ ...(await decide(ctx, company, policy, facts, "sales.follow_up")), decision: "refuse", decisionWords: `Follow-ups are ${opp.followUps} for this lead.` });
      } else {
        story = [`Sample: a customer got a quote and hasn't answered. Your sequence reminds after ${s.quoteHours.map((h) => `${h} h`).join(", then ") || "never"}.`];
      }
      if (!steps.length) steps.push(await decide(ctx, company, policy, facts, "sales.follow_up"));
      cost = { cents: null, words: "No direct cost beyond your messaging usage." };
    } else if (args.scenario === "applicant_missing_info") {
      if (!sample) {
        const application = await ctx.db.get(args.recordId as Id<"applications">);
        if (!application || application.companyId !== company._id) notFound();
        const applicant = await ctx.db.get(application.applicantId);
        record = { label: applicant?.name ?? "Applicant", href: `/app/agents/recruiter?open=application:${application._id}` };
        const screening = await ctx.db
          .query("screenings")
          .withIndex("by_company_application", (q) => q.eq("companyId", company._id).eq("applicationId", application._id))
          .order("desc")
          .first();
        story = [
          screening ? (screening.missing.length ? `Still missing: ${screening.missing.slice(0, 4).join(", ")}.` : "The latest screening found nothing missing.") : "This application hasn't been screened yet.",
          application.contact.address ? "The question would go by email to the address on the application." : "There's no address to write to, so a person would need to reach them.",
        ];
        if (!application.contact.address) steps.push({ ...(await decide(ctx, company, policy, facts, COLLECT)), decision: "refuse", decisionWords: "No email address on the application." });
      } else {
        story = ["Sample: an applicant left out their availability and whether they have transport."];
      }
      if (!steps.length) steps.push(await decide(ctx, company, policy, facts, COLLECT));
      cost = { cents: null, words: "No direct cost." };
    } else {
      const action = "retention.remedy_within_limit";
      let estimate: { estimateCents: number | null; basis: string } = { estimateCents: null, basis: "Sample: with a real case, the cost is worked out from the original visit's crew pay." };
      if (!sample) {
        const row = await ctx.db.get(args.recordId as Id<"retentionCases">);
        if (!row || row.companyId !== company._id) notFound();
        record = { label: row.title, href: `/app/agents/retention?open=case:${row._id}` };
        const evidence = await gatherEvidence(ctx, company, row);
        const minutes = targetedMinutes(evidence.job?.durationMinutes);
        estimate = correctionCost(evidence.job ? { crewPayCents: evidence.crew.reduce((sum, c) => sum + c.payCents, 0), durationMinutes: evidence.job.durationMinutes, priceCents: evidence.job.priceCents } : null, minutes);
        story = [
          `A targeted ${minutes}-minute correction of ${row.areas.join(", ") || "the reported work"}, at no charge to the customer.`,
          ...(row.serious ? ["This case is marked serious, so a person handles it whatever the setting."] : []),
          ...(evidence.guarantee.set ? [`Your guarantee: ${evidence.guarantee.within === false ? "this is outside its window" : evidence.guarantee.within ? "this is inside its window" : "its window can't be checked from the record"}.`] : []),
        ];
      } else {
        story = ["Sample: a customer writes that the kitchen wasn't finished and asks for someone to come back."];
      }
      cost = { cents: estimate.estimateCents, words: estimate.basis };
      // The money check is permitFor, the one execution uses; a query can't reserve, so it only looks.
      const permit = await permitFor(ctx, company._id, action, { cents: estimate.estimateCents });
      const step = await decide(ctx, company, policy, facts, action, undefined, permit.mode === "ask" ? permit.why : undefined);
      steps.push(step.decision !== "refuse" && permit.mode === "refuse" ? { ...step, decision: "refuse", decisionWords: permit.why } : step);
    }

    const first = steps[0];
    return {
      hypothetical: true as const,
      sample,
      scenario: args.scenario,
      words: SCENARIO_WORDS[args.scenario],
      record,
      story,
      steps,
      cost,
      next:
        first.decision === "refuse"
          ? first.missing[0]?.next ?? { label: "Review this action's setting", href: `/app/settings/agents?action=${first.action}` }
          : first.decision === "ask"
            ? { label: "Approvals are decided in the queue", href: "/app/approvals" }
            : null,
      revision: revisionOf(company),
      note: "Hypothetical. Nothing was sent, assigned, charged, changed or queued. When this happens for real, every check is made again at that moment.",
    };
  },
});

// ── One action's history ─────────────────────────────────────────────────────────────────────────

/**
 * Settings and what happened under them, for one action: the current setting and its last editor, every
 * change, recent reports of work done without asking, approvals in each state, and blocked attempts.
 * Counts are of records that exist; nothing is estimated.
 */
export const actionHistory = managerQuery({
  args: { action: v.string() },
  handler: async (ctx, args) => {
    const def = actionDef(args.action);
    if (!def) notFound();
    const company = ctx.company;
    const now = Date.now();
    const policy = await policyOf(ctx, company);
    const snap = snapshot(policy, def.key);
    const row = await ctx.db
      .query("permissions")
      .withIndex("by_company_action", (q) => q.eq("companyId", company._id).eq("action", def.key))
      .unique();
    const editor = row?.updatedBy ? await ctx.db.get(row.updatedBy) : null;
    const nameOf = async (id: Id<"members"> | undefined) => {
      if (!id) return "Selestial";
      const m = await ctx.db.get(id);
      return m ? (m.status === "support" ? "Selestial Support" : m.name) : "A former member";
    };

    const changes = [];
    for await (const change of ctx.db
      .query("controlChanges")
      .withIndex("by_company_revision", (q) => q.eq("companyId", company._id))
      .order("desc")) {
      if (!change.actions.includes(def.key)) continue;
      const before = change.before.permissions.find((p) => p.action === def.key);
      const after = change.after.permissions.find((p) => p.action === def.key);
      changes.push({ revision: change.revision, kind: change.kind, summary: change.summary, at: change.at, by: await nameOf(change.by), from: before ? LEVEL_WORDS[before.level] : null, to: after ? LEVEL_WORDS[after.level] : null });
      if (changes.length >= 50) break;
    }

    // Approvals for this action, newest first, read per status so one busy status can't hide another.
    const approvals: { id: Id<"approvals">; summary: string; state: string; at: number; detail: string | null; href: string }[] = [];
    for (const status of ["pending", "approved", "changed", "skipped", "expired"] as const) {
      const rows = await ctx.db
        .query("approvals")
        .withIndex("by_company_status_decideBy", (q) => q.eq("companyId", company._id).eq("status", status))
        .order("desc")
        .take(300);
      for (const a of rows) {
        if (a.action !== def.key) continue;
        const state =
          status === "pending"
            ? a.decideBy < now
              ? "Waiting, past its deadline"
              : "Waiting for a decision"
            : status === "expired"
              ? "Expired without a decision (not done)"
              : status === "skipped"
                ? "Declined"
                : a.carriedOut
                  ? a.carriedOut.ok
                    ? "Approved and carried out"
                    : "Approved, then blocked when it ran"
                  : "Approved, not yet carried out";
        approvals.push({ id: a._id, summary: a.summary, state, at: a.decidedAt ?? a.createdAt, detail: a.carriedOut?.detail ?? a.note ?? null, href: `/app/approvals?open=approval:${a._id}` });
      }
    }
    approvals.sort((a, b) => b.at - a.at);

    // Work done without asking, from the "Act and notify me" reports, and blocked or failed work recorded by
    // Retention. The event log is read for the last 30 days, newest first, up to 2,000 events.
    const reports: { at: number; stage: string; ok: boolean | null; kind: string | null; subject: string }[] = [];
    let scanned = 0;
    for await (const event of ctx.db
      .query("events")
      .withIndex("by_company_at", (q) => q.eq("companyId", company._id).gte("at", now - 30 * DAY))
      .order("desc")) {
      if (++scanned > 2000) break;
      if (event.type !== `${def.agent}.reported`) continue;
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (data.action !== def.key) continue;
      reports.push({ at: event.at, stage: typeof data.stage === "string" ? data.stage : "completed", ok: typeof data.ok === "boolean" ? data.ok : null, kind: typeof data.kind === "string" ? data.kind : null, subject: `${event.subject.table}:${event.subject.id}` });
      if (reports.length >= 50) break;
    }
    const blocked: { at: number; summary: string; status: string }[] = [];
    if (def.agent === "retention") {
      for (const status of ["blocked", "failed", "cancelled"] as const) {
        const rows = await ctx.db
          .query("retentionActions")
          .withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", status))
          .order("desc")
          .take(200);
        for (const r of rows) if (r.permission === def.key) blocked.push({ at: r._creationTime, summary: r.summary, status });
      }
      blocked.sort((a, b) => b.at - a.at);
    }

    return {
      action: def.key,
      label: def.label,
      agent: def.agent,
      setting: { level: snap.level, words: LEVEL_WORDS[snap.level], perActionCents: snap.perActionCents ?? null, perDayCents: snap.perDayCents ?? null, until: snap.until ?? null, changedBy: row ? (editor ? (editor.status === "support" ? "Selestial Support" : editor.name) : "A former member") : null, changedAt: row?.updatedAt ?? null, isDefault: !row },
      raised: rank(snap.level) > rank(def.standard),
      changes,
      approvals: approvals.slice(0, 50),
      reports,
      reportsScanned: { days: 30, events: Math.min(scanned, 2000), complete: scanned <= 2000 },
      blocked: blocked.slice(0, 30),
      counts: {
        waiting: approvals.filter((a) => a.state.startsWith("Waiting")).length,
        expired: approvals.filter((a) => a.state.startsWith("Expired")).length,
        approvedBlocked: approvals.filter((a) => a.state === "Approved, then blocked when it ran").length,
        carriedOut: approvals.filter((a) => a.state === "Approved and carried out").length,
        reported: reports.length,
      },
    };
  },
});
