# Launch readiness record

Maintained on branch `claude/selestial-launch-readiness-6l0r9s`. Started November 22, 2026 from `main` at
`e103fae` (the earlier review looked at `2a418e2`; everything below was re-checked against the code, not
taken from older documents).

**Evidence states used here**

| State | Meaning |
|---|---|
| Not implemented | No code. |
| Implemented; automated tests passed | Code and tests in this repository. Fakes stand in for providers. **Not** proof it works live. |
| Verified with provider sandbox | Exercised against a real provider's test facility. |
| Verified by controlled production check | Observed on the live system, read-only or with a controlled recipient. |
| Blocked externally | Needs an account, key, decision or dashboard this work could not reach. |

Nothing in this record is marked passed on the strength of a mock, a screenshot or a successful deploy.

## Verdicts

| | Verdict | Why |
|---|---|---|
| **Assisted pilot** (you onboard each company, watch it daily) | **Not ready yet. Ready once the six "Before the first pilot company" actions below are done** and this branch is merged. | The code gates are closed and tested, but no money, text or mailbox journey has been run against a real provider from this work, the Stripe webhooks could not be found, and nothing outside Selestial watches the monitoring. |
| **Unrestricted self-service** | **Not ready.** | Google restricted-scope verification for Gmail, real Indeed/ZipRecruiter samples, live Telnyx registration and release, a restore rehearsal, a test backend with test keys, and the $199 offer terms are all outstanding. |

## Decisions recorded (November 22, 2026, by the Owner)

| Question | Decision | What follows |
|---|---|---|
| Which Stripe account Selestial bills from | A Selestial account, not the one this work could reach. The Owner has added the webhook there. | Confirm in that dashboard that both `/webhooks/stripe-billing` and `/webhooks/stripe` (connected accounts) point at `stoic-gazelle-731.convex.site` and their signing secrets are set on that deployment. Then the unpaid-plan lock and payment reconciliation can be exercised. |
| $199 offer: duration | $199 a month for the first 12 months, then $299. | Built (gate 11); not yet verified with Autumn sandbox. |
| $199 offer: eligibility | The first 15 companies whose first plan payment succeeds. A sign-up that never pays does not use a place. | Built (gate 11); not yet verified with Autumn sandbox. |
| $199 offer: after 12 months | Moves to $299 automatically, with an email and in-app notice about 30 days before. | Built (gate 11); not yet verified with Autumn sandbox. |
| $199 offer: cancel and return | $299 on return. The place is not handed to anyone else. | Built (gate 11); not yet verified with Autumn sandbox. |
| Messaging charges | On for all users. No company is live yet, so no notice period is needed. | Switch-on is one setting on `stoic-gazelle-731` (`MESSAGING_BILLING`); to be done with the Owner's approval of that exact step, after the Autumn catalog holds `messaging_balance` and `messaging_top_up`. |
| Sales message reading | Approved at 1 credit per customer message read by AI (same as a hiring email read by AI). | Rate card `2026-11c` added; takes effect when `BILLING_RATE_CARD` is set to `2026-11c` on production. |
| Company deletion vs. the 90-day promise | Both: build a staff-run deletion that honors 90 days and keeps legally required records, and have counsel tighten the wording on what is retained. | To build; wording to counsel (docs/operations/07-account-closure.md). |

## Environments (verified November 22, 2026)

| Fact | Evidence | State |
|---|---|---|
| Production site is Vercel project `selestial-ai`, production deployment built from `main` `e103fae` | Vercel API: latest production deployment READY, commit `e103fae` | Verified by controlled production check |
| The live site talks to Convex `stoic-gazelle-731` | The served browser bundle at `app.selestial.io` contains `stoic-gazelle-731.convex.cloud` and no other deployment | Verified by controlled production check |
| `terrific-avocet-835` is the test / previous backend, and forwards old addresses | Its settings include `MOVED_TO`; `/webhooks/telnyx` answers 401 unsigned on both backends (alive, signature enforced) | Verified by controlled production check |
| `terrific-avocet-835` still holds live-era provider settings and has **no `TEST_RECIPIENTS`** | Setting names only were listed (no values read). With no `TEST_RECIPIENTS` it can send to nobody, which is safe, but it also cannot be used for controlled send tests | Verified; **owner action 3** |
| Production settings on `stoic-gazelle-731` (including `MESSAGING_BILLING`, `BILLING_RATE_CARD`) | This session holds only the test backend's key | **Blocked externally**; staff can now read these on `/staff/operations` after merge |
| Resend webhook points at production | Resend API: `stoic-gazelle-731.convex.site/webhooks/resend` enabled; the old endpoint is disabled | Verified by controlled production check |
| Resend sending domains | Six domains verified (`selestial.io`, `mail.`, `notify.`, `updates.`, `auth.`, `reply.`; `reply.` receives) | Verified by controlled production check |
| **Duplicate DMARC record still exists** | Public DNS: `_dmarc.selestial.io` returns two TXT records (`v=DMARC1; p=none;` twice). Two records make DMARC invalid for the domain. `_dmarc.notify.selestial.io` has one. | Verified; **owner action 4** |
| **No Selestial Stripe webhook endpoints found** | The Stripe account reachable from this session (DivineAcquisition) has two **disabled** endpoints pointing at Supabase in live mode, and none in test mode. Nothing points at `/webhooks/stripe` or `/webhooks/stripe-billing`. Either Selestial bills through a different Stripe account, or the endpoints are missing. | **Blocked externally; owner action 1 (highest priority)** |
| Telnyx account state (profile webhook, numbers, registrations) | The Telnyx connection in this session returned "no usable credentials" | **Blocked externally** |
| Clerk | Application "Selestial" has a production instance (`clerk.selestial.io`) and a development instance; the live bundle uses the production key | Verified by controlled production check |
| No provider secret in the live browser bundle | Scanned the served scripts for Stripe, Autumn, Resend, Telnyx and private-key patterns: only the Clerk publishable key | Verified by controlled production check |
| CI | The repository had **no** workflows. Added in this branch. | Implemented |

