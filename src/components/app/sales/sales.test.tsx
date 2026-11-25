import { writeFileSync } from "node:fs";

import { getFunctionName } from "convex/server";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CompanyProvider, type Role } from "@/components/app/company";

import type { Id } from "../../../../convex/_generated/dataModel";
import { quote } from "../../../../convex/lib/services/engine";
import { blankSpec, type Spec } from "../../../../convex/lib/services/spec";

// ── Convex and Next, replaced by what each test hands them ──────────────────────────────────────────

let data: Record<string, unknown> = {};
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => (args === "skip" ? undefined : data[getFunctionName(ref)]),
  useMutation: () => mutate,
  usePaginatedQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const page = args === "skip" ? undefined : (data[getFunctionName(ref)] as unknown[] | undefined);
    return page === undefined ? { results: [], status: "LoadingFirstPage", loadMore: () => undefined } : { results: page, status: "Exhausted", loadMore: () => undefined };
  },
}));
// Every mutation the screens call goes through here, so a test can say none was made.
const mutate = vi.fn(async () => undefined);
vi.mock("next/navigation", () => ({ usePathname: () => "/app/agents/sales", useRouter: () => ({ replace: () => undefined, push: () => undefined }), useSearchParams: () => new URLSearchParams() }));

const { SalesWorkspace } = await import("./workspace");
const { InternalBookingScreen } = await import("./internal-booking-screen");
const { QuotesProposalsScreen } = await import("./quotes-screen");
const { PipelineScreen } = await import("./pipeline-screen");
const { PlanDetail } = await import("./plan-detail");
const { ProposalPage } = await import("@/components/public/proposal-page");
const { SignPage } = await import("@/components/public/sign-page");

const companyId = "company1" as Id<"companies">;
function render(role: Role, node: React.ReactNode) {
  return renderToStaticMarkup(<CompanyProvider company={{ companyId, name: "Elm Cleaning", timezone: "America/Chicago", role }}>{node}</CompanyProvider>);
}
/** With SALES_SNAPSHOT_DIR set, each screen is also written out for a visual check in a browser. */
function snapshot(name: string, html: string) {
  const dir = process.env.SALES_SNAPSHOT_DIR;
  if (dir) writeFileSync(`${dir}/${name}.html`, html);
}

const spec: Spec = {
  ...blankSpec("residential"),
  name: "Standard clean",
  summary: "A full clean of the living areas, kitchen and bathrooms.",
  included: [
    { id: "counters", label: "Wipe kitchen counters", section: "Kitchen", requiresPhoto: false },
    { id: "floors", label: "Vacuum and mop floors", section: "Whole home", requiresPhoto: false },
  ],
  excluded: ["Inside the oven"],
  pricing: { method: "bed_bath", baseCents: 12000, includedBedrooms: 1, includedBathrooms: 1, perBedroomCents: 2000, perBathroomCents: 2500, perHalfBathCents: 1000, baseLaborMinutes: 120, perBedroomMinutes: 30, perBathroomMinutes: 30, perHalfBathMinutes: 15 },
  modifiers: { ...blankSpec("residential").modifiers, recurring: { enabled: true, options: [{ schedule: "every_14_days", discount: { kind: "percent", value: 10 } }] } },
};
const deep: Spec = { ...spec, name: "Deep clean", summary: "Top to bottom, inside cabinets and appliances." };
const visit = (s: Spec, schedule?: "every_14_days") => {
  const q = quote(s, { bedrooms: 3, bathrooms: 2, ...(schedule ? { schedule } : {}) });
  return { serviceKey: s.name, name: s.name, version: 1, outcome: q.outcome, reasons: q.reasons, totalCents: q.totalCents, per: q.per, lines: q.lines, includedScope: q.includedScope, extras: q.extras, time: q.time, warnings: q.warnings, missing: q.missing, str: q.str };
};

const draftId = "draft1" as Id<"salesDrafts">;
const customer = { _id: "cust1", name: "Dana Whitfield", email: "dana@example.com", phone: "512-555-0100", kind: "home", status: "active" };
const property = { _id: "prop1", customerId: "cust1", label: null, address: { line1: "12 Elm St", city: "Austin", region: "TX", postalCode: "78701" }, status: "active", kind: "home" };

