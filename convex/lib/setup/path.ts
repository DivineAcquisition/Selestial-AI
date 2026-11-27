/**
 * The setup path: which screens and questions this owner sees. Pure, and shared by the functions and the
 * screens, so the server and the browser never disagree about what comes next.
 *
 * The journey is fixed at five stages: choose an outcome → confirm essentials → add relevant context →
 * build the workspace → review the first useful result. The number of stages never changes, so the
 * progress bar never moves backward; only the questions inside "Add relevant context" depend on the
 * outcome, and a question is asked only when nothing the company already has answers it: an earlier
 * answer, a confirmed fact, or a record (an upcoming visit, a customer, a connected inbox). When nothing
 * is left to ask, the context stage is passed through on its own.
 */
import type { Choice, FactKey } from "./facts";
import type { Priority } from "./schema";

export const STAGES = [
  { id: "outcome", label: "Choose an outcome" },
  { id: "essentials", label: "Confirm essentials" },
  { id: "context", label: "Add context" },
  { id: "build", label: "Build your workspace" },
  { id: "result", label: "Review your first result" },
] as const;
export type StageId = (typeof STAGES)[number]["id"];

export type PriorityInfo = {
  id: Priority;
  title: string;
  /** One line under the choice: what it leads to. */
  hint: string;
  /** The launch agent that does this work, or null for setup the owner does with Selestial's help. */
  agent: "sales" | "dispatch" | "recruiter" | "retention" | null;
  /** What the owner gets first, in one sentence. */
  first: string;
};

export const PRIORITY_INFO: PriorityInfo[] = [
  { id: "sales", title: "Turn more inquiries into bookings", hint: "A quote or booking form, and answers to common customer questions.", agent: "sales", first: "Sales prepares your quote request or booking form and proposed answers to common questions." },
  { id: "dispatch", title: "Keep upcoming jobs covered", hint: "A coverage review of your real upcoming jobs and cleaners.", agent: "dispatch", first: "Dispatch reviews coverage for your upcoming jobs and names what is missing." },
  { id: "recruiter", title: "Find and onboard cleaners", hint: "A hiring role, application and screening questions.", agent: "recruiter", first: "Recruiter drafts your hiring role, application and screening questions." },
  { id: "retention", title: "Keep customers coming back", hint: "Follow-up opportunities found in your customer history.", agent: "retention", first: "Retention reviews your customers and past visits for real follow-up opportunities." },
  { id: "pricing", title: "Set up services and pricing", hint: "Service drafts with your prices, or help working them out.", agent: null, first: "We prepare your service drafts, with your prices or clearly marked examples." },
  { id: "booking", title: "Launch my booking form", hint: "A booking form preview, and what it needs to go live.", agent: null, first: "We prepare a booking form preview and show exactly what it needs before it can be published." },
];

/** Everything the company already has that can answer a question, so it is not asked again. */
export type Known = {
  answers: Record<string, string | string[]>;
  /** Confirmed facts only. A fact merely found on a website answers nothing. */
  facts: Partial<Record<FactKey, string | string[]>>;
  records: { upcomingJobs: number; readyCleaners: number; customers: number; completedJobs: number; activeServices: number; openInquiries: number; hiringInbox: "connected" | "broken" | "none"; openRoles: number };
};

export const NO_RECORDS: Known["records"] = { upcomingJobs: 0, readyCleaners: 0, customers: 0, completedJobs: 0, activeServices: 0, openInquiries: 0, hiringInbox: "none", openRoles: 0 };

export type Question = {
  id: string;
  /** The outcomes this question matters for. */
  for: Priority[];
  title: string;
  /** Why it is asked, in one sentence. */
  why: string;
  kind: "single" | "multi" | "text";
  choices: Choice[];
  /** Can be left without stopping anything. */
  optional: boolean;
  /** Saved as a confirmed company fact instead of a setup answer, so every agent reads it. */
  fact?: FactKey;
  placeholder?: string;
  /** What else already answers it. Returns the reason in the owner's words, or null when it must be asked. */
  answeredBy?: (known: Known) => string | null;
};

