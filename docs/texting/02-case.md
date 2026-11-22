# Business texting: the onboarding case

Companion to `00-audit.md` and `01-deployment.md`. Built 2026-11-22 on top of the six-step setup, without a
second registration flow, a second ticket system or a new agent.

Three kinds of progress are kept apart on every screen and in every record:

| Kind | Who decides | Words used |
|---|---|---|
| Draft change | The owner (or support, for allowed draft fields) | "Applied to your draft", "Saved" |
| Selestial's internal review | Selestial staff | "Under Selestial review", "Accepted for Selestial review" |
| Carrier review | Telnyx and the mobile carriers | Milestones on Getting you ready, read back from Telnyx |

Nothing in the case can stand for the carriers' decision, manufacture consent, or approve for the owner.

## 1. Evidence & notes

Code: `convex/lib/texting/caseSchema.ts` (`textingEvidence`, `textingNotes`), `convex/lib/texting/evidence.ts`,
`convex/textingCase.ts`, `src/components/app/texting/evidence.tsx`.

Shown on Permission to text, Review & submit, Getting you ready (corrections), staff texting review and in
support sessions.

- **Formats:** PNG, JPEG, PDF, plain text, up to 10 MB, or an https link, or a placeholder for evidence still
  to come. Declared type and size are checked on registering; the file's own first bytes are checked by a
  scheduled action right after, and a file that isn't what it says is deleted and the item asks for a
  replacement. Word files are refused. No malware scanning (same as agreement uploads).
- **Each version keeps:** company, setup, key (item), version, purpose, what it proves, links (field, place,
  exception, submission version), visibility (company / internal), review state, who added it (member, or
  the support session that did), when, who reviewed it, and the submission versions that filed it.
- **States:** Missing · Added · Under Selestial review · Accepted for Selestial review · Needs replacement.
- **Versions:** replacing adds version n+1 and marks the old one replaced. A version filed with a submission
  (`lockedIn`) is never changed or deleted. `textingSubmissions.evidence` records the exact evidence ids and
  versions filed; later replacements never touch it.
- **Private storage, expiring links:** files are in Convex storage. They open only through
  `/texting-evidence/<id>?exp&sig`, signed with `ACTION_LINK_SECRET` under its own label and valid for at most
  15–20 minutes. A deployment without signing gives no address at all. Addresses are returned to the caller
  only: never in events, notifications or analytics. Events record "evidence added / reviewed / opened by
  Selestial review" with the purpose, never a file name or address.
- **Review copies:** for an opt-in screenshot or form, the owner can add a separate blank or redacted copy.
  It is public only when Selestial accepted it **and** the owner approved the exact statement in
  `REVIEW_COPY_WORDING`. It is then served at `/texting-review/<random token>` (noindex) for carrier reviewers,
  and stops being served when withdrawn, replaced or re-reviewed. The original is never served publicly.
  Telnyx's toll-free verification takes opt-in images as URLs (`optInWorkflowImageURLs`); for 10DLC the
  documented mechanism is a link in the campaign's message flow. Selestial doesn't insert the link into any
  filing on its own: staff use it in an assisted step.
- **Notes:** company notes (owner and Selestial) and internal notes (staff only). Drafts are editable; every
  edit keeps the earlier wording (`revisions`); posted company notes are locked when a submission is made.
  Internal notes, internal evidence and staff words on exceptions are never sent to a company query, and are
  left out of the company's data export (`keep` filters in `convex/lib/trust/exportTables.ts`).

## 2. Recommendations

Code: `convex/lib/texting/recommend.ts` (pure rules), `syncRecommendations` in `convex/lib/texting/case.ts`,
`actOnRecommendation` in `convex/textingCase.ts`, `src/components/app/texting/recommendations.tsx`.

Deterministic rules only; no model is called, because every current finding is a known requirement
checked exactly (the existing drafts are deterministic too). Responsibility uses existing identities: a
Selestial check, or the existing agent that owns the work (Retention for promotions, or as configured).

| Rule | Example | Proposal | Approval |
|---|---|---|---|
| `name_mismatch` | "Your business name differs between two records" | Confirm the field (never picks a name) | Owner |
| `promotions_without_marketing_consent` / `draft_requirement` | "This registration includes promotions, but your wording doesn't…" | Selestial's draft wording | Owner |
| `review_copy` | "This opt-in screenshot needs a blank or redacted review copy" | Add a review copy | Owner |
| `correction_field` | "A correction was asked for on legalName" | Open the step | Owner |
| `coverage_gap` | "Your registration covers job offers but not promotions" | Update the registration | Owner; the fee only at submission |
| `evidence_required` | "Add evidence: opt-in screenshot" (own website, "somewhere else", or a configured rule) | Placeholder | None |

