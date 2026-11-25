/**
 * What each permission in the catalog can actually do today (docs/foundation/07-agent-controls.md).
 *
 * The catalog (convex/lib/permissionCatalog.ts) says what an owner may choose. This says what the code
 * behind the choice is: whether any execution path exists, what it needs before it can work, what a
 * money limit measures, and whether it is routine work a preset may delegate. Agent Controls, presets,
 * "Test these rules" and execution all read it, so the screen never offers something the agent cannot do.
 */
import type { Agent } from "../statuses";

/**
 * What an action needs before it can work, each checked by the same function the send path uses
 * (convex/lib/controls/readiness.ts):
 *  - sms: the company can text (sender name, number, approved registration, a text provider on the deployment)
 *  - email: the company can email (a from address and an email provider)
 *  - outreach: either of those
 *  - links: signed action links (ACTION_LINK_SECRET), without which an offer or application link cannot be made
 *  - pricing: at least one active, published service, without which no quote can be priced
 *  - google_ads / google_business: that Google tool connected
 */
export type Need = "sms" | "email" | "outreach" | "links" | "pricing" | "google_ads" | "google_business";

export type Capability = {
  /** Whether any execution path reads this permission. When false, the screen says why and nothing can raise it. */
  implemented: boolean;
  /** Why it is unavailable, in the owner's words. */
  unavailable?: string;
  needs: Need[];
  /** What a money limit counts, so the owner knows what they are capping. */
  measures?: string;
  /** Routine work the "Routine work delegated" preset may hand over, at the catalog's standard level. */
  routine?: boolean;
  /** Work that opens an AI execution, so the plan's AI access applies at execution (convex/lib/billing/executions.ts). */
  ai?: boolean;
  /** A short note shown beside the action, for a limit of the implementation an owner should know. */
  note?: string;
};

const ready = (needs: Need[], extra: Partial<Capability> = {}): Capability => ({ implemented: true, needs, ...extra });
const missing = (unavailable: string): Capability => ({ implemented: false, unavailable, needs: [] });

export const CAPABILITIES: Record<string, Capability> = {
  "dispatch.request_acceptance": ready(["sms", "links"], { routine: true }),
  "dispatch.send_replacement_offer": ready(["sms", "links"], { routine: true }),
  "dispatch.run_backup_coverage": ready(["sms", "links"]),
  "dispatch.broadcast_offer": ready(["sms", "links"], { note: "Runs only when asking several cleaners at once is switched on in the Dispatch playbook." }),
  "dispatch.declare_no_show": ready([]),
  "dispatch.request_urgent_hire": ready([]),
  "dispatch.send_reminder": ready(["sms"], { routine: true }),
  "dispatch.act_on_cleaner_reply": ready(["sms"]),
  "dispatch.notify_running_late": ready(["sms"], { note: "Today this hands the delay to a person to tell the customer; the agent does not text the customer itself." }),
  "dispatch.close_visit": missing("Dispatch doesn't close visits on its own yet. A person closes each visit."),
  "dispatch.reassign_confirmed_visit": ready(["sms", "links"]),
  "dispatch.availability_check_in": ready(["sms"], { routine: true }),
  "dispatch.override_time_between_jobs": missing("Dispatch never overrides the time-between-jobs rule. A person changes the rule in the playbook."),

  "sales.reply_and_quote": ready(["outreach", "pricing"], { ai: true }),
  "sales.follow_up": ready(["outreach"], { routine: true }),
  "sales.discount_in_band": missing("Sales never discounts: quotes come from your published prices. Your team can still lower a price inside your discount band."),
  "sales.draft_ad_campaign": ready(["google_ads"]),
  "sales.confirm_booking": ready(["outreach", "pricing"]),
  "sales.discount_out_of_band": missing("Sales never discounts. A price your team changes outside the band still comes to an Owner for approval."),

  "retention.request_feedback": ready(["outreach"], { routine: true }),
  "retention.offer_recurring_plan": ready(["outreach"]),
  "retention.recover_payment": missing("Retention doesn't chase payments yet. Payment reminders are prepared in Finance, and a person approves each one."),
  "retention.remedy_within_limit": ready([], {
    measures: "The credit's amount, or for a correction visit the estimated crew pay (the original crew's pay for the same share of the visit). It is not cash moved: credits go through Finance.",
  }),
  "retention.refund_above_limit": ready([]),
  "retention.cancel_on_request": ready([]),
  "retention.send_case_message": ready(["outreach"], { ai: true }),
  "retention.apply_plan_change": ready([]),
  "retention.reactivation_offer": ready(["outreach"]),
  "retention.hand_off": ready([]),
  "retention.draft_review_reply": ready(["google_business"]),

  "recruiter.acknowledge_and_collect": ready(["email"], { routine: true, ai: true }),
  "recruiter.decline_fixed_requirement": ready(["email"], {
    note: "Only on a yes/no or minimum you marked fixed and published, decided from the applicant's answers, never on judgment. Your published Terms and Security Overview say no agent rejects a worker; an applicant declined on a fixed requirement is the one opt-in exception. Rules on automated hiring decisions differ by state: have counsel review this, and that wording, before choosing anything above Ask me first.",
  }),
  "recruiter.run_interview": ready(["email"], { note: "Interviews are booked from your interview hours. Selestial doesn't check a calendar for conflicts yet." }),
  "recruiter.advance_candidate": missing("Recruiter never moves a candidate forward on its own. A person decides after screening or the interview."),
  "recruiter.send_invitation": ready(["email", "links"], { routine: true }),
  "recruiter.follow_up": ready(["email", "links"], { routine: true }),
  "recruiter.reply_inquiry": ready(["email", "links"], { routine: true }),
  "recruiter.interview_reminder": ready(["email", "links"], { routine: true }),
  "recruiter.answer_questions": ready(["email"], { routine: true, ai: true }),
  "recruiter.send_offer": ready(["email", "links"]),
  "recruiter.onboarding_reminder": ready(["outreach"], { routine: true }),
  "recruiter.urgent_outreach": ready(["email"]),

  "quality.review_completion": ready([], { routine: true, note: "A review never holds the visit, its invoice or anyone's pay. A manager still closes each visit." }),
  "quality.open_case": ready([], { routine: true }),
  "quality.request_cleaner_evidence": ready(["sms", "links"], { routine: true, note: "Only to cleaners who worked the visit, about that visit. It never says anything about fault." }),
  "quality.remind_outstanding": ready(["sms", "links"], { routine: true }),
  "quality.prepare_correction": ready([], { note: "Quality writes the scope and acceptance criteria. Retention arranges it, you set the crew's pay, and Dispatch staffs it." }),
  "quality.customer_clarification": ready(["links"], { note: "Quality prepares the question; Retention sends it to the customer under its own permission." }),
  "quality.verify_correction": ready([], { routine: true }),
  "quality.propose_improvement": ready([], { note: "A proposal only. You decide whether anything changes." }),
};

