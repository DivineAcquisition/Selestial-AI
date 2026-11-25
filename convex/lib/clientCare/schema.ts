/**
 * Client Care's records (docs/care/00-architecture.md). A request is the durable unit of work: one thing a
 * client needs, linked to the records it is about and to the conversation it came from. It is not a copy of
 * the conversation: the messages stay in the shared Inbox records (`inboundMessages`, `messages`).
 *
 *   careRequests  one actionable need, its state, who holds it, what it waits for and what is promised
 *   careMessages  a client's message as Care read it (up to 1,000 characters, access details withheld)
 *   careEntries   a request's history: what was received, found, done, decided and promised
 *   careSteps     one action Care prepared or carried out, with its idempotency key, its authority, the
 *                 stamp of the facts it was prepared on, and which of its parts succeeded
 *   careRuns      the durable work queue: reading a message, advancing a request, a follow-up
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

import { actorValidator } from "../events";
import { planRefValidator, PLAN_CHANGES } from "../retention/schema";
import { agentValidator, literals } from "../statuses";

export const CARE_CATEGORIES = ["appointment", "preference", "access", "reschedule", "cancellation", "complaint", "billing", "extra", "new_service", "general"] as const;
export type CareCategory = (typeof CARE_CATEGORIES)[number];
export const careCategoryValidator = literals(CARE_CATEGORIES);

/**
 * new: received, not yet worked. in_progress: Care (or a person) is working it. waiting_*: on someone, with
 * the reason kept separately so the screen can say it. resolved: the outcome is on the record and the client
 * was told. closed_no_action: closed for a stated reason (a duplicate, nothing to do, the client withdrew it).
 */
