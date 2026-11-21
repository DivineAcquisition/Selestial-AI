# Moving the live backend to a Convex production deployment

Status: **planned, not started** (November 21, 2026).

The live site runs on `terrific-avocet-835`, which Convex created as a **development** deployment. Anyone
holding its key can push code to it with `npx convex dev`, and Convex designs dev deployments for development,
not real customer data. This runbook moves the live backend to a production deployment **before** live
billing is switched on, so no paying company's billing has to be moved later.

`<new>` below is the new production deployment's name (it gives `https://<new>.convex.cloud` and
`https://<new>.convex.site`).

## What keeps this safe

The code decides production by deployment name (`PRODUCTION_DEPLOYMENTS` in `convex/lib/environment.ts`
and `scripts/build.mjs`). Until `<new>` is on that list **and** that code is deployed to `<new>`, the new
deployment is "not production": it sends email and texts only to `TEST_RECIPIENTS`, ignores live Stripe and
Autumn keys, and refuses Telnyx purchases. So it can hold the copied data, the real settings and all 49 crons
without reaching anyone. It only goes live at the cutover (step 6).

The other risk is two live backends running at once, both running crons, sending messages and settling billing.
So the old deployment is **paused** at the cutover, before the new one becomes production.

## Steps

### 1. Create the production deployment (Convex dashboard)

In the project that holds `terrific-avocet-835`, create or open the **Production** deployment. Generate its
production deploy key (`prod:<new>|...`). Keep it out of Claude's environments.

(Vercel already holds an unused `CONVEX_PROD_DEPLOY_KEY`. If that key is for this deployment, use it.)

### 2. Copy the settings

Copy every environment variable from `terrific-avocet-835` to `<new>` (Settings → Environment Variables), with
these differences:

| Variable | On `<new>` |
|---|---|
| `AUTUMN_SECRET_KEY` | The live key, `am_sk_live_...` |
| `AUTUMN_WEBHOOK_SECRET` | The secret of the **new** Autumn live webhook (step 7), not an old one |
| `BILLING_RATE_CARD` | `2026-11b` |
| `APP_ORIGIN`, `SITE_ORIGIN`, ... | Same as today (`https://app.selestial.io`, ...) |
| `CLERK_JWT_ISSUER_DOMAIN` | Same as today |
| Every webhook signing secret (Stripe, Resend, Telnyx, Google, signature) | Replaced in step 7, once each provider's webhook points at `<new>` |
| `TEST_RECIPIENTS` | Leave unset. Nothing is sent before the cutover. |

`CONVEX_SITE_URL` and `CONVEX_CLOUD_URL` are set by Convex itself.

### 3. Deploy the current code to `<new>` (still not production)

From an up-to-date `main`, deploy the code with `<new>`'s production key: `CONVEX_DEPLOY_KEY=prod:<new>|... npx convex deploy`.
`<new>` is not yet on the production list, so it stays harmless.

### 4. Rehearse the data copy

Export a snapshot from `terrific-avocet-835` with file storage included (Convex dashboard → Backups, or
`npx convex export --include-file-storage --path snapshot.zip`). Import it into `<new>`
(`npx convex import --replace-all snapshot.zip` with `<new>`'s key). Then compare row counts for the main tables.

Snapshot imports keep document ids. That matters because Autumn's customer id is `company_<companyId>`:
billing keeps matching only if ids survive. **Check this on the rehearsal:** a company's `_id` must be the
same on both.

**Check in Convex's documentation before the cutover:** whether **pending scheduled functions** move over
with a snapshot (they may not). Billing holds recover on their own (`billing.sweep`, and Autumn lock
expiry). Any other timed work that is pending at the cutover may need to be re-queued.

### 5. Prepare the cutover change (code)

One pull request: `PRODUCTION_DEPLOYMENTS = ["<new>"]` in both files, and the docs updated.
**Do not merge it yet.**

### 6. Cutover (a short maintenance window)

1. **Pause** `terrific-avocet-835` (Convex dashboard → Settings → Pause deployment). From here on the live
   site is down until step 6.5.
2. Export the final snapshot from `terrific-avocet-835` and import it into `<new>` (`--replace-all`). Check
   that exports still work while a deployment is paused. If they don't, take the export just before
   pausing and accept losing anything written in between.
3. In Vercel → selestial-ai → Environment Variables (Production only): set `CONVEX_DEPLOY_KEY` to `<new>`'s
   production key. Then remove `CONVEX_PROD_DEPLOY_KEY`, or keep it equal.
4. Set `NEXT_PUBLIC_CONVEX_URL` (Production) to `https://<new>.convex.cloud`. The build sets it on its own,
   but keep the stored value correct.
5. Merge the step 5 pull request. Vercel's production build deploys the code to `<new>` (which is now
   production) and builds the site against it.
6. Sign in on app.selestial.io and check that your company and records are there.

### 7. Point every provider at `<new>`

Each URL below becomes `https://<new>.convex.site/...`. Where the provider issues a new signing secret, copy it
into `<new>`'s matching variable.

| Provider | Where | Path |
|---|---|---|
| Autumn (live environment) | Developer → Webhooks | `/webhooks/autumn` |
| Stripe (Selestial's own account) | Developers → Webhooks | `/webhooks/stripe-billing` |
| Stripe Connect | Developers → Webhooks (Connect) | `/webhooks/stripe` |
| Telnyx | Messaging profile → webhook URL | `/webhooks/telnyx` |
| Resend | Webhooks | `/webhooks/resend` |
| Google Cloud | OAuth client → authorized redirect URIs | `/oauth/google/callback` |
| Google Pub/Sub | Push subscription endpoint | `/webhooks/google/pubsub` |
| Google lead forms | Webhook URL | `/webhooks/google/leads` |
| Jobber | App → callback URL | `/oauth/jobber/callback` |
| Signature provider | Webhook URL | `/webhooks/signature` |

Google Calendar watch channels are registered per company and carry the old address
(`/webhooks/google/calendar`). They have to be renewed from `<new>`, or they stop delivering when they expire.

### 8. After the cutover

- **Remove live keys from `terrific-avocet-835`.** These are the live keys for Stripe, Autumn, Telnyx and
  Resend. Once off the production list, the code there treats it as a test backend, but don't rely on that.
  Decide whether it becomes the work-in-progress test backend (wipe its real data first) or is deleted.
- **Already-sent emails still link to the old address.** Their one-click unsubscribe links point at
  `https://terrific-avocet-835.convex.site/notify/unsubscribe` (`CONVEX_SITE_URL` at send time). While the old
  deployment is paused or deleted, those links fail. Recipients still have the page link and replies. Decide
  before deleting it.
- Update `src/lib/trust/register.ts` and the docs that name `terrific-avocet-835`: 06-deployments,
  email/00 and 05, texting/00, and operations/05.
- Then switch on live billing (Autumn live webhook, a test purchase on Operate).
