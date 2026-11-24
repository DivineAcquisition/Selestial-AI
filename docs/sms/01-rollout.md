# SMS infrastructure: what's built, how it was checked, and how to turn it on

Companion to `00-architecture.md`. Branch `claude/loving-clarke-8ys51f`, checked 2026-11-24. Production is
`stoic-gazelle-731` (`api.selestial.io`).

## 1. What was built

| Area | Where | What it does |
|---|---|---|
| Company isolation | `convex/texting.ts` (step D0), `lib/messaging/telnyxAccount.ts` | Each company gets its own Telnyx messaging profile before its number is bought, with STOP/START/HELP answers in its own words. Telnyx keeps opt-outs per profile, so one company's STOP never blocks another. |
| One lifecycle, honest words | `lib/messaging/lifecycle.ts`, `lib/messaging/planning.ts` | Every screen says the same thing: Scheduled, Queued, Waiting until sending hours, Add funds to continue, Paused by the owner, Sending, Provider accepted, Delivered, Delivery not confirmed, Not known whether it went, Failed, Recipient opted out, Canceled, Not sent: setup needed. Each refusal has a class (hold, suppressed, setup, canceled, policy, provider). |
| Provider correctness | `lib/messaging/telnyx.ts`, `convex/messaging.ts` | 15 s send timeout (left unconfirmed, checked under the same idempotency key, never resent blindly); `delivery_unconfirmed` kept; 40300 recorded as a `provider_block` suppression; Telnyx's own keyword answers not repeated; "YES" no longer lifts a STOP; a reconcile that would send different words stops for a person. |
| Charging rule | `convex/messaging.ts` `reconcileCharge` | Charged once the carriers have it (even if undelivered); refunded when it never reached them (`sending_failed`, `expired`, 40014). |
| Owner controls | `convex/companies.ts`, `convex/businessTexting.ts` | Pause all texting (held, never refused; resume sends what waited), the emergency stop now includes Quality, a controlled test text to the Owner's own confirmed phone. |
| Sending hours | `lib/messaging/policy.ts`, `lib/messaging/recipientTime.ts` | 8 AM–9 PM in the recipient's own time for every text to people outside the company; the company's quiet hours can narrow it. |
| Throughput | `lib/messaging/throughput.ts` | Urgent / standard / bulk lanes; per-company and per-number per-minute limits; urgent answers never wait. |
| Platform texts | `convex/platformSms.ts`, `lib/platform/*` | Selestial's own texts kept apart from every company (never charged to one): Clerk code delivery with limits and pumping detection, security notices, staff alerts, "no replies" answers. |
| Clerk | `convex/http.ts` `/webhooks/clerk`, `scripts/auth-doctor.mjs` | `sms.created` (Svix-verified) texted from the code sender when Clerk isn't delivering it; the doctor lists and switches template delivery. |
| People's phones | `convex/myPhone.ts`, `convex/staffAlerts.ts` | A person's own confirmed phone for their notices; a staff member's phone for critical alerts. Neither is a sign-in method. |
| My notifications | `src/components/app/settings/text-preferences.tsx` | "Text me about": categories, quiet hours, confirmation flow. |
| Business texting | `src/components/app/texting/business-texting.tsx` | The eight states from real records, number and provider, routes per agent, blockers with next steps, week's outcomes, pause and test. |
| Inbox | `src/components/app/screens/inbox.tsx`, `convex/smsConversations.ts` `reply` | A reply box through the shared policy, with a segment and cost estimate; replying takes the conversation and holds the client's too. |
| Links | `convex/links.ts`, `lib/builders.ts` | A second tap on Accept answers with the accepted job instead of an error. |
| Operations | `convex/providerHealth.ts`, `lib/operations/detectors.ts`, `convex/smsOps.ts`, `src/components/staff/sms-ops.tsx` | Hourly read-only Telnyx probe (key refused, not answering, balance low); platform SMS check (pumping, breaker, failing codes); Staff › Texting operations. |

## 2. Which workflows are live once deployed

- **Company texts** (Dispatch, Recruiter, Sales, Retention, Quality, Finance, client conversations): already sending;
  now with recipient-local hours, the owner's pause, throughput limits, honest states and opt-out sync.
- **Inbox replies, test texts, Business texting panel, Texting operations:** live on deploy.
- **Per-company profiles:** for companies set up from now on. Numbers bought before stay on
  `TELNYX_MESSAGING_PROFILE_ID` until moved (step 8 below).
- **Selestial's own texts (codes, notices, alerts, personal texts):** built, but inactive until the two toll-free
  senders are verified and set (steps 4–6). Until then Clerk keeps delivering its own SMS, and screens say texts
  to people aren't available yet.
- **Not built, because no product records exist:** Selestial onboarding-appointment and support-ticket texts.

## 3. How it was checked

