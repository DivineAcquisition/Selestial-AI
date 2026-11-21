/**
 * Operations: Selestial's monitoring and recovery record (docs/operations/01-recovery.md).
 *
 *  - The monitor (cron, every 5 minutes) runs each due check in its own transaction, so one failing check
 *    never stops the others, and records when each last ran and succeeded.
 *  - Staff read the Operations workspace and act on incidents: assign, note, verify, dismiss with a
 *    reason, run a workflow's own recovery job, reconcile an unconfirmed text, stop or resume a company's
 *    outbound sending. Each needs a capability (convex/lib/support/capabilities.ts) and is logged with the
 *    staff member and their reason.
 *  - Owners see their own issues (never provider codes or ids), and can act: check an unconfirmed text
 *    with the provider, leave it, or ask Selestial Support for help with the facts already attached.
 *
 * Nothing here retries business work on its own except an unconfirmed text, and only inside the
 * provider's replay window, under the message's own idempotency key, after the send policy is asked
 * again (convex/messaging.ts claim).
 */
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { companyQuery, managerMutation, managerQuery, staffMutation, staffQuery } from "./lib/builders";
import { notFound, userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { emailLayout, emailText } from "./lib/email/layout";
import { emailProvider } from "./lib/email/provider";
import { appOrigin } from "./lib/invitations";
import { AUTO_RECONCILE_MS, CHECKS, checkForKind, checkNamed, reconcilable } from "./lib/operations/checks";
import { isolationSummary } from "./lib/operations/deployment";
import { applyRun, log, planOwnerNotices, planStaffEmail, reference, regroup, resolve, STATE_WORDS, staffShouldHear } from "./lib/operations/engine";
import { CATEGORIES, INCIDENT_STATES, SEVERITIES, type Category, type OpsActor } from "./lib/operations/schema";
import { capabilitiesOf, hasCapability } from "./lib/support/capabilities";
import { text } from "./lib/text";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STAFF_STATES = new Set(["needs_staff", "investigating"]);

// ── The monitor ───────────────────────────────────────────────────────────────────────────────────

export const monitor = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let scheduled = 0;
    for (const check of CHECKS) {
      const row = await ctx.db
        .query("monitorChecks")
        .withIndex("by_name", (q) => q.eq("name", check.name))
        .first();
      if (row && row.lastRunAt + check.everyMs - 30_000 > now) continue;
      await ctx.scheduler.runAfter(0, internal.operations.runCheck, { name: check.name });
      scheduled += 1;
    }
    return scheduled;
  },
});

/** One check, in its own transaction. A scan that throws is recorded and changes nothing else. */
export const runCheck = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const check = checkNamed(args.name);
    if (!check) return null;
    const now = Date.now();
    const row = await ctx.db
      .query("monitorChecks")
      .withIndex("by_name", (q) => q.eq("name", check.name))
      .first();
    let run: Awaited<ReturnType<typeof check.scan>>;
    try {
      run = await check.scan(ctx, now);
    } catch (error) {
      const fields = { name: check.name, everyMs: check.everyMs, lastRunAt: now, durationMs: Date.now() - now, found: 0, complete: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
      if (row) await ctx.db.patch(row._id, fields);
      else await ctx.db.insert("monitorChecks", fields);
      return null;
    }
    const before = new Set(
      (
        await Promise.all(
          check.kinds.map((kind) =>
            ctx.db
              .query("incidents")
              .withIndex("by_open_kind", (q) => q.eq("open", true).eq("kind", kind))
              .take(500),
          ),
        )
      )
        .flat()
        .map((incident) => incident.companyId),
    );
    const result = await applyRun(ctx, check, run, now);
    const fields = { name: check.name, everyMs: check.everyMs, lastRunAt: now, lastOkAt: now, durationMs: Date.now() - now, found: result.found, complete: run.complete, error: undefined };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("monitorChecks", fields);

    // A fresh unconfirmed text is checked with the provider by Selestial itself; an older one waits for a person.
    for (const finding of run.findings) {
      if (finding.kind !== "comms.unconfirmed") continue;
      for (const related of finding.related) {
        const id = ctx.db.normalizeId("messages", related.id);
        const message = id ? await ctx.db.get(id) : null;
        if (message && reconcilable(message, now) && !message.reconcile && message.reviewedAt === undefined && now - (message.attemptedAt ?? 0) < AUTO_RECONCILE_MS) {
          await startReconcile(ctx, message, { kind: "system" });
        }
      }
    }
    const companies = new Set<Id<"companies"> | undefined>([...before, ...run.findings.map((f) => f.companyId)]);
    let planned = 0;
    for (const companyId of companies) {
      if (!companyId || planned >= 50) continue;
      await planOwnerNotices(ctx, companyId, now);
      planned += 1;
    }
    await planStaffEmail(ctx, now);
    return result;
  },
});

/** Puts an unconfirmed text back through the outbox under its own key, inside the provider's replay window. */
async function startReconcile(ctx: MutationCtx, message: Doc<"messages">, actor: OpsActor) {
  const now = Date.now();
  if (!reconcilable(message, now)) throw userError("This message can't be checked with the provider any more. Its 24-hour window has passed, or it wasn't a text.");
  if (message.reconcile) return false;
  // A support session's request carries the session, so the send is refused if the session ends first.
  const by = actor.kind === "member" ? `member:${actor.memberId}` : actor.kind === "staff" ? `staff:${actor.staffId}${actor.sessionId ? `:session:${actor.sessionId}` : ""}` : "system";
  await ctx.db.patch(message._id, { status: "queued", reconcile: { requestedAt: now, deadline: (message.attemptedAt ?? now) + 23 * HOUR, by }, problem: "Checking with the texting provider whether this went." });
  await ctx.scheduler.runAfter(0, internal.messaging.deliver, { messageId: message._id });
  const incident = await ctx.db
    .query("incidents")
    .withIndex("by_key_open", (q) => q.eq("key", `comms.unconfirmed:${message.companyId}`).eq("open", true))
    .first();
  await log(ctx, {
    incidentId: incident?._id,
    companyId: message.companyId,
    kind: actor.kind === "member" ? "owner_action" : actor.kind === "staff" ? "staff_action" : "recovery",
    words: "Selestial is checking with the texting provider whether a message went, under the message's own key, so it can't be sent twice.",
    detail: `message ${message._id} · deadline ${new Date((message.attemptedAt ?? now) + 23 * HOUR).toISOString()} · by ${by}`,
    actor,
  });
  if (incident) await ctx.db.patch(incident._id, { recoveryAttempts: incident.recoveryAttempts + 1, lastRecoveryAt: now, state: "recovering", updatedAt: now });
  return true;
}

