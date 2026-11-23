/** Plain words for Quality's states. A status is words; the screens never show a colour alone. */
import type { Actor } from "../events";
import type { CaseClosure, CaseOrigin, CaseStage, CorrectionState, CustomerAnswer, FindingCategory, ImprovementKind, Recommendation, RequestPurpose, RequestStatus, RequirementKind, RequirementOutcome, ReviewStatus, StandardLevel, StandardTemplate } from "./schema";

export const QUALITY: Actor = { kind: "agent", agent: "quality" };
export const SYSTEM: Actor = { kind: "system" };
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const STAGE_WORDS: Record<CaseStage, string> = {
  needs_context: "Needs context",
  investigating: "Investigating",
  needs_decision: "Needs decision",
  action_underway: "Action underway",
  verifying: "Verifying",
  closed: "Closed",
};

export const ORIGIN_WORDS: Record<CaseOrigin, string> = {
  customer_feedback: "Customer feedback",
  call: "A call",
  sms: "A text",
  email: "An email",
  cleaner_report: "A cleaner's report",
  owner_report: "Reported by the office",
  completion_review: "Completion review",
  pattern: "A repeated pattern",
  retention_case: "A Retention case",
};

export const FINDING_WORDS: Record<FindingCategory, string> = {
  service_miss: "Service miss",
  scope_misunderstanding: "Scope misunderstanding",
  access_limitation: "Access limitation",
  equipment_limitation: "Equipment or supply limitation",
  scheduling_failure: "Scheduling failure",
  insufficient_evidence: "Insufficient evidence",
  no_issue_established: "No issue established",
  serious_incident: "Serious incident: human review",
};

export const CLOSURE_WORDS: Record<CaseClosure, string> = {
  findings_recorded: "Findings recorded. No correction was needed.",
  correction_verified: "The correction's record meets the acceptance criteria.",
  correction_not_verified: "The correction was not verified against its acceptance criteria.",
  no_issue_established: "Reviewed: no issue was established from the evidence.",
  insufficient_evidence: "Closed with insufficient evidence to establish what happened.",
  handled_by_person: "Handled by a person.",
  duplicate: "Joined to another case about the same visit.",
  serious_decided: "A person recorded the decision on this serious incident.",
};

export const REVIEW_WORDS: Record<ReviewStatus, string> = {
  queued: "Being reviewed",
  ready: "Reviewed",
  waiting_on_evidence: "Waiting on evidence",
  needs_decision: "Needs a decision",
  approved: "Approved",
  case_opened: "Case opened",
  superseded: "Superseded by a later submission",
  not_reviewed: "Not reviewed",
};

export const RECOMMENDATION_WORDS: Record<Recommendation, string> = {
  approve: "Approve: the record meets the standard that applied",
  request_information: "Ask for what is missing",
  correct: "Consider a correction",
  investigate: "Have a person look into it",
};

export const OUTCOME_WORDS: Record<RequirementOutcome, string> = {
  met: "Met",
  missing: "Missing",
  contradictory: "Contradictory",
  unverifiable: "Cannot be checked from the record",
  not_applicable: "Does not apply",
  waived: "Waived",
};

export const REQUEST_WORDS: Record<RequestStatus, string> = {
  prepared: "Prepared, not sent",
  awaiting_approval: "Waiting for approval",
  sent: "Sent",
  answered: "Answered",
  satisfied: "Closed: what was asked for arrived",
  unanswered: "Unanswered",
  expired: "Link expired",
  revoked: "Withdrawn",
  cancelled: "Cancelled",
  blocked: "Not sent",
  handed_to_retention: "With Retention",
};

export const PURPOSE_WORDS: Record<RequestPurpose, string> = {
  missing_evidence: "Missing evidence",
  question: "A focused question",
  statement: "An account of what happened",
  supplement: "A supplemental statement",
  correction_outcome: "Correction outcome",
};

export const CORRECTION_WORDS: Record<CorrectionState, string> = {
  proposed: "Proposed",
  approved: "Approved",
  scheduled: "Scheduled",
  crew_accepted: "Crew accepted",
  completed: "Completed",
  quality_verified: "Quality verified",
  verification_failed: "Not verified",
  cancelled: "Cancelled",
  blocked: "Blocked",
};

export const CUSTOMER_WORDS: Record<CustomerAnswer, string> = {
  not_asked: "Customer not asked",
  asked: "Customer asked, no answer yet",
  confirmed: "Customer confirmed",
  dissatisfied: "Customer says it is not resolved",
  no_response: "Customer did not respond",
};

export const LEVEL_WORDS: Record<StandardLevel, string> = {
  company: "Company default",
  service: "Service",
  account: "Account",
  property: "Property",
  visit: "Visit exception",
};

export const KIND_WORDS: Record<RequirementKind, string> = {
  checklist_completion: "Checklist completion",
  required_evidence: "Required evidence",
  guide_acknowledgment: "Guide acknowledged",
  inspection: "Inspection",
  site_confirmation: "Customer or site confirmation",
  document: "Document or certificate",
  timing: "Timing",
};

export const TEMPLATE_WORDS: Record<StandardTemplate, string> = {
  residential_one_time: "Residential, one-time",
  residential_recurring: "Residential, recurring",
  deep_move_out: "Deep and move-out cleaning",
  commercial: "Commercial",
  office: "Office",
  str_turnover: "Short-term rental turnover",
};

export const IMPROVEMENT_WORDS: Record<ImprovementKind, string> = {
  checklist_change: "Checklist change",
  booking_question: "Booking question",
  scope_exclusion: "Clearer scope exclusion",
  property_instruction: "Property instruction",
  training: "Training assignment",
  equipment: "Equipment requirement",
  inspection_frequency: "Inspection frequency",
  scheduling_assumption: "Scheduling assumption",
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
