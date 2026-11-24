import { getFunctionName } from "convex/server";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CompanyProvider, type Role } from "@/components/app/company";

import type { Id } from "../../../../convex/_generated/dataModel";
import { quote } from "../../../../convex/lib/services/engine";
import { emptyCosts, profitability } from "../../../../convex/lib/services/profit";
import { blankSpec, type Spec } from "../../../../convex/lib/services/spec";
import { TEMPLATES } from "../../../../convex/lib/services/templates";

// ── Convex and Next, replaced by what each test hands them ──────────────────────────────────────────

let data: Record<string, unknown> = {};
let pathname = "/app/services";
let search = "mode=template";
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => (args === "skip" ? undefined : data[getFunctionName(ref)]),
  useMutation: () => async () => undefined,
}));
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ replace: () => undefined, push: () => undefined }), useSearchParams: () => new URLSearchParams(search) }));

const { ServicesLayout } = await import("./layout");
const { ServicesHome } = await import("./home");
const { NewService } = await import("./new");
const { ServiceBuilder } = await import("./builder");
const { ChangeReview, beforeAfter } = await import("./changes");
const { QuoteLines, ProfitPanel, CustomerView, TeamView } = await import("./preview");
const { MoneyInput, Toggle, Stepper, InfoTip } = await import("./shared");
const { PricingStep, ExtrasStep } = await import("./steps");
const { marginStanding, PriceStrip } = await import("./visuals");
const { ResearchHome } = await import("./research");
const { PropertyPrices } = await import("./property-prices");
const { ChatProvider } = await import("@/components/app/chat/chat-context");
const { gapsOf, finishRequest, FinishBody } = await import("./finish");
const { Dialog } = await import("@/components/ui/dialog");

const companyId = "company1" as Id<"companies">;
function render(role: Role, node: React.ReactNode) {
  return renderToStaticMarkup(<CompanyProvider company={{ companyId, name: "Elm Cleaning", timezone: "America/Chicago", role }}>{node}</CompanyProvider>);
}

const catalog = (over: Record<string, unknown> = {}) => ({ role: "owner", canDraft: true, canPublish: true, legacyWaiting: 0, setupDone: true, services: [], counts: { active: 0, drafts: 0, waiting: 0, archived: 0 }, ...over });

const spec = (patch: Partial<Spec> = {}): Spec => ({
  ...blankSpec("residential"),
  name: "Standard clean",
  summary: "A full clean.",
  included: [{ id: "oven", label: "Inside the oven", section: "Kitchen", requiresPhoto: true }],
  excluded: ["Exterior windows"],
  pricing: { method: "fixed", amountCents: 15000, laborMinutes: 120 },
  addOns: [{ id: "oven-extra", label: "Oven interior", priceCents: 3500, per: "visit", laborMinutes: 30, maxQuantity: 1, coversItemId: "oven" }],
  ...patch,
});

beforeEach(() => {
  data = {};
  pathname = "/app/services";
  search = "mode=template";
});

const startFixture = (over: Record<string, unknown> = {}) => ({
  known: [
    { key: "services.categories", label: "Who you clean for", value: "Homes", provenance: "confirmed", from: "you", conflict: null },
    { key: "services.offered", label: "Services you offer", value: null, provenance: "unknown", from: null, conflict: null },
    { key: "company.areas", label: "Areas you serve", value: "Austin", provenance: "suggested", from: "your website", conflict: { value: "Round Rock", from: "a file you brought" } },
  ],
  costs: "unknown",
  pricing: "existing",
  canConfigure: true,
  ...over,
});
const prepFixture = (over: Record<string, unknown> = {}) => ({ started: false, ready: true, categories: ["residential"], preparing: ["Standard home cleaning"], priced: false, cards: [], canEdit: true, ...over });
const row = (over: Record<string, unknown> = {}) => ({
  id: "a",
  key: "a",
  name: "Standard clean",
  category: "residential",
  status: "active",
  origin: "manual",
  live: { version: 2, summary: "$150.00 per visit", method: "fixed", publishedAt: 1, description: "", included: 3, addOns: 1, crew: 2, skills: [] },
  draft: null,
  openChange: null,
  prepared: false,
  booking: { estimate: false, liveForms: 1, forms: 1 },
  ...over,
});
const draftRow = (over: Record<string, unknown> = {}) => ({ revision: 1, updatedAt: 1, by: "Dana", step: "basics", name: "Deep clean", summary: "$0.00 per visit", priced: false, illustrative: false, blockers: 1, firstBlocker: "Set a price for this service.", changed: false, ...over });

describe("the workspace frame", () => {
  it("leads with Add service, then Import prices, with the tools under More", () => {
    data["services:catalog"] = catalog();
    const owner = render("owner", <ServicesLayout>x</ServicesLayout>);
    expect(owner).toContain("Add service");
    expect(owner).toContain("Import prices");
    expect(owner).toContain('aria-label="More tools"');
    expect(owner.indexOf("Import prices")).toBeLessThan(owner.indexOf("Add service"));
    for (const gone of ["Build with Selestial", "Use a template", "Pricing Studio</a>", 'role="tablist"']) expect(owner).not.toContain(gone);
    const office = render("office", <ServicesLayout>x</ServicesLayout>);
    expect(office).not.toContain("Add service");
    expect(office).toContain("Selestial&#x27;s own plans and credits are under Settings");
  });

  it("keeps the tools' own addresses, each with a way back and its own heading", () => {
    pathname = "/app/services/changes/abc";
    data["services:catalog"] = catalog({ counts: { active: 1, drafts: 0, waiting: 2, archived: 0 } });
    const html = render("owner", <ServicesLayout>x</ServicesLayout>);
    expect(html).toContain('href="/app/services"');
    expect(html).toMatch(/<h1[^>]*>Review history<\/h1>/);
    expect(html).not.toContain("Add service");
  });

  it("lets a single service bring its own header", () => {
    pathname = "/app/services/svc1";
    data["services:catalog"] = catalog();
    const html = render("owner", <ServicesLayout>inside</ServicesLayout>);
    expect(html).toContain("inside");
    expect(html).not.toContain("Services &amp; Pricing");
  });
});

