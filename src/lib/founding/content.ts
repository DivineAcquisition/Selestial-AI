/**
 * Every word on the Selestial Founding Access page (src/app/founding).
 *
 * Terms come from code, never from older copy: price, duration, renewal and places from
 * convex/lib/founding/offer.ts (which reads the billing rule in convex/lib/billing/earlyOffer.ts), and
 * messaging prices from the approved rate card msg-2026-11 (docs/billing/03-messaging-billing.md).
 * Agent statements were checked against what each agent does in the product today
 * (convex/lib/billing/catalog.ts RELEASED, src/lib/marketing/content.ts PRICING).
 *
 * Not stated anywhere here, because none is approved: a credit allowance figure, a support response time,
 * "lifetime", "locked", "unlimited", "free migration" or "priority support".
 */
import { FOUNDING_OFFER } from "../../../convex/lib/founding/offer";

const whole = (cents: number) => `$${Math.round(cents / 100)}`;
export const FOUNDING_PRICE = whole(FOUNDING_OFFER.billing.foundingMonthlyCents);
export const RENEWAL_PRICE = whole(FOUNDING_OFFER.billing.renewalMonthlyCents);
export const FOUNDING_MONTHS = FOUNDING_OFFER.billing.foundingMonths;
export const CAPACITY = FOUNDING_OFFER.capacity;

export const SUPPORT_EMAIL = "support@selestial.io";
export const CTA = "Claim founding access";

export const META = {
  title: "Selestial Founding Access",
  description: `Join Selestial's founding customers: AI agents for sales follow-up, recruiting, dispatch and retention, built for cleaning companies. ${FOUNDING_PRICE} a month for your first ${FOUNDING_MONTHS} months, with help setting up.`,
};

export const HERO = {
  eyebrow: "Selestial Founding Access",
  headline: "Your next cleaning company hire could be a team of AI agents.",
  supporting:
    "Bring sales follow-up, recruiting, dispatch, and customer retention into one workspace built for cleaning companies. Join our founding customers and get help setting up Selestial around how your business operates.",
  secondary: "See how it works",
  priceLine: `${FOUNDING_PRICE}/month for your first ${FOUNDING_MONTHS} months`,
  priceThen: `then ${RENEWAL_PRICE}/month. Paid monthly, no trial. Cancel anytime.`,
  visualCaption: "Illustration of a day in Selestial: each agent’s lane, what it is doing and what waits for you. Demonstration data.",
};

/**
 * The hero's agent desk (src/components/founding/agent-desk.tsx). Each step is work the product supports
 * today: booking-page inquiries and quotes from pricing rules (Sales), an approval above the owner's limit,
 * text-link job offers (Dispatch), hiring-inbox screening (Recruiter) and post-visit feedback (Retention).
 * Names and figures are made up, and the panel is labelled as demonstration data.
 */
export const DESK = {
  label: "Example of Selestial's agents at work, with demonstration data",
  title: "Your agents are working",
  demo: "Demonstration data",
  waiting: "1 decision is waiting for you",
  clear: "Nothing is waiting on you",
  caption: "An example workflow: Sales answers an inquiry and prepares a quote, you approve a discount above your limit, Dispatch fills the visit, Recruiter screens applicants and Retention schedules feedback.",
  steps: [
    { id: "inquiry", agent: "sales", title: "New inquiry from your booking page", detail: "3 bed, 2 bath deep clean · Friday", done: "Details collected, quote next" },
    { id: "quote", agent: "sales", title: "Quote from your pricing rules", detail: "Deep clean, oven included · $285", done: "Sent · customer asked for 15% off" },
    { id: "approval", agent: "owner", title: "Discount above your 10% limit", detail: "Approve, change or decline", done: "Approved by you · booked Fri 9:00" },
    { id: "dispatch", agent: "dispatch", title: "Friday 9:00 needs a cleaner", detail: "Offer sent to Maria R. by text link", done: "Maria accepted the job" },
    { id: "recruit", agent: "recruiter", title: "2 applicants in your hiring inbox", detail: "Checking your requirements", done: "Interview times offered" },
    { id: "feedback", agent: "retention", title: "After Friday’s visit", detail: "Planning the customer follow-up", done: "Feedback request scheduled" },
  ] as const,
};