// ── Staff email ───────────────────────────────────────────────────────────────────────────────────

type Digest = { to: string[]; rows: { id: Id<"incidents">; reference: string; title: string; company: string; severity: string; state: string; next: string }[] };
type Handoff = { incident: Doc<"incidents">; reference: string; company: string; log: string[]; to: string[] };

export const staffDigest = internalQuery({
  args: { audience: v.union(v.literal("admins"), v.literal("responders")) },
  handler: async (ctx, args): Promise<Digest> => {
    const staff = (await ctx.db.query("staff").take(200)).filter((row) => row.status === "active" && (args.audience === "admins" ? row.role === "admin" : hasCapability(row, "operations.act")));
    const open = await ctx.db
      .query("incidents")
      .withIndex("by_open_seen", (q) => q.eq("open", true))
      .take(500);
    const due = open.filter(staffShouldHear).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    const rows = await Promise.all(due.slice(0, 20).map(async (row) => ({ id: row._id, reference: reference(row._id), title: row.title, company: row.companyId ? ((await ctx.db.get(row.companyId))?.name ?? "A company") : "Platform", severity: row.severity, state: row.state, next: row.next })));
    return { to: staff.map((row) => row.email), rows };
  },
});

export const markStaffTold = internalMutation({
  args: { ids: v.array(v.id("incidents")), sent: v.number(), failed: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (!row) continue;
      await ctx.db.patch(id, { notified: { ...row.notified, staffAt: now } });
      await log(ctx, { incidentId: id, companyId: row.companyId, kind: "notified", words: "Selestial staff were alerted.", detail: `staff email: ${args.sent} sent, ${args.failed} failed` });
    }
  },
});

