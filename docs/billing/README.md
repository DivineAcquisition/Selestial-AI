# Plans, credits and billing

Selestial sells two monthly plans, **Operate ($299)** and **Expand ($499)**, through
[Autumn](https://docs.useautumn.com), with Stripe as Autumn's payment layer. Autumn is the authority on
which plan a company has and how many credits it holds. Selestial keeps the mapping and a read-only copy
of Autumn's record, plus one record per piece of AI work. It has no subscription engine and no credit
wallet of its own.

The code is in `convex/lib/billing/` and `convex/billing.ts`. The Owner's screen is Settings → Plan & Usage
(`src/components/app/settings/billing.tsx`).

Messaging (texts and business email, paid from a prepaid messaging balance) is described in
[03-messaging-billing.md](03-messaging-billing.md), with the phase 1 audit in [02-messaging-audit.md](02-messaging-audit.md).

## Status: what works and what is not configured

| Area | State |
|---|---|
| Plan catalog, agent and feature mapping | Built (`catalog.ts`). Mirrored into Autumn by `billing/autumn.config.ts`. |
| Reserve, execute, finalize for AI work | Built: Company Chat answers, Recruiter's AI reading of hiring email, Creative Studio generations. |
| Plan changes, cancellation, top-ups, billing portal, payment method | Built as Owner-confirmed intents against Autumn's attach, preview, update, portal and setup-payment APIs. |
| Spending controls, usage alerts, zero-balance notices | Built. Automatic top-ups are not built and cannot be switched on. |
| Autumn webhooks | Built: signed (Svix), deduplicated. The body only triggers a re-read from Autumn. |
| Public pricing, FAQs, in-app comparison | Built. No credit allowance is shown because none is approved. |
| **Verified against Autumn** | **No.** No Autumn or Stripe key exists in this environment. Every flow was verified against a stand-in that follows Autumn's documented API (`tests/fakeAutumn.ts`). |
| Live Autumn catalog | **Pushed** (November 16, 2026): plans, the credit feature and agent/feature flags. Nobody can buy yet: the app's billing code is not deployed. |
| **Production billing** | **Not ready.** The production rate card has no approved rates, and there has been no end-to-end sandbox run. The owner chose to deploy only once rates are approved. |

## Plans and what they include

| Department | Agent | Operate | Expand | Released today |
|---|---|---|---|---|
| Growth | Sales | Included | Included | No |
| Growth | Retention | Included | Included | No |
| Team | Recruiter | Included | Included | **Yes** |
| Operations | Dispatch | Included | Included | **Yes** |
| Growth | Marketing | — | Included when released | No |
| Operations | Quality | — | Included when released | No |
| Operations | Customer Care | — | Included when released | No |

"Released" is recorded in `agentReleased()` after checking what is implemented. Dispatch and Recruiter run
end to end; Recruiter's own owner screens are still to come. Quality's photo and video review and Marketing's
creative requests existed in Chat, but per the owner's decision of November 16, 2026, nobody gets them until
those agents are released.

Platform features that differ by plan (`PLAN_FEATURES`):

| Feature | Plan | Built |
|---|---|---|
| Creative Studio (image and video generation) | Expand (owner's decision: Marketing's work) | Yes |
| Advanced approval routing (agreements) | Expand | Yes |
| Agreement template governance | Expand | Yes |
| Customer portal | Expand | No |
| Advanced workflow customization | Expand | No |
| Advanced team and location governance | Expand | No |

Everything else is in both plans: Company Chat, the core records, scheduling and operational workflows,
cleaner text-message action pages (offer, acceptance, job, delay, evidence links, which are separate from the
customer portal), agreements storage and templates, AI-guided drafting (using credits), review and signature
workflows where built, reporting and activity history, and permissions, security and audit.

### The five checks

Each piece of agent work asks five separate questions, each with its own reason in the interface:

1. Is the agent released? A plan or a purchase never answers this one.
2. Does the company's verified plan include it?
3. May this person ask for it? Checked by the access builders, independently of billing.
4. Are there enough credits? Answered only by an Autumn lock.
5. Is what it needs connected?

Company Chat is held to the same rules. A specialist's tool is not offered to the model, and is refused if
called, when its agent is unreleased or outside the plan (`specialistBlock` in `convex/lib/chat/tools.ts`).

## Credits

One company-wide balance, **Selestial Credits**, shared by Chat and every entitled agent. It is an Autumn
metered feature, `selestial_credits`, with a monthly included grant per plan. Credits reset each billing
period and do not roll over. Prepaid top-ups use a one-off add-on plan, `credit_top_up`.

A credit is defined AI work. It is not a token, not money, and not a promise of a business result.

| Category | Treatment |
|---|---|
| Platform actions without AI (opening or answering a cleaner link, accepting a job, viewing records, status changes, scheduled reminders, document indexing) | No credits |
| AI work (the rate card) | Selestial Credits |
| Texts, calls, other outside services | Measured separately in `messages`. Never converted into credits. Pricing not set. |

### The rate card (`convex/lib/billing/rateCards.ts`)

Each task defines exactly one billable unit, for example "one completed Chat response within the response
limits" or "one hiring email read by the AI reader". A batch is charged per completed unit. Internal model
calls, tool uses and retries are never charged separately.

Cards are versioned and never edited after they are published. Each execution stores the card version and
the rate per unit, so completed work is never repriced.

| Card | Use |
|---|---|
| `fixture-2026-11` | Test values for Autumn's sandbox. Refused with a live key. Labelled "test values, not prices" in the interface. |
| `2026-11` | The production card, **approved November 16, 2026**: standard Chat answer 1, premium-model Chat answer 5, hiring email read by AI 1, generated image 20 (standard quality, 1024 × 1024), edited image 15 (1024 × 1024), generated video from 200 (exactly 200 for a 6-second clip at standard resolution and default audio; other lengths have no published price and cannot run). Shown to the Owner in Usage → "What costs credits?", not on the public site. |

Tasks wired today: `chat_response_standard`, `chat_response_advanced` (models in the "Higher cost" class),
`hiring_message_reading`, `image_generation`, `image_edit`, `video_generation`, and `research_brief` (one Services &
Pricing research brief: up to 5 web searches and one written brief, under the work source `services`).

Card `2026-11b` is the `2026-11` rates unchanged plus `research_brief` at 10 credits, approved by the owner on November
16, 2026. Research briefs run only once `BILLING_RATE_CARD` is set to `2026-11b`; under `2026-11` they have no rate and are
refused with that reason. `2026-11` lists `research_brief` as null because the task did not exist when it was approved.

Defined but not wired, because the work is not built yet: `applicant_evaluation`, `follow_up_draft`,
`dispatch_exception_analysis`, `retention_assessment`, `agreement_draft` (today, AI-guided drafting is a
Chat answer), and `campaign_generation`.

## The execution lifecycle (`executions.ts`, `reserve.ts`, `billing.ts`)

1. **Authenticate.** The access builders establish the company and member. Autumn's customer id is
   `company_<companyId>`, derived on the server, never taken from a request.
2. **Check (open).** Release, plan, price and spending controls are checked in the same mutation that asks for
   the work, and one `aiExecutions` row is written, keyed so that asking twice opens one execution. The
   caller checks the person's role and the work's prerequisites.
3. **Price.** Credits are the rate times the units, from the card in force.
4. **Limits.** The per-run limit (`needs_authorization`) and the monthly budget for automatic work (`budget`)
   are checked in the same transaction.
5. **Reserve.** An action refreshes the copy of Autumn's record if it is stale, checks the plan again, then
   calls `POST /v1/balances.check` with `send_event` and a `lock` (`lock_id` = execution and attempt,
   `expires_at` always set, `Idempotency-Key`). Only an HTTP 200 that is `allowed` for this customer counts.
6. **Run** the work. **Persist** the output.
7. **Finalize.** Exactly once: `confirm` with `override_value` set to the completed units times the stored
   rate, or `release` when nothing was completed.

Recovery, every 5 minutes (`billing.sweep`):

- A hold recorded but never answered (a crash between steps) is released.
- Work that held credits and never reported back is marked expired; Autumn returns the credits at the lock's
  expiry.
- Due settlements are retried with backoff (1, 5, 15, 60, 180, 360 minutes). A failed settlement is retried on
  its own: the work and anything it did are never repeated.
- Settlement results:
  - A replay (409) counts as settled.
  - A lock that has gone (expired) means the work stays done and is recorded `unbilled`.
  - A 202 accepted while degraded is recorded `unverified` for reconciliation.

How each flow ends:

- **Chat:** an answer that finished, or is waiting on the person, is charged one unit; a failed or stopped
  answer releases its hold. The lock lasts 15 minutes.
- **Recruiter:** each hiring email the AI reader opens is one unit. Without a verified hold (no plan, no credits,
  billing unreachable, budget used), that email is read by the rules instead, so no application is dropped.
- **Creative Studio:** charged per image or video delivered; the rest of the hold is released. A job with no
  output is not charged, even when the provider may have billed Selestial.

## Outages and fail-open

Autumn's SDK, `autumn-js` 1.6.12, fails open by default. On a 5xx, a timeout or a network error its `check`
answers `allowed: true`, and it hides the HTTP status. Autumn's server can also answer **202 "allowed
fail-open"** on check and finalize. Paid AI work must never start on that, so `autumn.ts` calls the
documented REST API directly (version 2.6.0) and classifies every answer:

| Answer | Treatment |
|---|---|
| 200 | Verified. |
| 202 on check or finalize | Not verified. On check, the work does not start and any hold is released at once. On finalize, it is recorded `unverified`. |
| 5xx, 429, timeout, network | Unavailable. New AI work pauses ("billing could not be checked"). Settlement retries. |
| 409 | An Idempotency-Key replay: already done. |
| Other 4xx | Refused. |

During an outage, everything that does not use AI keeps working, because tenant isolation and roles never
call Autumn. New paid work needs a verified hold.

## The Plan & Usage page

Settings → Plan & Usage has three tabs. The credit indicator in Company Chat links the Owner to Usage.

- **Plan:** the current plan, renewal and pending changes, upgrade, downgrade and cancel, and the comparison
  of the two plans.
- **Usage** (`src/components/app/billing/usage.tsx`, data from `convex/billingUsage.ts`):
  1. **Overview:** available, used this cycle, reserved for running work, and the next reset with the monthly
     allowance. Monthly credits have a progress bar; purchased credits are kept separate. Buy credits and
     Manage spending come first, Change plan second.
  2. **Usage over time:** a daily chart, current cycle by default, with previous cycles, custom dates, a
     breakdown by agent or by action, an optional comparison line, and a table view. A forecast appears only
     with at least 7 days of the cycle and 14 days of use, marked "Estimate".
  3. **Where credits went:** by agent and by action, with completed units, credits and share. Company Chat is
     listed; agent work asked for in Chat counts once, under the agent, with Chat as its origin.
  4. **Work delivered:** real completed counts, each linking to its work.
  5. **Activity and credit history:** a searchable, filterable table of AI work (opening a row shows the
     estimate and final charge, the rate card, every step of the charge and why it changed). Balance history
     (monthly renewals, purchases, adjustments) is a separate view, from Autumn's ledger.
  6. **Spending controls:** a hard maximum per piece of work, an approval threshold, a monthly budget for
     automatic work, budgets per agent, a low-balance alert and usage alerts. Alerts only notify; hard limits
     pause that kind of AI work and nothing else. Automatic top-ups stay off and are not available.
  7. **What costs credits?:** the published rates, with model and setup for media, and what is free.
  8. **Texts, email and calls:** counts in their own units, never in credits.
- **Billing:** buy credits (when top-ups are on sale), the payment method, the billing portal and invoices.

While the copy of Autumn's balance is missing, failed to refresh or is older than 15 minutes, the page shows
"Updating usage" instead of a number. Company-wide spending details are the Owner's only.

## Plan changes, top-ups, cancellation

Each one is an intent (`billingIntents`). The Owner starts it, Autumn's `preview_attach` gives the price and
effective date, and the Owner confirms that exact charge (valid for 30 minutes). Then `billing.attach` runs
with `Idempotency-Key: intent:<id>`. Nothing is shown as changed until Autumn reports it, by webhook or
refresh.

- **Upgrade:** immediate, prorated, with the actual charge shown first. It takes effect after Autumn confirms
  payment (`enable_plan` defaults to `on_payment`).
  - **Credit policy:** `carry_over_usages` on `selestial_credits`. Credits used this cycle still count against
    Expand's allowance, so moving plans back and forth can never hand out a fresh allowance.
- **Downgrade:** scheduled for renewal (`end_of_cycle`).
  - The preview lists the agents and features that will be lost.
  - Records, completed work, signed agreements and portal data are kept.
  - Work already reserved before the boundary finishes. New work is checked against the new plan.
- **Cancel:** `cancel_end_of_cycle`. Paid access continues to the end of the period. "Keep this plan"
  (`uncancel`) reverses a pending cancellation or a scheduled change.
- **Top-ups:** offered only when `BILLING_TOP_UP_PACKS` is set.
  - Both plans can buy them, and they need an active plan.
  - Credits are granted only after verified payment; a missing card returns a Stripe payment page and no
    credits.
  - A top-up never changes agent access. Automatic purchase is off and cannot be enabled yet.
  - **Disclosed policy:** included credits are used first, then purchased credits (Autumn's default order).
    Purchased credits do not reset or expire on a date, and can be used only while there is an active plan.

## Required configuration

**On the Convex deployment** (names only; nothing is set by this work):

| Setting | Purpose |
|---|---|
| `AUTUMN_SECRET_KEY` | `am_sk_test_…` (sandbox) or `am_sk_live_…` (production). Unset: AI work is paused (the owner's decision). |
| `AUTUMN_WEBHOOK_SECRET` | Svix signing secret of the Autumn webhook pointed at `https://<deployment>.convex.site/webhooks/autumn` |
| `BILLING_RATE_CARD` | `fixture-2026-11` (sandbox) or an approved production card |
| `BILLING_TOP_UP_PACKS` | Top-up sizes in credits, e.g. `500,2000`. Unset: no top-ups |

Sandbox and production are separate Autumn environments with separate keys. Selestial keys its records by
environment (`billingAccounts.env`), so sandbox data never counts in production.

**In Autumn and Stripe:**

1. Create the Autumn organization and connect Stripe in sandbox mode.
2. Push the catalog:

   ```
   cd billing && set -a && . ./sandbox.env.example && npx atmn push
   ```

   This creates `selestial_credits`, the `operate` and `expand` plans (group `selestial`), boolean agent
   and feature flags, and `credit_top_up`.
3. Create a webhook to `/webhooks/autumn` for `billing.updated`, `balances.limit_reached`,
   `balances.usage_alert_triggered` and `invoice.finalized`.
4. Configure the Stripe customer portal (payment methods, billing contact, invoices).
5. Before anything goes live:
   - Ask Autumn to block access for past-due subscriptions (`blockOverdueEntitlements`), or confirm that
     keeping access while past due is acceptable. The default keeps access.
   - Decide `reset_usage_when_enabled` for the credit item (its default is not documented).
6. Run the sandbox end to end (below), then repeat with live keys and approved values.

## Outstanding commercial values (not approved; nothing invented)

- ~~Monthly credit allowances~~: **approved November 16, 2026: Operate 5,000, Expand 10,000.** Pushed to
  Autumn's live catalog that day (`SELESTIAL_OPERATE_CREDITS=5000 SELESTIAL_EXPAND_CREDITS=10000`; no
  top-up plan, since top-ups are not approved). Read back from Autumn: `operate` $299/month with 5,000
  credits and `expand` $499/month with 10,000, both resetting monthly, in group `selestial`.
- ~~Production rates~~: approved November 16, 2026 (see the rate card above). Still unpriced: video lengths other than 6 seconds, image sizes other than 1024 × 1024, the fast image model, and the tasks not built yet.
- Top-up sizes and price per credit (`SELESTIAL_TOP_UP_PRICE`, `SELESTIAL_TOP_UP_UNITS`,
  `BILLING_TOP_UP_PACKS`).
- Whether purchased credits should ever expire. Autumn documents no expiry for one-off top-ups.
- Default usage alert thresholds (the app's defaults are 50, 80 and 100% until set) and default automatic
  budgets.
- Pricing for texts, calls and other outside services.
- Policy for past-due subscriptions.

## Sandbox verification

- **Real sandbox:** not run. No Autumn or Stripe key was available in this environment, so no request
  reached Autumn.
- **Stand-in:** `convex/billing.test.ts` runs every flow against `tests/fakeAutumn.ts`, which follows the
  documented API. It covers:
  - company isolation and Owner-only access; the customer id derived on the server
  - plan restrictions in the UI data, backend (Agreements, Creative Studio), Chat tools and background work
    (Recruiter)
  - a hold before work, exactly one confirm, and a repeated settlement asking Autumn nothing
  - no overspend: two answers on one credit
  - duplicate executions, partial batches, failed and stopped answers, crashed and abandoned holds, and a
    finalize after expiry
  - Autumn unreachable, failing (5xx) or answering 202 on check; a settlement retried after an outage; a
    degraded finalize
  - not connected, a live key with test rates, and unapproved rates
  - upgrade preview, confirmation, carried-over usage and a duplicate confirmation; a scheduled downgrade
    with what is lost; cancel and keep
  - top-ups off by default, payment required before credits, and an idempotent purchase
  - zero balance: notice and pause, nothing auto-bought, and Recruiter still filing by rules
  - signed, deduplicated webhooks that cannot grant by what they claim
  - spending controls and usage alerts
  - retired plans granting nothing
- `billing/autumn.config.ts` type-checks against `atmn` 2.0.252's own types. It has not been pushed.

## Migration

- **Paying customers:** none. No payment provider was connected before this work, so no subscription exists
  to migrate, and no provider product id was renamed.
- **Retired plans:** `companies.plan` held Growth or Scale, set by Selestial staff. Those set Chat and
  generation allowances and were never charged. They now grant nothing, and only Autumn's verified plan
  (`operate` or `expand`) is written there.
  - Run `npx convex run billing:clearLegacyPlans` once to clear them; each one clears with an event.
  - The staff "change plan" control is removed.
- **Early companies:** if any should keep access, put them on Autumn plans deliberately (a
  commercial decision). Growth maps to Operate and Scale to Expand.
- **Chat's monthly answer caps** (300 or 1,000) are replaced by credits. `CHAT_MONTHLY_RUNS` remains an
  emergency cap.
- **Creative Studio's monthly caps** are now a provider-cost ceiling (150 images, 15 videos), with credits
  as the main limit.

## Early-user offer

The Owner's terms of November 22, 2026: **$199 a month for the first 12 months, for the first 15 companies
whose first plan payment succeeds, then $299.** No trial. Code: `convex/lib/billing/earlyOffer.ts` (the rule),
`convex/earlyOffer.ts` (sweep, month-12 move, Owner and staff views).

**Why a separate plan, not a coupon.** Autumn rewards (coupons with `duration: { type: "months", length: 12 }`,
applied through `discounts` on attach) would also work, but the customer record Selestial reads does not
report discounts, so the app could not check from Autumn's record that $199 is what is billed, and a Stripe
promotion code could leak. A plan id is on every subscription and invoice (`plan_ids`), so what Autumn holds
and what the app shows are the same fact. `operate_early` is in the same group (`selestial`) with the same
items as `operate`; `planIdFromAutumn` maps it to `operate`, so every entitlement check is unchanged.
`billingAccounts.autumnPlanId` keeps the real id for prices, cancellation and the switch.

**The rule, exactly.**

1. *Preview.* An Owner with no plan, whose company has no paid invoice and never held a place, opens the
   purchase while fewer than 15 places are used: the intent is marked `offer: "early"` and previewed as
   `operate_early`. Otherwise it is `operate` at $299. Previewing reserves nothing.
2. *Confirm.* `confirmIntent` reserves a place. Convex mutations are serializable, so this is the one point
   where two companies racing for the last place are decided. The loser's purchase is **not sent**; it is
   previewed again at $299 with "The last early-user place was just taken…", and the Owner confirms again.
   Nobody is attached at $199 without a place, and nobody is charged a price they were not shown.
3. *Pay.* The place is **claimed** when `storeAccount` sees `operate_early` active on Autumn's record (after the
   attach, a webhook or a refresh). The 12 months count from the subscription's `started_at`.
4. *Fail or abandon.* A refused purchase releases its place at once. A payment page that is never paid keeps the
   place for 24 hours (`RESERVE_MS`, the payment page's lifetime), then the hourly sweep releases it.

Used places = claimed + ended + reservations not yet expired. "15" is 15 ever granted: a cancelled company's
row becomes `ended` and still counts, and that company is quoted $299 if it returns. A payment Autumn reports
for `operate_early` is always honored, even after a reservation was released.

**The data.** `earlyOffers`: one row per company and environment, states `reserved → claimed → ended`, or
`reserved → released`. It holds `offerEndsAt`, the month-12 move (`switchRequestedAt`, `switchConfirmedAt`,
`switchAttempts`, `switchProblem`) and `reminderSentAt`. `billingIntents.offer` marks a $199 purchase.

**Month 12.** In the 12th billing period (Autumn's period end within a day of `offerEndsAt`), the hourly sweep
attaches `operate` with `plan_schedule: "end_of_cycle"` under the key `early-switch:<row>:<attempt>`, then reads
Autumn back; the move counts only when the scheduled `operate` subscription is on the record. Refusals are
retried after 1, 3 and 6 hours under a new key. From 7 days before month 12 ends (or at once on a failure),
an `early_offer_switch` incident is open for staff; after month 12 it is critical. The Owner cannot undo the
move (`resumePlan` refuses it). After the period ends Autumn bills $299 and the row becomes `ended`.

**The reminder.** About 30 days before `offerEndsAt`, once: an in-app notice on Plan & Usage (`price_change`)
and one email (`plan_price_change`, Account category, owner audience; Selestial's own mail, never the messaging
balance), each with the date and $299. Keyed so it is planned once however often the sweep runs; not sent if
the plan is ending.

**What staff can do.** Staff › Operations › Billing shows places used of 15, each company, when it moves to
$299 and whether that is on Autumn's record. A staff member with `billing.adjust` can release a place that was
reserved and never paid, with a reason. A claimed place can never be released.

**Not yet exercised against Autumn** (each is also marked in the code):

- That `plan_schedule: "end_of_cycle"` holds back an attach that is an upgrade by price (Operate after
  `operate_early`) until the period ends. The API reference lists the field; the lifecycle guide only
  describes the default (upgrades immediate). If Autumn ignores it, $299 would be charged early: verify first.
- That the scheduled plan shows as a `scheduled` subscription with `plan_id: "operate"`.
- That `started_at` is the start of the first paid period, and that monthly periods stay anchored to it.
- That a plan becomes `active` only on payment (`enable_plan` default `on_payment`).
- That Stripe Checkout pages Autumn opens expire within 24 hours.
- That `billing.update` cancels by `plan_id: "operate_early"`. The unpaid-plan cancel in
  `convex/billingLock.ts` still passes `account.plan` ("operate") and should pass `account.autumnPlanId ?? account.plan`.

**Before it can go live (Owner):** run `cd billing && npx atmn push` against the sandbox with the approved
credit values (the config keeps `operate` and `expand`, and adds `operate_early`), check in the Autumn
dashboard that `operate_early` is $199/month, in group `selestial`, with no trial and Operate's items, run one
purchase, a month-12 move (advance the test clock) and a cancellation, then push to production.

## Known limits

- Plan access in mutations reads Selestial's copy of Autumn's record. It is refreshed by webhooks, by the
  Owner's "check again", and before each reservation when older than 10 minutes, so a webhook delay can
  briefly show an old plan. Reservations always decide on a fresh copy.
- Whether `balances.check` with a lock but no `send_event` is valid is not documented. Selestial always sends
  both.
- A reused `lock_id` is not documented; every attempt uses a new one.
- How `override_value` behaves above the held amount is not documented; Selestial never exceeds the hold.
- Work longer than its hold (15 minutes for Chat, 3 hours for video) completes but is recorded `unbilled`.
- "Credits held for work in progress" is Selestial's own sum of open holds. Autumn's balance may or may not
  already subtract them.
- Usage by period uses the reset date from Autumn's balance. Before the first sync it falls back to the
  calendar month.
- Automatic top-ups, outside-service pricing and the Expand customer portal are not built.
- The landing page's pre-existing agent copy describes Sales and Retention in the present tense. The pricing
  section labels them unreleased; the rest of that page was left as it was.

### Switching the early-user offer on

The offer is **off by default**, so merging the code changes nothing a customer sees or pays. While it is off,
every company is offered Operate at $299, no screen mentions $199, and the public pricing card has no offer box.
Places already held keep working (claims, the month-12 move and the reminder still run).

To switch it on, in this order:

1. `cd billing && npx atmn push` against the sandbox, then against production. The config keeps `operate` and
   `expand` and adds `operate_early`. Check in the Autumn dashboard that `operate_early` is $199/month, in group
   `selestial`, with no trial and Operate's items.
2. Convex Dashboard › `stoic-gazelle-731` › Settings › Environment Variables: `EARLY_OFFER` = `on`.
3. Vercel › selestial-ai › Settings › Environment Variables: `NEXT_PUBLIC_EARLY_OFFER` = `on` (Production), then
   redeploy so the public pricing card shows the offer.

Switching off is the reverse (step 2 alone stops new places at once; step 3 removes the public line).