## Gates

Each gate: customer outcome · what exists (files) · what this work changed · acceptance · evidence · what remains and who owns it.

### 1. Buying the plan, credits and AI charges

- **Outcome:** an owner buys the plan once, gets the right access and credits, and each piece of AI work is charged once.
- **Exists:** `convex/billing.ts`, `convex/lib/billing/*`, `billing/autumn.config.ts`, `/webhooks/autumn`.
- **Fixed here:**
  - A purchase whose result was unknown (timeout, 429, 5xx) was reported as "Nothing was charged" and a retry used a new key, so a one-off purchase could be charged twice. It now keeps the same purchase and key, retries on a schedule, and says it could not confirm yet.
  - Purchases paid on the hosted payment page never closed, so the dialog reopened on every visit and a paid messaging top-up stayed "Waiting for payment" and was missing from the statement. They now close from Autumn's record, old ones are ignored after 30 minutes, and the dialog can be closed.
  - "Hard" AI budgets could be exceeded by work opened at the same moment; pending work now counts.
  - Finished AI work that could not be charged, and a failed payment that matched no company, now raise a staff incident.
- **Acceptance:** one charge per purchase and per completed piece of work; failed, cancelled and retried work releases its hold; duplicates and out-of-order callbacks change nothing.
- **Evidence:** Implemented; automated tests passed (`convex/billing.test.ts`, `billingLock.test.ts`, `messagingFunds.test.ts`).
- **Remaining:** every Autumn response shape is assumed from documentation and a fake (`tests/fakeAutumn.ts`). Run one sandbox purchase, one AI charge, one top-up and one refund and compare with `convex/lib/billing/autumn.ts` (shapes listed in "Provider shapes to confirm"). **Owner + engineer; needs a test backend with an Autumn sandbox key (owner action 3).**

### 2. Messaging money

- **Outcome:** an owner adds funds, sees the true balance, and each text or email is reserved and settled once at the right segment count.
- **Exists:** `convex/messagingBilling.ts`, `messagingFunds.ts`, `convex/lib/messagingBilling/*`.
- **Fixed here:** turning automatic top-up **off** could fail silently while the screen said off; it now shows "Turning off…" until Autumn confirms, retries, and tells the owner if it is still on.
- **`MESSAGING_BILLING`:** defaults off, which makes every message free. Nothing was switched on. Staff now see "Messaging charges: ON/OFF" on `/staff/operations`; on the production backend, OFF with no recorded reason shows a warning and raises one staff incident. A deliberate subsidy is recorded with `MESSAGING_BILLING_SUBSIDY_NOTE` (free text), which shows instead of the warning. Documented in `docs/billing/03-messaging-billing.md`.
- **Evidence:** Implemented; automated tests passed. Segment counting (GSM-7, UCS-2, extension characters, surrogate pairs) was re-read and is correct; the charge uses the provider's own part count.
- **Remaining:**
  - Production state of `MESSAGING_BILLING`: **Blocked externally** (read it on `/staff/operations` after merge). **Decision needed: charge, or record a pilot subsidy (owner action 5).**
  - A refund of a **manual** top-up cannot be matched: the purchase response carries no Stripe invoice id. Needs Autumn to return it, or confirmation that its invoice list id is Stripe's. Until then such a refund leaves the funds in place. **Engineer, after sandbox run.**

### 3. Unpaid plan: lock, pay, restore, cancel

