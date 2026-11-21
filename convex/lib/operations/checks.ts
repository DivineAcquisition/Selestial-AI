/**
 * The monitor's checks. Each reads one workflow's own durable state through an index, bounded, and says
 * what needs tracking (docs/operations/01-recovery.md §Detection). No check calls a model or a provider.
 *
 * A check distinguishes waiting from broken: an agent waiting for an approval, a registration with the
 * carriers, a message held overnight for quiet hours are normal and never found here. Each threshold is
 * set past the point where the workflow's own recovery should already have acted, so what a check finds
 * is the recovery itself having run out or stopped.
 *
 * A check owns the kinds it lists. An open incident of one of those kinds that a complete scan no longer
 * finds is resolved, with the check's own words as evidence. A scan that hit its read limit resolves
 * nothing. A check may also verify one incident directly (for findings inside a time window, where
 * leaving the window is not the same as being fixed).
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { AGENT_PROFILES } from "../departments";
import { FEATURE_INFO, type Feature } from "../google/features";
import { WAITING_FOR_INBOX } from "../inbox/mailboxes";
import type { Category, IncidentAction, IncidentState, Related, Severity } from "./schema";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LIMIT = 500;

export type Finding = {
  key: string;
  kind: string;
  companyId?: Id<"companies">;
  groupKey?: string;
  category: Category;
  severity: Severity;
  state: IncidentState;
  title: string;
  impact: string;
  done: string;
  action?: IncidentAction;
  next: string;
  diagnostics?: string;
  related: Related[];
  ownerVisible: boolean;
  /** Records covered right now. */
  count: number;
  recoveryAttempts: number;
};

export type Verdict = "fixed" | "broken" | "unknown";

export type Check = {
  name: string;
  /** In words, for the staff monitor table. */
  about: string;
  everyMs: number;
  kinds: readonly string[];
  scan: (ctx: MutationCtx, now: number) => Promise<{ findings: Finding[]; complete: boolean }>;
  /** For an open incident the scan did not find: is the condition really gone? Absent: a complete scan decides. */
  verify?: (ctx: MutationCtx, incident: Doc<"incidents">, now: number) => Promise<Verdict>;
};

const agentName = (agent: string) => AGENT_PROFILES[agent as keyof typeof AGENT_PROFILES]?.name ?? "An agent";
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("{n}", String(n)));
const short = (text: string | undefined, max = 300) => (text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : undefined);

function byCompany<T extends { companyId: Id<"companies"> }>(rows: T[]): Map<Id<"companies">, T[]> {
  const out = new Map<Id<"companies">, T[]>();
  for (const row of rows) out.set(row.companyId, [...(out.get(row.companyId) ?? []), row]);
  return out;
}

// ── Agent work ────────────────────────────────────────────────────────────────────────────────────

const activation: Check = {
  name: "agent.activation",
  about: "First work that stopped reporting past its lease, or failed after its bounded retries.",
  everyMs: 5 * MINUTE,
  kinds: ["agent.activation_stalled", "agent.activation_failed"],
  async scan(ctx, now) {
    const findings: Finding[] = [];
    // activation.sweep retries a lapsed lease within about 5 minutes; 15 minutes past it, that recovery has not happened.
    const stalled = await ctx.db
      .query("activationTasks")
      .withIndex("by_state_lease", (q) => q.eq("state", "working").lt("leaseUntil", now - 15 * MINUTE))
      .take(LIMIT);
    for (const task of stalled) {
      if (task.leaseUntil === undefined) continue;
      findings.push({
        key: `agent.activation_stalled:${task._id}`,
        kind: "agent.activation_stalled",
        companyId: task.companyId,
        groupKey: "selestial:activation_sweep",
        category: "agent_work",
        severity: "medium",
        state: "needs_staff",
        title: `${agentName(task.agent)}'s first work is taking longer than expected`,
        impact: `"${task.title}" hasn't finished. Everything it has made so far is saved.`,
        done: `Selestial retries a step that stops reporting. This one hasn't come back after ${task.attempts} ${task.attempts === 1 ? "try" : "tries"}, so a person at Selestial is checking it.`,
        action: { kind: "review", label: "See your agents' work", href: `/app?activation=${task.activationId}` },
        next: "Staff: check the activation sweep ran; run it from the incident if it did not.",
        diagnostics: `lease ended ${Math.round((now - task.leaseUntil) / MINUTE)} min ago · attempts ${task.attempts}${task.lastError ? ` · ${short(task.lastError, 200)}` : ""}`,
        related: [{ table: "activationTasks", id: task._id, label: task.title }],
        ownerVisible: true,
        count: 1,
        recoveryAttempts: task.attempts,
      });
    }
    const failed = await ctx.db
      .query("activationTasks")
      .withIndex("by_state_lease", (q) => q.eq("state", "failed"))
      .take(LIMIT);
    for (const task of failed) {
      if ((task.finishedAt ?? task.updatedAt) < now - 3 * DAY) continue;
      const blocker = task.blocker;
      const action: IncidentAction = blocker
        ? { kind: blocker.kind === "connection" ? "reconnect" : blocker.kind === "credits" ? "add_funds" : blocker.kind === "information" ? "update_information" : "review", label: blocker.action.label, href: blocker.action.href }
        : { kind: "contact_support", label: "Contact support" };
      findings.push({
        key: `agent.activation_failed:${task._id}`,
        kind: "agent.activation_failed",
        companyId: task.companyId,
        category: "agent_work",
        severity: "low",
        state: blocker ? "waiting_owner" : "needs_staff",
        title: `${agentName(task.agent)} couldn't finish "${task.title}"`,
        impact: blocker ? blocker.words : "This piece of first work stopped. The rest of the batch carried on.",
        done: `Selestial tried ${task.attempts} ${task.attempts === 1 ? "time" : "times"} and kept everything it made.`,
        action,
        next: blocker ? "Owner: the card names the one thing to do." : "Staff: read the task's last error; it failed without a blocker.",
        diagnostics: short(task.lastError),
        related: [{ table: "activationTasks", id: task._id, label: task.title }],
        ownerVisible: true,
        count: 1,
        recoveryAttempts: task.attempts,
      });
    }
    return { findings, complete: stalled.length < LIMIT && failed.length < LIMIT };
  },
  async verify(ctx, incident) {
    const id = incident.related[0]?.id ? ctx.db.normalizeId("activationTasks", incident.related[0].id) : null;
    const task = id ? await ctx.db.get(id) : null;
    if (!task) return "fixed";
    if (incident.kind === "agent.activation_failed") return task.state === "failed" ? "broken" : "fixed";
    return task.state === "working" && (task.leaseUntil ?? 0) < Date.now() - 15 * MINUTE ? "broken" : "fixed";
  },
};