/** Critical work, emailed to staff admins: one email per half hour at most, listing what is still open when it goes. */
export const emailStaff = internalAction({
  args: { bucket: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const digest: Digest = await ctx.runQuery(internal.operations.staffDigest, { audience: "admins" });
    if (!digest.rows.length || !digest.to.length) return;
    const provider = emailProvider();
    let sent = 0;
    let failed = 0;
    const origin = appOrigin();
    const action = origin ? { label: "Open Operations", url: `${origin}/staff/operations` } : undefined;
    const heading = digest.rows.length === 1 ? `${digest.rows[0].severity === "critical" ? "Critical" : "Needs staff"}: ${digest.rows[0].title}` : `${digest.rows.length} incidents need staff`;
    const lines = digest.rows.map((row) => `${row.reference} · ${row.company} · ${row.title} — ${row.next}`);
    for (const to of digest.to) {
      if (!provider) {
        failed += 1;
        continue;
      }
      try {
        const result = await provider.send({
          to,
          subject: `[Selestial Operations] ${heading}`,
          html: emailLayout({ preheader: lines[0] ?? heading, heading, bodyHtml: lines.map((line) => `<p style="margin:0 0 10px 0;">${escape(line)}</p>`).join(""), action, footnote: "You get this because you are a Selestial staff admin. Alerts are grouped: at most one every half hour." }),
          text: emailText({ heading, lines, action, footnote: "Selestial staff admin alert." }),
          idempotencyKey: `ops-staff-${args.bucket}-${to}`,
        });
        if (result.ok) sent += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    await ctx.runMutation(internal.operations.markStaffTold, { ids: digest.rows.map((row) => row.id), sent, failed });
  },
});

export const handoffFacts = internalQuery({
  args: { incidentId: v.id("incidents") },
  handler: async (ctx, args): Promise<Handoff | null> => {
    const incident = await ctx.db.get(args.incidentId);
    if (!incident) return null;
    const company = incident.companyId ? await ctx.db.get(incident.companyId) : null;
    const entries = await ctx.db
      .query("opsLog")
      .withIndex("by_incident_at", (q) => q.eq("incidentId", incident._id))
      .order("desc")
      .take(8);
    const responders = (await ctx.db.query("staff").take(200)).filter((row) => row.status === "active" && hasCapability(row, "operations.act")).map((row) => row.email);
    return { incident, reference: reference(incident._id), company: company?.name ?? "A company", log: entries.reverse().map((row) => `${new Date(row.at).toISOString()} · ${row.words}`), to: responders };
  },
});

/** The support handoff: everything Selestial already knows, so the owner never has to describe it. No secrets, no message text. */
export const emailHandoff = internalAction({
  args: { incidentId: v.id("incidents"), note: v.optional(v.string()) },
  handler: async (ctx, args): Promise<void> => {
    const facts: Handoff | null = await ctx.runQuery(internal.operations.handoffFacts, { incidentId: args.incidentId });
    const provider = emailProvider();
    if (!facts || !provider) return;
    const i = facts.incident;
    const lines = [
      `Reference: ${facts.reference}`,
      `Company: ${facts.company}`,
      `Workflow: ${i.category.replace("_", " ")} · ${i.kind}`,
      `What the owner sees: ${i.title}. ${i.impact}`,
      `First seen ${new Date(i.firstSeenAt).toISOString()} · last seen ${new Date(i.lastSeenAt).toISOString()}`,
      `State: ${STATE_WORDS[i.state]} · automatic recovery attempts: ${i.recoveryAttempts}`,
      `Already done: ${i.done}`,
      ...(i.diagnostics ? [`Diagnostics: ${i.diagnostics}`] : []),
      ...(args.note ? [`Owner's note: ${args.note}`] : []),
      "Recent history:",
      ...facts.log,
    ];
    const origin = appOrigin();
    const action = origin ? { label: "Open the incident", url: `${origin}/staff/operations?incident=${i._id}` } : undefined;
    const heading = `Support requested: ${facts.reference} · ${facts.company}`;
    for (const to of facts.to) {
      try {
        await provider.send({ to, subject: `[Selestial Support] ${heading}`, html: emailLayout({ preheader: i.title, heading, bodyHtml: lines.map((line) => `<p style="margin:0 0 8px 0;">${escape(line)}</p>`).join(""), action, footnote: "A Selestial support handoff. It carries no secrets and no customer message text." }), text: emailText({ heading, lines, action, footnote: "Selestial support handoff." }), idempotencyKey: `ops-handoff-${i._id}-${i.supportRequestedAt ?? 0}-${to}` });
      } catch {
        // The request is on the incident either way; staff see it in Operations.
      }
    }
  },
});

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Staff: reading ────────────────────────────────────────────────────────────────────────────────

async function companyNames(ctx: QueryCtx, ids: (Id<"companies"> | undefined)[]) {
  const out = new Map<string, string>();
  for (const id of new Set(ids)) {
    if (!id) continue;
    out.set(id, (await ctx.db.get(id))?.name ?? "A company");
  }
  return out;
}

async function staffNames(ctx: QueryCtx, ids: (Id<"staff"> | undefined)[]) {
  const out = new Map<string, string>();
  for (const id of new Set(ids)) {
    if (!id) continue;
    out.set(id, (await ctx.db.get(id))?.name ?? "Staff");
  }
  return out;
}

function staffRow(row: Doc<"incidents">, companies: Map<string, string>, staff: Map<string, string>) {
  return {
    id: row._id,
    reference: reference(row._id),
    companyId: row.companyId ?? null,
    company: row.companyId ? (companies.get(row.companyId) ?? "A company") : "Platform",
    scope: row.scope,
    parentId: row.parentId ?? null,
    kind: row.kind,
    category: row.category,
    severity: row.severity,
    state: row.state,
    title: row.title,
    impact: row.impact,
    next: row.next,
    ownerVisible: row.ownerVisible,
    occurrences: row.occurrences,
    recoveryAttempts: row.recoveryAttempts,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    resolvedAt: row.resolvedAt ?? null,
    assignedTo: row.assignedTo ? (staff.get(row.assignedTo) ?? "Staff") : null,
    supportRequestedAt: row.supportRequestedAt ?? null,
  };
}

function monitorRows(rows: Doc<"monitorChecks">[], now: number) {
  return CHECKS.map((check) => {
    const row = rows.find((r) => r.name === check.name);
    const stale = !row || now - row.lastRunAt > 3 * check.everyMs;
    return { name: check.name, about: check.about, everyMs: check.everyMs, lastRunAt: row?.lastRunAt ?? null, lastOkAt: row?.lastOkAt ?? null, found: row?.found ?? 0, complete: row?.complete ?? false, error: row?.error ?? null, stale, failing: Boolean(row?.error) };
  });
}

export const overview = staffQuery({
  capability: "operations.view",
  args: { asOf: v.number() },
  handler: async (ctx, args) => {
    const now = args.asOf;
    const open = await ctx.db
      .query("incidents")
      .withIndex("by_open_seen", (q) => q.eq("open", true))
      .order("desc")
      .take(500);
    const recovered = await ctx.db
      .query("incidents")
      .withIndex("by_open_resolved", (q) => q.eq("open", false).gte("resolvedAt", now - DAY))
      .order("desc")
      .take(20);
    const checks = await ctx.db.query("monitorChecks").take(50);
    const stops = await ctx.db
      .query("companies")
      .withIndex("by_outbound_stop", (q) => q.gt("outboundStop.at", 0))
      .take(50);
    const companies = await companyNames(ctx, [...open, ...recovered].map((row) => row.companyId));
    const staff = await staffNames(ctx, open.map((row) => row.assignedTo));
    const count = <K extends string>(keys: readonly K[], pick: (row: Doc<"incidents">) => K) => Object.fromEntries(keys.map((key) => [key, open.filter((row) => pick(row) === key).length])) as Record<K, number>;
    const affected = new Set(open.filter((row) => row.companyId).map((row) => row.companyId));
    const blocked = open.filter((row) => row.scope === "company" && (row.severity === "critical" || row.severity === "high"));
    const sorted = [...open].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.lastSeenAt - a.lastSeenAt);
    const monitor = monitorRows(checks, now);
    return {
      truncated: open.length >= 500,
      counts: { open: open.length, byState: count(INCIDENT_STATES, (row) => row.state), bySeverity: count(SEVERITIES, (row) => row.severity), byCategory: count(CATEGORIES, (row) => row.category) },
      affectedCompanies: affected.size,
      platform: sorted.filter((row) => row.scope === "platform").map((row) => staffRow(row, companies, staff)),
      urgent: sorted.filter((row) => row.scope === "company" && !row.parentId && (STAFF_STATES.has(row.state) || row.severity === "critical")).slice(0, 12).map((row) => staffRow(row, companies, staff)),
      blocked: blocked.slice(0, 12).map((row) => ({ ...staffRow(row, companies, staff) })),
      waitingOwner: open.filter((row) => row.state === "waiting_owner").length,
      recovering: open.filter((row) => row.state === "recovering").length,
      recovered: recovered.map((row) => ({ ...staffRow(row, companies, staff), how: row.resolution?.how ?? "verified", evidence: row.resolution?.evidence ?? "" })),
      monitor,
      monitorStale: monitor.some((row) => row.stale),
      lastMonitorRun: checks.length ? Math.max(...checks.map((row) => row.lastRunAt)) : null,
      isolation: isolationSummary(),
      outboundStops: stops.filter((row) => row.outboundStop).map((row) => ({ companyId: row._id, company: row.name, at: row.outboundStop!.at, reason: row.outboundStop!.reason })),
      me: { capabilities: [...capabilitiesOf(ctx.staff)] },
    };
  },
});

const VIEW_CATEGORIES: Record<string, Category[] | null> = {
  attention: null,
  agent_work: ["agent_work"],
  communications: ["communications"],
  connections: ["connections"],
  billing: ["billing"],
  platform: ["platform"],
  all: null,
};

export const incidents = staffQuery({
  capability: "operations.view",
  args: {
    view: v.union(v.literal("attention"), v.literal("agent_work"), v.literal("communications"), v.literal("connections"), v.literal("billing"), v.literal("platform"), v.literal("all")),
    state: v.optional(v.string()),
    severity: v.optional(v.string()),
    companyId: v.optional(v.id("companies")),
    resolved: v.optional(v.boolean()),
    mine: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const rows = args.companyId
      ? await ctx.db
          .query("incidents")
          .withIndex("by_company_open", (q) => q.eq("companyId", args.companyId).eq("open", !args.resolved))
          .order("desc")
          .take(300)
      : await ctx.db
          .query("incidents")
          .withIndex("by_open_seen", (q) => q.eq("open", !args.resolved))
          .order("desc")
          .take(args.resolved ? 200 : 500);
    const categories = VIEW_CATEGORIES[args.view];
    let filtered = rows.filter((row) => !categories || categories.includes(row.category));
    if (args.view === "attention") filtered = filtered.filter((row) => row.state !== "recovering" && row.state !== "resolved" && !(row.parentId && row.severity === "low"));
    if (args.state) filtered = filtered.filter((row) => row.state === args.state);
    if (args.severity) filtered = filtered.filter((row) => row.severity === args.severity);
    if (args.mine) filtered = filtered.filter((row) => row.assignedTo === ctx.staff._id);
    filtered.sort((a, b) => (args.resolved ? (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0) : SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.lastSeenAt - a.lastSeenAt));
    const companies = await companyNames(ctx, filtered.map((row) => row.companyId));
    const staff = await staffNames(ctx, filtered.map((row) => row.assignedTo));
    return filtered.slice(0, 200).map((row) => staffRow(row, companies, staff));
  },
});

export const incident = staffQuery({
  capability: "operations.view",
  args: { id: v.id("incidents") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) notFound();
    const entries = await ctx.db
      .query("opsLog")
      .withIndex("by_incident_at", (q) => q.eq("incidentId", row._id))
      .order("desc")
      .take(100);
    const children = await ctx.db
      .query("incidents")
      .withIndex("by_parent", (q) => q.eq("parentId", row._id))
      .take(100);
    const parent = row.parentId ? await ctx.db.get(row.parentId) : null;
    const companies = await companyNames(ctx, [row.companyId, ...children.map((c) => c.companyId), parent?.companyId]);
    const staffIds = [row.assignedTo, row.resolution?.by, ...entries.map((e) => (e.actor.kind === "staff" ? e.actor.staffId : undefined))];
    const staff = await staffNames(ctx, staffIds);
    const check = checkForKind(row.kind);
    const checkRow = check
      ? await ctx.db
          .query("monitorChecks")
          .withIndex("by_name", (q) => q.eq("name", check.name))
          .first()
      : null;
    const company = row.companyId ? await ctx.db.get(row.companyId) : null;
    const sessions = row.companyId
      ? (
          await ctx.db
            .query("supportSessions")
            .withIndex("by_company_started", (q) => q.eq("companyId", row.companyId!))
            .order("desc")
            .take(10)
        ).filter((s) => s.incidentId === row._id)
      : [];
    return {
      ...staffRow(row, companies, staff),
      done: row.done,
      action: row.action ?? null,
      diagnostics: row.diagnostics ?? null,
      related: row.related,
      groupKey: row.groupKey ?? null,
      notified: row.notified,
      resolution: row.resolution ? { ...row.resolution, by: row.resolution.by ? (staff.get(row.resolution.by) ?? "Staff") : null } : null,
      parent: parent ? staffRow(parent, companies, staff) : null,
      children: children.map((c) => staffRow(c, companies, staff)),
      check: check ? { name: check.name, about: check.about, lastRunAt: checkRow?.lastRunAt ?? null, everyMs: check.everyMs } : null,
      companyState: company ? { outboundStop: company.outboundStop ? { at: company.outboundStop.at, reason: company.outboundStop.reason } : null, pausedAgents: company.pausedAgents, suspended: company.suspendedAt !== undefined } : null,
      sessions: sessions.map((s) => ({ id: s._id, mode: s.mode, startedAt: s.startedAt, endedAt: s.endedAt ?? null, changes: s.changes })),
      log: entries.map((e) => ({ id: e._id, at: e.at, kind: e.kind, words: e.words, detail: e.detail ?? null, actor: e.actor.kind === "staff" ? `${staff.get(e.actor.staffId) ?? "Staff"}${e.actor.sessionId ? " (support session)" : ""}` : e.actor.kind === "member" ? "Company member" : "Selestial" })),
    };
  },
});

