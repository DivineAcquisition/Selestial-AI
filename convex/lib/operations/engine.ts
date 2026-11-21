/**
 * The incident record: what the monitor does with a check's findings (docs/operations/01-recovery.md).
 *
 *  - One open incident per key. A finding seen again updates it; it is never a second incident.
 *  - Resolved only on evidence: the check, run again, no longer finds it (or verifies it directly). A
 *    retry, a click or time passing is never evidence by itself.
 *  - Platform grouping: three or more companies with the same group key share a platform incident; each
 *    company keeps its own incident and its own impact.
 *  - Notices: owners are emailed when they must act, grouped per company and hour; again when something
 *    they were told about recovered. Staff admins are emailed for critical work, grouped per half hour.
 */
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { notifyMembers } from "../notify/route";
import type { Check, Finding } from "./checks";
import type { IncidentState, LogKind, OpsActor } from "./schema";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SYSTEM: OpsActor = { kind: "system" };

/** The short reference an owner and staff both quote: INC- and the end of the id. */
export function reference(id: Id<"incidents">): string {
  return `INC-${id.slice(-6).toUpperCase()}`;
}

export const STATE_WORDS: Record<IncidentState, string> = {
  investigating: "Investigating",
  recovering: "Recovering automatically",
  waiting_owner: "Waiting for the owner",
  waiting_provider: "Waiting for the provider",
  needs_staff: "Needs staff action",
  resolved: "Resolved",
};

export async function log(ctx: MutationCtx, entry: { incidentId?: Id<"incidents">; companyId?: Id<"companies">; kind: LogKind; words: string; detail?: string; actor?: OpsActor; at?: number }) {
  return ctx.db.insert("opsLog", { incidentId: entry.incidentId, companyId: entry.companyId, kind: entry.kind, words: entry.words.slice(0, 500), ...(entry.detail ? { detail: entry.detail.slice(0, 1000) } : {}), actor: entry.actor ?? SYSTEM, at: entry.at ?? Date.now() });
}

async function openByKey(ctx: MutationCtx, key: string) {
  return ctx.db
    .query("incidents")
    .withIndex("by_key_open", (q) => q.eq("key", key).eq("open", true))
    .first();
}

/** Records one finding: a new incident, or the open one for its key brought up to date. */
export async function upsert(ctx: MutationCtx, finding: Finding, now: number): Promise<Id<"incidents"> | null> {
  const existing = await openByKey(ctx, finding.key);
  if (!existing) {
    // Staff dismissed this exact problem in the last week and it has not grown: it stays dismissed.
    const last = await ctx.db
      .query("incidents")
      .withIndex("by_key_open", (q) => q.eq("key", finding.key).eq("open", false))
      .order("desc")
      .first();
    if (last?.resolution?.how === "dismissed" && (last.resolvedAt ?? 0) > now - 7 * 24 * HOUR && finding.count <= last.occurrences) return null;
  }
  const fields = {
    companyId: finding.companyId,
    scope: finding.companyId ? ("company" as const) : ("platform" as const),
    kind: finding.kind,
    ...(finding.groupKey ? { groupKey: finding.groupKey } : {}),
    category: finding.category,
    severity: finding.severity,
    state: finding.state,
    title: finding.title,
    impact: finding.impact,
    done: finding.done,
    action: finding.action,
    next: finding.next,
    diagnostics: finding.diagnostics,
    related: finding.related.slice(0, 30),
    ownerVisible: finding.ownerVisible,
    occurrences: finding.count,
    lastSeenAt: now,
    updatedAt: now,
  };
  if (!existing) {
    const id = await ctx.db.insert("incidents", { ...fields, key: finding.key, open: true, firstSeenAt: now, recoveryAttempts: finding.recoveryAttempts, notified: {} });
    await log(ctx, { incidentId: id, companyId: finding.companyId, kind: "detected", words: `Selestial noticed: ${finding.title}.`, detail: finding.diagnostics, at: now });
    return id;
  }
  await ctx.db.patch(existing._id, { ...fields, recoveryAttempts: Math.max(existing.recoveryAttempts, finding.recoveryAttempts), ...(finding.recoveryAttempts > existing.recoveryAttempts ? { lastRecoveryAt: now } : {}) });
  if (existing.state !== finding.state) {
    await log(ctx, { incidentId: existing._id, companyId: finding.companyId, kind: "state", words: `${STATE_WORDS[finding.state]}.`, detail: `${existing.state} → ${finding.state}`, at: now });
  }
  if (finding.recoveryAttempts > existing.recoveryAttempts) {
    await log(ctx, { incidentId: existing._id, companyId: finding.companyId, kind: "recovery", words: `Selestial tried again (${finding.recoveryAttempts} automatic ${finding.recoveryAttempts === 1 ? "attempt" : "attempts"} so far).`, at: now });
  }
  if (existing.occurrences !== finding.count && finding.count > existing.occurrences) {
    await log(ctx, { incidentId: existing._id, companyId: finding.companyId, kind: "recurred", words: `It now covers ${finding.count} ${finding.count === 1 ? "item" : "items"}.`, at: now });
  }
  return existing._id;
}