export const UNSURE = "unsure";

const has = (value: string | string[] | undefined) => (Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim() !== "");

/** The answers to "Do you already have prices?" an older setup gave, read as the new question's answer. */
export function pricingPath(answers: Record<string, string | string[]>): "existing" | "assist" | "later" | null {
  const direct = answers["pricing.path"];
  if (direct === "existing" || direct === "assist" || direct === "later") return direct;
  const legacy = answers["pricing.state"];
  if (legacy === "set_prices" || legacy === "some_prices") return "existing";
  if (legacy === "starting_out") return "assist";
  if (legacy === "quote_each") return "later";
  return null;
}

export const QUESTIONS: Question[] = [
  {
    id: "pricing.path",
    for: ["pricing", "sales", "booking"],
    title: "Do you already have prices you want to use?",
    why: "A firm price needs one you have approved. Without one, customers can still ask for a quote.",
    kind: "single",
    choices: [
      { value: "existing", label: "Yes, use my existing prices", hint: "Enter one service and its price now; add the rest later." },
      { value: "assist", label: "Help me work out my prices", hint: "A few costs, with every assumption shown. Nothing is published." },
      { value: "later", label: "I'll finish pricing later", hint: "Customers ask for a quote until you set prices." },
    ],
    optional: false,
    answeredBy: (k) => (pricingPath(k.answers) ? "You answered this earlier." : k.records.activeServices > 0 ? "You already have a published service with prices." : null),
  },
  {
    id: "inquiries.channels",
    for: ["sales"],
    title: "How do new customers reach you today?",
    why: "Sales starts where your inquiries already arrive, instead of asking you to move them.",
    kind: "multi",
    choices: [
      { value: "phone", label: "Phone calls" },
      { value: "text", label: "Text messages" },
      { value: "email", label: "Email" },
      { value: "website_form", label: "A form on my website" },
      { value: "google", label: "Google (Maps, ads, reviews)" },
      { value: "social", label: "Social media" },
      { value: "referrals", label: "Word of mouth" },
    ],
    optional: false,
  },
  {
    id: "company.areas",
    for: ["sales", "booking"],
    title: "Which areas do you serve?",
    why: "Sales can answer \"Do you come to me?\". This is description only: it does not limit who can book.",
    kind: "text",
    choices: [],
    optional: true,
    fact: "company.areas",
    placeholder: "Austin, Round Rock and Cedar Park",
  },
  {
    id: "contact.phone",
    for: ["sales", "booking"],
    title: "What number should customers call or text?",
    why: "Shown on your booking form and in answers Sales proposes. Nothing is sent from it.",
    kind: "text",
    choices: [],
    optional: true,
    fact: "contact.phone",
    placeholder: "(512) 555-0100",
  },
  {
    id: "jobs.where",
    for: ["dispatch"],
    title: "Where is your schedule kept today?",
    why: "Dispatch can only review jobs it can see. This tells us the simplest way to bring yours in.",
    kind: "single",
    choices: [
      { value: "calendar", label: "A calendar", hint: "Google Calendar or similar" },
      { value: "software", label: "Scheduling software" },
      { value: "spreadsheet", label: "A spreadsheet" },
      { value: "paper", label: "Paper, texts or memory" },
      { value: "none_yet", label: "No regular jobs yet" },
    ],
    optional: false,
    answeredBy: (k) => (k.records.upcomingJobs > 0 ? `You already have ${k.records.upcomingJobs === 1 ? "an upcoming job" : `${k.records.upcomingJobs} upcoming jobs`} in Selestial.` : null),
  },
  {
    id: "jobs.assigning",
    for: ["dispatch"],
    title: "How do cleaners get their jobs?",
    why: "Dispatch proposes cleaners the way your team already expects. It sends no offers on its own.",
    kind: "single",
    choices: [
      { value: "i_assign", label: "I assign every job" },
      { value: "regulars", label: "Regular cleaners keep regular customers" },
      { value: "first_to_accept", label: "I offer it and whoever accepts first takes it" },
      { value: "leads_assign", label: "Crew leads sort it out" },
    ],
    optional: true,
  },
  {
    id: "hiring.now",
    for: ["recruiter"],
    title: "Are you hiring right now?",
    why: "Recruiter prepares for the opening you have, not one you might have later.",
    kind: "single",
    choices: [
      { value: "now", label: "Yes, I need people now" },
      { value: "soon", label: "Soon, in the next month or two" },
      { value: "pipeline", label: "Not yet, but I want applicants ready" },
    ],
    optional: false,
    answeredBy: (k) => (k.records.openRoles > 0 ? "You already have an open role." : null),
  },
  {
    id: "workforce.arrangement",
    for: ["recruiter"],
    title: "How will this cleaner work with you?",
    why: "Employees and contractors get different role wording and onboarding. We never ask for pay rates or bank details here.",
    kind: "multi",
    choices: [
      { value: "employees", label: "Employee", hint: "On your payroll" },
      { value: "contractors", label: "Independent contractor", hint: "Paid per job or by share" },
      { value: "subcontractors", label: "Subcontractor company", hint: "Another company supplies the cleaner" },
    ],
    optional: false,
    fact: "workforce.arrangement",
  },
  {
    id: "hiring.sources",
    for: ["recruiter"],
    title: "Where do applicants come from?",
    why: "If applicants email you, you can connect a hiring inbox later. It is read only for applications, and only after you authorize it.",
    kind: "multi",
    choices: [
      { value: "job_boards", label: "Job boards", hint: "Indeed, Craigslist and similar" },
      { value: "email", label: "They email me" },
      { value: "referrals", label: "Referrals from my team" },
      { value: "social", label: "Social media" },
      { value: "walk_ins", label: "Calls and walk-ins" },
    ],
    optional: true,
  },
  {
    id: "customers.where",
    for: ["retention"],
    title: "Where are your customer records today?",
    why: "Follow-up needs to know who your customers are and when you last cleaned for them.",
    kind: "single",
    choices: [
      { value: "software", label: "In software I can export from" },
      { value: "spreadsheet", label: "A spreadsheet" },
      { value: "phone", label: "My phone and messages" },
      { value: "few", label: "I only have a few so far" },
    ],
    optional: false,
    answeredBy: (k) => (k.records.customers > 0 ? `You already have ${k.records.customers === 1 ? "a customer" : `${k.records.customers} customers`} in Selestial.` : null),
  },
];

