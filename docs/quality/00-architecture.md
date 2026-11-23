# Quality agent: what it is built on

**Philosophy.** Make the company's service promise measurable, identify where delivery falls short, and help
the business improve with every completed job.

Quality reviews every finished visit against the standard that applied to it, investigates concerns from
evidence, asks for what is missing, prepares the scope of corrective work, verifies that work, and proposes
changes that prevent repeats. It lives in `convex/quality.ts`, `convex/qualityWork.ts`,
`convex/qualityLinks.ts`, `convex/qualityComms.ts` and `convex/lib/quality/`. The screens are under
`/app/agents/quality` and the private pages under `/c/quality/<token>`.

Seven distinctions hold everywhere, in the data and on the screens:

| Not the same | How it is kept apart |
|---|---|
| A complaint and a finding | A case holds the report's words; findings are separate rows, each `suggested` until a person reviews it. |
| Documentation complete and service quality | A review reports requirement outcomes (met, missing, contradictory, unverifiable). It never scores the service. |
| A photograph and what happened | A photo is a record that a photo was taken. It never settles or cancels a report. |
| Missing information and misconduct | A missing record is an outcome of its own ("missing", "unverifiable") and a line with basis `missing`. An unanswered request is `unanswered`, never an admission. |
| Corrective work done and the customer satisfied | `qualityCorrections.state` (proposed → … → quality_verified) and `customer` (not asked, asked, confirmed, dissatisfied, no response) are separate fields; the customer's answer is Retention's. |
| A recommendation and a policy | Improvements are proposals; a published standard needs a person; nothing a reader suggests is applied. |
| A queued action and a delivered message | A request is `sent` when handed to the sender; delivery is the message's own state, shown as reported by the provider. |

## Phase 1 audit: reuse, change, new

Checked against `main` at `5089f5e` on November 22, 2026.

### Reused as is

| Shared system | How Quality uses it |
|---|---|
| Jobs, assignments, checklists (`checklistItems`, `checklistTemplates` versions), `evidence` photos, `jobReports`, check-ins, delays | Read by the evidence assembler (`lib/quality/evidence.ts`). Nothing is copied. |
| Completion submission (`lib/dispatch/live.ts` `submitCompletion`) and the manager's review (`jobs.reviewCompletion`, `closeWithoutReview`) | Unchanged rules. Submission already hands `quality.review:<job>` to the Quality queue; Quality now runs a review on it. Closing the visit stays a manager's decision; payouts still follow the visit's own completion. |
| Service snapshot, `visitScope` lines, `serviceQuotes`, `salesQuotes`, `bookings.instructions`, proposals, agreements (`serviceTerms`) | The service promise. Read, never edited. |
| Retention cases, actions, correction visits, customer links, `customerAnswered` | The one recovery episode and conversation owner. A correction is a Retention remedy (`correction_visit`) on that case; Retention books it through `createVisit` with `jobs.recovery`, Dispatch staffs it, Finance pays it. Quality adds scope, acceptance criteria and verification. |
| Approvals queue, permission catalog, `authorityFor`, spending limits | Eight `quality.*` actions; "Ask me first" goes to the one queue as `quality_request` or `quality_improvement` proposals, re-checked when approved. |
| Tasks and events | Each open case keeps one task; every change is an event. The `quality.review:<job>` handoff task is now Quality's (agent `quality`) and is still decided by a person. |
| Messaging outbox, sending policy, consent, quiet hours, limits, messaging billing, reconciliation | Every request goes through `messages` with purpose `quality_request`; `messaging.claim` re-checks it with `qualityClaim`. Uncertain sends stay `unconfirmed` and are never resent blindly. |
| Signed link scheme (`lib/sales/links.ts`) | New kind `quality` (`/c/quality/<token>`), one row per request: scoped, expiring, revocable, limited to named actions. |
| AI billing (`openExecution`, `reserveExecution`, `finishExecution`) | The optional reader is the `quality_review` task. Without an approved rate, the rules read and nothing is charged. |
| Notices (`lib/notify`) | Serious incident, case needs a decision, correction verification failed. |
| Imports (`customers.source = import:*`, `migrationRecords`) | Historical records are reviewed for the record and never trigger outreach. |
| Company deletion and export registries | Every Quality table is classified (`lib/trust/companyDeletion.ts`, `lib/trust/exportTables.ts`). |

