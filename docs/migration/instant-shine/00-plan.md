# Bay Area Cleaning Pros: migrating from Instant Shine

Engineering report and runbook. **Status: built and dry-run. Nothing has been imported into a production
Selestial workspace, nothing was written to Instant Shine, and no customer, cleaner or provider was contacted.**

Code: `scripts/migration/instant-shine/export.mjs` (exporter), `convex/lib/migration/sources/instantShine/`
(catalog, adapter, pricing and pay parity, fixtures, dry run), `convex/migrationSources.ts` (staging into the
guided migration), `src/components/app/migration/source-instant-shine.tsx` (owner review panel).

## 1. Source and destination: what was verified

Live facts were read on 2026-11-24 with read-only SQL through the Supabase connector. Code facts come from the
`DivineAcquisition/instant-shine-dash` repository at `cffc956`.

| Question | Answer | How it was established |
|---|---|---|
| Production source | Supabase project `rfgurianvyrgonjvvsnc` ("BayAreaCleaningPros"), Postgres 17 | **Live:** the repo's `supabase/config.toml` and client point to it, and the project is reachable |
| Schema drift | 68 live tables match the active migrations exactly. The generated TypeScript types lack 10 of them (`va_quotes`, `service_areas`, all `jobber_*` and `ghl_private_credentials`) and the 26 Jobber columns on `bookings`. Three Jobber pg_cron jobs defined in a migration never got scheduled. About 75 tables named in code don't exist (legacy paths). | **Live** table list compared with the migrations and types |
| Business location and clock | Houston Bay Area, Texas: 103 active ZIP codes (77001–77099 and 77520–77523), America/Chicago, closed Sundays, arrival windows from 8 AM to 4 PM | **Live** settings rows |
| Volume | 20 customers (11 are test records), 51 recurring clients, 11 payroll contractors and 12 directory subcontractors (the 11 contractors overlap by id, plus 1 directory-only entry), 5 bookings, 1 assignment. Zero rows in orders, payroll jobs, agreements, quality, opt-outs and files. | **Live** exact counts |
| Who runs scheduling today | **Not Instant Shine.** No booking is in the future. All 5 bookings are past and none was completed. The 51 recurring clients were loaded once on 2026-04-24 and have no next-visit dates. Nothing in Instant Shine generates recurring visits. The live schedule is kept elsewhere. | **Live** data plus code |
| Messaging | Three active crons send visit reminders, retries and photo links. Every reminder since September failed. The last delivered message was one booking confirmation on 2026-09-02. HighLevel is connected (`token_ok`, auto confirmations and balance reminders on). | **Live** `cron.job`, logs and HighLevel config |
| Jobber | Disconnected and never connected: no credentials, status `disconnected` | **Live** |
| Payments | A Stripe account whose id ends `…KugxYY6ADi`, taken from PaymentIntent ids. It isn't any Stripe account connected to this workspace (Divine Acquisition, Novara, Vistrial), so it is presumably the business's own. Deposits are 50%, and the balance is charged off-session when staff mark a visit complete. No subscriptions are in use. | **Live** ids plus code |
| Selestial destination | Production Convex `stoic-gazelle-731`. **No Bay Area company or owner account exists:** production Clerk has two users, neither the Bay Area owner. | **Live** Clerk listing |
| Previous imports | None into Selestial, since no tenant exists | Inferred from the above |

**Still needed from you to run the real migration:** the Bay Area owner's email (to create or identify the
tenant and its Owner); her current schedule (next visit and arrival time for each recurring customer, from
wherever she keeps it today); and a decision on who owns payments during the pilot (§7).

## 2. Inventory and dispositions

Every source table has a disposition in `catalog.ts`: A native, B extension, C archive, D retained, E excluded,
each with a reason. A test fails if the exporter and the catalog ever disagree. By family:

| Family | Moves (A) | Waits for the Owner | History (C) | Stays in Instant Shine (D) | Not moved (E) |
|---|---|---|---|---|---|
| Company settings | ZIP codes, hours and time zone, crew pay rule | | Slot counters, checklists | | |
| Customers | Customers; recurring clients become customers | Recurring services (no next visit or time recorded) | | Abandoned online checkouts (21) | Test records (held back, can be included) |
| Pricing | Services as drafts, priced by size bands | Promotion `NEW_CUSTOMER_50`; whether to keep the always-on welcome discount | Quotes and referrals (none at export) | | |
| Operations | Upcoming visits with accepted crew (none at export) | Past visits never marked complete (5) | Event log, payroll jobs | | Legacy orders tables |
| People | Cleaners, once each | Directory-only company-email entry | Restrictions, drops, extra pay (none) | | Sign-in profiles and roles |
| Quality and agreements | Feedback and cases (none) | | Case history | | Divine Acquisition's `contracts` and `companies` (vendor data) |
| Messages | Text opt-outs (none at export) | | Delivery logs | | Send queues (never replayed) |
| Connected systems | | | HighLevel sync log | HighLevel and Jobber configuration | Credentials and OAuth tokens (never read) |