/** Whether a question is already answered, and by what. A confirmed fact or a record counts; a found fact does not. */
export function answeredBy(question: Question, known: Known): string | null {
  if (question.fact) {
    if (has(known.facts[question.fact])) return "Already in your company details.";
  } else if (has(known.answers[question.id])) {
    return "You answered this earlier.";
  }
  return question.answeredBy?.(known) ?? null;
}

export type ContextQuestion = { question: Question; answeredBy: string | null };

/** Every question for this outcome, each with whether something already answers it. */
export function contextFor(primary: Priority | undefined | null, known: Known): ContextQuestion[] {
  if (!primary) return [];
  return QUESTIONS.filter((question) => question.for.includes(primary)).map((question) => ({ question, answeredBy: answeredBy(question, known) }));
}

/** The questions still to ask for this outcome. */
export function toAsk(primary: Priority | undefined | null, known: Known): Question[] {
  return contextFor(primary, known)
    .filter((row) => row.answeredBy === null)
    .map((row) => row.question);
}

/** Required questions nothing answers yet: what keeps "Add context" from being complete. */
export function unanswered(primary: Priority | undefined | null, known: Known): Question[] {
  return toAsk(primary, known).filter((question) => !question.optional);
}

/** Questions this setup may save an answer to: those of its outcome and any additional priorities. */
export function allowedQuestions(primary: Priority | undefined | null, secondary: Priority[]): Question[] {
  const chosen = [primary, ...secondary].filter(Boolean) as Priority[];
  return QUESTIONS.filter((question) => question.for.some((value) => chosen.includes(value)));
}

export type Step = { id: StageId; stage: StageId; optional: boolean; label: string };

