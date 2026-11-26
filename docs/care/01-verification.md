# Care: verification, capabilities and rollout

Checked on November 25, 2026 against branch `claude/modest-cray-dah54f`. What follows says plainly what was
verified against simulated providers, what was not run live, and what must happen before Care acts on its own
for a real company.

## How it was verified

| Check | Result |
| --- | --- |
| Care scenarios (`convex/clientCare.test.ts`) | 33 passing, through the real backend (convex-test), the real inbound webhook mutation and the mock text provider |
| Screens' answers from the real queries (`convex/careScreens.test.ts`) | Passing; writes `tests/fixtures/careScreens.json` with `CARE_SCREENS_OUT` |
| Screens rendered over those answers (`src/components/app/screens/care/care.test.tsx`) | 6 passing |
| Rules reader (`convex/lib/clientCare/read.test.ts`) | 9 passing |
| Whole suite (`npm test`) | 2,028 passing and 21 skipped, of 2,049 in 182 files (the skipped tests were skipped before this work) |
| Types (`npm run typecheck`) | Clean |
| Lint (`npx eslint`) | No errors; the remaining warnings are in files this work did not change |
| Production build (`npm run build`, local, no deploy) | Passes; `/app/agents/customer-care`, `/requests`, `/follow-ups` and `/care-setup` are built |
| Screenshots (`docs/screenshots/care/`) | Chromium at 1440 and 390 wide, the screens rendered over the fixture with the build's own stylesheet; a script checked every page at both widths for content wider than the screen and found none |

