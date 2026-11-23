/**
 * Deleting a whole company (docs/operations/07-account-closure.md): what happens to every company table,
 * and why. This is the single source of truth: the staff run (convex/companyDeletion.ts) applies it, the
 * staff console and the Owner's screen show it, and convex/companyDeletion.test.ts fails when a table
 * with a `companyId` is added to the schema without a decision here.
 *
 * Three treatments:
 *  - delete:    the rows go, with any files they hold in storage.
 *  - retain:    the rows stay because the law, the phone carriers or a payment processor need them to be
 *               producible (invoices, payments, refunds, payouts, consent and opt-out records, Selestial's
 *               own billing ledger, the record of this request). Personal content inside them is stripped
 *               where the record still makes sense without it; addresses that prove an opt-out are kept
 *               as a one-way hash.
 *  - anonymize: the row stays so retained financial rows still point at something whole (a visit, a
 *               customer, a cleaner), but names, contact details, addresses and free text are replaced with
 *               a fixed placeholder.
 *
 * Conservative by design: where it is unclear whether a record is legally required, it is retained with
 * its personal fields stripped and marked `counsel: true`, so the docs list it for counsel to decide.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { sha256Bytes } from "../agreements/hash";

export type Treatment = "delete" | "retain" | "anonymize";

/** What personal text is replaced with. One fixed value, so nothing about the person survives in it. */
export const PLACEHOLDER = "[deleted]";
/** The company row's name once deletion has finished. The row stays so retained records point at something. */
export const DELETED_COMPANY = "Deleted company";

type Row = Record<string, unknown>;

export type TablePlan = {
  table: string;
  treatment: Treatment;
  /** Why, in words staff and counsel can read. */
  reason: string;
  /** Fields replaced with the placeholder (dotted paths reach inside an object). Optional fields are removed. */
  personal?: readonly string[];
  /** Fields replaced with a one-way hash (sha256 of the trimmed, lower-cased value). */
  hashed?: readonly string[];
  /** For a retained table: rows this refuses are deleted instead (for example events that prove nothing). */
  keepRow?: (row: Row) => boolean;
  /** More changes worked out from other records, before those records are deleted. */
  derive?: (ctx: MutationCtx, row: Row) => Promise<Row>;
  /** Retained under a conservative reading; listed for counsel. */
  counsel?: boolean;
  /**
   * A retained table with nothing to strip that has no index starting with companyId: it is left alone and
   * not counted, because counting would read every company's rows.
   */
  uncounted?: boolean;
};

const del = (table: string, reason: string): TablePlan => ({ table, treatment: "delete", reason });
const keep = (table: string, reason: string, extra: Partial<TablePlan> = {}): TablePlan => ({ table, treatment: "retain", reason, ...extra });
const anon = (table: string, reason: string, personal: readonly string[], extra: Partial<TablePlan> = {}): TablePlan => ({ table, treatment: "anonymize", reason, personal, ...extra });

/** The hash kept in place of an address: proves a given phone or email asked to stop, without holding it. */
export function addressHash(value: string): string {
  return `sha256:${sha256Bytes(new TextEncoder().encode(value.trim().toLowerCase()))}`;
}

/** A consent record's recipient, looked up while the person's record still exists, kept only as hashes. */
async function recipientHashes(ctx: MutationCtx, row: Row): Promise<Row> {
  const recipient = row.recipient as { kind?: string; id?: string } | undefined;
  const hashes: string[] = [];
  if (recipient?.id && (recipient.kind === "customer" || recipient.kind === "cleaner" || recipient.kind === "applicant")) {
    const table = recipient.kind === "customer" ? "customers" : recipient.kind === "cleaner" ? "cleaners" : "applicants";
    const id = ctx.db.normalizeId(table, recipient.id);
    const person = id ? ((await ctx.db.get(id)) as { phone?: string; email?: string } | null) : null;
    if (person?.phone && person.phone !== PLACEHOLDER) hashes.push(`phone ${addressHash(person.phone)}`);
    if (person?.email && person.email !== PLACEHOLDER) hashes.push(`email ${addressHash(person.email)}`);
  }
  return { evidence: hashes.length ? `Recipient at company deletion: ${hashes.join("; ")}. Earlier evidence text removed.` : "Earlier evidence text removed at company deletion." };
}