function bookingData() {
  const ongoing = visit(spec, "every_14_days");
  const first = visit(deep);
  return {
    "sales:draft": {
      draft: { _id: draftId, mode: "booking", segment: "residential", bookingKind: "recurring", customerId: "cust1", propertyId: "prop1", revision: 4, updatedAt: Date.UTC(2027, 2, 1, 15), status: "open", createdBy: "m1", updatedBy: "m1", body: { service: { key: "standard", input: { bedrooms: 3, bathrooms: 2 } }, firstVisit: { mode: "different", service: { key: "deep", input: { bedrooms: 3, bathrooms: 2 } } }, recurring: { cadence: { kind: "every_2_weeks", weekday: 2 }, billing: "per_visit" }, schedule: { date: "2027-03-02", arrivalMinute: 540, windowMinutes: 60 }, payment: { policy: "deposit", depositCents: 5000 }, notes: { cleaner: "Gate code given day before" } } },
      customer,
      properties: [property],
      opportunity: null,
      createdBy: "Jordan (office)",
      updatedBy: "Jordan (office)",
      catalog: [
        { key: "standard", name: "Standard clean", category: "residential", spec, version: 1 },
        { key: "deep", name: "Deep clean", category: "residential", spec: deep, version: 1 },
      ],
      timezone: "America/Chicago",
      role: "office",
      serviceAreas: ["78701"],
      hours: [],
    },
    "sales:price": {
      mode: "booking",
      visit: ongoing,
      first,
      firstNote: "The first visit is a Deep clean; visits after it are Standard clean.",
      recurringNote: null,
      cadence: "Every 2 weeks on Tuesday",
      firstCents: first.totalCents,
      ongoingCents: ongoing.totalCents,
      dueNowCents: 5000,
      dueLaterCents: (first.totalCents ?? 0) - 5000,
      override: null,
      startsAt: Date.UTC(2027, 2, 2, 15),
      endsAt: Date.UTC(2027, 2, 2, 19),
      crew: 1,
      durationMinutes: 240,
      capacity: { state: "fits", freeCleaners: 3, promised: 1, crew: 1, why: "2 cleaners free after other commitments; this visit needs 1.", blockers: [] },
      inServiceArea: true,
      needs: [{ key: "contact", section: "customer", label: "Add an email or mobile number to send links to", blocking: false }],
      contribution: null,
    },
    "sales:customerContext": { visits: [], quotes: [], bookings: [], plans: [] },
    "cleaners:list": [{ _id: "c1", name: "Ana Ruiz" }],
    "bookings:forDraft": null,
  };
}

describe("booking workspace", () => {
  it("shows a recurring booking with a different first visit, the cadence preview and the live summary", () => {
    data = bookingData();
    const html = render("office", <SalesWorkspace draftId={draftId} />);
    snapshot("workspace-booking", html);
    expect(html).toContain("Book service");
    expect(html).toContain("Dana Whitfield");
    expect(html).toContain("Every 2 weeks");
    expect(html).toContain("Upcoming visits");
    expect(html).toContain("First visit");
    expect(html).toContain("Each visit after");
    expect(html).toContain("Due now");
    // A preferred cleaner is a preference, not an assignment.
    expect(html).toContain("A preference, not an assignment");
    // Office staff are told the Owner approves changed prices.
    expect(html).toContain("The Owner approves a changed price");
    // No card details in notes.
    expect(html).toContain("Never type card numbers");
    expect(html).not.toContain("Estimated costs (Owner only)");
  });
});

describe("pipeline", () => {
  it("shows stages, milestones, who has each deal and what's next", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2027, 2, 1, 18));
    data = {
      "pipeline:list": {
        opportunities: [
          { _id: "o1", title: "Northwind Offices, 3 floors", segment: "office", stage: "quoting", milestone: "proposal_sent", milestoneWords: "Proposal sent", customer: "Northwind Offices", owner: "Pat", nextAction: "Call if no answer by Friday", nextActionAt: Date.UTC(2027, 2, 5, 15), estimateCents: 420000, followUps: "on", source: "Website", draftId: "d2", updatedAt: Date.UTC(2027, 2, 1) },
          { _id: "o2", title: "Whitfield home", segment: "residential", stage: "new", milestone: null, milestoneWords: null, customer: null, owner: "Jordan", nextAction: "Call to qualify", nextActionAt: Date.UTC(2027, 1, 27, 15), estimateCents: null, followUps: "paused", source: "Phone", draftId: null, updatedAt: Date.UTC(2027, 2, 1) },
        ],
        last30: { quotes: 12, proposalsSent: 4, proposalsAccepted: 2, bookingsConfirmed: 9, bookingsWaiting: 3 },
      },
    };
    const html = render("manager", <PipelineScreen />);
    snapshot("pipeline", html);
    expect(html).toContain("Proposal sent");
    expect(html).toContain("Taken over");
    expect(html).toContain("Overdue since");
    expect(html).toContain("nothing is sent to customers on its own");
    vi.useRealTimers();
  });
});

