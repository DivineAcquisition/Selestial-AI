# Backup, restore and rollback runbook

For a bad release, lost or damaged data, or a provider outage. Code: `convex/restoration.ts`,
`convex/lib/environment.ts`, `scripts/build.mjs`. Tests: `convex/environment.test.ts`.

## Targets for the launch stage

| | Target | Why |
|---|---|---|
| **Recovery point (RPO)** | 24 hours at most; less around risky releases | Convex Pro scheduled backups run daily. Take a manual backup before every release that changes the schema or migrates data. |
| **Recovery time (RTO), code** | 15 minutes | Vercel keeps every production deployment; promoting the last good one is instant. |
| **Recovery time (RTO), data** | 4 hours | Restore into a new deployment, verify, reconcile providers, then switch. Most of the time is reconciliation, which must not be rushed. |

Revisit both once there are paying customers at scale (hourly backups, a warm standby).

## What exists to recover from

- **Code:** every production deployment in Vercel (`selestial-ai`), rollback candidates marked.
- **Data:** Convex backups of the live deployment `stoic-gazelle-731` (Dashboard › the deployment ›
  Backups): scheduled and manual, downloadable, and restorable into a deployment. The Convex CLI can also
  export (`npx convex export --path backup.zip`) and import (`npx convex import backup.zip`).
  `terrific-avocet-835` is the **test** backend (it was live until November 2026); its backups are not
  backups of production.
- **Files:** cleaner photos, signed agreements, texting evidence and export files live in Convex file
  storage, not in tables. A backup holds them **only if it was taken with file storage included**: in the
  dashboard, the "Include file storage" option on a manual backup and on the backup schedule; on the command
  line, `npx convex export --include-file-storage --path backup.zip`. A backup without it restores rows that
  point at files that are not there. **Not verified:** that the scheduled backups of `stoic-gazelle-731`
  include file storage. Check the schedule's setting, and check one backup by downloading it and looking
  for a `_storage` folder.
- **Providers keep their own record:** Telnyx (messages, numbers, brands, campaigns), Resend (emails),
  Stripe (company payments, Connect accounts), Autumn (plans, credits, top-ups), Google and Gmail. After a
  restore, those are the truth about what already happened outside.

**Check before relying on it:** confirm in the Convex dashboard, on `stoic-gazelle-731`, that scheduled
backups are turned on, that they include file storage, and how long they are kept. None of the three has
been verified from a development session.

## Rolling back code

The site and the backend are rolled back separately, and in that order.

### The site (Vercel)

1. Vercel › selestial-ai › Deployments › the last good production deployment › **Promote** (or *Instant
   Rollback*). The site is back in seconds. This serves files that were already built; it runs no build and
   does not touch the backend.
2. **Do not use "Redeploy" on an old production deployment.** Redeploy runs the build again from that old
   commit, and the production build pushes the backend (`scripts/build.mjs`): the live backend would be
   replaced with that commit's **old functions and schema**, under whatever site is live. Promote only.
3. After promoting, the previous site is talking to the newer backend. That works because every release
   keeps its functions compatible with the previous site for one release
   (`docs/foundation/06-deployments.md`, "The gap in every release"). If the bad release broke that rule,
   roll the backend back too.

### The backend (Convex)

1. Revert the bad commit on `main` with a new pull request and merge it. The production build builds the
   site from the reverted code and pushes the backend from the same known commit. This is the only way the
   live backend is deployed; never by hand.
2. The pushed schema must accept the data that is there now. Schema changes are additive, so reverting code
   that added an optional field or a table is safe: the data written meanwhile still fits. If Convex refuses
   the push because rows no longer match the older schema, do not delete data to make it fit: fix forward.
3. **When a rollback is unsafe:** Convex rejects a push whose schema does not match the data. A release
   that added a required field, removed a table, narrowed a type or migrated rows cannot simply be
   reverted. For those releases:
   - make schema changes additive first (new optional fields, new tables), ship, migrate, and remove the
     old shape in a later release;
   - take a manual backup immediately before;
   - if it has to be undone, fix forward with a new release; restore data only as a last resort.

## Restoring data

