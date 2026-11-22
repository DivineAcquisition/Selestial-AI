# Account closure: export, closing and deletion requests

What Selestial staff do when a company wants a copy of its records, wants to leave, or asks for its records
to be deleted, **as the code supports it today**. Nothing here is automatic unless it says so.

Code: `convex/dataRights.ts`, `convex/requests.ts`, `convex/retention.ts`, `convex/billingLock.ts`,
`convex/lib/trust/erase.ts`, `convex/companyDeletion.ts` (the staff-run deletion) and
`convex/lib/trust/companyDeletion.ts` (the retention classification, the single source of truth). Related: `docs/billing/04-unpaid-plan.md`, `docs/texting/03-offboarding.md`
(releasing a company's texting number and registration; being written), `05-recovery-runbook.md`.

## What exists and what does not

| | Today |
|---|---|
| Export of a company's records | **Built, self-serve.** Owner only, Settings › Privacy & messaging. Three a day; the file is downloadable for 24 hours, then deleted. Works while the account is locked for an unpaid plan (`whileLocked`). |
| Erasing one customer's or one cleaner's personal details | **Built, self-serve.** Owner only, with a deletion record. Opt-outs are kept. |
| Asking for the whole company to be deleted | **A request.** `requestCompanyDeletion` files a privacy request for staff, due in 90 days. It deletes nothing. After asking, the Owner sees its status (received → in progress → completed, with the due date) and what is kept and why (Settings › Privacy & messaging; `companyDeletion.status`). |
| Deleting a company's records | **Built, staff-run** (`convex/companyDeletion.ts`). From the request page in the staff console: a precondition checklist, the retention summary, a typed confirmation of the company's name, live progress and the final summary. Needs the Destructive actions capability (`records.destroy`). Never starts by itself. |
| A deletion clock when a plan is cancelled for non-payment | **Built.** When the plan is cancelled after 30 days locked (`billingLock.canceled`), the same deletion request is opened automatically: status received, due in 90 days, note "plan cancelled for non-payment". It deletes nothing. |
| Overdue deletions and failed runs | **Built.** The operations check `company_deletion` raises a staff incident when a deletion request is within 14 days of its due date and not completed, and when a run fails or stops making progress. |
| A path to export from the locked screen | **Missing in the screen.** The backend allows export while locked; `src/components/app/billing/locked.tsx` offers only paying and switching business. |

## 1. Export request

1. The Owner does it themselves: Settings › Privacy & messaging › Export. If they cannot sign in, verify who
   they are first (`docs/operations/03-support-sessions.md`); staff do not make or download an export for them.
2. If the account is locked for an unpaid plan, export still works by function, but the locked screen has no
   button for it yet (see the gap list, item 3). Until it does, the only way in is for a staff member with
   billing adjustments to lift the lock (`/staff/unpaid`, `billingLock.lift`, with a written reason). Lifting
   ends the lock for that invoice rather than pausing it, so it is a decision, not a routine step.
3. Very large companies: the export has not been tested at size. If it fails, the export row says why.

## 2. A company wants to leave (closure)

Reconcile these **before** anything is closed or deleted, in this order:

1. **Money owed to the company's customers and by them.** Open and overdue invoices, card payments
   `processing` or `checking`, refunds in progress (Finance). Let them settle or have the Owner void them.
2. **Stripe Connect.** The connected account is the company's own; Selestial does not close it. Confirm no
   payment or refund is in flight, then the Owner disconnects it or keeps it. Disputes can arrive for months:
   tell the Owner they are handled in Stripe.
3. **Selestial's own plan.** Cancel in Autumn (Settings › Billing, or staff). Unused prepaid messaging
   balance and credits: decide refund or forfeit per the Terms; record what was done.
4. **Texting.** The number, brand and campaign are registered with the carriers in the company's name and
   keep costing money until released. Follow `docs/texting/03-offboarding.md`. Do not release a number while
   customers may still reply STOP to it without recording those opt-outs first.
5. **Connections.** Google, inboxes, Jobber: the Owner disconnects (Settings › Integrations), which revokes
   Selestial's access at the provider. Queued Google work is cancelled by disconnecting.
6. **Agents and sending.** Pause every agent; if anything could still go out, suspend outbound
   (`compliance.setSuspended`, with a note).
7. **Export.** Remind the Owner to export first. After closure they cannot.

There is no "closed" state on a company. Closure today is: plan cancelled, agents paused, outbound
suspended, connections removed, and a note on the request.

## 3. Deletion request

1. It arrives as a privacy request (kind `privacy`, subtype `deletion`), from Settings (already verified as
   the signed-in Owner) or from the public form (verify first). Due date: 90 days.
2. Acknowledge it, and confirm with the Owner in writing that they want the whole company deleted and have
   exported what they need. A request made by mistake is closed with a note.
3. Do the closure steps in section 2.
4. **Run the deletion from the request page** (Staff › Requests › the request › "Delete the company"):
   1. Work the checklist. Each item blocks until satisfied:
      - **No active paid plan**: cancelled or ended in Autumn. Cannot be waived.
      - **No customer payments, refunds or disputes in flight**: card payments processing, checking or awaiting
        the customer; refunds sending, pending or checking; open disputes; open invoices. An admin with
        Destructive actions may waive it with a written reason (for example a payment Stripe confirms was
        abandoned).
      - **No unsettled messaging charges**: charges still estimated, reserving, reserved or pending. Waivable
        the same way.
      - **Texting number released or transferred**: no request with status active or interrupted
        (`docs/texting/03-offboarding.md`). Cannot be waived.
      - **Google, inboxes and Jobber disconnected**: not blocking; the run disconnects them and revokes the
        grants as its first step, using the same code as the Owner's disconnect.
      - **Owner offered an export**: recorded (whether one was downloaded, and when), not required.
   2. Read the retention summary with the Owner's request in mind.
   3. Type the company's name exactly and press **Delete**. The company is marked closing at once: every
      member and support-session read and write is refused, every link page (cleaner, pay, statement,
      applicant, portal, booking, proposal, quote, signing, care, invitation) says "no longer available",
      outbound sending is suspended, every agent is paused, and recurring visit generation stops.
   4. Watch progress. The run disconnects connections, then works through every company table in bounded
      batches (100 rows per transaction by default), recording per-table counts, a cursor, errors and
      attempts on the `companyDeletions` row in the same transaction. It is resumable: an interrupted run
      continues exactly where it stopped, with nothing done twice. A verification pass sends it back over any
      table where rows appeared after it was done (three passes at most, then it fails).
   5. If it fails (five attempts in a row), an incident is raised. Read the error, fix the cause, and press
      **Resume**.
   6. On completion the request is marked completed with a summary, one audit event (`company.deleted`, with
      the staff member's id) is written, and the companies row stays as a tombstone ("Deleted company",
      `deletedAt` set) so retained financial rows still point at something.
5. **Memberships are removed; sign-in accounts are not.** Clerk users are not deleted, because a person may
   belong to other companies. If the person asks for their own account to be deleted, that is a separate
   privacy request.
6. Backups and any test or restored backend are not reached by the run (gap list, item 6).

## Retention table: what a company deletion does to each table

Matches `DELETION_PLAN` in `convex/lib/trust/companyDeletion.ts` (generated from it on November 22, 2026).
`convex/companyDeletion.test.ts` fails when a table with a `companyId` is added without a decision there.
212 company tables: **164 deleted, 7 anonymized, 41 kept**.

- *Kept*: the law, the phone carriers or a payment processor need the record. Personal text inside is replaced
  with `[deleted]` where the record still makes sense without it; phone numbers and emails that prove an
  opt-out or consent are kept only as `sha256:` of the trimmed, lower-cased value. "derived" means the run
  works the value out from other records first (consent records get the recipient's hashed phone and email
  before the customer is anonymized; kept events keep numbers and short codes, other text is replaced).
  Events are kept only for consent, opt-outs, messages, texting, invoices, payments, refunds, tips, payouts,
  earnings, collections, Stripe, billing, the company and exports, and the erasure of a person; every other
  event is deleted.
- *Anonymized*: the row stays so kept financial rows point at something whole; the listed fields are replaced
  with `[deleted]` (required text) or removed (optional fields). A cleaner's photo file is deleted.
- Tables with no index starting with `companyId` (`billingWebhooks`, `lockdownCompanies`) are kept untouched and
  not counted, because counting them would read every company's rows.

### Kept (retain)

| Table | Why | Personal fields stripped | For counsel |
|---|---|---|---|
| `contactPermissions` | Proof of what each person agreed to and when they said stop. Carriers and US texting law expect consent records to be producible. Kept with the recipient as a hash. | evidence, derived |  |
| `permissionHistory` | Every change to a person's consent, for the same reason. Kept with the recipient as a hash. | evidence, derived |  |
| `suppressions` | Opt-outs and bounces: so a person who said stop is never contacted again. The address is kept only as a hash. | sourceMessage, note, liftNote, address (hashed) |  |
| `consentDisclosures` | The exact consent wording recipients were shown. Needed to prove what they agreed to. Holds no personal data. | none |  |
| `sendIntents` | The consent check made before each send: which permission applied. The address is kept only as a hash. | address (hashed) |  |
| `messages` | That a message was sent, on which channel, when, and under what permission: carriers expect sending records. The words, subject and links are removed; the address is kept only as a hash. | subject, replyTo, body, linkPath, problem, recipients, notice, salesLinks, refusal, to (hashed) |  |
| `textingRequests` | The carrier registration (brand, campaign, number, release dates) Selestial filed for the company. Carriers can ask about it after the number is released. | taxIdSealed, otp, leaseToken, leaseUntil, note, diagnostics, problem | yes |
| `textingSubmissions` | What was filed with the carriers, with the owner's authorization. Evidence for the registration. | none | yes |
| `textingPages` | The published opt-in, privacy and terms pages the carriers reviewed: evidence of how consent was collected. | none | yes |
| `textingEvidence` | Evidence of the opt-in flow given to the carriers (screenshots and links), with its files. | none | yes |
| `textingExceptions` | Holds the owner's recorded authorization to release or move the texting number. | internalWords | yes |
| `agreementAcceptances` | The company's acceptance of Selestial's Terms: the contract the service ran under. | none |  |
| `invoices` | Invoices: amounts, tax, dates and numbers are accounting and tax records. Line descriptions, the memo and the link part are removed. | lines, memo, publicId |  |
| `payments` | Payments: amounts, dates and Stripe ids. Disputes and chargebacks can arrive for months, and they are accounting records. The browser secret and notes are removed. | stripe.clientSecret, manual, problem |  |
| `refunds` | Refunds: amounts, dates and Stripe ids, for accounting and disputes. The written reason is removed. | reason, problem |  |
| `invoiceCredits` | Credits against invoices: part of the invoice's accounting record. The reason is removed. | reason |  |
| `tips` | Tips: amounts paid through the company's invoices and passed to cleaners. The note is removed. | note |  |
| `earnings` | What each cleaner earned per visit: payroll and contractor-payment (1099) records. Free-text facts are removed. | facts, voidReason | yes |
| `teamPayments` | Payouts to cleaners: amounts, dates and references. The note is removed. | note |  |
| `stripeAccounts` | The company's Stripe Connect account id: disputes and Stripe's questions about past payments reference it. The onboarding link is removed. | onboarding, problem |  |
| `billingAccounts` | Selestial's billing record for the company: the plan, Autumn customer id and balances. Selestial's own accounting. | none |  |
| `billingDunning` | Unpaid Selestial invoices and what happened to each: Selestial's own accounting. | none |  |
| `billingIntents` | Purchases the company started with Selestial. The short-lived payment address is removed. | url, problem |  |
| `billingWebhooks` | Autumn and Stripe deliveries to Selestial about the company's plan: Selestial's own accounting. | none |  |
| `aiExecutions` | Each piece of AI work and its credit charge: Selestial's billing ledger. | message, settleProblem |  |
| `messagingTopUps` | Messaging balance purchases and refunds: Selestial's billing ledger. | invoiceUrl, problem |  |
| `messagingCharges` | What each message cost and how it was settled: Selestial's billing ledger. | reason, settleProblem |  |
| `messagingAttention` | Selestial staff's review of the company's messaging balance. | detail, note |  |
| `aiUsage` | AI usage counted against the plan, kept for billing reconciliation with the AI providers. | raw |  |
| `earlyOffers` | The introductory $199 plan price: when it was reserved, claimed and ended. Selestial's own billing record, and what stops a returning company getting the introductory price again. No personal data. | switchProblem |  |
| `chatUsage` | Monthly AI chat usage counted against the plan. Numbers only. | none |  |
| `mediaAllowances` | Monthly image and video usage counted against the plan. Numbers only. | none |  |
| `trustRequests` | Privacy requests, including this one: kept three years after closing, then deleted (convex/retention.ts). | none |  |
| `deletionRecords` | Proof of each earlier erasure: kept three years, then deleted (convex/retention.ts). | none |  |
| `companyDeletions` | Proof of this deletion: what was deleted, anonymized and kept. | none |  |
| `incidents` | Selestial's operational records about the service. Diagnostics text is removed. | diagnostics |  |
| `lockdownCompanies` | Selestial's record of a restore that paused the company. | none |  |
| `supportSessions` | When Selestial staff were in the company's workspace and why: Selestial's access audit. | changes | yes |
| `supportGrants` | The owner's grants of support access: Selestial's access audit. | none |  |
| `supportEvents` | What staff did in the workspace: Selestial's access audit. Summaries are removed; ids and times stay. | summary | yes |
| `events` | The events that prove consent, opt-outs, messages sent, money moving and what happened to the account. Other events are deleted; text inside kept events is removed. | derived |  |

### Anonymized

| Table | Why | Personal fields stripped | For counsel |
|---|---|---|---|
| `customers` | Retained invoices and payments point at the customer. The row stays as an anchor with every personal detail removed. | name, email, phone, preferences, privateNotes, communication, relationshipNote, archivedReason, source |  |
| `properties` | Retained invoices point at the property (sales tax can depend on where the work was done). The address and every note are removed. | label, address, accessInstructions, parking, crewNotes, clientNotes, officeNotes, details | yes |
| `cleaners` | Retained earnings and payouts point at the cleaner. The row stays with every personal detail and the photo removed. | name, email, phone, skills, serviceAreas, preferredAreas, photoStorageId, checkIn, rehireRestriction |  |
| `jobs` | Retained invoices and earnings point at the visit: its date, price and status stay. Instructions and notes are removed. | scope, instructions, cancelReason, completionReview, completionReturns, completionReturn, recovery, serviceSnapshot |  |
| `assignments` | Retained earnings point at the assignment: its pay and times stay. Locations and notes are removed. | scope, endReason, checkIn.lat, checkIn.lng, checkIn.accuracyM, late.reason, contact, completion.note |  |
| `applications` | Hiring records: a line that an application for a role existed, how far it got and why it ended, with no person in it (the same line convex/lib/recruiter/retention.ts keeps). | roleSeen, contact, facts, nextAction, closure.note | yes |
| `hiringDecisions` | The decision on each application, with the written reason removed. | reason | yes |

### Deleted, with any files they hold

`textingSetups`, `textingNotes`, `textingRecommendations`, `numberSearches`, `complianceProfiles`, `financeMessages`, `financeSettings`, `statementLinks`, `expenses`, `expenseReceipts`, `expenseRules`, `expenseImports`, `payArrangements`, `applicants`, `members`, `invitations`, `notificationPreferences`, `memberNotices`, `tutorialProgress`, `tutorialReports`, `tutorialEvents`, `integrationRequests`, `agentAccessRequests`, `dataExports`, `availabilityWindows`, `timeOff`, `tasks`, `permissions`, `approvals`, `actionLinks`, `coverageRequests`, `checklistItems`, `checklistTemplates`, `evidence`, `jobReports`, `replyReadings`, `toolRuns`, `hiringNeeds`, `mailboxConnections`, `mailboxCredentials`, `oauthStates`, `sourceMessages`, `applicantLinks`, `formSessions`, `applicantAttachments`, `screenings`, `interviewSlots`, `interviews`, `hiringOffers`, `onboardingHandoffs`, `conversations`, `chatMessages`, `chatRuns`, `chatActionSteps`, `chatArtifacts`, `chatArtifactVersions`, `companyKnowledge`, `chatUploads`, `knowledgeChunks`, `agreements`, `agreementVersions`, `agreementLinks`, `agreementComments`, `agreementTemplates`, `agreementTemplateVersions`, `agreementFiles`, `agreementSignatureRequests`, `agreementSigningLinks`, `googleConnections`, `googleCredentials`, `googleOAuthStates`, `googleResources`, `googleJobs`, `googleCalendarLinks`, `googleWatches`, `googleReviews`, `googleLeads`, `googleLeadKeys`, `googleConversions`, `googleAdDrafts`, `googleChoices`, `googleBusy`, `googleAdsSnapshots`, `googleTravel`, `googleDriveTexts`, `googleSettings`, `connectorConnections`, `connectorCredentials`, `connectorStates`, `connectorReads`, `subcontractors`, `workerAffiliations`, `requirementDefinitions`, `workerRequirements`, `availabilityExceptions`, `skillClaims`, `crews`, `crewMemberships`, `portalLinks`, `portalCodes`, `followUps`, `coachingNotes`, `recordDisputes`, `personnelRequests`, `clientContacts`, `clientViews`, `servicePlans`, `clientNotes`, `inboundMessages`, `mediaAssets`, `mediaJobs`, `services`, `serviceVersions`, `serviceDrafts`, `serviceChanges`, `propertyPrices`, `pricingProfiles`, `serviceQuotes`, `serviceImports`, `researchBriefs`, `researchSources`, `bookingSettings`, `bookingExperiences`, `bookingExperienceVersions`, `bookingSessions`, `bookingHolds`, `bookingImages`, `bookingAcceptances`, `bookingEvents`, `salesOpportunities`, `salesDrafts`, `salesQuotes`, `bookings`, `capacityHolds`, `recurringPlans`, `recurringPlanVersions`, `planVisits`, `proposals`, `proposalVersions`, `proposalResponses`, `assessments`, `serviceSetups`, `salesMessages`, `salesActions`, `salesRuns`, `salesFollowUps`, `salesBatches`, `companySetups`, `setupWork`, `websiteReads`, `clientImportRuns`, `importedRecords`, `companyFacts`, `activations`, `activationTasks`, `retentionSignals`, `retentionCases`, `retentionEntries`, `retentionActions`, `retentionFeedback`, `retentionLinks`, `retentionRuns`, `migrationRecords`, `migrationImportRuns`

Not company tables, and not touched: `staffAudit`, `incidentUpdates`, `providerReceipts`,
`agreementProviderEvents`, `telnyxEvents`, `noticeSuppressions`, `opsSignals`. The companies row itself becomes a
tombstone: name "Deleted company", `deletedAt` set, settings cleared, id kept.

## Legal copy vs. behaviour: gaps for the owner and counsel to decide

**These are open. Nothing here has been changed in the legal documents.** Each needs a decision: build what
the sentence promises, or change the sentence (a new version of the document, with notice where the Terms
require it).

1. **"When a company leaves, we delete its records within 90 days."**
   `src/lib/trust/documents/privacy.ts:152`. Also the trust register,
   `src/lib/trust/register.ts:55` ("deleted within 90 days of leaving … staff carry it out"), and
   `convex/dataRights.ts:42-43` (`COMPANY_DELETION_DAYS = 90`).
   *Behaviour (November 22, 2026, the Owner's decision "Both"):* a staff-run deletion now exists
   (`convex/companyDeletion.ts`). "Leaves" means, in code: the Owner asked (Settings), or the plan was cancelled
   for non-payment (the request opens itself, due in 90 days). A company that is merely inactive, or that
   cancels its plan itself and does not ask, still gets no clock. Deletion keeps the records in the retention
   table above, so the sentence "we delete its records" is not literally true; see "For counsel".
   *Decide:* whether a self-cancelled plan should also start the clock; counsel tightens the wording.

2. **"Settings includes tools to export your records and to delete them."**
   `src/lib/trust/documents/terms.ts:161`.
   *Behaviour:* export is a tool. Deleting one customer or one cleaner is a tool. Deleting the company is a
   request to staff (`requestCompanyDeletion` in `convex/dataRights.ts`), carried out by staff with the
   deletion run; the in-app text says so and shows the request's status.
   *Decide:* reword to say which deletions are self-serve and which are requests, or build it.

3. **"You may stop using Selestial at any time. Export what you need first."**
   `src/lib/trust/documents/terms.ts:179`, and the unpaid-plan flow (`docs/billing/04-unpaid-plan.md`): the
   plan is cancelled after 30 days locked (`convex/lib/billing/lock.ts:17`, `convex/billingLock.ts:333`).
   *Behaviour:* export now works while locked at the backend (`convex/dataRights.ts:50,74,98`), but the
   locked screen (`src/components/app/billing/locked.tsx`) has no way to reach it, so a locked Owner still
   cannot export without help. After cancellation nothing is deleted and nothing tells the Owner how long
   their records are kept.
   *Decide:* add an export action to the locked screen (engineering); say in the cancellation notice what
   happens to the records and for how long.

4. **Retention the Privacy Notice does not mention.**
   `src/lib/trust/documents/privacy.ts:150-158` lists what is kept after deletion: opt-outs, deletion
   records, the activity log without details, backups. It does not mention financial records or message
   and consent logs. The in-app text beside "Ask Selestial to delete the company"
   (`src/components/app/screens/compliance.tsx:639-640`) says these are kept, and the status shown after
   asking lists them (`KEPT_FOR_OWNER` in `convex/lib/trust/companyDeletion.ts`). The deletion run keeps them.
   *Decide:* confirm the retention and its periods with counsel and add it to the notice, or decide they
   are deleted too and change the in-app text back.

5. **Customer payments are built; the public documents do not say so.**
   The trust register said "Not built … no money moves"; it now describes Stripe Connect payments
   (`src/lib/trust/register.ts:58`, marked not for public pages). A second register row with the same id
   `billing` (`src/lib/trust/register.ts:57`) still says "No payment provider; nothing is charged through
   the service", which contradicts the row at line 40 and is out of date. Stripe is not named for customer
   payments in `src/lib/trust/documents/*`.
   *Decide:* name Stripe (and what it receives) on the Subprocessors page and in the Privacy Notice; remove
   or correct the stale register row.

6. **A restored or test backend holds a copy of real data.** `docs/foundation/06-deployments.md` step 8
   says the old backend's copy "is cleared … after a week". Whether that was done is not recorded. A
   deletion carried out on production does not reach that copy or any backup.
   *Decide:* clear the test backend's copy and record it; state the backup retention period.

## For counsel

The Owner decided on November 22, 2026: build the deletion so the 90-day promise is honoured, keep the records
the law requires, and counsel tightens the wording on what is kept. **The legal documents have not been
edited.** Engineering chose conservatively: where it was unclear whether a record is legally required, it is
kept with personal text stripped. Counsel should confirm or reverse each choice below and set retention
periods (none of the kept categories has an automatic end date yet, except privacy requests and deletion
records, three years).

### Kept categories to confirm

1. **Consent and opt-out records** (`contactPermissions`, `permissionHistory`, `suppressions`,
   `consentDisclosures`, `sendIntents`): kept so a person who said stop is never contacted again and because
   carriers and the TCPA expect proof of consent. Addresses are kept as an unsalted SHA-256 hash. Note: a phone
   number's hash can be reversed by trying every number, so it is pseudonymous, not anonymous.
2. **Sending records** (`messages`, without words, subject or links; recipient as a hash) and the events that
   prove a message was sent.
3. **Texting registration** (`textingRequests`, `textingSubmissions`, `textingPages`, `textingEvidence` with its
   files, `textingExceptions` holding the Owner's release authorization). *Unsure:* how long carriers or TCR
   expect a brand's filing and opt-in evidence to be producible after a campaign ends.
4. **Customer money** (`invoices`, `payments`, `refunds`, `invoiceCredits`, `tips`, `teamPayments`,
   `stripeAccounts`), with descriptions and notes removed. These are the company's accounting records; Selestial
   keeps them as the payment platform (disputes can arrive for months). *Unsure:* whether Selestial, as
   processor, may keep them once the company leaves, and for how long.
5. **Cleaner earnings** (`earnings`): kept as payroll and 1099 support. *Unsure* whether this is Selestial's
   duty or only the company's.
6. **Anonymized anchors** (`customers`, `properties`, `cleaners`, `jobs`, `assignments`): rows kept, with every
   name, contact detail, address and note replaced, so kept financial rows point at something whole. A property
   keeps no address at all, so sales-tax jurisdiction is not recoverable from it. *Unsure:* whether the address
   (or its postal code) must be kept for sales tax.
7. **Hiring lines** (`applications`, `hiringDecisions`): a line that an application for a role existed, its
   stage and why it ended, with no person in it. Applicants themselves are deleted. *Unsure:* employment
   record-keeping rules (EEOC and state) are the company's duty; whether Selestial should keep even this line.
8. **Selestial's own billing** (`billingAccounts`, `billingDunning`, `billingIntents`, `billingWebhooks`,
   `aiExecutions`, `messagingTopUps`, `messagingCharges`, `messagingAttention`, `aiUsage`, `chatUsage`,
   `mediaAllowances`, `earlyOffers`).
9. **Selestial's records about the account** (`trustRequests`, `deletionRecords`, `companyDeletions`,
   `incidents`, `lockdownCompanies`, `supportSessions`, `supportGrants`, `supportEvents`, `agreementAcceptances`).
   Support records keep the staff member's written reason for opening a session. *Unsure:* whether that reason
   can name a customer.
10. **Not reached at all:** backups (provider schedule) and any test or restored backend (gap list, item 6);
    sign-in accounts at Clerk (a person may belong to other companies); copies held by Stripe, Google, Telnyx,
    Autumn and email providers.

### Sentences that should be tightened (not edited)

| Where | Sentence today | Why it needs tightening |
|---|---|---|
| `src/lib/trust/documents/privacy.ts:152` | "A company's records: while the company uses Selestial. When a company leaves, we delete its records within 90 days." | Records in categories 1–9 are kept after deletion. "Leaves" is not defined (asked, or plan cancelled for non-payment, in code). |
| `src/lib/trust/documents/privacy.ts:155` | "Opt-out records: kept, so that an opt-out is never forgotten, even after other details are deleted." | Accurate, but does not say the address is kept as a hash, or that consent and sending records are kept too. |
| `src/lib/trust/documents/privacy.ts:150-158` (the list) | Lists accounts, records, requests, exports, opt-outs, the activity log and backups. | No line for financial records, sending records, the texting registration, Selestial's billing, or anonymized anchors. |
| `src/lib/trust/documents/terms.ts:161` | "Settings includes tools to export your records and to delete them. Deletion is described in the Privacy Notice, including what is kept so that an opt-out is never forgotten." | Deleting the whole company is a request carried out by Selestial staff, not a Settings tool; what is kept is more than opt-outs. |
| `src/lib/trust/documents/terms.ts:179` | "You may stop using Selestial at any time. Export what you need first." | Does not say that a plan cancelled for non-payment starts the 90-day deletion clock. |
| `src/lib/trust/register.ts:55` | "deleted within 90 days of leaving … staff carry it out" | Internal register; same gap as privacy.ts:152. |
