/**
 * The words of a notice texted to a person (convex/lib/notify/route.ts): short, fixed, and never about a
 * customer, a cleaner or a message. Only events that need someone to act have words; the rest stay email.
 * Deterministic text: never written by an agent.
 */
import type { NoticeEvent } from "./catalog";

export const SMS_WORDS: Partial<Record<NoticeEvent, string>> = {
  security_change: "a security setting on your account changed.",
  approval_needed: "an agent is waiting for your approval.",
  approval_expiring: "an approval expires in two hours.",
  dispatch_escalation: "a visit needs attention now.",
  plan_payment_failed: "your Selestial plan payment was declined.",
  plan_access: "your Selestial plan needs payment.",
  credits_exhausted: "Selestial Credits ran out, so AI work is paused.",
  inbox_reconnect: "a connected inbox stopped working.",
  retention_serious: "a customer reported a serious concern.",
  retention_attention: "a customer case needs your decision.",
  quality_serious: "a possible safety or conduct concern needs you.",
  quality_attention: "a quality case needs your decision.",
  texting_attention: "business texting needs you.",
  quo_attention: "the connected Quo account stopped working.",
  service_attention: "something needs you to act.",
  recruiter_attention: "an applicant needs a reply.",
  care_urgent: "a client's request is urgent.",
  care_attention: "a client's request needs you.",
};
