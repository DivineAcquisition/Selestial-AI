import { writeFileSync } from "node:fs";

import { getFunctionName } from "convex/server";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CompanyProvider } from "@/components/app/company";

const data: Record<string, unknown> = {};
let search = "";
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => (args === "skip" ? undefined : data[getFunctionName(ref)]),
  useMutation: () => async () => undefined,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/app/agents/recruiter", useRouter: () => ({ replace: () => undefined, push: () => undefined }), useSearchParams: () => new URLSearchParams(search) }));

const { RecruiterOverviewScreen } = await import("./overview");
const { ApplicantsScreen } = await import("./applicants");
const { ScreeningScreen } = await import("./screening");
const { InterviewsScreen } = await import("./interviews");
const { OffersScreen } = await import("./offers");
const { OnboardingScreen } = await import("./onboarding");
const { HiringNeedsScreen } = await import("./hiring-needs");
const { HiringSetupScreen } = await import("./hiring-setup");
const { FormsHome } = await import("../../recruiter-forms/home");
const { FormBuilder } = await import("../../recruiter-forms/builder");
const { ApplicationForm } = await import("../../../applicant/form/application-form");
const { parseRecipients } = await import("../../recruiter-forms/send-dialog");
const { standardCleanerForm } = await import("../../../../../convex/lib/recruiter/formTemplates");
const { fieldsFor, sectionsFor } = await import("../../../../../convex/lib/recruiter/form");

const DAY = 86_400_000;
const T = Date.UTC(2026, 10, 16, 15);
const row = (id: string, name: string, stage: string, extra: Record<string, unknown> = {}) => ({
  applicationId: id,
  applicantId: `p${id}`,
  name,
  role: "House Cleaner",
  roleSeen: "House Cleaner",
  roleStatus: "open",
  source: "indeed",
  stage,
  appliedAt: T - 2 * DAY,
  contact: { status: "direct", words: "Email address given in the application.", address: `${name.split(" ")[0].toLowerCase()}@example.test`, bounced: false },
  completion: { invitedAt: T - 2 * DAY, startedAt: T - DAY, submittedAt: stage === "invited" ? null : T - DAY / 2 },
  nextAction: { by: "recruiter", what: "Send a reminder if the form is not finished", dueAt: T + DAY },
  withPerson: false,
  waitingOnReply: false,
  closure: null,
  detailsRemoved: false,
  ...extra,
});
const screening = {
  _id: "s1",
  _creationTime: T,
  companyId: "c",
  createdAt: T,
  applicationId: "a2",
  needId: "n1",
  summary: { experience: "3 years cleaning homes and offices", availability: "Weekdays 8–4", met: ["Transportation", "Experience"], concerns: ["Weekend availability unclear"], suggestedNextStep: "Invite to an interview this week." },
  results: [
    { key: "transport", label: "Has reliable transportation", source: "application form", outcome: "meets", evidence: "I have my own car", fixed: true },
    { key: "experience", label: "At least 1 year of cleaning", source: "application form", outcome: "meets", evidence: "3 years at Sparkle Co.", fixed: false },
    { key: "weekends", label: "Available some weekends", source: "application form", outcome: "needs_clarification", evidence: "Mostly weekdays", fixed: false },
  ],
  missing: [],
  contradictions: [],
  recommendation: "advance",
};
const rows = [
  row("a1", "Maria Lopez", "invited", { nextAction: { by: "applicant", what: "Finish the application form", dueAt: T + DAY }, waitingOnReply: true }),
  row("a2", "Dana Cole", "screening", { withPerson: true, nextAction: { by: "owner", what: "Decide whether to interview", dueAt: T + DAY } }),
  row("a3", "Lee Wong", "interview", { nextAction: { by: "recruiter", what: "Confirm the interview time" } }),
  row("a4", "Sam Ortiz", "received", { contact: { status: "relay", words: "Only a job-board relay address so far.", address: "x@indeedemail.com", bounced: false } }),
  row("a5", "Ava Chen", "offer_sent"),
  row("a6", "Noah Kim", "onboarding_handoff"),
];