const salesRuns: Check = {
  name: "agent.sales",
  about: "Sales runs that failed after three tries with no successful run since, and runs stuck past the Sales sweep.",
  everyMs: 5 * MINUTE,
  kinds: ["agent.sales_failed", "agent.sales_stuck"],
  async scan(ctx, now) {
    const findings: Finding[] = [];
    const failed = await ctx.db
      .query("salesRuns")
      .withIndex("by_status_started", (q) => q.eq("status", "failed").gte("startedAt", now - DAY))
      .take(LIMIT);
    for (const [companyId, rows] of byCompany(failed)) {
      const latest = Math.max(...rows.map((r) => r.finishedAt ?? r.startedAt ?? r.createdAt));
      const done = await ctx.db
        .query("salesRuns")
        .withIndex("by_company_status", (q) => q.eq("companyId", companyId).eq("status", "done"))
        .order("desc")
        .first();
      if (done && (done.finishedAt ?? done.createdAt) > latest) continue;
      const opportunities = new Set(rows.map((r) => r.opportunityId));
      findings.push({
        key: `agent.sales_failed:${companyId}`,
        kind: "agent.sales_failed",
        companyId,
        groupKey: "agent:sales_failed",
        category: "agent_work",
        severity: "medium",
        state: "waiting_owner",
        title: "Sales couldn't finish some of its work",
        impact: `${plural(opportunities.size, "One conversation is", "{n} conversations are")} waiting for a person. The conversations and any drafts are saved.`,
        done: "Selestial tried each one three times, then stopped so nothing is sent twice.",
        action: { kind: "review", label: "Review in Sales", href: "/app/agents/sales" },
        next: "Owner: reply to the waiting conversations. Staff: if this repeats across companies, check the AI provider.",
        diagnostics: `${rows.length} failed runs in 24 h · last: ${short(rows.at(-1)?.result, 200) ?? "no result recorded"}`,
        related: rows.slice(0, 20).map((r) => ({ table: "salesRuns", id: r._id, label: `Run for ${r.trigger}` })),
        ownerVisible: true,
        count: opportunities.size,
        recoveryAttempts: rows.reduce((sum, r) => sum + r.attempt, 0),
      });
    }
    // salesAgent.sweep closes a run running for 5 minutes; one running for 20 means the sweep itself stopped.
    const stuck = await ctx.db
      .query("salesRuns")
      .withIndex("by_status_started", (q) => q.eq("status", "running").lt("startedAt", now - 20 * MINUTE))
      .take(LIMIT);
    for (const [companyId, rows] of byCompany(stuck)) {
      findings.push({
        key: `agent.sales_stuck:${companyId}`,
        kind: "agent.sales_stuck",
        companyId,
        groupKey: "selestial:sales_sweep",
        category: "agent_work",
        severity: "high",
        state: "needs_staff",
        title: "Sales replies are delayed",
        impact: `${plural(rows.length, "A customer conversation is", "{n} customer conversations are")} waiting on Sales longer than usual.`,
        done: "Nothing was sent twice. A person at Selestial is restarting the work.",
        next: "Staff: run the Sales sweep from the incident; check the scheduler if it does not clear.",
        diagnostics: `${rows.length} runs running > 20 min`,
        related: rows.slice(0, 20).map((r) => ({ table: "salesRuns", id: r._id, label: "Sales run" })),
        ownerVisible: true,
        count: rows.length,
        recoveryAttempts: 0,
      });
    }
    return { findings, complete: failed.length < LIMIT && stuck.length < LIMIT };
  },
  async verify(ctx, incident) {
    if (!incident.companyId || incident.kind !== "agent.sales_failed") return "unknown";
    const done = await ctx.db
      .query("salesRuns")
      .withIndex("by_company_status", (q) => q.eq("companyId", incident.companyId!).eq("status", "done"))
      .order("desc")
      .first();
    return done && (done.finishedAt ?? done.createdAt) > incident.lastSeenAt ? "fixed" : "broken";
  },
};

