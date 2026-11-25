# Selestial Founding Access (beta.selestial.io)

Built November 25, 2026 on `claude/selestial-founding-access-page-byf60g`. Customer-facing name: **Selestial
Founding Access**. The word "beta" appears only in the host name.

## Offer terms: where they come from

Founding Access is the **existing early-user offer** under a customer-facing name. No new commercial term was
added. Sources: `convex/lib/billing/catalog.ts` (`EARLY_OFFER`, `EARLY_BONUS_AGENTS`, `PLANS`),
`convex/lib/billing/earlyOffer.ts`, `billing/autumn.config.ts`, docs/billing/README.md "Early-user offer"
(the Owner's decisions of November 22–23, 2026), and rate card `msg-2026-11`.

| Term | Value | Status |
|---|---|---|
| Founding price | $199/month (Autumn plan `operate_early`) | Approved in code |
| Duration | First 12 monthly billing periods, counted from the first paid period | Approved in code |
| Renewal | Moves automatically to Operate at $299/month; one email and in-app notice ~30 days before | Approved in code |
| Trial | None | Approved in code |
| Capacity | First 25 companies whose **first plan payment succeeds** | Approved in code |
| Bonus | Quality agent, kept after the 12 months while a plan is active | Approved in code |
| Cancel and return | Cancel stops renewal at period end; a returning company pays $299 | Approved in code |
| Texts / email | Prepaid messaging balance: 2.5¢ out / 1.5¢ in per segment, 0.2¢ per email recipient, Gmail included, $3/mo number, registration at cost | Approved rate card |
| AI credits | "A monthly allowance". **No figure shown: no allowance is approved** (`SELESTIAL_OPERATE_CREDITS` is set per environment) | **Decision pending** |
| Enrollment window | 90 days, shared, set once by staff | Built; **start date pending** |
| Setup / support | Setup conversation, guided CSV import, review help, draft services/booking page, email support. **No response time, no "priority support", no "free migration"** | **Commitment level pending** |

Offer record: `convex/lib/founding/offer.ts` (`FOUNDING_OFFER`: id `founding-access`, version `2026-11-25.1`,
display timezone `America/Chicago`, capacity, billing references). Raise `version` whenever a customer-facing
term changes; each reservation and claim keeps the version it was made under (`earlyOffers.offerVersion`,
`foundingClaims.offerVersion`).

## The 90-day countdown

- Stored once in `foundingCampaigns` (status `draft | open | closed`, `enrollmentStartsAt`, `enrollmentEndsAt`,
  `displayTimezone`, who activated). Set **only** by `founding:activate` (staff with `billing.adjust`, who must
  type the offer version). A second call is refused: the window cannot be restarted or moved. Nothing starts it
  on page load, sign-up, deploy, local storage or per visitor.
- `founding:activate` is refused unless billing is connected and `EARLY_OFFER=on`, so the page never invites
  claims checkout can't charge.
- The page renders from the server's view (`src/lib/founding/view.ts`, server time from the Next.js server, not
  a cached Convex query). The browser measures its clock offset against `/api/founding/status` and counts down
  to the same stored timestamp. Minute resolution, no seconds, not a live region, no flashing.
- At the deadline the timer stops at zero, the CTA becomes "Start on Operate", the claim form is replaced, and
  the **backend refuses**: `startClaim` returns `closed`, and `eligibility()` in the billing rule returns
  `enrollment_closed`, so a purchase confirmed after the deadline is re-previewed at $299 before any charge.
- Deadline during checkout: a place reserved (purchase confirmed) before the deadline is honoured for its 24-hour
  reservation (`RESERVE_MS`). Confirming after the deadline gets the full price, shown before charging.
- Capacity during checkout: unchanged billing rule. `confirmIntent` reserves atomically; the loser is shown $299.
- Staff can close early with `founding:close`. Existing founding customers keep their terms in every case.

## The counter

Public label: **"[N] cleaning companies have joined"**, with "Counts companies whose first founding payment has
been confirmed."

- N = unique companies with an `earlyOffers` row in `claimed` or `ended` (it was claimed), in the deployment's
  own billing environment, excluding companies staff flagged `excludeFromCounts` (test/demo/staff) and deleted
  companies. A row is claimed only when Autumn's record shows `operate_early` active (`storeAccount`), never from
  a browser return. One row per company and environment makes duplicate/out-of-order webhooks idempotent.
- "Places left" = 25 − the billing rule's own used count (claimed + ended + live reservations), shown only while
  enrollment is open.
