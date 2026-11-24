# SMS infrastructure: audit, architecture and plan

Phase 1 of "Selestial's complete SMS infrastructure on Telnyx". It records what the code does today (read
on 2026-11-24 at `c173b61`), what Telnyx and Clerk actually document, the decisions the owner made, and the
plan for every later phase. Earlier docs (`docs/texting/*`, `docs/quo/*`) are inputs, not proof: every claim
below was checked in the code, and the provider facts carry their sources.

Backends: **production is `stoic-gazelle-731`** (`convex/lib/environment.ts:21`, also `api.selestial.io`).
`terrific-avocet-835` is the development backend. (`docs/texting/00-audit.md` calls the development backend
"live"; that is wrong and is corrected there.)

## 1. Decisions (from the owner, 2026-11-24)

| Topic | Decision |
|---|---|
| Sign-in codes | Clerk stays the only login system. Clerk creates codes and sessions; Selestial delivers Clerk's SMS through Telnyx (`sms.created` webhook, "Delivered by Clerk" off per template). |
| Code uses | Second factor, account recovery, verifying a phone for alerts, and passwordless phone sign-in (never for Selestial staff). |
| Selestial's own sender | A verified toll-free number for notices, plus a separate sender for codes, so one problem never blocks the other. |
| Replies to Selestial's own number | No-reply: an automatic answer points to email and in-app support. |
| Prices | The `msg-2026-11` rate card and `reg-2026-11` registration prices are approved for production. |
| Failed texts | Charged once the message reaches the carriers, even if later undelivered. Released if Telnyx rejects it before sending. |
| Auto-recharge | Offered, off by default, with trigger, amount and monthly cap, explicitly authorized. |
| Agent first texts | Each agent keeps its permission level; a first text to a new contact asks the owner until automatic sending is turned on. |
| Sending hours | 8am–9pm in the **recipient's** local time (property address, then area code). Owners can narrow it, not widen it. Codes ignore it. |
| Internal alerts | Staff console + email, and SMS to on-call staff for urgent ones. |
| Delivery | One stacked draft PR per phase on `claude/loving-clarke-8ys51f`. |

## 2. What exists

### 2.1 Outbound

| Area | Where | State |
|---|---|---|
| Outbox | `messages` table (`convex/schema.ts:712`), `lib/messaging/outbox.ts` `plan`, `convex/messaging.ts` `claim` → `deliver` → `settle` | Works. One sender, one policy. |
| Statuses | `lib/statuses.ts:113`: queued, held, sending, sent, delivered, failed, unconfirmed, not_sent | No draft, awaiting approval, scheduled, canceled, suppressed or "delivery unknown after acceptance". `MESSAGE_CHANGES` is enforced only in `quoSend.ts`. |
| Policy | `lib/messaging/policy.ts` `checkSend` (at plan **and** at claim) | Suspension, agent pause, sender readiness, address, conversation owner, registration coverage, suppression, permission, quiet hours, weekly cap. Re-run before the provider call, followed by per-domain "still relevant" checks (`messaging.ts:118-138`). |
| Provider | `lib/messaging/provider.ts`, `lib/messaging/telnyx.ts` | `Idempotency-Key: selestial-<messageId>` (Telnyx documents this header). No fetch timeout. |
| Billing at send | `lib/messagingBilling/ledger.ts` `planOutbound`, `convex/messagingBilling.ts` | Autumn hold before every metered send, capture on acceptance, release on failure, sweep every 5 min. |
| Callers | 12 separate "insert + checkSend + schedule" copies (Dispatch `queueMessage`, Sales, Retention, Quality, Finance customer + cleaner statement, Cleaners, Recruiter, Booking, client conversations, calendar move notices, member notices) | Each re-implements planning. |
| Bypasses | `quo.ts:436` `sendTestText` (direct Quo send), `texting.ts:862` brand code (sent by TCR, no row) | Outside the outbox. |
| Queue | One `scheduler.runAfter(deliver)` per message | No lanes, no per-company fairness, no per-number throughput. |

### 2.2 Inbound, consent, conversations

