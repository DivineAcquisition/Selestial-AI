/**
 * What each agent may do, action by action (brief, sections 7 and 11 to 14). The catalog is code: an
 * owner chooses a level per action, and cannot invent an action or lift one past its ceiling.
 * Permission to send a reminder does not grant permission to discount a service.
 */
import { literals, type Agent } from "./statuses";

export const LEVELS = ["off", "propose", "execute_and_report", "execute"] as const;
export type Level = (typeof LEVELS)[number];
export const levelValidator = literals(LEVELS);

export function rank(level: Level): number {
  return LEVELS.indexOf(level);
}

export type ActionDef = {
  key: string;
  agent: Agent;
  label: string;
  /** The level the brief names as the default once the company trusts this action. */
  standard: Level;
  /** The most an owner may grant. "propose" means a person approves every time. */
  ceiling: Level;
  /** A customer, cleaner or applicant sees the result. These start on Propose in every new company. */
  outsider: boolean;
  /** Money moves. The owner sets a limit per action and per day. */
  money: boolean;
};

const action = (key: string, agent: Agent, label: string, standard: Level, options: Partial<Pick<ActionDef, "ceiling" | "outsider" | "money">> = {}): ActionDef => ({
  key,
  agent,
  label,
  standard,
  ceiling: options.ceiling ?? "execute",
  outsider: options.outsider ?? true,
  money: options.money ?? false,
});

export const ACTIONS: readonly ActionDef[] = [
  action("dispatch.request_acceptance", "dispatch", "Send the first offers for a visit", "execute"),
  action("dispatch.send_replacement_offer", "dispatch", "Offer a visit to the next cleaner after a no or no answer", "execute"),
  action("dispatch.run_backup_coverage", "dispatch", "Find cover when a cleaner drops out or does not arrive", "execute_and_report"),
  action("dispatch.broadcast_offer", "dispatch", "Ask several cleaners at once for one opening", "propose"),
  action("dispatch.declare_no_show", "dispatch", "Declare a no-show once the contact steps have run", "propose", { outsider: false }),
  action("dispatch.request_urgent_hire", "dispatch", "Ask Recruiter for an urgent hire", "execute", { outsider: false }),
  action("dispatch.send_reminder", "dispatch", "Send reminders and confirmations", "execute"),
  action("dispatch.act_on_cleaner_reply", "dispatch", "Act on a cleaner's text: running late, can't come, or declining an offer", "execute_and_report", { ceiling: "execute_and_report" }),
  action("dispatch.notify_running_late", "dispatch", "Tell a customer a visit is running late", "execute_and_report"),
  action("dispatch.close_visit", "dispatch", "Close a visit on clean evidence", "execute_and_report", { outsider: false }),
  action("dispatch.reassign_confirmed_visit", "dispatch", "Reassign a confirmed visit", "propose"),
  action("dispatch.availability_check_in", "dispatch", "Ask cleaners to confirm their availability, and check in with cleaners who have had no work", "execute"),
  action("dispatch.override_time_between_jobs", "dispatch", "Override the time-between-jobs rule", "propose", { ceiling: "propose", outsider: false }),

  action("sales.reply_and_quote", "sales", "Reply, collect details and send a quote from the rules", "execute"),
  action("sales.follow_up", "sales", "Send follow-up messages", "execute"),
  action("sales.discount_in_band", "sales", "Discount inside the allowed band", "execute_and_report", { money: true }),
  action("sales.draft_ad_campaign", "sales", "Draft a Google Ads campaign (costs nothing; the Owner approves and turns it on)", "execute", { outsider: false }),
  action("sales.confirm_booking", "sales", "Book an accepted quote: hold the time and send the customer the booking steps", "execute_and_report"),
  action("sales.discount_out_of_band", "sales", "Discount outside the band, custom or commercial price", "propose", { ceiling: "propose", money: true }),

  action("retention.request_feedback", "retention", "Request feedback, invite a review, send reminders", "execute"),
  action("retention.offer_recurring_plan", "retention", "Offer a recurring plan at the standard price", "execute"),
  action("retention.recover_payment", "retention", "Payment recovery messages and retries", "execute", { money: true }),
  action("retention.remedy_within_limit", "retention", "Re-clean or credit inside the limit", "execute_and_report", { money: true }),
  action("retention.refund_above_limit", "retention", "Refund or compensation above the limit", "propose", { ceiling: "propose", money: true }),
  action("retention.cancel_on_request", "retention", "Cancel on the customer's request", "execute"),
  action("retention.send_case_message", "retention", "Write to a customer about an open concern: acknowledge it, ask a question, explain the scope, or ask whether a correction worked", "execute_and_report"),
  action("retention.apply_plan_change", "retention", "Carry out a customer's own request to skip, pause or resume their recurring service", "execute_and_report"),
  action("retention.reactivation_offer", "retention", "Send a return offer to an eligible former customer", "propose", { ceiling: "execute_and_report" }),
  action("retention.hand_off", "retention", "Hand work on a case to Dispatch, Sales, Quality or Finance", "execute", { outsider: false }),
  action("retention.draft_review_reply", "retention", "Draft replies to Google reviews (a person approves before anything is posted)", "execute", { outsider: false }),

  // Quality (convex/lib/quality). A finding, a disciplinary decision, a pay change or a serious-incident
  // decision is never an action here: findings are suggested and reviewed by a person, and the rest is PERSON_ONLY.
  action("quality.review_completion", "quality", "Review a completed visit against the standard that applied and recommend approval, a request or an investigation (the manager still closes the visit)", "execute", { outsider: false }),
  action("quality.request_cleaner_evidence", "quality", "Ask a cleaner for a missing photo, a short answer, or their account of what happened, through a private link", "execute_and_report"),
  action("quality.remind_outstanding", "quality", "Remind the person responsible about a quality request they have not answered", "execute_and_report"),
  action("quality.open_case", "quality", "Open a quality case from a review, a report, a conversation or a confirmed pattern", "execute", { outsider: false }),
  action("quality.prepare_correction", "quality", "Prepare a correction's scope and acceptance criteria and hand it to Retention to arrange with the customer", "execute_and_report", { outsider: false }),
  action("quality.customer_clarification", "quality", "Prepare a focused question for a customer and hand it to Retention, which owns the conversation", "propose", { ceiling: "execute_and_report" }),
  action("quality.verify_correction", "quality", "Verify a correction visit's record against the acceptance criteria", "execute", { outsider: false }),
  action("quality.propose_improvement", "quality", "Propose a change to a checklist, booking question, scope wording, training or inspection frequency (a person decides)", "execute", { ceiling: "execute", outsider: false }),

  action("recruiter.acknowledge_and_collect", "recruiter", "Acknowledge, answer questions, request missing details", "execute"),
  // An owner opt-in (decided November 15 and confirmed November 22, 2026): only a published fixed requirement, decided in code from the answers.
  action("recruiter.decline_fixed_requirement", "recruiter", "Decline an applicant who doesn't meet a published fixed requirement (decided from their answers, never on judgment)", "execute_and_report"),
  action("recruiter.run_interview", "recruiter", "Coordinate and run the interview", "execute"),
  action("recruiter.advance_candidate", "recruiter", "Move a candidate forward, mark a cleaner ready", "propose", { ceiling: "propose", outsider: false }),
  action("recruiter.send_invitation", "recruiter", "Email an applicant the application link", "execute"),
  action("recruiter.follow_up", "recruiter", "Remind an applicant about an unfinished application", "execute"),
  action("recruiter.reply_inquiry", "recruiter", "Reply to someone asking about work with the open roles and the application link", "execute"),
  action("recruiter.interview_reminder", "recruiter", "Remind an applicant of their booked interview", "execute"),
  action("recruiter.answer_questions", "recruiter", "Answer an applicant's routine question from the role's approved details and the Hiring FAQ", "execute"),
  action("recruiter.send_offer", "recruiter", "Send a hiring offer on terms the Owner approved", "propose", { ceiling: "propose" }),
  action("recruiter.onboarding_reminder", "recruiter", "Remind a new cleaner about onboarding steps they still need to finish", "execute"),
  action("recruiter.urgent_outreach", "recruiter", "Contact existing applicants about an urgent staffing need", "propose", { ceiling: "propose" }),
];