const retentionRuns: Check = {
  name: "agent.retention",
  about: "Retention work that failed after three tries, and queued work the Retention sweep has not picked up.",
  everyMs: 10 * MINUTE,
  kinds: ["agent.retention_failed", "agent.retention_stuck"],
  async scan(ctx, now) {
    const findings: Finding[] = [];
    const failed = await ctx.db
      .query("retentionRuns")
      .withIndex("by_status_queued", (q) => q.eq("status", "failed").gte("queuedAt", now - 3 * DAY))
      .take(LIMIT);
    for (const [companyId, rows] of byCompany(failed)) {
      findings.push({
        key: `agent.retention_failed:${companyId}`,
        kind: "agent.retention_failed",
        companyId,
        category: "agent_work",
        severity: "low",
        state: "waiting_owner",
        title: "Retention needs a person for some follow-through",
        impact: `${plural(rows.length, "One customer follow-up", "{n} customer follow-ups")} didn't finish. Each is waiting as a task for your team.`,
        done: "Selestial tried each one three times and opened a task so a person can finish it.",
        action: { kind: "review", label: "Open Needs attention", href: "/app/agents/retention/needs-attention" },
        next: "Owner: work the tasks. Staff: only if the same kind fails across companies.",
        diagnostics: `${rows.length} failed runs in 72 h · kinds: ${[...new Set(rows.map((r) => r.kind))].join(", ")}`,
        related: rows.slice(0, 20).map((r) => ({ table: "retentionRuns", id: r._id, label: r.kind.replace(/_/g, " ") })),
        ownerVisible: true,
        count: rows.length,
        recoveryAttempts: rows.reduce((sum, r) => sum + r.attempts, 0),
      });
    }
    // The Retention sweep re-runs queued work older than 2 minutes every 10; an hour means it stopped.
    const stuck = await ctx.db
      .query("retentionRuns")
      .withIndex("by_status_queued", (q) => q.eq("status", "queued").lt("queuedAt", now - HOUR))
      .take(LIMIT);
    for (const [companyId, rows] of byCompany(stuck)) {
      findings.push({
        key: `agent.retention_stuck:${companyId}`,
        kind: "agent.retention_stuck",
        companyId,
        groupKey: "selestial:retention_sweep",
        category: "agent_work",
        severity: "medium",
        state: "needs_staff",
        title: "Retention follow-through is delayed",
        impact: `${plural(rows.length, "One piece of customer follow-through is", "{n} pieces of customer follow-through are")} waiting longer than usual.`,
        done: "Nothing was lost. A person at Selestial is restarting it.",
        next: "Staff: run the Retention sweep from the incident.",
        diagnostics: `${rows.length} queued > 1 h`,
        related: rows.slice(0, 20).map((r) => ({ table: "retentionRuns", id: r._id, label: r.kind.replace(/_/g, " ") })),
        ownerVisible: false,
        count: rows.length,
        recoveryAttempts: rows.reduce((sum, r) => sum + r.attempts, 0),
      });
    }
    return { findings, complete: failed.length < LIMIT && stuck.length < LIMIT };
  },
  async verify(ctx, incident, now) {
    if (incident.kind !== "agent.retention_failed") return "unknown";
    // The failures are tasks for a person; once nothing failed in three days, the condition is gone.
    return incident.lastSeenAt < now - 3 * DAY ? "fixed" : "unknown";
  },
};

const googleJobs: Check = {
  name: "work.google",
  about: "Google jobs that failed after five tries or whose outcome is uncertain, and a queue the worker stopped taking from.",
  everyMs: 5 * MINUTE,
  kinds: ["work.google_failed", "platform.google_queue"],
  async scan(ctx, now) {
    const findings: Finding[] = [];
    const failed = [
      ...(await ctx.db
        .query("googleJobs")
        .withIndex("by_status_next", (q) => q.eq("status", "failed"))
        .take(LIMIT)),
      ...(await ctx.db
        .query("googleJobs")
        .withIndex("by_status_next", (q) => q.eq("status", "uncertain"))
        .take(LIMIT)),
    ].filter((job) => job.updatedAt >= now - 3 * DAY);
    for (const [companyId, rows] of byCompany(failed)) {
      const uncertain = rows.filter((r) => r.status === "uncertain").length;
      findings.push({
        key: `work.google_failed:${companyId}`,
        kind: "work.google_failed",
        companyId,
        groupKey: "provider:google:jobs",
        category: "connections",
        severity: uncertain ? "medium" : "low",
        state: "needs_staff",
        title: "Some Google updates didn't finish",
        impact: `${plural(rows.length, "One update", "{n} updates")} to Google (calendar, files or reviews) didn't complete.`,
        done: uncertain ? "Updates whose outcome isn't known were not repeated, so nothing is duplicated in Google." : "Each was tried up to five times.",
        next: "Staff: read the jobs' last errors; an uncertain write needs checking in Google before anything is retried.",
        diagnostics: `${rows.length - uncertain} failed · ${uncertain} uncertain · kinds: ${[...new Set(rows.map((r) => r.kind))].join(", ")} · ${short(rows[0]?.lastError, 160) ?? ""}`,
        related: rows.slice(0, 20).map((r) => ({ table: "googleJobs", id: r._id, label: `${r.kind} (${r.status})` })),
        ownerVisible: false,
        count: rows.length,
        recoveryAttempts: rows.reduce((sum, r) => sum + r.attempts, 0),
      });
    }
    // The worker ticks every minute; queued work due 15 minutes ago means it stopped taking work.
    const overdue = await ctx.db
      .query("googleJobs")
      .withIndex("by_status_next", (q) => q.eq("status", "queued").lt("nextAt", now - 15 * MINUTE))
      .take(LIMIT);
    if (overdue.length >= 3) {
      findings.push({
        key: "platform.google_queue",
        kind: "platform.google_queue",
        category: "platform",
        severity: "critical",
        state: "needs_staff",
        title: "Google work has stopped progressing",
        impact: `${overdue.length} queued Google jobs across ${byCompany(overdue).size} companies are overdue.`,
        done: "Nothing was retried out of order.",
        next: "Staff: check the 'google works its queue' cron and the per-company rate limit.",
        diagnostics: `oldest due ${Math.round((now - Math.min(...overdue.map((j) => j.nextAt))) / MINUTE)} min ago`,
        related: [],
        ownerVisible: false,
        count: overdue.length,
        recoveryAttempts: 0,
      });
    }
    return { findings, complete: failed.length < LIMIT && overdue.length < LIMIT };
  },
};

// ── Communications ────────────────────────────────────────────────────────────────────────────────

const PURPOSE_WORDS: Record<string, string> = {
  offer: "a job offer to a cleaner",
  backup_offer: "a job offer to a cleaner",
  assignment_confirmed: "a job confirmation",
  reminder: "a visit reminder",
  member_notice: "a notice to your team",
};
const purposeWords = (purpose: string) => PURPOSE_WORDS[purpose] ?? "a message";

/** Whether an unconfirmed text can still be checked with Telnyx under its own key (successes replay for 24 hours). */
/** Providers whose send endpoint is verified to replay a stored success for the same key (the mock models Telnyx's documented behavior). */
const REPLAYING_PROVIDERS = new Set(["telnyx", "mock"]);

export function reconcilable(message: Pick<Doc<"messages">, "status" | "channel" | "provider" | "attemptedAt" | "purpose">, now: number): boolean {
  return message.status === "unconfirmed" && (message.channel ?? "sms") === "sms" && REPLAYING_PROVIDERS.has(message.provider ?? "") && message.purpose !== "verification_code" && message.attemptedAt !== undefined && now - message.attemptedAt < 23 * HOUR;
}
/** Selestial checks by itself only while the text is fresh; later, a person decides whether it is still worth sending. */
export const AUTO_RECONCILE_MS = 30 * MINUTE;