| Check | How | Live provider? |
|---|---|---|
| Full suite: 168 files, 1,867 tests | `npx vitest run` | No: mock provider and stubbed Telnyx/Clerk/Autumn |
| New: `smsFoundation`, `providerHealth`, `platformSms`, `memberTexts`, `businessTexting` | as above | No |
| Two companies, same number; codes with no credits; wrong/expired/reused codes; duplicate and out-of-order webhooks; timeout after accepting; opt-out while queued; cleaner accepts before reminder; concurrent last-balance sends; agent pause and takeover; invalid/revoked links; registration rejection | existing + new tests (see each file's header) | No |
| Telnyx account | Staff read-only check on production: **API key passed** (reported by the Owner). This session's own key is malformed, so no account data was read from here. | Read-only, production |
| Clerk SMS templates | `GET /v1/templates/sms` on the **development** instance: code templates `can_toggle: false` | Read-only, development |
| Screens | Business texting (ready, blocked, changes needed), My notifications, Inbox with reply, Staff › Texting operations, rendered from the real components with stand-in data at 390 px and 1100 px, light and dark: no console errors, no page-level horizontal scroll. Not checked inside the signed-in app with live data. | No |

**Never verified end to end with Telnyx from this work.** Step 7 is the controlled live test.

## 4. Needed before turning it on

- Telnyx balance of at least $30 (campaign filings are refused below it); $50+ recommended (the alert threshold).
- Two US toll-free numbers for Selestial (codes, notices), each verified (EIN required since 2026-02-17; 1–4 weeks).
- A Clerk webhook endpoint and its signing secret.
- `PLATFORM_SMS_KEY`: a random secret of 32+ characters (keys phone hashes).
- Your own phone for the controlled live test.

Rates: the approved `msg-2026-11` card and `reg-2026-11` registration prices are used; nothing else is priced.

## 5. Known limitations

- **Clerk codes:** if production, like development, doesn't let the code templates be switched, Clerk delivers
  codes (and charges its SMS fee); Selestial delivers only Clerk's security notices.
- **Recipient time zone:** customer property (or its state); otherwise the company's. Area codes are not used.
- **One send path, not one function:** all nine planning copies share `startingState` and the same policy, but
  approval references and template versions are not yet stored on each message.
- **Inbound:** media isn't stored; the thread keeps a 200-character excerpt.
- **Pay links** still have no time limit (unchanged).
- **Selestial's toll-free registration** is filed in the Telnyx portal by hand (content in step 4), not by an
  in-app builder.
- A delivery report for a platform text that arrives before the send settles isn't applied (it stays "sent").

## 6. Activation, in order (production `stoic-gazelle-731`)

1. **Merge and deploy** this branch. Nothing new sends until the settings below exist; existing company texting
   keeps working, with the new rules.
2. **Telnyx:** add funds (≥ $50). In Staff › Texting operations, the Telnyx card should say "Key works" within an
   hour.
3. **Backend settings** (Convex › stoic-gazelle-731 › Environment Variables): `PLATFORM_SMS_KEY`; optionally
   `TELNYX_BALANCE_ALERT_DOLLARS`, `SMS_COMPANY_PER_MINUTE`, `SMS_NUMBER_PER_MINUTE`, `PLATFORM_SMS_CODES_PER_HOUR`.
4. **Selestial's senders, in the Telnyx portal:**
   - Buy two toll-free numbers. Create two messaging profiles, "Selestial codes" and "Selestial notices", webhook
     `https://api.selestial.io/webhooks/telnyx`, US only; put one number on each.
   - File toll-free verification for each, as **Selestial (the legal entity on the EIN)**, website
     `https://selestial.io`. Codes: use case "2FA / one-time passcodes", sample "Selestial: 123456 is your
     verification code. It expires in 10 minutes." Notices: use case "Account notifications", sample "Selestial ·
     Alpha Cleaning: an agent is waiting for your approval. Open Selestial to see it." Opt-in: a person enters their
     own phone in Selestial and confirms it with a code; link the privacy policy and SMS terms.
   - Never use the cleaning-company setup for this (it now refuses Selestial's details).
5. **Once both say Verified:** set `PLATFORM_SMS_CODES_FROM`, `PLATFORM_SMS_CODES_PROFILE_ID`,
   `PLATFORM_SMS_NOTICES_FROM`, `PLATFORM_SMS_NOTICES_PROFILE_ID`.
6. **Clerk:** add a webhook endpoint `https://api.selestial.io/webhooks/clerk` for `sms.created`, and set its
   signing secret as `CLERK_WEBHOOK_SECRET`. Run `node scripts/auth-doctor.mjs` with production keys. Only after
   step 5, run it with `--sms-selestial --live`; to fail back, `--sms-clerk --live`.
7. **Controlled live test (your own phone only):**
   - My notifications › Text me about: confirm your phone (a code arrives from the codes number).
   - Staff › Texting operations › My alert phone: confirm it.
   - Business texting (a company with an active number): Send me a test text; it should show Delivered.
   - Text STOP to that business number from your phone: one confirmation, the suppression appears, a test text is
     refused as "Recipient opted out". Text START: it lifts.
   - Text the notices number: one "this number doesn't take replies" answer.
8. **Numbers bought before this change:** in Telnyx, list numbers on `TELNYX_MESSAGING_PROFILE_ID`. For each
   active company, create its own profile (or re-run provisioning) and move the number, then set the company's
   `messagingProfileId`. Until then those companies share opt-outs.