/** Event types that prove consent, an opt-out, a message sent, money moving or what happened to the account. */
const KEPT_EVENT_PREFIXES = ["consent", "compliance", "suppression", "permission", "message", "texting", "invoice", "payment", "payment_intent", "refund", "tip", "team_payment", "earning", "collection", "stripe", "billing", "company", "export", "customer.erased", "cleaner.erased"];
const CODE = /^[A-Za-z0-9_.:+-]{1,64}$/;

/** Event data keeps numbers, true/false and short codes and ids; any other text is replaced. */
function eventData(_ctx: MutationCtx, row: Row): Promise<Row> {
  const data = (row.data ?? undefined) as Record<string, unknown> | undefined;
  if (!data) return Promise.resolve({});
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) out[key] = typeof value === "string" && !CODE.test(value) ? PLACEHOLDER : value;
  return Promise.resolve({ data: out });
}

/**
 * Every company table, in the order the run visits them. Consent records come first, because their
 * hashes are worked out from customer, cleaner and applicant records that are deleted or anonymized later.
 */
export const DELETION_PLAN: readonly TablePlan[] = [
  // ── Consent, opt-outs and texting registration: kept (carriers and the TCPA) ───────────────────
  keep("contactPermissions", "Proof of what each person agreed to and when they said stop. Carriers and US texting law expect consent records to be producible. Kept with the recipient as a hash.", { personal: ["evidence"], derive: recipientHashes }),
  keep("permissionHistory", "Every change to a person's consent, for the same reason. Kept with the recipient as a hash.", { personal: ["evidence"], derive: recipientHashes }),
  keep("suppressions", "Opt-outs and bounces: so a person who said stop is never contacted again. The address is kept only as a hash.", { hashed: ["address"], personal: ["sourceMessage", "note", "liftNote"] }),
  keep("consentDisclosures", "The exact consent wording recipients were shown. Needed to prove what they agreed to. Holds no personal data."),
  keep("sendIntents", "The consent check made before each send: which permission applied. The address is kept only as a hash.", { hashed: ["address"] }),
  keep("messages", "That a message was sent, on which channel, when, and under what permission: carriers expect sending records. The words, subject and links are removed; the address is kept only as a hash.", {
    hashed: ["to"],
    personal: ["subject", "replyTo", "body", "linkPath", "problem", "recipients", "notice", "salesLinks", "refusal"],
  }),
  keep("textingRequests", "The carrier registration (brand, campaign, number, release dates) Selestial filed for the company. Carriers can ask about it after the number is released.", {
    personal: ["taxIdSealed", "otp", "leaseToken", "leaseUntil", "note", "diagnostics", "problem"],
    counsel: true,
  }),
  keep("textingSubmissions", "What was filed with the carriers, with the owner's authorization. Evidence for the registration.", { counsel: true }),
  keep("textingPages", "The published opt-in, privacy and terms pages the carriers reviewed: evidence of how consent was collected.", { counsel: true }),
  keep("textingEvidence", "Evidence of the opt-in flow given to the carriers (screenshots and links), with its files.", { counsel: true }),
  keep("textingExceptions", "Holds the owner's recorded authorization to release or move the texting number.", { personal: ["internalWords"], counsel: true }),
  del("textingSetups", "The owner's working answers for texting setup, including the sealed tax id. What was filed is kept in textingSubmissions."),
  del("textingNotes", "Selestial's working notes on the texting setup; the outcome is in the registration."),
  del("textingRecommendations", "Suggestions made while setting texting up; not a record of anything filed."),
  del("numberSearches", "Lists of numbers that were for sale at one moment."),
  del("complianceProfiles", "The company's messaging settings. What was filed with carriers is kept in textingSubmissions."),
  keep("agreementAcceptances", "The company's acceptance of Selestial's Terms: the contract the service ran under."),

  // ── Customer money: kept (tax, accounting, card-network disputes) ──────────────────────────────
  keep("invoices", "Invoices: amounts, tax, dates and numbers are accounting and tax records. Line descriptions, the memo and the link part are removed.", { personal: ["lines", "memo", "publicId"] }),
  keep("payments", "Payments: amounts, dates and Stripe ids. Disputes and chargebacks can arrive for months, and they are accounting records. The browser secret and notes are removed.", { personal: ["stripe.clientSecret", "manual", "problem"] }),
  keep("refunds", "Refunds: amounts, dates and Stripe ids, for accounting and disputes. The written reason is removed.", { personal: ["reason", "problem"] }),
  keep("invoiceCredits", "Credits against invoices: part of the invoice's accounting record. The reason is removed.", { personal: ["reason"] }),
  keep("tips", "Tips: amounts paid through the company's invoices and passed to cleaners. The note is removed.", { personal: ["note"] }),
  keep("earnings", "What each cleaner earned per visit: payroll and contractor-payment (1099) records. Free-text facts are removed.", { personal: ["facts", "voidReason"], counsel: true }),
  keep("teamPayments", "Payouts to cleaners: amounts, dates and references. The note is removed.", { personal: ["note"] }),
  keep("stripeAccounts", "The company's Stripe Connect account id: disputes and Stripe's questions about past payments reference it. The onboarding link is removed.", { personal: ["onboarding", "problem"] }),
  del("financeMessages", "Drafts of invoice and reminder messages; what was sent is in messages."),
  del("financeSettings", "The company's invoice settings."),
  del("statementLinks", "Links to cleaners' earnings statements."),
  del("expenses", "The company's own expense bookkeeping, held for the company; it had an export."),
  del("expenseReceipts", "Receipt files for the company's expenses."),
  del("expenseRules", "Rules for filing the company's expenses."),
  del("expenseImports", "Imported bank lines for the company's expenses."),
  del("payArrangements", "Pay rates agreed with cleaners; the rate applied to each visit is kept with its earning."),

  // ── Selestial's own billing ledger: kept ─────────────────────────────────────────────────────────
  keep("billingAccounts", "Selestial's billing record for the company: the plan, Autumn customer id and balances. Selestial's own accounting."),
  keep("billingDunning", "Unpaid Selestial invoices and what happened to each: Selestial's own accounting."),
  keep("billingIntents", "Purchases the company started with Selestial. The short-lived payment address is removed.", { personal: ["url", "problem"] }),
  keep("billingWebhooks", "Autumn and Stripe deliveries to Selestial about the company's plan: Selestial's own accounting.", { uncounted: true }),
  keep("aiExecutions", "Each piece of AI work and its credit charge: Selestial's billing ledger.", { personal: ["message", "settleProblem"] }),
  keep("messagingTopUps", "Messaging balance purchases and refunds: Selestial's billing ledger.", { personal: ["invoiceUrl", "problem"] }),
  keep("messagingCharges", "What each message cost and how it was settled: Selestial's billing ledger.", { personal: ["reason", "settleProblem"] }),
  keep("messagingAttention", "Selestial staff's review of the company's messaging balance.", { personal: ["detail", "note"] }),
  keep("aiUsage", "AI usage counted against the plan, kept for billing reconciliation with the AI providers.", { personal: ["raw"] }),
  keep("earlyOffers", "The introductory $199 plan price: when it was reserved, claimed and ended. Selestial's own billing record, and what stops a returning company getting the introductory price again. No personal data.", { personal: ["switchProblem"] }),
  keep("chatUsage", "Monthly AI chat usage counted against the plan. Numbers only."),
  keep("mediaAllowances", "Monthly image and video usage counted against the plan. Numbers only."),

  // ── Selestial's records about the request, the account and access to it: kept ─────────────────
  keep("trustRequests", "Privacy requests, including this one: kept three years after closing, then deleted (convex/retention.ts)."),
  keep("deletionRecords", "Proof of each earlier erasure: kept three years, then deleted (convex/retention.ts)."),
  keep("companyDeletions", "Proof of this deletion: what was deleted, anonymized and kept."),
  keep("incidents", "Selestial's operational records about the service. Diagnostics text is removed.", { personal: ["diagnostics"] }),
  keep("lockdownCompanies", "Selestial's record of a restore that paused the company.", { uncounted: true }),
  keep("supportSessions", "When Selestial staff were in the company's workspace and why: Selestial's access audit.", { personal: ["changes"], counsel: true }),
  keep("supportGrants", "The owner's grants of support access: Selestial's access audit."),
  keep("supportEvents", "What staff did in the workspace: Selestial's access audit. Summaries are removed; ids and times stay.", { personal: ["summary"], counsel: true }),

  // ── The people: anonymized where money points at them, deleted otherwise ─────────────────────
  anon("customers", "Retained invoices and payments point at the customer. The row stays as an anchor with every personal detail removed.", [
    "name", "email", "phone", "preferences", "privateNotes", "communication", "relationshipNote", "archivedReason", "source",
  ]),
  anon("properties", "Retained invoices point at the property (sales tax can depend on where the work was done). The address and every note are removed.", [
    "label", "address", "accessInstructions", "parking", "crewNotes", "clientNotes", "officeNotes", "details",
  ], { counsel: true }),
  anon("cleaners", "Retained earnings and payouts point at the cleaner. The row stays with every personal detail and the photo removed.", [
    "name", "email", "phone", "skills", "serviceAreas", "preferredAreas", "photoStorageId", "checkIn", "rehireRestriction",
  ]),
  anon("jobs", "Retained invoices and earnings point at the visit: its date, price and status stay. Instructions and notes are removed.", [
    "scope", "instructions", "cancelReason", "completionReview", "completionReturns", "completionReturn", "recovery", "serviceSnapshot",
  ]),
  anon("assignments", "Retained earnings point at the assignment: its pay and times stay. Locations and notes are removed.", [
    "scope", "endReason", "checkIn.lat", "checkIn.lng", "checkIn.accuracyM", "late.reason", "contact", "completion.note",
  ]),
  anon("applications", "Hiring records: a line that an application for a role existed, how far it got and why it ended, with no person in it (the same line convex/lib/recruiter/retention.ts keeps).", [
    "roleSeen", "contact", "facts", "nextAction", "closure.note",
  ], { counsel: true }),
  anon("hiringDecisions", "The decision on each application, with the written reason removed.", ["reason"], { counsel: true }),
  del("applicants", "Applicants' names and contact details."),
  del("members", "The company's memberships. Sign-in accounts (Clerk users) are not deleted: a person may belong to other companies."),
  del("invitations", "Invitations to join the company."),
  del("notificationPreferences", "Each member's notification choices."),
  del("memberNotices", "In-app notices to members."),
  del("tutorialProgress", "Members' progress through tutorials."),
  del("tutorialReports", "Feedback on tutorials."),
  del("tutorialEvents", "Tutorial views."),

  // ── Operational records: deleted ─────────────────────────────────────────────────────────────────
  del("integrationRequests", "Requests for integrations."),
  del("agentAccessRequests", "Requests for agents."),
  del("dataExports", "Earlier exports of the company's records, with their files."),
  del("availabilityWindows", "Cleaners' weekly availability."),
  del("timeOff", "Cleaners' time off."),
  del("tasks", "Agent and team tasks."),
  del("permissions", "The company's agent permission settings."),
  del("approvals", "Agent approvals and their reasons."),
  del("actionLinks", "Cleaners' job and offer links."),
  del("coverageRequests", "Requests to cover a visit."),
  del("checklistItems", "Visit checklists."),
  del("checklistTemplates", "Checklist templates."),
  del("evidence", "Photos from visits, with their files."),
  del("jobReports", "Reports cleaners wrote about visits."),
  del("replyReadings", "How cleaners' replies were read."),
  del("toolRuns", "Agent tool calls."),
  del("hiringNeeds", "Open roles."),
  del("mailboxConnections", "Connected inboxes, disconnected and revoked first."),
  // Quo (convex/quo.ts): the company's own phone account. What was sent is kept in messages.
  del("quoConnections", "The connected Quo account: its sealed API key and webhook secret, and which numbers agents may use."),
  del("smsConversations", "Which number each texting conversation runs on. The messages themselves are kept in messages."),
  del("smsInbound", "Texts received through Quo. Opt-outs they carried are kept in contactPermissions and suppressions."),
  // Bringing a business to Selestial (convex/migration.ts): working import data, with the uploaded files.
  del("migrations", "Imports from a previous system: the working record of what was brought in."),
  del("migrationFiles", "Files uploaded for an import, with the stored files."),
  del("migrationRows", "Rows read from those files while the import was reviewed."),
  del("migrationRuns", "Each import run and its counts."),
  del("migrationLinks", "Which record each imported row became, kept for undo."),
  del("importedHistory", "Past visits imported from a previous system, for reference only; they were never invoiced here."),
  keep("openingBalances", "Amounts customers already owed when the company moved to Selestial: part of the record of money owed. Notes are removed.", { personal: ["notes"], counsel: true }),
  // Agent Controls (convex/lib/controls): settings and their history.
  del("controlChanges", "Changes the company made to agent settings."),
  del("allowanceDays", "Daily counts of agent work against the company's own limits."),
  del("allowanceReservations", "Holds on those daily limits for work in progress."),
  del("mailboxCredentials", "Sealed mailbox authorizations (deleted when the inbox is disconnected; any left are deleted here)."),
  del("oauthStates", "Ten-minute mailbox sign-in records."),
  del("sourceMessages", "Emails read from the company's inbox."),
  del("recruiterFindings", "What Recruiter found about applications and the messages it prepared."),
  del("inboxRuns", "Records of each read of the hiring inbox, kept 30 days."),
  del("applicantLinks", "Applicants' links."),
  del("formSessions", "Applicants' answers."),
  del("applicantAttachments", "Applicants' files."),
  del("screenings", "Screening of applications."),
  del("interviewSlots", "Interview times."),
  del("interviews", "Interviews."),
  del("hiringOffers", "Offers to applicants."),
  del("onboardingHandoffs", "New-hire handoffs."),
  del("calendarEvents", "Calendar meetings, appointments, time away, training sessions and inspections."),
  del("memberHours", "Members' weekly working hours."),
  del("conversations", "Company Chat conversations."),
  del("chatMessages", "Company Chat messages, with attachments."),
  del("chatRuns", "Company Chat responses."),
  del("chatActionSteps", "What Company Chat did."),
  del("chatArtifacts", "Company Chat drafts."),
  del("chatArtifactVersions", "Versions of Company Chat drafts."),
  del("companyKnowledge", "What the company taught its agents."),
  del("chatUploads", "Chat uploads, with their files."),
  del("knowledgeChunks", "A search index of company knowledge."),
  del("agreements", "The company's own agreements with its customers and cleaners; the company had an export."),
  del("agreementVersions", "Versions of the company's agreements."),
  del("agreementLinks", "Links between agreements and records."),
  del("agreementComments", "Comments on agreements."),
  del("agreementTemplates", "Agreement templates."),
  del("agreementTemplateVersions", "Versions of agreement templates."),
  del("agreementFiles", "Agreement files, with the files."),
  del("agreementSignatureRequests", "Signature requests on the company's agreements, with the signed files; the company had an export."),
  del("agreementSigningLinks", "Signing links."),
  del("googleConnections", "Google connections, disconnected and revoked first."),
  del("googleCredentials", "Sealed Google authorizations (deleted on disconnect; any left are deleted here)."),
  del("googleOAuthStates", "Ten-minute Google sign-in records."),
  del("googleResources", "Google calendars, sheets and accounts chosen."),
  del("googleJobs", "Google work, cancelled on disconnect."),
  del("googleCalendarLinks", "Calendar event references."),
  del("googleWatches", "Google notification channels."),
  del("googleReviews", "Google reviews and draft replies."),
  del("googleLeads", "Leads from Google."),
  del("googleLeadKeys", "Lead-form key hashes."),
  del("googleConversions", "Conversions sent to Google Ads; Google holds its own copy."),
  del("googleAdDrafts", "Ad drafts."),
  del("googleChoices", "Short-lived lists from Google."),
  del("googleBusy", "Short-lived busy times."),
  del("googleAdsSnapshots", "Ads reports."),
  del("googleTravel", "Cached drive times."),
  del("googleDriveTexts", "Text read from Drive files."),
  del("googleSettings", "Google settings."),
  del("connectorConnections", "Jobber and Housecall Pro connections, disconnected first."),
  del("connectorCredentials", "Sealed Jobber authorizations (deleted on disconnect; any left are deleted here)."),
  del("connectorStates", "Ten-minute Jobber sign-in records."),
  del("connectorReads", "Copies of another system's client list."),
  del("subcontractors", "Subcontractor companies and contacts."),
  del("workerAffiliations", "Which cleaners work for which subcontractor."),
  del("requirementDefinitions", "The company's cleaner requirements."),
  del("workerRequirements", "Cleaners' documents and checks, with their files."),
  del("availabilityExceptions", "Cleaners' one-off availability."),
  del("skillClaims", "Cleaners' skills."),
  del("crews", "Crews."),
  del("crewMemberships", "Crew members."),
  del("portalLinks", "Cleaner portal links."),
  del("portalCodes", "One-time portal codes."),
  del("onboardingConfigs", "The company's guided onboarding content and its versions."),
  del("trainingProgress", "Cleaners' training progress."),
  del("payoutPreferences", "How cleaners would like to be paid."),
  del("taxDocuments", "Cleaners' tax documents, sealed numbers and files. The Owner downloads each finished W-9 from the cleaner's profile to keep it for their own tax records."),
  del("followUps", "Follow-ups with cleaners."),
  del("coachingNotes", "Coaching notes about cleaners."),
  del("recordDisputes", "Cleaners' disputes about their records."),
  del("personnelRequests", "Personnel requests."),
  del("clientContacts", "Customers' contacts."),
  del("clientViews", "The client directory's search rows."),
  del("servicePlans", "Customers' service plans."),
  del("clientNotes", "Internal notes about customers."),
  del("inboundMessages", "Texts and emails customers sent. Opt-outs among them are kept in suppressions and consent records."),
  del("mediaAssets", "Images and videos, with their files."),
  del("mediaJobs", "Image and video work."),
  del("services", "The service catalog."),
  del("serviceVersions", "Versions of services."),
  del("serviceDrafts", "Service drafts."),
  del("serviceChanges", "Service changes."),
  del("propertyPrices", "Prices for particular properties."),
  del("pricingProfiles", "Pricing settings."),
  del("serviceQuotes", "Price calculations."),
  del("serviceImports", "Imported price lists."),
  del("researchBriefs", "Market research."),
  del("researchSources", "Market research sources."),
  del("bookingSettings", "Booking page settings and logo."),
  del("bookingExperiences", "Booking pages, with their images."),
  del("bookingExperienceVersions", "Published versions of booking pages."),
  del("bookingSessions", "Customers' booking sessions."),
  del("bookingHolds", "Held booking times."),
  del("bookingImages", "Booking page images, with their files."),
  del("bookingAcceptances", "Customers' acceptance of the company's booking terms; the company's own records, which it had an export of.", ),
  del("bookingEvents", "Booking page analytics."),
  del("salesOpportunities", "Sales inquiries."),
  del("salesDrafts", "Sales drafts."),
  del("salesQuotes", "Quotes."),
  del("bookings", "Bookings; the visits and invoices they made are anonymized or kept."),
  del("capacityHolds", "Held capacity."),
  del("recurringPlans", "Recurring plans."),
  del("recurringPlanVersions", "Versions of recurring plans."),
  del("planVisits", "Planned visits."),
  del("proposals", "Proposals."),
  del("proposalVersions", "Versions of proposals."),
  del("proposalResponses", "Customers' responses to proposals; the company's own records, which it had an export of."),
  del("assessments", "Site assessments, with their photos."),
  del("serviceSetups", "Service setups."),
  del("salesMessages", "Sales conversations."),
  del("salesActions", "Sales agent actions."),
  del("salesRuns", "Sales agent runs."),
  del("salesFollowUps", "Sales follow-ups."),
  del("salesBatches", "Sales batches."),
  del("companySetups", "Setup progress."),
  del("setupWork", "Setup work."),
  del("websiteReads", "Reads of the company's website."),
  del("clientImportRuns", "Client imports."),
  del("importedRecords", "Imported record references."),
  del("companyFacts", "Facts about the company."),
  del("activations", "First agent work."),
  del("activationTasks", "First agent work steps."),
  del("retentionSignals", "Retention signals."),
  del("retentionCases", "Retention cases."),
  del("retentionEntries", "Retention case history."),
  del("retentionActions", "Retention actions."),
  del("retentionFeedback", "Customer feedback."),
  del("retentionLinks", "Customer care links."),
  del("retentionRuns", "Retention runs."),
  // Quality (convex/lib/quality/schema.ts). Preserved evidence is preserved from the company's ordinary routines, never from its own deletion.
  del("qualityStandards", "Quality standards and their versions."),
  del("qualityReviews", "Visit reviews."),
  del("qualityCases", "Quality cases."),
  del("qualityFindings", "Findings."),
  del("qualityEntries", "Quality case history."),
  del("qualityEvidence", "Evidence references pinned to cases."),
  del("qualityRequests", "Requests to cleaners and customers."),
  del("qualitySubmissions", "Statements and answers."),
  del("qualityFiles", "Files uploaded through Quality links (the stored files are deleted with them)."),
  del("qualityCorrections", "Correction scopes and verifications."),
  del("qualityImprovements", "Improvement proposals."),
  del("qualityRuns", "Quality runs."),
  del("qualityConnections", "Phone platform connections."),
  del("qualityCredentials", "Sealed phone platform keys (deleted on disconnect; any left are deleted here)."),
  del("qualityComms", "Calls, texts and transcripts read from a phone platform."),
  del("qualityExtracts", "Readings of those conversations."),
  del("qualityAssociations", "Which visit each conversation was linked to."),
  del("migrationRecords", "Records brought from another system."),
  del("migrationImportRuns", "Migration imports."),

  // ── Last: the event log, so the deletion's own events are judged with the rest ──────────────────
  keep("events", "The events that prove consent, opt-outs, messages sent, money moving and what happened to the account. Other events are deleted; text inside kept events is removed.", {
    keepRow: (row) => typeof row.type === "string" && KEPT_EVENT_PREFIXES.some((prefix) => row.type === prefix || (row.type as string).startsWith(prefix.includes(".") ? prefix : `${prefix}.`)),
    derive: eventData,
  }),
];