| Area | Where | State |
|---|---|---|
| Telnyx webhook | `convex/http.ts:176`, `verifyTelnyx` (`lib/messaging/telnyx.ts:107`) | Ed25519 over `timestamp|body`, ±5 min. Dedupe by `(provider, eventId)`. Early and out-of-order receipts handled. `message.sent` ignored; `delivery_unconfirmed` ignored. |
| Inbound routing | `convex/inbound.ts` | Company from the receiving number; sender matched **inside that company only**; unknown senders go to review; STOP/HELP/START and plain-language stops. "YES" counts as START (wrong). MMS media dropped. 200-character excerpt stored. |
| Consent | `lib/compliance/schema.ts`: `contactPermissions`, `permissionHistory`, `suppressions`, `consentDisclosures`, `sendIntents` | Company-scoped, categories operational/marketing/recruiting. No suppression screen. Telnyx-side opt-out (40300) not reconciled. |
| Conversations | `smsConversations`, `clientConversations`, `salesConversations` | Three takeover flags that never sync. `/app/inbox` has no composer. |
| Links | `lib/dispatch/links.ts`, `lib/sales/links.ts`, `lib/finance/payLinks.ts`, `lib/cleaners/portal.ts`, `lib/recruiter/links.ts` | HMAC tokens, 128-bit ids, scoped, revocable, audited (`linkAudit.test.ts`). Pay links have no time limit. A second offer accept throws instead of returning the accepted state. |
| Agent controls | `companies.ts` `pauseAgent`/`pauseAll`, `lib/permissionCatalog.ts` levels, `approvals.ts` | `pauseAll` leaves out Quality. |

### 2.3 Billing, notifications, auth, operations

| Area | Where | State |
|---|---|---|
| Autumn | `lib/billing/autumn.ts` (REST), feature `messaging_balance` | Atomic lock with reject overage; idempotency keys on every call. |
| Segments | `lib/messagingBilling/segments.ts` | GSM-7/UCS-2 aware, 10-segment cap. |
| Who pays | `lib/messagingBilling/classify.ts` | By purpose: `compliance_reply`, `verification_code`, `operator_alert`, `member_notice` are included (free). No platform/company/internal field. `providerCost` stored, unreported. |
| Auto-recharge | `convex/messagingFunds.ts:55` | **Exists** (threshold, amount, monthly max, off by default). |
| Statements | `messagingUsage.statement` + CSV in `src/components/app/billing/messaging.tsx` | Exists. |
| Notifications | `lib/notify/*` | Email + in-app. No SMS. Quiet hours fixed 9pm–7am on the company clock. |
| Clerk | `auth.config.ts`, `src/components/auth/*` | No Clerk webhook at all. Phone off. Login handles a phone second step if Clerk asks; no enrollment screen. Recovery is email only. |
| Phones on people | `members`, `staff` | No phone field (cleaners have `phone` + `phoneVerified`). |
| Staff | `lib/builders.ts:246` | Support actions need the `fva` claim, which the `convex` token template lacks. |
| Operations | `lib/operations/*` | Detectors for unconfirmed, stuck, inbound failures, provider outage grouping, settlement. Alerts by email only (`ALERT_CHANNELS`). No delivery-failure-rate, spend or Telnyx-key health detectors. |

### 2.4 Telnyx account (production and development)

- One messaging profile ("Selestial") for every company: `texting.ts:925` orders each number onto
  `TELNYX_MESSAGING_PROFILE_ID`. Its webhook points at production (correct).
- The development backend's `TELNYX_API_KEY` was refused on 2026-11-24 ("No key found matching the ID");
  it worked on 2026-11-22. Production's key is untested from this session.
- The 2026-11-22 development check: brand filing passed; the campaign was refused with
  *"Insufficient Funds: Your account must have at least $30.00"*.
- The session's own Telnyx secret is malformed (Telnyx can't parse it as a key). Account-level checks wait
  for a working key.

## 3. What Telnyx and Clerk document (checked 2026-11-24)