export const STATUS = {
  timerLabel: "Founding enrollment closes in",
  explain: "Join before enrollment closes to receive the founding offer.",
  benefit: `${FOUNDING_PRICE}/month for your first ${FOUNDING_MONTHS} months, then ${RENEWAL_PRICE}. Quality included while you keep a plan.`,
  closes: "Closes",
  joined: (n: number) => (n === 1 ? "1 cleaning company has joined" : `${n} cleaning companies have joined`),
  placesLeft: (n: number) => (n === 1 ? `1 of ${CAPACITY} founding places left` : `${n} of ${CAPACITY} founding places left`),
  countUnavailable: "Founding count unavailable right now",
  countNote: "Counts companies whose first founding payment has been confirmed.",
  notOpen: { title: "Founding enrollment opens soon", body: "The enrollment window hasn’t started yet. Its closing date appears here the moment it opens, and it’s the same for everyone." },
  closedDeadline: { title: "Founding enrollment has closed", body: "The founding window has ended. You can still start Selestial on the Operate plan, or talk with us about setup." },
  closedFull: { title: "All founding places are taken", body: `All ${CAPACITY} founding places are in use. You can still start Selestial on the Operate plan, or talk with us about setup.` },
  closed: { title: "Founding enrollment has closed", body: "Founding enrollment is closed. You can still start Selestial on the Operate plan, or talk with us about setup." },
  unavailable: { title: "Enrollment status unavailable", body: "We couldn’t load the enrollment status just now. Refresh in a moment." },
  afterCta: "Start on Operate",
  talkCta: "Talk with us",
  units: { days: "days", hours: "hours", minutes: "min" },
};

export const AGENTS_SECTION = {
  eyebrow: "Working today",
  headline: "What Selestial helps with",
  lead: "Four agents your founding plan includes from day one. Each works inside the rules and approvals you set, and brings decisions back to you.",
  cards: [
    {
      id: "sales" as const,
      name: "Sales",
      line: "Help turn inquiries into booked cleaning jobs.",
      examples: ["Replies to new inquiries by text and email", "Quotes from your own pricing rules, accepted online", "Follows up on unanswered quotes and books the visit"],
    },
    {
      id: "dispatch" as const,
      name: "Dispatch",
      line: "Coordinate cleaner offers, coverage, and upcoming visits.",
      examples: ["Sends job offers cleaners accept or decline from a text link", "Looks for a replacement when someone can’t make it", "Live job pages with check-in, checklist and delays"],
    },
    {
      id: "recruiter" as const,
      name: "Recruiter",
      line: "Find employment inquiries in connected email and move applicants through hiring.",
      examples: ["Reads your connected hiring inbox for applicants", "Applications, screening and interview booking", "Offers and onboarding through to a ready cleaner"],
    },
    {
      id: "retention" as const,
      name: "Retention",
      line: "Identify customer relationships that need attention and coordinate the next step.",
      examples: ["Asks for feedback after a visit", "Follows a concern through to a recorded outcome", "Renewals, plan changes and reaching quiet customers"],
    },
  ],
  bonus: { name: "Quality", line: "Founding customers also get Quality, which reviews finished visits’ photos and checklists and flags what was missed. It stays on your plan after the founding months." },
  notIncluded: "Marketing is planned and not available yet. No plan or purchase makes it available sooner.",
};

export const WALKTHROUGH = {
  id: "how-it-works",
  eyebrow: "See the work happen",
  headline: "From a new inquiry to a covered visit.",
  lead: "An illustrated example of a workflow Selestial supports today, with demonstration data.",
  label: "Illustration · demonstration data",
  steps: [
    { n: "1", title: "An inquiry arrives", body: "A customer asks for a clean by text or email, and Sales replies with a quote from your own pricing rules.", visual: "inquiry", alt: "Illustration: a customer asks for a deep clean on Friday and Sales replies with a quote from the company’s pricing rules." },
    { n: "2", title: "A booking is prepared", body: "The visit is confirmed with its date, arrival window and scope, and the customer gets one confirmation.", visual: "booking", alt: "Illustration: a confirmed booking with its date, arrival window, service and scope." },
    { n: "3", title: "Dispatch coordinates coverage", body: "Dispatch offers the job to a cleaner, who accepts or declines from a link in a text.", visual: "dispatch", alt: "Illustration: Dispatch offers the visit to the usual cleaner, who accepts, with the next option held in reserve." },
    { n: "4", title: "The owner sees the outcome", body: "Each booking’s state is kept apart, so you can see what’s confirmed, still in progress or waiting.", visual: "outcome", alt: "Illustration: the owner’s summary showing the visit booked and covered, the approval recorded and a follow-up scheduled." },
  ] as const,
};

