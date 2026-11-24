# Services & Pricing

**Company → Services & Pricing** (`/app/services`) is where a cleaning company designs what it sells, prices
it, checks what each job leaves it, and changes it safely. It replaced Settings › Services & pricing on
November 16, 2026; the old page redirects here.

It is the company's own pricing for its customers. Selestial's plans, Autumn billing and credit rates stay
under Settings › Plan & Usage.

## Decisions on record (Malik, November 16, 2026)

| Question | Decision |
|---|---|
| Categories fully supported at launch | Homes, short-term rentals, commercial. Property management, post-construction and specialty are templates that start on a walkthrough. |
| Audience | Internal builder first. Published services feed visit creation, Dispatch, checklists, Chat and agreement scope. Nothing customer-facing yet. |
| Who publishes | The Owner approves every live change. Chat and agents draft and submit; no tool publishes. This keeps the product brief's rule that changing prices always needs a person (`PERSON_ONLY` in `convex/lib/permissionCatalog.ts`). |
| Pricing methods | All of them, through one engine. |
| Research | Runs on its own when setup is finished (with a switch to skip it). Web research is one research brief: 10 Selestial Credits, on rate card `2026-11b`. |
| Recurring, packages, property prices | Modeled with real calendars and labeled annual averages. Nothing charges a customer. |
| Area and demand adjustments | Area and travel adjustments: yes. Demand pricing: built, off until the owner switches it on and sets its rate, with two triggers (days the owner marks, and how full the day is). The larger applies, never both, and a cap holds. |
| Strategy | Owners choose cost-plus, positioning or market-led. The cost floor is checked whatever they choose. |
| Plans | Everything on both plans. Research uses credits on either. |
| Outside systems | No sync in this release: Selestial connects to no outside pricing system yet. Nothing claims a price changed elsewhere. |

### Property prices (decided November 17, 2026)

| Question | Decision |
|---|---|
| What a property's own price changes | Its base price for one service. Extras, rush, discounts, the minimum and rounding still come from the service. |
| Who approves it | The Owner approves each one in Changes. Managers, and Chat on a person's request, propose it. Visits use it only once it is approved. |
| When the service's price changes | The property keeps its price until a person changes it or its end date passes. The review of a catalog change lists the properties that have their own price. |
| Review or end date | Optional. The Owner gets a reminder two weeks before either one. After an end date, the property pays the service's price again. |

## Where things are

| Piece | File |
|---|---|
| What a service is (validators and types, one definition) | `convex/lib/services/spec.ts` |
| The pricing engine | `convex/lib/services/engine.ts` |
| Profitability | `convex/lib/services/profit.ts` |
| Tables | `convex/lib/services/schema.ts` |
| Checks, hashes, change descriptions, specialists' notes | `convex/lib/services/store.ts` |
| Drafting and review steps (shared by the workspace and Chat) | `convex/lib/services/workflow.ts` |
| Visit pricing and the day's fullness | `convex/lib/services/operations.ts` |
| Property prices: proposing, approving, the price in force on a day, reminders | `convex/lib/services/propertyPrices.ts`; public functions in `convex/propertyPrices.ts` |
| Templates | `convex/lib/services/templates.ts` |
| Import parsing | `convex/lib/services/imports.ts` |
| Research rules, screening, company records | `convex/lib/services/research.ts`, `researchStart.ts`, `webResearch.ts` |
| Public functions | `convex/services.ts`, `convex/servicesImports.ts`, `convex/servicesResearch.ts` |
| Chat tools | `convex/lib/chat/serviceTools.ts` |
| Screens | `src/components/app/services/*`, pages under `src/app/(product)/app/services` |
| Routes, tools and the editor's sections | `src/lib/app/services.ts`; navigation entry in `src/lib/app/navigation.ts` |
| The service workspace (one-page editor, Selestial panel, Review & publish) | `src/components/app/services/builder.tsx` |
| Reviewing several drafts together | `src/components/app/services/review-all.tsx`, page `/app/services/review` |
| Selestial's draft edits and safe undo | `convex/lib/services/edits.ts`; table `serviceDraftEdits` |
| Tips, switches, labeled fields | `src/components/app/services/shared.tsx` |
| Animated price, price-split bar, margin meter | `src/components/app/services/visuals.tsx` |
| The Property prices panel on a service | `src/components/app/services/property-prices.tsx` |

