# Cancel subscription and retention offers

Built November 27, 2026. Code: `convex/cancellation.ts` (flow, offers, Stripe execution, report),
`convex/lib/billing/retention.ts` (rules and arithmetic), `src/components/app/billing/cancel-flow.tsx`
(the modal), `src/components/staff/cancellations.tsx` (staff report). Cancel and reactivate remain
`billing.cancelPlan` / `billing.resumePlan` in `convex/billing.ts`.

## Who owns what

| Concern | Owner | Notes |
|---|---|---|
| Which plan a company has, its period end, cancel at period end, reactivation | **Autumn** (`billing.update`: `cancel_end_of_cycle`, `uncancel`) | Unchanged. Selestial's copy is `billingAccounts`, refreshed by webhooks and syncs. |
| The early-user price | **Autumn** plan `operate_early` ($199), moved to `operate` at month 12 by `convex/earlyOffer.ts` | It is a separate plan, not a coupon, so a retention coupon cannot replace it. |
| Retention discounts | **Stripe**, on the subscription Autumn created | Autumn's API applies discounts only when a plan is attached (`billing.attach` `discounts`), and its customer record doesn't report them, so it can't apply and confirm a discount on an existing subscription. Owner's decision (Nov 27): use Autumn where it can, otherwise Stripe directly, confirmed by reading Stripe back. |
| Offer eligibility, terms, acceptance, the 12-month rule | **Selestial** (`retentionOffers`, `cancelFlows`) | One accepted offer per company in any rolling 12 months. |
| Agent and outbound entitlement after access ends | **Selestial**, at execution time | AI work: `billing.planCheck` at reservation. Outbound: `planOutbound` (metered) and `checkSend` (every agent message, including the company's own Gmail and Quo). |
| Confirmation emails | **Selestial** notice system, event `plan_subscription` | Sent only from Autumn's or Stripe's confirmed state. |

## The customer flow

Plan & Usage › Plan › **Cancel subscription** (Owner only; everyone else never reaches the billing page).
One dialog with steps. Closing it at any point changes nothing and accepts nothing; every step has a way to
cancel.

1. **What's making you consider leaving?** Eight reasons (stable codes in `CANCEL_REASONS`, words apart),
   an optional note. *Continue*, *Keep my subscription*, *Skip and cancel* (straight to confirmation).
2. **10% off one payment** (if eligible): the real next payment date, the normal price struck through, the
   discounted price, the saving, and the price after. Setup or reliability reasons also show an honest note
   and `support@selestial.io` (a discount doesn't fix those).
3. **What would need to change?** Six answers, optional note. "Nothing right now" goes to confirmation.
4. **15% off three payments** (if eligible): a dated schedule, the three-payment total, the saving, and when
   the normal price resumes.
5. **Cancel your Selestial subscription?** The plan, the paid-access end date, when agents stop, what
   happens to scheduled agent messages and work, how usage already incurred is handled, and what happens to
   data (see "What the confirmation says" below).
6. **Your subscription is canceled. You can continue using Selestial until [date].** Renewal is off;
   *Reactivate subscription* is right there and in Plan & Usage until the date.

Offers are alternatives. Accepting one ends the offer flow; the other can't be added.

## Rules (all enforced on the server)

| Rule | Where |
|---|---|
| Owner only | `ownerMutation` / `ownerQuery` on every function |
| Discount applies only to the recurring base price | Stripe coupon `applies_to.products = [the subscription's base product]`, `max_redemptions: 1` |
| Usage, credits, add-ons excluded | The coupon is limited to the base product, so it never discounts another line. Whether Autumn's one-off purchases could use up a `once` coupon is sandbox check 4 |
| Starts at the next renewal, current period untouched | `proration_behavior: none`; no invoice is created |
| One accepted offer per rolling 12 months | `accountProblem` → `used_recently` (failed offers don't count) |
| Viewing doesn't consume eligibility | Only `accept` writes a `retentionOffers` row |
| No stacking, no repeat acceptance, no two tabs | Accept is a serializable mutation; a pending offer blocks another (`in_progress`); the same flow gets its own offer back |
| Early-user expiration preserved, never restarted | The offer touches only Stripe discounts; `earlyOffers` and the Autumn plan are not changed |
| Price change during an offer | Each renewal is priced from its own scheduled base (`baseAt`): 15% of $299 after the early year ends. **Hidden** until verified (see blockers) |
| Existing promotions | Any discount already on the subscription → no offer (`existing_discount`). Nothing is ever removed or replaced. Re-checked in Stripe just before applying |
| Unsupported plans (annual, trial, custom, unknown price, several subscriptions) | No offer; cancellation works |
| Past due / locked | No offer ("your last payment didn't go through"); cancellation works |
| Already canceled / scheduled to cancel | No offer; the page shows *Reactivate subscription* instead of *Cancel subscription* |
| Scheduled plan change | No offer (`scheduled_change`); plan changes are refused while a discount runs |
| Money | Integer cents; percent rounded half up to the cent (`percentOf`). All the launch prices divide exactly |

Supported subscriptions: monthly `operate` ($299), `operate_early` ($199), `expand` ($499, legacy).

| Offer | $199 | $299 | $499 |
|---|---|---|---|
| 10% × 1 | $179.10 (saves $19.90) | $269.10 (saves $29.90) | $449.10 (saves $49.90) |
| 15% × 3 | $169.15 each, $507.45 (saves $89.55) | $254.15 each, $762.45 (saves $134.55) | $424.15 each, $1,272.45 (saves $224.55) |

## Preview and acceptance

The server reads Stripe (`loadFacts`: customer by Autumn's id in metadata, checked; the one live
subscription; its single non-metered base item) and computes each offer's preview: eligibility, offer id,
policy version (`retention-2026-11`), a fingerprint of the exact terms, renewal dates, base, discount and
subtotal per renewal, and when and at what price normal billing resumes. A preview is good for 15 minutes;
the dialog refreshes stale terms on its own.

`accept(flowId, offerId, version)` recomputes the terms from the stored facts and refuses if the fingerprint
differs ("the terms changed"). `applyOffer` then reads Stripe again: if anything changed (a new renewal date,
a price, a discount that appeared) the offer fails with `termsChanged` and the dialog shows the new terms for
fresh acceptance.

## Billing execution and reliability

`retentionOffers` row states: `pending → applied | failed`, or `unconfirmed` when Stripe didn't answer.

- Coupon: `POST /v1/coupons`, `Idempotency-Key: retention-coupon:<row id>`.
- Apply: `POST /v1/subscriptions/<id>` with `discounts[0][coupon]`, `proration_behavior=none`,
  `Idempotency-Key: retention-apply:<row id>`. Sent only when the subscription has no discount, so the list it
  sends replaces nothing.
- **Applied** only when Stripe's subscription, read back, carries the coupon. Then one confirmation email.
- Timeouts: retried after 1, 5, 15 minutes under the same keys; then `unconfirmed`, read hourly by
  `cancellation.sweep` (cron). A crash mid-way (pending > 30 min) is picked up the same way. After 2 days
  without confirmation it fails and shows in the staff report. A retry first checks whether the coupon is
  already on the subscription, so it can never apply twice.
- Cancel / reactivate: existing intents, idempotent by intent id; a second click or tab gets the in-flight
  request back. The dialog shows "canceled" only when Autumn's record has the end date.
- Webhooks: Autumn's (Svix-verified, deduplicated, re-read) and Stripe's `/webhooks/stripe-billing`
  (signature-verified). Invoice events for subscriptions with an applied offer are recorded once per event
  id. Out-of-order events can't reverse state: notices compare Selestial's copy before and after a fresh read
  of Autumn.
- Audit: events `billing.cancel_flow_*`, `billing.retention_offer_{viewed,declined,accepted,applied,failed}`,
  `billing.cancel_*`, `billing.uncancel_*`, `billing.cancel_scheduled`, `billing.reactivated`, each with
  the acting member or `system`.

## Agents after access ends

- Scheduling a cancellation changes nothing until the period end.
- At termination Autumn's record shows no plan. From then:
  - AI work is refused at reservation (`planCheck`, after a fresh sync), including jobs queued earlier;
  - every agent-originated message is refused at send time (`checkSend` → `no_plan`), including through
    the company's own Gmail or Quo, which the messaging balance never sees. It is refused, not held, so a
    later reactivation never replays stale campaigns or sends duplicates;
  - metered business messages are refused (`planOutbound` → `no_plan`).
- Still working: inbound provider callbacks, delivery reports, STOP/HELP answers, billing webhooks and
  reconciliation, people sending messages themselves, booking pages and records.
- Nothing is deleted. Numbers are not released and integrations are not disconnected: a plan that ends with a
  texting number opens a staff work item (`openPlanCancelledWork`), and only the Owner's own request
  releases a number.
- Usage before termination was paid from prepaid balances when it happened.
- Reactivating before the end removes the cancellation (`uncancel`): no new subscription, no charge.

### What the confirmation says (verified behavior)

Paid access until the period end, no further subscription charge; agents work until then and stop after;
agent messages and work planned for after that date won't be sent or run and aren't sent later; texts, email
and credits were paid from prepaid balances as used; unused messaging funds stay on the account, purchased
credits need an active plan; records stay in the workspace and can be exported or deleted from Settings; a
texting number isn't released automatically.

## Notifications

`plan_subscription` (account category, Owner, can't be turned off), each deduplicated by key:
`offer_applied` (payments and dates), `cancel_scheduled` (the last day of access), `reactivated`, `ended`
(skipped when the unpaid-plan flow already sent its own "canceled" notice). Each is re-checked against the
record when it goes, so a cancellation taken back in between sends no cancellation email.

Plan & Usage shows the active discount and discounted payments left, the next subscription payment (amount,
date, "discounted", plus tax, usage separate), the early-user end date (existing), and a scheduled
cancellation with its end date and *Reactivate subscription*.

## Reporting (Staff › Operations › Billing)

Flows started; reasons and needs with notes; skipped; eligible and why not; offers viewed, declined,
accepted, applied, failed; cancellations and reactivations confirmed or failed; failed billing operations;
discounts on paid invoices and subscription revenue collected after acceptance (Stripe's paid amounts, less
refunds), shown apart from projected discounted payments, which are labeled "not revenue"; and the share still
subscribed at 30, 60 and 90 days, with a note that this doesn't show whether a company would have left.

## Configuration

| Setting | Where | Purpose |
|---|---|---|
| `RETENTION_OFFERS=on` | Convex | Shows offers. **Off by default**: cancellation works without it. Turn on only after the sandbox checks. |
| `RETENTION_ACROSS_PRICE_CHANGE=on` | Convex | Allows offers that run past the end of an early-user year. Leave off until the month-12 check passes. |
| `STRIPE_SECRET_KEY` | Convex | Already used. Must be the same Stripe account Autumn charges through, test mode with Autumn's sandbox and live with production (a mismatch hides offers). Needs write access to Coupons and Subscriptions and read access to Customers (search), Invoices. |
| `STRIPE_BILLING_WEBHOOK_SECRET` | Convex | Already used. Add `charge.refunded` (already there) and the invoice events (already there). |

## Sandbox checks (required before `RETENTION_OFFERS=on` in production)

Never against live customers. On a non-production Convex deployment with `AUTUMN_SECRET_KEY=am_sk_test_…`
and `STRIPE_SECRET_KEY=sk_test_…` (not `terrific-avocet-835`, which holds live keys and forwards webhooks to
production):

1. Buy Operate ($299) with a test card. Accept 10%. Run
   `STRIPE_SECRET_KEY=sk_test_… node scripts/retention-sandbox-check.mjs <companyId> 26910`: the coupon is
   10%, `once`, limited to the base product; the preview total is $269.10.
2. Advance a Stripe test clock past renewal: the invoice shows $269.10 with $29.90 discount; the next preview is
   $299.00. Staff › Billing shows the discount and collected amount.
3. Repeat with 15% on Operate early ($199): $169.15 three times, then $199.00.
4. Buy a messaging top-up while a discount runs: it is charged in full (no discount on its invoice), and the
   `once` coupon is still on the subscription afterwards. **If a top-up consumes the `once` coupon, stop:**
   Autumn puts one-off purchases on the subscription invoice and the 10% offer must stay off.
5. Cancel from the flow: Autumn shows the end date; Stripe shows `cancel_at_period_end`; one email. Reactivate:
   no invoice, no new subscription.
6. Early-user crossing (only to enable `RETENTION_ACROSS_PRICE_CHANGE`): accept 15% with month 12 inside the
   three payments, advance through the month-12 move, and confirm the discount survives Autumn's plan swap and
   applies to the $299 product. If not, keep the switch off.

## Launch blockers

1. No sandbox run yet (this container has no Autumn or Stripe test keys, and the only deploy key points at a
   backend with live keys). Every flow is verified against the stand-ins only.
2. Unverified provider facts: where Autumn puts its id on the Stripe customer (`autumn_customer_id`,
   `autumn_id` or `customer_id`), whether Autumn's one-off purchases share the subscription invoice (check 4),
   and how the month-12 move treats an existing discount (check 6).
3. `RETENTION_OFFERS` stays off until checks 1–5 pass.

## Decisions (the Owner, November 27, 2026)

- **Setup and reliability reasons:** the discount is shown as usual, with no support note. Instead, one optional
  question beside the offer ("What made getting set up take so long?" / "What wasn't working reliably?"), or on
  the confirmation when no offer can be made. Stored as `cancelFlows.reasonDetail`, shown in the staff report.
- **Offers across the end of the early-user year:** allowed once sandbox check 6 passes; then set
  `RETENTION_ACROSS_PRICE_CHANGE=on`.
- **Sandbox checks:** the Owner runs checks 1–6 with `scripts/retention-sandbox-check.mjs` and reports the
  results. `RETENTION_OFFERS` stays off until then.
- **Privacy Notice:** change the wording rather than build automatic deletion. A cancelled plan keeps its records
  so the company can come back or export them. **Published** as Owner-approved version `privacy-2026-11-27`
  (the Owner chose to publish without waiting for counsel); `privacy-2026-11-16` stays listed unchanged:

  > A company's records: while the company has an account with Selestial, including after its plan ends, so it
  > can come back or export them. When the company's Owner asks us to delete the company, or its plan is
  > cancelled for non-payment, we delete its records within 90 days, except the records this section says we keep.
