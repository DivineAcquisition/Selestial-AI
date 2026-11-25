/**
 * Sample emails for the Email branding preview and the test email. Each one is written the way that
 * workflow's real message is written (the same shape of words, a link where the real one has a link), so
 * the preview shows what customers will actually get. All of it is invented: no name, address, price or
 * link here belongs to anyone. Links point at example.com.
 *
 * Only workflows that really email people through Selestial are listed. Dispatch offers jobs to cleaners
 * by text, so its sample is Recruiter's emailed job offer to an applicant instead.
 */
import { oneLine } from "./kit";

export const SAMPLE_IDS = ["booking_confirmation", "proposal", "visit_update", "application_link", "job_offer", "follow_up", "invoice"] as const;
export type SampleId = (typeof SAMPLE_IDS)[number];

export type Sample = {
  id: SampleId;
  /** What the owner picks from. */
  label: string;
  /** Which part of Selestial sends the real one. */
  sentBy: string;
  subject: string;
  body: string;
  reason: string;
};

const LINK = "https://example.com/sample";

export function sampleEmail(id: SampleId, companyName: string): Sample {
  const company = oneLine(companyName) || "Your company";
  switch (id) {
    case "booking_confirmation":
      return {
        id,
        label: "Booking confirmation",
        sentBy: "Booking pages",
        subject: `Your booking with ${company} is confirmed`,
        body: `Hi Jordan,\n\nYour booking with ${company} is confirmed for Tuesday, March 2 at 9:00 AM.\nTotal: $160.00.\n\nSee your booking and update access details here:\n${LINK}/booking\n\nThis link is private to you. Please don't forward it.`,
        reason: `You're getting this because you're a customer of ${company}.`,
      };
    case "proposal":
      return {
        id,
        label: "Quote or proposal",
        sentBy: "Sales",
        subject: `Your cleaning proposal from ${company}`,
        body: `Hi Jordan,\n\nThanks for walking us through your home. Here is the proposal for a recurring clean every two weeks, with the first deep clean included.\n\nYou can read it in full, ask for changes, or accept it online:\n${LINK}/proposal\n\nOpening it doesn't accept anything. Reply with any questions.`,
        reason: `You're getting this because you were in touch with ${company}.`,
      };
    case "visit_update":
      return {
        id,
        label: "Appointment update",
        sentBy: "Schedule (when a visit moves)",
        subject: `Your visit has moved`,
        body: `Hi Jordan,\n\nYour standard clean has moved from Tuesday at 9:00 AM to Wednesday at 10:00 AM, with arrival within 30 minutes of that time.\n\nIf the new time doesn't work, just reply to this email.`,
        reason: `You're getting this because you're a customer of ${company}.`,
      };
    case "application_link":
      return {
        id,
        label: "Applicant application link",
        sentBy: "Recruiter",
        subject: `Next step for the House Cleaner role at ${company}`,
        body: `Hi Sam,\n\nThanks for applying to ${company}. We'd like to learn a bit more about you for the House Cleaner role. The next step is a few short questions you can answer on your phone, about 10 minutes:\n${LINK}/apply\n\nThe link works for 7 days. If you have a question, reply to this email.`,
        reason: `You're getting this because you applied to ${company}.`,
      };
    case "job_offer":
      return {
        id,
        label: "Job offer to an applicant",
        sentBy: "Recruiter",
        subject: `Your offer from ${company}`,
        body: `Hi Sam,\n\nWe enjoyed meeting you and would like to offer you the House Cleaner role at ${company}, starting at $22.00 an hour.\n\nYou can read the offer and accept or decline it here:\n${LINK}/offer\n\nReply to this email with any questions.`,
        reason: `You're getting this because you applied to ${company}.`,
      };
    case "follow_up":
      return {
        id,
        label: "Customer follow-up",
        sentBy: "Sales and Retention",
        subject: `How did your first clean go?`,
        body: `Hi Jordan,\n\nThank you for choosing ${company}. How did your first service go? It takes a minute, and if anything wasn't right you can tell us there:\n${LINK}/feedback`,
        reason: `You're getting this because you're a customer of ${company}.`,
      };
    case "invoice":
      return {
        id,
        label: "Invoice or payment request",
        sentBy: "Finance",
        subject: `Invoice INV-1042 from ${company}`,
        body: `Hi Jordan,\n\nHere is your invoice INV-1042 for your standard clean on March 2: $160.00, due March 9.\n\nView and pay securely:\n${LINK}/pay\n\nThank you,\n${company}`,
        reason: `You're getting this because you're a customer of ${company}.`,
      };
  }
}

export function allSamples(companyName: string): Sample[] {
  return SAMPLE_IDS.map((id) => sampleEmail(id, companyName));
}
