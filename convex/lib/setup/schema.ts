/**
 * Company setup (the owner's onboarding) and the shared company context it collects.
 *
 * Setup keeps only where the owner is and what they chose. What it learns about the company is not kept
 * here: a fact with an authoritative home goes there (the name and clock on the company, postal codes in
 * business settings, services in Services & Pricing), and everything else is a `companyFacts` row that every
 * agent and Chat read. A fact says where it came from and whether a person confirmed it; a found fact is
 * never treated as confirmed.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const PRIORITIES = ["sales", "dispatch", "recruiter", "retention", "pricing", "booking"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const priorityValidator = v.union(...PRIORITIES.map((value) => v.literal(value)));

export const METHODS = ["website", "connect", "manual"] as const;
export type Method = (typeof METHODS)[number];
export const methodValidator = v.union(...METHODS.map((value) => v.literal(value)));

export const FACT_SOURCES = ["owner", "website", "import", "sign_in"] as const;
export const factSourceValidator = v.union(...FACT_SOURCES.map((value) => v.literal(value)));
export const factValueValidator = v.union(v.string(), v.array(v.string()));

export const workResultValidator = v.object({
  /** What was prepared. */
  title: v.string(),
  summary: v.string(),
  /** Which company information it used. */
  used: v.array(v.string()),
  /** What remains uncertain or missing. */
  uncertain: v.array(v.string()),
  /** The records it points at, each with where to open it. Only real records. */
  items: v.array(v.object({ label: v.string(), detail: v.string(), href: v.optional(v.string()) })),
  /** The next decision, and where it is made. */
  next: v.object({ words: v.string(), href: v.string() }),
  /** Real counts behind the summary, for "Your first work". */
  counts: v.record(v.string(), v.number()),
});
export type WorkResult = typeof workResultValidator.type;