/** Live counts from the workflows' own records, for the Agent work view. Bounded; "500+" when it hit the bound. */
export const agentWork = staffQuery({
  capability: "operations.view",
  args: { asOf: v.number() },
  handler: async (ctx, args) => {
    const now = args.asOf;
    const LIMIT = 500;
    const companies = new Map<string, string>();
    const name = async (id: Id<"companies">) => {
      if (!companies.has(id)) companies.set(id, (await ctx.db.get(id))?.name ?? "A company");
      return companies.get(id)!;
    };
    const tasks = async (state: Doc<"activationTasks">["state"]) =>
      ctx.db
        .query("activationTasks")
        .withIndex("by_state_lease", (q) => q.eq("state", state))
        .take(LIMIT);
    const working = await tasks("working");
    const queued = await tasks("queued");
    const waiting = [...(await tasks("waiting_info")), ...(await tasks("waiting_connection")), ...(await tasks("paused")), ...(await tasks("ready_for_review"))];
    const failed = (await tasks("failed")).filter((t) => (t.finishedAt ?? t.updatedAt) >= now - 3 * DAY);
    const completed = (await tasks("completed")).filter((t) => (t.finishedAt ?? 0) >= now - DAY);
    const stalled = working.filter((t) => (t.leaseUntil ?? now) < now - 15 * MINUTE);
    const sales = async (status: Doc<"salesRuns">["status"]) =>
      ctx.db
        .query("salesRuns")
        .withIndex("by_status_started", (q) => q.eq("status", status))
        .order("desc")
        .take(LIMIT);
    const salesRunning = await sales("running");
    const salesFailed = (await sales("failed")).filter((r) => (r.startedAt ?? r.createdAt) >= now - DAY);
    const retention = async (status: Doc<"retentionRuns">["status"]) =>
      ctx.db
        .query("retentionRuns")
        .withIndex("by_status_queued", (q) => q.eq("status", status))
        .order("desc")
        .take(LIMIT);
    const retentionQueued = await retention("queued");
    const retentionFailed = (await retention("failed")).filter((r) => r.queuedAt >= now - 3 * DAY);
    const google = async (status: Doc<"googleJobs">["status"]) =>
      ctx.db
        .query("googleJobs")
        .withIndex("by_status_next", (q) => q.eq("status", status))
        .take(LIMIT);
    const googleQueued = await google("queued");
    const googleRunning = await google("running");
    const googleFailed = (await google("failed")).filter((j) => j.updatedAt >= now - 3 * DAY);
    const googleUncertain = await google("uncertain");
    const chat = async (status: Doc<"chatRuns">["status"]) =>
      ctx.db
        .query("chatRuns")
        .withIndex("by_status_heartbeat", (q) => q.eq("status", status))
        .order("desc")
        .take(LIMIT);
    const chatRunning = await chat("running");
    const chatFailed = (await chat("failed")).filter((r) => (r.endedAt ?? 0) >= now - DAY);
    const n = (rows: unknown[]) => (rows.length >= LIMIT ? `${LIMIT}+` : String(rows.length));
    const oldest = (values: (number | undefined)[]) => {
      const list = values.filter((x): x is number => typeof x === "number");
      return list.length ? Math.min(...list) : null;
    };
    const rows = [
      { workflow: "First work (activation)", running: n(working), waiting: n([...queued, ...waiting]), stalled: n(stalled), failed: n(failed), recovered: n(completed.filter((t) => t.attempts > 1)), oldestRunningAt: oldest(working.map((t) => t.updatedAt)), recovery: "Lease 2 min · retry 30s·2ⁿ ×3 · 5-min sweep" },
      { workflow: "Sales agent", running: n(salesRunning), waiting: "—", stalled: n(salesRunning.filter((r) => (r.startedAt ?? now) < now - 20 * MINUTE)), failed: n(salesFailed), recovered: "—", oldestRunningAt: oldest(salesRunning.map((r) => r.startedAt)), recovery: "3 attempts · attempt×30s · 5-min sweep" },
      { workflow: "Retention", running: "—", waiting: n(retentionQueued), stalled: n(retentionQueued.filter((r) => r.queuedAt < now - HOUR)), failed: n(retentionFailed), recovered: "—", oldestRunningAt: oldest(retentionQueued.map((r) => r.queuedAt)), recovery: "3 attempts · 10-min sweep · task for a person" },
      { workflow: "Google jobs", running: n(googleRunning), waiting: n(googleQueued), stalled: n(googleQueued.filter((j) => j.nextAt < now - 15 * MINUTE)), failed: `${n(googleFailed)} · ${n(googleUncertain)} uncertain`, recovered: "—", oldestRunningAt: oldest(googleRunning.map((j) => j.updatedAt)), recovery: "5 attempts · 30s·4ⁿ ≤2 h · uncertain writes never repeated" },
      { workflow: "Company Chat", running: n(chatRunning), waiting: "—", stalled: n(chatRunning.filter((r) => r.heartbeatAt < now - 3 * MINUTE)), failed: n(chatFailed), recovered: "—", oldestRunningAt: oldest(chatRunning.map((r) => r.heartbeatAt)), recovery: "Heartbeat · 2-min sweep closes honestly" },
    ];
    const items = await Promise.all(
      [
        ...stalled.map((t) => ({ companyId: t.companyId, what: t.title, workflow: "First work", state: "stalled", since: t.leaseUntil ?? t.updatedAt, attempts: t.attempts, detail: t.lastError ?? null })),
        ...failed.slice(0, 20).map((t) => ({ companyId: t.companyId, what: t.title, workflow: "First work", state: "failed", since: t.finishedAt ?? t.updatedAt, attempts: t.attempts, detail: t.blocker?.words ?? t.lastError ?? null })),
        ...salesFailed.slice(0, 20).map((r) => ({ companyId: r.companyId, what: `Sales run (${r.trigger})`, workflow: "Sales", state: "failed", since: r.finishedAt ?? r.startedAt ?? r.createdAt, attempts: r.attempt, detail: r.result ?? null })),
        ...retentionFailed.slice(0, 20).map((r) => ({ companyId: r.companyId, what: r.kind.replace(/_/g, " "), workflow: "Retention", state: "failed", since: r.finishedAt ?? r.queuedAt, attempts: r.attempts, detail: r.result ?? null })),
        ...googleUncertain.slice(0, 20).map((j) => ({ companyId: j.companyId, what: j.kind, workflow: "Google", state: "uncertain", since: j.updatedAt, attempts: j.attempts, detail: j.lastError ?? null })),
      ]
        .sort((a, b) => b.since - a.since)
        .slice(0, 60)
        .map(async (item) => ({ ...item, company: await name(item.companyId), detail: item.detail ? item.detail.slice(0, 240) : null })),
    );
    return { rows, items };
  },
});