const outbox: Check = {
  name: "communications.outbox",
  about: "Unconfirmed sends, a burst of failures, messages waiting for funds, team notices that don't arrive, and sends the outbox sweep missed.",
  everyMs: 5 * MINUTE,
  kinds: ["comms.unconfirmed", "comms.failures", "billing.held_for_funds", "billing.unavailable", "comms.notices_failing", "platform.outbox_sweep"],
  async scan(ctx, now) {
    const findings: Finding[] = [];
    const unconfirmed = (
      await ctx.db
        .query("messages")
        .withIndex("by_status_attempted", (q) => q.eq("status", "unconfirmed").gte("attemptedAt", now - 7 * DAY))
        .take(LIMIT)
    ).filter((m) => m.purpose !== "member_notice" && m.reviewedAt === undefined);
    for (const [companyId, rows] of byCompany(unconfirmed)) {
      const checking = rows.filter((m) => reconcilable(m, now) && m.reconcile === undefined && now - (m.attemptedAt ?? 0) < AUTO_RECONCILE_MS).length;
      const reconciling = rows.filter((m) => m.reconcile !== undefined).length;
      const one = rows.length === 1;
      findings.push({
        key: `comms.unconfirmed:${companyId}`,
        kind: "comms.unconfirmed",
        companyId,
        groupKey: `provider:${rows[0].provider ?? "unknown"}:unconfirmed`,
        category: "communications",
        severity: rows.length >= 5 ? "high" : "medium",
        state: checking || reconciling ? "recovering" : "waiting_owner",
        title: one ? "We're checking whether a message was sent" : `We're checking whether ${rows.length} messages were sent`,
        impact: one ? `It's not known whether ${purposeWords(rows[0].purpose)} reached ${rows[0].channel === "email" ? "its recipient" : "the phone"}.` : `It's not known whether these messages reached their recipients.`,
        done: checking || reconciling ? "Selestial paused another attempt while it checks the delivery status with the provider." : "Selestial paused another attempt so nobody gets the same message twice. The provider's report never arrived.",
        action: { kind: "review", label: one ? "View message" : "Review messages" },
        next: checking || reconciling ? "System: reconciling under the message's own idempotency key." : "Owner: decide, per message, to check-and-send or leave it.",
        diagnostics: `${rows.length} unconfirmed · providers: ${[...new Set(rows.map((m) => m.provider ?? "?"))].join(", ")} · oldest ${Math.round((now - Math.min(...rows.map((m) => m.attemptedAt ?? now))) / MINUTE)} min`,
        related: rows.slice(0, 25).map((m) => ({ table: "messages", id: m._id, label: `${purposeWords(m.purpose)} (${m.channel ?? "sms"})` })),
        ownerVisible: true,
        count: rows.length,
        recoveryAttempts: rows.reduce((sum, m) => sum + m.attempts, 0),
      });
    }

    const failed = (
      await ctx.db
        .query("messages")
        .withIndex("by_status_attempted", (q) => q.eq("status", "failed").gte("attemptedAt", now - HOUR))
        .take(LIMIT)
    ).filter((m) => m.purpose !== "member_notice");
    for (const [companyId, rows] of byCompany(failed)) {
      if (rows.length < 5) continue;
      const provider = rows[0].provider ?? "unknown";
      findings.push({
        key: `comms.failures:${companyId}`,
        kind: "comms.failures",
        companyId,
        groupKey: `provider:${provider}:failures`,
        category: "communications",
        severity: "high",
        state: "investigating",
        title: "Some messages didn't go out",
        impact: `${rows.length} messages failed to send in the last hour. Work that depends on them is waiting.`,
        done: "Each was tried up to three times. Selestial is checking whether the provider is having trouble.",
        next: "Staff: compare across companies (a platform incident opens at three); read the failures' problems.",
        diagnostics: [...new Set(rows.map((m) => m.problem ?? "no problem recorded"))].slice(0, 4).join(" | "),
        related: rows.slice(0, 25).map((m) => ({ table: "messages", id: m._id, label: `${purposeWords(m.purpose)} (${m.channel ?? "sms"})` })),
        ownerVisible: true,
        count: rows.length,
        recoveryAttempts: rows.reduce((sum, m) => sum + m.attempts, 0),
      });
    }

    const held = await ctx.db
      .query("messages")
      .withIndex("by_status_attempted", (q) => q.eq("status", "held"))
      .take(LIMIT);
    const funds = held.filter((m) => (m.holdReason === "messaging_balance" || m.holdReason === "messaging_limit") && (m.heldAt ?? now) < now - 30 * MINUTE);
    for (const [companyId, rows] of byCompany(funds)) {
      const limit = rows.every((m) => m.holdReason === "messaging_limit");
      findings.push({
        key: `billing.held_for_funds:${companyId}`,
        kind: "billing.held_for_funds",
        companyId,
        category: "billing",
        severity: "high",
        state: "waiting_owner",
        title: limit ? `${plural(rows.length, "A message is", "{n} messages are")} waiting for your spending limit` : `${plural(rows.length, "A message is", "{n} messages are")} waiting for funds`,
        impact: limit ? "Your messaging spending limit was reached, so these are waiting." : "Your messaging balance doesn't cover them, so they are waiting.",
        done: "Kept every message and its words. Nothing was charged. Messages that wait more than a day are not sent on their own: a person decides.",
        action: limit ? { kind: "update_information", label: "Review spending limit", href: "/app/settings/billing?tab=messaging#messaging-controls" } : { kind: "add_funds", label: "Add funds", href: "/app/settings/billing?tab=messaging#add-funds" },
        next: "Owner: add funds or raise the limit; held messages are re-checked before each goes.",
        diagnostics: `${rows.length} held · oldest ${Math.round((now - Math.min(...rows.map((m) => m.heldAt ?? now))) / HOUR)} h`,
        related: rows.slice(0, 25).map((m) => ({ table: "messages", id: m._id, label: `${purposeWords(m.purpose)} (${m.channel ?? "sms"})` })),
        ownerVisible: true,
        count: rows.length,
        recoveryAttempts: 0,
      });
    }
    const unavailable = held.filter((m) => m.holdReason === "billing_unavailable" && (m.heldAt ?? now) < now - HOUR);
    for (const [companyId, rows] of byCompany(unavailable)) {
      findings.push({
        key: `billing.unavailable:${companyId}`,
        kind: "billing.unavailable",
        companyId,
        groupKey: "provider:autumn:unavailable",
        category: "billing",
        severity: "high",
        state: "waiting_provider",
        title: "Messages are waiting while billing is checked",
        impact: `${plural(rows.length, "A message is", "{n} messages are")} waiting because messaging billing couldn't be reached.`,
        done: "Kept every message. Selestial tries billing again every 10 minutes. Nothing was charged.",
        next: "Staff: check Autumn status and the billing settings on the deployment.",
        related: rows.slice(0, 25).map((m) => ({ table: "messages", id: m._id, label: purposeWords(m.purpose) })),
        ownerVisible: true,
        count: rows.length,
        recoveryAttempts: 0,
      });
    }

    const notices = [
      ...(await ctx.db
        .query("messages")
        .withIndex("by_status_attempted", (q) => q.eq("status", "failed").gte("attemptedAt", now - DAY))
        .take(LIMIT)),
    ].filter((m) => m.purpose === "member_notice");
    for (const [companyId, rows] of byCompany(notices)) {
      if (rows.length < 3) continue;
      findings.push({
        key: `comms.notices_failing:${companyId}`,
        kind: "comms.notices_failing",
        companyId,
        groupKey: "provider:email:notices",
        category: "communications",
        severity: "medium",
        state: "needs_staff",
        title: "Selestial's emails to your team aren't arriving",
        impact: `${rows.length} notices from Selestial failed in the last day. Everything they describe is still in the app.`,
        done: "Each was tried again. Selestial is checking the email service.",
        action: { kind: "review", label: "Check notification settings", href: "/app/settings/notifications" },
        next: "Staff: check the notice sender and the addresses' suppression state.",
        diagnostics: [...new Set(rows.map((m) => m.problem ?? "?"))].slice(0, 3).join(" | "),
        related: rows.slice(0, 10).map((m) => ({ table: "messages", id: m._id, label: "notice" })),
        ownerVisible: true,
        count: rows.length,
        recoveryAttempts: rows.reduce((sum, m) => sum + m.attempts, 0),
      });
    }

    // sweepStuck marks a send that started 5 minutes ago and never finished; 20 means the sweep stopped.
    const sending = await ctx.db
      .query("messages")
      .withIndex("by_status_attempted", (q) => q.eq("status", "sending").lt("attemptedAt", now - 20 * MINUTE))
      .take(LIMIT);
    if (sending.length > 0) {
      findings.push({
        key: "platform.outbox_sweep",
        kind: "platform.outbox_sweep",
        category: "platform",
        severity: "critical",
        state: "needs_staff",
        title: "The outbox stopped closing unfinished sends",
        impact: `${sending.length} sends across ${byCompany(sending).size} companies started more than 20 minutes ago and were never settled or marked unconfirmed.`,
        done: "Nothing was resent.",
        next: "Staff: run 'find sends that never finished' from the incident and check the scheduler.",
        related: sending.slice(0, 25).map((m) => ({ table: "messages", id: m._id, label: m.purpose })),
        ownerVisible: false,
        count: sending.length,
        recoveryAttempts: 0,
      });
    }
    return { findings, complete: unconfirmed.length < LIMIT && failed.length < LIMIT && held.length < LIMIT && sending.length < LIMIT };
  },
};