/** Closes an incident on evidence. A platform incident's children are left to their own checks. */
export async function resolve(ctx: MutationCtx, incident: Doc<"incidents">, resolution: { how: "verified" | "dismissed"; evidence: string; by?: Id<"staff"> }, now: number, actor: OpsActor = SYSTEM) {
  if (!incident.open) return;
  await ctx.db.patch(incident._id, { open: false, state: "resolved", resolvedAt: now, resolution: { how: resolution.how, evidence: resolution.evidence.slice(0, 500), ...(resolution.by ? { by: resolution.by } : {}) }, updatedAt: now });
  await log(ctx, {
    incidentId: incident._id,
    companyId: incident.companyId,
    kind: "resolved",
    words: resolution.how === "verified" ? "Resolved: Selestial checked again and it's working." : "Closed by Selestial staff.",
    detail: resolution.evidence,
    actor,
    at: now,
  });
}

/**
 * Applies one run of a check: findings up to date, and the check's other open incidents resolved when a
 * complete scan (or the check's own verification) shows the condition is gone.
 */
export async function applyRun(ctx: MutationCtx, check: Check, run: { findings: Finding[]; complete: boolean }, now: number) {
  const seen = new Set<string>();
  const groups = new Set<string>();
  for (const finding of run.findings) {
    seen.add(finding.key);
    if (finding.groupKey && finding.companyId) groups.add(finding.groupKey);
    await upsert(ctx, finding, now);
  }
  let resolved = 0;
  for (const kind of check.kinds) {
    const open = await ctx.db
      .query("incidents")
      .withIndex("by_open_kind", (q) => q.eq("open", true).eq("kind", kind))
      .take(500);
    for (const incident of open) {
      if (seen.has(incident.key)) continue;
      const verdict = check.verify ? await check.verify(ctx, incident, now) : "unknown";
      const fixed = verdict === "fixed" || (verdict === "unknown" && run.complete && windowless(incident));
      if (!fixed) continue;
      await resolve(ctx, incident, { how: "verified", evidence: `Check "${check.name}" ran at ${new Date(now).toISOString()} and no longer found this.${verdict === "fixed" ? " The record itself was read again and confirms it." : ""}` }, now);
      if (incident.groupKey) groups.add(incident.groupKey);
      resolved += 1;
    }
  }
  for (const groupKey of groups) await regroup(ctx, groupKey, now);
  return { found: run.findings.length, resolved };
}

/**
 * Kinds whose scan reads everything that could be wrong (not a time window): a complete scan not finding
 * them is evidence. Windowed kinds (failures in the last day) are only closed by their own verify.
 */
function windowless(incident: Doc<"incidents">): boolean {
  return !["agent.activation_failed", "agent.sales_failed", "agent.retention_failed", "billing.topup_failed"].includes(incident.kind);
}

const GROUP_TITLES: Record<string, string> = {
  "provider:google:auth": "Google authorizations ending for several companies",
  "provider:google:jobs": "Google updates failing for several companies",
  "provider:telnyx:unconfirmed": "Texts with unknown outcomes across several companies",
  "provider:telnyx:failures": "Texts failing for several companies",
  "provider:telnyx:registration": "Carriers pausing texting for several companies",
  "provider:telnyx:assignment": "Texting numbers slow to connect for several companies",
  "provider:autumn:unavailable": "Messaging billing unreachable for several companies",
  "provider:autumn:settlement": "Billing settlements retrying for several companies",
  "provider:email:notices": "Selestial's emails failing for several companies",
  "agent:sales_failed": "Sales work failing for several companies",
};

function groupTitle(groupKey: string): string {
  if (GROUP_TITLES[groupKey]) return GROUP_TITLES[groupKey];
  if (groupKey.startsWith("selestial:")) return `A Selestial recovery job (${groupKey.slice(10).replace(/_/g, " ")}) is behind for several companies`;
  const [, provider, what] = groupKey.split(":");
  return `${provider ?? "A provider"}: ${what ?? "problems"} across several companies`;
}