**Ownership:** `contracts` (revenue share, `signed_by_divine`) and `companies` belong to Divine Acquisition's
vendor relationship, not the cleaning business, and are excluded. Divine Acquisition's own admin accounts
(owner and super_admin roles) never become members of her workspace.

## 3. Mapping

- **Identity:** every imported id is `<instance>/<table>/<id>` under the link source `instant_shine`, so two
  tables or two databases never collide. Recurring plans use their own table name (`payroll_recurring_clients:plan`),
  separate from the customer.
- **Cleaners:** the source's trigger gives a payroll contractor and its directory entry the same UUID. They are
  imported once, and both references are kept in the notes.
- **Contacts:** generated placeholders (`<uuid>@bayareacleaningpros.com`, `0000000000`) are dropped, never used
  as messaging destinations. Shared phones and emails are noted on each record and never merged.
- **Statuses:**
  - bookings: completed → history; cancelled → archived with refund and fee; past and not completed → Owner
    review; unpaid web checkout → retained; future scheduled, confirmed or assigned → held visit.
  - assignments: assigned, accepted or completed with `accepted_at` → accepted crew; offered, declined or
    expired → archived, and no offer is re-sent.
- **Time:** `service_date` plus the slot's start time is read in the migration's time zone (America/Chicago),
  and DST is handled by the importer's own conversion. Durations: the source's minutes-or-hours rule.
- **Money:** the accepted `est_price` becomes the visit's price. The deposit, balance, refund and Stripe ids are
  kept in the report, never as an invoice or a collectible balance.
- **Pay:** an accepted crew keeps each cleaner's recorded `share_cents`, provisional or locked. Pay is never
  recalculated.

## 4. What was built in Selestial (reusing the guided migration)

- `migrationSources.stageFile/stageRows/finishFile` stage adapter rows as migration files. From there the
  migration's own check, review, import, release and undo apply unchanged. Staging the same export twice adds
  nothing.
- **Accepted crew transfer:**
  - Each cleaner must already be imported and must not be accepted on an overlapping visit; all checks run
    before any write.
  - Assignments are recorded `accepted` with the source's pay snapshot and acceptance time. The `imported`
    provenance marks them as never offered here.
  - No offer, message or link is sent.
  - Undo removes an untouched imported crew together with its visit.
- **Held leaks closed:** Google Calendar sync and Quality's pre-service check no longer act on visits a
  migration is holding.
- Owner-only `applyImportedPay` sets the 40% share on imported contractors who have no pay yet. Combined with
  the existing crew pay rule "split by crew", this reproduces the source's pool exactly, except that Selestial
  rounds to the nearest cent where the source rounds down (≤1¢ per cleaner on new visits).
- The owner review panel shows:
  - category cards, held-back records and money as recorded;
  - settings with Owner-only apply buttons;
  - who runs what, and outstanding links.

## 5. Tests and dry run

| Check | Result |
|---|---|
| Price parity: every tier edge for standard, deep, move-in/out and recurring | Selestial's quote equals the source list price; every estimate-only size is a walkthrough, never $0 |
| Discount applied once; deposit and balance split; referral never on recurring | Holds for every tier and offer |
| Pay: $200 job → $80 pool → $40 each; floors; Selestial within 1¢ | Holds |
| Adapter on de-identified fixtures (all 12 pilot cases) | Every source row has exactly one outcome; deterministic |
| End-to-end pilot through the real importer (fixtures) | Opt-out suppression applied; two properties for a multi-address customer; accepted crew with $52.40 each and acceptance time; 8:00 AM Central → 14:00 UTC; history kept; no plan invented; nothing sent or offered; a second import adds nothing; other tenants see nothing; undo removes the crew |
| **Dry run on the live snapshot** (pseudonymized in the database; stored outside Git) | All 23 exported tables balanced. 60 customers and 11 cleaners staged; 12 records held back (11 test customers, 1 company-email directory entry); 51 recurring services and 5 past bookings wait for the Owner |
| **Pilot import of the live snapshot** (in-memory Selestial) | 60 customers, 53 properties, 11 cleaners (onboarding, held) created. All 51 recurring services wait for a next visit and start time; 1 also lacks an address. 0 visits, 0 messages, 0 offers |

Run the dry run again with
`INSTANT_SHINE_SNAPSHOT=<file outside the repo> INSTANT_SHINE_TODAY=<YYYY-MM-DD> npx vitest run convex/lib/migration/sources/instantShine/dryrun`.

**Money at snapshot:** 5 bookings, $1,050.79 booked in total.
- 1 has a deposit paid: a $230.87 deep clean on 2026-09-02, $58.00 deposit captured in Stripe, $172.87 balance
  never recorded as collected. The Owner decides whether the visit happened.
- 4 are unpaid checkouts totalling $819.92.

## 6. Gap report

