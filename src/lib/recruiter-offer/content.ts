/**
 * The standalone Recruiter offer page (access host, /recruiter). Every claim here was checked against
 * the product on November 28, 2026:
 *
 *   Intake       a connected Gmail hiring inbox or label (convex/recruiterMailbox.ts, lib/recruiter/boundary.ts)
 *                and Recruiter application forms shared by link (app/agents/recruiter/forms).
 *   Job boards   Indeed and ZipRecruiter notification emails are recognised by sender and subject patterns
 *                that have NOT been checked against real samples (boundary.ts: UNVERIFIED). Nothing sources
 *                candidates or posts jobs.
 *   Gmail scope  gmail.readonly (the whole mailbox, as far as Google is concerned) and, optionally,
 *                gmail.send. Recruiter's own rule decides which messages it opens; others are skipped.
 *   Screening    criteria from the hiring need plus form knockouts, each with its evidence (lib/recruiter/screening.ts).
 *   Sending      invitations start on "review"; each kind of message can be switched to automatic; pausing
 *                Recruiter stops its sends (lib/recruiter/act.ts). Hiring decisions are never automatic.
 *   Fixed reqs   a plainly unmet published fixed requirement is raised and a decline PROPOSED for a person.
 *                Automatic decline exists but is held back pending legal review (lib/recruiter/decisions.ts),
 *                so this page does not offer it.
 *   Interviews   applicants pick from offered times; nothing is confirmed until a slot is reserved; reminders
 *                (lib/recruiter/interviews.ts).
 *   Onboarding   offers, agreements and a readiness checklist a person approves (lib/recruiter/settings.ts).
 *
 * BILLING: the $39 standalone plan is NOT in the billing catalog (billing/autumn.config.ts,
 * convex/lib/billing/catalog.ts), and no Recruiter-only checkout or onboarding exists. Until it does, the
 * page runs in "inquiry" mode: its actions open the working booking page, are labelled as a request, and
 * the page is kept out of search. Switching is one change to RECRUITER_CTA below.
 */
import { BOOK_CALL_PATH } from "@/lib/marketing/content";

export const RECRUITER_PRICE = "$39";
export const RECRUITER_PRICE_LINE = `${RECRUITER_PRICE}/month`;
export const SUPPORT_EMAIL = "support@selestial.io";

/**
 * Where every primary action goes, and how it is worded. ONE place.
 *
 *   inquiry   checkout is not open. Actions open the booking page (a real Cal.com calendar) and say so.
 *   checkout  set only once a Recruiter plan exists in the billing catalog AND a Recruiter entry flow that
 *             checks entitlements on the server. `path` is that flow's entry; it must never be the general
 *             sign-up, which ends in the full-platform checkout.
 */
export type RecruiterCta =
  | { mode: "inquiry"; path: typeof BOOK_CALL_PATH }
  | { mode: "checkout"; path: `/${string}` };

// `as`, not an annotation: the mode stays the union type, so code reading it works for either mode.
export const RECRUITER_CTA = { mode: "inquiry", path: BOOK_CALL_PATH } as RecruiterCta;

/** Labels for each mode. The page never shows a purchase label while checkout is closed. */
export const CTA_LABELS = {
  inquiry: {
    primary: "Request Recruiter access",
    compact: "Request access",
    note: "Online checkout for Recruiter isn’t open yet. Book a short call and the Selestial team will set up access with you.",
  },
  checkout: {
    primary: `Get Recruiter — ${RECRUITER_PRICE_LINE}`,
    compact: "Get Recruiter",
    note: "",
  },
} as const;

/** The offer is indexable only once someone can actually buy it. */
export const RECRUITER_INDEXABLE = RECRUITER_CTA.mode === "checkout";

/** Campaign parameters carried from this page to the next step (the booking page passes them to Cal.com). */
export const CAMPAIGN_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

export const META = {
  title: "Selestial Recruiter — AI recruiting for cleaning companies",
  description: "Organize applicants, keep follow-ups moving and bring new cleaners onboard with your own AI recruiter. You make the hiring decisions.",
};

export const NAV = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#included", label: "What’s included" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQs" },
];

export const HERO = {
  eyebrow: "AI recruiting for cleaning companies",
  headline: "Your next great cleaner shouldn’t get lost in your inbox.",
  highlight: "lost in your inbox.",
  supporting: "Organize applicants, keep follow-ups moving, and bring new cleaners onboard with your own AI recruiter. You make the hiring decisions.",
  secondary: "See how it works",
  reassurance: "Start with recruiting. Keep your existing cleaning software.",
};