- If the backend can't be reached the page shows "unavailable": no number, no countdown, no claim.
- Internal funnel (`founding:funnel`, staff): leads (claims started), accounts (claims linked to a company),
  checkouts started (places reserved), verified claims, active founding subscriptions.

## Claim flow

1. Public page form: company name, booking software, people who clean, first priority (`startClaim`, via a
   server action holding `PUBLIC_FORM_SECRET`; random claim key; UTM source/medium/campaign kept only if plain).
2. Redirect to `/signup?next=/app/founding?claim=<key>` (workspace host). Existing users sign in from there;
   signed-in users skip straight through. Name and email come from the account, not the form.
3. Company creation is prefilled from the claim (`claimPreview`). `/app/founding` is shown full screen during
   setup, links the claim (`attachClaim`; bound to the first person; key removed from the URL), and seeds setup:
   priority, "people who clean", tools.
4. "See the exact charge" opens the **existing** purchase dialog (`billing.startPlanChange` → `IntentDialog`).
   The server decides $199 vs $299.
5. States: access claimed / payment still processing / ready to pay / something needs attention, from billing only.
6. On verified claim: one `founding_claimed` owner notice (email via the notice system, deduplicated by key).

## Visuals

No product screenshots are used on the page. The hero's agent desk (`src/components/founding/agent-desk.tsx`)
and the drawn illustrations (`src/components/founding/illustrations.tsx`: a day in Selestial, the four
walkthrough steps, the guided import) show work the product supports today with made-up names and figures,
each labelled "Illustration · demonstration data". The header matches the main site's floating nav.

## Analytics

Client events (only if a consent choice already loaded a tool; no personal data): `founding_page_viewed`,
`founding_cta_selected`, `founding_signup_started`. Account created, checkout started, claim verified and
onboarding are measured server-side (`founding:funnel`, event log), because the workspace never runs trackers.

## Domain and routing

`src/lib/hosts.ts` has a `founding` role read from `FOUNDING_ORIGIN`. On that host `/` is rewritten to
`/founding` (indexable), `/founding` redirects to `/`, sign-up/sign-in/workspace go to `APP_ORIGIN` keeping the
query, and legal/other pages go to the public site. The public and app hosts redirect `/founding` to the founding
host once it is set. Previews and hosts no setting names serve `/founding` directly.

**Verified November 25, 2026 (read-only):** `beta.selestial.io` is **not attached** to Vercel project
`selestial-ai`, and has no DNS record. DNS for `selestial.io` is at GoDaddy (`ns69/ns70.domaincontrol.com`).
**It is not live.**

To go live (needs the Owner's go-ahead):

1. Vercel › `selestial-ai` › Domains › add `beta.selestial.io` (production).
2. GoDaddy DNS for `selestial.io`: `CNAME beta → 1d759f65bace6df9.vercel-dns-016.com.` (Vercel's recommended
   value for this project; `cname.vercel-dns.com.` also works).
3. Vercel › Environment Variables (Production): `FOUNDING_ORIGIN=https://beta.selestial.io`. Redeploy.
4. Clerk: no change needed. Sign-in stays on `app.selestial.io`; `beta` only links to it.
5. Verify: TLS issued, `https://beta.selestial.io/` returns 200 with the founding page, `/terms` redirects to
   `www`, `/signup?next=...` redirects to `app` with the query intact, `/api/founding/status` returns JSON.

## Before enabling live claims

1. `cd billing && npx atmn push` against sandbox, then production, so `operate_early` exists ($199, group
   `selestial`, no trial, Operate's items). Then `EARLY_OFFER=on` on `stoic-gazelle-731`.
2. Decide the open terms above (credit allowance figure, setup/support commitment, enrollment start date).
3. Flag Selestial's own test/demo companies with `founding:setExcludedFromCounts`.
4. Run one sandbox purchase end to end and compare with `convex/lib/billing/autumn.ts`.
5. Staff run `founding:activate` with the offer version. That instant starts the shared 90 days.

## Tests

`convex/founding.test.ts` (window set once, 90 days, refuses restart; claims only while open; claim → company →
setup seeding → checkout → verified count; duplicate syncs count once and notify once; reservations, released,
other-environment and excluded companies never counted; server refusal after the deadline mid-checkout;
founding customers keep terms after close; staff close), `src/lib/founding/view.test.ts`, `src/lib/hosts.test.ts`
("the founding host"). Visual checks: desktop 1440 and iPhone 13, open / closed / unavailable states, sticky CTA
hides over hero, form and footer and while the cookie notice is open, keyboard order through the form.