/** Live counts for the Communications, Connections and Billing views. Bounded the same way. */
export const live = staffQuery({
  capability: "operations.view",
  args: { asOf: v.number() },
  handler: async (ctx, args) => {
    const now = args.asOf;
    const LIMIT = 500;
    const n = (rows: unknown[]) => (rows.length >= LIMIT ? `${LIMIT}+` : String(rows.length));
    const messages = async (status: Doc<"messages">["status"], since?: number) =>
      ctx.db
        .query("messages")
        .withIndex("by_status_attempted", (q) => (since === undefined ? q.eq("status", status) : q.eq("status", status).gte("attemptedAt", since)))
        .take(LIMIT);
    const unconfirmed = (await messages("unconfirmed", now - 7 * DAY)).filter((m) => m.reviewedAt === undefined);
    const failed = await messages("failed", now - DAY);
    const held = await messages("held");
    const sending = (await messages("sending")).filter((m) => (m.attemptedAt ?? now) < now - 5 * MINUTE);
    const texting = async (status: Doc<"textingRequests">["status"]) =>
      ctx.db
        .query("textingRequests")
        .withIndex("by_status_requested", (q) => q.eq("status", status))
        .take(LIMIT);
    const inbound = await ctx.db
      .query("opsSignals")
      .withIndex("by_kind_at", (q) => q.eq("kind", "inbound_unknown_number").gte("at", now - DAY))
      .take(LIMIT);
    const mail = async (status: Doc<"mailboxConnections">["status"]) =>
      ctx.db
        .query("mailboxConnections")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(LIMIT);
    const googleExpired = await ctx.db
      .query("googleConnections")
      .withIndex("by_status", (q) => q.eq("status", "expired"))
      .take(LIMIT);
    const connectorsExpired = await ctx.db
      .query("connectorConnections")
      .withIndex("by_status", (q) => q.eq("status", "expired"))
      .take(LIMIT);
    const settle = async (table: "aiExecutions" | "messagingCharges", settlement: "unverified" | "pending_confirm" | "pending_release") =>
      table === "aiExecutions"
        ? ctx.db
            .query("aiExecutions")
            .withIndex("by_settlement_next", (q) => q.eq("settlement", settlement))
            .take(LIMIT)
        : ctx.db
            .query("messagingCharges")
            .withIndex("by_settlement_next", (q) => q.eq("settlement", settlement))
            .take(LIMIT);
    const topUpsFailed = await ctx.db
      .query("messagingTopUps")
      .withIndex("by_status_updated", (q) => q.eq("status", "failed").gte("updatedAt", now - 7 * DAY))
      .take(LIMIT);
    const attention = await ctx.db
      .query("messagingAttention")
      .withIndex("by_resolved_at", (q) => q.eq("resolvedAt", 0))
      .take(LIMIT);
    const byProvider = (rows: Doc<"messages">[]) => Object.entries(rows.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.provider ?? "unknown"]: (acc[m.provider ?? "unknown"] ?? 0) + 1 }), {})).map(([provider, count]) => ({ provider, count }));
    const aiPending = [...(await settle("aiExecutions", "pending_confirm")), ...(await settle("aiExecutions", "pending_release"))];
    return {
      communications: {
        unconfirmed: n(unconfirmed),
        reconciling: String(unconfirmed.filter((m) => m.reconcile).length),
        failed24h: n(failed),
        failedByProvider: byProvider(failed),
        heldForFunds: n(held.filter((m) => m.holdReason === "messaging_balance" || m.holdReason === "messaging_limit")),
        heldBillingUnavailable: n(held.filter((m) => m.holdReason === "billing_unavailable")),
        heldForInbox: n(held.filter((m) => m.refusal === "inbox_disconnected")),
        heldQuietHours: n(held.filter((m) => !m.holdReason && m.refusal !== "inbox_disconnected")),
        sendingOver5m: n(sending),
        inboundUnrouted24h: n(inbound),
        texting: {
          awaitingReview: n(await texting("requested")),
          needsOwner: n(await texting("needs_you")),
          withCarriers: n([...(await texting("approved")), ...(await texting("provisioning")), ...(await texting("waiting_on_carriers"))]),
          interrupted: n(await texting("interrupted")),
          failed: n(await texting("failed")),
          active: n(await texting("active")),
        },
      },
      connections: {
        mailboxesExpired: n(await mail("expired")),
        mailboxesError: n(await mail("error")),
        mailboxesConnected: n(await mail("connected")),
        googleExpired: n(googleExpired),
        connectorsExpired: n(connectorsExpired),
      },
      billing: {
        aiUnverified: n(await settle("aiExecutions", "unverified")),
        aiRetrying: n(aiPending.filter((r) => r.settleAttempts >= 3)),
        aiPending: n(aiPending),
        messagingUnverified: n(await settle("messagingCharges", "unverified")),
        topUpsFailed7d: n(topUpsFailed),
        messagingAttention: n(attention),
      },
    };
  },
});