- **Outcome:** a failed payment restricts the account clearly, paying restores it at once, and cancelling deletes nothing.
- **Exists:** `convex/billingLock.ts`, `src/components/app/billing/locked.tsx`, `docs/billing/04-unpaid-plan.md`.
- **Fixed here:**
  - A late "payment failed" arriving after "paid" could lock a paid account with nothing left to unlock it. A paid or voided invoice now leaves a record, and every lock re-reads the invoice from Stripe first.
  - "I've paid, check again" only re-read Autumn and could not unlock. It now asks Stripe about the unpaid invoice and unlocks only if Stripe says it is paid.
  - The 30-day cancel treated a repeated success as a failure.
  - A locked owner could not export their records, though the Terms say to export first. Export now works while locked, with a "Your records are still yours" panel on the locked screen.
- **Evidence:** Implemented; automated tests passed.
- **Remaining:** depends entirely on Stripe's invoice events reaching `/webhooks/stripe-billing`. **See owner action 1.** Not exercised with a real failing test card.

### 4. Business texting

- **Outcome:** a company registers once, gets one number, exchanges real texts, and STOP is always honoured.
- **Exists:** guided setup, readiness, provisioning and corrections in `convex/texting*.ts`, `convex/lib/texting/*`, `convex/messaging.ts`, `convex/inbound.ts`.
- **Fixed here:**
  - Staff "Reject" on a corrected request led to a second brand, campaign and setup fee. Reject is refused once anything is filed; staff use Send back.
  - While only a new number was needed, the owner could add uses the approved campaign never covered. Everything but the number is now locked in that state.
  - A rejected, non-appealable campaign could be "corrected" unchanged for a fee, repeatedly. Nothing is filed or charged; it goes to staff.
  - Opt-out words now include REVOKE, OPTOUT and OPT OUT, and a message that is only "please stop" counts. START restores what a plain-words stop withdrew.
  - The uncertain-send check could mark a possibly-sent text as failed. It now returns to "unconfirmed". The existing safeguards (same idempotency key, time window, policy re-checks, no blind resend) are unchanged.
  - A failed number assignment could not be retried in the app; Retry now re-assigns and never buys again.
  - Owners are now told when a registration is rejected or fails.
  - A non-production backend with no link address set no longer emits production links.
- **Evidence:** Implemented; automated tests passed (`convex/texting.test.ts`, `reconcile.test.ts`, `textingCase.test.ts`). Checked and left as they were: idempotent brand/campaign/number creation, duplicate and out-of-order delivery reports, expired and stale offer links.
- **Stress tested (November 22, 2026):** `convex/telnyxStress.test.ts` drives the real outbox, Telnyx client and `/webhooks/telnyx` route against a fake Telnyx that follows its documented idempotency (replay for 24 hours, 409 while a key is in progress, errors not replayed). It covers 60 texts at once through rate limits, Telnyx errors and answers lost after Telnyx took the text; 40 texts whose delivery reports come shuffled, three times over and partly before the send's own answer; the same messages queued six times at once; 200 forged, altered, stale and unsigned webhooks; and STOP / START / HELP / ordinary replies from 25 numbers, each delivered twice and out of order. Invariants checked: no text goes twice, a text Telnyx may have taken is never called failed, nothing is left in flight, each delivery is recorded once, and a refused webhook changes nothing. It found and fixed two faults:
  - A text whose every attempt got Telnyx's 409 ("an earlier attempt under this key is in progress") was marked **failed** after three tries, though it may have gone. A 409 now leaves it unconfirmed, and Selestial's own check under the same key settles it.
  - When Selestial's automatic check with Telnyx itself lost its answer, the five-minute sweep left the check marked as under way, so the text stayed unconfirmed for good and neither Selestial nor staff could check it again. The sweep now ends the check. The 24-hour replay window is now counted from the text's **first** attempt (`firstAttemptedAt`), not the latest check, and automatic checks stop 30 minutes after the first attempt, after which a person decides.
- **Production settings (November 22, 2026):** `stoic-gazelle-731` has `MESSAGING_PROVIDER=telnyx`, `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY` and `TELNYX_MESSAGING_PROFILE_ID` set (names checked; only the provider word read), and its health check reports ok.
- **Remaining:** nothing here has been exercised against live Telnyx from this work, and Telnyx has no sandbox for registration. One controlled company must complete a real registration, send to a controlled phone, and reply STOP / HELP / START. **Owner approval required for the registration and number fees (owner action 6).** Confirm with counsel that the opt-out word list meets current FCC revocation rules.

### 5. Number offboarding (was missing)

