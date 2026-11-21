# Operations: audit before building monitoring and recovery

Inspected on `claude/selestial-monitoring-recovery-z3wg0x` at `19614f1` (main, November 20, 2026).

The rule for this work: **extend what exists.** Selestial already has durable task state, leases, bounded
retries and recovery crons in almost every workflow. What it lacked was one place that notices when those
mechanisms themselves give up, groups the result into something a person can act on, and tells the right
person. That is what `convex/operations.ts` adds. It does not retry anything on its own except through
the workflows' own recovery functions.

## What exists, and what it already does

| Area | Durable state | Recovery that already runs | Where it gives up |
|---|---|---|---|
| Activation (first work) | `activationTasks`: state, `attempts`, `leaseUntil`, `lastError`, `blocker` | `tick` leases (2 min), `recover` at lease end, 5-min `activation.sweep`, backoff 30s·2ⁿ, 3 attempts | `failed` + a `memberNotices` row |
| Sales agent | `salesRuns` (no lease; stuck = 5 min since `startedAt`) | `salesAgent.failed`: 3 attempts, `attempt·30s`; 5-min sweep | `failed`, event `opportunity.run_failed` |
| Retention | `retentionRuns` (`running` is never written) | 10-min sweep re-runs queued rows older than 2 min | `failed` + a `tasks` row `retention.run_failed:<id>` |
| Google jobs | `googleJobs`: `attempts`, `nextAt`, `checkpoint` | 1-min tick, 5 attempts, 30s·4ⁿ (≤2 h); a quiet write becomes `uncertain` | `failed` / `uncertain`, event `google.job_failed` |
| Creative Studio | `mediaJobs`: `heartbeatAt` | 5-min sweep polls or marks `uncertain`; never resends | `uncertain` |
| Company Chat | `chatRuns`: `heartbeatAt` | 2-min sweep closes stale runs honestly | `failed` |
| Outbox | `messages`: 8 statuses, `attempts`, `attemptedAt`, `holdReason` | `claim` re-runs the send policy every time; 3 attempts on retryable errors; 5-min `sweepStuck` | `unconfirmed` (never resent), `failed`, `not_sent` |
| Delivery receipts | `providerReceipts` keyed by provider event id | Duplicates dropped; early receipts parked and applied at settle | — |
| Inbound texts | `inboundMessages` | Dedupe through `providerReceipts` | `unknown_number` / `bad_number` were return values only: **nothing recorded them** |
| Texting registration | `textingRequests` (10 statuses, `needs`, `diagnostics`, lease) | 30-min reconcile of quiet rows (>6 h), daily active check | `failed`, `interrupted`, `needs_you` |
| Gmail inboxes | `mailboxConnections.status` connected/expired/disconnected/error | `inbox_reconnect` notice, held messages resume on reconnect | `expired` / `error` + a task |
| Google tools | `googleConnections.status` | `markExpired` records `google.expired` | **No notice is sent** (`google.expired` is not a notice event) |
| AI credits | `aiExecutions`: `settlement`, `settleAttempts`, `nextSettleAt` | 5-min `billing.sweep`, backoff 1→360 min | `unverified` |
| Messaging money | `messagingCharges`, `messagingTopUps`, `messagingAttention` | 5-min sweep, releases stale holds | `unverified`; held messages >24 h left for a person |
| Notices | `messages` purpose `member_notice` (no messaging balance), `memberNotices` in-app | Outbox retries; night hold | Messaging-balance emails (`messagingNotices.ts`) bypass the outbox and are only counted |
| Pause | `companies.pausedAgents`; `companies.suspendedAt` (staff, `compliance.setSuspended`) | `checkSend` refuses at the moment of sending; each agent checks in its own run | Google jobs, Creative Studio and Chat check neither |
| Takeover | Sales `takeOverConversation`, Retention `heldBy`, `tasks.withPersonSince` | Rechecked by each workflow before acting | — |
| Audit | `events` (append-only, guarded), `trustChanges`, `messagingAttention.resolvedBy` | — | No cross-company index; staff actors are written as `system` with `staffId` in data |
| Staff | `staff` rows: `admin` / `reviewer`; `staffQuery`/`staffMutation` | — | No capability catalog: every staff member could credit balances or suspend a company |

## Facts verified against provider documentation

- **Telnyx `POST /v2/messages` honors `Idempotency-Key`.** Verified on November 21, 2026 in Telnyx's OpenAPI
  for the endpoint (`developers.telnyx.com/api-reference/messages/send-a-message`): keys are 1–255 of
  `[A-Za-z0-9_-]`; a successful response is replayed for 24 hours with `Idempotent-Replayed: true`; the
  same key still in progress returns 409 (code 10036); the same key with a different body returns 422;
  errors are not replayed. Selestial sends `selestial-<messageId>`, the same key for every attempt of one
  message. This is what makes reconciling an unconfirmed text safe inside 24 hours (see `01-recovery.md`).
  It has not yet been exercised against the live Telnyx account (the development key is rejected, see
  `docs/texting/01-deployment.md`).
- The Telnyx 10DLC/account API has no idempotency header (`convex/lib/messaging/telnyxAccount.ts`), so
  number purchases and registrations are never retried blindly; they are read back first (already the
  case in `texting.provision`).

## Gaps this work closes

1. Nothing noticed when a recovery mechanism itself stopped (a sweep not running, a lease never recovered).
2. Failures were per-record; nothing grouped them per company, deduplicated them, or tied them to a
   provider outage across companies.
3. `unconfirmed` texts were a dead end: no reconciliation, no owner explanation.
4. Inbound texts to an unknown number, and failed messaging-balance emails, left no record.
5. An expired Google tool connection told nobody.
6. Staff had no Operations view: counts had to be worked out per page, and staff actions on a company were
   recorded as `system`.
7. No staff capability catalog; no audited, time-bound way to look inside a customer workspace.
8. A non-production backend could text and email real people; nothing marked a restored backend as unsafe
   to execute.
9. No restore or rollback runbook.

## Outdated notes reconciled

- `docs/foundation/04-trust.md` says the staff console is "requests, trust records, companies, staff". It
  also has texting, messaging money, agent requests, setup funnel and AI models; Operations is added.
- `README.md` says "There is no texting". Texting is built (`docs/texting/`); that line predates it.
- `convex/lib/messaging/telnyx.ts` claimed idempotency without a source; it now cites the verified behavior.
- `docs/foundation/06-deployments.md` describes isolation by deploy key only. Backend controls are added in
  `02-isolation-and-restore.md`.