export const PLAN_BY_TABLE: ReadonlyMap<string, TablePlan> = new Map(DELETION_PLAN.map((plan) => [plan.table, plan]));

/** Fields of the companies row cleared when it becomes a tombstone. Its id stays, so retained rows point at it. */
export const COMPANY_TOMBSTONE_CLEARS = ["dispatch", "dispatchPolicy", "recruiter", "cleaners", "retention", "sales", "businessSettings", "setupKey", "createdBy", "payTiers", "aiFeatures"] as const;

// ── Scrubbing a row against its validator ─────────────────────────────────────────────────────────

/** A loose view of a Convex validator, enough to make a replacement that still passes it. */
export type LooseValidator = {
  kind: string;
  isOptional?: string;
  fields?: Record<string, LooseValidator>;
  members?: LooseValidator[];
  element?: LooseValidator;
  value?: unknown;
  tableName?: string;
};

/** Replaces every piece of text inside a value with the placeholder; keeps numbers, ids, literals and booleans. */
export function scrubValue(value: unknown, validator: LooseValidator | undefined): unknown {
  if (value === undefined || value === null || !validator) return value;
  switch (validator.kind) {
    case "string":
      return PLACEHOLDER;
    case "any":
      return typeof value === "string" ? PLACEHOLDER : typeof value === "object" ? null : value;
    case "array":
      return Array.isArray(value) ? value.map((item) => scrubValue(item, validator.element)) : value;
    case "record": {
      if (typeof value !== "object") return value;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = scrubValue(item, validator.value as LooseValidator);
      return out;
    }
    case "object": {
      if (typeof value !== "object") return value;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = scrubValue(item, validator.fields?.[key]);
      return out;
    }
    case "union": {
      const members = validator.members ?? [];
      if (members.every((member) => member.kind === "literal")) return value;
      if (typeof value === "string") return members.some((member) => member.kind === "string") ? PLACEHOLDER : value;
      if (typeof value === "object" && !Array.isArray(value)) {
        const match = members.find(
          (member) =>
            member.kind === "object" &&
            Object.entries(member.fields ?? {}).every(([key, field]) => field.kind !== "literal" || (value as Record<string, unknown>)[key] === field.value) &&
            Object.keys(value as Record<string, unknown>).every((key) => key in (member.fields ?? {})),
        );
        return match ? scrubValue(value, match) : value;
      }
      if (Array.isArray(value)) {
        const array = members.find((member) => member.kind === "array");
        return array ? scrubValue(value, array) : value;
      }
      return value;
    }
    default:
      return value;
  }
}

