# Quality: what it does, and when

Quality makes the service promise measurable, checks delivery against it, gathers the evidence, investigates
concerns, coordinates approved corrective work with the agents that own it, verifies the outcome, and
proposes improvements. This note is what the code does today. The architecture, the reuse map and who owns
what between agents are in `00-architecture.md`. What was tested, and how, is in `02-verification.md`.

## The distinctions it keeps

| Not the same | How the product keeps them apart |
| --- | --- |
| A complaint and a finding | A report opens or joins a case. Findings start as **suggested**, from the company's rules or the AI reader, and count only once a person confirms or revises them. |
| A complete record and good service | Every review summary ends: "A complete record is not proof of how the service looked; it is what was documented." Insights label documentation coverage as documentation. |
| A photo and the whole room | Photos are counted against the standard, never read as proof. A reader finding that concludes "no issue" from photos alone is dropped. |
| Missing information and a failure | A missing item is "Waiting on evidence". A gap in the evidence says *why*: not found, no access, not connected, still processing, stale, needs association, or restricted. A phone platform that is not connected says it is not connected, never "no calls". |
| A correction done and a customer satisfied | Each correction has two separate states: Quality's verification of the work, and the customer's answer through Retention. A case whose work is verified waits in **Verifying** until Retention has the customer's answer. |
| A recommendation and a policy | Quality proposes improvements. Only the Owner adopts one, and adopting a standard change creates a draft the Owner still publishes. |
| Queued and delivered | Requests show prepared, awaiting approval, sent, answered, unanswered, satisfied or cancelled. A text counts as sent only when the sender confirms it. |

## Standards

- **Levels, in a fixed order:** company default, then service, then client (account), then property, then a
  visit exception. A more specific standard adds a requirement, replaces one with the same id, or waives it
  with a reason. A waiver is never allowed at company level. A visit exception needs a note of what was
  agreed, and with whom.
- **Requirement types:** checklist completion, required evidence (photo counts by kind, optionally tied to
  checklist items), guide acknowledgment, inspection, customer or site confirmation, document or certificate,
  and timing. Each is required or advisory, and each names who is responsible.
- **Templates** (editable starting points, not industry claims): residential one-time, residential recurring,
  deep and move-out, commercial, office, and short-term rental turnover.
- **Versions:** every change is a draft. A Manager edits it and the Owner publishes it. Publishing ends the
  previous version. A visit is held to what applied at its start, and the review **snapshots** that standard,
  so a later edit never redefines a reviewed visit.
- **With no published standard**, a visit is reviewed against what is already on record: the checklist and
  Dispatch's photo counts. The review says so.

## Before, during and after service

- **Before** (visits in the next day, from the 10-minute sweep): a check of the scope, checklist, property
  instructions and open concerns at the property. Gaps go on a task for the office. The visit is never held.
- **During:** Quality does not step into live work. A photo or checklist update after the crew reports the
  visit done reruns the review, combined within the company's "wait after completion" window so related gaps
  go out in one request.
- **After:** when the crew reports the visit done, Quality reviews it against the standard. The review leads
  to one of four recommendations: approve, ask for what is missing, consider a correction, or have a person
  look into it.
  - Approve: nothing else happens.
  - Missing items: one focused request to the crew lead, capped per visit.
  - A crew-reported miss or a contradiction: a case opens with suggested findings.
  - A serious signal: a restricted case.

  **Operational completion is separate.** The manager still closes the visit, and Quality never blocks an
  invoice or a payout. A visit sent back to the crew supersedes its earlier review. A new round is reviewed
  when it is resubmitted.

## Cases

Stages: needs context, investigating, needs decision, action underway, verifying, closed. A case has several
findings, each with:

- its sources
- what conflicts with it
- what is missing
- whether it is suggested or reviewed
- a history of every change

The case timeline is the record: what arrived, what was asked, what was decided, by whom.

A person can:

- take the case over, which withdraws Quality's prepared requests; Quality prepares nothing outside while a
  person has it
- hand it back, add a note, assign it, or escalate it to the Owner
- preserve the visit's evidence
- close it, which needs every suggested finding reviewed first, and closes with what actually happened