export const activity = staffQuery({
  capability: "operations.view",
  args: { limit: v.optional(v.number()), actor: v.optional(v.union(v.literal("staff"), v.literal("system"), v.literal("member"))) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("opsLog")
      .withIndex("by_at")
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 100, 1), 300));
    const filtered = args.actor ? rows.filter((row) => row.actor.kind === args.actor) : rows;
    const companies = await companyNames(ctx, filtered.map((row) => row.companyId));
    const staff = await staffNames(ctx, filtered.map((row) => (row.actor.kind === "staff" ? row.actor.staffId : undefined)));
    const incidents = new Map<string, Doc<"incidents"> | null>();
    for (const row of filtered) if (row.incidentId && !incidents.has(row.incidentId)) incidents.set(row.incidentId, await ctx.db.get(row.incidentId));
    return filtered.map((row) => {
      const inc = row.incidentId ? incidents.get(row.incidentId) : null;
      return {
        id: row._id,
        at: row.at,
        kind: row.kind,
        words: row.words,
        detail: row.detail ?? null,
        company: row.companyId ? (companies.get(row.companyId) ?? "A company") : null,
        actor: row.actor.kind === "staff" ? (staff.get(row.actor.staffId) ?? "Staff") : row.actor.kind === "member" ? "Company member" : "Selestial",
        actorKind: row.actor.kind,
        viaSession: row.actor.kind === "staff" && row.actor.sessionId !== undefined,
        incident: inc ? { id: inc._id, reference: reference(inc._id), title: inc.title } : null,
      };
    });
  },
});

// ── Staff: acting ─────────────────────────────────────────────────────────────────────────────────

const staffActor = (ctx: { staff: Doc<"staff"> }): OpsActor => ({ kind: "staff", staffId: ctx.staff._id });

async function incidentOrFail(ctx: QueryCtx, id: Id<"incidents">) {
  const row = await ctx.db.get(id);
  if (!row) notFound();
  return row;
}

export const assign = staffMutation({
  capability: "operations.act",
  args: { id: v.id("incidents"), staffId: v.optional(v.union(v.id("staff"), v.null())) },
  handler: async (ctx, args) => {
    const row = await incidentOrFail(ctx, args.id);
    const to = args.staffId === null ? null : (args.staffId ?? ctx.staff._id);
    if (to) {
      const target = await ctx.db.get(to);
      if (!target || target.status !== "active" || !hasCapability(target, "operations.act")) throw userError("That person can't work incidents.");
    }
    await ctx.db.patch(row._id, { assignedTo: to ?? undefined, updatedAt: Date.now() });
    const name = to ? ((await ctx.db.get(to))?.name ?? "Staff") : null;
    await log(ctx, { incidentId: row._id, companyId: row.companyId, kind: "assigned", words: name ? `Assigned to ${name} at Selestial.` : "Unassigned.", actor: staffActor(ctx) });
    return null;
  },
});

export const note = staffMutation({
  capability: "operations.act",
  args: { id: v.id("incidents"), words: v.string() },
  handler: async (ctx, args) => {
    const row = await incidentOrFail(ctx, args.id);
    // Staff notes are for staff: they are never shown on an owner's card.
    await log(ctx, { incidentId: row._id, companyId: row.companyId, kind: "note", words: "Staff note added.", detail: text(args.words, "The note", 1000), actor: staffActor(ctx) });
    return null;
  },
});

/** Runs the incident's own check now. It resolves only if the check no longer finds the problem. */
export const verify = staffMutation({
  capability: "operations.act",
  args: { id: v.id("incidents") },
  handler: async (ctx, args) => {
    const row = await incidentOrFail(ctx, args.id);
    if (!row.open) return { open: false };
    const now = Date.now();
    if (row.kind === "platform.group" && row.groupKey) {
      await regroup(ctx, row.groupKey, now);
    } else {
      const check = checkForKind(row.kind);
      if (!check) throw userError("No check covers this incident.");
      await applyRun(ctx, check, await check.scan(ctx, now), now);
    }
    const after = await ctx.db.get(row._id);
    if (after?.open) await log(ctx, { incidentId: row._id, companyId: row.companyId, kind: "staff_action", words: "Selestial checked again: it's still happening.", actor: staffActor(ctx) });
    return { open: after?.open ?? false };
  },
});