function fill() {
  data["recruiter:overview"] = {
    asOf: T,
    openHiringNeeds: 2,
    newApplications: 1,
    contactNeeded: 0,
    invitationsAwaitingApproval: 0,
    incompleteNeedingFollowUp: 0,
    incompleteApplications: 1,
    awaitingScreening: 1,
    awaitingInterview: 1,
    decisionsAwaitingOwner: 1,
    offersOut: 1,
    awaitingOnboardingHandoff: 0,
    inOnboarding: 1,
    inbox: [{ connectionId: "m1", address: "hiring@alpha-cleaning.test", provider: "gmail", status: "connected", problem: null, lastSyncAt: T - 600_000, connectorBuilt: true, sendsApplicantEmail: true, discovery: "label", label: "Hiring" }],
    inboxConnected: true,
    failures: { messages: 0, flaggedMessages: 0, mailboxes: 0 },
    connections: { applicantLinks: true, email: "resend", texting: null, calendar: null, signing: null, reader: "claude" },
    paused: false,
    gmailAvailable: true,
  };
  data["applications:list"] = rows;
  const finding = (id: string, applicationId: string, name: string, kind: string, status: string, extra: Record<string, unknown> = {}) => ({
    findingId: id,
    applicationId,
    kind,
    status,
    name,
    role: "House Cleaner",
    source: "ZipRecruiter",
    stage: "received",
    headline: `${name} applied for House Cleaner`,
    explanation: "ZipRecruiter. Not provided yet: availability.",
    reported: [`${name.split(" ")[0]} reports: "two years of cleaning experience".`],
    missing: ["Availability"],
    next: "Send your application link to collect their availability, experience and service area.",
    prepared: { kind: "application_link", channel: "email", to: `${name.split(" ")[0].toLowerCase()}@example.test`, toKind: "direct", subject: "Next step for your House Cleaner application at Alpha Cleaning", body: "Hi,\n\nPlease complete our application:\n{link}", preview: "Hi,\n\nPlease complete our application:\n[your application link]", link: "apply", reason: "Collects what you need.", limitation: null, writtenBy: "template" },
    scheduledFor: null,
    draft: null,
    outcome: null,
    automatic: false,
    delivery: null,
    discoveredAt: T - 3_600_000,
    updatedAt: T - 3_600_000,
    ...extra,
  });
  data["recruiterFindings:list"] = {
    open: [
      finding("f1", "a7", "Maria Ruiz", "new_application", "ready"),
      finding("f2", "a8", "Jo Park", "new_application", "ready"),
      finding("f3", "a4", "Sam Ortiz", "contact_needed", "needs_attention", { headline: "Sam Ortiz applied for House Cleaner, with no address to write to", next: "Open the application on the job board and enter the applicant's email address.", prepared: null }),
      finding("f4", "a1", "Maria Lopez", "incomplete_application", "scheduled", { headline: "Maria Lopez has not finished the House Cleaner application", scheduledFor: T + DAY, prepared: null }),
    ],
    outcomes: [finding("f5", "a5", "Ava Chen", "new_application", "sent", { outcome: "Accepted by the email service. Delivery is not confirmed yet.", delivery: { status: "sent", deliveredAt: null, bouncedAt: null } })],
  };
  data["recruiterFindings:forApplication"] = [finding("f9", "a2", "Dana Cole", "decision_needed", "needs_attention", { headline: "Dana Cole finished the House Cleaner application", next: "Review it and decide: interview, hold, offer or decline.", prepared: null })];
  data["recruiter:inboxRuns"] = [{ connectionId: "m1", address: "hiring@alpha-cleaning.test", status: "connected", problem: null, lastSyncAt: T - 600_000, runs: [{ startedAt: T - 600_000, finishedAt: T - 590_000, outcome: "read", filed: 4, opened: 2, possible: 1, problem: null }] }];
  data["recruiterPossible:list"] = [{ sourceMessageId: "sm1", from: "pat@example.test", subject: "Quick question about a job", why: "The subject might be about work.", receivedAt: T - 7_200_000, expiresAt: T + 13 * DAY, mailbox: "hiring@alpha-cleaning.test", openUrl: "https://mail.google.com/mail/u/?authuser=hiring%40alpha-cleaning.test#all/abc" }];
  data["recruiterAutomation:list"] = {
    paused: false,
    items: [
      { key: "application_links", action: "recruiter.send_invitation", title: "Send application links to new applicants", trigger: "A new application arrives.", message: "Your application invitation.", stops: "Not sent when the address is unclear.", on: false, level: "Ask me first", limitation: null },
      { key: "routine_answers", action: "recruiter.answer_questions", title: "Answer routine questions", trigger: "An applicant asks something.", message: "A drafted reply (1 credit).", stops: "Never answers what isn't approved.", on: true, level: "Act automatically", limitation: null },
    ],
  };
  data["recruiter:playbook"] = { settings: { invitationMode: "review", followUpHours: [48, 120], maxFollowUps: 2, sendFromMinute: 540, sendUntilMinute: 1080, sendDays: [1, 2, 3, 4, 5], fromName: "Alpha Cleaning Hiring Team", replyTo: "hiring@alpha-cleaning.test", verifiedRelays: [], linkTtlDays: 14, offerTtlDays: 7, retentionDays: 365, interviewMinutes: 30, interviewReminderHours: 24, decideWithinHours: 48, onboardingRequirements: [{ key: "agreement", label: "Agreement completed" }], recruitingRules: null, communicationPolicy: null, escalationRules: null, hiringFaq: "Supplies: we provide all supplies." }, timezone: "America/Chicago", connections: {} };
  data["recruiter:staffingRequests"] = [{ taskId: "t1", kind: "urgent_hire", title: "Two cleaners needed for Saturday", what: "Coverage gap on three visits", dueAt: T + DAY, about: null }];
  data["permissions:list"] = { pausedAgents: [] };
  data["approvals:pending"] = [];
  data["applications:get"] = {
    ...rows[1],
    applicant: { name: "Dana Cole", email: "dana@example.test", phone: "+1 512 555 0101", location: "Austin, TX", mayBeTexted: true, doNotContact: null, possibleDuplicateOf: null },
    contactEvidence: [{ kind: "direct", address: "dana@example.test", where: "body: labelled Email" }],
    facts: [{ value: "3 years", from: "message", field: "Experience", where: "Indeed notification" }],
    form: { savedAt: T, submittedAt: T - DAY / 2, answers: [{ key: "car", label: "Do you have a car?", answer: "Yes, my own car" }], answered: 4, required: 4 },
    attachments: [{ attachmentId: "f1", kind: "resume", fileName: "Dana-Cole-resume.pdf", size: 52_000, uploadedAt: T, verified: false }],
    conversation: [
      { direction: "in", at: T - 2 * DAY, classification: "new_application", classifiedBy: "model", source: "indeed", subject: "New application for House Cleaner", excerpt: "Dana Cole applied to House Cleaner.", flag: null, attachments: [] },
      { direction: "out", at: T - 2 * DAY + 3_600_000, purpose: "application_invitation", channel: "email", subject: "Next step for your House Cleaner application", status: "delivered", sentAt: T - 2 * DAY, deliveredAt: T - 2 * DAY, bouncedAt: null, problem: null },
    ],
    remindersSent: 1,
    screening,
    interviews: [],
    offers: [],
    handoff: null,
    decisions: [],
  };
  data["applications:screeningQueue"] = [{ ...rows[1], screening }];
  data["hiringNeeds:list"] = [
    { _id: "n1", _creationTime: T, title: "House Cleaner", companyId: "c", createdBy: "m", createdAt: T, status: "open", location: "Austin, TX", questions: [], engagement: "contractor", requiredSkills: [], titleAliases: [], responsibilities: "Residential cleaning: kitchens, bathrooms, floors and dusting, following each home's checklist.", serviceTypes: ["standard"], coverageAreas: [], requiredAvailability: "Weekdays", openings: 3, criteria: screening.results.map((r) => ({ key: r.key, label: r.label, field: r.key, fixed: r.fixed, test: { kind: "person_reviews" } })), applications: 6, active: 5, hired: 1, compensation: { approvedBy: "m", approvedAt: T, pay: { kind: "hourly", hourlyCents: 2200 } } },
    { _id: "n2", _creationTime: T, title: "Deep-Clean Specialist", companyId: "c", createdBy: "m", createdAt: T, status: "paused", location: "Round Rock, TX", questions: [], engagement: "employee", requiredSkills: [], titleAliases: [], responsibilities: "Move-out and deep cleans.", serviceTypes: [], coverageAreas: [], requiredAvailability: "Weekends", openings: 1, criteria: [], applications: 0, active: 0, hired: 0 },
  ];
  data["interviews:board"] = {
    interviews: [
      { interviewId: "i1", applicationId: "a3", applicant: "Lee Wong", status: "confirmed", startsAt: T + DAY, endsAt: T + DAY + 1_800_000, interviewer: "Owner A", how: "Phone", reschedules: 0, reminderQueuedAt: null, feedback: null, inCalendar: false },
      { interviewId: "i2", applicationId: "a2", applicant: "Dana Cole", status: "awaiting_slots", startsAt: null, endsAt: null, interviewer: null, how: null, reschedules: 0, reminderQueuedAt: null, feedback: null, inCalendar: false },
    ],
    slots: [{ slotId: "sl1", interviewerId: "m", startsAt: T + 2 * DAY, endsAt: T + 2 * DAY + 1_800_000, status: "open" }],
    offerable: 1,
    calendar: null,
    timezone: "America/Chicago",
  };
  data["members:list"] = [{ id: "m", name: "Owner A", email: "a@example.test", role: "owner", status: "active" }];
  data["hiringOffers:board"] = {
    rows: [{ applicationId: "a5", applicant: "Ava Chen", role: "House Cleaner", stage: "offer_sent", approvedTerms: { engagement: "contractor", pay: "$22.00 an hour", approvedAt: T }, offers: [{ offerId: "o1", status: "sent", pay: "$22.00 an hour", terms: { role: "House Cleaner", engagement: "contractor", pay: { kind: "hourly", hourlyCents: 2200 }, startConditions: "After one shadow shift", expectations: "Three days a week" }, approvalId: null, sentAt: T, expiresAt: T + 5 * DAY, respondedAt: null, agreement: { status: "not_started" } }], handoff: null, nextAction: { by: "applicant", what: "Answer the offer" } }],
    signing: null,
  };
  data["onboarding:queue"] = [
    { handoffId: "h1", applicationId: "a6", applicant: "Noah Kim", role: "House Cleaner", approvedTerms: { payWords: "$22.00 an hour", role: "House Cleaner", engagement: "contractor", pay: { kind: "hourly", hourlyCents: 2200 }, startConditions: "", expectations: "" }, information: [], requirements: [{ key: "agreement", label: "Agreement signed", status: "done" }, { key: "background", label: "Background check recorded", status: "outstanding" }, { key: "availability", label: "Availability confirmed", status: "done" }], responsible: "Owner A", nextAction: "Record the background check", dueAt: T + 3 * DAY, status: "open", cleanerId: "cl1", workerStatus: "onboarding", dispatchReady: false,
      readiness: {
        items: [
          { key: "agreement", label: "Agreement signed", state: "approved", fromRecord: false, blocksWork: true, confirmedBy: "Owner A", confirmedAt: T - DAY, note: null },
          { key: "background", label: "Background check recorded", state: "received", fromRecord: false, blocksWork: true, confirmedBy: null, confirmedAt: null, note: null },
          { key: "availability", label: "Weekly availability", state: "approved", fromRecord: true, blocksWork: true, confirmedBy: null, confirmedAt: null, note: null },
          { key: "service_areas", label: "Service areas", state: "missing", fromRecord: true, blocksWork: true, confirmedBy: null, confirmedAt: null, note: null },
        ],
        decisions: [],
        skillsConfirmed: [],
        serviceAreas: [],
        canApprove: false,
        approved: false,
        stillNeeded: ["Background check recorded (received)", "Service areas (missing)"],
        dispatchEligible: false,
        summary: "Still needed before work: background check recorded, service areas.",
      },
    },
  ];
}