/**
 * The patch that removes one field (a dotted path reaches inside an object): optional fields go, required
 * ones get the placeholder in their own shape.
 */
function scrubPath(row: Row, path: string, fields: Record<string, LooseValidator>, patch: Row) {
  const [head, ...rest] = path.split(".");
  const validator = fields[head];
  if (!validator || row[head] === undefined) return;
  if (rest.length === 0) {
    patch[head] = validator.isOptional === "optional" ? undefined : scrubValue(row[head], validator);
    return;
  }
  const inner = (patch[head] ?? row[head]) as Row;
  if (!inner || typeof inner !== "object" || validator.kind !== "object" || !validator.fields) return;
  const nested: Row = { ...inner };
  const innerPatch: Row = {};
  scrubPath(inner, rest.join("."), validator.fields, innerPatch);
  for (const [key, value] of Object.entries(innerPatch)) {
    if (value === undefined) delete nested[key];
    else nested[key] = value;
  }
  patch[head] = nested;
}

/** The patch a plan makes to one retained or anonymized row. Empty when nothing changes. */
export async function planPatch(ctx: MutationCtx, plan: TablePlan, row: Row, fields: Record<string, LooseValidator>): Promise<Row> {
  const patch: Row = {};
  for (const path of plan.personal ?? []) scrubPath(row, path, fields, patch);
  for (const field of plan.hashed ?? []) {
    const value = row[field];
    if (typeof value === "string" && value && !value.startsWith("sha256:")) patch[field] = addressHash(value);
  }
  if (plan.derive) Object.assign(patch, await plan.derive(ctx, row));
  return patch;
}