## The workspace (November 24, 2026)

Services & Pricing is a collection of the company's services, with one workspace per service. It stays under
Company and is about the company's prices for its customers, never Selestial's own plans.

**The main page** (`home.tsx`)

- Add service is the primary action, and Import prices the secondary one. Comparing example jobs (the
  Studio), market research, costs and pricing setup (Owner) and review history sit under More. Each keeps
  its own address, so old links still work, and each tool page has a way back.
- Live, Drafts and Archived filter the cards. A "waiting for review" link appears only when something is
  waiting, or when several drafts are ready to review together.
- Each card shows the name, the kind of work, and the price with its unit, or "No price yet": a draft is
  never shown as $0. It also shows how customers get the service (`bookingWords`): "Customers ask for an
  estimate", "Bookable online on N live forms", or "Not online yet". Then come its status, the first thing
  blocking it (`catalog().draft.firstBlocker`), and Review, Edit or Open.
- **Drafts Selestial prepared lead the page** until they are reviewed. "Prepared" means `services.createdBy`
  is not a member, which covers business configuration, setup and activation. While configuration is
  building, the page says so from the real `configOutputs` state: a spinner only while the row is queued
  or working, and the error if it failed.
- **What Selestial used** (`services.startingPoint`) shows who the company cleans for, what it offers, its
  areas, and whether costs are known, each marked by where it came from:
  - **Confirmed**: the Owner said or checked it.
  - **Imported**: read from a file they brought.
  - **Suggested**: found, for example on their website, and not checked yet.
  - **Not known yet**: nothing yet.

  A conflicting value is shown beside the fact and never picked. Facts change only in company details.
- **Two pricing paths**: "Use my existing prices" (the import reader) and "Help me work out my prices"
  (costs, then cost-based prices with the arithmetic shown). The path that matches the setup answer
  `pricing.state` is marked "Fits what you told us".
- **The first visit** offers Set up with Selestial first, then Import prices and Create manually:
  - **Owner, when setup knows who the company cleans for**: Set up with Selestial runs
    `configure.regenerate({ kind: "services" })`. This is the same idempotent build onboarding uses. It
    adopts drafts already made from the same template, never duplicates them, and never rewrites a draft
    someone edited (`buildServices`).
  - **Owner, when setup doesn't know yet**: it links to company setup.
  - **Manager**: it opens Describe it.

**One service** (`builder.tsx`) is one page with three sections instead of the six-step wizard:

- **Service & scope**: Basics and Scope.
- **Price**: the method, then Extras. Adjustments are folded under More options.
- **Booking & team**: crew, time, skills, questions, walkthroughs, requirements and turnover details.

The step components are the same as before. Every check's field maps to its section (`sectionOf`). A
blocker's Fix button opens its section and moves focus to it. An address ending `#price` opens at that
section, and `?panel=review` or `?panel=assistant` opens that panel.

Autosave and conflicts work as before: edits are saved after 900 ms against the revision they started from,
and a refused save keeps both versions. A newer draft is adopted only when nothing on screen is unsaved.

Beside the editor are three panels: Preview, Selestial and Review. On a wide screen they sit in a sticky
rail; on a phone, a bottom bar opens each as a sheet.

**The customer preview** uses the same engine booking uses (`engine.quote`):

- It shows whether the job is a firm price, an estimate or a walkthrough first, with the reason.
- It shows the questions customers answer, the recurring options with their discounts, and that
  requirements are confirmed by the team, not shown to customers.
- "Try an example job" changes the inputs locally. Nothing is booked, quoted or saved.

### Selestial in the workspace

