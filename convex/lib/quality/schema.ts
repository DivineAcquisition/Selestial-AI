/**
 * The Quality agent: make the company's service promise measurable, find where delivery fell short, and
 * help the business improve with every completed job.
 *
 * Quality owns the assessment, not the records it reads. Jobs, checklists, photos, crew reports, messages,
 * Retention's cases and remedies, Finance's money and Dispatch's visits stay where they live; these tables
 * point at them by id and keep what Quality itself concluded, asked for, or was told.
 *
 *  - qualityStandards: versioned, configurable standards (company, service, account, property, visit).
 *  - qualityReviews: one visit's review against the standard that applied, with the standard snapshotted.
 *  - qualityCases: one quality investigation, kept apart from its findings, its remedy and the customer's answer.
 *  - qualityFindings: what the evidence supports, each with sources, conflicts, gaps, and who reviewed it.
 *  - qualityEntries: a case's timeline, each line with what it rests on.
 *  - qualityEvidence: references pinned to a case (and preserved for a serious incident).
 *  - qualityRequests / qualitySubmissions / qualityFiles: private-link requests for an account, an answer
 *    or evidence, and what came back, versioned and never overwritten.
 *  - qualityCorrections: Quality's scope and acceptance criteria for a correction Retention arranges and
 *    Dispatch staffs, and Quality's own verification of the work.
 *  - qualityImprovements: proposed changes from reviewed patterns, published only through approval.
 *  - qualityRuns: durable background work with idempotency keys, leases, bounded retries and blocked states.
 *  - qualityConnections / qualityComms / qualityExtracts / qualityAssociations: communications Quality reads
 *    from a connected phone platform (Quo), each kept with provenance, and the review queue that links a
 *    conversation to a visit only on evidence, never on a name or a lone phone match.
 *
 * Distinctions kept everywhere: a complaint is a reported concern, not a finding; documentation complete is
 * not service quality; a photo shows a limited view; missing information is uncertainty, not misconduct;
 * completed corrective work is not customer-confirmed satisfaction; a recommendation is not a policy; a
 * queued action is not a delivered message.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

import { actorValidator } from "../events";
import { literals } from "../statuses";

// ── Shared shapes ────────────────────────────────────────────────────────────────────────────────

/** A record a statement came from, so a person can open it. The id is the proof; the label is words. */
export const qualitySourceValidator = v.object({ table: v.string(), id: v.string(), label: v.string(), at: v.optional(v.number()) });
export type QualitySource = typeof qualitySourceValidator.type;

/** What a line rests on. "missing" is a statement about what the record does not hold. */
export const EVIDENCE_BASES = ["fact", "customer_stated", "cleaner_stated", "provider_summary", "analysis", "missing"] as const;
export type EvidenceBasis = (typeof EVIDENCE_BASES)[number];

// ── Standards ────────────────────────────────────────────────────────────────────────────────────

/** From least to most specific. A more specific level adds, replaces (same id) or waives a requirement. */
export const STANDARD_LEVELS = ["company", "service", "account", "property", "visit"] as const;
export type StandardLevel = (typeof STANDARD_LEVELS)[number];

export const REQUIREMENT_KINDS = ["checklist_completion", "required_evidence", "guide_acknowledgment", "inspection", "site_confirmation", "document", "timing"] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export const RESPONSIBLE = ["crew", "crew_lead", "office", "owner", "customer"] as const;
export const PHASES = ["before", "during", "completion", "after"] as const;
export type Phase = (typeof PHASES)[number];

export const requirementValidator = v.object({
  /** Stable within a standard's history, so a more specific level can replace or waive it. Lowercase slug. */
  id: v.string(),
  kind: literals(REQUIREMENT_KINDS),
  label: v.string(),
  /** Required gaps hold a review for a person; advisory gaps are noted and never block anything. */
  level: v.union(v.literal("required"), v.literal("advisory")),
  responsible: literals(RESPONSIBLE),
  phase: literals(PHASES),
  /** When it applies. Absent fields mean "always". */
  when: v.optional(
    v.object({
      services: v.optional(v.array(v.string())),
      propertyKinds: v.optional(v.array(v.string())),
      firstVisitOnly: v.optional(v.boolean()),
      recurringOnly: v.optional(v.boolean()),
      /** Inspection frequency: every Nth completed visit at the property. */
      everyNthVisit: v.optional(v.number()),
    }),
  ),
  /** What counts as evidence for it. */
  evidence: v.optional(
    v.object({
      photoKind: v.optional(v.union(v.literal("before"), v.literal("after"), v.literal("item"), v.literal("issue"))),
      minPhotos: v.optional(v.number()),
      /** Checklist labels (matched without regard to case) that must be done, not skipped. Absent: every item. */
      checklistLabels: v.optional(v.array(v.string())),
      /** A readable guide or document by name, for acknowledgment or certificate requirements. */
      documentName: v.optional(v.string()),
      /** Timing: minutes after the scheduled start the crew must have checked in by; or minutes before a hard deadline to finish. */
      checkInWithinMinutes: v.optional(v.number()),
      finishBeforeDeadlineMinutes: v.optional(v.number()),
    }),
  ),
  /** Hours after the visit's end before an unmet required item is escalated to the responsible person's manager. */
  escalateAfterHours: v.optional(v.number()),
  approval: v.optional(v.union(v.literal("none"), v.literal("manager"), v.literal("owner"))),
  note: v.optional(v.string()),
  /** Only on a more specific level: this requirement does not apply here, and why. */
  waived: v.optional(v.object({ reason: v.string() })),
});
export type Requirement = typeof requirementValidator.type;