const inbound: Check = {
  name: "communications.inbound",
  about: "Inbound texts that could not be routed to a company, and Selestial's own billing emails that failed (reported by the code that handled them).",
  everyMs: 10 * MINUTE,
  kinds: ["platform.inbound_unrouted", "comms.balance_emails"],
  async scan(ctx, now) {
    const findings: Finding[] = [];
    const unrouted = await ctx.db
      .query("opsSignals")
      .withIndex("by_kind_at", (q) => q.eq("kind", "inbound_unknown_number").gte("at", now - DAY))
      .take(LIMIT);
    const bad = await ctx.db
      .query("opsSignals")
      .withIndex("by_kind_at", (q) => q.eq("kind", "inbound_bad_number").gte("at", now - DAY))
      .take(LIMIT);
    if (unrouted.length + bad.length > 0) {
      findings.push({
        key: "platform.inbound_unrouted",
        kind: "platform.inbound_unrouted",
        category: "platform",
        severity: unrouted.length >= 10 ? "high" : "medium",
        state: "needs_staff",
        title: "Texts are arriving that no company could take",
        impact: `${unrouted.length} texts in the last day came to numbers no company uses, and ${bad.length} had a sender number that couldn't be read.`,
        done: "Each was recorded and left unanswered. No company received a stranger's text.",
        next: "Staff: check the numbers on the Telnyx messaging profile against companies' texting numbers.",
        diagnostics: [...new Set(unrouted.map((s) => s.detail))].slice(0, 8).join(", "),
        related: [],
        ownerVisible: false,
        count: unrouted.length + bad.length,
        recoveryAttempts: 0,
      });
    }
    const emails = await ctx.db
      .query("opsSignals")
      .withIndex("by_kind_at", (q) => q.eq("kind", "notice_email_failed").gte("at", now - DAY))
      .take(LIMIT);
    for (const [companyId, rows] of byCompany(emails.filter((s): s is typeof s & { companyId: Id<"companies"> } => s.companyId !== undefined))) {
      findings.push({
        key: `comms.balance_emails:${companyId}`,
        kind: "comms.balance_emails",
        companyId,
        groupKey: "provider:email:notices",
        category: "communications",
        severity: "low",
        state: "needs_staff",
        title: "A billing email from Selestial didn't arrive",
        impact: "An email about your messaging balance couldn't be delivered. The same information is on your billing page.",
        done: "Selestial recorded it and is checking the email service.",
        action: { kind: "review", label: "Open messaging billing", href: "/app/settings/billing?tab=messaging" },
        next: "Staff: check the email provider and the Owner's address.",
        diagnostics: rows.map((r) => r.detail).slice(0, 5).join(" | "),
        related: [],
        ownerVisible: true,
        count: rows.length,
        recoveryAttempts: 0,
      });
    }
    return { findings, complete: unrouted.length < LIMIT && bad.length < LIMIT && emails.length < LIMIT };
  },
};