The panel is Chat, focused on one service. It uses the same `chat.send`, run, tools, credits and
retry (`ConversationBody` from `chat/thread.tsx`). It is not a second assistant and does not send the person
to Chat.

- **Its conversation.** The first message creates a conversation with `origin: { kind: "service_draft",
  serviceId }`. `conversationFocus` tells the model to:
  - work on that service only, with `read_service` and `edit_service_draft`;
  - use only amounts the person gave or that are already on the service;
  - never publish.

  `services.assistant` finds the person's own conversation again, since conversations are private.
- **Stale answers change nothing.**
  - Before sending, the panel saves any unsaved edits. It then sends the draft revision on screen
    (`draftRevision`, stored on the chat message).
  - `edit_service_draft` refuses if the draft has moved since (`staleRequest`, `edits.ts`). It tells the
    model why, so a late answer never overwrites newer manual edits.
  - Edits the same answer already made don't count as moved.
- **View changes and Undo.**
  - Each edit Selestial makes is recorded part by part, before and after, in `serviceDraftEdits`, with its
    summary from `describeChanges`.
  - Undo (`services.undoEdit`, Owner or Manager) puts back only the parts that still hold what Selestial
    wrote. Parts changed since are kept and named, both before you undo ("Undo keeps Description") and
    after.
  - A second Undo changes nothing.
- **Honest states.** Thinking, failure, retry and stop are the chat run's own states. Credits follow
  `aiExecutions`: one per answer, and a retry of a failed answer isn't charged again (`docs/chat`).
- **Describe it** (`/app/services/new?mode=selestial`) creates the draft, sends the description to
  Selestial beside it, and opens the service with the panel showing.

### Review & publish in the workspace

`services.reviewPreview` reads everything from the saved draft on the server:

- what changes, and example prices before and after (`priceComparison`);
- blockers and warnings;
- what publishing does (`impactLines`);
- the booking forms that offer the service, live or not (`bookingForms`);
- any change already open.

The panel says when the screen is ahead of what was read ("Saving your latest edits"), and acts only when the
two match.

The impact text matches what the application does:

- New quotes and visits use the new version.
- Live booking forms that offer the service show it as soon as it is live. No booking form is published or
  changed by publishing a service.
- Booked visits keep their scope and price, and sent and accepted proposals keep theirs.
- Recurring customers keep their price. If a Sales recurring plan is changed later, it is re-priced from
  the live service, with the Owner's approval unless the Owner made the change.
- Property prices and signed agreements keep theirs.

No blanket grandfathering is promised.

What each role sees:

- **Owner: Review & publish** (`services.publishDraft`). The revision they reviewed is submitted, approved
  for its exact hash, and published or scheduled, in one step. Every check of submit, approve and publish
  still runs. A retry finds no draft and changes nothing.
- **Manager: Submit for review** (`services.submit`). Agents can do neither.
- **A change already in review**: the Owner can approve and publish it there for its hash.

**Several at once** (`/app/services/review`): drafts that are complete and differ from what is live are
listed with checkboxes and one shared reason. Each is published, or submitted, on its own for the revision
shown. One that fails says why, and the rest keep their results.

## Showing, not explaining

The screens keep configuration copy short. These rules apply to every Services screen:

- **Only what is needed to fill a field stays visible**: the unit beside every amount, and short notes like "Leave
  empty for none". Anything that explains *why* goes in an `InfoTip`, which opens on click or tap (and on hover
  with a pointer), closes with Escape, and is named "About {label}". The tip sits outside the `<label>`, so the
  input keeps its own accessible name.
- **The effect of a setting is shown, not described.**
  - The preview's price rolls to its new value and shows how much the last edit moved it.
  - The Pricing step shows "A usual job", worked out by the engine from what is typed.
  - Each pricing method is a card with an icon and a made-up example. Four common methods show first; the rest
    are one tap away.
- **A setting that is off takes one line.** Each adjustment is a card with a switch. When it is on, the card
  carries a tag saying what it does ("+25%") and its fields open beneath it.