export const setupTables = {
  /** One per company. Absent for companies made before setup existed: they are never sent through it. */
  companySetups: defineTable({
    companyId: v.id("companies"),
    /** in_progress: the owner has not entered the workspace. entered: they have; setup continues inside the product. */
    status: v.union(v.literal("in_progress"), v.literal("entered")),
    /** The step the owner was last on, to resume there. */
    step: v.string(),
    methods: v.array(methodValidator),
    priority: v.optional(priorityValidator),
    secondary: v.array(priorityValidator),
    /** Answers to the priority's own questions, by question id. "unsure" is an answer. */
    answers: v.record(v.string(), factValueValidator),
    /** Optional steps the owner chose to skip, so they are not asked again. */
    skipped: v.array(v.string()),
    /** Counts saves, so an older tab or device cannot overwrite a newer one. */
    revision: v.number(),
    /** When each point of the journey was first reached. Measured, never estimated. */
    milestones: v.object({
      startedAt: v.number(),
      contextConfirmedAt: v.optional(v.number()),
      firstArtifactAt: v.optional(v.number()),
      firstReviewedAt: v.optional(v.number()),
      firstActionAt: v.optional(v.number()),
      enteredAt: v.optional(v.number()),
      /** The owner chose the one outcome setup leads with. */
      outcomeSelectedAt: v.optional(v.number()),
      /** The owner pressed "Build my workspace". */
      buildStartedAt: v.optional(v.number()),
      /** The first output the owner can open and use was ready (a draft, a review, a role). */
      firstUsableAt: v.optional(v.number()),
      /** The owner first opened a prepared output from setup to review it. */
      firstOpenedAt: v.optional(v.number()),
      /** The first prepared output was published or switched on by the owner. */
      firstPublishedAt: v.optional(v.number()),
      /** The owner left setup with "Save and exit" before building, and when they came back. */
      exitedAt: v.optional(v.number()),
      resumedAt: v.optional(v.number()),
    }),
    /** How the owner came in, for the funnel: with a website to read, or by hand. */
    entry: v.optional(v.union(v.literal("website"), v.literal("manual"), v.literal("founding"))),
    /**
     * The owner's one "Build my workspace" request: what it coordinates. Asking again finds this, so a
     * refresh, a second tab or a retry never starts the expensive work twice.
     */
    build: v.optional(
      v.object({
        requestedAt: v.number(),
        requestedBy: v.id("members"),
        outcome: priorityValidator,
        configure: v.array(v.string()),
        exclude: v.array(v.string()),
        activationId: v.optional(v.id("activations")),
        /** Why activation didn't start, in the owner's words, when it didn't. */
        activationNote: v.optional(v.string()),
        updatedAt: v.number(),
      }),
    ),
    /** The last time setup sent the owner to another page to connect, import or approve something. */
    handoff: v.optional(v.object({ kind: v.string(), href: v.string(), step: v.string(), at: v.number(), outcome: v.optional(v.union(v.literal("completed"), v.literal("failed"), v.literal("returned"))) })),
    /** Set for a company that was already working in Selestial and chose setup later (`setup.begin`). */
    optedIn: v.optional(v.boolean()),
    /** The Owner closed the setup checklist on Home. It stays closed; setup itself is still there. */
    checklistDismissedAt: v.optional(v.number()),
    /** What setup prepared, so going through it again opens the same drafts instead of making new ones. */
    prepared: v.optional(v.object({ serviceId: v.optional(v.id("services")), agreementId: v.optional(v.id("agreements")), experienceId: v.optional(v.id("bookingExperiences")), hiringNeedId: v.optional(v.id("hiringNeeds")) })),
    updatedAt: v.number(),
  }).index("by_company", ["companyId"]),

  /**
   * One reading of the owner's own website. Each page read is recorded as it is read, so the screen shows
   * real progress. The first completed read is free; a failed or stopped read does not count.
   */
  /**
   * One agent's first work, prepared during setup (lib/setup/work.ts). Each row is a real, persisted run:
   * "preparing" while it is scheduled, then what it found. It reads the company's own records and contacts
   * no one. A new run for the same agent replaces nothing: the newest row is the one shown.
   */
  setupWork: defineTable({
    companyId: v.id("companies"),
    agent: v.union(v.literal("sales"), v.literal("recruiter"), v.literal("dispatch"), v.literal("retention")),
    /** preparing: scheduled. ready_for_review: there is something to look at. waiting: nothing to review until something is added. */
    status: v.union(v.literal("preparing"), v.literal("ready_for_review"), v.literal("waiting"), v.literal("failed")),
    /** What the run is doing, in words that match what the code does. */
    activity: v.string(),
    result: v.optional(workResultValidator),
    problem: v.optional(v.string()),
    requestedBy: v.id("members"),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_company_agent", ["companyId", "agent", "startedAt"]),

  websiteReads: defineTable({
    companyId: v.id("companies"),
    host: v.string(),
    status: v.union(v.literal("queued"), v.literal("reading"), v.literal("ready"), v.literal("failed"), v.literal("stopped")),
    pages: v.array(v.object({ url: v.string(), title: v.string(), ok: v.boolean(), note: v.optional(v.string()), at: v.number() })),
    /** What the pages name as services. An advertised price is kept as the page's own words, never as a price. */
    services: v.array(v.object({ name: v.string(), category: v.union(v.string(), v.null()), advertised: v.union(v.string(), v.null()), sourceRef: v.string() })),
    found: v.number(),
    /** Whether the model also read the pages, or only the rules did. */
    reader: v.union(v.literal("rules"), v.literal("rules_and_model")),
    free: v.boolean(),
    problem: v.optional(v.string()),
    requestedBy: v.id("members"),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_company_started", ["companyId", "startedAt"]),

  /** One import of clients, kept under the key the screen sent, so sending it twice imports once. */
  clientImportRuns: defineTable({
    companyId: v.id("companies"),
    importKey: v.string(),
    source: v.union(v.literal("csv"), v.literal("jobber"), v.literal("housecall_pro")),
    label: v.string(),
    results: v.array(v.object({ index: v.number(), name: v.string(), outcome: v.union(v.literal("created"), v.literal("skipped"), v.literal("failed")), reason: v.optional(v.string()), customerId: v.optional(v.id("customers")) })),
    created: v.number(),
    skipped: v.number(),
    failed: v.number(),
    by: v.id("members"),
    createdAt: v.number(),
  }).index("by_company_key", ["companyId", "importKey"]),

  /** Which client a record in another system became, so importing it again finds it instead of adding it twice. */
  importedRecords: defineTable({
    companyId: v.id("companies"),
    source: v.string(),
    externalId: v.string(),
    customerId: v.id("customers"),
    createdAt: v.number(),
  }).index("by_company_source_external", ["companyId", "source", "externalId"]),

  /** One thing known about the company, with its source and whether a person confirmed it. */
  companyFacts: defineTable({
    companyId: v.id("companies"),
    /** For example "workforce.arrangement". The keys are listed in lib/setup/facts.ts. */
    key: v.string(),
    value: factValueValidator,
    source: factSourceValidator,
    /** Where it was found, for a fact read from a page or a file. */
    sourceRef: v.optional(v.string()),
    retrievedAt: v.optional(v.number()),
    state: v.union(v.literal("found"), v.literal("confirmed")),
    confirmedBy: v.optional(v.id("members")),
    confirmedAt: v.optional(v.number()),
    /** A different value found elsewhere, kept for the owner to choose between. */
    conflict: v.optional(v.object({ value: factValueValidator, source: factSourceValidator, sourceRef: v.optional(v.string()) })),
    updatedAt: v.number(),
  }).index("by_company_key", ["companyId", "key"]),
};