- **Outcome:** an owner can ask to move or release their number, understands fees and timing, and nothing irreversible happens without their authorization.
- **Built here:** "Stop using this number" on the texting screen (move to another provider, or release), with fees, timing and permanence explained and a ticked acknowledgement for release. Staff-assisted: admin-only "mark transfer complete" and "release number", which need the destructive-records capability and the owner's authorization for that exact number. Release is refused while a transfer is pending. A cancelled plan opens a staff work item; it never releases anything by itself. Procedure: `docs/texting/03-offboarding.md`.
- **Evidence:** Implemented; automated tests passed.
- **Remaining:** the release calls have **never run against live Telnyx**. Monthly number and registration fees continue until release even after a plan ends: **decision needed on whether fees should stop at plan end.** A company that releases a number cannot set up again without staff.

### 6. Email

- **Outcome:** company email is delivered, replies route back, bounces and complaints suppress, and account notices are never charged to the customer's balance.
- **Exists:** `convex/lib/email/*`, `convex/lib/notify/*`, `/webhooks/resend`.
- **Evidence:** domains and webhook destination verified live (table above). Account notices (`member_notice`, compliance replies, verification codes, operator alerts) are excluded from charges in `convex/lib/messagingBilling/classify.ts`: Implemented; tests passed.
- **Remaining:** the duplicate DMARC record (owner action 4). Delivery, reply, bounce, complaint and suppression were not demonstrated with a controlled recipient because the test backend has no `TEST_RECIPIENTS`. **Engineer, after owner action 3.**

### 7. Gmail connection

- **Outcome:** an owner connects a mailbox safely, it stays connected, and disconnecting stops the work.
- **Exists:** `convex/recruiterMailbox.ts`, `inboxes.ts`, `recruiterGmailWatch.ts`, `/oauth/google/callback`, `/webhooks/google/pubsub`.
- **Fixed here:**
  - The return from Google trusted the state alone, so a link started by one company's owner could connect a different person's mailbox to that company. The callback now connects nothing: the signed-in member who started must confirm the mailbox address shown to them, within 15 minutes, or the authorization is deleted and revoked.
  - Disconnecting a Google tool on the same account revoked the mailbox's access too.
  - A mailbox connected from Recruiting silently became the Sales and Care sender.
  - The Recruiting disconnect skipped revocation and the security notice; an in-flight sync could bring a disconnected mailbox back.
- **Scopes requested:** `gmail.readonly` (restricted), `gmail.send` only when sending is allowed (sensitive), `openid`, `email`. Never `gmail.modify`.
- **Evidence:** Implemented; automated tests passed (`convex/recruiterGmail.test.ts`, `inboxes.test.ts`).
- **Remaining:**
  - **Google verification is not shown to be complete, and is not claimed.** `gmail.readonly` is a restricted scope: an app used by external users needs Google's verification and a security assessment, and an app left in "Testing" loses refresh tokens after 7 days. **Owner: check the consent screen status in Google Cloud (owner action 7).** Until verified, connect only pilot mailboxes you have added as test users, and expect weekly reconnects.
  - The Google **tools** connection (Calendar, Drive, Business Profile, Ads) has the same state-only weakness on a separate code path. **Not fixed. Engineer; do before self-service.**
  - The Pub/Sub push subscription must point at `stoic-gazelle-731.convex.site`; pushes forwarded from the old backend fail their audience check (timers cover the gap). **Owner: confirm in Google Cloud.**
  - `gmail.readonly` is requested even for a send-only mailbox.

### 8. Recruiter applicant intake

- **Outcome:** a real applicant notification becomes the right applicant, once, and nothing is sent when identity is uncertain.
- **Fixed here:**
  - Replies through Indeed/ZipRecruiter relay addresses were discarded as promotions, so "stop emailing me" was lost.
  - The mailbox's own sent mail was read as new applications.
  - Mail from other job boards was treated as the applicant's own address; later applicants were filed under the first. Those boards now go to human review and never produce a contactable address.
  - Unrecognised Indeed/ZipRecruiter mail was dropped silently; it now opens one review item.
  - Historical import now reads oldest first.
- **Evidence:** Implemented; automated tests passed (`convex/recruiterIntake.test.ts`).
- **Remaining:** **every Indeed and ZipRecruiter sample in the tests is invented.** The gate is not passed until real notifications are read correctly. `docs/recruiter/07-real-samples.md` says how to capture and redact them; files dropped in `tests/fixtures/recruiter-real/` are checked automatically. **Owner: supply 3–5 real notifications of each (owner action 8).** Microsoft stays "Coming soon".

### 9. "Start my agents" and the four agents

