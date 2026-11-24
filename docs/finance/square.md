# Finance › Square

Each cleaning company can connect **its own Square account** and collect customer payments for its
Selestial invoices through it. Square sits beside Stripe inside Finance: the same invoices, payments,
refunds, credits, confirmations, reminders and history. There is no second dashboard and no second
ledger. Selestial's own subscription (Autumn) is unrelated and never touches these records.

## Phase 1: audit and decisions (November 24, 2026)

### What was there

- **Finance** (`docs/finance/00-plan.md`) is built around one provider:
  - **Stripe Connect:** each company has its own account (`stripeAccounts`). Payments are direct
    charges, and Selestial takes no fee.
  - **Invoices** (`invoices`) are authoritative and derive their states.
  - **Payments** (`payments`) hold a `stripe` block. `refunds` and `invoiceCredits` are kept separate,
    so a cash refund and a credit note never mix.
  - **Confirmation previews** carry a fingerprint (`confirm.ts`), and money questions are Owner-only
    (`authority.ts`).
  - **One request key per record:** an unclear answer marks the record "checking". It is never retried
    under a new key.
  - **Webhooks only point:** `/webhooks/stripe` dedupes on `providerReceipts` and reads the object back.
  - **Reconciliation:** a cron reconciles every 10 minutes.
  - **Pay page:** the branded pay page (`/c/pay/<token>`, `convex/pay.ts`) uses Stripe's Payment
    Element.
- **Online booking** (`convex/lib/booking/payments.ts`) makes an ordinary Finance invoice and pays it
  through the same `payments` rows.
- **Chat (Owner)** can list unpaid invoices, explain one and draft reminders. Refunds and credits stay in
  Finance's confirmations.
- **OAuth precedent:** Google, Jobber and HighLevel. Tokens are sealed with AES-GCM under
  `MAILBOX_TOKEN_KEY` (`convex/lib/recruiter/secrets.ts`). States are hashed, one-time and expiring.
  Because a callback carries no session, Google's authorization is held and confirmed by the signed-in
  member who started it.
- **Square catalog card:** "planned". It advertised tap to pay and invoices, which were not built.

### The configured credentials (names only)

| Setting on Convex Production | What it is | How Selestial uses it |
|---|---|---|
| `SQUARE_APPLICATION_ID` | A **production** application ID (`sq0idp-` form) | The OAuth `client_id` |
| `SQUARE_ACCESS_TOKEN` | A production access token. Square gives no format rule that tells a personal token from one merchant's OAuth token, and either way it acts as **one** Square account | **Not used.** It is never a stand-in for a company's authorization. It is not needed and can be removed |

Missing for the multi-company flow:

- `SQUARE_APPLICATION_SECRET` (the code flow needs it).
- `SQUARE_WEBHOOK_SIGNATURE_KEY`.

Present and reused: `MAILBOX_TOKEN_KEY`, the token encryption key. There are no Sandbox credentials on
any deployment yet.

### Decisions

