/**
 * The operating rules behind each permission, in one line, read from the settings the playbooks already
 * edit (docs/foundation/07-agent-controls.md §Rules). Nothing here is a new rule: each sentence describes a
 * setting the agent's own code enforces, and links to where it is changed.
 */
import type { Doc } from "../../_generated/dataModel";
import { dispatchPolicy } from "../dispatch/policy";
import { dispatchSettings } from "../dispatch/settings";
import { recruiterSettings } from "../recruiter/settings";
import { retentionSettings } from "../retention/settings";
import { salesSettings } from "../sales/settings";
import { AGENT_PLAYBOOK } from "./capabilities";

export type Rule = { words: string; href: string };

const hours = (list: number[]) => (list.length ? list.map((h) => (h % 24 === 0 ? `${h / 24} day${h === 24 ? "" : "s"}` : `${h} h`)).join(", then ") : "never");
const minutes = (m: number) => (m >= 120 && m % 60 === 0 ? `${m / 60} hours` : `${m} minutes`);

export function ruleFor(action: string, company: Doc<"companies">): Rule | null {
  const sales = () => salesSettings(company);
  const dispatch = () => ({ ...dispatchSettings(company), ...dispatchPolicy(company) });
  const retention = () => retentionSettings(company);
  const recruiter = () => recruiterSettings(company);
  switch (action) {
    case "sales.reply_and_quote": {
      const s = sales();
      return { words: `Quotes only from your published prices for ${s.eligibility.kinds.join(", ").replace(/_/g, " ")} work${s.eligibility.commercialNeedsWalkthrough ? "; commercial work needs a walkthrough" : ""}. Quotes stay valid ${s.quotes.validDays} days${s.quotes.reviewAboveCents !== null ? `, and any over $${(s.quotes.reviewAboveCents / 100).toFixed(0)} waits for review` : ""}.`, href: AGENT_PLAYBOOK.sales };
    }
    case "sales.follow_up": {
      const s = sales().followUp;
      return { words: `Using your sequence: quotes after ${hours(s.quoteHours)}; missing details after ${hours(s.missingInfoHours)}. Stops when the customer replies or a person takes over.`, href: AGENT_PLAYBOOK.sales };
    }
    case "sales.confirm_booking": {
      const s = sales().booking;
      return { words: `Holds the time ${minutes(s.holdMinutes)}, needs ${s.minimumNoticeHours} hours' notice${s.agreementRequired ? ", and sends your agreement" : ""}. Deposit: ${s.deposit.kind === "none" ? "none" : "as your playbook says"}.`, href: AGENT_PLAYBOOK.sales };
    }
    case "dispatch.request_acceptance":
      return { words: `Looks ${dispatch().lookAheadDays} days ahead; each cleaner has ${minutes(dispatch().offerWindowMinutes)} to answer, with ${minutes(dispatch().travelBufferMinutes)} kept between jobs.`, href: AGENT_PLAYBOOK.dispatch };
    case "dispatch.send_replacement_offer":
    case "dispatch.run_backup_coverage":
      return { words: `Backup offers wait ${minutes(dispatch().backupOfferWindowMinutes)} for an answer before the next cleaner is asked.`, href: AGENT_PLAYBOOK.dispatch };
    case "dispatch.broadcast_offer": {
      const d = dispatch();
      return { words: d.broadcastEnabled ? `Asks ${d.broadcastSize} cleaners at once; the first to accept gets it.` : "Asking several cleaners at once is switched off in the playbook, so this never runs.", href: AGENT_PLAYBOOK.dispatch };
    }
    case "dispatch.send_reminder":
      return { words: `Reminders go ${minutes(dispatch().reminderLeadMinutes)} before the start.`, href: AGENT_PLAYBOOK.dispatch };
    case "dispatch.declare_no_show": {
      const d = dispatch();
      return { words: `Asks the cleaner after ${d.contactAfterMinutes} min, alerts you after ${d.alertAfterMinutes} min, and only then considers a no-show at ${d.noShowAfterMinutes} min.`, href: AGENT_PLAYBOOK.dispatch };
    }
    case "retention.remedy_within_limit": {
      const r = retention();
      return { words: r.guarantee ? `Inside your ${r.guarantee.days}-day guarantee: "${r.guarantee.text.slice(0, 90)}${r.guarantee.text.length > 90 ? "…" : ""}"` : "No guarantee is set in the playbook, so each remedy is weighed case by case.", href: AGENT_PLAYBOOK.retention };
    }
    case "retention.send_case_message":
      return { words: `Concerns are answered within ${retention().recoveryDueHours} hours; a person always handles safety, damage or legal concerns.`, href: AGENT_PLAYBOOK.retention };
    case "retention.request_feedback": {
      const r = retention();
      return { words: `${r.feedbackAfterFirstService ? "Asks after the first service" : "Asks after services"}, and leaves at least ${r.quietDays} days between asks.`, href: AGENT_PLAYBOOK.retention };
    }
    case "retention.apply_plan_change":
      return { words: `Customers may: ${retention().selfService.join(", ").replace(/_/g, " ")} (only what they ask for, as previewed to them).`, href: AGENT_PLAYBOOK.retention };
    case "recruiter.send_invitation": {
      const r = recruiter();
      return { words: r.invitationMode === "auto" ? "Your recruiting rules say to invite eligible applicants as they arrive." : "Your recruiting rules say a person reviews each applicant before an invitation, so this waits for review whatever its level.", href: AGENT_PLAYBOOK.recruiter };
    }
    case "recruiter.follow_up": {
      const r = recruiter();
      return { words: `Reminds after ${hours(r.followUpHours)}, at most ${r.maxFollowUps} times, only inside your sending hours.`, href: AGENT_PLAYBOOK.recruiter };
    }
    case "recruiter.run_interview": {
      const r = recruiter();
      return { words: `${r.interviewMinutes}-minute interviews from your open times; a reminder ${r.interviewReminderHours} hours before.`, href: AGENT_PLAYBOOK.recruiter };
    }
    case "recruiter.decline_fixed_requirement":
      return { words: "Only requirements you marked fixed on a published role. Anything else is a person's decision.", href: AGENT_PLAYBOOK.recruiter };
    default:
      return null;
  }
}
