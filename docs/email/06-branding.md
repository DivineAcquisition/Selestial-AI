# Email branding

Settings › Email & texting › Email branding (`/app/settings/email-branding`). An Owner makes email sent
through Selestial's shared sending domain look like their business, without buying a domain or touching
DNS. It controls real outgoing email: every company email through Selestial passes one render step
(`convex/lib/messaging/companyMail.ts`), and that step applies the branding.

## Pieces

| File | Does |
|---|---|
| `convex/lib/email/branding.ts` | Pure: the curated choices, validation (sender name, colours, closing line, links), resolving saved choices over the company's defaults, the sending-address rules. |
| `convex/lib/email/brandingSchema.ts` | `emailBranding` (one per company, with revision and reply address), `emailSenderAddresses` (unique across companies), `emailBrandingVersions` (immutable). |
| `convex/lib/email/brandingStore.ts` | Company defaults, address assignment, the version a send uses, Reply-To precedence. |
| `convex/lib/email/brandingSamples.ts` | Labelled sample emails for the preview and test email. All invented; links go to example.com. |
| `convex/lib/email/templates/company.ts` | `brandedLetter`: the one renderer for company email through Selestial. Real sends, test emails and the preview call it. |
| `convex/lib/email/kit.ts` | The frame gained three layouts (classic, banner, letter), light or dark header, logo alignment. Without a look it is the classic frame as before. |
| `convex/emailBranding.ts` | The page's query and mutations, reply verification, test email. |
| `src/components/app/settings/email-branding.tsx` | The page: controls left, live preview right; Edit/Preview tabs on phones. |

## Sender

- From: `"<sender name>" <<local>@<shared domain>>`. The shared domain is the domain of the configured
  company sender (`COMPANY_EMAIL_FROM`, then `RECRUITER_EMAIL_FROM`, then `EMAIL_FROM`). Nothing an owner
  types becomes an address.
- The local part is made from the company name (`bay-area-cleaning-pros`), assigned on first save or
  first send, unique across all companies (`-2`, `-3`… on a collision), never one of the reserved names
  (postmaster, support, noreply, selestial…). It never changes, even after a rename, and is kept after a
  company is deleted so it is never reissued.
- The sender name defaults to the company name. One line, 2–60 characters, no quotes, angle brackets,
  backslash, `@`, semicolon or web address, and not "Selestial". The display name is cleaned again when
  the header is built.
- A workflow that named its own sender on purpose keeps it (Recruiter's "… Hiring Team"). The generic
  names workflows used before (company name, texting sender name, booking display name) give way to the
  branded name.
- The old owner-typed "Emails are sent from" field is gone. It was never used as a From, only as a gate.
  Company email is now ready when Selestial's shared sender is configured (`senderGaps` in
  `convex/lib/messaging/policy.ts`).

## Replies

- A reply address is used once verified: at once for the Owner's own verified sign-in email or a
  connected inbox (ownership already proven), otherwise by a 6-digit code emailed from Selestial. The
  code is made in an action and only its hash is stored; it lasts 30 minutes, 5 tries, 5 codes an hour.
  The current address stays in use until the new one is confirmed.
- Precedence at send time (`replyFor`): a workflow's routing address (Sales `r-…@reply`) and addresses a
  workflow chose on purpose (Finance's reply address, the hiring inbox) are kept. The verified address
  replaces the generic fallbacks workflows used before (support email, booking page email) or fills an
  empty Reply-To. With no verified address, behaviour is unchanged.
- The page says plainly that a reply address is where replies are delivered, and that agents only read
  replies in an inbox connected to Selestial. Gmail is optional; Microsoft is "coming soon".

## Versions and retries

On a message's first attempt, `versionForSend` resolves the branding in force, stores it as an
immutable, content-addressed version (same branding → same row) and writes `brandingVersionId` on the
message. Every retry and every provider check renders from that version, so it never changes between
attempts. Saving branding affects only messages not yet attempted; sent messages are never edited.
Saves carry the revision they started from; a stale save is refused.

## Appearance

Logo (company logo from the booking profile, an uploaded one, or name only), accent colour, button
colour, light or dark header, three layouts, logo left or centred. Colours must keep white text on them
and links in them at 4.5:1; anything else falls back to a readable colour. Logos are PNG, JPEG or WebP
under 2 MB, claimed by the company (`convex/lib/booking/images.ts`); another company's file or an SVG is
refused. Convex file addresses don't expire, so logos in sent email keep working. With images off the
alt text is the company name. No HTML, CSS, scripts or tracking from owners.

## Signature and footer

Optional signature (name, phone, website, support email, one closing line with no links or offers) and
business address. Empty fields use the company profile. The footer (why the person got it, "sent via
Selestial", the address, unsubscribe where it applies) is the renderer's and can't be removed.

## Test email

`sendTest` queues a real outbox message (purpose `email_branding_test`) to the Owner's own verified
sign-in email or the verified reply address only, 5 an hour, subject prefixed `[Test]`, a test note at
the top, sample content. It goes through the same policy, billing, provider and delivery reports; the
page shows the outbox's own status. It is billed like any business email (`email_out` from the current
rate card); an Owner's test text is included, the test email deliberately is not.

## What doesn't use it

Mail from a connected Gmail (plain, threaded, from that inbox); Dispatch job offers (texts); Stripe card
receipts; Selestial's own notices, sign-in and billing mail (stay Selestial's).

## Platform setup still needed

See docs/email/00-architecture.md §4 and §6: the shared domain's DMARC record, the Resend webhook for the
live deployment, and `SALES_REPLY_DOMAIN` for reply routing into Selestial. None of it is an owner task.
