/**
 * The onboarding case around a company's texting setup (docs/texting/02-case.md): the evidence that backs
 * what the owner says, the discussion with Selestial, the recommendations Selestial's checks make, the
 * exceptions staff track, and the versioned configuration of the forms themselves.
 *
 * Three things are kept visibly apart everywhere: a draft change (the owner's own setup), Selestial's
 * internal review (people at Selestial looked at it), and the carriers' review (Telnyx and the mobile
 * carriers decided). Nothing here can stand for the carriers' decision.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

import { agentValidator, literals } from "../statuses";
import { SETUP_STEPS } from "./schema";

// ── Evidence ───────────────────────────────────────────────────────────────────────────────────────

/** Where an evidence item stands in Selestial's own review. Never a carrier state. */
export const EVIDENCE_STATES = ["missing", "submitted", "under_review", "accepted_internal", "needs_replacement"] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

export const EVIDENCE_STATE_WORDS: Record<EvidenceState, string> = {
  missing: "Missing",
  submitted: "Added",
  under_review: "Under Selestial review",
  accepted_internal: "Accepted for Selestial review",
  needs_replacement: "Needs replacement",
};

/** What an item is for. Each one says what it proves; the owner can add their own words. */
export const EVIDENCE_PURPOSES = ["opt_in_screenshot", "opt_in_form", "business_document", "website_page", "policy_page", "correction_response", "other"] as const;
export type EvidencePurpose = (typeof EVIDENCE_PURPOSES)[number];

export const EVIDENCE_PURPOSE_WORDS: Record<EvidencePurpose, { label: string; proves: string }> = {
  opt_in_screenshot: { label: "Opt-in screenshot", proves: "Shows where and how people agree to texts, with the wording they see." },
  opt_in_form: { label: "Paper or offline opt-in form", proves: "Shows the wording people sign or tick outside a website." },
  business_document: { label: "Business document", proves: "Shows the legal name, address or tax registration matches what was entered." },
  website_page: { label: "Website page", proves: "Shows the business's website names the business and its services." },
  policy_page: { label: "Policy page", proves: "Shows the privacy policy or texting terms are public and say what carriers require." },
  correction_response: { label: "Answer to a correction", proves: "Shows the change Selestial or the carriers asked for was made." },
  other: { label: "Other", proves: "Supports the registration in the owner's own words." },
};

/** Who can see an item. Staff-only items are never returned to the company, exported or notified. */
export const VISIBILITIES = ["company", "internal"] as const;

export const evidenceLinkValidator = v.object({
  /** A business field, draft key or step name. */
  field: v.optional(v.string()),
  /** A place where permission is collected (PERMISSION_PLACES). */
  place: v.optional(v.string()),
  exceptionId: v.optional(v.id("textingExceptions")),
  /** The submission version it was filed with, once filed. */
  submissionVersion: v.optional(v.number()),
});