**Launch blockers (need you):**
1. Create or identify the Bay Area tenant and its Owner in Selestial production (her email).
2. Her actual current schedule: the next visit and arrival time for the 51 recurring customers, and any
   one-time visits. Instant Shine doesn't hold them.
3. Her service area is broader than Instant Shine's list: 22 customers are at ZIP codes outside it (Dayton,
   Crosby, Mont Belvieu, La Porte, Pearland…). Confirm the real area before applying it.
4. Decide the payments owner for the pilot (§7). Until then Instant Shine's Stripe keeps charging.
5. Messaging: HighLevel auto-confirmations and balance reminders are on in the source. They must stay the only
   sender until texting moves.

**Later improvements:** binary import of agreement PDFs and job photos (both buckets are empty today);
historical message import (only failed reminders exist); promo and referral tables in Selestial; generic CSV
identity namespacing for other sources; a source-adapter path for files larger than 5,000 rows.

**Source security issues found (not changed):**
- The anon key can read customers (all personal details) and can update customers and partial bookings.
- `store-service-agreement` accepts unauthenticated posts.
- `ghl-webhook-handler` and `sync-calendar-busy-slots` have no signature check.
- Provider secrets sit in plain-text tables.

Recommend restricting these RLS policies in Instant Shine now, independent of the migration.

## 7. Who runs each workflow

| Workflow | Now | During the pilot | After cutover |
|---|---|---|---|
| Customer records | Instant Shine and her real scheduling tool | Both. Selestial holds the imported copy; edits are made in one place, agreed per customer. | Selestial |
| Schedule and crews | Her real scheduling tool (not Instant Shine) | That tool. Selestial's imported visits stay held. | Selestial, per released visit |
| Recurring generation | Nothing automatic | Nothing in Selestial until plans are confirmed and released | Selestial |
| Reminders and photo links | Instant Shine crons (currently failing) | Instant Shine only, for its own visits | Selestial; switch the crons off first |
| Customer messages | HighLevel (auto confirmations and balance reminders) | HighLevel only | Selestial texting once set up; switch HighLevel automations off first |
| Payments | Instant Shine's Stripe account | Instant Shine's Stripe only | Selestial only after a verified payments connection; never both |
| Online booking | Instant Shine `/book` | Instant Shine | Selestial booking page |
| Jobber | Not connected | Keep disconnected; never enable alongside Selestial | — |

## 8. Cutover and recovery runbook

1. **Tenant:** create or identify the company and Owner. Record the company id in the migration ticket; never
   identify the tenant by display name alone.
2. **Export:** take a fresh read-only export (the exporter with a read key, or the connector), stored outside
   Git. Check `consistent: true`.
3. **Stage:** open `/app/migration?from=instant_shine`, load the export, and include any held-back record that
   is real. Stage for review.
4. **Review:**
   - map services to the drafted services;
   - add each recurring customer's next visit and time from her real schedule;
   - decide each past booking;
   - confirm the time zone.
5. **Settings:** the Owner applies the ZIP codes and hours (after adding the missing ZIP codes) and the crew pay
   rule.
6. **Import:** the Owner or a Manager starts the import. Records stay held, and nothing is sent or charged.
7. **Delta:** just before release, take another export and stage it. Known records link by id instead of
   duplicating, and new or changed records appear for review. A record deleted in the source is not deleted
   here; it's listed in the report for the Owner.
8. **Release, by workflow (Owner only):** Team, then Visits, then Plans, each separately. Releasing the
   schedule does not switch on messaging, booking intake or payments.
9. **Switch the source off, per workflow, after the matching Selestial workflow is verified:** Instant Shine
   reminder and photo crons, HighLevel automations, the booking page, and Stripe balance charging last.
   Pending webhook and queue items are drained in Instant Shine before its side is switched off.
10. **Duplicate checks after each release:**
    - no customer has two upcoming visits at the same time across systems;
    - no visit is reminded by both;
    - no balance is charged by both.

**Recovery:**
- Before release, the migration's undo removes untouched imported records, including an imported crew.
- After release, records that were edited, messaged, paid or used are never deleted. Pause the workflow in
  Selestial and hand it back to the source, which was never switched off before verification.
- A database rollback cannot recall a sent message or a completed payment. That is why the senders and charges
  stay single-owner throughout.

## 9. Statement

- **Operational in Selestial after import:** customers, properties, cleaners (onboarding), opt-outs, any
  upcoming visit with its accepted crew, the company's area, hours and crew pay (once applied).
- **Historical:** completed visits; money as recorded (report only); delivery and event logs (export archive).
- **Retained in Instant Shine or its providers:** payments and saved cards (Stripe), abandoned checkouts,
  HighLevel and Jobber configuration, outstanding customer and cleaner links.
- **Not yet migrated:** the live schedule (not in Instant Shine), agreement PDFs and photos (none exist),
  message history (only failed reminders exist), promotions (pending the Owner's decision).