export const PROBLEM = {
  headline: "Hiring shouldn’t become your second job.",
  items: [
    { title: "Applications everywhere", body: "Job-board notifications, direct emails and forms land in different places, and some never get a reply." },
    { title: "Applicants go quiet", body: "A good cleaner applies on Monday. By the time someone writes back on Thursday, they’ve taken another job." },
    { title: "Onboarding stalls", body: "You said yes, but the agreement, documents, training and supplies live in your head or a spreadsheet." },
  ],
  answer: "Recruiter gives every applicant a visible next step — who it’s waiting on, and when — so nobody slips through between the inbox, the interview and the first job.",
};

export type WorkflowStep = {
  id: "applications" | "screening" | "follow-up" | "interview" | "onboarding";
  label: string;
  receives: string;
  prepares: string;
  ownerSees: string;
  next: string;
};

export const WORKFLOW = {
  headline: "From first application to ready for onboarding.",
  intro: "Pick a step to see what Recruiter works with and what lands in front of you.",
  demoNote: "Demonstration with sample data — not a live applicant account.",
  steps: [
    {
      id: "applications",
      label: "Applications",
      receives: "A completed application form, or a recruiting email in your connected hiring inbox — including job-board notifications.",
      prepares: "One applicant record per person and role, with their contact details and every message about the application filed together.",
      ownerSees: "Maria Lopez — Residential Cleaner. Applied through your application link, Tuesday 9:14 AM.",
      next: "Screening against the requirements you set for the role.",
    },
    {
      id: "screening",
      label: "Screening",
      receives: "The applicant’s answers: experience, availability, service area, transport and anything else you ask.",
      prepares: "Each requirement marked meets, doesn’t meet or unclear — with the answer it came from.",
      ownerSees: "Weekday availability: meets (“Mon–Fri, 8–4”). Own transport: meets. Pet-friendly homes: unclear — not answered.",
      next: "A prepared invitation or follow-up for you to review.",
    },
    {
      id: "follow-up",
      label: "Follow-up",
      receives: "Where the application stands and how long it has waited.",
      prepares: "The next relevant message — an invitation, a reminder to finish the form, or an answer to their question.",
      ownerSees: "Interview invitation ready to review. Sends within your hours, from your hiring team’s name.",
      next: "It goes when you approve it, or by itself only for the message kinds you’ve switched to automatic.",
    },
    {
      id: "interview",
      label: "Interview",
      receives: "Your available interview times, and your calendar if you connect one.",
      prepares: "Times for the applicant to choose from, a reminder before the interview, and a note if they reschedule.",
      ownerSees: "Interview booked: Thursday 10:30 AM. Decision due within 48 hours of the interview.",
      next: "You decide: offer, hold or decline.",
    },
    {
      id: "onboarding",
      label: "Onboarding",
      receives: "Your decision to hire, and your onboarding checklist.",
      prepares: "The offer and agreement, then each onboarding item tracked to done.",
      ownerSees: "Agreement signed. Training done. Missing: payment details, equipment handover.",
      next: "You mark them ready for their first job once everything is in place.",
    },
  ] satisfies WorkflowStep[],
};

export const INCLUDED = {
  headline: "Everything between “I applied” and “I’m ready to start.”",
  items: [
    { title: "Know who applied", body: "Applicants from your application link and your hiring inbox, organized by role, with recruiting emails picked out of the rest." },
    { title: "See who fits your requirements", body: "Each answer checked against what you said the role needs, with the evidence beside it and unclear answers flagged." },
    { title: "Keep conversations moving", body: "Invitations, reminders and replies prepared for you, sent with your approval or by the rules you turn on." },
    { title: "Keep interviews organized", body: "Applicants choose from times you offer, reminders go out, and every interview shows its status." },
    { title: "Bring accepted cleaners onboard", body: "Offers and agreements tracked, your onboarding checklist followed, and readiness confirmed by you." },
  ],
};

export const GETTING_STARTED = {
  headline: "Start with the role you need to fill.",
  steps: [
    { title: "Tell us who you need", body: "Role, location, availability, pay and the requirements that matter to you." },
    { title: "Choose how applications arrive", body: "Share your application link, connect a Gmail hiring inbox, or both." },
    { title: "Let Recruiter organize the next steps", body: "Review findings, prepared messages and each applicant’s progress in one place." },
  ],
  note: "You don’t need to set up services, pricing, scheduling or the rest of your business to start recruiting.",
};