Object.assign(CAPABILITIES, {
  "care.answer_question": ready(["outreach"], { routine: true, ai: true, note: "Only what the visit, plan and invoice records say. It never gives an arrival estimate the record doesn't have." }),
  "care.acknowledge": ready(["outreach"], { routine: true, ai: true }),
  "care.send_invoice_link": ready(["outreach"], { routine: true, note: "The existing invoice's own link. Care never creates an invoice, marks one paid, refunds or charges." }),
  "care.complaint_intake": ready(["outreach"], { note: "Opens or joins Retention's recovery case for the visit, which starts Quality's investigation. Care states no finding, refund or re-clean time." }),
  "care.send_update": ready(["outreach"], { routine: true }),
  "care.update_preferences": ready([], { note: "A preference for one visit goes on that visit only. A standing one goes on the property or the client." }),
  "care.update_access": ready([], { note: "Written to the property's restricted access field. The code never appears in notices, summaries or the activity." }),
  "care.reschedule_visit": ready(["outreach"], { note: "Only times Dispatch's capacity check offers. Moving re-checks the time and the visit, then asks the crew again." }),
  "care.skip_visit": ready(["outreach"], { note: "One visit only. The rest of a recurring series is unchanged." }),
  "care.change_plan": ready(["outreach"], { note: "Through Retention's plan-change code, for exactly the visits the client was shown. Retention is told; it never delays a cancellation." }),
  "care.add_extra": ready(["outreach"], { note: "Only an extra the visit's service publishes, at the engine's price for that visit, after the client says yes. An extra that adds time lengthens the visit through Dispatch. Custom work goes to Sales." }),
  "care.apply_fee": missing("Care never applies a fee. When your policy sets one, the request comes to you; Finance adds it if you decide to."),
  "care.hand_off": ready([]),
} satisfies Record<string, Capability>);

export function capabilityOf(action: string): Capability {
  return CAPABILITIES[action] ?? missing("This isn't something an agent can do.");
}

export const AGENT_PLAYBOOK: Record<Agent, string> = {
  dispatch: "/app/agents/dispatch/playbook",
  sales: "/app/agents/sales/playbook",
  recruiter: "/app/agents/recruiter/hiring-setup",
  retention: "/app/agents/retention/playbook",
  quality: "/app/agents/quality/playbook",
  "customer-care": "/app/agents/customer-care/care-setup",
};