### Changed

| Where | Change |
|---|---|
| `lib/statuses.ts`, `lib/departments.ts` | `quality` is an agent id in Operations, `built: true`. |
| `lib/billing/catalog.ts` | `RELEASED.quality` follows `AGENT_PROFILES.quality.built`. **Plan access is unchanged: Quality stays on Expand only.** See "Entitlements". |
| `lib/permissionCatalog.ts` | Eight `quality.*` actions. Findings, discipline, pay and serious-incident decisions are not actions (person-only). |
| `lib/dispatch/handoffs.ts` | A Quality handoff is filed under agent `quality`, still held for a person. |
| `lib/dispatch/live.ts`, `convex/links.ts`, `convex/jobs.ts` | Emit Quality runs on completion reported, photo added, report returned and visit closed. |
| `lib/retention/*` | Emit Quality runs on feedback, correction completed, credit recorded and case outcome; show a linked Quality case. |
| `convex/messaging.ts`, `convex/schema.ts` (`messages`) | `quality_request` purpose, `qualityRequestId`, `qualityClaim` at send time, delivery results back to the request. |
| `convex/approvals.ts`, `schema.ts` (`proposalValidator`) | `quality_request` and `quality_improvement` proposals. |
| `convex/http.ts`, `convex/crons.ts` | `/webhooks/quo/<id>`; Quality's sweep and communications sync. |
| Frontend navigation | Quality is live: Overview · Reviews · Cases · Corrections · Standards · Insights · Playbook (replacing the earlier Completion Review · Checklists & Photos · Service Issues · Re-cleans · Playbook). |

### New

Tables in `convex/lib/quality/schema.ts`: standards (versioned), reviews (with the standard snapshotted),
cases, findings, entries, evidence references, requests, submissions, files, corrections, improvements, runs,
and the communications set (connections, credentials, webhook deliveries, comms, extracts, associations).

## Ownership between agents

| Agent | Owns in a quality matter |
|---|---|
| **Quality** | Service-standard assessment, documentation review, investigation, evidence requests to cleaners, findings and their sources, correction scope and acceptance criteria, verification of corrective work, proposed improvements. |
| **Dispatch** | Crew assignment and replacement, arrival and execution, scheduling inspections and correction visits, coverage. |
| **Retention** | The customer recovery conversation, relationship continuity, the customer's acceptance of a remedy, and their confirmation or dissatisfaction. |
| **Sales** | Quotes, proposals, accepted scope, exclusions and commercial promises; approved changes to booking questions and scope wording. |
| **Recruiter / Team** | Hiring, readiness, training assignments, onboarding requirements, human-reviewed workforce follow-through. |
| **Finance** | Financial records, credits and refunds, cleaner earnings and pay, actual movement of money. |
| **Owner** | Company policy, exceptional remedies, serious-incident decisions, consequential personnel decisions, anything outside delegated authority. |

There is no Team Coordinator. Marketing and Care have no part in this flow.

**One conversation owner per recovery episode.** When a customer is involved, the Retention case is the
episode. Quality may prepare a focused customer question, but it is handed to Retention
(`handed_to_retention`), which sees it on its case and sends nothing twice. Quality writes directly only to
cleaners, about evidence for a visit they worked.

**A handoff is a record, not a task.** Every handoff Quality makes names the source case and visit, the sending
and receiving agent, the requested action, the evidence and constraints, the authority or approval, the due
date, the expected result, its current status and what came back. It is not done when the task is created;
it is done when the named record shows the result.

## Entitlements

`AGENT_CATALOG.quality.plans` is `["expand"]` and only Operate is on sale (`PLANS_ON_SALE`). This work does
**not** change that. The effect:

- Quality's **agent work** (background reviews, requests, AI reading) runs only where `agentVerdict` allows it.
  On Operate it shows "Quality isn't part of the Operate plan" and does nothing on its own.
- **People keep the workspace.** Reviewing visits, opening and working cases, recording findings, requesting
  statements by hand and reading evidence work on every plan, because the person-worked review queue they
  replace already existed on every plan. A paused or unavailable agent never removes access to existing cases.
- Making Quality part of Operate is one line in the catalog and is the Owner's decision.
