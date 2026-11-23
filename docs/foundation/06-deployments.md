# Deployments

Two Convex backends, with one rule: **only `main` changes what the live site runs on.**

| Backend | Used by | Who deploys to it |
|---|---|---|
| Live: `stoic-gazelle-731` (Convex's production deployment) | www, app and link.selestial.io (Vercel production). Real companies' data. | Only Vercel's production build, on a merge to `main` (`scripts/build.mjs`). Never by hand. |
| Test: `terrific-avocet-835` (a development deployment) | Work in progress: Claude sessions, local development, trying a branch. | Anyone, any branch, any time. |

Until November 2026 the live site ran on `terrific-avocet-835`. It moved to the production deployment so that
nothing users touch lives on a development deployment; see "The move to the production deployment" below.

Why: both used to share the live backend, and `npx convex deploy` from one branch replaces every function
and index another branch had deployed. On November 18, 2026 a deploy of `main` removed unmerged onboarding
work (`websiteReads`, `importedRecords`) that had been deployed to the live backend from a branch. No data
was lost, but the work had to be redeployed.

## How a change reaches the live site

1. Merge the pull request to `main`.
2. Vercel's production build runs `npm run build`, which is `scripts/build.mjs`. With `VERCEL_ENV=production`
   and `CONVEX_DEPLOY_KEY` set, it runs `npx convex deploy --cmd "node scripts/next-build.mjs"`. Convex's
   order is: **run the command first** (the site build, given the live backend's address), **then** type-check
   and push the functions and schema (`npx convex deploy --help`, steps 1 to 5; `convex/src/cli/lib/deploy2.ts`).
   Vercel publishes the built site only after the whole script exits successfully.
   - The site fails to build: nothing is pushed, the previous site and backend stay live.
   - The backend fails its type check or schema check: the build fails, the site just built is not published,
     and the previous site and backend stay live.
   - Both succeed: the new backend is live at once; the new site follows when Vercel finishes publishing.
3. Preview builds (pull requests) and local builds only run `next build`. A preview never deploys a
   backend, even if it can see the key.

Without `CONVEX_DEPLOY_KEY` in Vercel's production settings, step 2 builds the site only, as before, and the
backend has to be deployed by hand from `main`.

### The gap in every release: new backend, old site

The backend goes live before the site does. For the minute or two until Vercel finishes publishing, and for
as long as anyone keeps a tab open, **the previous site calls the new backend**. If Vercel's own publishing
step fails after the push, that state lasts until the next successful build. Nothing in the tooling closes
this gap, so every release has to be safe inside it:

- **Never remove or rename a function, or add a required argument, in the same release as the site change
  that stops using the old shape.** New arguments are optional; a renamed function keeps its old name
  working for one release.
- **Removals take two releases.** First ship the site that no longer calls it; in a later release, remove it.
- **Schema changes are additive.** New tables and optional fields only. Narrowing a type, removing a field
  or making one required waits until no deployed code writes the old shape, and is its own release.
- **Return shapes only grow.** The previous site must still be able to read what a query returns.
- A change that cannot be made compatible is announced, shipped at a quiet time, and followed by asking
  open tabs to reload.

The same rule is what makes a rollback possible (`docs/operations/05-recovery-runbook.md`): promoting the
previous site in Vercel leaves the new backend running, and it only works if that backend still serves the
previous site.

A Vercel **Redeploy** of an older production commit is not a rollback: it runs this build again, so it
pushes that commit's **old backend code** to the live backend. Use **Promote** (or Instant Rollback) to go
back to an earlier site without touching the backend.

## One-time setup (the Owner, in the dashboards)

1. **Create the test backend.** In the Convex dashboard, open the project that holds `terrific-avocet-835`,
   open the deployment menu and create a new deployment (for example `work-in-progress`). Or, signed in to
   Convex: `npx convex deployment create dev/work-in-progress --type dev`.
2. **Copy its settings.** In the new deployment's Settings › Environment Variables, add the variables the
   code needs. Use test keys (Stripe test mode, a test email sender), never the live ones: messages and
   payments from the test backend must not reach real people.
3. **Give work-in-progress sessions the test key.** In the new deployment's Settings, generate a deploy key.
   In Claude's environment settings (environment "Selestial"), replace `CONVEX_DEPLOY_KEY` with it. Sessions
   on that environment then deploy only to the test backend.
4. **Give Vercel the live key.** In the live deployment's Settings, generate a deploy key. In Vercel ›
   selestial-ai › Settings › Environment Variables, add `CONVEX_DEPLOY_KEY` with it, for **Production only**
   (not Preview, not Development).
5. Merge anything to `main` and check the production build log for "Production build: deploying the Convex
   backend". From then on, nobody deploys the live backend by hand.

## Isolation: what a backend that is not production can do

Production is decided by the deployment's own name (`convex/lib/environment.ts`, `PRODUCTION_DEPLOYMENTS`).
Every other deployment (the test backend, a restored copy, anyone's own) is not production without
any setting, and:

- sends email (Resend), texts (Telnyx) and mailbox mail (Gmail) only to the addresses in its
  `TEST_RECIPIENTS` setting (comma-separated emails and phone numbers); everything else is refused before it
  reaches the provider;
- refuses every Telnyx call that buys or files anything (numbers, brands, campaigns); lookups still work;
- never writes to a company's Google account: calendar events, Business Profile review replies, Ads
  campaigns and conversion uploads, Drive and Sheets files, and notification channels are refused at the one
  place every Google call goes through (`convex/lib/google/http.ts`, `writesToGoogle`). Signing in, refreshing
  a token and every read still work. A Google job that would write is settled once as "Not run: this is not
  the production backend", never retried and never counted as failed. There is no opt-in for a test Google
  account: the call wrapper does not know which account a token belongs to, so none was added;
- ignores live Stripe (`sk_live_`/`rk_live_`) and Autumn (`am_sk_live_`) keys, so card payments and
  billing are simply unavailable with them: nothing it does can charge a real card.

**Previews never touch the live record.** `scripts/build.mjs` builds a preview whose `NEXT_PUBLIC_CONVEX_URL`
is the live backend with no backend at all (signed-in and link pages then say Selestial isn't available).
That covers what is decided at build time. Server actions (the early-access form, booking, the unsubscribe
link, trust requests) read the address when they run, and Vercel still gives a preview's server the shared
value, so they apply the same rule again at run time: `serverBackendUrl()` in
`src/lib/app/server-backend.ts` returns nothing when `VERCEL_ENV` is set to anything but `production` and
the address is the live backend's (by name or by `api.selestial.io`). The forms then say they are not open.
Previews today also have no sign-in key (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is Production only), so no one
can sign in on one.

### Still to do in the dashboards (not verified as done)

1. **The test backend.** Step 1 below has not been done, or its key never reached Claude's environment:
   on November 20, 2026 the `CONVEX_DEPLOY_KEY` in Claude's environment "Selestial" was the **live**
   deployment's (`dev:terrific-avocet-835`). Create the test deployment, give it test provider keys and
   `TEST_RECIPIENTS`, and replace the key in Claude's environment with the test deployment's (step 3).
   Until then a session could deploy the live backend by hand; none has since the split.
2. **Working previews.** In Vercel › selestial-ai › Environment Variables, give **Preview** its own
   `NEXT_PUBLIC_CONVEX_URL` (the test backend's address) and a development Clerk publishable key. Today the
   one value is shared by Production and Preview, so previews are built without a backend.
3. **Production credentials, Production only.** `CONVEX_DEPLOY_KEY` and `CONVEX_PROD_DEPLOY_KEY` are
   Production only (good). Several provider keys in Vercel (`TELNYX_API_KEY`, `STRIPE_SECRET_KEY`,
   `CLAUDE_API_KEY`, `GOOGLE_PRIVATE_KEY`, others) are set for **Production and Preview**. The site itself
   does not use most of them (the backend holds its own), but they should be Production only, or test keys
   for Preview.

## Notes

- Pull request previews use the live backend's address for reading (`NEXT_PUBLIC_CONVEX_URL`), so a preview
  of a branch with new backend functions shows errors on those pages until it is merged. Convex preview
  deployments (a backend per preview) fix that and need a paid Convex plan.
- Older docs that say "run `npx convex deploy`" (for example `docs/ai/02-status.md`) describe what a deploy
  does. On the live backend it now happens through the merge, not by hand.

## The move to the production deployment (November 2026)

The live site ran on the development deployment `terrific-avocet-835` while Convex's production deployment
`stoic-gazelle-731` sat empty, with some providers already pointed at it (the Stripe Connect webhook, the
Telnyx messaging profile, a Resend webhook). The move puts every user-facing thing on `stoic-gazelle-731`.

Order of the cut-over (each step checked before the next):

1. **Settings.** `stoic-gazelle-731` carries the same values as the live backend for everything that reads
   stored data: `MAILBOX_TOKEN_KEY` (sealed tokens and tax IDs), `ACTION_LINK_SECRET` and `PUBLIC_FORM_SECRET`
   (links and forms already sent), and the provider keys. Webhook secrets are each provider endpoint's own:
   they match the endpoint that points at `stoic-gazelle-731`.
2. **Code.** The current `main` is deployed to `stoic-gazelle-731` before any data, so the import is checked
   against today's schema. Until the switch it is not production by name, so it sends nothing.
3. **Rollback point.** A backup of each deployment, with file storage.
4. **Data.** A snapshot of `terrific-avocet-835`, with file storage, imported into `stoic-gazelle-731`. Record
   and file IDs are kept, so every reference and signed link still works. Row counts are compared table by
   table. (There were no pending scheduled functions to carry over.)
5. **Switch.** Vercel's production `CONVEX_DEPLOY_KEY` becomes the production deployment's key and the pull
   request that names `stoic-gazelle-731` in `PRODUCTION_DEPLOYMENTS` merges: the build deploys the backend
   and builds the site against it. From that moment `terrific-avocet-835` is a test backend: it sends only to
   `TEST_RECIPIENTS` and ignores live Stripe and Autumn keys.
6. **Old addresses.** `MOVED_TO=https://stoic-gazelle-731.convex.site` on `terrific-avocet-835`: Unsubscribe
   buttons, crew photo links, OAuth returns and provider webhooks that still carry the old address are passed
   on unchanged and answered by the live backend (`forwardIfMoved`, convex/lib/builders.ts).
7. **Providers** pointed at `https://stoic-gazelle-731.convex.site`: Stripe (Connect `/webhooks/stripe`, and
   `/webhooks/stripe-billing`), Resend (`/webhooks/resend`; the old endpoint removed), Telnyx messaging profile
   (`/webhooks/telnyx`), Autumn (`/webhooks/autumn`), Google Cloud (OAuth redirect URIs `/oauth/google/callback`,
   the Pub/Sub push subscription `/webhooks/google/pubsub`), Jobber (`/oauth/jobber/callback`), and any Google
   Ads lead form (`/webhooks/google/leads`).
8. **Claude's environments.** "Selestial Production" keeps the production key (it now reads live data);
   "Selestial" keeps the `terrific-avocet-835` key (the test backend). After a week with no rollback, the test
   backend's copy of real data is cleared and its provider keys replaced with test keys.

## Addresses: what the app connects to, and what people see (November 22, 2026)

A Convex custom domain serves one side only: the client API (the app's WebSocket) or HTTP actions (webhooks,
links, the future public API and MCP).

| Address | Serves | Used for |
|---|---|---|
| `https://stoic-gazelle-731.convex.cloud` | Client API | The app's own connection. Production builds always use the deployment's own address (`scripts/convex-address.mjs`, run by `scripts/next-build.mjs`), whatever custom domain Convex names. The build log says when it replaced one. |
| `https://api.selestial.io` | **Client API since at least November 23, 2026** (answers `/version`, not `/health`) | Was meant for the HTTP routes people see. Because it serves the client API, nothing is built on it unless `PUBLIC_API_ORIGIN` is set: webhooks and review-copy links use `<name>.convex.site` (`publicApiOrigin()` in `convex/lib/environment.ts`). To use it for HTTP routes again, point the custom domain at HTTP actions in the Convex dashboard, check `https://api.selestial.io/health` answers 200, then set `PUBLIC_API_ORIGIN`. |
| `https://stoic-gazelle-731.convex.site` | HTTP actions | What providers are registered with (OAuth returns, Stripe, Telnyx, Resend, Google Pub/Sub). Unchanged. |

On November 22 the build was handed `api.selestial.io` as the app's address while that domain served HTTP
actions, and no signed-in screen loaded. The guard prevents that. Production detection also recognises the
custom domain (`DEPLOYMENT_DOMAINS`), so a backend whose `CONVEX_CLOUD_URL` is the domain is still production.
Staff can check both in the readiness panel on `/staff/texting` ("Production detection", "Public API address").
