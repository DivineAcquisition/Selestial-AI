# When the Selestial plan isn't paid

Decided by the owner on November 20, 2026: lock the account after two failed payment attempts, keep the
customers' side working, and cancel the plan after 30 days locked.

| When | What happens | Who is told |
| --- | --- | --- |
| 1st failed attempt | Nothing changes. A banner in the workspace shows the amount and the next try. | The Owner, by email (`plan_access`, "first_failure") |
| 2nd failed attempt | **Locked.** The team can't open the workspace and every agent is paused. | The Owner, by email ("locked"); staff see it under Staff › Unpaid plans |
| 23 days locked | Reminder that the plan is canceled in 7 days. | The Owner ("cancel_soon") |
| 30 days locked | The plan is canceled in Autumn (`cancel_immediately`). The lock ends; with no plan, agents still can't run. | The Owner ("canceled") |
| Paid at any point | Reopens at once. Agents go back to exactly what the Owner had paused before. | The Owner ("reinstated") |

The attempt count is Stripe's own `attempt_count`, so changing the retry schedule in Stripe's dashboard
doesn't change the rule: the lock follows the second real failure.

## What a lock does

- **Locked:** every company function refuses with `billing_locked`, except the few marked `whileLocked`
  (`billingLock.status`, `billing.openBillingPortal`, `billing.intent`, `billing.refresh`). The app shows
  the payment screen (`src/components/app/billing/locked.tsx`) instead of the workspace.
- **Paused:** all agents, through the company's own `pausedAgents`. Every place that honors a pause (the
  sending policy, permissions, each agent's work) honors the lock. The Owner's earlier choices are saved
  on the invoice's record and put back.
- **Still working:** booking pages, quote and payment links, the cleaner portal, delivery reports and the
  records. Nothing is deleted.
- **Admin Support Sessions** are not affected, so staff can still help.

The Owner sees the amount, the card issuer's reason, Stripe's hosted payment page ("Pay now"), "Update
card" (Stripe's billing portal) and "I've paid, check again". Everyone else sees who the Owner is. The
screen reopens on its own when the payment arrives, because the lock is read live.

## How Selestial learns about it

Stripe's signed events on Selestial's own account arrive at `/webhooks/stripe-billing`
(`STRIPE_BILLING_WEBHOOK_SECRET`): `invoice.payment_failed`, `invoice.paid`, `invoice.voided` and
`invoice.marked_uncollectible`. Only invoices for a subscription count; one-off purchases are paid on the
spot.

The company is found from the Autumn customer id (`company_<id>`) that Autumn puts on the invoice's or the
subscription's metadata, or, if it isn't there, on the Stripe customer (read with `STRIPE_SECRET_KEY`).
That id is then checked against Selestial's own billing record. An event no company can be found for
changes nothing and is kept in `billingWebhooks` as `stripe.<type>.unmatched` for staff.

## Setup (the Owner, in Stripe)

1. In Stripe › Developers › Webhooks, on the endpoint pointing at
   `https://terrific-avocet-835.convex.site/webhooks/stripe-billing`, tick `invoice.payment_failed`,
   `invoice.paid`, `invoice.voided` and `invoice.marked_uncollectible` (alongside `charge.refunded`). Create
   the endpoint if it doesn't exist, and put its signing secret in `STRIPE_BILLING_WEBHOOK_SECRET` on the
   live Convex backend.
2. In Stripe › Billing › Revenue recovery, keep at least two retries before Stripe gives up, and set what
   happens after the last retry to **leave the subscription past due** (not cancel it), so the 30-day
   cancellation here is the one that applies.

## Not verified against the real services

Tested against stand-ins (`convex/billingLock.test.ts`). Two things were not observed live:

- Where Autumn puts its customer id on Stripe objects. The code reads `autumn_customer_id`, `autumn_id` and
  `customer_id` from the invoice, subscription and customer metadata. If live events show up as
  unmatched, the metadata key is the thing to check.
- Autumn's `cancel_immediately` cancel action on `/v1/billing.update`.

## Staff

Staff › Unpaid plans lists locked accounts with the days left until cancellation. Staff holding
`billing.adjust` can lift a lock (paid another way, a mistake) with a reason, which is recorded.