const html = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <CompanyProvider company={{ companyId: "c" as never, name: "Alpha Cleaning", timezone: "America/Chicago", role: "owner" }}>{node}</CompanyProvider>,
  );

/** Writes each screen to a file when VISUAL_OUT is set, so it can be looked at with the built styles. */
function keep(name: string, markup: string) {
  const out = process.env.VISUAL_OUT;
  if (out) writeFileSync(`${out}/${name}.html`, markup);
}

describe("Recruiter's screens", () => {
  it("the overview leads with a brief from the records, then findings, messages ready to send, follow-ups and outcomes", () => {
    fill();
    const page = html(<RecruiterOverviewScreen />);
    keep("overview", page);
    for (const text of [
      "Recruiter found three new applicants. Two are ready for an application link, one needs a contact method, and one is due a reminder.",
      "New findings",
      "Ready to send",
      "Send application link",
      "Edit message",
      "View source",
      "Dismiss",
      "To <span class=\"font-medium text-strong\">maria@example.test</span>",
      "Review and send all (2)",
      "Possibly hiring-related · 1",
      "Include in recruiting",
      "Open in Gmail",
      "Scheduled follow-ups · 1",
      "Recent outcomes",
      "Sent · delivery not confirmed",
      "Hiring pipeline",
      "Two cleaners needed for Saturday",
    ])
      expect(page, text).toContain(text);
    // No generic decisions queue, and no technical service names on the overview.
    for (const text of ["Waiting on a decision", "Reader:", "resend", "claude"]) expect(page, text).not.toContain(text);
  });

  it("an applicant opens with the journey and how Recruiter read them, with sources", () => {
    fill();
    search = "open=a2";
    const page = html(<ApplicantsScreen />);
    keep("applicants", page);
    search = "";
    for (const text of ["Dana Cole", "Dana Cole finished the House Cleaner application", "How Recruiter got here", "Found in the hiring inbox (Indeed)", "Application: “New application for House Cleaner”", "Recruiter suggests an interview", "Dana-Cole-resume.pdf", "not verified", "Application link · delivered", "Hand back to Recruiter", "A person decides every decline.", "Needs a decision", "Any role"]) expect(page, text).toContain(text);
    for (const text of ["Read by the AI reader", "by rule", "application_invitation"]) expect(page, text).not.toContain(text);
  });

  it("screening shows each criterion with the applicant's words, and a person decides", () => {
    fill();
    const page = html(<ScreeningScreen />);
    keep("screening", page);
    for (const text of ["Recruiter&#x27;s reading", "Has reliable transportation", "“I have my own car”", "fixed requirement", "Needs clarification", "Invite to interview", "Decline"]) expect(page, text).toContain(text);
    expect(page).not.toMatch(/score/i);
  });

  it("interviews, offers and onboarding show where each one stands", () => {
    fill();
    const interviews = html(<InterviewsScreen />);
    const offers = html(<OffersScreen />);
    const needs = html(<HiringNeedsScreen />);
    keep("interviews", interviews);
    keep("offers", offers);
    keep("hiring-needs", needs);
    for (const text of ["Waiting for times", "Booked", "Lee Wong", "Open time", "Offer interview times"]) expect(interviews, text).toContain(text);
    for (const text of ["Ava Chen", "Accepted", "Agreement: not started", "1 new worker is onboarding", "Onboarding &amp; Readiness"]) expect(offers, text).toContain(text);
    // Onboarding is its own tab: each item's state and who confirmed it. Received is never shown as approved.
    const onboarding = html(<OnboardingScreen />);
    keep("onboarding-readiness", onboarding);
    for (const text of ["Noah Kim", "Not ready yet", "Background check recorded", "Received", "Approved", "Confirmed by Owner A", "On their record", "Add it on their record in Cleaners", "Still needed before work: Background check recorded (received), Service areas (missing)."]) expect(onboarding, text).toContain(text);
    expect(onboarding).not.toContain("Approve readiness</button>");
    for (const text of ["House Cleaner", "1/3", "$22 an hour", "Deep-Clean Specialist", "Paused", "Required: "]) expect(needs, text).toContain(text);
  });

  it("hiring setup holds the roles, the inbox boundary, the five switches with their rules, the FAQ and the services in plain words", () => {
    fill();
    const page = html(<HiringSetupScreen />);
    keep("hiring-setup", page);
    for (const text of ["Open roles", "Where Recruiter looks for hiring mail", "A hiring inbox", "A Gmail label", "Find hiring emails in my business inbox", "It may miss an inquiry", "Recruiter doesn&#x27;t create labels", "Recent reads", "4 looked at · 2 opened · 1 possibly hiring-related", "Send application links to new applicants", "When: ", "Sends: ", "Stops: ", "Hiring FAQ", "Supplies: we provide all supplies.", "Services Recruiter uses"]) expect(page, text).toContain(text);
    expect(page).toContain("Gmail&#x27;s read permission covers your whole mailbox");
  });
});