| Fact | Consequence | Source |
|---|---|---|
| Webhooks: Ed25519 over `{timestamp}|{raw body}`, reject older than 5 min; up to 3 attempts + 3 failover; no ordering guarantee; dedupe on `data.id`, order by `occurred_at`. | Current verification is right; add `message.sent`. | developers.telnyx.com/docs/messaging/messages/receiving-webhooks |
| Statuses: queued, sending, sent, delivered, sending_failed, delivery_failed, delivery_unconfirmed (+ expired). `message.finalized` is terminal. | `delivery_unconfirmed` becomes our **Delivery not confirmed**. | same |
| `Idempotency-Key` on `POST /v2/messages`: stored 24 h for 2xx; 409 (10036) in flight; 422 (10027) same key, different body. | The body must be frozen after the first attempt, or a reconcile turns into a 422. | developers.telnyx.com/docs/development/api-fundamentals/idempotency |
| `GET /v2/messages/{id}` only 10 days; Detail Records searchable by destination and date. | Reconcile = replay the same key within 24 h; after that, detail-record search, then a person. | api-reference/detail-records |
| Billed per part plus carrier fees; failures after leaving Telnyx are charged; 40014 is not. `cost` can be null until finalized. | Matches the owner's policy: release on `sending_failed` before acceptance and 40014; keep the charge on `delivery_failed`/unconfirmed. | support.telnyx.com/en/articles/6505121 |
| **Opt-out blocks are per messaging profile.** STOP on one number blocks every number on the profile; blocked sends fail with 40300. Inbound payloads carry `autoresponse_type`. | **One messaging profile per company.** Treat 40300 as a provider suppression. Don't send a second STOP confirmation when Telnyx already answered. | developers.telnyx.com/docs/messaging/messages/advanced-opt-in-out |
| Auto-responses configurable per profile (`autoresp_configs`); AI opt-out detection can be turned off. | Each company profile carries its own STOP/HELP wording. | api-reference/opt-out-management |
| Toll-free: unverified numbers are **blocked** in the US (40329); verification takes 1–4 weeks; EIN mandatory since 2026-02-17; up to 20 MPS once verified. | Clerk keeps delivering its own SMS until Selestial's code number is verified. | developers.telnyx.com/docs/messaging/toll-free-verification |
| 10DLC: each customer is its own brand; the privacy policy must be the brand's own; CTA must name program, frequency, cost, STOP/HELP, links; consent box optional. Campaigns can go dormant on T-Mobile after 15 days with no traffic and no numbers. | The cleaning-company builder stays per company. Selestial's own registration is a toll-free verification, never the company builder. | developers.telnyx.com/docs/messaging/10dlc/* |
| Verify: Telnyx or custom codes, destination allowlist per profile, no built-in pumping protection; sender undocumented. | Not used for login (Clerk owns codes). Kept as an option for non-Clerk checks. | developers.telnyx.com/docs/identity/verify |
| Number Lookup gives line type, not time zone. | Recipient time zone comes from the property address, then the area code. | api-reference/number-lookup |
| Clerk: "Delivered by Clerk" can be turned off **per template**; then `sms.created` carries `to_phone_number`, `message` (the rendered text), `slug`, `user_id`, `delivered_by_clerk`. Svix-signed, at least once, dedupe on `svix-id`. | Send Clerk's `message` verbatim (deterministic, Clerk's own template). Never log the payload. | clerk.com/docs/guides/customizing-clerk/email-sms-templates |
| Clerk: SMS auth and MFA need the Pro plan in production; US/CA SMS allowlist by default; 10 failed attempts lock the account; reverification for phone changes. | Owner decision: Clerk Pro plan in production. | clerk.com/pricing, clerk.com/docs/guides/secure/reverification |

## 4. Architecture

### 4.1 Three kinds of message, kept apart in data

| Kind | Store | Sender | Who pays | Examples |
|---|---|---|---|---|
| **Company business** | `messages` (requires `companyId`) | The company's own number, on the company's own messaging profile, or its Quo connection | The company, by rate card and usage policy | Offers, reminders, invoices, recruiting |
| **Selestial platform** | `platformMessages` (no company; keyed by Clerk user or staff) | Selestial's code sender or notice sender | Selestial (recorded as platform spend) | Sign-in codes, security notices, account notices |
| **Selestial internal** | `platformMessages` with `kind: "internal"` | Selestial's notice sender | Selestial | Provider outage, abnormal spend, stuck queues |

A platform message never enters a company's tables, exports or erasure, and a company message never falls
back to a platform sender: if the company's number can't send, the message is held with the reason.

### 4.2 One controlled send path (company messages)

`enqueue(ctx, request)` in `lib/messaging/outbox.ts` replaces the twelve copies. Every request states:
company, audience + recipient, channel, purpose, category, **actor** (member, agent, system or contact),
agent, related records, template key + version, approval reference, dedupe key, not-before time and lane.

Checks, at enqueue and again at claim (unchanged order, extended):

1. Company suspended or **owner paused all texting**.
2. Actor authorized (members: role; agents: authority level and pause).
3. Recipient identity and normalized address (US standard routes only).
4. Purpose → consent category (no more "operational" for sales follow-ups).
5. Suppression (Selestial's and the provider's).
6. Sender ownership: the number belongs to this company, sits on its profile and its approved campaign.
7. Provider connection and registration readiness.
8. Recipient-local sending hours.
9. Conversation owner (human takeover pauses agents).
10. Approval still valid.
11. Frequency caps and duplicate prevention (per recipient, across agents).
12. Balance and spending limits (Autumn hold).
13. The underlying event still matters (registered per purpose: offer still open, invoice still unpaid…).

Every refusal carries a **class**: `hold` (temporary, will retry), `suppressed` (permanent for this
recipient), `setup` (the company must act), `provider` (Telnyx/Quo failed), `canceled` (no longer relevant
or canceled by a person).

### 4.3 Lifecycle

```
draft ─► awaiting_approval ─► scheduled ─► queued ─► sending ─► accepted ─► delivered
                   │               │          │         │           ├──► failed
                   └► canceled ◄───┴──────────┘         │           └──► delivery_unknown
                                    held (hold class) ◄─┤
                                    suppressed / not_sent (setup)    unconfirmed (did the provider take it?)
```

- `sent` is renamed in the UI to **"Accepted by carrier network"**, never "Delivered".
- `delivery_unknown`: Telnyx finalized with `delivery_unconfirmed`, or no receipt within the window.
- `unconfirmed`: the request may or may not have reached Telnyx; reconciled with the same idempotency key
  inside 24 h (the frozen body makes the replay identical), then by detail-record search.
- Status changes go through one `transition()` helper that enforces `MESSAGE_CHANGES`.

### 4.4 Lanes, fairness, throughput

| Lane | Contents | Rule |
|---|---|---|
| `urgent` | STOP/HELP replies, same-day dispatch, portal codes | Never waits behind other lanes. |
| `standard` | One-to-one business texts | Per-company and per-number rate limits. |
| `bulk` | Batches, campaigns, re-engagement | Paced; resumes only unresolved recipients. |

Platform codes never share a lane, a sender or a profile with company traffic.

### 4.5 Telnyx resources (created by Selestial through the API)

| Resource | One per | Created by |
|---|---|---|
| Messaging profile (webhook = the backend's own public origin, STOP/HELP wording, AI opt-out detection off) | Company, per backend | Provisioning, before the number order |
| Number | Company | Existing order flow, onto that company's profile |
| Brand + campaign | Company | Existing guided registration |
| Platform notice profile + toll-free number + verification | Selestial | Platform setup (staff) |
| Platform code profile + toll-free number + verification | Selestial | Platform setup (staff) |

Development uses its own profiles and refuses to order onto a production profile.

### 4.6 Platform SMS and sign-in

- `/webhooks/clerk` (Svix): `sms.created` with `delivered_by_clerk: false` → `platformMessages` (purpose
  `auth_code`) → the code sender. The text is Clerk's `message`, verbatim. Never logged or stored after send
  (only a hash and the last digits of the destination).
- Abuse limits before sending: per destination, per Clerk user, per country (US only), global hourly
  ceiling and spend circuit breaker, pumping detection (velocity by number prefix). Clerk's own IP limits
  and lockout stay.
- Rollout safety: "Delivered by Clerk" is turned off per template only after the code sender is verified;
  if the code sender fails persistently, staff (or the breaker) turn Clerk delivery back on through Clerk's
  API.
- Security notices (phone added/removed, MFA changes) from Clerk `user.updated` diffs, to the person's other
  verified destinations.
- People's phones: `userPhones` (Clerk user, E.164, verified at, source) synced from Clerk; used for SMS
  notifications and staff alerts. A verified phone grants nothing in any company.
- Staff: SMS never approves impersonation, ownership transfer or other privileged actions; staff accounts
  can't use passwordless phone sign-in.

### 4.7 Inbound

- Company from the receiving number (and profile); never matched across companies.
- One conversation owner (`smsConversations.owner`) replaces the three takeover flags.
- Full inbound text kept with restricted access; media stored only when the channel supports it.
- STOP/HELP/START reconciled with Telnyx (`autoresponse_type`, 40300); "YES" no longer lifts a stop.
- Replies to Selestial's no-reply numbers get one automatic answer with help options, at most once a day.

### 4.8 Billing

Kept as is (Autumn hold → capture → settle, versioned rates, auto-recharge, statement), plus: explicit
`payer` on every charge (company / platform), refund on `sending_failed` only when Telnyx never accepted,
estimates before manual and bulk sends, platform spend report from `providerCost`, and reconciliation
exceptions surfaced to staff.

## 5. Event map

"Backed" means a real product event exists today. Infrastructure is built for every row; only backed rows
are enabled.

| Area | Message | Backed by | Enable |
|---|---|---|---|
| Authentication | Phone verification, sign-in and second-factor codes | Clerk `sms.created` | After code sender verified |
| Security | Phone/MFA changes | Clerk `user.updated` | Phase 3 |
| Selestial onboarding | Setup appointments, setup assistance | **No appointment records exist** | No (infrastructure only) |
| Selestial onboarding | Import ready for review | `migration.step = "review"` | Phase 3 |
| Account operations | Disconnected sending, balance warnings | `texting.*` events, `messagingNotices` | Phase 3 |
| Support | Appointment reminders, ticket updates | **No ticket/appointment records** | No |
| Sales | Lead follow-up, quote/proposal links, walkthrough reminders | `lib/sales/*`, `proposals.ts`, `assessments.ts` | Already sending; moved onto `enqueue` |
| Recruiter | Invitations, interviews, reminders, follow-up | `lib/recruiter/outbox.ts` | Phase 5 |
| Dispatch | Offers, acceptance follow-up, changes, arrival checks, replacements | `lib/dispatch/*`, `dispatchOps.ts` | Phase 5 |
| Cleaner onboarding | Invitations, outstanding requirements, completion | `cleanerOnboarding.ts`, `cleaners/followUps.ts` | Phase 5 |
| Job execution | Job links, check-in prompts, photo requests | `dispatch/live.ts` | Phase 5 |
| Retention | Follow-up, rebooking, recovery | `lib/retention/*` | Already sending; moved onto `enqueue` |
| Quality | Evidence requests, reclean coordination | `lib/quality/requests.ts` | Already sending; moved onto `enqueue` |
| Finance | Invoice links, payment reminders, confirmations | `financeMessages.ts`, `teamPay.ts` | Already sending; moved onto `enqueue` |
| Internal | Delivery incidents, queue failures, verification abuse, spend | `lib/operations/*` + new detectors | Phase 6 |

## 6. Gaps, in priority order

1. **Shared messaging profile**: one STOP blocks every company. (Isolation, compliance.)
2. **Three takeover flags and "operational" for everything**: quiet hours, caps and takeover skip most
   business texts.
3. **Quiet hours on the company's clock**, not the recipient's.
4. **Twelve planning copies**; `pauseAll` misses Quality; system sends labeled `manual` slip past agent
   pause.
5. **No fetch timeout** and a re-rendered body on reconcile (422 forever).
6. **Delivery unknown and Telnyx opt-outs not represented.** "YES" lifts a STOP.
7. **No platform sender, no Clerk webhook, no phones on people, no SMS notifications.**
8. **No Telnyx-key health check**: a dead key fails silently.
9. **No composer in the Inbox**, no suppression screen.
10. **Pay links never expire**; second offer accept errors.

## 7. Phases

| Phase | Delivers |
|---|---|
| 2. Shared foundation | `enqueue` + lifecycle + `transition()`; refusal classes; per-company messaging profiles; Telnyx timeout, frozen body, `message.sent`, `delivery_unknown`, 40300/`autoresponse_type`; YES fix; Quality in `pauseAll`; owner "pause all texting"; lanes + per-company/per-number limits; `platformMessages`; `payer`; Telnyx key health detector. |
| 3. Platform SMS | Clerk webhook + code delivery with abuse limits; `userPhones`; SMS channel for notifications with per-person quiet hours; security notices; staff SMS alerts; Selestial toll-free verification builder (separate from the company builder) and public SMS terms. |
| 4. Company setup | Business texting states derived from real records (not configured → ready to send); profile per company; test send to an authorized recipient through `enqueue`; guard that the company builder never describes Selestial; Quo shown per workflow. |
| 5. Business workflows | Inbox composer and single owner; recipient-local hours; Dispatch and Recruiter on `enqueue` with relevance hooks; second-accept idempotency. |
| 6. Billing and operations | Refund rule by Telnyx status; estimates; platform spend; admin views for provider health, queue age, failures, spend, verification abuse, reconciliation exceptions. |
| 7. Verification and rollout | Failure-case tests, visual checks, controlled live test with the owner's approved phone, release checklist. |

## 8. Needed from the owner

- A working Telnyx API v2 key (`KEY…_…`) for this session, the development backend, and (if the read-only
  check fails there) production.
- At least $30 on the Telnyx account before any campaign filing.
- Clerk Pro plan on the production instance (SMS sign-in and MFA).
- Selestial's legal name, EIN, address and contact exactly as on IRS records, for toll-free verification.
- One approved test phone (your own) for the controlled live test.
- On-call staff phones for urgent alerts (added in the staff console, not code).