// ── Connections ───────────────────────────────────────────────────────────────────────────────────

const INBOX_IMPACT: Record<string, { name: string; impact: string }> = {
  hiring: { name: "hiring inbox", impact: "Recruiter can't check new applications. Your existing applicants are saved." },
  sales: { name: "sales inbox", impact: "Sales can't read or answer customer emails sent to this address." },
  care: { name: "customer care inbox", impact: "Retention can't read customer replies in this inbox." },
  operations: { name: "operations inbox", impact: "Emails your team sends from this address are waiting." },
};

const connections: Check = {
  name: "connections.authorization",
  about: "Gmail inboxes, Google tools and other apps whose authorization ended.",
  everyMs: 10 * MINUTE,
  kinds: ["connections.mailbox", "connections.google", "connections.connector"],
  async scan(ctx) {
    const findings: Finding[] = [];
    const mailboxes = [
      ...(await ctx.db
        .query("mailboxConnections")
        .withIndex("by_status", (q) => q.eq("status", "expired"))
        .take(LIMIT)),
      ...(await ctx.db
        .query("mailboxConnections")
        .withIndex("by_status", (q) => q.eq("status", "error"))
        .take(LIMIT)),
    ];
    for (const box of mailboxes) {
      const purposes = box.purposes?.length ? box.purposes : ["hiring" as const];
      const first = INBOX_IMPACT[purposes[0]] ?? INBOX_IMPACT.hiring;
      const held = await ctx.db
        .query("messages")
        .withIndex("by_company_hold", (q) => q.eq("companyId", box.companyId))
        .take(200);
      const waiting = held.filter((m) => m.status === "held" && m.refusal === WAITING_FOR_INBOX).length;
      findings.push({
        key: `connections.mailbox:${box._id}`,
        kind: "connections.mailbox",
        companyId: box.companyId,
        groupKey: "provider:google:auth",
        category: "connections",
        severity: "high",
        state: "waiting_owner",
        title: `Your ${first.name} needs reconnecting`,
        impact: `${first.impact}${purposes.length > 1 ? ` It's also used for ${purposes.slice(1).map((p) => INBOX_IMPACT[p]?.name ?? p).join(" and ")}.` : ""}`,
        done: `Selestial stopped reading and sending from ${box.address}${waiting ? ` and is keeping ${plural(waiting, "one message", "{n} messages")} to send once it's back` : ""}. Nothing is lost.`,
        action: { kind: "reconnect", label: "Reconnect Gmail", href: "/app/settings/integrations?tool=gmail" },
        next: "Owner: reconnect. Google ended the authorization; nobody else can renew it.",
        diagnostics: `status ${box.status}${box.problem ? ` · ${short(box.problem, 200)}` : ""}`,
        related: [{ table: "mailboxConnections", id: box._id, label: box.address }],
        ownerVisible: true,
        count: 1 + waiting,
        recoveryAttempts: 0,
      });
    }
    const google = await ctx.db
      .query("googleConnections")
      .withIndex("by_status", (q) => q.eq("status", "expired"))
      .take(LIMIT);
    for (const row of google) {
      const label = row.feature ? FEATURE_INFO[row.feature as Feature].label : "Google";
      findings.push({
        key: `connections.google:${row._id}`,
        kind: "connections.google",
        companyId: row.companyId,
        groupKey: "provider:google:auth",
        category: "connections",
        severity: "medium",
        state: "waiting_owner",
        title: `${label} needs reconnecting`,
        impact: `Selestial can't use ${label} for you until it's reconnected. Nothing already saved there is affected.`,
        done: "Selestial stopped using the connection so nothing fails halfway.",
        action: { kind: "reconnect", label: "Reconnect", href: `/app/settings/integrations${row.feature ? `?tool=${row.feature}` : ""}` },
        next: "Owner: reconnect.",
        diagnostics: short(row.problem),
        related: [{ table: "googleConnections", id: row._id, label }],
        ownerVisible: true,
        count: 1,
        recoveryAttempts: 0,
      });
    }
    const connectors = await ctx.db
      .query("connectorConnections")
      .withIndex("by_status", (q) => q.eq("status", "expired"))
      .take(LIMIT);
    for (const row of connectors) {
      const name = row.system === "jobber" ? "Jobber" : "Housecall Pro";
      findings.push({
        key: `connections.connector:${row._id}`,
        kind: "connections.connector",
        companyId: row.companyId,
        category: "connections",
        severity: "low",
        state: "waiting_owner",
        title: `${name} needs reconnecting`,
        impact: `Selestial can't read from ${name} until it's reconnected. What was already imported is saved.`,
        done: "Selestial stopped reading so nothing is imported halfway.",
        action: { kind: "reconnect", label: `Reconnect ${name}`, href: "/app/settings/integrations" },
        next: "Owner: reconnect.",
        diagnostics: short(row.problem),
        related: [{ table: "connectorConnections", id: row._id, label: name }],
        ownerVisible: true,
        count: 1,
        recoveryAttempts: 0,
      });
    }
    return { findings, complete: mailboxes.length < LIMIT && google.length < LIMIT && connectors.length < LIMIT };
  },
};

// ── Texting registration ──────────────────────────────────────────────────────────────────────────