**Serious concerns:** safety, damage, theft, injury and conduct, recognised in someone's words.

- The case is restricted to the Owner and anyone the Owner names, and stays restricted after closing.
- It is escalated, and the Owner is notified without anyone's words in the notice.
- The visit's evidence is preserved, and preserved photos cannot be deleted from a link.
- Prepared requests are cancelled.

Quality never admits liability, accuses a cleaner, contacts insurers or authorities, promises compensation,
suspends or terminates anyone, or changes pay. The case closes only after the Owner records a decision.

## Statements and evidence requests

Requests go to a cleaner by text, as a private link (`/c/quality/<token>`). Each link is:

- **Scoped:** one company, one person, one visit, one purpose. The allowed actions are save draft, upload and
  submit.
- **Time-limited:** the company's link days. It can be revoked, and it closes when its request closes or is
  cancelled.
- **Verified:** an account asks for the last four digits of the cleaner's phone, or the property's ZIP code.
  Five wrong tries close the link.
- **Minimal:** the page names the visit by day and town only, and never repeats what anyone said.
- **Versioned:** a submission is kept as written. Anything added later is a supplement beside it, never an
  overwrite.

Missing-evidence photos go on the visit's own record, as crew photos would. Other files are kept on the
request and served only through short-lived signed addresses.

One reminder is sent, then the request is marked **unanswered**: "That is not an admission of anything." When
accounts conflict or a miss is suggested, every accepted crew member is asked, not just one.

Customer questions are never sent by Quality. They are handed to Retention as a message action on its case,
under Retention's own permission ("Ask me first" by default).

## Corrections

A correction needs reviewed service-miss findings. Quality refuses a correction for work outside the booked
scope, and for a serious case still waiting for the Owner. Quality writes the scope (targeted or full), the
areas, the minutes and the acceptance criteria.

Retention carries it out as an ordinary `correction_visit` remedy on its recovery episode:

1. The Owner sets the crew's pay, which books the visit.
2. Dispatch staffs it like any visit.
3. When it is done, Quality checks the after photos and checklist labels against the criteria. An inspection
   needs a person.
4. The customer's answer comes from Retention.

Every state is distinct: proposed, approved, scheduled, crew accepted, completed, quality verified or not
verified, and blocked. If a finding is revised or rejected before the visit, the prepared remedy is withdrawn
and the correction is blocked. Nothing stale is carried out, because each request and remedy carries a stamp
of the evidence it was approved on and is re-checked at the moment it would run.

## Calls, texts and email

- **Quo (formerly OpenPhone)**, connected by the Owner with an API key that is stored sealed.
  - Selestial checks what the workspace actually allows (numbers, call details, transcripts, Quo's
    summaries, signed webhooks) and shows each capability as checked.
  - Recordings are "Not used": Quality never starts a recording or changes recording settings. This reading
    connection sends nothing. Its deliveries arrive at `/webhooks/quality-quo/<id>`, apart from the Quo
    texting connection's `/webhooks/quo/<id>`.
  - Quality's texts to cleaners follow each conversation's own route (`convex/lib/quo/route.ts`). Where a
    cleaner's conversation runs through the company's Quo texting number, Quality's request goes that way
    only if the Owner allowed Quality on that connection (Settings › Integrations › Quo); otherwise it is
    reported blocked, never moved to another number.
  - Signed webhooks are verified against the connection's own key, inside a five-minute window. Bounded
    polling (three pages a sync) catches what webhooks missed. Repeated, out-of-order, late and revised
    transcripts are handled.
  - Reading is off until the Owner turns on "Read calls and texts from the connected phone platform".
  - Conversations from before connecting are history and never start outreach.
- **Matching a conversation to a visit** uses evidence only: an explicit reference, the customer's number,
  dates, street numbers and names, property labels and the service.
  - More than one customer on a number, or several possible visits with nothing decisive, goes to
    **Conversations to link** on the Playbook.
  - A person's link, unlink or dismissal is kept with its history and is never overwritten by a later
    automatic decision.
