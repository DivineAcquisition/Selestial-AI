/**
 * Admin support sessions (docs/operations/03-support-sessions.md): a Selestial admin inside one
 * company's workspace for a short, recorded time, as themselves.
 *
 *  - supportSessions  one session: who, which company, why, View or Manage, until when
 *  - supportActions   append-only: start, mode changes, pages opened, every change made, refusals, end
 *
 * A session works through a `members` row with status "support" (one per company and staff member),
 * so the record's own rules, ids and wording apply unchanged: an event reads "Selestial Support updated
 * your booking settings". That row is never an active membership: it is accepted only on a request that
 * names a live session (convex/lib/support/access.ts).
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

import { literals } from "../statuses";
import { roleValidator } from "../roles";
import { staffCapabilityValidator } from "./capabilities";

export const SESSION_MODES = ["view", "manage"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];
export const sessionModeValidator = literals(SESSION_MODES);

/** Default and longest sessions. A Manage switch never extends the session. */
export const SESSION_MINUTES = { default: 30, max: 120, min: 10 } as const;
/** How fresh a sign-in, and its second factor, must be for Manage and sensitive actions. */
export const STRONG_MINUTES = 15;

export const supportTables = {
  supportSessions: defineTable({
    companyId: v.id("companies"),
    staffId: v.id("staff"),
    /** The members row the session acts through (status "support"). */
    memberId: v.id("members"),
    mode: sessionModeValidator,
    /** "View as": which company role's screens and reads to show. Never more authority than the session. */
    previewRole: roleValidator,
    reason: v.string(),
    /** A ticket or incident reference, as staff typed it. */
    reference: v.optional(v.string()),
    incidentId: v.optional(v.id("incidents")),
    startedAt: v.number(),
    expiresAt: v.number(),
    /** Set the moment the session stops working, for whatever reason. */
    endedAt: v.optional(v.number()),
    endReason: v.optional(literals(["exited", "expired", "revoked", "staff_removed"] as const)),
    manageReason: v.optional(v.string()),
    manageAt: v.optional(v.number()),
    /** When a strong check (fresh sign-in and second factor) last passed in this session. */
    verifiedAt: v.optional(v.number()),
    /** Changes made, for the owner's history and the completion summary. */
    changes: v.number(),
    notified: v.object({ manageAt: v.optional(v.number()), summaryAt: v.optional(v.number()) }),
  })
    .index("by_company_started", ["companyId", "startedAt"])
    .index("by_staff_started", ["staffId", "startedAt"])
    .index("by_ended_expires", ["endedAt", "expiresAt"])
    .index("by_started", ["startedAt"]),

  supportActions: defineTable({
    sessionId: v.id("supportSessions"),
    companyId: v.id("companies"),
    staffId: v.id("staff"),
    kind: literals(["started", "mode", "viewed", "changed", "refused", "external", "ended"] as const),
    /** Readable, for the owner: "Updated booking settings". */
    summary: v.string(),
    /** What changed, with secrets removed and long text cut (lib/support/redact.ts). Staff and owner see it. */
    detail: v.optional(v.string()),
    capability: v.optional(staffCapabilityValidator),
    at: v.number(),
  })
    .index("by_session_at", ["sessionId", "at"])
    .index("by_company_at", ["companyId", "at"]),
};