- **Totals first, detail on request.**
  - The breakdown ("How it adds up") and the cost table are folded.
  - "Base / Added / Off" summarize the price at a glance.
  - A walkthrough is "From $400.00" or "Set after a walkthrough", never a bare number or $0. An estimate is
    "About $180.00".
- **Costs and earnings are pictures with words.**
  - A thin bar splits the price into direct costs, overhead and what remains, with a legend listing names and
    amounts, and the full split as the bar's accessible name. Its colors were checked for color-blind
    separation in drawing order.
  - The margin is a meter with ticks at the floor and target. Its standing ("Under your 40% target") is written
    out with an icon, never shown by color alone.
- **A change review shows only what moves.**
  - Each change reads as label, old value (struck through), then new value.
  - Example jobs whose price moves show the difference in dollars and percent; unchanged ones are folded.
  - What approving does is a short checked list.
- **Long lists fold.**
  - Each extra is one row showing its name, its price with unit (or "Included"), and its time. Its fields
    open beneath it, and a new extra opens straight away.
  - On a live service, versions read as a timeline, with "Roll back to this" on each earlier version.
- **Progress is shown, not described.** Each editor section shows how many things in it need fixing, and
  the Review panel lists them with a Fix button that opens the section.
- **Template prices are named.** `keptTemplateAmounts` (`convex/lib/services/store.ts`) lists the money
  amounts in a draft that still exactly match its template's illustrative numbers. Review groups them by
  amount, each opening the Price section, so the owner confirms specific prices rather than "every amount".
  Times and counts are not listed: they describe the work, not a market's prices.
- **Research starts a real Chat conversation.**
  - Market research (under More) opens on Chat's own composer, centered on the page, with four starter ideas built
    from the company's area.
  - Sending creates a conversation with `origin: research` (`chat.send`) and opens it in Chat. The first
    question is kept with the conversation for every reply (`<conversation>`), alongside the business and
    the person (`docs/chat/00-architecture.md`).
  - In the conversation, Chat can start a brief with `start_research`, after the person approves. Web
    research costs 10 credits; without it, the brief uses the company's own records, free. When a web brief
    finishes, the conversation gets a "Research ready" message with a link, and `read_research_brief` reads
    it.
  - The page lists the person's research chats and every brief, with where each started. A brief started
    in a chat links back to it.
  - Office sees the briefs without the box.
- **Research draws its range.** Comparable prices that share the range's unit are dots on one line, with
  the computed range as a band. The service's own starting price (`startingCents`, `engine.ts`) is marked
  only when the range is of advertised starting prices per visit, so like is compared with like.
- Motion respects reduced-motion settings, and screen readers hear the final price, never the frames in between.
- Text uses `text-brand-300`, the app's deep violet on white. The light theme reverses the brand scale, so
  `text-brand-700` is pale there.

## One catalog

- `services` holds identity: a stable `key` (a migrated service keeps its Settings id, so visits that name it
  still resolve), its status (`draft`, `active`, `archived`) and which version is live.
- `serviceVersions` are immutable. Each stores the whole spec and the SHA-256 of its canonical form. A
  rollback writes a new version whose `basedOn` names the old one; history is never rewritten.
- `serviceDrafts` holds the one working draft per service, shared by people and Chat. Every save names the
  revision it started from. A different revision is refused, with who saved and when. Nothing is overwritten
  unless a person chooses "Save my version over theirs".
- On first open by the Owner, the services in `companies.businessSettings.services` are copied once into
  version 1 (live, `source: "settings"`). Settings' copy is left as a record and is no longer read once
  `companies.servicesMigratedAt` is set. Before that, `jobs.create` still reads it, so nothing breaks
  between deploy and first open. `services:migrateCompany` (internal) moves a company without anyone
  opening the page.

## The engine

Pure, deterministic code. It never reads the clock, randomness or the database. The builder preview, Pricing
Studio, Chat and visit creation all call it, so the same version and inputs give the same price everywhere.
A model never produces a price.

**Methods:**