export const CONTROL = {
  headline: "Your standards. Your decisions. Your recruiter.",
  items: [
    { title: "You define the job", body: "Requirements, onboarding checklist, sending hours and the words your team uses are yours to set." },
    { title: "Screening shows its evidence", body: "Every judgment points to the answer it came from. Nothing is scored in the dark." },
    { title: "Messages follow your permissions", body: "Invitations start in review. You choose which kinds of message may go by themselves, and within which hours." },
    { title: "Unclear information is flagged", body: "Missing or ambiguous answers are marked unclear and brought to you, not guessed." },
    { title: "You can pause it", body: "Pause Recruiter and it stops sending. Applications keep arriving and stay organized." },
    { title: "People decide who is hired", body: "If an applicant plainly misses a fixed requirement you published, Recruiter proposes a decline — a person approves it." },
  ],
  inbox:
    "About your inbox: Google’s permission for reading Gmail covers the whole mailbox, and Selestial asks for read access (plus send access only if you want messages to go from your address). Recruiter applies its own rule to decide which messages it opens — recruiting mail is read, possible hiring mail is held for you to include or ignore, and everything else is skipped without being stored. A dedicated hiring inbox or Gmail label gives the clearest boundary.",
};

export const PRICING = {
  name: "Selestial Recruiter",
  description: "Your focused hiring workspace for a growing cleaning team.",
  included: [
    "Application forms with a shareable link",
    "Gmail hiring inbox or label, with recruiting emails organized into applicants",
    "Screening against your requirements, with evidence",
    "Prepared invitations, follow-ups and replies, within your permissions",
    "Interview times, booking and reminders",
    "Offers, agreements and your onboarding checklist through readiness",
  ],
  billing: "Billed monthly.",
  aiUsage: "AI work uses Selestial Credits. Recruiter’s monthly allowance hasn’t been published yet and will be shown here before checkout opens.",
  upsell: { title: "Need more than recruiting?", body: "Expand into the full Selestial workspace when you’re ready. Your recruiting records come with you." },
};

export const FAQ = {
  headline: "Questions owners ask",
  items: [
    {
      q: "Does Recruiter find new applicants for me?",
      a: "No. Recruiter manages the applicants who come to you — through your application link and the recruiting emails in your connected hiring inbox. Posting jobs and advertising on job boards stay with you or the job boards.",
    },
    {
      q: "Can I keep using my existing cleaning software?",
      a: "Yes. Recruiter is a starting point that covers hiring only. You don’t move your clients, bookings or scheduling into Selestial to use it.",
    },
    {
      q: "How does it work with Indeed and ZipRecruiter?",
      a: "There is no direct integration. When Indeed or ZipRecruiter emails an application notification to your connected hiring inbox, Recruiter recognises it and files it under the applicant. Recognition relies on those emails’ senders and subjects, and hasn’t yet been tested against every format they send; anything Recruiter isn’t sure about is held for you to review rather than dropped. Some boards hide applicants’ addresses behind relay emails, which can limit replying.",
    },
    {
      q: "Do I need to connect Gmail?",
      a: "No. You can start with your application link alone: applicants fill in your form and land in Recruiter. Connecting a Gmail hiring inbox or label adds the applications and replies that arrive by email.",
    },
    {
      q: "Do I need SMS or a phone number?",
      a: "No. Recruiter works by email and your application forms. Text messages are optional, need the applicant’s consent and a texting number, and are charged from a prepaid messaging balance.",
    },
    {
      q: "Does AI decide who gets hired?",
      a: "No. Recruiter organizes, checks answers against your requirements and prepares messages, always showing its evidence. Offers, holds and declines are decided by a person. You choose which routine messages may send by themselves.",
    },
    {
      q: "What is included in $39?",
      a: "Recruiter’s hiring workspace: application forms, the hiring inbox, screening, prepared communication, interviews and onboarding through readiness. AI work uses Selestial Credits — the Recruiter allowance will be published before checkout opens. Emails from your own connected Gmail have no Selestial delivery charge; emails sent through Selestial and text messages are charged from a prepaid messaging balance at the published rates below.",
    },
    {
      q: "Can I upgrade later?",
      a: "Yes. Moving to the full Selestial workspace keeps your recruiting records. The full workspace is a separate subscription; when you upgrade, the payment provider shows the prorated amount before you confirm.",
    },
    {
      q: "What happens if I pause recruiting?",
      a: "Pausing Recruiter stops it sending messages; applications still arrive and stay organized, and you can resume anytime. Pausing is not cancelling — your subscription continues until you cancel it.",
    },
  ],
};

