# Business configuration: from onboarding answers to a configured workspace

**The owner gives a small amount of context, leaves, comes back, and reviews configuration that was really
created in the workspace's own records: services and pricing drafts, a booking form, agreement templates,
job standards and agent context. Nothing is published, sent or activated without an explicit owner action.**

Builds on `00-plan.md` (setup) and `01-activation.md` (durable first work). This document is the Phase 1
audit and mapping, and records each phase as it is built.

## Phase 1: audit (inspected on `main` at `0898686`)

### What exists and is reused

| Area | Exists today | Reused for |
|---|---|---|
| Setup flow | Resumable, revision-checked steps (`lib/setup/path.ts`, `setup.save`), adaptive questions, "I'm not sure" on every question, website reader, client import, Jobber/Housecall Pro connectors | The initial onboarding. New questions are added to the same catalog. |
| Shared facts | `companyFacts`: value, source (owner, website, import, sign_in), `found`/`confirmed`, conflicts kept apart (`lib/setup/facts.ts`) | The business profile's provenance. Only confirmed facts drive generation. |
| Services | `Spec` with scope, exclusions, intake questions, duration, crew, nine pricing methods, modifiers, add-ons, recurring options (`lib/services/spec.ts`); 22 templates, all marked illustrative; deterministic `quote()`; `profitability()` with `targetCents`; drafts, versions, owner-only review and publish | Service drafts. Services & Pricing stays the editor. |
| Pricing setup | `pricingProfiles` (context, costs, strategy), costs: pay model, supplies, travel, fees, overhead, target and floor margin, minimum job | The one place costs live. Onboarding writes here instead of a copy. |
| Booking | Definition (steps, offered services, questions, theme, three modes: `instant`, `estimate_request`, `walkthrough_request`), readiness blockers, desktop and mobile preview, explicit owner publish | The booking-form draft. |
| Business settings | `companies.businessSettings`: postal codes and weekly booking hours, revisioned | Areas and hours the owner states. |
| Agreements | 40+ catalog document types, clause kits with `{{variables}}`, unresolved facts rendered `[[TO CONFIRM]]`, company templates with versions and review, explicit send only | Agreement drafts per service type. |
| Job standards | Quality standard templates (residential one-time and recurring, deep/move-out, commercial, office, STR) with evidence rules; per-service checklist templates | Standards drafts per service type. |
| Cleaners | Records with engagement, skills, areas, availability, pay; CSV import with duplicate checks and dry run; requirements with evidence; explicit invitations; consent never inferred | The cleaner step points at the existing import. |
| Agents | Sales proposed answers, Recruiter draft role, Dispatch coverage review, Retention reconcile, all gated by plan and pause (`agentVerdict`) and permission levels | Agent context from confirmed facts, via activation. |
| Background work | Activation: leases, retries, dependencies, notices, one summary email | Agent work. Configuration gets its own small runner (below). |

### Gaps found

1. **Setup answers that go nowhere.** `pricing.state`, `agreements.have`, `jobs.where` and the rest are stored in
   `companySetups.answers` and read only to choose the next question.
2. **One template service.** Setup and activation create a single service from the first category, with
   template example prices. Nothing adapts it to the owner's services or costs.
3. **Costs never reach a price.** Pay, margin and minimum job are used only to report profitability after
   the fact.
4. **A booking draft can't use draft services.** `starterDefinition` offers published services only, so a
   setup-made page is empty until something is published.
5. **Areas and hours stay as words.** `company.areas` is never turned into booking postal codes; hours are
   never asked.
6. **No regeneration or edit tracking.** A draft is created once; changed answers never update it, and
   nothing records whether the owner edited it.
7. **Two stores for the same context.** `pricingProfiles.context` and `companyFacts` both hold categories
   and areas.
8. **Chat cannot change facts or settings**, and its edit tools report new values without the old ones.
9. **No review workspace** that shows each prepared output, what it used, what is missing and its one
   next action.

## The mapping

Onboarding answer → authoritative record → generated configuration → consuming workflow → review requirement.

| Answer | Authoritative record | Generated | Consumed by | Review |
|---|---|---|---|---|
| Company name, time zone | `companies` | Company profile | Everything | Owner-entered: confirmed |
| Location, areas (words) | `companyFacts` | Agent context, agreement venue | Chat, Sales answers | Confirmed fact |
| ZIP codes served (optional) | `businessSettings.serviceAreas` | Booking area check | Booking, Sales | Owner-entered: applied |
| Booking days and hours (optional) | `businessSettings.hours` | Booking times | Booking capacity | Owner-entered: applied |
| Who you clean for | `companyFacts services.categories` | Which services, booking page kind, agreements, standards | Generators | Confirmed fact |
| Services offered | `companyFacts services.offered` (template ids) | One service draft per chosen service | Services & Pricing, Booking, Sales | Owner approves and publishes each |
| How you price today | `companySetups.answers pricing.state` | Price import step, or suggested prices, or quote-request booking | Services, Booking mode | Visible in the review card |
| Pay, typical margin, minimum job | `pricingProfiles.costs` | Suggested prices with stated assumptions | Quote engine, Profitability | Labelled suggestions; owner approves |
| Service agreement today | `companySetups.answers agreements.have` | Agreement drafts, or "upload your own" | Agreements | Unresolved decisions listed; owner reviews |
| Team size, arrangement | `companyFacts` | Cleaner import step, role draft, contractor/employee agreement draft | Cleaners, Recruiter, Agreements | Import review; nothing sent |
| Priority | `companySetups.priority` | Order of the review queue and agent work | Activation, review workspace | — |