- **Transcripts** keep apart: call metadata, the provider's transcript (versioned), the provider's summary
  (labelled, never quoted as anyone's words), Selestial's extraction (speaker-aware: a rule about what a
  customer said never fires on a staff line, and an unidentified speaker is flagged), and what a person
  reviewed.
- **Business texting (Telnyx)** carries Quality's requests to cleaners under every sending rule. Incoming
  customer texts reach Retention, which opens the cases Quality investigates.
- **Email:** Retention reads the care mailbox when it is turned on. Quoted history is stripped, so an old
  thread is not a new complaint, and a repeated complaint is one complaint. A hiring-only mailbox is never
  read for this.

Everything external is data. Transcripts, emails, texts and statements cannot instruct the agent or the AI
reader: they are wrapped as evidence, the frame cannot be closed from inside, and nothing they say changes a
permission or starts an action.

## The AI reader (optional)

When the Owner turns it on and a reader is configured (`QUALITY_MODEL=claude` with an Anthropic key), the
reader suggests findings and a short summary from the assembled evidence.

Before reading, credits are reserved under the task `quality_review`, keyed by case and evidence stamp. One
reading of unchanged evidence is charged once.

A suggestion is kept only if all of these hold:

- it cites evidence ids that were really given
- it uses no blaming or consequence words
- its category is a real finding category
- it does not conclude "no issue" from photos alone

What is kept is still only a suggestion for a person.

The model never produces disciplinary decisions, financial penalties or conclusive accusations. The rules'
findings stand on their own when no reader is configured.

## Background work and governance

Durable runs with:

- idempotency keys
- three-minute leases
- four attempts with backoff (0, 1, 5, 20, 60 minutes)
- cancellation when a case closes
- a 10-minute recovery sweep that requeues expired leases and stalled runs

A run that cannot finish opens a task saying so. Each run records what it checked, what it found and what
happens next, and the screens show exactly that, never invented activity or confidence figures.

**When agent work is blocked** (paused, suspended, or not on the plan), runs record why and resume when
allowed. Review records are still kept, but nothing goes outside.

**Permissions** (the Owner's, in the Playbook), with their starting levels:

| Action | Starts at |
| --- | --- |
| Review completion | Act automatically |
| Open a case | Act automatically |
| Verify a correction | Act automatically |
| Propose an improvement | Act automatically |
| Ask a cleaner for evidence | Act and notify me |
| Remind | Act and notify me |
| Prepare a correction | Act and notify me |
| Customer clarification | Ask me first, and can never be set higher than Act and notify me |

## Improvements

From **reviewed** findings over 90 days, grouped by category and area (and by property where it matters),
Quality proposes a change. Possible changes:

- a checklist item
- booking question or scope wording (Sales)
- a property instruction or scheduling assumption (Dispatch)
- training (Recruiter)
- equipment
- inspection frequency

Each proposal carries its evidence count, its denominator and its window. Proposals below the company's
pattern minimum are not made. A small sample is called too small to read.

The Owner decides. Adopting a proposal makes a draft standard, or a task for the agent that owns the change.
A later evaluation reports counts before and after, and says when the numbers do not prove the change worked.

## Where it shows up

- **Operations → Quality:**
  - **Overview:** sources, counts, what needs a person, waiting on evidence, the run trace, recently closed.
  - **Reviews**, with a review drawer.
  - **Cases**, with a workspace: Summary, Evidence, Timeline, People, Actions, Outcome.
  - **Corrections**, **Standards**, **Insights** and **Playbook**.
- **Elsewhere:**
  - A **Quality** section on each visit.
  - A **Quality** card on the client overview, the property page and (for managers) the cleaner profile.
    The cleaner card never shows a score.
  - Quality's findings and correction state in the Retention case drawer.
  - Sidebar badges: serious, then decisions, then overdue, then working.
  - Owner notices.
  - Company Chat tools: list cases, explain a case, explain a visit's review. These are read-only, respect
    restricted cases, and hide people's statements from office staff.

## Entitlements

Quality is released in code. Plan access is **unchanged**: it is part of Expand, and only Operate is on sale.
On Operate, agent work is visibly blocked ("Quality isn't part of the Operate plan") while people keep the
workspace. Making it part of Operate is the Owner's decision; see `00-architecture.md`.