/** Closes an incident that is not actionable, with a reason. The same problem, unchanged, stays closed for a week. */
export const dismiss = staffMutation({
  capability: "operations.act",
  args: { id: v.id("incidents"), reason: v.string() },
  handler: async (ctx, args) => {
    const row = await incidentOrFail(ctx, args.id);
    const reason = text(args.reason, "The reason", 500);
    if (reason.length < 10) throw userError("Say why it isn't actionable, so the dismissal can be audited.");
    await resolve(ctx, row, { how: "dismissed", evidence: reason, by: ctx.staff._id }, Date.now(), staffActor(ctx));
    return null;
  },
});

/** Each workflow's own recovery job, run now. These are the same idempotent sweeps the crons run. */
const JOBS: Record<string, { label: string; ref: FunctionReference<"mutation" | "action", "internal", Record<string, never>> }> = {
  "activation.sweep": { label: "Activation: recover and resume first work", ref: internal.activation.sweep },
  "messaging.sweepStuck": { label: "Outbox: find sends that never finished", ref: internal.messaging.sweepStuck },
  "billing.sweep": { label: "Billing: settle and recover AI work", ref: internal.billing.sweep },
  "messagingBilling.sweep": { label: "Messaging charges: settle and recover", ref: internal.messagingBilling.sweep },
  "texting.reconcile": { label: "Texting registrations: reconcile", ref: internal.texting.reconcile },
  "googleWork.tick": { label: "Google: work the queue", ref: internal.googleWork.tick },
  "salesAgent.sweep": { label: "Sales: pick up what a missed trigger left", ref: internal.salesAgent.sweep },
  "retentionWork.sweep": { label: "Retention: reconcile and follow through", ref: internal.retentionWork.sweep },
  "chatRuns.sweep": { label: "Chat: close interrupted responses", ref: internal.chatRuns.sweep },
  "operations.monitor": { label: "Operations: run due checks", ref: internal.operations.monitor },
};
export const RECOVERY_JOBS: { id: string; label: string }[] = Object.entries(JOBS).map(([id, job]) => ({ id, label: job.label }));

export const runRecovery = staffMutation({
  capability: "operations.act",
  args: { job: v.string(), id: v.optional(v.id("incidents")), reason: v.string() },
  handler: async (ctx, args) => {
    const job = JOBS[args.job];
    if (!job) throw userError("That isn't a recovery job.");
    const reason = text(args.reason, "The reason", 300);
    await ctx.scheduler.runAfter(0, job.ref, {});
    const row = args.id ? await ctx.db.get(args.id) : null;
    await log(ctx, { incidentId: row?._id, companyId: row?.companyId, kind: "staff_action", words: `Selestial restarted its own recovery: ${job.label}.`, detail: `job ${args.job} · ${reason}`, actor: staffActor(ctx) });
    return null;
  },
});

export const reconcileMessage = staffMutation({
  capability: "communications.act",
  args: { messageId: v.id("messages"), reason: v.string() },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) notFound();
    text(args.reason, "The reason", 300);
    return startReconcile(ctx, message, staffActor(ctx));
  },
});

/** Selestial's emergency stop on one company's outbound activity (docs/operations/01-recovery.md §Controls). */
export const stopOutbound = staffMutation({
  capability: "communications.act",
  args: { companyId: v.id("companies"), reason: v.string(), incidentId: v.optional(v.id("incidents")) },
  handler: async (ctx, args) => {
    const company = await ctx.db.get(args.companyId);
    if (!company) notFound();
    const reason = text(args.reason, "The reason", 500);
    if (reason.length < 10) throw userError("Say why, so the stop can be audited and explained.");
    if (company.outboundStop) return null;
    const now = Date.now();
    await ctx.db.patch(company._id, { outboundStop: { at: now, staffId: ctx.staff._id, reason, ...(args.incidentId ? { incidentId: args.incidentId } : {}) } });
    await recordEvent(ctx, { companyId: company._id, type: "company.outbound_stopped", actor: { kind: "system" }, subject: { table: "companies", id: company._id }, data: { staffId: ctx.staff._id } });
    await log(ctx, { incidentId: args.incidentId, companyId: company._id, kind: "suspension", words: "Selestial stopped outbound texts, emails and autonomous agent actions for this company while it looks into a problem. Inbound texts, STOP replies, delivery reports and billing reconciliation continue.", detail: reason, actor: staffActor(ctx), at: now });
    return null;
  },
});

export const resumeOutbound = staffMutation({
  capability: "communications.act",
  args: { companyId: v.id("companies"), reason: v.string() },
  handler: async (ctx, args) => {
    const company = await ctx.db.get(args.companyId);
    if (!company) notFound();
    if (!company.outboundStop) return null;
    const reason = text(args.reason, "The reason", 500);
    await ctx.db.patch(company._id, { outboundStop: undefined });
    await recordEvent(ctx, { companyId: company._id, type: "company.outbound_resumed", actor: { kind: "system" }, subject: { table: "companies", id: company._id }, data: { staffId: ctx.staff._id } });
    await log(ctx, { incidentId: company.outboundStop.incidentId, companyId: company._id, kind: "suspension", words: "Selestial resumed outbound sending. Nothing refused while it was stopped is sent now; new work is checked as usual.", detail: reason, actor: staffActor(ctx) });
    return null;
  },
});

// ── Owners ────────────────────────────────────────────────────────────────────────────────────────

const OWNER_LOG = new Set(["detected", "state", "recovery", "recovered", "resolved", "owner_action", "support_requested", "staff_action", "suspension"]);
const AREA = v.optional(v.union(v.literal("all"), v.literal("agent_work"), v.literal("communications"), v.literal("connections"), v.literal("billing")));