export const FINAL = {
  headline: "Build your team. Get your time back.",
  body: "Start with one role and a clearer path from application to onboarding.",
};

export const FOOTER = {
  note: "Product previews on this page show demonstration data.",
  links: [
    { href: "/privacy", label: "Privacy" },
    { href: "/terms", label: "Terms" },
    { href: "/security", label: "Security" },
  ],
};

/**
 * The hero's agentic desk: Recruiter at the centre, where applications come from, and you. Each step is an
 * example of work the product does today (see the header of this file), with made-up names.
 */
export type DeskNode = "inbox" | "link" | "owner" | "onboarding";
export const DESK = {
  label: "Example of Recruiter at work, with demonstration data",
  title: "Recruiter is working",
  demo: "Demonstration data",
  waiting: "1 decision is waiting for you",
  clear: "Nothing is waiting on you",
  caption:
    "An example: Recruiter files a job-board notification from your hiring inbox, checks Jordan's application against your requirements, flags an unanswered question, prepares an interview invitation for you to approve, books the time Jordan picks, and starts onboarding for a cleaner who accepted an offer.",
  nodes: {
    inbox: { x: 14, y: 24, label: "Hiring inbox" },
    link: { x: 86, y: 24, label: "Application link" },
    owner: { x: 14, y: 76, label: "You" },
    onboarding: { x: 86, y: 76, label: "Onboarding" },
  } satisfies Record<DeskNode, { x: number; y: number; label: string }>,
  steps: [
    { id: "inbox", node: "inbox", actor: "recruiter", title: "Indeed notification in your hiring inbox", detail: "Residential Cleaner · new applicant", done: "Filed under Jordan Reyes" },
    { id: "form", node: "link", actor: "recruiter", title: "Jordan completed their application", detail: "Checking answers against your requirements", done: "Weekday availability matches your role" },
    { id: "unclear", node: "link", actor: "recruiter", title: "Pet-friendly homes: not answered", detail: "Looking for an answer in the application", done: "Flagged for you as unclear" },
    { id: "invite", node: "owner", actor: "owner", title: "Interview invitation ready to review", detail: "Approve, edit or hold", done: "Approved by you · sent within your hours" },
    { id: "interview", node: "inbox", actor: "recruiter", title: "Jordan picked Thursday 10:30", detail: "Reserving the time", done: "Interview booked · reminder set" },
    { id: "onboard", node: "onboarding", actor: "recruiter", title: "Maria accepted your offer", detail: "Starting your onboarding checklist", done: "Agreement signed · payment details missing" },
  ] as const,
};

/**
 * The permissions panel: Recruiter's real actions and the levels an owner can give each
 * (convex/lib/permissionCatalog.ts). A ceiling of "propose" means a person approves every time.
 */
export const PERMISSIONS = {
  title: "What may Recruiter do by itself?",
  actionLabel: "Pick a task",
  levelLabel: "Your setting",
  note: "An example of the setting, not your account. Messages always follow your sending hours, and anything above your setting waits for you.",
  levels: [
    { id: "off", label: "Off", body: "Recruiter doesn’t do this. It stays a task for your team." },
    { id: "propose", label: "Propose", body: "Recruiter prepares it and waits. Nothing happens until you approve." },
    { id: "execute_and_report", label: "Act & report", body: "Recruiter does it within your sending hours and tells you each time." },
    { id: "execute", label: "Act", body: "Recruiter does it within your sending hours and records it in the applicant’s history." },
  ],
  actions: [
    { id: "send_invitation", label: "Email an applicant the application link", ceiling: "execute" },
    { id: "follow_up", label: "Remind about an unfinished application", ceiling: "execute" },
    { id: "answer_questions", label: "Answer a routine question from your hiring FAQ", ceiling: "execute" },
    { id: "interview_reminder", label: "Remind an applicant of their interview", ceiling: "execute" },
    { id: "send_offer", label: "Send a hiring offer", ceiling: "propose", locked: "Offers always wait for your approval." },
    { id: "decline_fixed", label: "Decline someone who misses a fixed requirement", ceiling: "propose", locked: "Recruiter proposes the decline; a person approves it." },
  ],
} as const;
