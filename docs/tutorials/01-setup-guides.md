# Setup guides: six narrated tutorials for new owners

**"A busy owner can watch one short video beside the task, then finish that task in the real app."**

Status, November 24, 2026: all six guides are recorded from the real application, narrated with ElevenLabs
(stock voice Eric; "Selestial" said like "celestial", confirmed by the Owner), assembled, and verified in the app
from every placement. Nothing is published: the files are uploaded to Vercel Blob and staff publish each guide at
/staff/tutorials after review (see Still needed). How to reproduce everything: `tutorials/SETUP-SERIES.md`.

## What was there before

The migration-tutorial system (`00-plan.md`): a typed catalog (`convex/lib/tutorials/catalog.ts`), one dialog and
player for the whole workspace (`src/components/app/tutorials/host.tsx`, `player.tsx`), staff publication and
media versions without a release (`convex/tutorials.ts`, `/staff/tutorials`), privacy-safe events, and a
production pipeline (`tutorials/scripts`: Playwright capture, ElevenLabs narration with character timings,
ffmpeg assembly, Vercel Blob upload). The Owner chose ElevenLabs' stock voice **Eric** on November 20.

The setup guides reuse all of it. There is no second registry, player or storage convention.

## What is built

| Part | Where |
|---|---|
| Six guides in the catalog (platform `selestial`, tasks `setup_*`, order, short name, placements, next action, written steps, transcript) | `convex/lib/tutorials/setup.ts`, joined into `TUTORIALS` in `catalog.ts` |
| Placements beside each task | setup's first step, Settings › Company profile, Services & Pricing, Clients & Properties, Bring your business to Selestial, Cleaners, Settings › Email & texting, Connected apps, Set up business texting, Settings › Agent permissions |
| "Need a hand? Watch how to … · 1 min 18 sec" card (real length from the media; nothing when not published; "Read how to …" when published without video) | `src/components/app/tutorials/setup-help.tsx` (`SetupHelpCard`) |
| Getting started: the six in order, each with its real length and "Done"/"To do" read from records (`tutorials.setupStatus`). On Home for Owners and Managers (closable, gone once every published guide's task is done) and at the top of Help & tutorials | `GettingStarted`, `screens/overview.tsx`, `/app/help` |
| Help & tutorials in the account menu (the help page had no link) | `src/components/auth/user-menu.tsx` |
| Next action: closes the dialog and returns to the task when the owner is already on that screen (or on setup, "Continue setup"), so nothing typed is lost; otherwise opens the screen | `host.tsx` `ActionButton` |
| Setup wording in the dialog: "Setup guide n of 6", "Recorded in Selestial on …, with a fictional demo company", "Get setup help", transcript download | `host.tsx` |
| Transcript file beside each video (`media.transcript`), accepted by staff media updates | `catalog.ts`, `schema.ts`, `tutorials.ts` |
| Player fixes, shared with the migration tutorials: controls moved beneath the picture so captions are never covered; compact native speed menu (the form-field select had broken the bar onto three rows); readable caption size in the dialog, on phones and full screen | `player.tsx`, `globals.css` |

Watching never completes anything: `setupStatus` reads business settings, live services, clients, ready cleaners,
connected inboxes or an active texting number, and whether agents were started.

## Placement map

| # | Guide | Owner's goal | Offered at | Shows (real screens) | Next action |
|---|---|---|---|---|---|
| 1 | Set up your company | Name, clock, service area, booking hours, how the team works, first priority | Setup's first step ("Continue setup"), Settings › Company profile | Create company; setup: start, basics, team, priority, Save and exit; Company profile: ZIP codes, booking hours | Open Company profile |
| 2 | Build your services and pricing | One service priced, reviewed and live | Services & Pricing | Set up with Selestial (drafts from setup answers, on example prices); Standard clean: replace the prices, "A usual job"; Booking & team; Review & publish (example homes, what publishing does); "These prices are right for my market", why, Publish and confirm; Live | Set up services |
| 3 | Bring in your clients and upcoming work | Import and review, or add by hand | Clients & Properties, Bring your business to Selestial | Migration: source, files, organize (columns, dates, time zone, service matching), review & fix, import, verify & activate. Manual: Add client, Book a visit (price answers, day, time, cleaners), the booked visit | Review your import |
| 4 | Get your cleaners ready | Add a cleaner, see what's missing, set hours and pay | Cleaners | Add cleaner; readiness; Onboarding & Documents; Availability; Finance › Team pay; Make active ("active, but … no work can be offered") | Add your cleaners |
| 5 | Connect your email and phone | See whether the company can send messages; request a texting number | Email & texting, Connected apps, Set up business texting | Email & texting: "Can your company send messages?" (what's missing, with Fix); Connected apps: Gmail's real status; texting: business, what you'll send, permission wording, number, review & costs | Open Email & texting |
| 6 | Put your agents to work | Set autonomy, start real work, find results and decisions | Agent permissions | Agent permissions (levels, what an action is blocked on); Home: Review and start, focus "Hire cleaners", Start my agents; tasks moving to Ready for review / Waiting for connection; the draft role it made; Approvals; notifications | Open agent activity |

## Scripts and storyboards

Every guide follows: outcome (title card and first line), demonstration, the one or two choices that matter,
next step (closing card). Storyboards: `tutorials/storyboards/setup-*.json`; the narration in each scene is the
script, and the transcript. Fictional company **Juniper Cleaning Co.**, Austin TX; people and addresses are
fictional, emails are example.com, phones 555-01xx, the EIN is the IRS's own example.

| Guide | Narration | Video | Target | Notes |
|---|---|---|---|---|
| 1 Set up your company | 1,151 characters | 81.0 s | 60–90 s | |
| 2 Build your services and pricing | 1,121 | 87.9 s | 90–150 s | Publishing at 2×, labelled |
| 3 Bring in your clients and upcoming work | 1,284 | 104.0 s | 90–150 s | Organize at 1.3×, new client at 1.5×, visit form at 2×, all labelled |
| 4 Get your cleaners ready | 854 | 75.1 s | 90–150 s | Add cleaner and pay at 1.6×, Make active at 1.5×, labelled |
| 5 Connect your email and phone | 1,111 | 83.0 s | 90–150 s | Business details at 2×, labelled |
| 6 Put your agents to work | 986 | 75.3 s | 90–150 s | |

Version 2 of every guide was re-recorded on November 24 and 25 after main reorganized Settings (#151), redesigned
Services & Pricing (#161), added business configuration to setup (#160) and texting infrastructure (#155), and the Finish draft pop-up in Services (#163), which guide 2 now shows.

Guides 2, 4, 5 and 6 run under the 90-second target: the scripts say only what the screens show, without padding. A
scene is never cut shorter than its recording, because a recording usually ends on its result.
Each is 4–6 MB at 1080p (H.264/AAC, faststart).

ElevenLabs usage: 6,515 characters for the first versions, 1,418 for the lines that changed in version 2, plus
230 for the voice samples. This billing cycle: 8,801 of 10,000 used (free tier, resets December 20). Neighbouring-line context is not billed; unchanged lines are reused
from the cache.

## Blockers and limits found (not demonstrated, or demonstrated with care)

- **Gmail connection**: built, but Selestial must switch it on per account ("Setup needed") and no real Google
  sign-in has been verified (`docs/email/05-verification.md`). Guide 5 shows the card and its real status, and
  never shows a connection. Outlook and Microsoft 365 are "Coming soon".
- **Email readiness**: Email & texting reports "Email is not set up" until "Emails are sent from" is filled in,
  but that address is only checked for readiness; nothing sends from it (`convex/lib/messaging/policy.ts`).
  Elsewhere the app says email goes from Selestial's address under the company's name until an inbox is
  connected. Guide 5 shows the readiness view and makes no promise about where email comes from.
- **Texting number search** fails in the demo environment ("The search didn't work right now"), so guide 5
  shows the number step without searching. Nothing is submitted in the video; submitting sends the request to
  Selestial's review, and carriers and purchase follow only after it, as the screen says.
- **Quo** needs a real Quo API key and its test text sends a real SMS: not recorded.
- **Invite to portal** sends a text or email: highlighted, never pressed.
- **Ready for assignments** needs the cleaner's own onboarding steps (agreement, phone, training). Guide 4 makes
  the cleaner active and shows plainly that no work can be offered until those are met; it doesn't fake them.

## Product issues found while recording (not changed here)

1. **The guided migration misreads Selestial's own templates.** `guessKind` (`convex/lib/migration/rules.ts`)
   treats any file with a "Frequency" column as recurring service, so `public/templates/selestial-clients.csv`
   is read as recurring; `selestial-appointments.csv` scores as customers ("client", "email", "phone" beat
   "date", "start time"). Guide 3 tells owners to check what each file holds; the sample files avoid the trap.
2. Two rows with the same email and address in one file ("Elena Ortiz") were not shown as possible duplicates.
   The screen says a shared email isn't enough to merge; worth confirming that within-file repeats are intended
   to pass silently.
3. Booking outside the service area says "Add it under Business & hours first", but the page is
   **Company profile** (it was Business details before the Settings reorganization).
6. "Emails are sent from" (Email & texting) gates email readiness but isn't used as the sender anywhere, and the
   Connected apps copy says email already goes from Selestial's address: the two disagree.
4. `setup.save` accepts fact values that aren't choices (`"homes"`, `"6_15"`) without complaint.
5. The visit form shows "No price is in your file… priced when you release your schedule" for imported visits;
   fine, but owners may expect a price column to be read.

## Verification

- `convex/tutorials.test.ts` (7): six ordered guides with in-app next steps and draft by default; "Done" only from
  records (watching and every tutorial event change nothing; a saved service area does; another company's records
  never count and its status is refused); a video publishes only with its reviewed transcript; transcript
  addresses must be https or Selestial's own.
- Browser checks against the local demo backend with the pilot published (28/28 at 1440×900 and 390×844, reduced
  motion): no autoplay; plays when asked; 23 caption cues showing; `k` pauses and `c` toggles captions from the
  player's buttons; transcript readable and downloadable; no horizontal overflow; Escape closes; focus returns to
  the card; typed but unsaved Business details survive opening and closing; the next action returns to the task.
- Every placement (52/52), with version 2 of all six published in the local backend: setup's first step (next action
  "Continue setup"), Company profile, Services & Pricing, Clients & Properties, the migration workspace, Cleaners,
  Email & texting, Connected apps, business texting and Agent permissions each show their card with the real length, open the right guide,
  play it and close without errors; Home and Help & tutorials list all six.
- Failure paths (14/14): a missing video says it didn't load and offers a retry, with steps, transcript and
  next action still there; "Needs update" removes the card; republishing restores it; Home shows "Done" and "To do" from
  records; Help & tutorials opens from the account
  menu and its next action navigates to the task.
- Every recorded frame was taken from the running application with synthetic data; no real inbox, phone, payment
  or customer record appears, and nothing was sent, bought or charged.

## Still needed

1. **Owner:** the ElevenLabs account is on the free tier, whose terms don't cover commercial use and require
   attribution. Upgrade to a paid plan (Starter is enough for this series) before these videos are published.
2. **Media upload:** `tutorials/scripts/publish.mjs <id>` uploads each build to the `selestial-tutorials` Blob store;
   it needs `BLOB_READ_WRITE_TOKEN`, which this session doesn't hold. Then paste the printed media entry at
   /staff/tutorials (Replace media version) and set the state to Published, or put it in `setup.ts` `media`.
3. Re-record a guide when its screens change (`--from <scene>` re-captures from one scene; unchanged narration is
   reused from the cache at no cost).
