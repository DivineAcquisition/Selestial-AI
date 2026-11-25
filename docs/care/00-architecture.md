# Client Care: what it is built on

**Responsibility.** Understand the customer's request, coordinate the action needed to resolve it, and keep
the customer informed until it is actually resolved. A reply sent is not a resolved request.

Display name **Client Care**, in Operations. The stored identifier stays `customer-care` everywhere it was
already used (navigation, billing catalog, chat specialists); the backend agent id is the same string. The
workspace is `/app/agents/customer-care` with four tabs: Overview, Requests, Follow-ups, Care Setup.

Client Care is a view over the shared Inbox and the records, not a second inbox. Every customer message stays
in the client's conversation (`inboundMessages`, `messages`, `smsConversations`); a Care request points at it.

Code: `convex/clientCare.ts` (screens), `convex/clientCareWork.ts` (the worker), `convex/lib/clientCare/`.

## Owner decisions (November 25, 2026)

| Question | Decision |
| --- | --- |
| Who speaks to the customer | **Care is the one voice** for requests the customer starts. Care calls Retention's plan-change code for skips, pauses and cancellations, opens or links Quality and Retention cases for complaints, and relays any customer step Retention prepares for a case linked to a Care request. Retention receives the relationship signal. |
| Retention's own outreach | **Retention keeps it**: feedback asks, renewals, win-back and payment recovery. Once the customer replies or raises something, it is a Care request. |
| Entitlement | **Operate and Expand.** `AGENT_CATALOG["customer-care"].plans` lists both. Agent work runs only where `agentVerdict` allows it; without an active plan, requests are still recorded for people. |
| Policy source | **The customer's agreement first** (`rescheduleNoticeHours`, `lateCancelFeeCents` from its terms), **then Care Setup**. With neither, a late change goes to the Owner and no fee is ever applied or quoted. |
| Reading | **Rules now, a Claude reader when priced**, behind the `care_message_reading` task, which has no approved rate on the production card, so the rules read and nothing is charged. Up to 1,000 characters of a known client's message are kept on the Care message record (export and erasure cover it). |
| Starting authority | **Verified answers, invoice look-ups and acknowledgments start at Act automatically.** Every change (preferences, access, rescheduling, skips, plan changes, extras) starts at Ask me first. |
| The Care & Retention inbox | **Care reads it.** The reading switch moved to Care Setup; with no Care setting yet, Retention's earlier setting carries over. Retention no longer reads it. |
| Pilot | **Novara Cleaning.** |

## Phase 1: implementation map

### Reused as is

| Shared system | How Care uses it |
| --- | --- |
| Texts in (`convex/inbound.ts`, Telnyx and Quo webhooks) | Deduplicated by provider event id before Care sees anything. Care takes a known client's ordinary text after Sales and the STOP/HELP/START rules. |
| Conversation owner (`smsConversations.owner`, `agentsPausedAt`, `customers.conversationHeld`) | Checked when a reply is planned and again at send. A person, the Quo app or the review queue holding the thread stops every agent, Care included. |
| The outbox and the one sending policy (`messages`, `checkSend`, `messaging.claim`) | Every Care message is a `client_care_reply` row with `careRequestId`/`careStepId`, checked again by `careReplyClaim` at the moment it goes. Delivery states are the provider's. |
| Inbox routing (`lib/inbox/mailboxes.ts`) | Care email goes from the Care & Retention inbox when one is connected, otherwise "{Company} via Selestial". |
| Rescheduling (`lib/dispatch/reschedule.ts` `planMove`/`commitMove`, `lib/sales/capacity.ts` `checkCapacity`) | Options come from capacity; committing re-checks capacity and refuses if the visit changed since the plan. Crew are re-offered by Dispatch's own code. |
| Plan changes (`lib/retention/planChanges.ts`) | `previewPlanChange` and `carryOutPlanChange` (extracted from `applyPlanChange`, behaviour unchanged) skip a visit, pause or end a plan for exactly the visits shown. |
| One-off visit cancellation (`lib/jobs/visits.ts` `cancelVisit`) | Ends assignments, tells Dispatch, refreshes the client. |
| Complaints (`lib/retention/recovery.ts` `openRecovery`) | Opens or joins the one recovery case per visit; that queues Quality's investigation. Care links both. |
| Relationship signals (`lib/retention/signals.ts`) | A stated wish to cancel or reduce is raised to Retention, never used to delay the cancellation. |
| Invoices (`lib/finance/invoiceState.ts`, `customerClaim`) | Read-only. A pay link is the existing invoice's, made at send time by Finance's own claim. |
| Approvals, `authorityFor`, Agent Controls, presets | Thirteen `care.*` actions. Ask me first is a `care_action` proposal bound to a stamp of the material facts. |
| Tasks and events | Each open request keeps one task; every change is an event. |
| AI credits (`openExecution`, `reserveExecution`, `finishExecution`) | One reading is one `care_message_reading` unit, held before the model runs. |
| Notices (`lib/notify`) | Urgent request, request needs your decision, action failed, Care did this for you. |
| Migration marks, imported clients | A visit held by a migration is never moved or answered as confirmed; Care starts only from new inbound messages. |
| Company deletion and export registries | Every Care table is classified. |

