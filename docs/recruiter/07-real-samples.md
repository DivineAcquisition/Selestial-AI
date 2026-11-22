# Recruiter: checking the reader against real notifications

Every Indeed and ZipRecruiter message in the tests today is **invented**. The sender domains, the subject
wording and the body layout in `convex/lib/recruiter/mail.ts` (`BOARDS`) and `interpret.ts` were written
from general knowledge, and no test proves real notices are read correctly. This page is how to change
that: capture real notices, redact them, drop them in one directory, and a test pins what Recruiter makes
of each.

Until samples are in, two things limit the damage of a wrong guess:

- Mail from Indeed or ZipRecruiter whose subject matches no pattern is **not** thrown away as advertising.
  It is filed as "needs review" and a person is asked to read it (one task per message). Only mail that is
  plainly the board writing about itself (marketing, digests, billing) is filed as a promotion.
- A board's forwarding address is never written to until the Owner confirms that board's forwarding works.

## Where samples go

```
tests/fixtures/recruiter-real/*.eml
```

One message per file, as the mailbox received it: all headers, a blank line, the body. Name files so they
sort usefully, for example `indeed-new-application-01.eml`, `ziprecruiter-candidate-message-01.eml`.

`convex/recruiterIntake.test.ts` ("Recruiter: real job-board notifications") reads every `.eml` file there
and snapshot-asserts four things:

| Field | Meaning |
|---|---|
| `kind` | What the message is filed as: `new_application`, `applicant_reply`, `status_update`, `suggested_candidate`, `promotion`, `needs_review`, `unrelated` |
| `applicantName` | The name Recruiter read, or `null` |
| `contactKind` | `direct` (the applicant's own address), `relay` (only the board's forwarding address), `none` |
| `wouldAutoInvite` | `yes` if Recruiter would email this person without anyone looking, given a matching open role and invitations set to automatic. `no` otherwise |

`source` is recorded too (`indeed`, `ziprecruiter`, `direct`, `other`, or `unsupported board`). With the
directory empty the test is skipped, not passed.

## Capturing a notification with its headers

From the Gmail mailbox that received it (the web page, not the phone app):

1. Open the message.
2. Open the three-dot menu at the top right of the message and choose **Show original**.
3. Choose **Download original**. Gmail saves a `.eml` file.

Forwarding the message to yourself does **not** work: a forward replaces the headers (From, Reply-To,
Subject) with your own, and those headers are exactly what Recruiter reads first.

Collect at least one of each kind you can find, from each board:

- a new application (with and without a resume attached, if both occur)
- a second notice about the same application (a reminder, or "X is waiting")
- an applicant's message or reply that came through the board
- an interview or status notice
- a "recommended candidates" notice
- an advertisement or digest
- your own reply to an applicant, as the applicant's answer quoted it

## What to redact, and how

Edit the `.eml` file in a plain text editor. Replace, do not delete: the reader depends on where things
are and how they are labelled, so the line must stay.

| Replace | With | Keep |
|---|---|---|
| The applicant's name | An invented name, the same one everywhere in the file (subject, From display name, body) | Number of words, capitalisation |
| The applicant's own email address | `first.last@example.test` | The label in front of it ("Email:", etc.) |
| The local part of a forwarding address (`abc123@indeedemail.com`) | Other letters and digits of the same length and shape | **The domain, exactly** |
| Phone numbers | `(512) 555-01xx` | The format the board used |
| Street addresses, and anything in a resume | Invented text of the same kind | The city and state if the board shows them |
| Your company's name and mailbox address | `Alpha Cleaning`, `hiring@company.test` | |
| Application or candidate ids, and tokens inside links | The same number of other characters | The parameter names in the link (`?candidate_id=…`) |
| `Received:`, `DKIM-Signature:`, `ARC-*`, `X-Google-*`, `Authentication-Results:` headers | Delete these whole headers | |

Never change: the `From`, `Reply-To` and `Sender` **domains**, the wording of the `Subject` apart from the
name and job title, the labels in the body, `Content-Type`, `Content-Transfer-Encoding`, and MIME boundaries.

If the body is base64 or quoted-printable, decode it, redact it, and either re-encode it or change
`Content-Transfer-Encoding` to `8bit` and paste the redacted text in. A resume attachment can be replaced
with a one-line text file of the same file name; the name is what Recruiter records.

Before committing, search the file for the applicant's real name, the `@` of every address, and digits.
Nothing in this directory may identify a real person.

## Adding a sample

1. Put the redacted `.eml` in `tests/fixtures/recruiter-real/`.
2. Run `npx vitest run convex/recruiterIntake.test.ts -t "real job-board"`. A new file writes a new entry
   in `convex/__snapshots__/recruiterIntake.test.ts.snap`.
3. **Read the snapshot entry.** It is what Recruiter would do with that message today. If it is wrong
   (an application read as `needs_review` or `promotion`, a name missed, a forwarding address taken for a
   direct one, `wouldAutoInvite: yes` where a person should have looked), fix the patterns in
   `convex/lib/recruiter/mail.ts` or `interpret.ts`, not the snapshot, and run it again.
4. Commit the sample and the snapshot together. From then on, a change to the reader that alters what any
   real sample reads as fails the test until someone has looked at the difference
   (`npx vitest run convex/recruiterIntake.test.ts -u` rewrites the snapshot once they have).
5. When a board's samples all read correctly, update its rows in `05-assumptions.md` from "assumption" to
   "checked against samples", with the date.

The sample reader (`tests/recruiterSamples.ts`) uses the rules reader, not a model, and no database: it
shows what the message alone says. Matching the role to a hiring need, duplicates, and permissions are
covered by the scenario tests with invented messages.

## A board that is not Indeed or ZipRecruiter

LinkedIn, Glassdoor, Craigslist, Facebook and the hiring tools listed in `UNSUPPORTED_BOARDS` are not read.
An application found in their mail is kept for a person, with no address trusted, and nobody is invited.
Samples from them are welcome here too: they will read as `unsupported board` with `wouldAutoInvite: no`.
A board becomes supported by adding it to `BOARDS` with patterns checked against its samples.