describe("the first visit", () => {
  it("offers Set up with Selestial first, then Import prices and Create manually, and the two pricing paths", () => {
    data["services:catalog"] = catalog({ setupDone: false });
    data["configure:workspace"] = prepFixture();
    data["services:startingPoint"] = startFixture();
    const html = render("owner", <ServicesHome />);
    expect(html).toContain("Set up with Selestial");
    expect(html.indexOf("Set up with Selestial")).toBeLessThan(html.indexOf("Import prices"));
    expect(html).toContain("Create manually");
    expect(html).toContain("Standard home cleaning");
    expect(html).toContain("Use my existing prices");
    expect(html).toContain("Help me work out my prices");
    expect(html).toMatch(/Use my existing prices.*?Fits what you told us/);
  });

  it("says where each fact came from, and shows a conflict instead of picking one", () => {
    data["services:catalog"] = catalog({ setupDone: false });
    data["configure:workspace"] = prepFixture();
    data["services:startingPoint"] = startFixture();
    const html = render("owner", <ServicesHome />);
    expect(html).toContain("Confirmed");
    expect(html).toContain("Suggested · your website");
    expect(html).toContain("Not known yet");
    expect(html).toContain("a file you brought says “Round Rock”");
  });

  it("shows real background preparation, not a spinner for show", () => {
    data["services:catalog"] = catalog();
    data["configure:workspace"] = prepFixture({ started: true, cards: [{ kind: "services", status: "preparing", items: [], notes: [], missing: [], kept: [], error: null, retrying: false, changed: false, dependsOn: [], finishedAt: null }] });
    data["services:startingPoint"] = startFixture();
    const html = render("owner", <ServicesHome />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Preparing your services");
    expect(html).not.toContain(">Set up with Selestial<");
  });

  it("tells Office plainly who adds services", () => {
    data["services:catalog"] = catalog({ canDraft: false, canPublish: false });
    expect(render("office", <ServicesHome />)).toContain("The Owner or a Manager adds the company&#x27;s services here");
  });

  it("labels template amounts as illustrative and lists what the company must confirm", () => {
    const html = render("owner", <NewService />);
    expect(html).toContain("Templates are structure, not your rates");
    expect(html).toContain("Illustrative amounts");
    expect(TEMPLATES.filter((t) => t.category === "residential").every((t) => html.includes(t.name.replace("/", "/")))).toBe(true);
  });
});

describe("the collection of services", () => {
  it("shows each card's price with its unit, how customers get it, its status and what blocks it", () => {
    data["services:catalog"] = catalog({ services: [row(), row({ id: "b", name: "Deep clean", status: "draft", live: null, draft: draftRow(), booking: { estimate: false, liveForms: 0, forms: 0 } })] });
    data["configure:workspace"] = prepFixture({ started: true });
    data["services:startingPoint"] = startFixture();
    const live = render("owner", <ServicesHome />);
    expect(live).toContain("$150.00 per visit");
    expect(live).toContain("Bookable online on 1 live form");
    expect(live).toContain("Live v2");
    for (const tab of ["Live", "Drafts", "Archived"]) expect(live).toMatch(new RegExp(`role="tab"[^>]*>${tab} `));
    expect(live).not.toContain(">All ");
  });

  it("never shows a draft without a price as $0, and names its first blocker", () => {
    data["services:catalog"] = catalog({ services: [row({ id: "b", name: "Deep clean", status: "draft", live: null, draft: draftRow(), booking: { estimate: false, liveForms: 0, forms: 0 } })] });
    data["configure:workspace"] = prepFixture({ started: true });
    data["services:startingPoint"] = startFixture();
    const html = render("owner", <ServicesHome />);
    expect(html).toContain("No price yet");
    expect(html).not.toContain("$0.00");
    expect(html).toContain("Set a price for this service.");
    expect(html).toContain("Not online yet");
    expect(html).toMatch(/>Finish <svg/);
    expect(html).toContain('href="/app/services/b?finish=1"');
  });

  it("leads with the drafts Selestial prepared, and a way to review them together", () => {
    const prepared = (id: string, name: string) => row({ id, name, status: "draft", live: null, prepared: true, draft: draftRow({ name, priced: true, summary: "$140.00 per visit", blockers: 0, firstBlocker: null, illustrative: false }) });
    data["services:catalog"] = catalog({ services: [prepared("a", "Standard clean"), prepared("b", "Deep clean")] });
    data["configure:workspace"] = prepFixture({ started: true });
    data["services:startingPoint"] = startFixture();
    const html = render("owner", <ServicesHome />);
    expect(html).toContain("2 drafts prepared from your setup");
    expect(html).toContain("2 ready to review");
    expect(html).toContain('href="/app/services/review"');
    expect(html).toContain("Prepared by Selestial");
    expect(html).toMatch(/>Review <svg/);
  });

  it("calls an estimate service an estimate, and a draft on a live form what will happen on publish", () => {
    data["services:catalog"] = catalog({ services: [row({ booking: { estimate: true, liveForms: 1, forms: 1 } }), row({ id: "b", status: "draft", live: null, draft: draftRow({ priced: true, blockers: 0, firstBlocker: null }), booking: { estimate: false, liveForms: 1, forms: 1 } })] });
    data["configure:workspace"] = prepFixture({ started: true });
    data["services:startingPoint"] = startFixture();
    expect(render("owner", <ServicesHome />)).toContain("Customers ask for an estimate");
  });
});

describe("prices always carry their unit", () => {
  it("writes the unit beside a typed amount", () => {
    const html = renderToStaticMarkup(<MoneyInput label="Rate" unit="per cleaner per hour" cents={4500} onCents={() => undefined} />);
    expect(html).toContain("45.00");
    expect(html).toContain("per cleaner per hour");
    expect(html).toMatch(/aria-describedby="[^"]+-unit"/);
  });

  it("shows each line with its reason, the unit, and the total as their sum", () => {
    const result = quote(spec(), { addOns: [{ id: "oven-extra", quantity: 1 }] });
    const html = renderToStaticMarkup(<QuoteLines result={result} showOrder />);
    expect(html).toContain("$150.00");
    expect(html).toContain("per visit");
    expect(html).toContain("Already included in this service, so not charged");
    expect(html).toContain("The order every price is worked out in");
  });

  it("never shows a walkthrough job as a firm price, or as $0", () => {
    const html = renderToStaticMarkup(<QuoteLines result={quote(spec({ pricing: { method: "custom_quote", fromCents: 40000, laborMinutes: null } }), {})} />);
    expect(html).toContain("Walkthrough needed");
    expect(html).toMatch(/>From<\/span><span[^>]*><span class="sr-only">\$400\.00/);
    expect(html).toContain("Starting price");
    const none = renderToStaticMarkup(<QuoteLines result={quote(spec({ pricing: { method: "custom_quote", fromCents: null, laborMinutes: null } }), {})} />);
    expect(none).toContain("Set after a walkthrough");
    expect(none).not.toContain("$0.00");
  });

  it("leads with the total and the price at a glance, with every line one tap away", () => {
    const withExtra = spec({ addOns: [{ id: "fridge", label: "Inside the fridge", priceCents: 2500, per: "visit", laborMinutes: 20, maxQuantity: 1 }] });
    const html = renderToStaticMarkup(<QuoteLines result={quote(withExtra, { addOns: [{ id: "fridge", quantity: 1 }] })} />);
    expect(html).toContain("$175.00");
    expect(html).toContain('aria-label="The price at a glance"');
    expect(html).toMatch(/Base<\/span> \$150\.00/);
    expect(html).toMatch(/Added<\/span> \+\$25\.00/);
    expect(html).toMatch(/<details[^>]*><summary[^>]*>.*How it adds up.*2 lines/);
  });
});

describe("the three preview views", () => {
  it("shows the customer what is and is not included, and an included extra as included", () => {
    const html = renderToStaticMarkup(<CustomerView spec={spec()} result={quote(spec(), {})} />);
    expect(html).toContain("Not included");
    expect(html).toContain("Exterior windows");
    expect(html).toContain("Oven interior: included");
  });

  it("gives the team its checklist by room, with photo markers", () => {
    const html = renderToStaticMarkup(<TeamView spec={spec()} result={quote(spec(), {})} />);
    expect(html).toContain("Kitchen");
    expect(html).toContain("photo");
    expect(html).toContain("all cleaners together");
  });

  it("calls the remainder contribution, never net profit, and lists what was not entered", () => {
    const html = renderToStaticMarkup(<ProfitPanel profit={profitability(quote(spec(), {}), emptyCosts())} />);
    expect(html).toContain("Contribution after direct costs");
    // Nothing is labeled net profit. What contribution, margin and markup mean is one tap away.
    expect(html).not.toMatch(/>\s*net profit/i);
    expect(html).toContain('aria-label="About Contribution after direct costs"');
    expect(html).toContain('aria-label="About Margin"');
    expect(html).toContain('aria-label="About Markup"');
    expect(html).toContain("Not entered");
  });

  it("shows where the price goes as one bar, named in full for screen readers, and the margin as a meter", () => {
    const costs = { ...emptyCosts(), pay: { model: "hourly" as const, hourlyCents: 2000, burdenPercent: 0 }, suppliesPerVisitCents: 500, targetMarginPercent: 40, floorMarginPercent: 25 };
    const profit = profitability(quote(spec(), {}), costs);
    const html = renderToStaticMarkup(<ProfitPanel profit={profit} costs={costs} />);
    expect(html).toMatch(/role="img" aria-label="Where the \$150\.00 goes: Direct costs \$[\d.,]+ \([\d.]+%\), Contribution after direct costs/);
    expect(html).toContain('role="meter"');
    expect(html).toContain("Floor 25% · Target 40%");
    expect(html).toContain("Target price");
  });

  it("puts a margin against the floor and target in words, never by color alone", () => {
    expect(marginStanding(10, 25, 40).words).toBe("Below your 25% floor");
    expect(marginStanding(30, 25, 40).words).toBe("Under your 40% target");
    expect(marginStanding(45, 25, 40).words).toBe("At or above your 40% target");
    expect(marginStanding(-5, null, null).words).toBe("Costs are more than the price");
    expect(marginStanding(45, null, null).words).toBe("No target margin set");
  });
});

describe("explanations wait behind a tip", () => {
  it("names the tip for what it explains and keeps the explanation out of the page until asked", () => {
    const html = renderToStaticMarkup(<InfoTip label="Rush">Short-notice bookings.</InfoTip>);
    expect(html).toContain('aria-label="About Rush"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Short-notice bookings.");
  });

  it("keeps the tip outside the label, so the input keeps its own name", () => {
    const html = renderToStaticMarkup(<MoneyInput label="Minimum charge" unit="per visit" cents={null} onCents={() => undefined} tip="Applied after discounts." />);
    expect(html).toMatch(/<label for="([^"]+)"[^>]*>Minimum charge<\/label><button[^>]*aria-label="About Minimum charge"/);
  });
});

describe("pricing shown, not described", () => {
  const edit = () => undefined;

  it("offers the common methods as cards with an example, and the rest one tap away", () => {
    const html = renderToStaticMarkup(<PricingStep spec={spec()} edit={edit} disabled={false} />);
    expect(html).toContain("Fixed price");
    expect(html).toContain("e.g. $150 a visit");
    expect(html).toContain("More ways to price (5)");
    expect(html).not.toContain("Recurring package");
    expect(html).toMatch(/aria-expanded="false"[^>]*>More ways to price/);
  });

  it("shows the selected method even when it is not a common one", () => {
    const html = renderToStaticMarkup(<PricingStep spec={spec({ pricing: { method: "custom_quote", fromCents: null, laborMinutes: null } })} edit={edit} disabled={false} />);
    expect(html).toContain("Custom quote");
    expect(html).toContain("Fewer ways to price");
  });

  it("works out a usual job from what is typed", () => {
    const hourly = spec({ pricing: { method: "hourly_per_cleaner", rateCents: 4500, minimumHours: 2, incrementMinutes: 30, estimatedLaborMinutes: 240 } });
    const html = renderToStaticMarkup(<PricingStep spec={hourly} edit={edit} disabled={false} />);
    expect(html).toContain("A usual job");
    expect(html).toMatch(/4 cleaner-hours \(\d cleaners?\) × \$45\.00 per cleaner per hour<\/span><span[^>]*>= \$180\.00/);
  });

  it("shows each adjustment as a switch, with what it does when on", () => {
    const base = spec();
    const on = { ...base, modifiers: { ...base.modifiers, rush: { enabled: true, adjustment: { kind: "percent" as const, value: 25 } } } };
    const html = renderToStaticMarkup(<ExtrasStep spec={on} edit={edit} disabled={false} />);
    expect(html).toMatch(/id="([^"]+)-title"[^>]*>Rush<\/span>/);
    expect(html).toMatch(/role="switch" aria-checked="true" aria-labelledby="[^"]+-title"/);
    expect(html).toContain("+25%");
    expect(html).toContain("Off: prices never change with demand");
    expect(html).toContain('aria-label="About Demand pricing"');
  });
});

describe("phase two: less to scan", () => {
  const edit = () => undefined;

  it("folds each extra into a row with its price, or Included when the service already covers it", () => {
    const html = renderToStaticMarkup(<ExtrasStep spec={spec({ addOns: [{ id: "oven-extra", label: "Oven interior", priceCents: 3500, per: "visit", laborMinutes: 30, maxQuantity: 1, coversItemId: "oven" }, { id: "fridge", label: "Inside the fridge", priceCents: 3500, per: "visit", laborMinutes: 30, maxQuantity: 1 }] })} edit={edit} disabled={false} />);
    expect(html).toMatch(/aria-expanded="false"[^>]*>.*?Inside the fridge.*?\$35\.00 per visit/);
    expect(html).toMatch(/Oven interior.*?>Included</);
    expect(html).not.toContain(">Already included as<");
  });

  it("draws comparable prices on one line, named in full, with the company's starting price marked", () => {
    const html = renderToStaticMarkup(<PriceStrip points={[{ key: "a", cents: 12900, label: "North" }, { key: "b", cents: 14500, label: "East" }, { key: "c", cents: 16900, label: "South" }]} low={12900} high={16900} unit="per visit" kind="Advertised starting prices" mine={{ cents: 13500, label: "Your starting price" }} />);
    expect(html).toContain('aria-label="Advertised starting prices per visit: $129.00, $145.00, $169.00. Range $129.00 to $169.00. Your starting price: $135.00."');
    expect(html).toContain("Your starting price $135.00");
  });

  it("lists the prices still the template's on the Review step, each with a way to change it", () => {
    const standard = TEMPLATES.find((t) => t.id === "res-standard")!.spec;
    data["services:service"] = {
      service: { id: "svc1", key: "standard-clean", name: "Standard clean", category: "residential", status: "draft", origin: "template", templateId: "res-standard", publishedVersion: null, publishedAt: null },
      live: null,
      draft: { spec: { ...standard, illustrative: true }, revision: 1, baseVersion: null, step: "review", updatedAt: 1, by: "Dana", rollbackOf: null },
      versions: [],
      changes: [],
      canDraft: true,
      canPublish: true,
    };
    data["services:profile"] = { costs: emptyCosts() };
    data["services:reviewPreview"] = reviewFixture();
    const html = render("owner", <ServiceBuilder serviceId="svc1" />);
    expect(html).toContain('aria-label="Prices still from the template"');
    expect(html).toMatch(/Base price <span[^>]*>\$120\.00/);
    expect(html).toContain("These prices are right for my market");
    expect(html).toMatch(/\d+ prices are still the template&#x27;s example/);
  });

  it("opens one page with three sections, the preview beside it, and less common settings folded", () => {
    data["services:service"] = {
      service: { id: "svc1", key: "standard-clean", name: "Standard clean", category: "residential", status: "draft", origin: "manual", templateId: null, publishedVersion: null, publishedAt: null },
      live: null,
      draft: { spec: spec(), revision: 1, baseVersion: null, step: "pricing", updatedAt: 1, by: "Dana", rollbackOf: null },
      versions: [],
      changes: [],
      canDraft: true,
      canPublish: true,
    };
    data["services:profile"] = { costs: emptyCosts() };
    const html = render("owner", <ServiceBuilder serviceId="svc1" />);
    const order = ["Service &amp; scope", ">Price<", "Booking &amp; team"].map((t) => html.indexOf(t));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("More options");
    expect(html).not.toContain("Recurring discounts</");
    expect(html).not.toContain('aria-current="step"');
    for (const tab of ["Preview", "Selestial", "Review"]) expect(html).toMatch(new RegExp(`role="tab"[^>]*>${tab}<`));
    expect(html).toContain("Try an example job");
    expect(html).toContain("Review &amp; publish");
  });
});

describe("research starts a real Chat conversation", () => {
  const briefs = (over: Record<string, unknown> = {}) => ({ canStart: true, briefs: [], ...over });
  const profile = { costs: emptyCosts(), context: { serviceAreas: "Austin, TX" } };
  const inChat = (role: Role, node: React.ReactNode) => render(role, <ChatProvider userId="user-a" companyId={companyId}>{node}</ChatProvider>);

  it("opens on Chat's own box, centered, with ideas to start from", () => {
    pathname = "/app/services/research";
    data["servicesResearch:briefs"] = briefs();
    data["services:profile"] = profile;
    data["chat:researchChats"] = [];
    const html = inChat("owner", <ResearchHome />);
    expect(html).toContain("What do you want to find out?");
    expect(html).toMatch(/<section aria-labelledby="research-ask" class="[^"]*items-center[^"]*justify-center[^"]*text-center/);
    // Chat's composer: the same labelled box and send button as Chat.
    expect(html).toMatch(/<label[^>]*class="sr-only"[^>]*>Message Selestial<\/label><textarea/);
    expect(html).toContain('placeholder="Ask a pricing or market question…"');
    expect(html).toContain('aria-label="Send"');
    // Chat is told which page the conversation started on.
    expect(html).toContain("You are on Services &amp; Pricing");
    expect(html).toContain("What do cleaning businesses near Austin, TX publish for a standard home clean?");
    expect(html).not.toContain("New research");
  });

  it("lists research chats to carry on, and says where each brief started", () => {
    data["servicesResearch:briefs"] = briefs({ briefs: [{ id: "b1", question: "What do businesses near Austin charge?", geography: "Austin", origin: "chat", mode: "web", state: "ready", blocked: null, findings: 4, createdAt: 1, finishedAt: 2 }] });
    data["services:profile"] = profile;
    data["chat:researchChats"] = [{ id: "c1", title: "Move-out prices near Austin", updatedAt: 1, state: "idle" }];
    const html = inChat("owner", <ResearchHome />);
    expect(html).toContain('href="/app/chat/c1"');
    expect(html).toContain("Move-out prices near Austin");
    expect(html).toContain("started in Chat");
  });

  it("shows Office the briefs, with no box to start one", () => {
    data["servicesResearch:briefs"] = briefs({ canStart: false, briefs: [{ id: "b1", question: "What do businesses near Austin charge?", geography: "Austin", origin: "member", mode: "web", state: "ready", blocked: null, findings: 4, createdAt: 1, finishedAt: 2 }] });
    data["services:profile"] = profile;
    data["chat:researchChats"] = [];
    const html = inChat("office", <ResearchHome />);
    expect(html).not.toContain("Message Selestial");
    expect(html).toContain("What do businesses near Austin charge?");
  });
});

describe("controls a keyboard can reach", () => {
  it("draws switches as switches, with their state in words", () => {
    const html = renderToStaticMarkup(<Toggle label="Demand pricing" checked={false} onChange={() => undefined} />);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("Off");
  });

  it("names both stepper buttons", () => {
    const html = renderToStaticMarkup(<Stepper label="Bedrooms" value={2} onValue={() => undefined} />);
    expect(html).toContain('aria-label="Fewer: Bedrooms"');
    expect(html).toContain('aria-label="More: Bedrooms"');
  });
});

function reviewFixture(over: Record<string, unknown> = {}) {
  return {
    draft: { revision: 1, sameAsLive: false, changes: ["New service: Standard clean"], prices: [{ label: "Usual visit", before: null, after: 15000, note: null }], blockers: [], warnings: [], impact: ["New quotes and visits use it.", "Main booking form shows it as soon as it is live. No booking form is published or changed by this."], ownPrices: 0 },
    live: null,
    forms: [{ id: "f1", name: "Main booking form", live: true }],
    openChange: null,
    canPublish: true,
    canSubmit: true,
    ...over,
  };
}

describe("the builder and review", () => {
  const view = (over: Record<string, unknown> = {}) => ({
    service: { id: "svc1", key: "standard-clean", name: "Standard clean", category: "residential", status: "draft", origin: "manual", templateId: null, publishedVersion: null, publishedAt: null },
    live: null,
    draft: { spec: spec({ illustrative: true }), revision: 3, baseVersion: null, step: "pricing", updatedAt: Date.UTC(2027, 2, 1), by: "Selestial, asked by Dana in Chat", rollbackOf: null },
    versions: [],
    changes: [],
    canDraft: true,
    canPublish: true,
    ...over,
  });

  it("reopens a draft with its sections in order and its save state", () => {
    data["services:service"] = view();
    data["services:profile"] = { costs: emptyCosts() };
    const html = render("owner", <ServiceBuilder serviceId="svc1" />);
    expect(html.indexOf("Basics")).toBeLessThan(html.indexOf("Time and team"));
    expect(html).toContain("Example prices");
    expect(html).toContain("Draft saved");
  });

  it("lets the Owner publish in place, from a review read from the saved draft", () => {
    data["services:service"] = view({ draft: { spec: spec(), revision: 3, baseVersion: null, step: "review", updatedAt: 1, by: "Dana", rollbackOf: null } });
    data["services:profile"] = { costs: emptyCosts() };
    data["services:reviewPreview"] = reviewFixture({ draft: { ...reviewFixture().draft, revision: 3 } });
    const html = render("owner", <ServiceBuilder serviceId="svc1" />);
    expect(html).toContain("What publishing does");
    expect(html).toContain("No booking form is published or changed by this.");
    expect(html).toMatch(/Main booking form.*?Live form/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Publish<\/button>/);
    expect(html).not.toContain("Saving your latest edits");
  });

  it("gives a Manager Submit for review, never Publish", () => {
    data["services:service"] = view({ canPublish: false, draft: { spec: spec(), revision: 3, baseVersion: null, step: "review", updatedAt: 1, by: "Dana", rollbackOf: null } });
    data["services:profile"] = { costs: emptyCosts() };
    data["services:reviewPreview"] = reviewFixture({ canPublish: false, draft: { ...reviewFixture().draft, revision: 3 } });
    const html = render("manager", <ServiceBuilder serviceId="svc1" />);
    expect(html).toContain("Submit for review");
    expect(html).not.toMatch(/>Publish</);
    expect(html).toContain("Only the Owner publishes");
  });

  it("says a review is behind when the screen has a newer revision than the server read", () => {
    data["services:service"] = view({ draft: { spec: spec(), revision: 4, baseVersion: null, step: "review", updatedAt: 1, by: "Dana", rollbackOf: null } });
    data["services:profile"] = { costs: emptyCosts() };
    data["services:reviewPreview"] = reviewFixture();
    expect(render("owner", <ServiceBuilder serviceId="svc1" />)).toContain("Saving your latest edits");
  });

  it("shows a manager that only the Owner approves, with no approve button", () => {
    data["services:change"] = changeFixture();
    const html = render("manager", <ChangeReview changeId="c1" />);
    expect(html).toContain("Only the Owner approves and publishes price changes");
    expect(html).not.toContain("Approve and publish");
    expect(html).toContain("Set the default crew to 2");
    expect(html).toContain("They describe the price, not how customers will respond");
  });

  const changeFixture = () => ({
      id: "c1",
      service: { id: "svc1", name: "Standard clean", status: "draft", liveVersion: null },
      kind: "publish",
      state: "in_review",
      hash: "h",
      title: "Add Standard clean",
      reason: "New.",
      evidence: [],
      agentNotes: [{ agent: "dispatch", status: "concern", title: "Dispatch: timing or staffing may not hold", detail: "Too long.", suggestion: { label: "Set the default crew to 2", field: "team.crewSize", value: 2 } }],
      impact: ["Booked visits keep their price."],
      customerNotice: { required: false, note: "" },
      contractReview: { required: false, note: "" },
      effectiveAt: null,
      submittedAt: 1,
      submittedBy: "Dana",
      approval: null,
      publishedAt: null,
      publishedBy: null,
      closedReason: null,
      version: 1,
      fromVersion: null,
      after: spec(),
      before: null,
      changesInWords: ["New service: Standard clean."],
      prices: [{ label: "A usual visit", before: null, after: 15000 }],
      liveMoved: false,
      draftMoved: false,
      propertyPrice: null,
      ownPrices: [],
      canPublish: false,
      canWithdraw: true,
  });

  it("shows what changes as old and new, and folds away prices that stay the same", () => {
    data["services:change"] = {
      ...changeFixture(),
      changesInWords: ["Price: $150.00 per visit → $165.00 per visit.", "The customer description changed."],
      prices: [
        { label: "A small home", before: 15000, after: 16500 },
        { label: "A large home", before: 22000, after: 22000 },
      ],
      canPublish: true,
    };
    const html = render("owner", <ChangeReview changeId="c1" />);
    expect(html).toMatch(/line-through[^>]*><span class="sr-only">was <\/span>\$150\.00 per visit/);
    expect(html).toContain("The customer description changed.");
    expect(html).toContain("+$15.00 (+10%)");
    expect(html).toContain("1 example job priced the same");
    expect(html).toContain("Approves exactly this version 1, nothing else");
    expect(html).toContain("Booked visits and signed agreements keep their price");
  });

  it("reviews a property's own price: the property, the price now and proposed, and one approve button", () => {
    data["services:change"] = {
      ...changeFixture(),
      kind: "property_price",
      title: "Own price for 12 Elm St, Austin",
      changesInWords: [],
      prices: [],
      agentNotes: [],
      impact: ["Extras, rush, discounts, the minimum charge and rounding still come from the service."],
      propertyPrice: {
        property: { id: "p1", name: "12 Elm St, Austin", address: "12 Elm St, Austin 78701" },
        customer: { id: "c1", name: "Dana Whitfield" },
        baseCents: 18500,
        laborMinutes: 200,
        until: { kind: "end", date: "2027-06-30" },
        untilWords: "Ends after June 30, 2027",
        untilDay: "June 30, 2027",
        addedTasks: ["Water the plants"],
        extras: [{ id: "oven-extra", label: "Oven interior", included: true, priceCents: null, serviceCents: 3500, unit: "per visit" }],
        current: { baseCents: 17000, approvedAt: 1, untilWords: null, addedTasks: [], extras: [] },
        catalog: { version: 3, summary: "$150.00 per visit", spec: spec() },
        moved: null,
      },
      canPublish: true,
    };
    const html = render("owner", <ChangeReview changeId="c1" />);
    expect(html).toContain("12 Elm St, Austin");
    expect(html).toContain("Dana Whitfield");
    expect(html).toMatch(/line-through[^>]*><span class="sr-only">now <\/span>\$170\.00/);
    expect(html).toContain("$185.00");
    expect(html).toContain("$150.00 per visit (version 3)");
    expect(html).toContain("Ends after June 30, 2027");
    expect(html).toContain("3 h 20 min");
    // The example job at the service's own fixed price, priced both ways.
    expect(html).toMatch(/\$185\.00<\/span> here[\s\S]*\$150\.00<\/span> elsewhere/);
    expect(html).toContain("Also done here, on every visit");
    expect(html).toContain("• Water the plants");
    expect(html).toMatch(/Oven interior[\s\S]*line-through[^>]*><span class="sr-only">service price <\/span>\$35\.00<\/span>Included/);
    expect(html).toContain("Approve this price");
    expect(html).not.toContain("Approve only");
    expect(html).toContain("The service&#x27;s price and other properties stay as they are");
    expect(html).not.toContain("Customers to be told");

    data["services:change"] = { ...(data["services:change"] as object), propertyPrice: { ...(data["services:change"] as { propertyPrice: object }).propertyPrice, moved: "This property's price changed after this was proposed." } };
    const moved = render("owner", <ChangeReview changeId="c1" />);
    expect(moved).toContain("This property&#x27;s price changed");
    expect(moved).toMatch(/<button[^>]*disabled=""[^>]*>Approve this price/);
  });

  it("lists the properties that keep their own price in a catalog change's review", () => {
    data["services:change"] = { ...changeFixture(), ownPrices: [{ id: "pp1", property: "12 Elm St, Austin", customer: "Dana Whitfield", baseCents: 18500, until: null, untilWords: "Review by May 1, 2027" }] };
    const html = render("owner", <ChangeReview changeId="c1" />);
    expect(html).toContain("Properties that keep their own price");
    expect(html).toContain("Dana Whitfield · review by May 1, 2027");
    expect(html).toContain("$185.00 base");
  });

  it("reads a change line as its label, old value and new value", () => {
    expect(beforeAfter("Default crew: 1 → 2.")).toEqual({ label: "Default crew", before: "1", after: "2" });
    expect(beforeAfter("Rush switched on.")).toBeNull();
  });
});

describe("property prices on a service", () => {
  const row = {
    id: "pp1",
    propertyId: "p1",
    property: "12 Elm St, Austin",
    address: "12 Elm St, Austin",
    customerId: "c1",
    customer: "Dana Whitfield",
    baseCents: 18500,
    laborMinutes: null,
    addedTasks: ["Water the plants", "Feed the cat"],
    extras: [{ id: "oven-extra", label: "Oven interior", included: false, priceCents: 3000, serviceCents: 3500, unit: "per visit" }],
    until: { kind: "review", date: "2027-03-10" },
    untilWords: "Review by March 10, 2027",
    dueSoon: true,
    lapsed: false,
    reason: "Walkthrough.",
    state: "active",
    approvedAt: Date.UTC(2027, 1, 20),
    approvedBy: "Dana",
    catalogVersion: 1,
    catalogMoved: true,
    endedAt: null,
    endedReason: null,
    changeId: "ch1",
  };
  const prices = (over: Record<string, unknown> = {}) => ({ live: true, active: [row], waiting: [{ changeId: "ch2", state: "in_review", property: "40 Oak Ave, Austin", customer: "Sam Lee", baseCents: 15000, untilWords: null, submittedAt: 1, replacesOwnPrice: false }], past: [], today: "2027-03-01", canPropose: true, canEnd: true, ...over });

  it("shows each property's own price, its date, and that it kept its price through a service change", () => {
    data["propertyPrices:forService"] = prices();
    const html = render("owner", <PropertyPrices serviceId={"s1" as Id<"services">} spec={spec()} />);
    expect(html).toContain("12 Elm St, Austin");
    expect(html).toContain("$185.00");
    expect(html).toContain("base per visit");
    expect(html).toContain("Review by March 10, 2027");
    expect(html).toContain("Kept its price through a service change");
    expect(html).toContain("+2 tasks here");
    expect(html).toContain("Oven interior: $30.00 per visit");
    expect(html).toContain("Waiting for the Owner");
    expect(html).toContain("40 Oak Ave, Austin");
    expect(html).toContain("Add a property price");
    expect(html).toContain('aria-label="End the price for 12 Elm St, Austin"');
  });

  it("lets a Manager propose and change but not end, and an Office member only read", () => {
    data["propertyPrices:forService"] = prices({ canEnd: false });
    const manager = render("manager", <PropertyPrices serviceId={"s1" as Id<"services">} spec={spec()} />);
    expect(manager).toContain("Add a property price");
    expect(manager).not.toContain("End the price");
    data["propertyPrices:forService"] = prices({ canEnd: false, canPropose: false });
    const office = render("office", <PropertyPrices serviceId={"s1" as Id<"services">} spec={spec()} />);
    expect(office).not.toContain("Add a property price");
    expect(office).not.toContain("Change the price");
    expect(office).toContain("$185.00");
  });

  it("says plainly when no property has its own price", () => {
    data["propertyPrices:forService"] = prices({ active: [], waiting: [] });
    expect(render("owner", <PropertyPrices serviceId={"s1" as Id<"services">} spec={spec()} />)).toContain("No property has its own price. Every visit uses the service&#x27;s price.");
  });
});

describe("finishing a draft with Selestial", () => {
  const blank = (): Spec => ({ ...blankSpec("residential"), name: "Deep clean" });

  it("splits what is missing into what Selestial drafts and what only the company sets", () => {
    const gaps = gapsOf({ ...blank(), illustrative: true, requirements: [{ id: "ins", label: "Insurance for work at height", confirmed: false }] });
    const by = (kind: string) => gaps.filter((g) => g.kind === kind).map((g) => g.id);
    expect(by("selestial")).toEqual(["summary", "included", "excluded"]);
    expect(by("price")).toEqual(["price"]);
    expect(by("confirm")).toEqual(["illustrative", "req-ins"]);
    // A finished service has nothing left.
    expect(gapsOf(spec())).toEqual([]);
  });

  it("asks Selestial only for words and lists, never for an amount", () => {
    const request = finishRequest(gapsOf(blank()));
    expect(request).toContain("customer description");
    expect(request).toContain("included tasks");
    expect(request).toContain("Don't change any price or amount, and don't submit or publish.");
    expect(request).not.toMatch(/\$\d/);
  });

  it("opens the Finish pop-up from a link, with the price set right inside it", () => {
    search = "finish=1";
    data["services:service"] = {
      service: { id: "svc1", key: "deep", name: "Deep clean", category: "residential", status: "draft", origin: "manual", templateId: null, publishedVersion: null, publishedAt: null },
      live: null,
      draft: { spec: blank(), revision: 1, baseVersion: null, step: "basics", updatedAt: 1, by: "Dana", rollbackOf: null },
      versions: [],
      changes: [],
      canDraft: true,
      canPublish: true,
    };
    data["services:profile"] = { costs: emptyCosts() };
    data["services:assistant"] = { conversationId: null };
    const html = render("owner", <ServiceBuilder serviceId="svc1" />);
    expect(html).toMatch(/Finish draft.*?>4</);
    const body = render(
      "owner",
      <Dialog open>
        <FinishBody spec={blank()} edit={() => undefined} disabled={false} kept={[]} costs={null} canPublish onAsk={async () => undefined} onGoTo={() => undefined} onClose={() => undefined} />
      </Dialog>,
    );
    expect(body).toContain("Finish Deep clean");
    expect(body).toContain("4 things left before it can be published");
    expect(body).toContain("Selestial can draft these");
    expect(body).toContain("Ask Selestial to draft 3");
    expect(body).toContain("How it&#x27;s priced");
  });

  it("offers the Owner prices worked out from their own costs, with how", () => {
    const standard = TEMPLATES.find((t) => t.id === "res-standard")!.spec;
    const costs = { ...emptyCosts(), pay: { model: "hourly", hourlyCents: 2200, burdenPercent: 12 }, targetMarginPercent: 40 } as never;
    const body = render(
      "owner",
      <Dialog open>
        <FinishBody spec={{ ...standard, illustrative: true }} edit={() => undefined} disabled={false} kept={[]} costs={costs} canPublish onAsk={async () => undefined} onGoTo={() => undefined} onClose={() => undefined} />
      </Dialog>,
    );
    expect(body).toContain("Work it out from your costs");
    expect(body).toContain("Use these prices");
    const manager = render(
      "manager",
      <Dialog open>
        <FinishBody spec={{ ...standard, illustrative: true }} edit={() => undefined} disabled={false} kept={[]} costs={null} canPublish={false} onAsk={async () => undefined} onGoTo={() => undefined} onClose={() => undefined} />
      </Dialog>,
    );
    expect(manager).not.toContain("Work it out from your costs");
    expect(manager).toContain("I&#x27;ve replaced or confirmed every amount for my market");
  });
});