const texting: Check = {
  name: "communications.texting",
  about: "Registrations needing a correction, stopped, paused by carriers, approved with no number connected, awaiting review, or no longer being reconciled.",
  everyMs: 30 * MINUTE,
  kinds: ["texting.needs_you", "texting.failed", "texting.interrupted", "texting.number_pending", "texting.review_waiting", "platform.texting_reconcile"],
  async scan(ctx, now) {
    const findings: Finding[] = [];
    const read = (status: Doc<"textingRequests">["status"]) =>
      ctx.db
        .query("textingRequests")
        .withIndex("by_status_requested", (q) => q.eq("status", status))
        .take(LIMIT);
    const needs = await read("needs_you");
    for (const row of needs) {
      const kind = row.needs?.kind ?? "correction";
      const title = kind === "code" ? "Confirm it's you to keep texting setup moving" : kind === "number" ? "Choose another texting number" : "Your texting registration needs a change";
      const step = kind === "number" ? "number" : kind === "code" ? "progress" : row.needs?.fields.length ? "business" : "permission";
      findings.push({
        key: `texting.needs_you:${row._id}`,
        kind: "texting.needs_you",
        companyId: row.companyId,
        category: "communications",
        severity: "medium",
        state: "waiting_owner",
        title,
        impact: `${row.needs?.words ?? "Something in the registration needs you."} Your agents can't text from your number until it's done. Everything you filled in is kept.`,
        done: "Selestial paused the registration at this step. Nothing else is filed or charged until you answer.",
        action: { kind: "update_information", label: kind === "code" ? "Enter the code" : "Make the change", href: `/app/texting?step=${step}` },
        next: "Owner: answer in texting setup.",
        diagnostics: row.needs?.fields.length ? `fields: ${row.needs.fields.join(", ")}` : undefined,
        related: [{ table: "textingRequests", id: row._id, label: row.phoneNumber }],
        ownerVisible: true,
        count: 1,
        recoveryAttempts: 0,
      });
    }
    const failed = await read("failed");
    for (const row of failed) {
      if ((row.updatedAt ?? row.requestedAt) < now - 30 * DAY) continue;
      findings.push({
        key: `texting.failed:${row._id}`,
        kind: "texting.failed",
        companyId: row.companyId,
        category: "communications",
        severity: "high",
        state: "needs_staff",
        title: "Texting setup stopped",
        impact: "Your number isn't connected yet, so your agents can't text from it. Your answers are kept.",
        done: "Selestial stopped before anything could be filed or bought twice. A person at Selestial is looking into it.",
        action: { kind: "contact_support", label: "Contact support" },
        next: "Staff: read the request's diagnostics on Texting; Retry runs it again from where it stopped.",
        diagnostics: short(row.problem ?? row.step),
        related: [{ table: "textingRequests", id: row._id, label: row.phoneNumber }],
        ownerVisible: true,
        count: 1,
        recoveryAttempts: 0,
      });
    }
    const interrupted = await read("interrupted");
    for (const row of interrupted) {
      findings.push({
        key: `texting.interrupted:${row._id}`,
        kind: "texting.interrupted",
        companyId: row.companyId,
        groupKey: "provider:telnyx:registration",
        category: "communications",
        severity: "high",
        state: "waiting_provider",
        title: "The carriers paused your texting",
        impact: "Texts from your number are on hold. Nothing is sent while it's paused.",
        done: "Selestial stopped every text from your number and checks the registration with the carriers every day.",
        next: "Staff: check the campaign status with Telnyx; the daily check restores texting when the carriers do.",
        diagnostics: short(row.problem ?? row.step),
        related: [{ table: "textingRequests", id: row._id, label: row.phoneNumber }],
        ownerVisible: true,
        count: 1,
        recoveryAttempts: 0,
      });
    }
    const working = [...(await read("approved")), ...(await read("provisioning")), ...(await read("waiting_on_carriers"))];
    for (const row of working) {
      // Approved by the carriers with no number assigned: normal for a day, worth tracking after that.
      if (row.campaignApprovedAt !== undefined && row.assignedAt === undefined && row.campaignApprovedAt < now - DAY) {
        const long = row.campaignApprovedAt < now - 3 * DAY;
        findings.push({
          key: `texting.number_pending:${row._id}`,
          kind: "texting.number_pending",
          companyId: row.companyId,
          groupKey: "provider:telnyx:assignment",
          category: "communications",
          severity: long ? "medium" : "low",
          state: long ? "needs_staff" : "waiting_provider",
          title: "Your texting number is still connecting",
          impact: "The carriers approved your registration. Texts wait until the number is connected to it.",
          done: "Selestial checks the connection with the carriers every 30 minutes.",
          next: long ? "Staff: the number has been approved for over 3 days without connecting; check the assignment with Telnyx." : "Provider: number assignment in progress.",
          diagnostics: `approved ${Math.round((now - row.campaignApprovedAt) / HOUR)} h ago · step: ${short(row.step, 120)}`,
          related: [{ table: "textingRequests", id: row._id, label: row.phoneNumber }],
          ownerVisible: true,
          count: 1,
          recoveryAttempts: 0,
        });
      }
      // texting.reconcile re-checks rows quiet for 6 hours every 30 minutes; 12 hours quiet means it stopped.
      if ((row.lastCheckedAt ?? row.updatedAt ?? row.requestedAt) < now - 12 * HOUR && (row.leaseUntil ?? 0) < now) {
        findings.push({
          key: `platform.texting_reconcile:${row._id}`,
          kind: "platform.texting_reconcile",
          companyId: row.companyId,
          groupKey: "selestial:texting_reconcile",
          category: "platform",
          severity: "medium",
          state: "needs_staff",
          title: "Texting setup progress is delayed",
          impact: "Selestial hasn't checked this registration with the carriers for over 12 hours.",
          done: "Nothing was filed twice.",
          next: "Staff: run 'texting registrations reconcile' from the incident.",
          diagnostics: `last checked ${Math.round((now - (row.lastCheckedAt ?? row.updatedAt ?? row.requestedAt)) / HOUR)} h ago · status ${row.status}`,
          related: [{ table: "textingRequests", id: row._id, label: row.phoneNumber }],
          ownerVisible: false,
          count: 1,
          recoveryAttempts: 0,
        });
      }
    }
    const requested = await read("requested");
    for (const row of requested) {
      if (row.requestedAt > now - 2 * DAY) continue;
      findings.push({
        key: `texting.review_waiting:${row._id}`,
        kind: "texting.review_waiting",
        companyId: row.companyId,
        category: "communications",
        severity: "low",
        state: "needs_staff",
        title: "Your texting setup is waiting for Selestial's review",
        impact: "Nothing is filed with the carriers until a person at Selestial checks it.",
        done: "Your answers are saved.",
        next: "Staff: review it on Texting.",
        related: [{ table: "textingRequests", id: row._id, label: row.phoneNumber }],
        ownerVisible: false,
        count: 1,
        recoveryAttempts: 0,
      });
    }
    return { findings, complete: [needs, failed, interrupted, working, requested].every((rows) => rows.length < LIMIT) };
  },
};