Problems the scenarios and screenshots found, and this work fixed: a contact's role read as the client's own
(the first contact is always primary, so tests now add the client's primary first); "still not fixed" opening a
new request instead of reopening the resolved one; "weren't wiped" not read as a complaint; a stale approval
that could have been carried out after the client changed the request; a second acknowledgment on a complaint
the client wrote about again; the overview calling Care "recording only" before a plan is chosen while the
worker did run; doubled full stops and a repeated provider phrase; the request panel's columns stretching; a
reply held for messaging funds that showed only on the message (the request now waits on the Owner and says why,
and picks up by itself once the message goes).

**Not run live.** No Telnyx, Quo, Gmail, Resend or Anthropic call was made. No message went to a real person.

## The required scenarios

| # | Scenario | Where it is checked | State |
| --- | --- | --- | --- |
| 1 | One of several bookings | "asks which visit when a client with several bookings…" | Verified |
| 2 | Shared contact limited to one site | "acts only within a contact's own authority and properties" | Verified |
| 3 | Answer from verified appointment data | "says exactly what the visit's record says…", "says a visit held by a migration is not confirmed" | Verified |
| 4 | Preference for one visit, series unchanged | "puts a one-visit preference on that visit only…", "asks whether a preference is for one visit or every visit…" | Verified |
| 5 | A time becomes unavailable before confirmation | "offers only times capacity allows, and re-checks the chosen one when it is carried out" | Verified |
| 6 | One skip leaves the recurring schedule intact | "skips one visit of a recurring plan…" | Verified |
| 7 | Cancellation by policy, no retention obstruction | "ends the plan as the client asked, tells Retention, and sends no retention offer", "asks what 'cancel' means…" | Verified |
| 8 | Complaint: one linked case, coordinated updates | "acknowledges without findings, opens one linked recovery case…" | Verified |
| 9 | Invoice look-up creates and charges nothing | "sends the existing invoice's record and link, and creates, charges or marks nothing" | Verified |
| 10 | Human takes over while a reply is queued | "stops a queued reply when a person takes the request over" | Verified |
| 11 | Sales and Care receive the same event | "leaves a client's reply on an open Sales inquiry to Sales" (Sales is asked first; Care takes only what Sales doesn't) | Verified |
| 12 | Duplicate webhooks and worker retries | "handles one delivery once, however often the webhook or the worker repeats it" | Verified |
| 13 | Client changes the request while approval is pending | "never carries out an approval for a request the client has since changed" | Verified |
| 14 | Change succeeds, notification fails | "keeps a change that was made, retries only the message, and never makes the change twice" | Verified |
| 15 | Provider timeout leaves delivery uncertain | "leaves an uncertain send uncertain and never sends it again by itself" | Verified |
| 16 | Spending limit or disconnected channel blocks visibly | "shows a reply held for messaging funds on the request, and picks up once funds arrive", "shows a channel that can't send on the request…" | Verified |
| 17 | Imports and migration-held records start nothing | "keeps a replayed or imported message for the record and starts nothing", the migration-held visit test | Verified |
| 18 | A resolved request reopens | "reopens a resolved request when the client says it isn't done" | Verified |
| 19 | Another tenant cannot read or act | "never lets another company read or act on a request" | Verified |
| 20 | Pause stops new autonomous work, hides nothing | "keeps everything while Care is paused…" | Verified |

Email intake through the Care & Retention inbox is exercised by Retention's existing inbox tests, which now
pass through Care (a known customer's mail is opened, only their own lines are read, a described problem
becomes a recovery case, a stated wish to cancel becomes Retention's signal).

## Capability matrix

| Capability | State | Notes |
| --- | --- | --- |
| SMS intake (Telnyx and Quo webhooks) | Implemented, verified (simulated) | After STOP/HELP/START and Sales. Deduplicated by provider event id. |
| Email intake (Care & Retention Gmail inbox) | Implemented, verified (simulated) | Off until turned on in Care Setup (Retention's earlier switch carries over). |
| Several requests in one message | Implemented, verified | Rules split clauses. |
| Appointment and service questions | Implemented, verified | Booked, offered, accepted, in progress, held by a migration, booking requested, awaiting payment. No arrival estimate beyond the record. |
| Preferences: one visit, property, client | Implemented, verified | Asks when the scope is not said. Supplies requests are handed to Dispatch to confirm. |
| Access instructions | Implemented, verified with no key | Written to the restricted field only when `MAILBOX_TOKEN_KEY` can seal them; otherwise handed to a person. The code is withheld from Care's stored words, events and notices. |
| Rescheduling within policy | Implemented, verified | Capacity-backed options; re-checked on commit by Dispatch's `commitMove`; price unchanged. |
| Skip one visit / cancel a one-time visit | Implemented, verified | Through Retention's plan-change code and the visit cancellation. |
| Pause or end a plan | Implemented, verified | Retention's signal raised; never delayed. |
| Late-change fees | Not included | `care.apply_fee` is unavailable; a late change goes to the Owner. |
| Complaint intake | Implemented, verified | Opens or joins Retention's recovery case, which starts Quality. Serious words go urgent to the Owner. |
| Retention's remedy steps through Care | Implemented, verified | A Retention customer step on a Care-linked case is sent by Care in the client's thread, once; Retention's step settles from the provider's answer ("sends Retention's case message in the client's own Care thread…"). |
| Invoice and payment questions | Implemented, verified | The invoice's own link; a "paid" claim goes to Finance; refunds go to the Owner. |
| Extras (published add-ons) | Implemented, verified | Only an add-on the visit's own published service lists. The price is the pricing engine's difference for that visit; the client says yes to that exact price; the Owner approves (Ask me first); it is priced again when carried out and stops on any change, an issued invoice or a crew that can't cover the longer visit. A custom scope goes to Sales. |
| New service | Implemented, verified via Sales intake | Filed as a Sales opportunity; Sales owns the quote. |
| Authority per action, approvals bound to facts | Implemented, verified | Thirteen `care.*` actions; `care_action` proposals carry a stamp of the facts. |
| Conversation ownership and takeover | Implemented, verified | Holds the client's conversation and the text thread; queued agent messages stop. |
| Durable runs, leases, retries, recovery | Implemented, verified | Sweep every 5 minutes; three tries, then a task for a person. |
| Follow-through | Implemented, verified | One reminder per open question, promised updates at most four times, linked work that finishes. |
| Workspace: Overview, Requests, Follow-ups, Care Setup | Implemented, verified (rendered) | Not exercised in a signed-in browser against a deployment. |
| Care on related records | Implemented, verified (query) | The client's profile, the visit panel and the Inbox thread list the client's Care requests and where each stands (`clientCare.forRecord`); never the client's words or access details; another company gets nothing. |
| Owner notices | Implemented, verified | Urgent request (critical), request needs a person, message failed, and "Care did this" at Act and notify me. |
| AI reading | Implemented, not live | `CARE_MODEL=claude`; the `care_message_reading` task has no approved price, so the rules read and nothing is charged. |
| AI calling | Not included | Excluded from this release. |

## Integration map

| Record or system | How Care touches it |
| --- | --- |
| `inbound.ts`, `retentionInbox.ts` | Intake (`lib/clientCare/intake.ts receive`) |
| `messages`, `messaging.ts` | `client_care_reply`; `careReplyClaim` at send; `afterCareReply` on every outcome |
| `smsConversations`, `customers.conversationHeld` | Ownership checks; takeover and hand-back |
| `jobs`, `assignments`, `bookings` | Read for answers; `commitMove`, `cancelVisit` |
| `servicePlans`, `recurringPlans`, `planVisits` | `previewPlanChange`, `carryOutPlanChange` |
| `properties`, `customers` | Preferences and access, with revisions |
| `retentionCases`, `retentionSignals`, `retentionActions` | `openRecovery`, `noteStatedWish`, the relay |
| `qualityCases` | Linked through the recovery case |
| `salesOpportunities` | `fileInquiry`; Sales precedence |
| `invoices` | Read only; Finance's own link at send; an issued invoice stops an extra |
| `services`, `serviceVersions`, `serviceQuotes` | `quote` (the engine) and `saveQuote` for an accepted extra |
| `approvals`, `permissions`, `tasks` | `care_action`, `authorityFor`, one task per request |
| `lib/notify` | `care_urgent`, `care_attention`, `customer-care.reported` |
| `lib/billing` | Catalog (Operate and Expand), `care_message_reading` |
| `lib/trust` | Deletion, export (sealed fields omitted) and customer erasure |

## Authority defaults (a new company)

| Action | Starts at | Standard | Ceiling |
| --- | --- | --- | --- |
| Answer a question from the record | Act automatically | Act automatically | Act automatically |
| Acknowledge and ask what is missing | Act automatically | Act automatically | Act automatically |
| Send an invoice's record and link | Act automatically | Act automatically | Act automatically |
| Acknowledge a complaint, open the cases | Act automatically | Act automatically | Act automatically |
| Send a promised update | Ask me first | Act automatically | Act automatically |
| Record a preference | Ask me first | Act and notify me | Act automatically |
| Replace access instructions | Ask me first | Act and notify me | Act and notify me |
| Move one visit | Ask me first | Act and notify me | Act automatically |
| Skip or cancel one visit | Ask me first | Act and notify me | Act automatically |
| Pause or end a plan | Ask me first | Act and notify me | Act automatically |
| Add a published extra | Ask me first | Act and notify me | Act and notify me |
| Apply a late-change fee | Unavailable | Ask me first | Ask me first |
| Hand a request to another agent | Act automatically | Act automatically | Act automatically |

The first four starting levels are the Owner's decision of November 25, 2026; everything else follows the
review-first rule. Refunds, credits, contract changes and anything legal stay on their existing person-only path.

## Deployment and live-provider requirements

1. **Deploy the backend with the site** (the normal production build). The schema changes are additive.
2. **Texting**: an approved registration and number (or a ready Quo connection with Care allowed in its
   agent list). Clients need recorded operational permission; a contact with none is refused by the send policy,
   which the request shows.
3. **Email** (optional): a Gmail inbox connected for Care & Retention, allowed to send, and reading turned on in
   Care Setup.
4. **`MAILBOX_TOKEN_KEY`** on the deployment, so new access details can be sealed and written to the property.
   Without it they are handed to a person.
5. **AI reading** (optional): an approved `care_message_reading` price on the rate card, `CARE_MODEL=claude`
   and `ANTHROPIC_API_KEY`. Until then the rules read, at no charge.
6. **Care Setup**: a change-notice value (or customer agreements that state one). Without it, every move, skip
   and cancellation comes to the Owner.
7. **Live verification still owed**: one text and one email to the Owner's own phone and address, a delivery
   receipt back, a reply that opens a request, and a Gmail reply joining its thread.

## Launch: every company

The Owner chose on November 25, 2026 to launch Care for every company on Operate and Expand at once,
instead of a pilot first. What keeps that safe is the starting authority above, not a slower rollout:

1. **On by default, cautious by default.** Every company starts with verified answers, invoice look-ups and
   acknowledgments on their own, and every change waiting in Approvals. Nothing a company had before changes.
2. **Nothing new is sent without what it needs.** A company with no texting registration, no client permission
   or no messaging funds gets requests recorded and shown, with the reason, and no message.
3. **The Owner's first week.** Set the change notice in Care Setup; review each request daily; raise an action
   to Act and notify me only after a week with no wrong visit or wrong scope.
4. **Stop rules.** Any message about the wrong visit, a disclosed access code, or two agents writing the same
   client about the same thing: pause Care (one button), fix, and restart at Ask me first.
5. **Measures, from the record only**: requests resolved with outcome on record, time to first answer, changes
   carried out without a later correction, approvals changed or skipped, promised updates sent late.

## Earlier pilot plan (superseded): Novara Cleaning


1. **Week 0.** Enable texting checks; set the change notice in Care Setup; leave every change at Ask me first;
   choose escalation contacts. Send test texts from the Owner's own phone only.
2. **Week 1 (answers only).** Real clients. Verified answers, invoice look-ups and acknowledgments go on their
   own (the starting defaults); every change waits in Approvals. Review each request daily: wrong reads, wrong
   visits, wording.
3. **Week 2.** If week 1 shows no wrong visit or wrong scope, raise preferences and one-visit skips to Act and
   notify me.
4. **Week 3.** Raise rescheduling inside the notice window to Act and notify me. Keep plan pauses and ends at
   Ask me first.
5. **Stop rules.** Any message about the wrong visit, a disclosed access code, or two agents writing the same
   client about the same thing: pause Care (one button), fix, and restart at Ask me first.
6. **Measures, from the record only**: requests resolved with outcome on record, time to first answer, changes
   carried out without a later correction, approvals changed or skipped, promised updates sent late.