/** The five stages, always. "Add context" is optional, and passed through when nothing is left to ask. */
export function stepsFor(): Step[] {
  return STAGES.map((stage) => ({ id: stage.id, stage: stage.id, label: stage.label, optional: stage.id === "context" }));
}

/**
 * Answers business configuration still reads (configure.ts) that the shorter path no longer asks on its own
 * screen: how pricing works today, and whether they have their own agreement. They can still be saved.
 */
export const KEPT_ANSWERS = ["pricing.state", "agreements.have", "customers.where"] as const;

const LEGACY_STEPS = ["start", "basics", "team", "priority", "offer", "records", "prepare", "review"];

/**
 * A step id setup accepts: a stage, or one of the earlier setup's ids, saved as the stage that holds it.
 * The earlier screens' question steps stay accepted, so a tab still open on them during a release (the new
 * backend goes live before the new site) keeps saving instead of being refused.
 */
export function isKnownStep(step: string): boolean {
  if (STAGES.some((stage) => stage.id === step) || LEGACY_STEPS.includes(step)) return true;
  const id = step.startsWith("q:") ? step.slice(2) : null;
  return id !== null && (QUESTIONS.some((question) => question.id === id) || (KEPT_ANSWERS as readonly string[]).includes(id));
}

/** Step ids from the earlier, longer setup, mapped onto the stage that now holds them. */
export function normalizeStep(step: string): StageId {
  if (STAGES.some((stage) => stage.id === step)) return step as StageId;
  if (step === "priority") return "outcome";
  if (step === "start" || step === "basics" || step === "team") return "essentials";
  if (step.startsWith("q:")) return "context";
  if (step === "offer" || step === "records" || step === "prepare") return "build";
  if (step === "review") return "build";
  return "outcome";
}

/**
 * How far along the owner is, out of a fixed total. A stage counts once the owner moved past it, so
 * choosing another outcome or answering fewer questions never moves the bar backward.
 */
export function progress(input: { step: string }): { done: number; total: number; stage: StageId } {
  const stage = normalizeStep(input.step);
  return { done: STAGES.findIndex((row) => row.id === stage), total: STAGES.length, stage };
}

export type Connection = { id: string; title: string; does: string; href: string; for: Priority[] };

/** Connections that already work in Selestial, in business words, by the outcome they help. Nothing here is a connector that does not exist. */
export const CONNECTIONS: Connection[] = [
  { id: "google-calendar", title: "Google Calendar", does: "Bring in existing appointments.", href: "/app/settings/integrations", for: ["dispatch", "retention", "sales"] },
  { id: "gmail", title: "Gmail hiring inbox", does: "Find applicants who already applied by email. Read only for hiring.", href: "/app/agents/recruiter/applicants", for: ["recruiter"] },
  { id: "google-business", title: "Google Business Profile", does: "Read and answer your Google reviews.", href: "/app/settings/integrations", for: ["retention", "sales"] },
  { id: "google-ads", title: "Google Ads lead forms", does: "Read incoming customer inquiries from your ads.", href: "/app/settings/integrations", for: ["sales"] },
  { id: "quo", title: "Quo (formerly OpenPhone)", does: "Text through your own numbers instead of a new one.", href: "/app/settings/integrations/quo", for: ["dispatch", "sales", "retention", "recruiter"] },
  { id: "stripe", title: "Payments", does: "Collect customer payments and deposits.", href: "/app/finance/setup", for: ["booking", "sales"] },
  { id: "google-drive", title: "Google Drive", does: "Bring in price lists and documents you already keep.", href: "/app/settings/integrations", for: ["pricing", "booking"] },
];

export function connectionsFor(primary: Priority | undefined | null, secondary: Priority[] = []): Connection[] {
  if (!primary) return [];
  const chosen = [primary, ...secondary];
  return CONNECTIONS.filter((row) => row.for.some((value) => chosen.includes(value)))
    .sort((a, b) => Number(b.for.includes(primary)) - Number(a.for.includes(primary)))
    .slice(0, 3);
}