describe("Recruiter's application forms and board", () => {
  const form = standardCleanerForm();
  const look = { display: "one_at_a_time" as const, accentColor: "#6838ef", logoUrl: null, companyName: "Alpha Cleaning", copy: { title: "Apply for House Cleaner at Alpha Cleaning", intro: "It takes about five minutes.", submitLabel: "Submit application", thankYouTitle: "Your application is in", thankYouBody: "" } };
  const fillForms = () => {
    fill();
    data["applicationForms:overview"] = {
      forms: [{ id: "f1", name: "Cleaner application", template: "standard_cleaner", isDefault: true, publishedVersion: 2, draftDiffers: true, display: "one_at_a_time", questions: 24, accentColor: "#6838ef", usedBy: ["House Cleaner"], updatedAt: T, draftSavedBy: "Owner A" }],
      roles: [{ id: "n1", title: "House Cleaner", status: "open", formId: null, formName: "Cleaner application", publicApply: true, slug: "house-cleaner", url: "https://app.selestial.test/apply/alpha/house-cleaner" }],
      templates: [{ key: "standard_cleaner", name: "Cleaner application", blurb: "The full application." }],
      handle: "alpha",
      careersUrl: "https://app.selestial.test/apply/alpha",
      canDraft: true,
      canPublish: true,
    };
    data["applicationForms:get"] = {
      form: { id: "f1", name: "Cleaner application", template: "standard_cleaner", isDefault: true, publishedVersion: 2, publishedAt: T, archived: false, draftRevision: 4, draftSavedAt: T, draftSavedBy: "Owner A", draftDiffers: false },
      draft: form,
      versions: [{ version: 2, publishedAt: T, publishedBy: "Owner A", note: null, restoredFrom: null, current: true }],
      roles: [{ id: "n1", title: "House Cleaner", status: "open", publicApply: true, url: "https://app.selestial.test/apply/alpha/house-cleaner" }],
      sample: { title: "House Cleaner", coverageAreas: ["78701"], questions: [] },
      brand: { companyName: "Alpha Cleaning", brandColor: "#6838ef", logoUrl: null },
      catalog: { builtins: [{ id: "resume", name: "Resume", kind: "file", label: "Resume", help: "", locked: [] }], kinds: [{ kind: "text", label: "Short answer" }], displays: [{ id: "one_at_a_time", label: "One question at a time", blurb: "" }, { id: "sections", label: "One page with sections", blurb: "" }], workAuthorizedWording: "" },
      handle: "alpha",
      careersUrl: "https://app.selestial.test/apply/alpha",
      canDraft: true,
      canPublish: true,
    };
  };

  it("the board shows the pipeline's columns with each applicant, and a way to move them without dragging", () => {
    fillForms();
    search = "layout=board";
    const page = html(<ApplicantsScreen />);
    keep("applicants-board", page);
    search = "";
    for (const text of ["data-testid=\"board\"", "Inbox", "Invited", "Applying", "Screening", "Interview", "Decision", "Offer", "Onboarding", "Drop a card here to close the application.", "Maria Lopez", "Dana Cole", "Move to…", "Send application"]) expect(page, text).toContain(text);
  });

  it("application forms list the forms, which role uses which, and the public links", () => {
    fillForms();
    const page = html(<FormsHome />);
    keep("application-forms", page);
    for (const text of ["Application forms", "Cleaner application", "Default", "Published v2", "Unpublished changes", "Used by House Cleaner", "Careers page", "https://app.selestial.test/apply/alpha", "Anyone can apply", "New form"]) expect(page, text).toContain(text);
  });

  it("the builder draws the form as an applicant sees it, beside its sections and questions", () => {
    fillForms();
    const page = html(<FormBuilder formId={"f1" as never} />);
    keep("application-form-builder", page);
    for (const text of ["Layout and look", "Page words", "Invitation email", "Share and send", "Getting to jobs", "Do you have a car you can use to get to jobs?", "Ends the application on an answer", "Apply for House Cleaner at Alpha Cleaning", "1 of ", "Continue", "One question at a time"]) expect(page, text).toContain(text);
  });

  it("one question at a time: the first question, a progress bar, and lettered choices", () => {
    const need = { title: "House Cleaner", coverageAreas: [], questions: [] };
    const fields = fieldsFor(form, need, "Alpha Cleaning");
    const page = html(<ApplicationForm look={look} fields={fields} sections={sectionsFor(form, need)} answers={{}} onAnswer={() => undefined} attestation="True." onContinue={async () => true} onSubmit={() => undefined} busy={null} problem={null} saved={false} jumpTo={{ key: "f.own_car", n: 1 }} />);
    for (const text of ["Do you have a car you can use to get to jobs?", "data-letter=\"A\"", "Getting to jobs", "Continue"]) expect(page, text).toContain(text);
  });

  it("reads a pasted list of people to send the application to", () => {
    expect(parseRecipients("Maria Lopez <Maria@Example.test>\njames@example.test; Lee Chen, lee@example.test\nnot an address")).toEqual([
      { email: "maria@example.test", name: "Maria Lopez" },
      { email: "james@example.test" },
      { email: "lee@example.test", name: "Lee Chen" },
    ]);
  });
});