// ── Billing ───────────────────────────────────────────────────────────────────────────────────────

const billing: Check = {
  name: "billing.settlement",
  about: "AI credit and messaging charges whose settlement could not be verified or keeps retrying, and messaging top-ups that failed.",
  everyMs: 15 * MINUTE,
  kinds: ["billing.unverified", "billing.retrying", "billing.topup_failed"],
  async scan(ctx, now) {
    const findings: Finding[] = [];
    const ai = await ctx.db
      .query("aiExecutions")
      .withIndex("by_settlement_next", (q) => q.eq("settlement", "unverified"))
      .take(LIMIT);
    const msg = await ctx.db
      .query("messagingCharges")
      .withIndex("by_settlement_next", (q) => q.eq("settlement", "unverified"))
      .take(LIMIT);
    const unverified = [...ai.map((r) => ({ companyId: r.companyId, id: r._id as string, table: "aiExecutions", label: `AI ${r.task}`, problem: r.settleProblem, attempts: r.settleAttempts })), ...msg.map((r) => ({ companyId: r.companyId, id: r._id as string, table: "messagingCharges", label: `Messaging ${r.kind}`, problem: r.settleProblem, attempts: r.settleAttempts }))];
    for (const [companyId, rows] of byCompany(unverified)) {
      findings.push({
        key: `billing.unverified:${companyId}`,
        kind: "billing.unverified",
        companyId,
        category: "billing",
        severity: "medium",
        state: "needs_staff",
        title: "Some charges couldn't be confirmed with billing",
        impact: `${rows.length} charges or releases were never confirmed by Autumn. The work itself is done and is not repeated.`,
        done: "Selestial retried settlement six times over about ten hours, then stopped so nothing is charged twice.",
        next: "Staff: compare each with Autumn's usage events, then settle or credit by hand on Messaging money.",
        diagnostics: [...new Set(rows.map((r) => r.problem ?? "?"))].slice(0, 3).join(" | "),
        related: rows.slice(0, 25).map((r) => ({ table: r.table, id: r.id, label: r.label })),
        ownerVisible: false,
        count: rows.length,
        recoveryAttempts: rows.reduce((sum, r) => sum + r.attempts, 0),
      });
    }
    const retrying = [];
    for (const settlement of ["pending_confirm", "pending_release"] as const) {
      const rows = await ctx.db
        .query("aiExecutions")
        .withIndex("by_settlement_next", (q) => q.eq("settlement", settlement))
        .take(LIMIT);
      retrying.push(...rows.filter((r) => r.settleAttempts >= 3));
    }
    for (const [companyId, rows] of byCompany(retrying)) {
      findings.push({
        key: `billing.retrying:${companyId}`,
        kind: "billing.retrying",
        companyId,
        groupKey: "provider:autumn:settlement",
        category: "billing",
        severity: "low",
        state: "recovering",
        title: "Charges are being settled again",
        impact: `${rows.length} AI charges are still being settled after several tries. The work is done and is not repeated.`,
        done: "Selestial retries with growing waits and never charges twice.",
        next: "Staff: if this spans companies, check Autumn.",
        diagnostics: [...new Set(rows.map((r) => r.settleProblem ?? "?"))].slice(0, 3).join(" | "),
        related: rows.slice(0, 25).map((r) => ({ table: "aiExecutions", id: r._id, label: r.task })),
        ownerVisible: false,
        count: rows.length,
        recoveryAttempts: rows.reduce((sum, r) => sum + r.settleAttempts, 0),
      });
    }
    const topUps = await ctx.db
      .query("messagingTopUps")
      .withIndex("by_status_updated", (q) => q.eq("status", "failed").gte("updatedAt", now - 7 * DAY))
      .take(LIMIT);
    for (const [companyId, rows] of byCompany(topUps)) {
      const latest = rows.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
      const later = await ctx.db
        .query("messagingTopUps")
        .withIndex("by_company_created", (q) => q.eq("companyId", companyId).gt("createdAt", latest.createdAt))
        .take(20);
      if (later.some((row) => row.status === "paid")) continue;
      findings.push({
        key: `billing.topup_failed:${companyId}`,
        kind: "billing.topup_failed",
        companyId,
        category: "billing",
        severity: "medium",
        state: "waiting_owner",
        title: "A messaging top-up didn't go through",
        impact: latest.source === "automatic" ? "Automatic top-up couldn't charge your card, so it's turned off. Texts may wait when the balance runs low." : "The payment for your messaging balance didn't go through. Your balance didn't change.",
        done: "Nothing was charged. Messages that can't be covered wait with their words kept.",
        action: { kind: "add_funds", label: "Add funds", href: "/app/settings/billing?tab=messaging#add-funds" },
        next: "Owner: add funds or update the card.",
        diagnostics: short(latest.problem),
        related: rows.map((r) => ({ table: "messagingTopUps", id: r._id, label: `$${(r.cents / 100).toFixed(2)} ${r.source}` })),
        ownerVisible: true,
        count: rows.length,
        recoveryAttempts: 0,
      });
    }
    return { findings, complete: ai.length < LIMIT && msg.length < LIMIT && retrying.length < LIMIT && topUps.length < LIMIT };
  },
  async verify(ctx, incident) {
    if (incident.kind !== "billing.topup_failed" || !incident.companyId) return "unknown";
    const recent = await ctx.db
      .query("messagingTopUps")
      .withIndex("by_company_created", (q) => q.eq("companyId", incident.companyId!))
      .order("desc")
      .first();
    return recent?.status === "paid" ? "fixed" : "unknown";
  },
};

export const CHECKS: readonly Check[] = [activation, salesRuns, retentionRuns, googleJobs, outbox, inbound, connections, texting, billing];

export function checkNamed(name: string): Check | undefined {
  return CHECKS.find((check) => check.name === name);
}

export function checkForKind(kind: string): Check | undefined {
  return CHECKS.find((check) => check.kinds.includes(kind));
}
