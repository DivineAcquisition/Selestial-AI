# Recruiter rework (November 23, 2026)

Find relevant hiring conversations. Explain the findings. Prepare the next useful communication. Execute
within the owner's configured permissions. Track the outcome.

## 1. The recruiting-only boundary — `convex/lib/recruiter/boundary.ts`

One gate decides, from sender, Reply-To, subject, thread and what Selestial already knows, whether a
message is **read**, kept as **possibly hiring-related**, or **skipped**. The first scan, the timer,
Gmail push and history, a reconnect or recovery scan, a manual refresh and the next run after a failure
are all the same run (`recruiterInbox.sync`), so they apply the same gate.

| Discovery mode | Provider-side narrowing | Local gate |
|---|---|---|
| Hiring inbox (recommended) | none | vague mail from a person → possibly hiring-related |
| Gmail label (recommended) | `label:"X"` in the scan; history asks for `messageAdded` and `labelAdded`; every header must carry the label now | same |
| Search a business inbox | job-board senders or recruiting words, never promotions/social | vague mail → skipped |

Connections from before modes: a label is kept (label mode); no label is searched narrowly. Changing the
mode or label starts the reading window again; what was filed is not filed again.

- **Read:** supported job-board applications and status notices, direct applications and employment
  inquiries, replies in a thread already filed under an application or from a known applicant.
- **Possibly hiring-related:** unrecognised job-board mail, unsupported boards with hiring words, maybe-hiring
  subjects. Never opened, no task. Sender and subject kept 14 days, then cleared (`recruiterPossible.expire`).
  A person can include (then it is read normally), ignore (cleared at once) or open it in Gmail.
- **Skipped:** customers, working cleaners, notice-only senders, invoices/newsletters, a board's ads and
  suggested candidates (people who have not applied). Only a content-free id is kept; ads and suggestions
  also keep which board.
- A known applicant writing about something plainly not hiring (a booking, an invoice) is possibly
  hiring-related, not read: identity is context, not permission.
- Attachment text is downloaded only for applications. Every body and attachment is untrusted data.
- Job-board notices are read by the rules first, for nothing. The AI reader (1 credit) is used for mail a
  person wrote, and for notices the rules can't name anyone from; it is charged only when it answered.
- Gmail's `gmail.readonly` covers the whole mailbox; Selestial enforces the boundary. Sending is a
  separate permission (`canSend`).

## 2. Findings — `convex/lib/recruiter/findings.ts`, `act.ts`, `convex/recruiterFindings.ts`

At most one open finding per application, derived from its records and refreshed whenever they change.
It keeps reported facts ("Maria reports…") apart from Recruiter's reading, lists what is missing, and
carries the prepared message: real recipient, channel, subject, text, link, reason and any limitation.

| Finding | Prepared |
|---|---|
| New application | application link |
| Employment inquiry | reply with the open role and its link, or the open roles and "which one?" |
| Applicant wrote before getting the link | the application link, which answers them |
| Incomplete application | reminder (scheduled until due) |
| Pay question | reply with approved pay only; none approved → needs you |
| Availability given | interview times to choose from; none open → needs you |
| Other question | a person writes it, or AI drafts it (1 credit) from the role and the Hiring FAQ |
| Interview soon | interview reminder |
| Contact needed / delivery failed / role unclear or closed / decision needed | needs you, nothing prepared |

States: Ready to send · Scheduled · Sending · Sent (delivery shown separately) · Needs you · Dismissed ·
Done · Expired (facts changed before use). **Send is the authorization** — no approval queue for routine
messages. Every send re-derives the finding and refuses a stale one, then goes through the existing send
functions and outbox (role, do-not-contact, withdrawal, application state, address, sending policy,
pause for Recruiter's own sends, duplicate keys). Bulk send shows each recipient first and rechecks each.
Hiring decisions (interview, offer, decline, hire, pay) are never prepared as messages.

## 3. Automatic sends — `convex/recruiterAutomation.ts`

Five switches, each a permission level underneath: application links (`recruiter.send_invitation` plus
automatic invitations), inquiry replies (`recruiter.reply_inquiry`), reminders (`recruiter.follow_up`),
interview reminders (`recruiter.interview_reminder`), routine answers (`recruiter.answer_questions`).
New companies start with all off. Drafted answers are checked: no figure, link or address that is not in
approved information, no hiring-decision words.

## 4. Billing

Rate card **2026-11d** = 2026-11c plus "Hiring reply drafted by AI" at 1 credit (owner, Nov 23, 2026).
Charged only for a usable draft. **Takes effect only when `BILLING_RATE_CARD=2026-11d` is set.** Until
then drafting is unavailable and only pay questions are answered by themselves.

## 5. Background work and notices

`inboxRuns` records each read (read / partial / failed, counts, reason), kept 30 days. Notices:
`recruiter_attention` (an unanswered reply, a failed send) and `recruiter_activity` (hourly new-applicant
summary, a booked interview); each opens the applicant.

## 6. Migration — `npx convex run recruiterMigration:start`

Run once after deploying; safe to repeat; sends nothing. Pending invitation and reminder approvals are
closed as moved and become prepared messages (so neither path can send twice); interview reminders stay
automatic where interviews were on; every open application gets its finding.
`recruiterMigration:inventory '{"companyId": …}'` counts content earlier builds kept from mail now outside
the boundary; `recruiterMigration:clearOutside` clears it and is run only on purpose.

## 7. Verified and not

Every Indeed and ZipRecruiter format here is still **invented**: no real samples are in
`tests/fixtures/recruiter-real/`. Gmail search syntax, history `labelAdded`, and the Claude drafter were
tested against fakes only, not the live services.