/** Every file id a value holds, read from its validator. */
export function storageIds(value: unknown, validator: LooseValidator | undefined, out: Set<string> = new Set()): Set<string> {
  if (value === undefined || value === null || !validator) return out;
  if (validator.kind === "id" && validator.tableName === "_storage" && typeof value === "string") out.add(value);
  else if (validator.kind === "object" && typeof value === "object") for (const [key, item] of Object.entries(value as Row)) storageIds(item, validator.fields?.[key], out);
  else if (validator.kind === "array" && Array.isArray(value)) for (const item of value) storageIds(item, validator.element, out);
  else if (validator.kind === "union") for (const member of validator.members ?? []) storageIds(value, member, out);
  else if (validator.kind === "record" && typeof value === "object") for (const item of Object.values(value as Row)) storageIds(item, validator.value as LooseValidator, out);
  return out;
}

/** Deletes a stored file if it is still there. Returns whether one was deleted. */
export async function deleteFile(ctx: MutationCtx, id: string): Promise<boolean> {
  const storageId = ctx.db.system.normalizeId("_storage", id);
  if (!storageId) return false;
  const file = await ctx.db.system.get(storageId);
  if (!file) return false;
  await ctx.storage.delete(storageId as Id<"_storage">);
  return true;
}

// ── What staff and the Owner are told ─────────────────────────────────────────────────────────────

export type RetentionSummary = { treatment: Treatment; table: string; reason: string; counsel: boolean }[];

export function retentionSummary(): RetentionSummary {
  return DELETION_PLAN.map((plan) => ({ treatment: plan.treatment, table: plan.table, reason: plan.reason, counsel: plan.counsel === true }));
}

/** What is kept, in plain words, for the Owner's screen. */
export const KEPT_FOR_OWNER: readonly { what: string; why: string }[] = [
  { what: "Opt-out and consent records", why: "So nobody who asked not to be contacted is contacted again, and because phone carriers require proof of permission. Phone numbers and emails in them are kept only as a scrambled code that can't be turned back into the number." },
  { what: "That messages were sent", why: "When, on which channel and under what permission, because carriers require it. The words of the messages are deleted." },
  { what: "Invoices, payments, refunds, tips and payouts", why: "Amounts, dates and payment ids, for tax and accounting and because card disputes can arrive months later. Names, addresses and descriptions are removed." },
  { what: "Your texting registration", why: "The brand and campaign filed with the carriers, and your authorization to release the number." },
  { what: "Selestial's billing for your plan", why: "Selestial's own accounting." },
  { what: "This request and the record of the deletion", why: "Proof of what was done. Kept for three years after it closes." },
];
