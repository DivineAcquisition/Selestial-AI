# Release checks, deployment and rollback

## What runs on every pull request

`.github/workflows/ci.yml`, two jobs:

| Job | Steps |
|---|---|
| Lint, types, tests | `npx eslint --max-warnings 50` · `npm run typecheck` (the app) · `npx tsc --noEmit -p convex` (the backend) · `npx vitest run` |
| Build (deploys nothing) and smoke | Fails if it holds `CONVEX_DEPLOY_KEY` or runs as a production build · `npm run build` with no backend and no keys · starts the built site and runs `tests/e2e/smoke.mjs` |

The build deploys the live backend only when `VERCEL_ENV=production` **and** `CONVEX_DEPLOY_KEY` is set
(`scripts/build.mjs`). CI sets neither and holds no provider secret. Never add `CONVEX_DEPLOY_KEY` to the
repository's Actions secrets.

The smoke run proves: public pages answer; the public offer is one plan at $299 with no trial and no plan
that cannot be bought; `/app` and `/staff` fail closed without sign-in; link pages with a made-up token leak
nothing; no provider secret is in the browser bundle. It proves nothing that needs sign-in or a provider.

## Not in CI yet

The signed-in browser runs (`tests/e2e/auth.mjs`, `cleaner-pages.mjs`, `applicant-pages.mjs`, `trust.mjs`)
need a development Clerk instance and a test Convex backend. Once the test backend exists
(docs/foundation/06-deployments.md), add a third job that runs them with `CLERK_SECRET_KEY` (development
instance only; the scripts refuse a production one) and the test backend's address as Actions secrets.

## Branch protection (needs a repository administrator)

GitHub › Settings › Branches › Add branch ruleset for `main`:

- Require a pull request before merging.
- Require status checks to pass: **Lint, types, tests** and **Build (deploys nothing) and smoke**.
- Require branches to be up to date before merging.
- Block force pushes; do not allow deletion.
- Do not allow bypassing the above (include administrators).

This could not be applied from the session that added CI; it is listed as an owner action in `readiness.md`.

## How a release reaches production

1. Merge to `main`. Vercel's production build runs `scripts/build.mjs`.
2. The site is built first. If that fails, nothing is pushed.
3. The Convex functions and schema are type-checked and pushed. If that fails, the build fails and the site
   that was just built is not published.
4. Vercel publishes the site.

Between 3 and 4, and for every browser tab already open, **the previous site talks to the new backend.** So:

- Never remove or rename a function, or add a required argument, in the same release as the site change
  that stops using the old form. Remove in a later release.
- Schema changes are additive: optional fields, new tables, new indexes, new values in a status list.
  Removing a field or narrowing a type is a second release after no row holds the old shape.

## Rolling back

The site and the backend roll back separately.

| | How | Careful |
|---|---|---|
| Site only | Vercel › selestial-ai › Deployments › the last good production deployment › **Promote** (or Instant Rollback). | Do **not** use "Redeploy" on an old commit: it re-runs the build and pushes that old backend code to live. |
| Backend only | From a checkout of the last good commit, with the production deploy key: `npx convex deploy`. Functions return to that commit. | The schema must still accept every row written since. Additive changes make this safe; a field the newer code wrote stays in the rows and is ignored. Data is not rolled back. |
| Both | Site first (Promote), then backend. | Same as above. |
| Data | Restore from a backup into a **new** deployment and verify there (docs/operations/05-recovery-runbook.md). | Never restore over production as a test. Reconcile payments and messages with the providers before releasing restored work. |

After any rollback, open `/staff/operations`: checks should be fresh, alerts delivering, and `/health` 200.

## Before the first pilot company

Run, in this order, against the test backend and then once on production with a controlled company:

1. Buy the plan with a Stripe test card; confirm one subscription, the credits, and one invoice.
2. Refresh and revisit; confirm no second subscription.
3. One AI answer in Chat: one hold, one charge. Stop one mid-way: hold released.
4. Add messaging funds; send one text and one email to `TEST_RECIPIENTS`; compare the balance with the statement.
5. Fail a payment with Stripe's failing test card; confirm the lock, "I've paid, check again", and the unlock on payment.
6. Connect a Gmail mailbox; confirm the address confirmation step; disconnect.
7. Texting (production only, with approval): registration, one number, one text out, a reply, STOP, START.
8. One visit through Dispatch on a real phone: offer, accept, check-in, photos, submit, send back, resubmit, close.

Record each result, with date and commit, in `readiness.md` under its gate.
