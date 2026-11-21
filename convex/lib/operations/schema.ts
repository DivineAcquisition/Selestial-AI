/**
 * Operations: what Selestial tracks when its own recovery runs out (docs/operations/01-recovery.md).
 *
 * Not a second retry system. Every workflow keeps its own leases, retries and sweeps. The monitor
 * (convex/operations.ts) reads their durable state on a schedule and turns what needs a person into one
 * incident per problem, deduplicated by key, grouped under a platform incident when one provider is
 * failing for several companies.
 *
 *  - incidents       one problem worth tracking: who it affects, what is blocked, who acts next
 *  - opsLog          append-only: what the monitor, staff and owners did about it, in order
 *  - monitorChecks   one row per check: when it last ran and last succeeded, so a stopped monitor shows
 *  - opsSignals      small facts code paths report that no record keeps (an inbound text to no company)
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

import { literals } from "../statuses";

export const INCIDENT_STATES = ["investigating", "recovering", "waiting_owner", "waiting_provider", "needs_staff", "resolved"] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];
export const incidentStateValidator = literals(INCIDENT_STATES);

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severityValidator = literals(SEVERITIES);

export const CATEGORIES = ["agent_work", "communications", "connections", "billing", "platform"] as const;
export type Category = (typeof CATEGORIES)[number];
export const categoryValidator = literals(CATEGORIES);

/**
 * The one thing an owner can do about it. Every kind either opens the exact page where it is done (href)
 * or runs a real operation (convex/operations.ts ownerAct). Nothing here is decorative.
 */
export const ACTION_KINDS = ["reconnect", "update_information", "add_funds", "review", "retry", "pause_agent", "contact_support"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const actionValidator = v.object({ kind: literals(ACTION_KINDS), label: v.string(), href: v.optional(v.string()) });
export type IncidentAction = typeof actionValidator.type;

export const relatedValidator = v.object({ table: v.string(), id: v.string(), label: v.string() });
export type Related = typeof relatedValidator.type;

export const opsActorValidator = v.union(
  v.object({ kind: v.literal("system") }),
  v.object({ kind: v.literal("staff"), staffId: v.id("staff"), sessionId: v.optional(v.id("supportSessions")) }),
  v.object({ kind: v.literal("member"), memberId: v.id("members") }),
);
export type OpsActor = typeof opsActorValidator.type;

export const LOG_KINDS = ["detected", "recurred", "state", "recovery", "recovered", "resolved", "reopened", "assigned", "note", "staff_action", "owner_action", "notified", "support_requested", "suspension"] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export const operationsTables = {
  incidents: defineTable({
    /** Absent only for a platform incident, which groups company incidents (each keeps its own impact). */
    companyId: v.optional(v.id("companies")),
    scope: literals(["company", "platform"] as const),
    parentId: v.optional(v.id("incidents")),
    /** Dedupe: the same problem keeps one open incident. For example "connections.mailbox:<id>". */
    key: v.string(),
    /** The check that found it (convex/lib/operations/checks.ts). */
    kind: v.string(),
    /** Platform grouping: company incidents with the same group key and several companies share a parent. */
    groupKey: v.optional(v.string()),
    category: categoryValidator,
    severity: severityValidator,
    state: incidentStateValidator,
    /** Owner words. No provider codes, no ids. */
    title: v.string(),
    /** What is affected and what is blocked, in business words. */
    impact: v.string(),
    /** What Selestial has already done. */
    done: v.string(),
    action: v.optional(actionValidator),
    /** Who acts next and what they do, for staff. */
    next: v.string(),
    /** Staff diagnostics: provider codes, the record's own problem text, counts. Never shown to owners. */
    diagnostics: v.optional(v.string()),
    related: v.array(relatedValidator),
    ownerVisible: v.boolean(),
    open: v.boolean(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    /** How many records it covers now (messages waiting, runs failed); for a platform incident, companies. */
    occurrences: v.number(),
    /** Automatic recovery attempts, read from the records themselves plus the monitor's own. */
    recoveryAttempts: v.number(),
    lastRecoveryAt: v.optional(v.number()),
    assignedTo: v.optional(v.id("staff")),
    /** Set when the owner asked for help from the card: the support handoff exists. */
    supportRequestedAt: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
    resolution: v.optional(
      v.object({
        how: literals(["verified", "dismissed"] as const),
        evidence: v.string(),
        by: v.optional(v.id("staff")),
      }),
    ),
    /** Each notice once: the owner told action is needed, told it recovered; staff told it's critical. */
    notified: v.object({ ownerAt: v.optional(v.number()), recoveredAt: v.optional(v.number()), staffAt: v.optional(v.number()) }),
    updatedAt: v.number(),
  })
    .index("by_key_open", ["key", "open"])
    .index("by_open_seen", ["open", "lastSeenAt"])
    .index("by_open_kind", ["open", "kind"])
    .index("by_company_open", ["companyId", "open", "lastSeenAt"])
    .index("by_parent", ["parentId"])
    .index("by_group_open", ["groupKey", "open"])
    .index("by_open_resolved", ["open", "resolvedAt"]),

  opsLog: defineTable({
    incidentId: v.optional(v.id("incidents")),
    companyId: v.optional(v.id("companies")),
    kind: literals(LOG_KINDS),
    /** Words an owner may read (shown on their card when the incident is owner-visible). */
    words: v.string(),
    /** Staff-only detail. */
    detail: v.optional(v.string()),
    actor: opsActorValidator,
    at: v.number(),
  })
    .index("by_incident_at", ["incidentId", "at"])
    .index("by_at", ["at"])
    .index("by_company_at", ["companyId", "at"]),

  monitorChecks: defineTable({
    name: v.string(),
    /** How often it is meant to run; a check older than three of these reads "stale". */
    everyMs: v.number(),
    lastRunAt: v.number(),
    lastOkAt: v.optional(v.number()),
    durationMs: v.number(),
    /** Findings in its last run. */
    found: v.number(),
    /** Whether the last scan read everything it covers (a truncated scan never resolves anything). */
    complete: v.boolean(),
    error: v.optional(v.string()),
  }).index("by_name", ["name"]),

  opsSignals: defineTable({
    companyId: v.optional(v.id("companies")),
    kind: literals(["inbound_unknown_number", "inbound_bad_number", "notice_email_failed"] as const),
    /** Small facts only: a masked number, a count. Never message text. */
    detail: v.string(),
    at: v.number(),
  })
    .index("by_kind_at", ["kind", "at"])
    .index("by_company_at", ["companyId", "at"]),
};
