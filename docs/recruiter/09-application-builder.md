# Recruiter: application forms, public application pages, and the pipeline board

November 26, 2026. A company builds the application its applicants fill in, sends it by email or puts it
on its own website, and moves applicants between pipeline stages on a board.

## Application forms

A form is a definition (`convex/lib/recruiter/formDefinition.ts`): a layout, a look, the page's words, the
invitation email, and sections of questions. It is stored like a booking experience: a working draft with
a revision number (`applicationForms`), and frozen published versions (`applicationFormVersions`). Every
save names the revision it started from; a stale save is refused with who saved and when.

- **Layout.** `one_at_a_time` (one question per screen, a progress bar, Enter to continue, a letter key to
  pick a choice) or `sections` (one page per section).
- **Standard fields** have names Recruiter knows (`fullName`, `email`, `phone`, `smsConsent`, `city`,
  `address`, `experienceYears`, `experienceSummary`, `availableDays`, `hoursPerWeek`, `earliestStart`,
  `serviceAreas`, `workAuthorized`, `over18`, `resume`) and are answered under that name, so screening
  criteria, prefill, the applicant record and the onboarding handoff keep working whatever the form looks
  like. The name and email are always asked and always required. `smsConsent`, `availableDays`,
  `serviceAreas`, `workAuthorized` and `over18` have fixed wording or choices.
- **The company's own questions** are answered under `f.<id>`: short answer, paragraph, number, yes or no,
  one choice, several choices, date, file upload (kept as a resume or a supporting file), an agreement
  checkbox (with an optional policy link), or text only.
- **Show only when.** A question can depend on an earlier question's answer. Only questions the applicant
  was shown are required, and only their answers are kept on submit.
- **Knockouts.** An answer can end an application under a published requirement. `gate`: the applicant is
  told at once, in the company's words, and can change the answer or send the application as it is.
  `flag`: nothing is said; screening lists it. In screening a gate is a fixed requirement and a flag is
  not (`screening.ts`, `knockoutResults`). A decline without a person still happens only where the Owner
  allowed `recruiter.decline_fixed_requirement`.
- **The role's own questions** (`hiringNeeds.questions`) are added after the form, under `q.<key>`.

### What an application never asks

`normalizeForm` refuses wording that asks for an identity document, a tax identifier or bank and card
details; those belong to onboarding. Question labels, help text and choices also pass the fairness guard
(`fairness.ts`). Minimum age and work authorization are offered only as the two standard fields with fixed
wording (`OVER_18_WORDING`, `WORK_AUTHORIZED_WORDING`). **Legal review:** how and when those two may be
asked differs by state; the builder says so beside them, and a company should have counsel confirm before
it turns them on.

### Which form an applicant answers

`lib/recruiter/forms.ts`. A role's own form (`hiringNeeds.formId`), else the company's default form, else
the original short form (`classicForm`). Only a published, unarchived form is used. The first save of an
applicant's answers pins the version (`formSessions.form`), so publishing a change never changes what
someone already answered; a session without a pin is on the original short form.

### Templates

`lib/recruiter/formTemplates.ts`:

- **Cleaner application** (`standard_cleaner`): the reference company's order (contact and texting
  permission, home address, getting to jobs with car, license and insurance, eligibility, experience,
  availability, how the work is done with contractor, background-check and pay agreements, supplies with a
  follow-up checklist, their own words, an optional resume). It leaves out the reference company's photo-ID
  upload.
- **Quick apply**: contact, experience, availability and an optional resume.
- **Short form**: Recruiter's original form.

The first time a company's Owner opens Application forms, `applicationForms.ensureStarter` creates the
Cleaner application, publishes it and makes it the default. A Manager gets it as a draft for the Owner.

### Who does what

Everyone reads forms. Managers and the Owner draft, duplicate and copy an earlier version into the draft.
The Owner publishes, chooses the default form, archives, chooses each role's form (`hiringNeeds.setForm`)
and turns a role's public page on or off (`hiringNeeds.setPublicApply`).

## Getting the form to applicants

- **An emailed private link.** `applications.sendApplication({ needId, recipients })` takes up to 50
  addresses (with optional names), adds each as an application from a person, and sends the invitation
  straight away: choosing Send is the approval. Every sending check still applies, and anyone already
  applying for the role is skipped. The link is the same `/c/apply/<token>` an inbox application gets,
  with the same expiry and reminders. The email is the form's own wording when it has one
  (`{first_name}`, `{role}`, `{company}`, `{link}`), with Recruiter's footer always added
  (`words.ts`, `customInvitationEmail`).
- **A public page.** `/apply/<handle>` lists the roles a company opened to the public, and
  `/apply/<handle>/<role>` starts an application. The handle is the company's public address from Booking
  rules, shared with booking pages. Starting asks for a name and an email (`applyPublic.start`, through
  Selestial's server with a hashed visitor key: eight starts an hour from one place, 300 an hour per role,
  and a hidden field that makes nothing when a script fills it). It makes a new applicant and an
  application (source `website`, stage `application_started`) and returns the applicant's private token;
  the browser goes on to `/c/apply/<token>`, the same page an emailed link opens. An address that already
  has an open application for the role gets the link to continue by email instead, and the visitor is told
  only to check their email, so typing an address never opens someone else's application.
- **An embed.** `/apply/<handle>/<role>/embed` is a small card (the role and an Apply button that opens
  the full page in a new tab). Only that route may be framed (`next.config.ts`). The Share panel gives the
  link, a button for any website and the embed snippet.

## The pipeline board

Applicants › Board (`?layout=board`). Columns are the application's own stages, grouped
(`lib/recruiter/board.ts`, `COLUMNS`); they are not a second status. Dragging a card, or choosing "Move to"
on it, opens a confirmation that says what will happen, and `applications.move` does exactly what the
matching button does:

| Drop on | From | Does |
| --- | --- | --- |
| Invited | Inbox | Sends the application link (`sendInvitation`). |
| Invited | Invited, Applying | Sends a new link; the old one stops working. |
| Interview | Screening, Decision | `decide("interview")`: Recruiter offers interview times. |
| Decision | Screening, Interview | Holds for a decision, with a reason. Nothing is sent. |
| Offer | Screening, Interview, Decision | `decide("offer")`: waits in Decision until an offer is approved and sent. |
| Close | any open stage before an accepted offer | Closes for a chosen reason; optionally emails the decline. |

Applying, Screening and Onboarding take no drops: the applicant or a finished step puts people there. The
server checks every move again, whoever makes it.