/** What the company says it does when a visit falls short. Its words; absent means not set, never invented. */
export const remedyPolicyValidator = v.object({
  guaranteeDays: v.optional(v.number()),
  guaranteeText: v.optional(v.string()),
  /** What Quality proposes first when a correction fits. */
  correctionScope: v.optional(v.union(v.literal("targeted_first"), v.literal("full"), v.literal("decide_each_time"))),
  /** How a correction's work is verified before Quality calls it verified. */
  verifyBy: v.optional(v.union(v.literal("record_and_photos"), v.literal("inspection"), v.literal("record_only"))),
  /** Whether the customer is asked to confirm a correction (Retention asks). */
  askCustomer: v.optional(v.boolean()),
});

export const STANDARD_TEMPLATES = ["residential_one_time", "residential_recurring", "deep_move_out", "commercial", "office", "str_turnover"] as const;
export type StandardTemplate = (typeof STANDARD_TEMPLATES)[number];

// ── Reviews ──────────────────────────────────────────────────────────────────────────────────────

export const REVIEW_STATUSES = ["queued", "ready", "waiting_on_evidence", "needs_decision", "approved", "case_opened", "superseded", "not_reviewed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REQUIREMENT_OUTCOMES = ["met", "missing", "contradictory", "unverifiable", "not_applicable", "waived"] as const;
export type RequirementOutcome = (typeof REQUIREMENT_OUTCOMES)[number];

/** Where a requirement came from. No standard id (version 0) means the company's rules already on record. */
export const appliedFromValidator = v.object({ standardId: v.optional(v.id("qualityStandards")), level: literals(STANDARD_LEVELS), version: v.number(), name: v.string() });

export const appliedRequirementValidator = v.object({ requirement: requirementValidator, from: appliedFromValidator });
export type AppliedRequirement = typeof appliedRequirementValidator.type;

export const requirementResultValidator = v.object({
  requirementId: v.string(),
  label: v.string(),
  level: v.union(v.literal("required"), v.literal("advisory")),
  responsible: literals(RESPONSIBLE),
  outcome: literals(REQUIREMENT_OUTCOMES),
  detail: v.string(),
  sources: v.array(qualitySourceValidator),
  from: v.optional(appliedFromValidator),
});
export type RequirementResult = typeof requirementResultValidator.type;

export const RECOMMENDATIONS = ["approve", "request_information", "correct", "investigate"] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

// ── Cases and findings ───────────────────────────────────────────────────────────────────────────

export const CASE_STAGES = ["needs_context", "investigating", "needs_decision", "action_underway", "verifying", "closed"] as const;
export type CaseStage = (typeof CASE_STAGES)[number];

export const CASE_ORIGINS = ["customer_feedback", "call", "sms", "email", "cleaner_report", "owner_report", "completion_review", "pattern", "retention_case"] as const;
export type CaseOrigin = (typeof CASE_ORIGINS)[number];

export const FINDING_CATEGORIES = [
  "service_miss",
  "scope_misunderstanding",
  "access_limitation",
  "equipment_limitation",
  "scheduling_failure",
  "insufficient_evidence",
  "no_issue_established",
  "serious_incident",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_STATES = ["suggested", "reviewed", "rejected", "superseded"] as const;

/** How a case closed. None of these says a customer is satisfied: that is Retention's, read from its case. */
export const CASE_CLOSURES = [
  "findings_recorded",
  "correction_verified",
  "correction_not_verified",
  "no_issue_established",
  "insufficient_evidence",
  "handled_by_person",
  "duplicate",
  "serious_decided",
] as const;
export type CaseClosure = (typeof CASE_CLOSURES)[number];

// ── Requests ─────────────────────────────────────────────────────────────────────────────────────

export const REQUEST_PURPOSES = ["missing_evidence", "question", "statement", "supplement", "correction_outcome"] as const;
export type RequestPurpose = (typeof REQUEST_PURPOSES)[number];

/**
 * prepared: written, nothing sent. awaiting_approval: in the approvals queue. sent: handed to the sender
 * (delivery is the message's own state). answered: something came back. satisfied: what was asked for
 * arrived another way, so the request closed. unanswered: past due with no reply, which is never read as
 * an admission. handed_to_retention: a customer question Retention owns.
 */
export const REQUEST_STATUSES = ["prepared", "awaiting_approval", "sent", "answered", "satisfied", "unanswered", "expired", "revoked", "cancelled", "blocked", "handed_to_retention"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const recipientValidator = v.union(v.object({ kind: v.literal("cleaner"), cleanerId: v.id("cleaners") }), v.object({ kind: v.literal("customer"), customerId: v.id("customers") }));
export type Recipient = typeof recipientValidator.type;

/** What a link may do. The page offers exactly these. */
export const LINK_ACTIONS = ["save_draft", "submit", "upload", "confirm_outcome"] as const;

// ── Corrections ──────────────────────────────────────────────────────────────────────────────────

/**
 * Kept apart on purpose; none of them is "resolved". The money, the visit and the customer conversation
 * live in Finance, Dispatch and Retention; this is what Quality knows of each, read back from them.
 */
export const CORRECTION_STATES = ["proposed", "approved", "scheduled", "crew_accepted", "completed", "quality_verified", "verification_failed", "cancelled", "blocked"] as const;
export type CorrectionState = (typeof CORRECTION_STATES)[number];
export const CUSTOMER_ANSWERS = ["not_asked", "asked", "confirmed", "dissatisfied", "no_response"] as const;
export type CustomerAnswer = (typeof CUSTOMER_ANSWERS)[number];

// ── Improvements ─────────────────────────────────────────────────────────────────────────────────

export const IMPROVEMENT_KINDS = ["checklist_change", "booking_question", "scope_exclusion", "property_instruction", "training", "equipment", "inspection_frequency", "scheduling_assumption"] as const;
export type ImprovementKind = (typeof IMPROVEMENT_KINDS)[number];
export const IMPROVEMENT_STATES = ["proposed", "awaiting_approval", "approved", "declined", "adopted", "evaluated", "withdrawn"] as const;
/** Who carries out an approved change. Quality proposes; the owner of the record changes it. */
export const IMPROVEMENT_OWNERS = ["quality", "sales", "dispatch", "recruiter", "owner"] as const;

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────────

/** The events Quality reacts to, each a run named by an idempotency key (docs/quality/00-architecture.md). */
export const RUN_KINDS = [
  "completion_submitted",
  "evidence_added",
  "message_received",
  "transcript_available",
  "feedback_submitted",
  "statement_submitted",
  "remedy_approved",
  "correction_completed",
  "financial_settled",
  "case_outcome",
  "pre_service",
  "comms_sync",
  "upkeep",
  "pattern_scan",
  "interpret",
] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = ["queued", "running", "done", "skipped", "blocked", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// ── Communications ───────────────────────────────────────────────────────────────────────────────

export const COMM_PROVIDERS = ["quo", "highlevel"] as const;
export const commProviderValidator = literals(COMM_PROVIDERS);
export const COMM_KINDS = ["call", "sms", "voicemail", "email"] as const;
export const TRANSCRIPT_STATES = ["absent", "in_progress", "completed", "failed", "not_available"] as const;

/** Each one is checked against the provider, never assumed. "unknown" until checked. */
export const capabilityStateValidator = v.union(v.literal("available"), v.literal("unavailable"), v.literal("unknown"), v.literal("not_used"));
export const capabilitiesValidator = v.object({
  readMessages: capabilityStateValidator,
  readThreads: capabilityStateValidator,
  readCallMetadata: capabilityStateValidator,
  readTranscripts: capabilityStateValidator,
  readSummaries: capabilityStateValidator,
  /** Selestial never copies recordings: their status and length are read, never the audio. */
  recordings: capabilityStateValidator,
  webhooks: capabilityStateValidator,
  /** Quality does not send through a phone platform it reads. Messages go through the company's own sender. */
  send: capabilityStateValidator,
});

export const ASSOCIATION_METHODS = ["explicit_reference", "thread_association", "verified_relationship", "person"] as const;

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────

/** What the company told Quality about how it works. Absent values mean "not set". */
export const qualitySettingsValidator = v.object({
  /** Days a request link stays open. */
  linkDays: v.optional(v.number()),
  /** Hours a cleaner has to answer an evidence request before it is due. */
  cleanerAnswerHours: v.optional(v.number()),
  /** Minutes Quality waits after a completion before asking, so related gaps go in one request. */
  combineMinutes: v.optional(v.number()),
  /** Most requests to one person about one visit. Beyond it a person decides. */
  maxRequestsPerVisit: v.optional(v.number()),
  /** Read calls and texts from a connected phone platform for quality evidence. Off until the Owner turns it on. */
  readPhonePlatform: v.optional(v.boolean()),
  /** Ask an AI reader to suggest findings and a plain summary, when one is connected and priced. Credits are held first. Off until the Owner turns it on. */
  reader: v.optional(v.boolean()),
  /** Days a closed case's preserved evidence is kept before the company's ordinary deletion applies. Absent: the company's ordinary rules. */
  preserveDays: v.optional(v.number()),
  /** Minimum reviewed cases before a pattern is proposed as an improvement. */
  patternMinimum: v.optional(v.number()),
});
export type QualitySettingsInput = typeof qualitySettingsValidator.type;

// ── Tables ───────────────────────────────────────────────────────────────────────────────────────

export const qualityTables = {
  qualityStandards: defineTable({
    companyId: v.id("companies"),
    level: literals(STANDARD_LEVELS),
    /** Names the standard's history: "company", "service:<key>", "account:<id>", "property:<id>", "visit:<id>". */
    key: v.string(),
    serviceKey: v.optional(v.string()),
    customerId: v.optional(v.id("customers")),
    propertyId: v.optional(v.id("properties")),
    jobId: v.optional(v.id("jobs")),
    version: v.number(),
    /** draft: being written. published: in force from publishedAt. superseded: a later version took over. retired: stopped. */
    status: v.union(v.literal("draft"), v.literal("published"), v.literal("superseded"), v.literal("retired")),
    name: v.string(),
    template: v.optional(literals(STANDARD_TEMPLATES)),
    requirements: v.array(requirementValidator),
    remedy: v.optional(remedyPolicyValidator),
    /** A visit exception is agreed with someone, and says where that agreement is recorded. */
    agreement: v.optional(v.object({ with: v.union(v.literal("customer"), v.literal("office")), note: v.string(), source: v.optional(qualitySourceValidator) })),
    changeNote: v.optional(v.string()),
    createdBy: actorValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
    publishedBy: v.optional(v.id("members")),
    publishedAt: v.optional(v.number()),
    /** When a later version or a retirement ended this one. A visit before then still reads this version. */
    endedAt: v.optional(v.number()),
  })
    .index("by_company_key_version", ["companyId", "key", "version"])
    .index("by_company_status", ["companyId", "status", "updatedAt"])
    .index("by_company_level", ["companyId", "level", "updatedAt"]),

  qualityReviews: defineTable({
    companyId: v.id("companies"),
    jobId: v.id("jobs"),
    customerId: v.id("customers"),
    propertyId: v.id("properties"),
    /** One review per completion round: a report sent back and submitted again is a new round. */
    round: v.number(),
    key: v.string(),
    status: literals(REVIEW_STATUSES),
    /** The standard that applied, resolved once and kept: a later edit never redefines this visit. */
    standard: v.object({
      asOf: v.number(),
      resolvedAt: v.number(),
      sources: v.array(appliedFromValidator),
      requirements: v.array(appliedRequirementValidator),
      waived: v.array(v.object({ requirementId: v.string(), label: v.string(), reason: v.string(), from: appliedFromValidator })),
    }),
    results: v.array(requirementResultValidator),
    completeness: v.object({ required: v.number(), met: v.number(), missing: v.number(), contradictory: v.number(), unverifiable: v.number(), advisoryGaps: v.number() }),
    flags: v.array(v.object({ code: v.string(), text: v.string(), sources: v.array(qualitySourceValidator) })),
    recommendation: v.optional(literals(RECOMMENDATIONS)),
    /** "rules", or a reader's name when one added an interpretation. */
    recommendedBy: v.optional(v.string()),
    summary: v.string(),
    /** What the run actually did, for "What I checked", "What I found", "What happens next". */
    checked: v.array(v.string()),
    found: v.array(v.string()),
    next: v.array(v.string()),
    /** The evidence as it was read, as one string. Unchanged evidence is not read (or billed) again. */
    evidenceStamp: v.string(),
    caseId: v.optional(v.id("qualityCases")),
    decision: v.optional(v.object({ outcome: v.union(v.literal("approved"), v.literal("requested_information"), v.literal("opened_case"), v.literal("no_action")), by: v.id("members"), at: v.number(), note: v.optional(v.string()) })),
    /** Something arrived after the visit (a late transcript, a message) that reopened the quality question. The visit still happened. */
    reopened: v.optional(v.object({ at: v.number(), reason: v.string(), source: v.optional(qualitySourceValidator) })),
    /** Whether the agent's follow-ups (requests, a case) ran for this evidence; a person's own review records only. */
    acted: v.optional(v.boolean()),
    /** An imported, historical visit: reviewed for the record, never a reason to contact anyone. */
    historical: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_company_job", ["companyId", "jobId", "round"])
    .index("by_company_key", ["companyId", "key"])
    .index("by_company_status", ["companyId", "status", "updatedAt"])
    .index("by_company_property", ["companyId", "propertyId", "createdAt"]),

  qualityCases: defineTable({
    companyId: v.id("companies"),
    key: v.string(),
    stage: literals(CASE_STAGES),
    origin: literals(CASE_ORIGINS),
    originRef: v.optional(qualitySourceValidator),
    title: v.string(),
    /** One sentence each, rewritten as the case moves: what was reported, what Quality is doing, what needs a person. */
    happened: v.string(),
    doing: v.string(),
    needs: v.optional(v.string()),
    jobId: v.optional(v.id("jobs")),
    customerId: v.optional(v.id("customers")),
    propertyId: v.optional(v.id("properties")),
    /** The crew on the visit, from its assignments. Being on a visit is not being at fault. */
    cleanerIds: v.array(v.id("cleaners")),
    reviewId: v.optional(v.id("qualityReviews")),
    /** The recovery episode Retention owns. Quality never opens a second conversation with the customer. */
    retentionCaseId: v.optional(v.id("retentionCases")),
    /** The words of the report, untrusted: shown as text, never treated as an instruction. */
    reportWords: v.optional(v.string()),
    areas: v.array(v.string()),
    urgency: v.union(v.literal("urgent"), v.literal("normal"), v.literal("low")),
    ownerId: v.optional(v.id("members")),
    /** Explicit flags, each with who owns them. */
    escalated: v.optional(v.object({ at: v.number(), by: actorValidator, reason: v.string(), toMemberId: v.optional(v.id("members")) })),
    heldBy: v.optional(v.object({ memberId: v.id("members"), since: v.number() })),
    /** Safety, damage, theft, injury or conduct. Restricted, escalated at once, evidence preserved, and decided by a person. */
    serious: v.optional(
      v.object({
        reason: v.string(),
        at: v.number(),
        preservedAt: v.optional(v.number()),
        decision: v.optional(v.object({ memberId: v.id("members"), at: v.number(), text: v.string(), continueOperations: v.boolean() })),
      }),
    ),
    /** Owners only, once set. It is never switched off. */
    restricted: v.boolean(),
    outcome: v.optional(v.object({ code: literals(CASE_CLOSURES), note: v.optional(v.string()), by: actorValidator, at: v.number() })),
    historical: v.optional(v.boolean()),
    dueAt: v.number(),
    taskId: v.optional(v.id("tasks")),
    /** Counts changes, so anything prepared against an older state is recognised as stale. */
    revision: v.number(),
    /** First time a person or the agent did something on it, for "time to first action". */
    firstActionAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    closedAt: v.optional(v.number()),
  })
    .index("by_company_key", ["companyId", "key"])
    .index("by_company_stage", ["companyId", "stage", "dueAt"])
    .index("by_company_job", ["companyId", "jobId"])
    .index("by_company_customer", ["companyId", "customerId", "createdAt"])
    .index("by_company_property", ["companyId", "propertyId", "createdAt"])
    .index("by_company_retention", ["companyId", "retentionCaseId"])
    .index("by_company_created", ["companyId", "createdAt"]),

  qualityFindings: defineTable({
    companyId: v.id("companies"),
    caseId: v.id("qualityCases"),
    category: literals(FINDING_CATEGORIES),
    /** One sentence that only says what the sources support. Never a verdict on a person. */
    statement: v.string(),
    areas: v.array(v.string()),
    state: literals(FINDING_STATES),
    supporting: v.array(qualitySourceValidator),
    conflicting: v.array(v.object({ text: v.string(), source: v.optional(qualitySourceValidator) })),
    missing: v.array(v.string()),
    /** "rules", "person", or a reader's name. A reader's finding is a suggestion until a person reviews it. */
    suggestedBy: v.string(),
    reviewedBy: v.optional(v.id("members")),
    reviewedAt: v.optional(v.number()),
    revision: v.number(),
    history: v.array(v.object({ at: v.number(), by: actorValidator, change: v.string(), statement: v.optional(v.string()), category: v.optional(literals(FINDING_CATEGORIES)), state: v.optional(literals(FINDING_STATES)) })),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_company_case", ["companyId", "caseId", "createdAt"])
    .index("by_company_category", ["companyId", "category", "updatedAt"]),

  qualityEntries: defineTable({
    companyId: v.id("companies"),
    caseId: v.id("qualityCases"),
    at: v.number(),
    kind: v.union(v.literal("evidence"), v.literal("finding"), v.literal("request"), v.literal("statement"), v.literal("handoff"), v.literal("action"), v.literal("verification"), v.literal("outcome"), v.literal("note"), v.literal("agent"), v.literal("association")),
    basis: v.optional(literals(EVIDENCE_BASES)),
    text: v.string(),
    source: v.optional(qualitySourceValidator),
    actor: actorValidator,
    /** Words someone outside wrote. Rendered as plain text only. */
    quote: v.optional(v.string()),
  }).index("by_company_case", ["companyId", "caseId", "at"]),

  qualityEvidence: defineTable({
    companyId: v.id("companies"),
    caseId: v.id("qualityCases"),
    kind: v.union(v.literal("photo"), v.literal("checklist"), v.literal("report"), v.literal("statement"), v.literal("message"), v.literal("call"), v.literal("transcript"), v.literal("email"), v.literal("document"), v.literal("feedback"), v.literal("finance"), v.literal("history"), v.literal("note")),
    source: qualitySourceValidator,
    /** When the thing happened or was captured, if a record says so. Never filled in by guessing. */
    capturedAt: v.optional(v.number()),
    /** When it reached Selestial. */
    receivedAt: v.optional(v.number()),
    access: v.union(v.literal("available"), v.literal("no_access"), v.literal("processing"), v.literal("stale"), v.literal("needs_association"), v.literal("not_found"), v.literal("deleted")),
    note: v.optional(v.string()),
    /** Kept from the company's ordinary deletion while the case needs it (always, for a serious incident). */
    preserved: v.boolean(),
    addedBy: actorValidator,
    addedAt: v.number(),
  })
    .index("by_company_case", ["companyId", "caseId", "addedAt"])
    .index("by_company_source", ["companyId", "source.id"]),

  qualityRequests: defineTable({
    companyId: v.id("companies"),
    caseId: v.optional(v.id("qualityCases")),
    reviewId: v.optional(v.id("qualityReviews")),
    jobId: v.id("jobs"),
    purpose: literals(REQUEST_PURPOSES),
    recipient: recipientValidator,
    /** Names this request, so a retry or a second event never makes another. */
    key: v.string(),
    questions: v.array(v.object({ id: v.string(), text: v.string() })),
    evidence: v.array(v.object({ id: v.string(), label: v.string(), photoKind: v.optional(v.union(v.literal("before"), v.literal("after"), v.literal("item"), v.literal("issue"))), requirementId: v.optional(v.string()) })),
    status: literals(REQUEST_STATUSES),
    /** quality: Quality sends it. retention: a customer question in a recovery episode Retention owns. */
    conversationOwner: v.union(v.literal("quality"), v.literal("retention")),
    permission: v.string(),
    authorization: v.optional(v.string()),
    approvalId: v.optional(v.id("approvals")),
    channel: v.optional(v.union(v.literal("sms"), v.literal("email"))),
    messageIds: v.array(v.id("messages")),
    /** A customer question: the message action on Retention's case that carries it. Retention sends it. */
    retentionActionId: v.optional(v.id("retentionActions")),
    /** The link: 128 random bits; with the deployment's secret it makes the token, which is never stored. */
    publicId: v.optional(v.string()),
    allowed: v.array(v.string()),
    expiresAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    revokeReason: v.optional(v.string()),
    /** What the person must confirm before a sensitive submission. */
    verification: v.union(v.literal("none"), v.literal("zip"), v.literal("phone_last4")),
    verifyFailures: v.number(),
    /** Saved progress, replaced on each save. A submission is a separate, immutable row. */
    draft: v.optional(v.object({ answers: v.array(v.object({ questionId: v.string(), text: v.string() })), account: v.optional(v.string()), savedAt: v.number() })),
    reminders: v.number(),
    lastActionAt: v.optional(v.number()),
    lastAction: v.optional(v.string()),
    dueAt: v.number(),
    /** What it was prepared against. Not sent if the evidence moved on since. */
    stamp: v.string(),
    historical: v.optional(v.boolean()),
    result: v.optional(v.string()),
    createdBy: actorValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
    answeredAt: v.optional(v.number()),
  })
    .index("by_company_key", ["companyId", "key"])
    .index("by_publicId", ["publicId"])
    .index("by_company_job", ["companyId", "jobId", "createdAt"])
    .index("by_company_case", ["companyId", "caseId", "createdAt"])
    .index("by_company_status", ["companyId", "status", "dueAt"])
    .index("by_company_retention_action", ["companyId", "retentionActionId"]),

  /** What came back. Never patched or deleted: a correction is a new version that names the one it supplements. */
  qualitySubmissions: defineTable({
    companyId: v.id("companies"),
    requestId: v.id("qualityRequests"),
    caseId: v.optional(v.id("qualityCases")),
    jobId: v.id("jobs"),
    version: v.number(),
    kind: v.union(v.literal("original"), v.literal("supplement")),
    by: recipientValidator,
    answers: v.array(v.object({ questionId: v.string(), question: v.string(), text: v.string() })),
    account: v.optional(v.string()),
    fileIds: v.array(v.id("qualityFiles")),
    /** A correction outcome the customer gave. Retention records it on its own case too. */
    outcome: v.optional(v.union(v.literal("resolved"), v.literal("not_resolved"))),
    clientKey: v.string(),
    submittedAt: v.number(),
  })
    .index("by_company_request", ["companyId", "requestId", "version"])
    .index("by_company_case", ["companyId", "caseId", "submittedAt"])
    .index("by_company_clientKey", ["companyId", "clientKey"]),

  qualityFiles: defineTable({
    companyId: v.id("companies"),
    requestId: v.id("qualityRequests"),
    storageId: v.id("_storage"),
    name: v.string(),
    contentType: v.string(),
    size: v.number(),
    /** What the person's device said about when it was taken, labelled as theirs. Never inferred. */
    statedCapturedAt: v.optional(v.number()),
    uploadedAt: v.number(),
    clientKey: v.string(),
    /** Set when the submission that carries it is sent. Unsubmitted uploads can be removed by the uploader. */
    submittedAt: v.optional(v.number()),
  })
    .index("by_company_request", ["companyId", "requestId", "uploadedAt"])
    .index("by_storage", ["storageId"]),

  qualityCorrections: defineTable({
    companyId: v.id("companies"),
    caseId: v.id("qualityCases"),
    jobId: v.id("jobs"),
    key: v.string(),
    areas: v.array(v.string()),
    scope: v.union(v.literal("targeted"), v.literal("full")),
    /** Why this correction fits the reviewed findings, in words that name them. */
    why: v.string(),
    findingIds: v.array(v.id("qualityFindings")),
    /** What must be on record afterwards for Quality to call the work verified. */
    acceptance: v.object({ criteria: v.string(), afterPhotos: v.number(), checklistLabels: v.array(v.string()), inspection: v.boolean() }),
    timeSensitive: v.optional(v.object({ by: v.number(), reason: v.string() })),
    crewConstraints: v.array(v.string()),
    avoidCleanerIds: v.array(v.id("cleaners")),
    minutes: v.number(),
    estimatedCostCents: v.optional(v.number()),
    costBasis: v.string(),
    approvalNeeded: v.string(),
    state: literals(CORRECTION_STATES),
    /** The remedy on Retention's case that carries this correction; Retention arranges it and Dispatch staffs it. */
    retentionCaseId: v.optional(v.id("retentionCases")),
    retentionActionId: v.optional(v.id("retentionActions")),
    correctionJobId: v.optional(v.id("jobs")),
    actualCostCents: v.optional(v.number()),
    verification: v.optional(v.object({ outcome: v.union(v.literal("verified"), v.literal("not_verified")), detail: v.string(), unmet: v.array(v.string()), sources: v.array(qualitySourceValidator), by: actorValidator, at: v.number() })),
    customer: literals(CUSTOMER_ANSWERS),
    /** What the plan was prepared against: case revision, finding revisions, the job's state. */
    stamp: v.string(),
    result: v.optional(v.string()),
    createdBy: actorValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_company_case", ["companyId", "caseId", "createdAt"])
    .index("by_company_key", ["companyId", "key"])
    .index("by_company_state", ["companyId", "state", "updatedAt"])
    .index("by_company_correction_job", ["companyId", "correctionJobId"])
    .index("by_company_retention_action", ["companyId", "retentionActionId"]),

  qualityImprovements: defineTable({
    companyId: v.id("companies"),
    key: v.string(),
    kind: literals(IMPROVEMENT_KINDS),
    title: v.string(),
    proposedChange: v.string(),
    /** The reviewed evidence behind it, and the denominator it was counted against. */
    evidence: v.object({
      findingIds: v.array(v.id("qualityFindings")),
      caseIds: v.array(v.id("qualityCases")),
      count: v.number(),
      denominator: v.number(),
      denominatorLabel: v.string(),
      windowDays: v.number(),
    }),
    affects: v.object({ services: v.array(v.string()), propertyIds: v.array(v.id("properties")) }),
    expectedBenefit: v.string(),
    owner: literals(IMPROVEMENT_OWNERS),
    evaluation: v.object({ measure: v.string(), windowDays: v.number(), baselineCount: v.number(), baselineDenominator: v.number() }),
    state: literals(IMPROVEMENT_STATES),
    approvalId: v.optional(v.id("approvals")),
    decidedBy: v.optional(v.id("members")),
    decidedAt: v.optional(v.number()),
    decisionNote: v.optional(v.string()),
    adoptedAt: v.optional(v.number()),
    /** After adoption: what was measured, over what, and what may and may not be concluded. */
    result: v.optional(v.object({ at: v.number(), count: v.number(), denominator: v.number(), words: v.string() })),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_company_key", ["companyId", "key"])
    .index("by_company_state", ["companyId", "state", "updatedAt"]),

  qualityRuns: defineTable({
    companyId: v.id("companies"),
    kind: literals(RUN_KINDS),
    /** Names this one piece of work. A repeated event or webhook finds it and does nothing. */
    key: v.string(),
    status: literals(RUN_STATUSES),
    attempts: v.number(),
    /** Set while a worker holds the run. A lease that ran out is picked up by the sweep. */
    leaseUntil: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    /** Why it waits: paused, plan, not connected, a person holds the case. Shown, never hidden. */
    blockedReason: v.optional(v.string()),
    jobId: v.optional(v.id("jobs")),
    caseId: v.optional(v.id("qualityCases")),
    reviewId: v.optional(v.id("qualityReviews")),
    commId: v.optional(v.id("qualityComms")),
    connectionId: v.optional(v.id("qualityConnections")),
    /** Ids and small facts only. Untrusted text is never kept here. */
    payload: v.optional(v.string()),
    executionId: v.optional(v.id("aiExecutions")),
    checked: v.array(v.string()),
    found: v.array(v.string()),
    next: v.array(v.string()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    historical: v.optional(v.boolean()),
    queuedAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_company_key", ["companyId", "key"])
    .index("by_status_next", ["status", "nextAttemptAt"])
    .index("by_company_kind", ["companyId", "kind", "queuedAt"])
    .index("by_company_status", ["companyId", "status", "queuedAt"])
    .index("by_company_job", ["companyId", "jobId", "queuedAt"])
    .index("by_company_case", ["companyId", "caseId", "queuedAt"]),

  /**
   * Quality reading one phone platform for a company. For Quo it rides on the company's one Quo connection
   * (`quoConnectionId`, convex/quo.ts): no second key, no second webhook. For HighLevel it is Quality's own
   * Marketplace-app installation for one location (`externalId`), with its tokens in `qualityCredentials`.
   */
  qualityConnections: defineTable({
    companyId: v.id("companies"),
    provider: commProviderValidator,
    /** Quo: the shared connection Quality reads through. */
    quoConnectionId: v.optional(v.id("quoConnections")),
    /** HighLevel: the location (sub-account) id the app was installed on; webhooks are matched by it. */
    externalId: v.optional(v.string()),
    /** Kept for rows made before reading moved onto the shared connection. */
    publicId: v.optional(v.string()),
    label: v.string(),
    status: v.union(v.literal("checking"), v.literal("connected"), v.literal("error"), v.literal("expired"), v.literal("disconnected")),
    problem: v.optional(v.string()),
    /** The provider's workspace numbers, as it reported them. Its own numbers are never a customer match. */
    numbers: v.array(v.object({ id: v.string(), number: v.string(), name: v.optional(v.string()) })),
    capabilities: capabilitiesValidator,
    webhookId: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
    lastSuccessAt: v.optional(v.number()),
    /** Calls are read from here on: the poll window's start, never further back than the Owner chose. */
    readFrom: v.number(),
    syncCursor: v.optional(v.number()),
    failures: v.number(),
    leaseUntil: v.optional(v.number()),
    connectedBy: v.id("members"),
    connectedAt: v.number(),
    disconnectedAt: v.optional(v.number()),
  })
    .index("by_company_provider", ["companyId", "provider"])
    .index("by_publicId", ["publicId"])
    .index("by_quo_connection", ["quoConnectionId"])
    .index("by_provider_external", ["provider", "externalId"])
    .index("by_status", ["status"]),

  /**
   * Sealed secrets for a connection Quality holds itself (HighLevel's OAuth tokens). Never sent to a browser,
   * never exported. Quo has none here: its key lives with the shared Quo connection (`quoSecrets`).
   */
  qualityCredentials: defineTable({
    companyId: v.id("companies"),
    connectionId: v.id("qualityConnections"),
    /** HighLevel: the refresh token (it rotates on every use). */
    sealedKey: v.string(),
    /** HighLevel: the current access token and when it stops working. */
    sealedAccess: v.optional(v.string()),
    accessExpiresAt: v.optional(v.number()),
    sealedWebhookKey: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  }).index("by_connection", ["connectionId"]),

  /** Webhook deliveries, by the provider's delivery id: the same delivery twice changes nothing twice. */
  qualityWebhookEvents: defineTable({
    connectionId: v.id("qualityConnections"),
    deliveryId: v.string(),
    eventId: v.optional(v.string()),
    type: v.string(),
    receivedAt: v.number(),
  }).index("by_connection_delivery", ["connectionId", "deliveryId"]),

  qualityComms: defineTable({
    companyId: v.id("companies"),
    connectionId: v.id("qualityConnections"),
    provider: commProviderValidator,
    kind: literals(COMM_KINDS),
    /** The provider's id for the call or message. */
    providerId: v.string(),
    conversationId: v.optional(v.string()),
    phoneNumberId: v.optional(v.string()),
    direction: v.union(v.literal("incoming"), v.literal("outgoing")),
    /** The other side's number (E.164), worked out by leaving out the company's own numbers. */
    counterpart: v.optional(v.string()),
    status: v.optional(v.string()),
    /** When the provider says it happened, and when it reached Selestial. Kept apart. */
    occurredAt: v.number(),
    completedAt: v.optional(v.number()),
    ingestedAt: v.number(),
    durationSec: v.optional(v.number()),
    /** A text's words. Untrusted data: shown as text, never an instruction. */
    body: v.optional(v.string()),
    /** The provider's own summary, labelled as such. Never treated as what anyone said. */
    providerSummary: v.optional(v.object({ status: literals(TRANSCRIPT_STATES), lines: v.array(v.string()), nextSteps: v.array(v.string()), fetchedAt: v.number() })),
    /** The original transcript as the provider gave it. Revisions replace it and keep the version count. */
    transcript: v.optional(
      v.object({
        status: literals(TRANSCRIPT_STATES),
        version: v.number(),
        hash: v.optional(v.string()),
        segments: v.array(v.object({ start: v.number(), end: v.number(), speaker: v.optional(v.string()), speakerKind: v.union(v.literal("company"), v.literal("external"), v.literal("unknown")), text: v.string(), recordingId: v.optional(v.string()) })),
        fetchedAt: v.number(),
        revisedAt: v.optional(v.number()),
      }),
    ),
    /** The recording's state only. The audio is never copied. */
    recording: v.optional(v.object({ status: v.string(), durationSec: v.optional(v.number()) })),
    /** Customers whose phone or contacts match the counterpart, from the company's own records. */
    matchedCustomerIds: v.array(v.id("customers")),
    matchedCleanerIds: v.array(v.id("cleaners")),
    /** The visit it is linked to, once linked by evidence or by a person. */
    jobId: v.optional(v.id("jobs")),
    associationId: v.optional(v.id("qualityAssociations")),
    /** The source content was deleted or became unavailable at the provider. What was read is kept, marked. */
    unavailableAt: v.optional(v.number()),
    /** When a call's transcript is checked again (transcripts arrive after the call ends). */
    recheckAt: v.optional(v.number()),
    rechecks: v.number(),
  })
    .index("by_connection_provider_id", ["connectionId", "providerId"])
    .index("by_company_occurred", ["companyId", "occurredAt"])
    .index("by_company_job", ["companyId", "jobId", "occurredAt"])
    .index("by_company_counterpart", ["companyId", "counterpart", "occurredAt"])
    .index("by_recheck", ["recheckAt"]),

  /** Selestial's reading of a transcript or message: a suggestion tied to segments, never invented words. */
  qualityExtracts: defineTable({
    companyId: v.id("companies"),
    commId: v.id("qualityComms"),
    /** The transcript version it was read from. A revision marks older extracts stale. */
    version: v.number(),
    kind: v.union(v.literal("complaint"), v.literal("promised_follow_up"), v.literal("scope_expectation"), v.literal("access_issue"), v.literal("requested_correction"), v.literal("preference"), v.literal("deadline")),
    /** Selestial's paraphrase. */
    text: v.string(),
    /** Exact words, copied only from a transcript segment or message, never from a summary. */
    quote: v.optional(v.string()),
    segments: v.array(v.object({ index: v.number(), start: v.number(), end: v.number() })),
    speakerUncertain: v.boolean(),
    /** Read from the provider's summary, not the words: weaker, and labelled. */
    fromSummary: v.boolean(),
    by: v.string(),
    state: v.union(v.literal("suggested"), v.literal("reviewed"), v.literal("rejected"), v.literal("stale")),
    caseId: v.optional(v.id("qualityCases")),
    createdAt: v.number(),
  })
    .index("by_company_comm", ["companyId", "commId", "version"])
    .index("by_company_case", ["companyId", "caseId"]),

  /** One conversation and the visits it might be about. Linked automatically only on evidence; otherwise a person decides. */
  qualityAssociations: defineTable({
    companyId: v.id("companies"),
    commId: v.id("qualityComms"),
    status: v.union(v.literal("linked"), v.literal("needs_review"), v.literal("unlinked"), v.literal("dismissed")),
    method: v.optional(literals(ASSOCIATION_METHODS)),
    jobId: v.optional(v.id("jobs")),
    /** Each candidate with the reasons for it and against it, in words. There is no score. */
    candidates: v.array(v.object({ jobId: v.id("jobs"), customerId: v.id("customers"), propertyId: v.id("properties"), startsAt: v.number(), for: v.array(v.string()), against: v.array(v.string()) })),
    why: v.string(),
    history: v.array(v.object({ at: v.number(), by: actorValidator, action: v.string(), jobId: v.optional(v.id("jobs")), note: v.optional(v.string()) })),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_company_comm", ["companyId", "commId"])
    .index("by_company_status", ["companyId", "status", "updatedAt"]),
};