- fixed per visit;
- hourly per cleaner, or hourly for the crew. The label always says which, with a minimum and billing
  increments;
- size bands, half-open, where each band covers its lower bound up to but not including its upper bound;
- rate per square foot or meter, in millicents, so $0.085 survives;
- bedrooms and bathrooms;
- per unit (room, load, window, turnover);
- recurring package, priced per calendar month;
- custom quote, with an optional "from" price that is always labeled.

**Calculation order** (`CALCULATION_ORDER`, shown to owners in these words):

1. Base price from the method.
2. Property condition. Price and time change separately; a level can require a walkthrough.
3. First-clean reset.
4. Extras. An extra linked to an included task is shown as included and never charged.
5. Short-term rental laundry, by load.
6. Area or travel.
7. Rush or after-hours.
8. Demand, when on: the larger of a marked day and a busy day, never both, capped.
9. Recurring discount and promotion, on the cleaning amount only, combined by the service's rule. "Best only"
   applies the larger. "Stack" applies the recurring discount first and the promotion to what remains. The
   total discount never passes the service's limit. Only approved promotions, inside their dates, apply.
10. Minimum charge.
11. Rounding.

**How results are reported:**

- Every line is rounded half away from zero when it is computed, and the total is always the sum of the
  lines shown (tested across a grid of inputs).
- Restocking billed at cost is listed as "billed after the visit" and is never in the total. Condition
  charges apply only after a person reviews photos.