| Question | Decision |
|---|---|
| Authorization | Square OAuth **code flow** (a server app with a secret), one authorization per company. Refresh tokens don't expire and aren't rotated (Square docs); access tokens last 30 days. Selestial refreshes when 7 or fewer days remain, and daily checks keep that true |
| Permissions | `MERCHANT_PROFILE_READ`, `ORDERS_READ`, `ORDERS_WRITE`, `PAYMENTS_READ`, `PAYMENTS_WRITE`. Nothing for customers, fees, devices or catalog |
| Environment | Taken from the application ID: `sandbox-sq0idb-` is Sandbox, `sq0idp-` is Production. A deployment that is not production never uses a Production application ID (as with live Stripe keys). Connections are stored with their environment and never cross |
| Confirm the merchant | The callback has no session, so nothing is connected there. Tokens are sealed and held on the one-time state. The signed-in Owner who started sees the Square business and confirms it; unconfirmed, the hold is discarded after 15 minutes |
| Same Square account, two companies | Refused at confirmation. Access is never shared |
| Checkout | Square's **hosted checkout (payment links)**. It meets every invoice requirement, so card data never touches Selestial. See below |
| Ledger | Selestial's invoice stays authoritative. A Square payment link carries one Square order made for that one payment attempt (the amount, plus the tip as its own line). No Square invoice is ever issued |
| Provider for new requests | One preferred provider per company (`financeSettings.paymentProvider`, absent meaning Stripe). Switching is refused while any payment or refund is processing or being checked. Unfinished checkouts on open invoices are closed as part of the switch, and the preview lists them first. Existing payments keep their provider forever |
| Money | Whole cents in USD, as Finance already requires. Only an active USD location with card processing can be chosen |
| Deferred and not advertised | Tap to Pay, terminals, card on file, recurring charges, QuickBooks, platform fees, Square invoices, Square disputes (handled in Square's Dashboard) |

### Why hosted checkout (payment links)

- **Amount:** `CreatePaymentLink` with an `order` fixes the amount server-side, and the buyer cannot
  change it.
- **Partial payments and deposits:** the amount is chosen on Selestial's page under the existing rules,
  then a link is made for exactly that amount.
- **No surprise charges:** `pricing_options.auto_apply_taxes` and `auto_apply_discounts` are false and
  `allow_tipping` is false, so Square adds no tax, discount or tip. The tip the customer chose on
  Selestial's page is its own line.
- **One use, then closed:** a link is single-use. `DeletePaymentLink` cancels its order, so a stale link
  can't collect after the invoice is settled or voided.
- **Card data:** handled by Square only. Payment methods are card, Apple Pay and Google Pay.
  - Bank transfer (ACH) is switched off: it settles over days.
  - Afterpay and Cash App Pay are switched off: they are payment methods Selestial doesn't present yet.
- **Return to Selestial:** the redirect goes back to the pay page. A redirect proves nothing. The order
  and its payments are read back from Square with the company's own token.

The SDK route (the Web Payments SDK plus server-side `CreatePayment`) would bring card fields into
Selestial's page and more PCI surface, for no behaviour the invoice needs.

## Phases 2 to 6: what is built (November 24, 2026)

### How it fits together

```
Finance › Payments setup ── Connect Square ──► Square's authorization page (code flow, 5 permissions)
        ▲                                              │ ?code&state
        │ confirm the business (signed-in Owner)        ▼
        └──── /app/finance/setup?square=confirm ◄── GET /oauth/square/callback
                                                       (state: hashed, one use, 10 minutes; code exchanged
                                                        on the backend; tokens sealed to the state and held 15 minutes)
squareConnections (sealed tokens, merchant, locations, chosen location; one live per company and environment)
        │ choose an eligible location → ready      │ refresh ≤ 7 days before expiry (lease + version)
        ▼                                          ▼
/c/pay/<token> or an online booking ── start ──► payments (source "square") ── CreatePaymentLink (key sel-<payment id>)
        ▲  ?square=<payment id> (proves nothing)     │ order: the amount (+ the tip line), no Square tax/discount/tip
        │                                            ▼
        └── read back: RetrieveOrder → its tenders → GetPayment ◄── POST /webhooks/square (signature, dedupe,
                                                                     merchant → company) and the 10-minute sweep
refunds (source payment's provider) ── RefundPayment (key = refund id) ── refund.* webhooks, dashboard refunds recorded
```

| Area | Where |
|---|---|
| Square client: configuration, OAuth, locations, checkout, orders, payments, refunds, signature, event parsing | `convex/lib/finance/square.ts` |
| Connection state for pages (`unavailable`, `not_connected`, `needs_location`, `ready`, `needs_reconnect`, `disconnected`) | `convex/lib/finance/squareState.ts` |
| Which provider takes new payments, and whether it is ready (pay page, booking, readiness) | `convex/lib/finance/provider.ts` |
| Connect, callback, confirm, locations, refresh, revoke, disconnect, daily sweep | `convex/financeSquare.ts` |
| Checkout attempts, read-back, closing links, refunds, webhooks, reconciliation, losing access | `convex/financeSquarePay.ts` |
| Provider switch with a preview, Square-aware findings, fees, refund previews | `convex/finance.ts`, `convex/lib/finance/findings.ts` |
| Pay page and online booking | `convex/pay.ts`, `convex/lib/booking/payments.ts`, `src/components/pay/pay-page.tsx`, `src/components/booking/step-finish.tsx` |
| Setup UI | `src/components/app/finance/square-setup.tsx` (in Finance › Payments setup) |
| Connected apps card | `src/lib/app/integrations.ts`, `convex/integrations.ts` |
| Chat (Owner) | `explain_invoice` shows each payment's provider, receipt and fee (unknown until reported); `check_payment_status` asks the provider again about payments in flight |
| Contract tests | `convex/financeSquare.test.ts` against `tests/fakeSquare.ts` |

### Rules the code keeps

- **Who.** Only the Owner holds Finance capabilities, as before. Connecting, choosing a location,
  switching providers and disconnecting need `edit`; refunds need `issue_refunds` and the existing
  fingerprinted confirmation. Support access can't connect or disconnect. Agents read, and can ask a
  provider to re-check: they never see a token, choose a merchant, change an amount or refund.
- **Amounts.** The pay page and booking take the amount from the invoice (`amountRequested`): the deposit
  while one is outstanding, otherwise the balance, or a part of it when the company allows partial
  payments. The browser's figure is only checked against that, never used to raise it.
  - **Minimum:** Selestial asks for at least $1.00 through Square.
  - **Tips:** a tip is its own line on the Square order and is the crew's, as with Stripe.
- **One attempt at a time.** A payment is keyed by the browser's key, so a double click is one attempt.
  - **Starting again** closes the previous unfinished checkout: the link is deleted, which cancels its order.
  - **Paying, voiding or switching providers** closes every unfinished checkout.
  - **A checkout left open a day** is closed by the sweep.
- **Uncertain answers.**
  - **Lost checkout or refund answer:** the record is marked "checking" and the request is asked again
    with the same key.
  - **After 23 hours:** a checkout is looked up by its marker and a refund by the payment's refunds,
    instead of being made again.
  - **Never** a new key and a second charge.
- **Confirmation comes only from Square.**
  - **The redirect** only triggers a read.
  - **Webhooks** are pointers: the payment is read with the company's own token, and must belong to that
    attempt's own order at its own location.
  - **Received money is never moved backwards.** A payment on a checkout Selestial had closed still
    counts, and an overpayment shows on the invoice for the Owner to refund.
  - **A different amount, or a second payment on one checkout,** is flagged "check in Square".
- **Counting once.** Invoice totals are recomputed from rows, so a webhook and the sweep reporting the
  same payment count it once. Reminders stop on their own once the invoice is paid.
- **Fees.** Square's processing fee is stored when Square reports it. Until then it shows as unknown,
  never zero.
- **Matching.**
  - **Unknown Square account:** an event for a Square account no company connected is noted for
    Selestial's team (operations signals), never matched.
  - **Other sales:** a payment the business took elsewhere in Square matches no invoice and is left alone.
- **Losing access.**
  - **What triggers it:** `oauth.authorization.revoked`, a refused refresh, or a 401.
  - **The Owner sees:** "Reconnect Square to accept new payments", with how many checkouts were open.
  - **Reconnecting the same account** reads those checkouts again.
  - **Disconnecting** is refused while a Square payment or refund is being confirmed. Otherwise unfinished
    checkouts are closed and read back, the grant is revoked, and the sealed tokens are cleared.
- **Records.** Payments keep their Square payment, order, checkout-link and location IDs, the receipt
  link, the method ("Visa ending 1111") and the fee. Refunds keep Square's refund ID. A refund made in
  Square's Dashboard is recorded as "Refunded in Square". A credit is always a separate, Owner-confirmed
  record.

### Provider switch rule

New payment requests, and the pay links customers already have, use the company's chosen provider
(`financeSettings.paymentProvider`).

- **Switching is refused:**
  - while any online payment is processing or being checked;
  - when the new provider isn't ready (Square connected with an eligible location, or Stripe active).
- **Unfinished checkouts are closed by the switch.** The preview counts them first.
- **Nothing silently falls back.** A company on Square whose connection needs attention can't be paid
  online until it is fixed or the Owner switches.

## Tests

`convex/financeSquare.test.ts` runs 18 contract tests against a stand-in for Square that follows Square's
documented behaviour (`tests/fakeSquare.ts`).

**Setup and connection:**
- Configuration and an honest blocker when the secret is missing.
- OAuth permissions, the held authorization and confirming it.
- Location eligibility: a location without card processing, or in another currency, is refused.
- Declined, replayed, expired and forged authorizations.
- The same Square account on a second company, which is refused and not shared.
- Token refresh, a stale refresh losing to a newer one, and a revoked refresh.

**Payments:**
- Payment by webhook, with a forged signature refused.
- Duplicate and repeated notices plus the sweep, counted once.
- Fee and receipt recorded.
- Deposit and partial amounts.
- A declined card.
- A lost checkout answer with no second checkout.
- Starting again while an older checkout was paid, giving an overpayment and the newer checkout closed.
- A void closing the checkout.
- An unmatched merchant noted.

**Refunds:** full and partial, a lost refund answer refunded once, and a Dashboard refund recorded.

**Access and switching:**
- Revocation, then reconnecting and recovering the payment.
- Disconnecting, blocked while a payment is in flight and closing checkouts otherwise.
- Switching providers, blocked while a payment is in flight and closing checkouts otherwise.

The setup states, the confirmation dialog and the customer's Square states were also checked in a
browser with axe at 1280 px and 390 px: no WCAG 2.2 AA violations.

**Not yet verified against Square itself:** no Sandbox credentials exist anywhere, and the test backend
forwards OAuth returns and webhooks to production (`MOVED_TO`), so it can't host Sandbox. See below.

## Setup checklist

### Addresses (derived from verified deployment configuration)

| What | Production (`stoic-gazelle-731`) | Sandbox |
|---|---|---|
| OAuth redirect URL | `https://stoic-gazelle-731.convex.site/oauth/square/callback` | **Unresolved.** Needs a non-production deployment that doesn't forward to production (`terrific-avocet-835` does, through `MOVED_TO`). Its URL will be `https://<that deployment>.convex.site/oauth/square/callback` |
| Webhook notification URL | `https://stoic-gazelle-731.convex.site/webhooks/square` | **Unresolved**, same reason: `https://<that deployment>.convex.site/webhooks/square` |

`https://stoic-gazelle-731.convex.site` answers `/health` with 200. That host is where the existing
providers are registered (`docs/foundation/06-deployments.md`). `api.selestial.io` serves the client API,
not HTTP actions, so it must not be used here. The routes exist once this change is deployed.

### Settings on the Convex deployment (names only)

| Name | Production | Sandbox deployment | Notes |
|---|---|---|---|
| `SQUARE_APPLICATION_ID` | Set (`sq0idp-…`) | The Sandbox application ID (`sandbox-sq0idb-…`) | Decides the environment. A production ID is ignored on any non-production deployment |
| `SQUARE_APPLICATION_SECRET` | **Missing** | The Sandbox application secret | Developer Console › your app › OAuth › Application secret, for the same environment. Without it, Square shows "Unavailable" and nobody can connect |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | **Missing** | The Sandbox subscription's key | Shown on the webhook subscription. Without it, webhooks are refused and payments are confirmed by the 10-minute sweep instead |
| `MAILBOX_TOKEN_KEY` | Set | Needed | Seals every stored authorization |
| `SQUARE_OAUTH_REDIRECT_URI`, `SQUARE_WEBHOOK_URL` | Optional | Optional | Only if a different exact address is registered with Square; it must end in the same path |
| `SQUARE_ACCESS_TOKEN` | Set | – | **Not used** by Selestial. Safe to remove; never use it for companies' payments |

### In the Square Developer Console (for each environment, using the toggle at the top)

1. **OAuth.** Open the application, go to **OAuth**, set the **Redirect URL** to the address above,
   and save. Copy the **Application secret** into `SQUARE_APPLICATION_SECRET` with `npx convex env set`.
   Don't paste it into a chat.
2. **Webhooks.** Go to **Webhooks › Subscriptions › Add subscription**:
   - **Notification URL:** the address above, exactly. The signature covers it.
   - **Events:** `payment.created`, `payment.updated`, `refund.created`, `refund.updated`,
     `oauth.authorization.revoked`.
   - **API version:** `2026-11-18`, the version Selestial sends.
   - **Signature key:** copy it into `SQUARE_WEBHOOK_SIGNATURE_KEY`.
3. **Permissions requested** (no other settings are needed; they are asked for in the authorization
   link): `MERCHANT_PROFILE_READ`, `ORDERS_READ`, `ORDERS_WRITE`, `PAYMENTS_READ`, `PAYMENTS_WRITE`.

### Production activation

1. **Sandbox first.** Create the dedicated test deployment the deployments doc already calls for, without
   `MOVED_TO`, and give it the Sandbox settings. Then:
   - connect a Sandbox seller, choose a location, switch to Square, and pay a test invoice with Square's
     Sandbox test card;
   - refund part of it;
   - revoke from the Sandbox seller dashboard and reconnect;
   - confirm webhook delivery in the Developer Console's logs.
2. **Production settings.** Set `SQUARE_APPLICATION_SECRET` and `SQUARE_WEBHOOK_SIGNATURE_KEY` on
   production. Register the production redirect URL and webhook subscription.
3. **Verify.** Check that Finance › Payments setup shows **Not connected** (not Unavailable) and that a
   webhook test event from the Developer Console is accepted.
4. **Live payments.** A real payment or refund is the company's own decision. Nothing in this setup
   charges anyone.

## Limitations owners should know

- **What Square takes:** online card, Apple Pay and Google Pay payments through Square's checkout, in US
  dollars, at one chosen location.
- **Not available:**
  - bank transfers (ACH), Afterpay and Cash App Pay;
  - Tap to Pay, card readers and saved cards;
  - recurring charges;
  - Square invoices and QuickBooks sync;
  - platform fees.
- **Disputes** are handled in Square's Dashboard. Selestial doesn't track them for Square payments yet.
- **One provider at a time** takes new payment requests: Stripe or Square. Earlier payments keep theirs.
- **One company per Square account:** a Square account can be connected to one Selestial company.
- **Fees** appear once Square reports them, usually within hours. Until then they show as unknown.
- **Without notifications:** until Selestial's Square notifications are switched on, payments are confirmed
  within about 10 minutes by checking Square, and refunds within about 15 minutes.