- **Outcome:** starting launches server-side work that continues with the browser closed, and every reported result is real.
- **Confirmed in code:** start is one owner-only transaction; steps run as scheduled work with leases, three attempts and a 5-minute sweep; repeat clicks return the same batch; owner status, suspension, pause and plan are re-checked before each step; existing drafts are reused, not overwritten; no demo data path exists for a real company.
- **Fixed here:**
  - Activation summaries claimed work that had not been confirmed (Retention "Reconciled…" for a run that never finished, Sales counting skipped and failed runs as reviewed, Recruiter "no new applications" when the inbox was not read, Dispatch "every visit has an offer out" when none was made). Each now states only what finished.
  - **Dispatch** used up every cleaner when the company's texts were blocked (registration pending, no funds, suspended): each offer ended "undelivered", the cleaner was ruled out, and the next was asked. Such offers now end as "never texted", rule nobody out, and the visit waits on the one "texts are not going out" task.
  - A visit report sent back for correction told nobody and could leave the crew with an expired link. The crew is now texted a link good for a day, and the job page shows the note.
  - A cleaner or applicant link could delete a stored file by id, including evidence from another job. Uploads are now discarded only when recent and kept by nothing.
- **Evidence:** Implemented; automated tests passed (`convex/activation.test.ts`, `dispatchFlow.test.ts`, `dispatchCore.test.ts`, `linkAudit.test.ts`, and each agent's suite). Tenant isolation, link tokens, consent, send-time policy and approval re-checks were audited and found sound.
- **Remaining:**
  - No agent has completed a full business outcome against real providers from this work. **Engineer + owner, with the first pilot company.**
  - Rules-based agent work (cron-driven) does not check the plan; after a plan is cancelled for non-payment agents are un-paused. Sends are still refused when messaging charges are on, but **not when they are off**. **Engineer; before self-service.**
  - A suspended company's Sales drafts, Recruiter inbox reads and Dispatch offers continue (sends are blocked).
  - Activation tasks marked "unavailable" do not resume when a plan is bought the same day.
  - Importing `googleWork` into `convex/google.test.ts` changes another test's result; cause not found. **Engineer.**
  - **Real-phone check not done:** camera permission, poor connectivity (a failed upload restarts and is lost on reload), expired and reassigned links on iOS and Android. **Explicitly unverified.**

### 10. Sales message reading

- **Path:** Sales calls the AI reader only when `SALES_MODEL=claude`, a key is set and a credit hold is verified. `sales_message_reading` has **no approved rate** on either production rate card (`convex/lib/billing/rateCards.ts`), so no hold can be made and the deterministic rules read every message.
- **Fixed here:** the Sales overview said "An AI reader reads customer messages" whenever the model was configured. It now says rules or AI truthfully, from the same data as the readiness row. Staff see unapproved rates on `/staff/operations`.
- **Prepared:** a test confirms that approving a rate on the rate card switches reading to AI with no code change. No rate was invented or borrowed.
- **Decided:** 1 credit per message read by AI, on new rate card `2026-11c` (published cards are never edited). Rules-read messages stay free.
- **Remaining:** set `BILLING_RATE_CARD=2026-11c` on production; then confirm in an Autumn sandbox run that one AI-read message holds and charges 1 credit. **Owner (setting) + engineer (sandbox run).**

### 11. Offer accuracy

- **Direction applied:** one public early-user plan at $299.
- **Found:** the code sold two plans (Operate $299, Expand $499). Expand was purchasable and promised "team coordination, with customer portals" and "eight agents". There was no $199 price, no first-15 counter and no trial anywhere.
- **Changed here:** only Operate is on sale (`PLANS_ON_SALE` in `convex/lib/billing/catalog.ts`). The server refuses a new Expand purchase; public pricing, navigation, agent pages, the in-app plan screen and every "Operate or Expand" message now describe one plan. A company already on Expand keeps it, with its identifiers, usage and invoices unchanged. No trial is promised anywhere (checked by the smoke test).
- **Evidence:** Implemented; automated tests passed; screenshots in `docs/launch/screenshots/public-pricing-*.png`.
- **The $199 early-user offer (Owner's terms of November 22, 2026):** built as its own Autumn plan, `operate_early` ($199, same group, credits, agents and features as Operate), which the app reads as Operate for every entitlement. Places are counted server-side in `earlyOffers`; a place is reserved by the Owner's confirmation (the race for the last place is decided there) and claimed only when Autumn shows the plan paid and active. The move to $299 is scheduled in the 12th billing period for the end of that period, once, with a staff incident if it fails; one email and one in-app notice go about 30 days before. A company that held a place pays $299 if it returns. Public pricing has one line under the $299 plan ("while places last"); Plan & Usage shows $199 only when the server says it will be honored. See `docs/billing/README.md`, "Early-user offer". **Evidence:** Implemented; automated tests passed — not verified with Autumn sandbox. **Remaining:** push the catalog to the sandbox, run one purchase, one month-12 move and one cancellation there; then the same `atmn push` on production (owner action).
- **Team Coordinator:** responsibilities are absorbed (Recruiter: hiring and readiness; Dispatch: visit staffing and coverage; Finance: pay records). Remaining promises removed from the plan copy; historical ids, the dedupe key, the history label and the redirect routes are kept.
- **Remaining:** Autumn's catalog still holds Expand; do **not** run `atmn push` with Expand removed (it would delete the plan existing subscribers are on). Features that were Expand-only and built (Creative Studio, second approver, template governance) cannot be bought by new companies.

### 12. Bookings and customer payments

- **Fixed here:**
  - A customer who accepted an alternative proposal option was scheduled and billed at the primary rate. Activation now uses the accepted option, or is blocked with a message.
  - Monthly invoices could be issued twice for the same visits; visits completed late in a month were never invoiced. Covered visits are recorded and checked.
  - The recurring-visit sweep handled only 200 plans across all companies.
  - A refund made in the Stripe Dashboard never reached Selestial. It is now recorded from Stripe.
  - A declined payment's intent was left open when a new payment started; a paid public booking could stall after ten tries with no alert; cancelling a booking left its unpaid invoice open.
  - Cleaner pay: the earnings page now says plainly that Selestial records pay and does not send money.
- **Evidence:** Implemented; automated tests passed (`proposals.test.ts`, `finance.test.ts`, `bookings.test.ts`). Server-side amounts, signature checks and idempotency keys were audited and found sound.
- **Remaining:** no Stripe test-mode onboarding or payment was run from this work (no Selestial Stripe endpoints or Connect configuration could be found). **Owner action 1, then engineer.** Two recurring-plan systems (`recurringPlans` from Sales, `servicePlans` from the client screen) can both schedule one client. **Engineer; before self-service. For the pilot, set up recurring service in one place only.**

### 13. Migration

- **Confirmed:** imported clients get no communication consent; appointments, schedules and history are inert records that never become bookings or trigger messages; re-import is idempotent.
- **Fixed here:** same-day visits were dropped as duplicates and times were lost; timestamps with a zone landed on the wrong day; "bi-monthly" was guessed; a street prefix could match the wrong property; a client matched by email and phone to two different people was not flagged. The review screen now shows imported-versus-scheduled counts and totals, a list of upcoming visits not yet scheduled, "Show more", Skip, and an explicit "I've set this up myself".
- **Evidence:** Implemented; automated tests passed (`migrationImports.test.ts`). The screen was type-checked, not viewed in a browser.
- **Remaining:** not run against a real Jobber or Housecall Pro export. **Do not tell a pilot customer to stop their old platform until the reconciliation panel shows every upcoming visit scheduled or deliberately skipped.** **Owner + engineer, per pilot company.**

### 14. Deployment and isolation

- **Fixed here:**
  - A non-production backend could still write to customers' real Google accounts (calendar, review replies, ads, conversions) from stale copies. Writes are now refused there; sign-in and reads continue.
  - Preview server actions could reach the live backend at run time.
  - The build order in the script and documents was wrong: the site builds first, then the backend is pushed, and the new backend is live before the new site. Documented, with the compatibility rule (never remove or rename a function or required argument in the same release as the site change; additive schema only).
- **Evidence:** Implemented; automated tests passed. All schema changes in this branch are additive (optional fields, new indexes, new status values).
- **Remaining (owner, dashboards):** give Preview its own backend address and a development sign-in key; make provider keys in Vercel Production-only; replace the live-era keys on `terrific-avocet-835` with test keys and set `TEST_RECIPIENTS`. Vercel's environment settings could not be read from this session.

### 15. Support, alerts and recovery

- **Fixed here:**
  - Staff alerts were marked sent when the email was refused or no staff existed. They now stay pending, with a banner on `/staff/operations`.
  - Nothing watched the monitoring. **New `GET /health`** answers 200 only while checks are finishing and alerts are being delivered; 503 with reason codes otherwise; no company data. See `docs/operations/06-heartbeat.md`.
  - Messages stuck queued for two hours now raise an incident. Public Google writes held through a suspension are cancelled, not run, if older than 24 hours. Restore release only undoes what the lock-down set, and lists payments, refunds and unconfirmed messages to reconcile first.
  - Revoking support access now ends every live session.
- **Evidence:** Implemented; automated tests passed (`operations.test.ts`, `recovery.test.ts`, `support.test.ts`).
- **Remaining:**
  - **No external monitor polls `/health` yet (owner action 10).** Until one does, a dead monitoring job is still silent.
  - **No restore rehearsal has been run**, and whether backups are enabled on `stoic-gazelle-731` is unverified. Steps are in `docs/operations/05-recovery-runbook.md` (restore into a new isolated deployment, never over production). **Owner + engineer (owner action 11).**
  - Whether any staff rows exist to receive alerts on production: **unverified**.

### 16. Privacy, export and account closure

- **Found:** the Privacy Notice says a leaving company's records are deleted within 90 days, and the Terms say Settings has tools to delete them. The code only files a request for staff; nothing deletes a company, and a plan cancelled for non-payment starts no clock.
- **Decided (November 22, 2026):** "Both": build the deletion so the 90-day promise is honoured, keep legally required records, and counsel tightens the wording on what is kept.
- **Now exists:** a staff-run company deletion (`convex/companyDeletion.ts`). One retention classification for every company table, with its reason in code (`convex/lib/trust/companyDeletion.ts`: 164 deleted, 7 anonymized, 41 kept), enforced by a test that fails when a company table is added without a decision. A precondition checklist (plan cancelled, no money in flight, messaging charges settled, texting number released; connections disconnected by the run itself; export offered), with admin waivers and reasons for the waivable ones. Start needs the Destructive actions capability, the company's deletion request and its name typed exactly. The company is closed at once to members, support sessions, every link page, agents, sending and recurring visits; the run disconnects Google, inboxes and Jobber, then works through every table in bounded, resumable batches, deletes stored files, leaves a tombstone and completes the request with a summary and one audit event. A plan cancelled for non-payment opens the deletion request automatically (due in 90 days; deletes nothing). An operations check raises an incident 14 days before a request is due and when a run fails. Staff see it on the request page; the Owner sees the status and what is kept in Settings and on a closing screen. No legal text was rewritten.
- **Evidence:** Implemented; automated tests passed (`companyDeletion.test.ts`, `billingLock.test.ts`, `dataRights.test.ts`); **not yet rehearsed on a copy of real data.**
- **Remaining:**
  - **Counsel (owner action 12):** confirm the kept categories and their periods, and tighten the sentences listed in `docs/operations/07-account-closure.md` › "For counsel" (privacy.ts:152, 155, 150-158; terms.ts:161, 179).
  - Rehearse one deletion on a restored copy of production in an isolated deployment and record the counts and time taken.
  - Backups, test backends and Clerk accounts are not reached by the run.

### 17. Release checks

- **Added:** `.github/workflows/ci.yml`: lint, app and backend type checks, all tests, a build that cannot deploy (the job fails if it ever holds a deploy key or runs as production), and an isolated smoke run of the built site (`tests/e2e/smoke.mjs`: public pages, the true offer, gated pages fail closed, link pages leak nothing, no secret in the bundle).
- **Evidence:** all five pass locally on this branch. See `docs/launch/release-checks.md`.
- **Remaining:** branch protection needs repository administration (**owner action 13**; exact settings in `release-checks.md`). The signed-in browser runs (`tests/e2e/auth.mjs` and others) need a development sign-in instance and a test backend, so they are not in CI yet.

### 18. Final walkthrough

- **Done:** public site on desktop and mobile (screenshots in `docs/launch/screenshots/`); gated routes and link pages checked by direct URL with no session.
- **Not done:** the signed-in walkthrough with two companies and several roles (sign-up, verification, reset, onboarding, purchase, integrations, first agent result, invitations and role limits, booking, cleaner action, payment, approval, recovery, cancellation, support). It needs a backend that accepts a development sign-in and test provider keys, which does not exist yet (owner action 3). **Explicitly unverified.** Role and company boundaries are covered by automated tests at the function level (`isolation.test.ts`, `authority.test.ts`, `linkAudit.test.ts`), which call the backend directly rather than through buttons.

## Provider shapes to confirm in a sandbox run

These are what the code assumes. Each is from documentation and a fake, not from a live response.

| Provider | Assumption | Where |
|---|---|---|
| Autumn | Hold: `POST /v1/balances.check` with `lock {lock_id, expires_at}` returns `{allowed, customer_id, balance.remaining}` | `convex/lib/billing/autumn.ts` |
| Autumn | Settle: `POST /v1/balances.finalize {lock_id, action, override_value}`; a 409 means already applied; a 4xx means the lock expired | same |
| Autumn | Auto top-up: `customers.update` with `billing_controls.auto_topups[]`; events `billing.auto_topup_succeeded` / `_failed` with `data.customer_id`, `data.invoice.stripe_id` | same; `convex/http.ts` |
| Autumn | Customer id is `company_<id>`; a second attach of the same plan is refused; `balance.remaining` is net of holds | `convex/lib/billing/access.ts` |
| Autumn | Cancel: `billing.update` with `cancel_end_of_cycle` / `cancel_immediately` / `uncancel` | `autumn.ts` |
| Stripe | Invoice events carry the Autumn customer id in metadata (`autumn_customer_id`, `autumn_id` or `customer_id`) | `convex/lib/billing/lock.ts` |
| Stripe | `charge.refunded` carries `invoice` as a string and cumulative `amount_refunded` on the endpoint's API version | `convex/http.ts` |
| Telnyx | Campaign status after an update or appeal; 409 on a duplicate assignment; number and campaign deletion | `convex/lib/messaging/telnyxAccount.ts` |
| Resend | Event names and signature scheme; the two meanings of 409 | `convex/lib/email/provider.ts` |

## Actions that need you

0. **Early-user offer is off until you switch it on** (docs/billing/README.md, "Switching the early-user offer on"): push `operate_early` to Autumn, then set `EARLY_OFFER=on` on Convex and `NEXT_PUBLIC_EARLY_OFFER=on` on Vercel.
In priority order. The first six are required before the first pilot company.

1. **Stripe webhooks (you've added one; confirm both).** Stripe Dashboard › the Selestial account › Developers › Webhooks. Confirm two live endpoints exist and are enabled: `https://stoic-gazelle-731.convex.site/webhooks/stripe-billing` (events `invoice.payment_failed`, `invoice.paid`, `invoice.voided`, `invoice.marked_uncollectible`, `charge.refunded`) and `https://stoic-gazelle-731.convex.site/webhooks/stripe` with "Listen to events on connected accounts" (payment intent, charge, refund, dispute and `account.updated` events). Copy each signing secret to the matching setting on `stoic-gazelle-731` (`STRIPE_BILLING_WEBHOOK_SECRET`, and the Connect webhook secret). Tell me which Stripe account it is; the one I could reach has neither.
2. ~~Decide the $199 offer~~ Decided (see "Decisions recorded"). Being built.
3. **Make a real test backend.** Follow `docs/foundation/06-deployments.md` "One-time setup": test keys for Stripe, Autumn and Resend, a development Clerk issuer, and `TEST_RECIPIENTS` set to your own email and phone. Give Vercel Preview that backend's address. This unlocks the sandbox runs and the signed-in walkthrough.
4. **Remove the duplicate DMARC record.** At your DNS host, `_dmarc.selestial.io` has two TXT records. Delete one, leaving a single `v=DMARC1; p=none; rua=mailto:<an inbox you read>`.
5. **Messaging charges: decided ON for all users.** Before switching, the Autumn catalog must hold the messaging balance (`cd billing && npx atmn push` preview, with Expand kept). Then approve the one step: set `MESSAGING_BILLING=on` on `stoic-gazelle-731`.
6. **Approve one live texting registration** for the first pilot company (Telnyx brand and campaign fees, one number), and confirm the controlled phone number to test with. I will not file or buy anything without this.
7. **Google Cloud › APIs & Services › OAuth consent screen:** report the publishing status and whether `gmail.readonly` verification has been submitted. If "Testing", add each pilot mailbox as a test user.
8. **Send real Indeed and ZipRecruiter application notifications** (3–5 each, with headers), following `docs/recruiter/07-real-samples.md`.
9. ~~Sales message reading~~ Decided: 1 credit. Set `BILLING_RATE_CARD=2026-11c` on `stoic-gazelle-731` (Convex Dashboard › Settings › Environment Variables).
10. **Uptime monitor:** in any uptime service, add an HTTPS check on `https://stoic-gazelle-731.convex.site/health` every 1–5 minutes, alerting a phone on any non-200 or timeout (`docs/operations/06-heartbeat.md`).
11. **Backups:** Convex Dashboard › `stoic-gazelle-731` › Backups: confirm a daily backup **including file storage** is on, then schedule the restore rehearsal with me.
12. **Privacy wording:** decided "both". Deletion is being built; take the gap list in `docs/operations/07-account-closure.md` to counsel for the retention wording.
13. **Branch protection:** GitHub › Settings › Branches › add a rule for `main` (settings in `docs/launch/release-checks.md`).

## Open issues carried forward

| Issue | Impact | Owner | Next action |
|---|---|---|---|
| Google tools connection trusts the state alone | A crafted link could attach another person's Google account to a company | Engineer | Apply the mailbox confirmation step to `convex/google.ts` |
| Rules-based agent work ignores the plan | A company with no plan keeps getting agent work while messaging charges are off | Engineer | Check the plan in each agent's sweep |
| Two recurring-plan systems | One client scheduled twice | Engineer | Make each check the other, then merge |
| Manual top-up refund not matched | Customer keeps refunded funds | Engineer | Confirm Autumn's invoice id in sandbox |
| No staff tool to clear and refile a rejected campaign | Staff fix it in Telnyx by hand | Engineer | Add after first live registration |
| Fees continue after plan end until number release | Balance goes negative for a departed company | Owner | Decide the policy |
| Cleaner photo upload loses progress on reload | Lost evidence on poor signal | Engineer | Keep pending uploads across reloads; test on real phones |
| `convex/lib/trust/exportTables.ts` describes `oauthStates` as holding nothing sensitive | It now briefly holds a sealed token (not exported) | Engineer | Correct the description |
| `src/lib/trust/register.ts` has a stale "No payment provider" row | Public trust page understates what is built | Owner | Approve corrected wording |