## Design

- **Outputs live in their own records.** A service draft is a Services & Pricing draft, a booking form is a
  booking experience draft, an agreement is an agreement draft. Configuration keeps only a small ledger,
  `configOutputs`, saying what it prepared, from which inputs, with which hash, and where it stands.
- **Provenance.** Generation reads confirmed facts and owner-entered records only. Found (website) values
  are suggestions until the owner chooses them. Template amounts stay marked as examples unless worked
  out from the owner's own costs, and then they are labelled suggestions with their assumptions.
- **Statuses.** Preparing · Ready to review · Needs information · Approved · Published · Couldn't complete,
  read from the output's own record whenever possible (a published booking page is published, whatever
  the ledger last said).
- **Runner.** Each output kind is one job: scheduled, idempotent (one ledger row per company and kind),
  ordered by dependencies (booking after services), retried with backoff, and swept if abandoned. A
  failed job leaves the others' results in place.
- **Changed inputs.** The ledger keeps an input hash and, per record, the hash of what was generated. When
  inputs change: an untouched draft is regenerated in place; an edited, approved or published one is
  never overwritten. It is marked "Your answers changed since this was prepared" with a choice.
- **Existing companies.** A kind that is already configured (live services, a published booking page) is
  reported as such and not regenerated. Nothing is reset.

## Phases

| Phase | Delivers | State |
|---|---|---|
| 1 | Audit and mapping (this document) | Done |
| 2 | Onboarding additions: services offered, pricing inputs, ZIP codes and hours; written to their owning records | Done |
| 3 | Generators: service drafts with suggested pricing, booking draft with draft services and the right mode, agreement drafts, standards; configuration runner; "Your business setup" review workspace | Done |
| 4 | Cleaner review table on the existing import; contractor/employee agreement drafts | Planned |
| 5 | Chat tools for facts and settings with before/after previews | Planned |
| 6 | Agent context and the review workspace's agent cards | Planned |
| 7 | Scenario verification (residential, commercial, STR, mixed, skipped, existing, duplicates, retry, regenerate, limited plan) | Planned |

## Phases 2 and 3: what was built

- **Onboarding step `offer`** (optional, in "Prepare your workspace"): services offered (only those that fit
  what they clean), the costs that decide a price (pay, payroll costs, target margin, minimum job, supplies),
  ZIP codes and weekly hours. Every field may be blank. Each answer saves as given, to its home:
  `companyFacts services.offered`, `pricingProfiles.costs`, `companies.businessSettings`
  (`configure.saveOffering`, `saveCosts`, `saveAvailability`). The same form is on the review page.
- **Suggested pricing** (`lib/configure/pricing.ts`): prices a typical job with the template, asks
  `profitability()` for the price that reaches the target margin (and minimum job), and scales every amount
  by that ratio, rounded. Deterministic; every assumption written down; "not market research". Without pay
  and a margin the template amounts stay marked as examples. Assessment-only services get no price.
- **Catalog** (`lib/configure/catalog.ts`): services per category with small defaults, booking page per
  category, an honest booking mode (walkthrough for commercial or assessment work, estimate request when
  prices aren't worked out or they quote every job, otherwise instant once published), agreements and
  standards per service.
- **Runner** (`convex/configure.ts`, ledger `configOutputs`): `start` queues services, booking, agreements and
  standards; `run` claims with a lease, `build` makes one kind in one transaction, `failed` retries with
  backoff (3 attempts) and marks what depended on it as waiting; `sweep` (cron, 5 minutes) recovers lost
  workers. Booking runs after services. Starting again with unchanged answers does nothing.
- **Generators** use the existing builders: `createDraft`/`writeDraft` for services, `createExperience` plus a
  definition offering the draft services for booking forms, `createAgreement` for agreements, and the
  quality standard templates for service-level standards. Drafts made earlier by setup or activation from
  the same template, and never edited, are adopted instead of duplicated; a live booking form or service is
  left alone.
- **Changed answers** re-queue only the kinds whose inputs changed. A draft whose content still matches the
  hash it was generated with is rewritten in place; one a person edited, published or approved is kept and
  listed with why.
- **Review workspace** at `/app/setup/business`, and a "Prepare my business setup" card on setup's prepare
  step: one card per output with its status (Preparing, Ready to review, Needs information, Approved,
  Published, Couldn't complete) read from the records, what was made, what is still needed, what was left
  alone, how it was prepared, one next action, and "Prepare again".

Tests: `convex/configure.test.ts` (residential with costs, commercial without, mixed with "I quote every
job", idempotent start, an owner edit surviving a change while untouched drafts follow, adopting an existing
workspace's drafts and live form, retries to failure and the sweep, "I have my own agreement", roles and
other companies) and `convex/lib/configure/pricing.test.ts`.