/** These need a person at any setting. They are not permissions, so nothing can switch them on. */
export const PERSON_ONLY: readonly { key: string; label: string }[] = [
  // This label is the published wording of the Terms and the Security Overview (src/lib/trust/documents), and a
  // test holds them equal. It changes only with a new published version, which the Owner dates. Declining an
  // applicant on a published fixed requirement (recruiter.decline_fixed_requirement) is an Owner opt-in that
  // Agent Controls shows with a legal-review caution; nothing decided on judgment is ever an agent's.
  { key: "person.cleaner_consequence", label: "Any consequence for a cleaner, including rejecting or ending a worker" },
  { key: "person.after_background_check", label: "Any decision that follows a background check" },
  { key: "person.pay_run", label: "Paying out a pay run" },
  { key: "person.change_prices_pay_policies", label: "Changing prices, pay rates or policies" },
  { key: "person.legal_injury_damage_dispute", label: "Anything legal, an injury, property damage or a payment dispute" },
];

const BY_KEY = new Map(ACTIONS.map((def) => [def.key, def]));

export function actionDef(key: string): ActionDef | undefined {
  return BY_KEY.get(key);
}

/** Every company starts with review: anything an outsider sees begins on Propose, whatever it loosens to later. */
export function initialLevel(def: ActionDef): Level {
  return def.outsider && rank(def.standard) > rank("propose") ? "propose" : def.standard;
}