export const caseTables = {
  /**
   * One version of one evidence item. Items are grouped by `key`; replacing an item adds a new version and
   * marks the old one replaced, so a submission that referenced the old version still points at exactly
   * what was filed. A version referenced by a submission (`lockedIn`) is never changed or deleted.
   */
  textingEvidence: defineTable({
    companyId: v.id("companies"),
    setupId: v.id("textingSetups"),
    key: v.string(),
    version: v.number(),
    purpose: literals(EVIDENCE_PURPOSES),
    /** What this item proves, in the uploader's words. */
    describes: v.string(),
    kind: v.union(v.literal("file"), v.literal("url"), v.literal("placeholder")),
    file: v.optional(v.object({ storageId: v.id("_storage"), name: v.string(), contentType: v.string(), size: v.number(), sha256: v.optional(v.string()) })),
    url: v.optional(v.string()),
    links: evidenceLinkValidator,
    visibility: literals(VISIBILITIES),
    state: literals(EVIDENCE_STATES),
    stateNote: v.optional(v.string()),
    /** Who uploaded or asked for it: a member of the company, or staff (by staff id) outside a support session. */
    addedBy: v.union(v.object({ kind: v.literal("member"), memberId: v.id("members"), supportSessionId: v.optional(v.id("supportSessions")) }), v.object({ kind: v.literal("staff"), staffId: v.id("staff") })),
    addedAt: v.number(),
    reviewedBy: v.optional(v.id("staff")),
    reviewedAt: v.optional(v.number()),
    /** Submission versions that filed exactly this version. */
    lockedIn: v.array(v.number()),
    replacedAt: v.optional(v.number()),
    /**
     * A blank or redacted copy made for a reviewer outside Selestial. It is never the original: it points at
     * the original, carries the owner's statement that it holds no subscriber's name, signature or contact
     * details, and is only served publicly once both the owner approved exposure and Selestial accepted it.
     */
    reviewCopy: v.optional(
      v.object({
        of: v.id("textingEvidence"),
        exposure: v.union(v.literal("private"), v.literal("approved"), v.literal("withdrawn")),
        /** The owner's exact approval wording, when approved. */
        approval: v.optional(v.object({ wording: v.string(), by: v.id("members"), at: v.number() })),
        /** Unguessable path part for the public copy. Set only when approved. */
        token: v.optional(v.string()),
      }),
    ),
  })
    .index("by_company_key_version", ["companyId", "key", "version"])
    .index("by_setup_added", ["setupId", "addedAt"])
    .index("by_storage", ["file.storageId"])
    .index("by_token", ["reviewCopy.token"]),

  /**
   * Discussion on the case. `company` notes are seen by the owner and Selestial; `internal` notes only by
   * Selestial staff. Editing keeps every earlier wording; a note referenced by a submission is locked.
   */
  textingNotes: defineTable({
    companyId: v.id("companies"),
    setupId: v.id("textingSetups"),
    audience: literals(VISIBILITIES),
    body: v.string(),
    status: v.union(v.literal("draft"), v.literal("posted")),
    author: v.union(v.object({ kind: v.literal("member"), memberId: v.id("members"), supportSessionId: v.optional(v.id("supportSessions")), staffId: v.optional(v.id("staff")) }), v.object({ kind: v.literal("staff"), staffId: v.id("staff") })),
    links: evidenceLinkValidator,
    revisions: v.array(v.object({ body: v.string(), at: v.number() })),
    lockedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_setup_created", ["setupId", "createdAt"])
    .index("by_company_created", ["companyId", "createdAt"]),

  /**
   * One recommendation from a deterministic check (or, where an agent owns the work, under that agent's
   * name). Bound to the setup revision and a fingerprint of the facts it read: when those facts change it
   * goes stale, and an approval given on it no longer applies.
   */
  textingRecommendations: defineTable({
    companyId: v.id("companies"),
    setupId: v.id("textingSetups"),
    /** Rule and subject, so the same finding updates the same row. */
    key: v.string(),
    rule: v.string(),
    /** Who is responsible: a deterministic Selestial check, or an existing agent that owns the work. */
    responsible: v.union(v.object({ kind: v.literal("check") }), v.object({ kind: v.literal("agent"), agent: agentValidator })),
    stage: literals(SETUP_STEPS),
    field: v.optional(v.string()),
    issue: v.string(),
    /** The rule or evidence it rests on. */
    basisWords: v.string(),
    proposal: v.union(
      v.object({ kind: v.literal("draft_text"), draftKey: v.string(), text: v.string() }),
      v.object({ kind: v.literal("confirm_field"), field: v.string() }),
      v.object({ kind: v.literal("add_evidence"), purpose: literals(EVIDENCE_PURPOSES), place: v.optional(v.string()) }),
      v.object({ kind: v.literal("review_copy"), evidenceId: v.id("textingEvidence") }),
      v.object({ kind: v.literal("open_step"), step: literals(SETUP_STEPS) }),
      v.object({ kind: v.literal("start_correction") }),
    ),
    proposalWords: v.string(),
    effect: v.string(),
    approval: v.union(v.literal("none"), v.literal("owner"), v.literal("owner_and_charges")),
    status: v.union(v.literal("open"), v.literal("applied"), v.literal("dismissed"), v.literal("clarification"), v.literal("approved"), v.literal("stale"), v.literal("resolved")),
    nextAction: v.string(),
    /** The setup revision and fingerprint of what was read when this was made. */
    revision: v.number(),
    fingerprint: v.string(),
    /** An owner's approval of exactly this proposal, at exactly this fingerprint. */
    approvedAt: v.optional(v.number()),
    approvedBy: v.optional(v.id("members")),
    clarification: v.optional(v.object({ question: v.string(), at: v.number(), by: v.id("members") })),
    decidedAt: v.optional(v.number()),
    decidedBy: v.optional(v.id("members")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_setup_key", ["setupId", "key"])
    .index("by_setup_status", ["setupId", "status"])
    .index("by_company_updated", ["companyId", "updatedAt"]),

  /**
   * An onboarding exception: something staff track on the case until it is resolved. It extends the
   * request's own states (a blocking correction also puts the request in "needs you", which the operations
   * detectors already raise as an incident) instead of being a second ticket system.
   */
  textingExceptions: defineTable({
    companyId: v.id("companies"),
    setupId: v.id("textingSetups"),
    requestId: v.optional(v.id("textingRequests")),
    category: v.union(
      v.literal("business_details"),
      v.literal("consent_evidence"),
      v.literal("policy_pages"),
      v.literal("number"),
      v.literal("number_port"),
      v.literal("toll_free"),
      v.literal("carrier_correction"),
      v.literal("other"),
    ),
    severity: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    field: v.optional(v.string()),
    evidenceKey: v.optional(v.string()),
    submissionVersion: v.optional(v.number()),
    assignee: v.union(v.object({ kind: v.literal("staff"), staffId: v.optional(v.id("staff")) }), v.object({ kind: v.literal("agent"), agent: agentValidator }), v.object({ kind: v.literal("owner") })),
    /** Staff only. Never returned to the company. */
    internalWords: v.optional(v.string()),
    /** What the owner reads. */
    ownerWords: v.string(),
    /** What Selestial asks the owner for, answered in the same place. */
    ask: v.optional(v.object({ kind: v.union(v.literal("correction"), v.literal("evidence"), v.literal("information")), field: v.optional(v.string()), purpose: v.optional(literals(EVIDENCE_PURPOSES)) })),
    response: v.optional(v.object({ words: v.string(), evidenceKey: v.optional(v.string()), at: v.number(), by: v.id("members") })),
    blocker: v.string(),
    /** What the business can keep doing meanwhile. */
    canContinue: v.string(),
    nextAction: v.string(),
    followUpAt: v.optional(v.number()),
    state: v.union(v.literal("waiting_owner"), v.literal("waiting_selestial"), v.literal("waiting_provider"), v.literal("resolved")),
    /** Assisted routes (port, toll-free): what the owner asked for, kept as they wrote it. */
    assisted: v.optional(v.object({ route: v.union(v.literal("port_existing"), v.literal("toll_free")), phoneNumber: v.optional(v.string()), carrier: v.optional(v.string()), words: v.optional(v.string()) })),
    resolution: v.optional(v.string()),
    history: v.array(v.object({ at: v.number(), state: v.string(), words: v.string(), by: v.string() })),
    reopened: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_setup_updated", ["setupId", "updatedAt"])
    .index("by_company_updated", ["companyId", "updatedAt"])
    .index("by_state_follow", ["state", "followUpAt"]),

  /**
   * A version of the forms' configuration (convex/lib/texting/config.ts). Only approved shapes and rule
   * types; never code. A version is drafted, validated, then published with an effective time; publishing
   * never changes a submitted record, which keeps the version it was submitted under.
   */
  textingConfigVersions: defineTable({
    version: v.number(),
    status: v.union(v.literal("draft"), v.literal("validated"), v.literal("published"), v.literal("retired")),
    /** The configuration itself, as JSON text checked against the constrained schema on every change. */
    body: v.string(),
    reason: v.string(),
    author: v.id("staff"),
    reviewer: v.optional(v.id("staff")),
    /** The version this was copied from (for a rollback, the earlier version restored). */
    basedOn: v.optional(v.number()),
    validation: v.optional(v.object({ ok: v.boolean(), problems: v.array(v.string()), needsReview: v.boolean(), at: v.number() })),
    effectiveAt: v.optional(v.number()),
    publishedAt: v.optional(v.number()),
    retiredAt: v.optional(v.number()),
    /** How many unfinished setups the publish reopened tasks on. */
    affected: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_version", ["version"])
    .index("by_status", ["status", "version"]),

  /** One person's place in one tutorial's written steps, so they can resume. Nothing about their files. */
  tutorialProgress: defineTable({
    companyId: v.id("companies"),
    memberId: v.id("members"),
    tutorialId: v.string(),
    contentVersion: v.number(),
    done: v.array(v.number()),
    completedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_member_tutorial", ["memberId", "tutorialId"])
    .index("by_company_member", ["companyId", "memberId"]),
};

export const NUMBER_ROUTES = ["new_local", "port_existing", "toll_free"] as const;
export type NumberRoute = (typeof NUMBER_ROUTES)[number];