describe("recurring plan", () => {
  it("shows schedule and staffing separately, and how a closed day is handled", () => {
    data = {
      "plans:get": {
        plan: { _id: "p1", status: "active", billing: "per_visit", timezone: "America/Chicago" },
        customer: { _id: "cust1", name: "Dana Whitfield" },
        property: { label: null, line1: "12 Elm St", city: "Austin" },
        current: { arrivalMinute: 540, visitPriceCents: 16650, quoteInput: { bedrooms: 3, bathrooms: 2 }, cadenceWords: "Every 2 weeks on Tuesday", rate: "2 or 3 visits a month (26 a year)" },
        pendingVersions: [],
        upcoming: [
          { _id: "v1", date: "2027-03-02", state: "scheduled", first: true, version: 1, exception: null, job: { _id: "j1", startsAt: 0, status: "scheduled", priceCents: 29000, service: "Deep clean" }, staffing: "covered" },
          { _id: "v2", date: "2027-03-16", state: "scheduled", first: false, version: 1, exception: null, job: { _id: "j2", startsAt: 0, status: "scheduled", priceCents: 16650, service: "Standard clean" }, staffing: "uncovered" },
          { _id: "v3", date: "2027-03-30", state: "exception", first: false, version: 1, exception: "The company is closed this weekday.", job: null, staffing: null },
        ],
        past: [],
        agreement: null,
        billingWords: "Each completed visit is invoiced on its own in Finance.",
        history: [{ type: "recurring_plan.created", at: Date.UTC(2027, 2, 1) }],
        today: "2027-03-01",
      },
    };
    const html = render("manager", <PlanDetail planId={"p1" as Id<"recurringPlans">} />);
    snapshot("plan", html);
    expect(html).toContain("Crew accepted");
    expect(html).toContain("No crew yet");
    expect(html).toContain("Needs a decision");
    expect(html).toContain("never moved on their own");
  });
});

const proposalDoc = {
  template: "office",
  title: "Northwind Offices · office cleaning proposal",
  intro: "Thank you for walking us through your floors. Here is our recommended plan.",
  client: { name: "Northwind Offices", email: "ops@northwind.example" },
  sites: [
    { key: "a", label: "Floor 1", address: "1 Main St, Austin, TX 78701", service: { name: "Office cleaning", version: 1 }, scope: ["Empty trash and recycling", "Vacuum carpets"], excluded: ["Window exteriors"], details: [{ label: "Workstations", value: "40" }], matrix: [{ task: "Vacuum carpets", frequency: "Each visit", note: null }, { task: "Wipe blinds", frequency: "Monthly", note: null }], cadence: "3× a week (Mon, Wed, Fri)", cadenceRate: "3 visits a week", perTurnover: false, priceCents: 40000, initialCharge: null, monthlyEstimateCents: 521700, monthlyVisits: 13.04 },
  ],
  options: [],
  terms: { invoiceFrequency: "Invoiced monthly for the visits done", netDays: 15, contractTerm: "12 months", startPlan: "First visit the Monday after signing.", startTogether: false, rushTerms: null, restockPolicy: null },
  totals: { initialCents: 0, fixedMonthlyEstimateCents: 521700, anyVariable: false },
  attachments: [],
};

describe("client pages", () => {
  it("shows the proposal with its terms, and separates acceptance from signing and payment", () => {
    data = { "proposals:publicView": { company: "Elm Cleaning", status: "sent", version: 2, hash: "abc", content: proposalDoc, expiresAt: Date.UTC(2027, 2, 31), lastResponse: null } };
    const html = renderToStaticMarkup(<ProposalPage token="t" />);
    snapshot("proposal", html);
    expect(html).toContain("Proposal v2");
    expect(html).toContain("Each visit");
    expect(html).toContain("Invoiced monthly for the visits done");
    expect(html).toContain("Accepting this proposal is followed by a service agreement to sign");
    expect(html).toContain("Print or save as PDF");
  });

  it("shows the exact version to sign and the consent words", () => {
    data = { "sign:view": { state: "open", company: "Elm Cleaning", title: "Recurring Residential Cleaning", markdown: "# Recurring Residential Cleaning\n\n**Parties.** Elm Cleaning and Dana Whitfield.\n\n- Every 2 weeks\n- $166.50 per visit", version: 3, hash: "0123456789abcdef", signer: { name: "Dana Whitfield", email: "dana@example.com" }, signature: null, others: [], expiresAt: Date.UTC(2027, 2, 15), consent: "I have read this agreement, I agree to its terms, and I intend my typed name below to be my electronic signature." } };
    const html = renderToStaticMarkup(<SignPage token="t" />);
    snapshot("sign", html);
    expect(html).toContain("Version 3");
    expect(html).toContain("intend my typed name");
    expect(html).not.toContain("<script");
  });
});