Each row stores the setup revision and a fingerprint of exactly the facts it read. On every relevant change
the rules run again: a changed finding is revalidated, an approved one becomes **stale** and its approval is
withdrawn, and one that no longer applies is resolved. Every action sends the fingerprint the person saw; a
mismatch is refused ("made for an earlier version") and nothing is written. Approving records consent to
exactly that proposal and never submits, buys, files or charges. Support may apply draft text or add a
placeholder for the owner to review; confirming, approving, dismissing and asking stay the owner's.

## 3. Forms configuration

Code: `convex/lib/texting/config.ts`, `convex/textingConfig.ts`, staff page `/staff/texting-config`.

JSON checked against a constrained schema on every change. Supported:

- `fields`: label, help, example for business fields and drafts. **Order is not configurable**: steps group
  fields by carrier requirement, and a layout change is a release.
- `rules`: `required_when_entity`, `max_length` (may only lower the built-in cap), `pattern_preset` (named
  presets only: `no_po_box`, `https_only`, `no_free_email`), `evidence_required`.
- `ownership`: a task → `check` or an existing agent (new agents are refused).
- `templates`: rewording of named recommendation/correction templates, with only their own placeholders.
- `tutorials`: extra placements for catalog tutorials.
- `prerequisites`: step dependencies (cycles refused).
- `providerRequirements`: words, https source URL, verification date.

Rules only add requirements; built-in checks always run. Nothing is evaluated as code or used as a regular
expression, and configuration touches no access control, billing or prices.

**Workflow:** Draft → Preview (which unfinished setups would have which steps reopened) → Validate →
Publish (immediately; `effectiveAt` recorded) → Retire (the previous version is in force again) or Roll back
(copy an earlier version into a new validated version). A version that changes requirements needs a second
admin to publish; the author and reviewer are recorded with the reason.

Publishing reopens, on unfinished setups only, exactly the steps that gained a requirement, with a note
saying why. Setups with a request at Selestial or the carriers are untouched, and each submission keeps
`configVersion`.

Limits: a new label or approved rule type is configuration; a new provider capability or API still needs an
adapter in code.

## 4. Exceptions

`textingExceptions`, written through `writeException` (staff console or a Manage support session): category,
severity, field, evidence, submission version, assignee (staff, agent, owner), owner-facing words, internal
words, ask (correction, evidence, information), owner response, blocker, what can continue, next action,
follow-up date, state (waiting owner / Selestial / provider, resolved), resolution, reopen count and history.

A correction ask on a request waiting for Selestial review also puts the request in `needs_you`, exactly as
"Ask for a change" does; the existing operations detector raises it as an incident. An evidence ask leaves a
placeholder. No exception changes a carrier status.

## 5. Number journeys

Step 4 offers three routes (`textingSetups.numberRoute`):

| Route | State | What happens |
|---|---|---|
| New local number | Automated (unchanged 10DLC journey) | Search, choose, Selestial review, registration, purchase after approval |
| Bring an existing number | **Assisted** | The owner accepts the continuity statement (`PORT_WORDING`), gives the number and optionally the carrier; a request is assigned to Selestial with a two-day follow-up. Staff can run Telnyx's portability check (`POST /v2/portability_checks`, creates no order). No porting order is created: it needs the account holder's details, account number, PIN, LOA and an invoice. |
| Toll-free | **Assisted** | A request assigned to Selestial. Toll-free verification (`POST /v2/messaging_tollfree/verification/requests`) is not automated. |

Submitting the local registration is refused unless the route is "new local", so a toll-free or ported
number never goes through 10DLC. Nothing is bought, ported or released by choosing a route.

Sources (read 2026-11-22): Telnyx "Run a portability check", porting getting-started and port-in
requirements, toll-free verification guide and API reference. The porting guide says FOC dates are set by
the losing carrier and not guaranteed; the toll-free guide says verification typically takes 1–2 weeks.

## 6. Support sessions

New staff capability `onboarding.evidence` (admin, support and reviewer roles hold it). Inside a session:

| Function | Opened with | Notes |
|---|---|---|
| `textingCase.workspace` (read) | View | Internal items only with `onboarding.evidence` |
| `textingCase.fileLink` (read) | View, **content revealed** | A reveal needs a reason and second factor and is in the owner's history |
| `addEvidence`, `describeEvidence`, `addNote`, `editNote` | Manage, `records.edit` | Shown to the owner as Selestial Support |
| `actOnRecommendation` | Manage, `records.edit` | Apply/edit draft text or placeholders only |
| `manageException` | Manage, `records.edit` + `onboarding.evidence` | |
| `setReviewExposure`, `respond`, `setNumberRoute`, `requestAssistance`, `removeEvidence`, `submit` | never | Owner only |

Expiry, revocation and the Manage basis are enforced by the existing builders on every call.

## 7. Readiness

`/staff/texting` shows a readiness panel (`textingReview.readiness`): Configured / Not configured / Failed /
Not verified, from settings present on this deployment, recorded checks and received callbacks. "Run
read-only check" reads the API key and messaging profile with GET requests only. The full Telnyx check
(which files a mock brand and campaign) is separate and is not run by this panel.
