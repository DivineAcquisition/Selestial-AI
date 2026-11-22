# Onboarding and readiness

Recruiter owns a new cleaner from an accepted offer to an Owner's readiness approval. Team Coordinator was
retired on November 22, 2026 (`docs/foundation/01-navigation.md`, section 9); this is the part of its plan
that belongs to Recruiter.

**Recruiter gets a person ready for work. Dispatch decides whether that person can take a specific visit.
The Cleaners workspace holds the shared record.** Readiness never guarantees an assignment: Dispatch still
checks availability, skills, service area and requirements for every visit.

## The checklist

When an applicant accepts an approved offer (`lib/recruiter/handoff.ts`, `createHandoff`):

1. One person, one record: a returning worker keeps their cleaner record and history; anyone else gets a new
   one in **onboarding**, with the company's onboarding template applied. Retrying the acceptance finds the
   existing onboarding and creates nothing twice.
2. The onboarding lists the template's items, read from the shared cleaner record by
   `readinessSummary`. Each item has one state in the words the Owner sees:

   | State | Means |
   |---|---|
   | Missing | Nothing received |
   | Received | The cleaner sent it; nobody has looked |
   | Awaiting review | Waiting for the reviewer the template names |
   | Needs changes | A reviewer sent it back |
   | Approved / Waived | A named person accepted or waived it (shown with who) |
   | Expired | It was approved and has lapsed |

   Receiving a document is never shown as approved. Availability, service areas and a signed workforce
   agreement are read from the record ("On their record") rather than ticked.
3. Recording an item (`onboarding.record`) records it on the cleaner too, under the template's reviewer rule
   (an Owner for the agreement, tax form and payment details). Recording in the Cleaners workspace shows here
   at once.
4. Open decisions are listed: a rehire restriction on the record, or an engagement that is no longer
   onboarding.

Recruiter's own task carries the onboarding (`recruiter.onboarding:<application>`). It is held for a person
from the start; nothing is handed to another queue. Follow-ups about missing items are Recruiter's
(`lib/cleaners/followUps.ts`), under the company's reminder limits and messaging consent, and when they run out
the same task asks a person to reach out. No other workflow reminds the same person.

## Presenting and approving

When every item is recorded, Recruiter's task asks: "Every onboarding item for Jordan is recorded. Approve their
readiness…". Taking an item back changes the question back.

An Owner approves (`onboarding.approve`, `approveReadiness`). It refuses while anything that blocks work is
missing, unreviewed or expired, while a decision is open (a rehire restriction must be acknowledged), or for a
paused, suspended or ended engagement. Approval:

1. Closes the onboarding and the hiring record (closed as **hired**).
2. Makes the engagement active (`onboarding` → `ready`) and records `onboarding.ready_approved`, with how many
   items people confirmed and how many were read from the record.
3. Notifies Owners and Managers, except the person who approved, with the `worker_ready` notice: "Jordan's
   onboarding is complete. Required onboarding items have been reviewed. Dispatch can now consider Jordan for
   visits that match their availability, skills, and service area." The notice is written when it goes and
   only while the worker is still active with a completed onboarding.

Approving again changes nothing, opens nothing and sends nothing (the notice is keyed to the onboarding).

The Cleaners workspace cannot make a worker with an open Recruiter onboarding active around the checklist
(`lib/cleaners/status.ts`). Someone added directly in Cleaners, with no hiring record, is still made active
there by a Manager, as before.

## After approval: Dispatch

Dispatch offers work only to an active cleaner whose requirements are met (`lib/cleaners/readiness.ts`), and
checks each visit's time, skills and area. If the cleaner is later paused or moved back to onboarding, no new
offers go to them, and their accepted upcoming visits are not cancelled: Dispatch gets a task to decide each
one.

## Screens

- **Recruiter › Onboarding & Readiness** (`/app/agents/recruiter/onboarding-readiness`): each onboarding's
  checklist with states and who confirmed each item, open decisions, what is still needed, and the approval.
  Approved workers are listed with whether Dispatch can consider them.
- **Recruiter › Offers & Agreements**: offers and agreements, with a link onward to onboarding.
- **Cleaners › a worker's profile**: says who handles the next step, with links to onboarding in Recruiter,
  assignments in Dispatch and earnings in Finance.