/** What is wrong for this company right now, in its own words, and what was just fixed. */
export const forCompany = companyQuery({
  args: { area: AREA, kinds: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const open = await ctx.db
      .query("incidents")
      .withIndex("by_company_open", (q) => q.eq("companyId", ctx.companyId).eq("open", true))
      .order("desc")
      .take(100);
    const closed = await ctx.db
      .query("incidents")
      .withIndex("by_company_open", (q) => q.eq("companyId", ctx.companyId).eq("open", false).gte("lastSeenAt", now - 3 * DAY))
      .order("desc")
      .take(50);
    const inArea = (row: Doc<"incidents">) => row.ownerVisible && (!args.area || args.area === "all" || row.category === args.area) && (!args.kinds || args.kinds.includes(row.kind));
    const issues = await Promise.all(
      open
        .filter(inArea)
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.lastSeenAt - a.lastSeenAt)
        .map(async (row) => {
          const entries = await ctx.db
            .query("opsLog")
            .withIndex("by_incident_at", (q) => q.eq("incidentId", row._id))
            .order("desc")
            .take(20);
          return {
            id: row._id,
            reference: reference(row._id),
            kind: row.kind,
            category: row.category,
            severity: row.severity,
            state: row.state,
            stateWords: STATE_WORDS[row.state],
            title: row.title,
            impact: row.impact,
            done: row.done,
            action: row.action ?? null,
            firstSeenAt: row.firstSeenAt,
            lastSeenAt: row.lastSeenAt,
            recoveryAttempts: row.recoveryAttempts,
            supportRequestedAt: row.supportRequestedAt ?? null,
            updates: entries
              .filter((e) => OWNER_LOG.has(e.kind))
              .slice(0, 6)
              .map((e) => ({ at: e.at, words: e.words })),
          };
        }),
    );
    const recovered = closed.filter((row) => inArea(row) && row.resolution?.how === "verified" && (row.resolvedAt ?? 0) > now - DAY).map((row) => ({ id: row._id, title: row.title, resolvedAt: row.resolvedAt ?? now, reference: reference(row._id) }));
    const checks = await ctx.db.query("monitorChecks").take(50);
    const monitor = monitorRows(checks, now);
    return {
      issues,
      recovered,
      checkedAt: checks.length ? Math.max(...checks.map((row) => row.lastOkAt ?? 0)) : null,
      stale: monitor.some((row) => row.stale),
      outboundStopped: ctx.company.outboundStop ? { at: ctx.company.outboundStop.at } : null,
    };
  },
});

const PURPOSE: Record<string, string> = { offer: "Job offer", backup_offer: "Job offer", assignment_confirmed: "Job confirmation", reminder: "Visit reminder", before_photos: "Photo reminder", check_in_nudge: "Check-in reminder", offer_withdrawn: "Offer withdrawn", assignment_ended: "Assignment ended" };

function mask(to: string | undefined, channel: string) {
  if (!to) return "";
  if (channel === "email") {
    const [name, domain] = to.split("@");
    return `${name.slice(0, 1)}…@${domain ?? ""}`;
  }
  return `…${to.slice(-4)}`;
}

/** The messages behind an unconfirmed-delivery issue: what each was, to whom (masked), and what can be done. */
export const uncertainMessages = managerQuery({
  args: { incidentId: v.id("incidents") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.incidentId);
    if (!row || row.companyId !== ctx.companyId || row.kind !== "comms.unconfirmed") notFound();
    const now = Date.now();
    const out = [];
    for (const related of row.related) {
      const id = ctx.db.normalizeId("messages", related.id);
      const message = id ? await ctx.db.get(id) : null;
      if (!message || message.companyId !== ctx.companyId) continue;
      const channel = message.channel ?? "sms";
      out.push({
        id: message._id,
        what: PURPOSE[message.purpose] ?? (message.subject ? "Email" : "Message"),
        channel,
        to: mask(message.to, channel),
        attemptedAt: message.attemptedAt ?? message.queuedAt,
        status: message.status,
        checking: message.reconcile !== undefined,
        canCheck: reconcilable(message, now) && !message.reconcile,
        checkUntil: message.attemptedAt !== undefined ? message.attemptedAt + 23 * HOUR : null,
        open: message.jobId ? `?open=job:${message.jobId}` : null,
        reviewed: message.reviewedAt !== undefined,
      });
    }
    return out;
  },
});

async function ownedMessage(ctx: QueryCtx & { companyId: Id<"companies"> }, id: Id<"messages">) {
  const message = await ctx.db.get(id);
  if (!message || message.companyId !== ctx.companyId) notFound();
  return message;
}

/**
 * Check with the provider whether an unconfirmed text went, and send it only if it never did. The send
 * policy (consent, STOP, pauses, Selestial's stop, quiet hours), billing and the record's own checks run
 * again first; the provider's replay of the stored answer prevents a second copy.
 */
export const checkMessage = managerMutation({
  args: { messageId: v.id("messages") },
  support: { capability: "communications.act", summary: "Checked with the texting provider whether a message went", sensitive: true },
  handler: async (ctx, args) => {
    const message = await ownedMessage(ctx, args.messageId);
    if (message.status !== "unconfirmed") throw userError("This message isn't waiting on a check any more.");
    const started = await startReconcile(ctx, message, ctx.support ? { kind: "staff", staffId: ctx.support.staffId, sessionId: ctx.support.sessionId } : { kind: "member", memberId: ctx.member._id });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "message.reconcile_requested", actor: byMember(ctx), subject: { table: "messages", id: message._id } });
    return started;
  },
});

/** Leave an unconfirmed message as it is: nothing is sent, and it is no longer tracked. */
export const leaveMessage = managerMutation({
  args: { messageId: v.id("messages") },
  support: { capability: "communications.act", summary: "Marked an unconfirmed message as handled", sensitive: false },
  handler: async (ctx, args) => {
    const message = await ownedMessage(ctx, args.messageId);
    if (message.status !== "unconfirmed") return null;
    await ctx.db.patch(message._id, { reviewedAt: Date.now(), reviewedBy: ctx.support ? `staff:${ctx.support.staffId}` : `member:${ctx.member._id}` });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "message.left_unconfirmed", actor: byMember(ctx), subject: { table: "messages", id: message._id } });
    return null;
  },
});

/** Ask Selestial Support for help with one issue. The handoff carries what Selestial already knows. */
export const requestSupport = managerMutation({
  args: { incidentId: v.id("incidents"), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.incidentId);
    if (!row || row.companyId !== ctx.companyId || !row.ownerVisible) notFound();
    const note = args.note?.trim() ? text(args.note, "Your note", 500) : undefined;
    const now = Date.now();
    if (row.supportRequestedAt && row.supportRequestedAt > now - HOUR) return reference(row._id);
    await ctx.db.patch(row._id, { supportRequestedAt: now, updatedAt: now });
    await log(ctx, { incidentId: row._id, companyId: ctx.companyId, kind: "support_requested", words: `You asked Selestial Support for help. Reference ${reference(row._id)}. They have the details already.`, detail: note, actor: { kind: "member", memberId: ctx.member._id } });
    await ctx.scheduler.runAfter(0, internal.operations.emailHandoff, { incidentId: row._id, ...(note ? { note } : {}) });
    return reference(row._id);
  },
});