/** Three or more companies with one group key share a platform incident. Fewer than two close it. */
export async function regroup(ctx: MutationCtx, groupKey: string, now: number) {
  const children = (
    await ctx.db
      .query("incidents")
      .withIndex("by_group_open", (q) => q.eq("groupKey", groupKey).eq("open", true))
      .take(500)
  ).filter((row) => row.scope === "company");
  const companies = new Set(children.map((row) => row.companyId));
  const key = `platform:${groupKey}`;
  const parent = await openByKey(ctx, key);
  if (companies.size >= 3) {
    const id = await upsert(
      ctx,
      {
        key,
        kind: "platform.group",
        category: "platform",
        severity: "critical",
        state: children.some((c) => c.state === "needs_staff") ? "needs_staff" : children.every((c) => c.state === "recovering") ? "recovering" : "investigating",
        title: groupTitle(groupKey),
        impact: `${companies.size} companies are affected. Each company's own incident keeps what it means for them.`,
        done: "Each company's work is held the way its own incident says. Nothing was retried in a way that could repeat an action.",
        next: "Staff: confirm the provider's status, then work the company incidents; this closes when fewer than two remain.",
        diagnostics: `${children.length} open company incidents · kinds: ${[...new Set(children.map((c) => c.kind))].join(", ")}`,
        related: children.slice(0, 30).map((c) => ({ table: "incidents", id: c._id, label: c.title })),
        ownerVisible: false,
        count: companies.size,
        recoveryAttempts: children.reduce((sum, c) => sum + c.recoveryAttempts, 0),
      },
      now,
    );
    if (id) for (const child of children) if (child.parentId !== id) await ctx.db.patch(child._id, { parentId: id });
    return;
  }
  if (parent && companies.size < 2) {
    await resolve(ctx, parent, { how: "verified", evidence: `Only ${companies.size} ${companies.size === 1 ? "company is" : "companies are"} still affected; ${companies.size ? "that one is tracked on its own." : "every company incident closed."}` }, now);
  }
}

// ── Notices ───────────────────────────────────────────────────────────────────────────────────────

/** Whether the owner should hear about this incident now: they must act, or the interruption is material. */
export function ownerShouldHear(incident: Doc<"incidents">): boolean {
  if (!incident.open || !incident.ownerVisible || incident.notified.ownerAt !== undefined || !incident.companyId) return false;
  return incident.state === "waiting_owner" || (incident.severity === "high" && (incident.state === "waiting_provider" || incident.state === "needs_staff"));
}

/** Plans the owner notices this company is due: one email per hour at most, written when it goes. */
export async function planOwnerNotices(ctx: MutationCtx, companyId: Id<"companies">, now: number) {
  const company = await ctx.db.get(companyId);
  if (!company || company.suspendedAt !== undefined) return;
  const open = await ctx.db
    .query("incidents")
    .withIndex("by_company_open", (q) => q.eq("companyId", companyId).eq("open", true))
    .take(100);
  const bucket = String(Math.floor(now / HOUR));
  if (open.some(ownerShouldHear)) await notifyMembers(ctx, { companyId, event: "operations_attention", ref: companyId, key: bucket, now });
  const recent = await ctx.db
    .query("incidents")
    .withIndex("by_company_open", (q) => q.eq("companyId", companyId).eq("open", false).gte("lastSeenAt", now - 2 * 24 * HOUR))
    .take(100);
  if (recent.some((row) => row.ownerVisible && row.notified.ownerAt !== undefined && row.notified.recoveredAt === undefined && row.resolution?.how === "verified")) {
    await notifyMembers(ctx, { companyId, event: "operations_recovered", ref: companyId, key: bucket, now });
  }
}

/** Whether staff admins should be emailed about this incident. */
export function staffShouldHear(incident: Doc<"incidents">): boolean {
  if (!incident.open || incident.notified.staffAt !== undefined || incident.parentId) return false;
  return incident.severity === "critical" || (incident.severity === "high" && incident.state === "needs_staff");
}

export async function planStaffEmail(ctx: MutationCtx, now: number) {
  const open = await ctx.db
    .query("incidents")
    .withIndex("by_open_seen", (q) => q.eq("open", true))
    .take(500);
  if (!open.some(staffShouldHear)) return;
  // One email per half hour at most; the action reads what is still open when it runs.
  await ctx.scheduler.runAfter(0, internal.operations.emailStaff, { bucket: String(Math.floor(now / (30 * MINUTE))) });
}