A restore must never replay what already happened outside. Rows restored from a backup can say
"queued" or "sending" for messages that went out after the backup, "reserving" for charges Autumn
already took, or "provisioning" for a number Telnyx already sold.

### 1. Restore into an isolated deployment

1. Convex dashboard: create a new deployment in the project (for example `restore-2026-11-20`).
2. It is **not production by name** (`convex/lib/environment.ts`), so from its first moment it sends email
   and texts only to `TEST_RECIPIENTS`, refuses Telnyx purchases and filings, and ignores live Stripe and
   Autumn keys. Leave `TEST_RECIPIENTS` unset unless a person needs to receive test mail.
3. Deploy `main` to it (`npx convex deploy` with that deployment's own deploy key), then restore the backup
   into it (dashboard › Backups › Restore, or `npx convex import --replace backup.zip`).
4. Immediately lock it down:

   ```sh
   npx convex run restoration:lockDown '{"reason":"Restored from the 2026-11-20 03:00 backup"}'
   # repeat with the returned lockdownId and cursor until "done": true
   ```

   Every company's outbound sending is suspended and every agent paused. What each company had before,
   and exactly what the lock-down wrote, is kept, so release undoes only that.

### 2. Verify the restored records

```sh
npx convex run restoration:verify
npx convex run restoration:status
```

- `verify` counts every company table and samples rows for references to companies that are not there.
  Compare the counts with the source (the live dashboard's Data page, or the backup's own table list).
- `verify` also returns `reconcileFirst`: card payments and refunds in progress (with their Stripe ids),
  messages that may or may not have gone (`sending`, `unconfirmed`, with their provider ids), and queued or
  scheduled messages whose timers were lost. Each group adds a line to `problems`. `problems` must be empty,
  or every line in it explained in the release note, before release.
- Check files: open a few cleaner photos and a signed agreement in the restored copy. If they are missing,
  the backup was taken without file storage (see "What exists to recover from").
- Spot-check a few companies end to end: members, customers, jobs and their assignments, invoices and
  payments, texting requests.

### 3. Reconcile provider state before anything runs

`status` lists what may disagree with the providers. Work each group against the provider's record:

| Restored rows | Check against | Then |
|---|---|---|
| Messages `queued`, `held`, `sending` | Telnyx and Resend logs, and Gmail Sent, after the backup time | Already sent: set the row to sent or delivered in the dashboard's data editor. Not sent: see "Messages that lost their timers" below. Nothing re-sends them. |
| Card payments `awaiting_customer` (with a Stripe intent), `processing`, `checking`; refunds `sending`, `pending`, `checking` (`reconcileFirst.payments`, `.refunds`) | Stripe, in the company's connected account, by the payment intent or refund id | A payment or refund that finished after the backup is missing from the restored rows or shown as still in progress. Stripe is the truth: after release, the reconcile job (every ten minutes) reads each one back by its id and its original request key, so nothing is charged or refunded twice. Before release, note any that Stripe shows as succeeded so the company can be told. A payment made after the backup with no row at all has to be recorded by hand from Stripe. |
| Messages `unconfirmed` | Same | Apply the provider's outcome. Never send again without knowing. Inside 23 hours of the first attempt, a text can be checked under its own key (`docs/operations/02-incidents.md`): only on the restored deployment once it is production, never from a test copy, which sends nothing. |
| AI and messaging charges `pending_*`, `unverified` | Autumn usage and balances | Confirm or release each hold. Stripe and Autumn honor idempotency keys (Stripe for 24 hours), so retries with the original key are safe. |
| Texting requests `approved`, `provisioning`, `waiting_on_carriers` | Telnyx numbers, brands, campaigns | Telnyx declares no idempotency on these endpoints: look up by the saved order, brand and campaign references before any retry. |
| Google jobs `queued`, `running`, `uncertain` | The calendar, Drive or Ads object by its key | The worker reconciles uncertain writes by key before retrying. Public writes (a review reply, an ad going live, a conversion report) are held while the company is suspended. At release, one that has waited more than 24 hours is **cancelled as out of date** and the Owner is told in the app; a fresher one runs. A restored copy that is not production never writes to Google at all. |
| Activation tasks, agent runs | Their outputs | Work that completed is not run again (idempotency keys and tool-run receipts). |

### Messages that lost their timers

Each message is sent by its own scheduled timer. A restore brings back the rows but not the timers, and no
sweep re-sends `queued` or `held` messages: sending something hours or days late, after a restore, is worse
than not sending it. So:

- `restoration:status` returns `stuckMessages` (up to 100): messages `queued` for more than two hours, and
  scheduled (`held`) messages whose time passed more than two hours ago, with their company and purpose.
- On a live backend the same condition raises one staff incident, "Messages are queued and not going"
  (`02-incidents.md`).
- For each: check the provider's log that it did not already go. If it is still wanted, the company sends it
  again from the app (a new message, checked against today's permissions). If not, set the row to
  `not_sent` in the dashboard's data editor with a note. Never requeue in bulk.

### 4. Switch over (only when the live deployment cannot be used)

1. Add the restored deployment's name to `PRODUCTION_DEPLOYMENTS` in both `convex/lib/environment.ts` and
   `scripts/build.mjs` (a test checks they match), and point Vercel's production `CONVEX_DEPLOY_KEY` and
   `NEXT_PUBLIC_CONVEX_URL` at it. Merge to `main`; the production build deploys it.
2. Copy the live deployment's environment variables to it (provider keys, `EMAIL_FROM`, origins). Point
   provider webhooks (Telnyx, Resend, Stripe, Autumn, Google) at its `convex.site` address.
3. Release the lock-down, saying what was reconciled:

   ```sh
   npx convex run restoration:release '{"lockdownId":"…","note":"Outbox reconciled with Telnyx and Resend; Autumn holds settled; numbers checked"}'
   ```

   Release undoes only what the lock-down set, and returns `skipped` with a reason for every company it
   left alone:

   - a company staff suspended before or during the lock-down **stays suspended** (release lifts only the
     suspension the lock-down wrote, and not if anyone suspended or unsuspended the company since);
   - agents go back to the Owner's own pauses only if they are still exactly as the lock-down left them;
   - a company locked for an unpaid plan keeps every agent paused; when it pays, it gets back the pauses the
     Owner chose, not the lock-down's.

   Read `skipped` and decide each by hand. Nothing that was refused while locked down is sent later.
4. Before releasing, the reconciliation in step 3 must be done for payments, refunds and messages: release
   is what lets retries, settlement jobs and agents run again against the providers.

## Rehearsal

**Not performed.** No restore has been rehearsed. A rehearsal always goes into a **new, isolated
deployment**: never restore or import over production (`stoic-gazelle-731`), and never over the test
backend while anyone is using it.

1. Convex dashboard: create a new deployment in the project (for example `rehearsal-2026-12`) and generate
   its own deploy key. Give the person rehearsing only that key. **Unverified:** that the Convex plan allows
   an extra deployment, and that a backup can be restored into a different deployment than it came from
   (if not: download the backup and `npx convex import --replace` it with the new deployment's key).
2. Set no provider keys on it and leave `TEST_RECIPIENTS` empty. It is not production by name, so it sends
   nothing, buys nothing, charges nothing and writes to no Google account, whatever the restored rows say.
3. Deploy `main` to it with its own key, then restore the latest production backup **with file storage**.
   Note the backup's age: that is the real recovery point.
4. Immediately run `restoration:lockDown` until `done`, then `restoration:verify` and `restoration:status`.
   Time each step. Compare table counts with production's Data page. Open a few photos and a signed
   agreement to prove files came across.
5. Walk the reconciliation table in step 3 against the providers' dashboards read-only, for a handful of
   rows in each group, and write down how long a full pass would take.
6. Check `https://<rehearsal>.convex.site/health` answers for itself (`06-heartbeat.md`).
7. Do **not** run `release`, do not add the deployment to `PRODUCTION_DEPLOYMENTS`, and do not point Vercel
   or any provider webhook at it.
8. Delete the deployment: it holds a full copy of customers' personal data. Record the date, the timings
   and anything that did not work in `00-decisions.md`, and update the register entry "Backups and
   restoration" (`src/lib/trust/register.ts`), which today says no restore has been tested.

The commands themselves are tested (`convex/environment.test.ts`, "Restoring without replaying anything").