### Extended

| Where | Change |
| --- | --- |
| `lib/statuses.ts`, `lib/departments.ts` | `customer-care` is a backend agent in Operations, `built: true`. |
| `lib/billing/catalog.ts`, `rateCards.ts`, `executions.ts` | Operate and Expand; released; `care_message_reading` task (no production rate). |
| `lib/permissionCatalog.ts` | `care.*` actions, with an `initial` level for the three the Owner chose to start automatic. |
| `lib/retention/planChanges.ts` | `carryOutPlanChange` extracted so Care calls the same code. |
| `lib/retention/actions.ts`, `outbox.ts` | A case linked to an open Care request hands its customer message to Care, which sends it once. |
| `convex/inbound.ts`, `convex/retentionInbox.ts` | Known clients' texts and Care-inbox emails go to Care intake instead of a person task and Retention's reader. |
| `convex/messaging.ts`, `schema.ts` `messages` | `client_care_reply`, `careRequestId`, `careStepId`; claim and settle hooks. |
| `convex/approvals.ts`, `proposalValidator` | `care_action`. |
| `convex/crons.ts` | Care's sweep. |
| Frontend navigation | Client Care is live with Overview · Requests · Follow-ups · Care Setup. |

### Added

`convex/lib/clientCare/schema.ts`: `careRequests`, `careMessages`, `careEntries`, `careSteps`, `careRuns`.
Company settings gain `clientCare`.

### Needs live-provider verification

- Telnyx and Quo delivery of Care replies, and the Gmail send and thread for Care email.
- The Claude reader (`CARE_MODEL=claude` with `ANTHROPIC_API_KEY`): written, verified only against a mock.
- A `care_message_reading` credit price, which the Owner has not set.

## Phase 2: responsibility boundaries

| Owns | In a customer request |
| --- | --- |
| **Client Care** | Intake, clarification, routine answers from the record, coordinating approved actions through the owners' functions, every customer-facing update, follow-through and closure. |
| **Sales** | New service, another property, a custom scope, quotes and proposals. Care routes and keeps the customer informed. |
| **Dispatch** | Whether a time can be covered, crew assignment and re-offers after a move. |
| **Quality** | Investigation, evidence review, corrective scope and verification. Care never states a finding. |
| **Retention** | Relationship risk, the recovery remedy, renewals and longer-term continuity. Its remedy steps for a Care-linked case go to the customer through Care. |
| **Finance** | Invoices, payment status, refunds, credits and collection. Care reads and links; it never marks paid, refunds or charges. |
| **Recruiter** | Applicants and cleaners. A text from an applicant or cleaner is never a Care request. |

Care copies none of their rules: it calls the same functions their own screens call.