export const SETUP = {
  eyebrow: "Guided setup",
  headline: "Your business already has a way of working. Start there.",
  supporting:
    "We’ll review your existing setup, help bring over supported records, and prepare your services, pricing, and booking experience for review.",
  steps: [
    { n: "1", title: "Tell us about your business.", body: "Your services, prices, service area and how you book today. Your claim answers are already filled in." },
    { n: "2", title: "Review the setup Selestial prepares.", body: "A draft booking page, services and pricing, and proposed answers for Sales. Nothing is used until you approve it." },
    { n: "3", title: "Activate the workflows you’re ready to use.", body: "Turn on one agent at a time, and choose which actions need your approval first." },
  ],
  help: {
    title: "The setup help we provide",
    items: [
      "A setup conversation with the Selestial team about how your company runs today.",
      "Guided import of customers, properties, recurring plans and upcoming bookings from CSV exports of Jobber, Housecall Pro, BookingKoala or a spreadsheet.",
      "Help reviewing what Selestial read from your files: duplicates, missing details and anything that didn’t transfer.",
      "Your services, pricing and booking page prepared as drafts for you to review.",
    ],
  },
  limits:
    "Not everything moves over. Payment methods, card details and customer subscriptions stay with your current provider, and other record types aren’t imported yet. Imported visits and plans stay on hold until you release them, so you can keep using your current software while you review the move.",
  imageCaption: "Illustration of a guided import: files read, records checked, and nothing live until you release it. Demonstration data.",
};

export const OFFER = {
  id: "offer",
  eyebrow: "The founding offer",
  headline: "One plan. Founding pricing for your first year.",
  name: "Operate, at the founding price",
  price: FOUNDING_PRICE,
  period: "/month",
  duration: `for your first ${FOUNDING_MONTHS} monthly billing periods`,
  renewal: `Then ${RENEWAL_PRICE}/month, the standard Operate price. We email you and show a notice in the app about 30 days before it changes. You don’t need to do anything.`,
  groups: [
    { title: "Included agents", items: ["Sales, Dispatch, Recruiter, Retention and Client Care", "Quality, as a founding benefit, kept after your founding months while you have a plan"] },
    { title: "AI credits", items: ["A monthly allowance of Selestial Credits for AI work, reset each billing period", "Your allowance and what each task costs are shown in Plan & Usage. If credits run out, new AI work pauses until the next reset; schedules, records and cleaner links keep working. Nothing is bought automatically"] },
    {
      title: "Texts and email",
      items: [
        "Billed separately from a prepaid messaging balance you add funds to",
        "Texts: 2.5¢ per outgoing and 1.5¢ per incoming message segment (US numbers)",
        "Email through Selestial: 0.2¢ per recipient. Email from your own connected Gmail: included",
        "Business texting number: $3/month, plus carrier registration at cost",
      ],
    },
    { title: "Setup and support", items: ["Guided setup and record import, with help from the Selestial team", `Support by email at ${SUPPORT_EMAIL}`] },
  ],
  cancel: "Cancel anytime in Plan & Usage. Your plan stays active until the end of the period you’ve paid for. The founding price can’t be restarted: if you return later, Operate is the standard price.",
  ends: `When your founding months end, your plan continues on Operate at ${RENEWAL_PRICE}/month with the same agents, features and credits, and Quality stays on your plan.`,
  payment: `Claiming founding access means paying ${FOUNDING_PRICE} for your first month. You’ll create your account and confirm your company first, then see the exact charge before you confirm.`,
  places: `Founding places are limited to the first ${CAPACITY} companies whose first payment goes through while enrollment is open.`,
};