export const REQUEST_STATUSES = ["new", "in_progress", "waiting_customer", "waiting_team", "waiting_owner", "resolved", "closed_no_action"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const requestStatusValidator = literals(REQUEST_STATUSES);
export const OPEN_STATUSES: readonly RequestStatus[] = ["new", "in_progress", "waiting_customer", "waiting_team", "waiting_owner"];

export const URGENCIES = ["normal", "high", "urgent"] as const;
export type Urgency = (typeof URGENCIES)[number];

/** What a cancellation actually is. "Cancel Friday" is never read as ending the whole plan. */
export const CANCEL_KINDS = ["skip_visit", "cancel_visit", "pause_plan", "end_plan"] as const;
export type CancelKind = (typeof CANCEL_KINDS)[number];

/** Who a preference applies to: one visit, one property, every future visit at it, or the client in general. */
export const PREFERENCE_SCOPES = ["one_visit", "property", "all_future", "customer"] as const;
export type PreferenceScope = (typeof PREFERENCE_SCOPES)[number];

/** The authority the person writing has: the client's own phone or email, or one of its contacts with their roles. */
export const authorityValidator = v.object({
  as: v.union(v.literal("client"), v.literal("contact")),
  contactId: v.optional(v.id("clientContacts")),
  name: v.string(),
  roles: v.array(v.union(v.literal("primary"), v.literal("billing"), v.literal("signer"), v.literal("site"))),
  /** The properties this person may speak for. Empty: all of the client's. */
  propertyIds: v.array(v.id("properties")),
});
export type Authority = typeof authorityValidator.type;

export const factValidator = v.object({
  key: v.string(),
  value: v.string(),
  /** record: read from a record. customer: what the client said. policy: a company or agreement rule. derived: worked out in code from those. */
  basis: v.union(v.literal("record"), v.literal("customer"), v.literal("policy"), v.literal("derived")),
  source: v.optional(v.object({ table: v.string(), id: v.string(), label: v.string() })),
  at: v.number(),
});
export type Fact = typeof factValidator.type;

/** What the client asked for, as code read it. Every field is optional: absent means not said. */
export const askValidator = v.object({
  question: v.optional(v.union(v.literal("when"), v.literal("included"), v.literal("who"), v.literal("confirmed"), v.literal("general"))),
  cancel: v.optional(literals(CANCEL_KINDS)),
  /** The visit the client refers to, by day. */
  target: v.optional(v.object({ day: v.optional(v.string()), weekday: v.optional(v.number()), words: v.string() })),
  /** When the client wants it instead. */
  when: v.optional(v.object({ day: v.optional(v.string()), weekday: v.optional(v.number()), minute: v.optional(v.number()), words: v.string() })),
  scope: v.optional(literals(PREFERENCE_SCOPES)),
  /** The preference or extra in the client's words (access details withheld). */
  detail: v.optional(v.string()),
  serious: v.optional(v.string()),
});
export type Ask = typeof askValidator.type;

/** A question Care asked and is waiting on the client to answer, with the options it offered. */
export const pendingValidator = v.object({
  kind: v.union(v.literal("which_visit"), v.literal("which_scope"), v.literal("which_change"), v.literal("choose_time"), v.literal("confirm"), v.literal("details")),
  question: v.string(),
  options: v.array(
    v.object({
      key: v.string(),
      label: v.string(),
      jobId: v.optional(v.id("jobs")),
      startsAt: v.optional(v.number()),
      endsAt: v.optional(v.number()),
      scope: v.optional(literals(PREFERENCE_SCOPES)),
      cancel: v.optional(literals(CANCEL_KINDS)),
      propertyId: v.optional(v.id("properties")),
    }),
  ),
  askedAt: v.number(),
  /** After this, the question is followed up once, then handed to a person. */
  expiresAt: v.number(),
  reminded: v.boolean(),
});
export type Pending = typeof pendingValidator.type;

export const waitingValidator = v.object({
  on: v.union(v.literal("customer"), v.literal("team"), v.literal("owner")),
  /** In words the owner reads: "Waiting for the client to choose a time", "Dispatch is finding a cleaner". */
  reason: v.string(),
  /** The agent or person it waits on, when it is one. */
  who: v.optional(v.string()),
  since: v.number(),
});

export const ownerValidator = v.union(v.object({ kind: v.literal("care") }), v.object({ kind: v.literal("member"), memberId: v.id("members"), since: v.number() }), v.object({ kind: v.literal("specialist"), agent: agentValidator, since: v.number() }));

export const STEP_KINDS = ["reply", "reschedule", "skip_visit", "cancel_visit", "plan_change", "preference", "access", "invoice_link", "complaint", "hand_off", "relay", "update"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/**
 * proposed: prepared; nothing done. awaiting_approval: in the approvals queue. ready: authorized and about to
 * run. done: every part done. partial: the change is done and a later part (the message) is not yet.
 * failed: it did not happen. blocked: it cannot run (policy, channel, authority), with the reason.
 * uncertain: an outside system may or may not have done it; it is never retried blindly. cancelled: set aside.
 */
export const STEP_STATUSES = ["proposed", "awaiting_approval", "ready", "done", "partial", "failed", "blocked", "uncertain", "cancelled"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const partValidator = v.object({
  name: v.union(v.literal("change"), v.literal("notify"), v.literal("record"), v.literal("handoff")),
  state: v.union(v.literal("pending"), v.literal("done"), v.literal("failed"), v.literal("uncertain"), v.literal("skipped")),
  detail: v.optional(v.string()),
  at: v.number(),
});
export type Part = typeof partValidator.type;

export const stepPayloadValidator = v.object({
  jobId: v.optional(v.id("jobs")),
  startsAt: v.optional(v.number()),
  endsAt: v.optional(v.number()),
  /** The visit's version when the move was planned (lib/dispatch/reschedule.ts). */
  moveVersion: v.optional(v.string()),
  plan: v.optional(planRefValidator),
  change: v.optional(literals(PLAN_CHANGES)),
  from: v.optional(v.string()),
  until: v.optional(v.string()),
  shown: v.optional(v.array(v.id("jobs"))),
  propertyId: v.optional(v.id("properties")),
  scope: v.optional(literals(PREFERENCE_SCOPES)),
  /** A preference in the client's words. */
  text: v.optional(v.string()),
  /** New access instructions, sealed to this step (lib/recruiter/secrets.ts). Never stored in the clear. */
  sealed: v.optional(v.string()),
  invoiceId: v.optional(v.id("invoices")),
  handoffTo: v.optional(v.union(v.literal("sales"), v.literal("dispatch"), v.literal("quality"), v.literal("retention"), v.literal("finance"), v.literal("owner"))),
  taskId: v.optional(v.id("tasks")),
  retentionActionId: v.optional(v.id("retentionActions")),
  retentionCaseId: v.optional(v.id("retentionCases")),
  /** The message is true whatever the client wrote since (it confirms a change already made). */
  staleSafe: v.optional(v.boolean()),
});
export type StepPayload = typeof stepPayloadValidator.type;

export const careSettingsValidator = v.object({
  /** The request types Care works. Absent: all of them. A type left out is recorded for a person. */
  requestTypes: v.optional(v.array(careCategoryValidator)),
  /** The company's own rules, used when the client's agreement does not say. Absent means not set. */
  policy: v.optional(
    v.object({
      changeNoticeHours: v.optional(v.number()),
      lateChangeFeeCents: v.optional(v.number()),
      /** Where the rule comes from in the company's own words, e.g. "Service terms, section 4". */
      source: v.optional(v.string()),
    }),
  ),
  tone: v.optional(v.union(v.literal("warm"), v.literal("direct"), v.literal("formal"))),
  /** Added to the end of an email. Never a person's name presented as the writer. */
  signature: v.optional(v.string()),
  /** People told first about urgent or serious requests. Absent: every Owner and Manager under their own notice settings. */
  escalationMemberIds: v.optional(v.array(v.id("members"))),
  /** How soon a request should get its first answer, and how often a client waiting on the team hears from Care. */
  respondWithinMinutes: v.optional(v.number()),
  updateEveryHours: v.optional(v.number()),
  /** Read customers' email in the Care & Retention inbox. Absent: Retention's earlier setting carries over. */
  readInbox: v.optional(v.boolean()),
  revision: v.optional(v.number()),
});
export type CareSettingsInput = typeof careSettingsValidator.type;

const sourceValidator = v.object({ table: v.string(), id: v.string(), label: v.string() });

export const clientCareTables = {
  careRequests: defineTable({
    companyId: v.id("companies"),
    customerId: v.id("customers"),
    authority: authorityValidator,
    propertyId: v.optional(v.id("properties")),
    jobId: v.optional(v.id("jobs")),
    plan: v.optional(planRefValidator),
    invoiceId: v.optional(v.id("invoices")),
    agreementId: v.optional(v.id("agreements")),
    /** Where the request came from and where answers go: the same thread, by the same channel. */
    conversation: v.object({
      channel: v.union(v.literal("sms"), v.literal("email")),
      address: v.string(),
      smsConversationId: v.optional(v.id("smsConversations")),
      mailboxConnectionId: v.optional(v.id("mailboxConnections")),
      threadId: v.optional(v.string()),
      subject: v.optional(v.string()),
    }),
    category: careCategoryValidator,
    summary: v.string(),
    requestedOutcome: v.string(),
    ask: askValidator,
    status: requestStatusValidator,
    waiting: v.optional(waitingValidator),
    owner: ownerValidator,
    urgency: literals(URGENCIES),
    urgencyReason: v.optional(v.string()),
    facts: v.array(factValidator),
    blocker: v.optional(v.string()),
    nextAction: v.optional(v.string()),
    pending: v.optional(pendingValidator),
    /** What the client was told they would hear, and by when. */
    promised: v.optional(v.object({ words: v.string(), by: v.number(), madeAt: v.number() })),
    /** When Care next looks at this request on its own: a follow-up, a promised update, a stuck step. */
    nextCheckAt: v.optional(v.number()),
    lastCustomerAt: v.number(),
    lastUpdateAt: v.optional(v.number()),
    updatesSent: v.number(),
    qualityCaseId: v.optional(v.id("qualityCases")),
    retentionCaseId: v.optional(v.id("retentionCases")),
    opportunityId: v.optional(v.id("salesOpportunities")),
    taskId: v.optional(v.id("tasks")),
    resolution: v.optional(v.object({ at: v.number(), words: v.string(), evidence: v.array(sourceValidator) })),
    reopened: v.array(v.object({ at: v.number(), reason: v.string(), from: requestStatusValidator })),
    /** Counts every material change, so an approval prepared on an earlier version is never carried out. */
    version: v.number(),
    reader: v.string(),
    origin: v.union(v.literal("sms"), v.literal("email"), v.literal("staff")),
    createdAt: v.number(),
    updatedAt: v.number(),
    closedAt: v.optional(v.number()),
  })
    .index("by_company_status", ["companyId", "status", "updatedAt"])
    .index("by_company_customer", ["companyId", "customerId", "createdAt"])
    .index("by_company_check", ["companyId", "nextCheckAt"])
    .index("by_check", ["nextCheckAt"])
    .index("by_company_retention_case", ["companyId", "retentionCaseId"])
    .index("by_company_updated", ["companyId", "updatedAt"]),

  careMessages: defineTable({
    companyId: v.id("companies"),
    customerId: v.id("customers"),
    contactId: v.optional(v.id("clientContacts")),
    channel: v.union(v.literal("sms"), v.literal("email")),
    from: v.string(),
    /** The provider's id for this message, so the same delivery is read once. */
    providerKey: v.string(),
    /** Up to 1,000 characters of the client's own words, with access codes withheld. */
    text: v.string(),
    withheld: v.boolean(),
    /** The withheld original, sealed to this row, when the message carried new access details. */
    sealed: v.optional(v.string()),
    receivedAt: v.number(),
    status: v.union(v.literal("queued"), v.literal("read"), v.literal("skipped")),
    requestIds: v.array(v.id("careRequests")),
    note: v.optional(v.string()),
    reader: v.optional(v.string()),
    conversationId: v.optional(v.id("smsConversations")),
    mailbox: v.optional(v.object({ connectionId: v.id("mailboxConnections"), threadId: v.optional(v.string()), subject: v.optional(v.string()) })),
  })
    .index("by_company_provider", ["companyId", "providerKey"])
    .index("by_company_customer", ["companyId", "customerId", "receivedAt"])
    .index("by_company_status", ["companyId", "status", "receivedAt"]),

  careEntries: defineTable({
    companyId: v.id("companies"),
    requestId: v.id("careRequests"),
    kind: v.union(
      v.literal("received"),
      v.literal("found"),
      v.literal("asked"),
      v.literal("did"),
      v.literal("waiting"),
      v.literal("decision"),
      v.literal("handoff"),
      v.literal("update"),
      v.literal("problem"),
      v.literal("reopened"),
      v.literal("resolved"),
      v.literal("note"),
    ),
    text: v.string(),
    source: v.optional(sourceValidator),
    actor: actorValidator,
    at: v.number(),
  }).index("by_request", ["requestId", "at"]),

  careSteps: defineTable({
    companyId: v.id("companies"),
    requestId: v.id("careRequests"),
    /** Names this one action, so a retry or a repeated run finds it instead of doing it again. */
    key: v.string(),
    kind: literals(STEP_KINDS),
    permission: v.string(),
    status: literals(STEP_STATUSES),
    /** What it does, in words a person checks before approving. */
    summary: v.string(),
    /** The facts it was prepared on. Approving it, or carrying it out, re-reads them; a different stamp stops it. */
    stamp: v.string(),
    payload: stepPayloadValidator,
    message: v.optional(v.object({ channel: v.union(v.literal("sms"), v.literal("email")), subject: v.optional(v.string()), body: v.string() })),
    messageId: v.optional(v.id("messages")),
    approvalId: v.optional(v.id("approvals")),
    attempts: v.number(),
    parts: v.array(partValidator),
    result: v.optional(v.string()),
    createdBy: actorValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_company_key", ["companyId", "key"])
    .index("by_request", ["requestId", "createdAt"])
    .index("by_company_status", ["companyId", "status", "updatedAt"]),

  careRuns: defineTable({
    companyId: v.id("companies"),
    kind: v.union(v.literal("read"), v.literal("check")),
    key: v.string(),
    messageId: v.optional(v.id("careMessages")),
    requestId: v.optional(v.id("careRequests")),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("skipped"), v.literal("failed")),
    attempts: v.number(),
    /** While set and in the future, one worker holds the run. A crashed worker's lease lapses. */
    leaseUntil: v.optional(v.number()),
    executionId: v.optional(v.id("aiExecutions")),
    reader: v.optional(v.string()),
    result: v.optional(v.string()),
    queuedAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_company_key", ["companyId", "key"])
    .index("by_status_queued", ["status", "queuedAt"])
    .index("by_company_queued", ["companyId", "queuedAt"]),
};