- Each result is one of: **firm**; **estimate** (hourly work, or an assumed input such as an unstated
  condition, postal code or date); **walkthrough** (above the largest band or area limit, a severe
  condition, a flagged answer, a custom quote, or a postal code outside a refusing service's areas); or
  **incomplete**, which lists exactly what is missing. A walkthrough or incomplete job has no price unless a
  "from" price is set, and that is labeled.
- Time is labor-minutes (all cleaners) and minutes on site (on the clock). The engine warns when a visit
  passes the service's longest visit, suggesting a crew that would fit. It also warns when a turnover cannot
  fit between checkout and check-in, and when laundry passes the site's machines.

**Recurring schedules are calendars, not "four a month":**

- Every 7 days is 52.18 visits a year (4.35 a month on average, 4 or 5 in a given month).
- Every 14 days is 26.09 (2.17 on average).
- Twice or once per calendar month is exact.
- `scheduleDates` lists the real dates, clamping a 31st to the month's end.
- Studio shows the twelve-month calendar and labels every annual figure as an estimate.
- A monthly package keeps one price per calendar month and shows the per-visit annual average.

**Checks before review** (`checkSpec`):

- Blockers:
  - an unnamed service;
  - overlapping or gapped bands;
  - malformed amounts;
  - demand pricing on without a cap or a trigger;
  - illustrative amounts not confirmed;
  - requirements not confirmed.
- Warnings:
  - a price drop or a jump of more than 50% at a band boundary;
  - $0 prices;
  - an extra that is also an included task;
  - missing scope or exclusions;
  - unapproved promotions.

## Profitability

From the costs the Owner entered under Pricing setup (`pricingProfiles`). These costs are the Owner's alone,
like pay: Managers and Office never receive them.

- Pay is one model at a time: hourly with payroll costs, a set amount per cleaner per visit, or a share of
  the price. The models never mix.
- Direct costs are labor, supplies, travel, equipment, laundry by load, and card fees (percent plus fixed).
- Contribution after direct costs is labeled as not net profit. "Estimated operating profit before taxes"
  appears only when an overhead allocation is entered.
- Margin is a share of price and markup a share of cost; both are shown, with the definitions.
- A cost not entered is listed as missing and never counted as $0.
- The floor price and the target price are solved, not estimated. Costs that grow with price, such as a
  revenue share or a card fee, are included in the solve.
- Prices below the floor margin or the minimum job are flagged.

## Review and publishing

- **Draft.** A person or Chat edits the draft, which is saved after a short pause.
- **Submit.** Submitting freezes the draft as a new version and opens a change `in_review`. The change
  records the version, the live version it replaces, a hash binding the two (plus timing), and the reason.
  It also stores evidence: research, import rows, and example jobs priced before and after. Alongside that
  are the specialists' notes, the impact in words, and whether customers must be told or agreements
  reviewed.
- **Approve.** Only the Owner approves, and approval is for that hash. The Owner may approve only, approve
  and publish, or approve and schedule for the start date.
- **Returned.** Any later save of the draft returns the change, and the approval goes with it. So does a
  live version that moved. Approving or publishing re-checks both.
- **Scheduled.** A scheduled change is published by the scheduler at its start date after checking
  everything again. If anything moved, it is returned with the reason and an event.
- **Published.** The service's live version moves, and other open changes of the same kind are marked
  superseded. The service's checklist template gets a new version if its scope changed.
- **Archive and restore** are changes too, reviewed the same way. An archived service is refused for new
  visits; booked ones keep it.
- **What is never touched.** Accepted quotes, booked visits, recurring customers' prices and signed
  agreements stay as they are. The impact text says so, and repricing an existing customer is a separate
  workflow that is not built here.

Every step writes an event (`service.*`) to the append-only log.

## Property prices

![The Property prices panel on a service](../screenshots/services/14-property-prices-1440.png)

A property can have its own base price for one service, for example after a walkthrough, or for a rental
listing priced differently from the bands.

**Where it shows.** The **Property prices** panel sits under the service, whether or not a draft is open. It
shows three groups:

- the prices in force, each with its date (a due date stands out) and its own cleaner time, marked when it
  kept its price through a change to the service;
- the proposals waiting for the Owner, each linked to its review;
- the ones that ended or were replaced, folded away.

**Proposing.** Owners and Managers choose the customer and property, the base price, optionally the cleaner
time there, a review or end date, and why. The form prices the service's example job at the property and
elsewhere, with the same engine visits use. Sending it opens a change of kind `property_price` in
**Changes**. A newer proposal for the same property and service replaces an older open one.

**Reviewing and approving.** Only the Owner approves, one button, for that exact proposal (its hash).

- The review shows the property and customer.
- It shows the proposed price beside the property's current one (struck through) and the service's price.
- It prices the example job both ways.
- The catalog version is not checked: a property price keeps its price when the catalog moves (the
  decision above).
- What is checked is the property's own price. If another price for the property was approved or ended
  after this was proposed, the review says so and approval is refused.
- Approving writes a `propertyPrices` row (`active`). The one it replaces is kept, marked `replaced`.
- Approving one property's price never touches another property's proposal.

**Pricing.** The engine takes `propertyPrice` (`QuoteInput`), which replaces only the base line ("Base price
for this property").

- The size, rooms or walkthrough the method would need are not asked again.
- Condition, first clean, extras, area, rush, demand, discounts, the minimum and rounding still apply, in
  the usual order.
- The time is the property's own cleaner time when given, else the method's, else the service's usual.
- An hourly service becomes the property's flat price. A monthly package's per-visit average follows the
  property's monthly price.

**Visits.** `jobs.create` looks up the price in force at the property, for the service, on the visit's own
day (`priceInForce`). It never takes one from what a screen or a model sent: `quoteInputValidator` has no
such field, and the server removes one if it appears.

- The visit form reads the same price (`propertyPrices.forVisit`) to show it. "Base price for this property"
  appears in the breakdown, and the price the person saw is checked as usual.
- The saved quote keeps the property price's id in its inputs.
- A visit on the last day of an end date gets the property's price. A visit the day after pays the
  service's price, whether or not the daily sweep has run.

**Dates and reminders.** A daily cron (`propertyPrices.sweep`, 12:23 UTC) does two things:

- Two weeks before a review or end date, it opens one task for a person, about the property. It says
  Selestial will not change or extend the price.
- After an end date, it marks the price ended.

It never proposes, approves or extends anything.

**What's different here** (optional, added November 18, 2026). A property price can also carry the
property's own scope and extras, reviewed and approved with it:

![What's different here](../screenshots/services/18-property-different-here-1440.png)

- **Tasks also done here**, one per line: at most 20, 800 characters together. They are added after the
  service's scope on each new visit there, under "At this property:". They are also added to the visit's
  checklist, in an "At this property" section. This happens whether the price came from the engine or was
  typed, because they are scope, not price. When a long service scope would push the visit's scope over
  its 2,000 characters, the service's part is shortened and the property's tasks stay whole.
- **Extras here**: an extra the service sells can be included at no charge at this property, or sold at
  the property's own price.
  - An extra the service already includes stays free whatever the property says.
  - An included extra's time is still planned.
  - The line reads "Included at this property" or "…, this property's price".
  - A price equal to the service's is dropped, and an unknown extra is refused.
- The review lists both, the extras against the service's price, and the impact says them in words.
  Proposing the same terms again is refused. Chat's `propose_property_price` takes `addedTasks` and
  `extras`.

**Ending early.** The Owner can end a price with a reason. Booked visits keep their price.

**On Customers & Properties.** Each customer's row lists the property prices in force for their
properties. Each entry shows the service, the base, its tasks and extras, and its date, and links to the
service where it is changed (`propertyPrices.forCompany`). A full page per customer is still not built.

![Customers & Properties with property prices](../screenshots/services/19-customers-property-prices-1440.png)

**A change to the service.** Its impact says how many properties keep their own price, and its review lists
them under "Properties that keep their own price". An archive request leaves property price proposals alone.

## Operations

- **Visits.** `jobs.create` takes a service key and `quoteInput`.
  - It prices the live version with the engine, using the visit's own date. When the busy-day rule needs
    it, it adds how full that day is: booked crew-minutes against ready cleaners' availability. Nothing
    about the customer is used.
  - It refuses an incomplete or walkthrough job unless a person types the price. A typed price is recorded
    as `priceSource: "manual"`.
  - If `expectedTotalCents` (the price the person saw) differs, the visit is refused, never silently
    repriced.
  - The visit's `serviceSnapshot` stores the version, the quote id and where the price came from.
    `serviceQuotes` stores the inputs, their hash, the lines and the engine version.
  - A property's own approved price, in force on the visit's day, replaces the base (see Property
    prices).
- **Dispatch.** The visit takes the service's crew, skills, arrival window, and the engine's minutes on
  site.
- **Checklists.** Publishing writes the included tasks, by room, with photo requirements, as the service's
  checklist template; visits copy it as before.
- **Chat, sales quotes and agreements.**
  - `quote_service` and `read_service` are the only way Chat states a price or a scope.
  - Agreements and proposals drafted in Chat read scope from `read_service`.
  - Sales and Retention are not released, so their quoting and offer workflows do not exist yet. Their notes
    on each change say so.
- **Not built here:** a customer booking flow, a customer portal, payments, and sync to outside systems.

## Agents and Chat

Chat's tools (`convex/lib/chat/serviceTools.ts`) call the same workflow functions as the workspace, as the
member chatting, with their role as it is now:

| Tool | Kind | Who |
|---|---|---|
| `list_services`, `read_service`, `quote_service`, `run_pricing_scenarios` | read | everyone; draft prices and costs only for Managers and the Owner, costs only for the Owner. `quote_service` takes an optional `propertyId` and uses that property's approved price |
| `start_service_draft`, `edit_service_draft`, `attach_research` | draft | Owner, Manager |
| `submit_service_for_review` | write, approved in chat first | Owner, Manager |
| `propose_property_price` | write, approved in chat first; then waits for the Owner in Changes | Owner, Manager |
| `start_research` | write, approved in chat first (shows the 10-credit cost for web research) | Owner, Manager |
| `read_research_brief` | read | everyone |
| `update_price_book` | unavailable | says publishing is the Owner's, in Changes |

**Rules Chat works under:**

- Edits land on the same draft the workspace shows, attributed "Selestial, asked by <name> in Chat".
- From the workspace's Selestial panel, an edit for a screen that has since moved is refused, and each edit
  can be undone part by part ("Selestial in the workspace" above).
- A workspace tab that was open at an older revision is refused on its next save, and its edits are kept on
  screen.
- Chat never publishes, approves, or confirms that template amounts suit the market.
- The Chat price calculator now takes a schedule and uses its annual average. Every 14 days was being
  treated as 2 visits a month.

**Specialists' checks** (`specialistNotes`, run in code at submission) are structured contributions on the
change:

- **Dispatch** checks that a usual visit fits the longest-visit limit and, for a turnover, the checkout to
  check-in window. It also counts ready cleaners with the skills, and compares the estimate with the median
  time on site of the last completed visits. It can propose a crew size, which a person applies with one
  click.
- **Recruiter** reports how many ready cleaners meet the requirements and whether an open hiring need covers
  the skills. No applicant is named.
- **Sales and Retention** say they are not released.

## Templates

There are 22 structural templates across the six categories. Each one includes:

- scope by room, with photo marks, and exclusions;
- suitable pricing methods;
- required quoting questions with walkthrough rules;
- extras, linked to included tasks where the work is included;
- staffing and time;
- walkthrough situations;
- for specialty, post-construction and warehouse work, the training, insurance or equipment the company must
  confirm.

Every amount is illustrative (`illustrative: true`), and a service made from a template cannot be submitted
until the owner confirms its amounts and requirements in the Review step. Tests check that every template
validates, prices once its questions are answered, and blocks publishing until confirmed.

## Import

CSV or one-service-per-line text is read in code, free.

- Each row keeps its source ("Row 4", "Line 7") and its raw text.
- Flags:
  - unclear unit ("$60/hour" without per cleaner or per crew is never decided for the owner);
  - missing price;
  - missing scope;
  - listed twice;
  - already in the catalog.
- A person corrects and drafts each row, or skips it.
- An unclear value becomes an illustrative amount that must be confirmed.
- The row's source travels into the review as evidence.
- An empty, binary or unreadable file is kept as a failed import with the reason, and nothing is created.
- PDFs and photos are not read. "Ask Selestial to read it instead" hands pasted text to Chat, at Chat's
  normal cost.

## Research

A brief answers one question.

**Free parts:**

- What the company's own completed visits show (count, median booked price, median time on site), counted
  in code and labeled "Your own records".
- Sources the team adds, each labeled by kind of price: starting price, estimate or firm price.

**Web research** (when asked for, and on its own once setup is finished):

- One Anthropic call with the web search tool, at most 5 searches, billed as one `research_brief` through
  the existing Autumn reserve and finalize flow.
- Nothing is charged if it does not finish.
- Code screens the answer:
  - a finding must cite a page retrieved in that run, or it is dropped and the brief says how many were;
  - "company data" can only come from code;
  - AI inferences carry no price.
- A typical range is computed in code only from three or more comparable prices with one unit. It is
  labeled by its weakest price kind and as not a market average.
- If web research cannot run (no model, no rate on the card in force, no credits, billing unreachable), the
  brief says why in words and keeps the free parts.

The brief shows what was found, what is comparable, what remains uncertain, options with tradeoffs, every
finding with its kind and numbered sources, and each source with when it was read and what it could not
show. "Apply to draft" attaches a finding as evidence to a service's draft, and it goes into the review. It
never changes a price.

## Permissions summary

| | Office | Manager | Owner |
|---|---|---|---|
| Read catalog, versions, changes, research | ✓ | ✓ | ✓ |
| Price a job from a live version | ✓ | ✓ | ✓ |
| Draft, import, research, submit, withdraw own, start rollback | | ✓ | ✓ |
| Costs, profitability, pricing setup | | | ✓ |
| Approve, publish, schedule, return, archive or restore | | | ✓ |
| Read property prices; visits use them | ✓ | ✓ | ✓ |
| Propose a property price | | ✓ | ✓ |
| Approve or end a property price | | | ✓ |

A record of another company is "Not found." (tested).