describe("Internal Booking and Quotes & Proposals", () => {
  const drafts = [
    { _id: "d1", label: "Dana Whitfield", property: "12 Elm St, Austin", service: "Standard clean", kind: "recurring", status: "quoted", statusWords: "Quote saved", quoteId: "q1", bookingId: null, updatedAt: Date.UTC(2027, 2, 1, 15), by: "Jordan" },
    { _id: "d2", label: null, property: null, service: null, kind: "one_time", status: "open", statusWords: "Draft", quoteId: null, bookingId: null, updatedAt: Date.UTC(2027, 2, 1, 14), by: "Jordan" },
  ];

  it("starts bookings and lists booking drafts, and makes nothing by being opened", () => {
    mutate.mockClear();
    data = { "sales:bookingDrafts": drafts };
    const html = render("office", <InternalBookingScreen />);
    snapshot("internal-booking", html);
    expect(html).toContain("Internal Booking");
    expect(html).toContain("Book a service for a customer, arrange recurring cleaning, or continue a booking you started.");
    expect(html).toContain("New booking");
    expect(html).toContain("New recurring booking");
    expect(html).toContain("Booking drafts");
    expect(html).toContain("Dana Whitfield");
    expect(html).toContain("12 Elm St, Austin");
    expect(html).toContain("Recurring · Standard clean");
    expect(html).toContain("Quote saved");
    expect(html).toContain("Customer not chosen yet");
    expect(html).toContain("One-time · service not chosen");
    // Continue opens the existing workspace and returns here.
    expect(html).toContain('href="/app/agents/sales/book/d1?from=internal-booking"');
    expect(html).toContain('href="/app/agents/sales/quotes-proposals"');
    expect(mutate).not.toHaveBeenCalled();
  });

  it("explains how to start when there are no drafts, without inventing any", () => {
    data = { "sales:bookingDrafts": [] };
    const html = render("office", <InternalBookingScreen />);
    snapshot("internal-booking-empty", html);
    expect(html).toContain("No booking drafts yet");
    expect(html).toContain("New booking");
    expect(html).not.toContain("Continue");
  });

  it("files the shared workspace under the tab its draft belongs to, and returns to where the visit came from", () => {
    data = bookingData();
    const booking = render("office", <SalesWorkspace draftId={draftId} />);
    expect(booking).toContain("Internal Booking");
    expect(booking).toContain("Back to Internal Booking");
    expect(booking).toContain("Recurring booking");
    const fromCalendar = render("office", <SalesWorkspace draftId={draftId} from="calendar" />);
    expect(fromCalendar).toContain('href="/app/calendar"');
    expect(fromCalendar).toContain("Back to Calendar");
    // The same address holding a proposal belongs to Quotes & Proposals.
    const proposal = bookingData();
    (proposal["sales:draft"] as { draft: { mode: string; segment: string } }).draft.mode = "proposal";
    (proposal["sales:draft"] as { draft: { mode: string; segment: string } }).draft.segment = "office";
    data = proposal;
    const html = render("office", <SalesWorkspace draftId={draftId} />);
    expect(html).toContain("Back to Quotes &amp; Proposals");
  });

  it("keeps quotes and proposals, and leaves booking creation and booking drafts to Internal Booking", () => {
    mutate.mockClear();
    data = {
      "sales:quotes": [{ _id: "q1", draftId: "d1", customer: "Dana Whitfield", kind: "recurring", status: "saved", totalCents: 14000, firstCents: 23000, service: "Standard clean", cadence: "Every 2 weeks", expiresAt: Date.UTC(2027, 2, 8), createdAt: Date.UTC(2027, 2, 1), by: "Jordan" }],
      "sales:drafts": [
        { _id: "d1", mode: "booking", segment: "residential", bookingKind: "recurring", status: "quoted", customer: "Dana Whitfield", updatedAt: 1, by: "Jordan", bookingId: null, proposalId: null, quoteId: "q1" },
        { _id: "d3", mode: "proposal", segment: "office", bookingKind: "one_time", status: "open", customer: "Acme Offices", updatedAt: 1, by: "Jordan", bookingId: null, proposalId: null, quoteId: null },
      ],
      "proposals:list": [],
    };
    const html = render("office", <QuotesProposalsScreen />);
    snapshot("quotes-proposals", html);
    expect(html).toContain("New proposal");
    expect(html).not.toContain("One-time visit");
    expect(html).not.toContain("Recurring service");
    expect(html).not.toContain("Book service");
    // The saved quote stays here, and continues into its booking.
    expect(html).toContain("Dana Whitfield");
    expect(html).toContain("Continue to booking");
    expect(html).toContain('href="/app/agents/sales/book/d1?from=saved-quote"');
    // Saved, sent, accepted, expired and withdrawn quotes can be told apart.
    expect(html).toContain("Quote status");
    expect(html).toContain("Withdrawn or declined");
    expect(html).toContain("Go to Internal Booking");
    expect(mutate).not.toHaveBeenCalled();
  });
});
