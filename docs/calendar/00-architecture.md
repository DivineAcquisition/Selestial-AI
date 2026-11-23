# Calendar: architecture

Calendar is the company's central scheduling workspace at `/app/calendar`, directly under Approvals in
the persistent sidebar (Home, Approvals, Calendar, Inbox, Search). It stays visible whichever department
is selected. Dispatch › Schedule stays the specialized staffing view; both read the same jobs and
assignments, so a change made in one shows in the other.

This document is the audit (phase 1) and the plan the later phases follow. It records what the code
does, traced on November 23, 2026, where that differs from comments and older documents.

## Owner decisions (November 23, 2026)

| Question | Decision |
|---|---|
| Delivery | Phase by phase. Pause for review after phase 2 and after phase 4. |
| New records | Business events (meetings, manual appointments, members' unavailable time), onboarding and training sessions, scheduled quality inspections. Consultations are walkthroughs (assessments), not a new record. |
| Access | Every role opens Calendar. Office sees visits, crews and cleaners' availability, and Dispatch's own due dates; not interviews, walkthroughs, inspections, private events, members' time or applicant details. Office cannot reschedule from Calendar. Owners and Managers see and change what they can already change elsewhere. |
| Notifications on a reschedule | The confirmation lists who would be told under existing rules (customer, crew), all on by default; the person may turn a recipient off before saving. |
| Members' availability | Owners and Managers get optional weekly working hours and unavailable blocks, used for conflicts on business events, walkthroughs, interviews, training and inspections. Interview slots stay as they are. |
| Google Calendar | Business events are mirrored through the existing `googleCalendarLinks` mapping, Selestial being the source of truth, outside edits flagged. |
| Needs attention | A collapsible right rail that shares its space with the event panel. |
| Grid | Built in-house over Dispatch's components; no calendar library. |
| `/app/schedule` | Keeps redirecting to Dispatch › Schedule. |
| Training | Led by an Owner, Manager or designated trainer; new hires from `onboardingHandoffs` attend. Attendance counts toward onboarding only when a person marks it. |
| Inspections | Done by an Owner, Manager or lead cleaner. They block that person's time and link to the property, the visit inspected and the quality case when there is one. |

## What is scheduled today

| Record | Table | Time fields | Index for a range read | Shown in | Changed by |
|---|---|---|---|---|---|
| Visit (one-time, recurring, commercial, office, turnover) | `jobs` | `startsAt`, `endsAt`, `arrivalWindowMinutes`, `hardDeadlineAt` | `by_company_start` | Phase 2 | `jobs.reschedulePreview` / `jobs.reschedule` (`lib/dispatch/reschedule.ts`), `jobs.cancel`, `assignments.*` |
| Correction visit | `jobs` with `recovery` | as above | as above | Phase 2 | as above, arranged by Retention, staffed by Dispatch |
| Crew | `assignments` | from the job | `by_company_job` | Phase 2 | `assignments.offer/release/recordAnswer` |
| Recurring series (Clients) | `servicePlans` | `cadence`, `startsOn`, `startTime`, `bookedThrough` | `by_company_*` | Phase 2 (projections) | `servicePlans.skipVisit/pause/resume/end/changeSeries` (Manager+, `expectedRevision`) |
| Recurring series (Sales) | `recurringPlans`, `recurringPlanVersions`, `planVisits` | `cadence`, `arrivalMinute`, `generatedThrough` | `planVisits.by_company_job` | Phase 2 (projections) | `plans.skipVisit/pause/resume/end/changeFuture` |
| Interview | `interviews` | `startsAt`, `endsAt` once confirmed | none by time (added: `by_company_start`) | Phase 2 | `interviews.schedule`, `interviews.cancelTime` (Manager+) |
| Interviewer free time | `interviewSlots` | `startsAt`, `endsAt` | `by_company_start` | Phase 2 | `interviews.addSlots/removeSlot` |
| Walkthrough (and consultation) | `assessments` | `scheduledAt`, `durationMinutes` | none by time (added: `by_company_scheduled`) | Phase 2 | `assessments.request`, `assessments.schedule` |
| Cleaner time off | `timeOff` | `startsAt`, `endsAt` | per cleaner only (added: `by_company_end`) | Phase 2 | `availability.*`, cleaner portal |
| Cleaner date exceptions | `availabilityExceptions` | `date`, minutes | per cleaner only (added: `by_company_date`) | Phase 2 | `cleanerProfile.*` |
| Cleaner weekly hours | `availabilityWindows` | weekday, minutes | per cleaner | Phase 2 (Team view) | `availability.*` |
| Dated work | `tasks` | `dueAt` | `by_company_status_due` | Phase 2 (Deadlines, off by default) | each agent's workflow |
| Sales follow-ups | `salesFollowUps` | `dueAt` | `by_company_status_due` | Phase 2 (Deadlines) | Sales |
| Agreement renewals | `agreements.lifecycle.renewalOn` | date | `by_company_renewal` | Phase 2 (Deadlines, by agreement access) | Agreements |
| Connected calendar busy time | `googleBusy` | blocks | `by_company_calendar` | Phase 2 (External, off by default) | `googleCalendar.refreshBusy` (every 10 min) |

Not scheduled anywhere today, built in phase 3: business events and members' unavailable time,
training sessions, inspections, members' weekly hours.

## Findings that shape the build

1. **Two live recurrence systems.** `servicePlans` (Clients) books 28 days ahead through
   `lib/clients/plans.ts:bookAhead` and stamps `jobs.planId`. Sales plans book 56 days ahead through
   `lib/sales/plans.ts:generateVisits`, link through `planVisits.jobId` and do **not** set
   `jobs.planId`. Neither is legacy. Calendar reads both and generates nothing: projected occurrences
   come from each system's own pure helper (`seriesDays`; `cadenceDates` with the version rules), start
   after that plan's own boundary (`bookedThrough` / `generatedThrough`), and are never shown as booked.
2. **`servicePlans` local times ignore daylight saving.** `instantOn` in `lib/clients/plans.ts` adds
   fixed minutes to local midnight, so on a clock-change day a plan's visit is booked an hour off. Sales
   plans use `localInstant`, which is correct. To be fixed and tested in phase 4.
3. **Rescheduling is `jobs.reschedule`** (any role, version-checked when crew is affected). It re-checks
   each accepted cleaner and reopens a place rather than double-booking, texts cleaners, records
   `job.rescheduled`, and never tells the customer. Calendar uses the same `planMove`/`commitMove`; the
   customer notice and the per-recipient choice are added in phase 4. Calendar's own entry point is
   Manager+, by the owner's decision; Dispatch keeps its current rule (open question below).
4. **Moving one occurrence of a Sales plan** moves the job only; `planVisits.state = "moved"` is never
   set. Calendar must read a moved Sales visit as its job's time, not the plan's.
5. **Google Calendar sync is a sweep, not a reaction.** No job or interview mutation queues a sync; the
   10-minute `googleCalendar.sweep` rebuilds the plan (jobs from yesterday to 60 days ahead, confirmed
   interviews). So Calendar never waits on Google and keeps working without it. Gaps found:
   `cancelInterviewTime` leaves the Google event in place (the interview goes back to `proposed`, which
   the stale check does not catch); a job moved past 60 days keeps its old Google event; `edited` is
   never detected. Phase 5 fixes the first two and queues a sync after a Calendar change.
6. **Scopes.** Calendar access is `calendar.calendarlist.readonly`, `calendar.events` and
   `calendar.freebusy`. External calendars are read as free/busy only, so Calendar shows them as
   "Busy" and can show nothing more. No broader scope is requested.
7. **Detail panel.** `?open=job:<id>` opens the shared panel for jobs, approvals and tasks. Calendar
   reuses it for visits and tasks, and opens interviews, walkthroughs and agreements on their own pages
   until phase 3 adds panels for them.

## Data model

Calendar keeps no copy of any record. `convex/calendar.ts:range` reads each source for a bounded date
range (at most 45 days) and returns `Item`s (`convex/lib/calendar/model.ts`):

- stable `key` (`<table>:<id>`, plus the date for a projection) and `source` (table and id);
- `kind`, `layer` and `timing` — appointment, proposed, due, availability or projected, never mixed;
- `startsAt`/`endsAt`, `allDay` for a date with no time, `arrivalEndsAt` for an arrival window, and the
  record's own `timezone`;
- `status` and `statusLabel` in words; `resources` (cleaners with accepted/offered, members);
- `customerId`, `propertyId`, `agent`, `problems`, `href`, and the record's `version`.

Each source is read through a company-scoped index with a limit. When a source reaches its limit the
response says which and how many were shown; nothing is cut silently.

Access is applied before anything is returned. Layers by role are in `LAYER_ROLES`. Pay, access
instructions, private notes, applicant details beyond a name, cleaner documents and restricted quality
cases are never returned to Calendar.

## Phases

1. Audit and architecture (this document).
2. Route, sidebar, unified read, read-only Week, Day, Month, Agenda and Team views, filters, URL state.
3. Event panels and creation: business events, members' time, training, inspections; creating
   bookings through Sales, interviews through Recruiter, walkthroughs through Sales.
4. Rescheduling with preview (people, conflicts, buffer, customer commitments, notices), drag and resize
   with keyboard and form equivalents, recurrence scopes, the `servicePlans` daylight-saving fix.
5. Needs attention, Ask Selestial with the range as context, notifications and audit, Google mirroring
   of business events, the sync gaps above.
6. Accessibility, responsive polish, migrations and verification.

## Status

**Phase 2 (built).** `/app/calendar` with Week (default on a desk), Day, Month, Agenda (default on a
phone) and Team views; layers and filters (cleaner or crew, responsible person, client, status, agent)
in the address, the view and layers remembered per person and company; Needs attention as a rail beside
the calendar on a wide screen and a line that opens on a narrow one. Visits and tasks open in the shared
record panel; other items open a read-only panel that links to their own page. Read: `calendar.range`.
Team reuses Dispatch › Schedule's lanes. Create offers what exists today: a cleaning booking through
Sales, one visit, and an interview through Recruiter.

Not yet: creating business events, members' time, training and inspections (phase 3); moving anything
from Calendar (phase 4); Ask Selestial and notifications (phase 5).

## Open questions

- Dispatch lets any role reschedule a visit (`jobs.reschedule` is a `companyMutation`). Calendar's
  reschedule is Manager+ by the owner's decision. Should Dispatch be tightened to match?