export const CLAIM = {
  id: "claim",
  eyebrow: "Claim access",
  headline: "Claim your founding place.",
  lead: "Four quick questions so setup starts from how your business runs. Next, you’ll create your account (or sign in to an existing one) and confirm your company. You’ll see the exact charge before you pay, then setup begins.",
  stepsLabel: ["Your business", "Account", "Payment", "Setup"],
  fields: {
    companyName: "Company name",
    currentSoftware: "What do you use today to run bookings?",
    teamSize: "About how many people clean for you?",
    priority: "What should Selestial help with first?",
  },
  choose: "Select one",
  submit: "Continue to create your account",
  sending: "Saving your answers",
  already: "Already using Selestial?",
  signIn: "Sign in to claim for your company",
  privacy: "We use your answers to prepare your setup. See our",
  errors: {
    invalid: "Fill in your company name and choose an answer for each question.",
    closed: "Founding enrollment isn’t open right now, so this claim couldn’t start.",
    limited: "Too many attempts from this connection. Please try again in an hour.",
    failed: "That didn’t go through. Please try again in a moment.",
    unconfigured: "Claims can’t be started from this site yet. Please try again soon.",
  },
};

export const FAQ = {
  id: "faq",
  headline: "Questions",
  developing:
    "Selestial is developing, and founding customers’ feedback helps decide what we improve and build next. We’ll be clear about what works today and what doesn’t yet.",
  items: [
    { q: "Who is Founding Access for?", a: "Owners and operators of residential, commercial and short-term rental cleaning companies in the US who want to start early, get hands-on help setting up, and tell us what to improve." },
    { q: "What can I use today?", a: "Sales, Dispatch, Recruiter, Retention and Client Care, plus Quality for founding customers. You also get booking pages priced from your services, clients and properties, cleaners, services and pricing, finance, Company Chat, approvals and agreements. Marketing isn’t available yet. Connecting a Gmail inbox for Recruiter is done with our team during setup." },
    { q: "What does joining early mean?", a: `You start on the founding price, get help setting up, and talk directly with the people building Selestial. Founding places go to the first ${CAPACITY} companies whose first payment goes through while enrollment is open.` },
    { q: "Can I keep my current software during setup?", a: "Yes. Imported visits and recurring plans stay on hold until you release them, so nothing is booked twice while you review. Customer payments and subscriptions stay with your current provider." },
    { q: "What can you help migrate?", a: "Customers, properties, recurring plans and upcoming bookings, from CSV exports of Jobber, Housecall Pro, BookingKoala or a spreadsheet. Payment methods, card details, subscriptions and other record types aren’t imported. You review every record before anything goes live." },
    { q: "What costs extra?", a: "Texts and email sent through Selestial are billed from a prepaid messaging balance at published rates (texts from 1.5¢ per segment, email 0.2¢ per recipient; email from your own Gmail is included). A business texting number is $3/month plus carrier registration at cost. AI work uses your plan’s monthly credits; if they run out, new AI work pauses until the next reset. Nothing is bought automatically." },
    { q: "How long does my founding price last?", a: `For your first ${FOUNDING_MONTHS} monthly billing periods, counted from your first payment. Then Operate is ${RENEWAL_PRICE}/month, and we tell you about 30 days before it changes.` },
    { q: "What happens after enrollment closes?", a: "No new founding places are offered, and new companies start on Operate at the standard price. Founding customers keep their founding price for their full founding period, and keep Quality." },
    { q: "How do I cancel?", a: "In Settings › Plan & Usage. Your plan stays active until the end of the period you’ve paid for, and your records stay yours to export. If you return later, you’ll be on the standard Operate price." },
  ],
};

export const FINAL = {
  headline: "Start where your business already is.",
  body: `Founding access is ${FOUNDING_PRICE}/month for your first ${FOUNDING_MONTHS} months, with help setting up.`,
  links: [
    { href: "/terms", label: "Terms" },
    { href: "/privacy", label: "Privacy" },
    { href: "/eula", label: "License agreement" },
    { href: "/messaging", label: "Messaging practices" },
    { href: "#offer", label: "Founding offer terms" },
  ],
  support: `Questions? ${SUPPORT_EMAIL}`,
  note: "Product illustrations on this page show demonstration data.",
};

export const HEADER = { signIn: "Sign in" };
