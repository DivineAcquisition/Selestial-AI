# Selestial: sidebar navigation

**Status: the owner's structure, recorded November 15, 2026.** Where it
differs from `00-product-brief.md` on departments and agents, this document is
the newer decision.

**What exists:** the navigation definition, the helpers that derive everything
from it, the sidebar drawn from it, and tests that check it. **What does not
exist:** the agent overview pages and most work tabs. They are listed in the
sidebar, marked "Not built yet", and do not link anywhere.

| File | What it is |
|---|---|
| `src/lib/app/navigation.ts` | The one definition: departments, agents, work tabs, company-wide items, paths, availability |
| `src/lib/app/navigation-helpers.ts` | Agent lists, links, active item, breadcrumbs, deep links, sidebar state, badge priority |
| `src/lib/app/navigation.test.ts` | Validation: names and order, unique ids, no conflicting paths, department mappings, availability against real pages |
| `src/lib/app/badges.ts` | Turns the record's facts into badges. The facts come from the `overview.sidebar` query |
| `src/components/app/sidebar.tsx` | The sidebar. It adds icons and markup; the structure is the definition's |

---

## 1. Structure

Three departments. They are departments, not lifecycle stages. Eight agents
work inside them.

| Department | Agents, in order |
|---|---|
| **Growth** | Marketing, Sales, Retention |
| **Operations** | Dispatch, Quality, Customer Care |
| **Team** | Recruiter (with the shared Cleaners workspace) |

| Agent | Owns |
|---|---|
| Marketing | Generates customer interest. |
| Sales | Turns inquiries into confirmed bookings. |
| Retention | Notices when a customer relationship needs attention, coordinates the response, and verifies what happened afterward. |
| Dispatch | Visit eligibility, assignments, coverage, and service coordination. |
| Quality | Reviews service evidence, investigates issues, coordinates corrective work. |
| Customer Care | Handles customer communications, setup, requests and scheduling changes. |
| Recruiter | Applications, hiring, onboarding, and readiness. |

**Team Coordinator was retired on November 22, 2026**, before it was ever released. It never ran: it was a
coming-soon page, a catalog entry and a queue label on tasks a person worked. Its responsibilities have owners
that already run, so nothing is duplicated or lost (section 9).

Two pairs of names are close and stay with their owners:

- **Customer Setup** is Customer Care's and is about customers. **Onboarding &
  Readiness** is Recruiter's and is about cleaners.
- **Offers & Agreements** is Recruiter's and is about hiring. **Offers &
  Coverage** is Dispatch's and is about job assignments.

## 2. The sidebar, top to bottom

The order is fixed (`SIDEBAR_SECTIONS`). It changed on November 21, 2026: the
company-wide shortcuts moved above the department tabs, so the tabs sit
directly above the agents they choose between.

1. **Business selector.** The active cleaning company. Switching changes the
   whole workspace and its data. There is no client selector: customers and
   properties are records inside a company. No location selector until
   multi-location support exists.
2. **Persistent navigation.** Home, Approvals, Calendar, Inbox, Search. Always
   visible, whichever department is selected. Calendar sits directly under
   Approvals (the owner's decision of November 23, 2026).
3. **Department tabs.** Growth | Operations | Team, under an "Agents" heading.
   Choosing one changes which agents are listed directly below. It does not
   change the business, it does not navigate, and it does not filter Home,
   Approvals, Calendar, Inbox or the shared records. A small mark on a tab shows which
   department holds the page that is open.
4. **The selected department's agents.** Each agent has a name that opens its
   overview, a separate arrow that opens its tabs, the nested work tabs, and
   one status beneath the name. An agent that is not released has no arrow
   unless one of its tabs is really built (`disclosedTabs`): its name opens
   the coming-soon page, which says what each tab will do.
5. **Shared business navigation.** Chat, Services & Pricing, Clients &
   Properties, Cleaners, Agreements, Finance, Reports. Company-wide.
6. **Footer.** Settings only, pinned below the scrolling list.

How the rows line up, how the active page and an open group differ, and the
rest of the frame are in [07-layout.md](07-layout.md).

**Shared records are shared.** An agent tab is a view over the company's
records, never a second copy. Dispatch's availability view and Team
Coordinator's Availability tab read the same cleaner records that the Cleaners
page shows.

**Finance is the cleaning company's money.** Selestial's own subscription
billing is separate and lives inside Settings.

## 3. Work tabs

Names and order are the owner's. Playbook is always last. Chat is never a tab: it is one company-wide destination under Company, and the conversation decides which specialist's tools it needs.

| Agent | Tabs |
|---|---|
| Marketing | Campaigns · Content & Creative · Promotions · Lead Sources · Performance · Playbook |
| Sales | Pipeline · Internal Booking · Quotes & Proposals · Follow-ups · Conversations · Booking Forms · Playbook (Internal Booking added November 24, 2026: see below) |
| Retention | Needs Attention · Recovery · Continuity & Renewals · Re-engagement · Playbook (changed November 18, 2026, when Retention was built: see `docs/retention/00-architecture.md`) |
| Dispatch | Dispatch Board · Schedule · Offers & Coverage · Live Jobs · Action Links · Playbook |
| Quality | Reviews · Cases · Corrections · Standards · Insights · Playbook (changed November 22, 2026, when Quality was built: see `docs/quality/00-architecture.md`) |
| Customer Care | Conversations · Customer Setup · Service Requests · Rescheduling & Cancellations · Playbook |
| Recruiter | Hiring Needs · Applicants · Screening · Interviews · Offers & Agreements · Onboarding & Readiness · Playbook |

### Sales: Internal Booking, Quotes & Proposals and Booking Forms

Three tabs, three jobs, one booking system behind them:

- **Internal Booking** (`/app/agents/sales/internal-booking`) is where the
  company books service for a customer itself: a new one-time or recurring
  booking, and every booking draft still in progress, quoted, awaiting
  confirmation or booked. Opening the tab creates nothing; a draft is made only
  when someone chooses New booking or New recurring booking, and a double click
  or a retried request returns the same draft.
- **Quotes & Proposals** (`/app/agents/sales/quotes-proposals`) is where saved
  quotes are reviewed (saved, sent, accepted, expired, withdrawn) and where
  commercial, office and short-term rental proposals are prepared and followed
  through. A quote saved from a booking stays listed here; "Continue to booking"
  opens its draft.
- **Booking Forms** configures what customers see when they book online.

Both Internal Booking and Quotes & Proposals open the same workspace
(`/app/agents/sales/book/[draftId]`). Its address is the same for both, so the
workspace tells the sidebar which tab it belongs to from the draft's mode
(`SALES_WORKSPACE_TAB` in `navigation.ts`, applied as an `owner` hint in
`navigation-helpers.ts`), and changes it if the mode is switched. The back link
returns to where the person came from (`?from=`: Internal Booking, Quotes &
Proposals, Pipeline, a customer, Calendar, Dispatch or the Sales overview), and
otherwise to the tab the draft belongs to (`src/lib/app/sales-workspace.ts`).

### What Dispatch's tabs must hold

These are requirements for the future workspaces, not work done here.

| Tab | Must accommodate |
|---|---|
| Dispatch Board | Jobs needing staffing; pending dispatch approval; offers sent; partially staffed jobs; confirmed crews; jobs requiring intervention |
| Schedule | Daily and weekly views; arrival windows and projected duration; cleaner availability; conflicts and buffers; changes affecting later jobs |
| Offers & Coverage | Standard offers; broadcast offers; acceptance, decline and expiration; backup coverage; unfilled jobs; urgent-hire requests handed to Recruiter |
| Live Jobs | Check-ins and progress; running-late updates; checklist progress; drops and replacement needs; completion awaiting quality review |
| Action Links | Job offer links; contractor checklist links; before/after photo upload links; coverage response links; ETA response links |

Action Links is a management view. Every link is also reachable from its job;
nobody has to go through Action Links to act.

Six states stay distinct everywhere: an offer **sent**, a cleaner
**accepting**, a job **fully staffed**, a cleaner **finishing**, **quality
review**, and **financial completion**. None is inferred from another. Today
the record separates the first two and job completion; "fully staffed" (more
than one cleaner on a job), quality review and financial completion do not
exist yet.

### Every agent overview

The page an agent's name opens will show: its current responsibilities and
work, items needing the owner's attention, recent outcomes, an "Ask [Agent]"
entry point, and activity history with agent controls. Conversation with the
agent is opened from the page header or a side panel, never from a sidebar
tab.

The **Playbook** says how that agent works within the company's rules. Company
policies have one source of truth (Settings); a Playbook refers to them and
does not keep its own copy.

## 4. Route map

Everything signed-in is under `/app`. Home is the landing page.

**Agents use two route patterns, which will serve all eight agents and 47
tabs:**

- `/app/agents/[agent]` is the overview.
- `/app/agents/[agent]/[tab]` is a work tab. Records beneath a tab continue
  the path, for example `/app/agents/dispatch/live-jobs/<job>`.

The agent's id is in the path and its department is not, so a deep link keeps
working if an agent ever moves department. Departments have no page of their
own.

Three states describe each destination:

- **Live**: a page exists at its own path.
- **Interim**: no page at its own path yet; an existing page serves it in
  whole or part, and links go there until the real page exists.
- **Planned**: not built. It is shown as not built and is never linked as if
  it worked.

### Company-wide destinations

| Destination | Path | Today |
|---|---|---|
| Home | `/app` | **Live.** The Overview. |
| Approvals | `/app/approvals` | **Live.** The decision queue. |
| Calendar | `/app/calendar` | **Live.** The company's whole schedule, read from the records that hold it: visits and crews, interviews, walkthroughs, time off, due dates, connected-calendar busy time. Dispatch › Schedule stays the staffing view over the same jobs. See `docs/calendar/00-architecture.md`. |
| Inbox | `/app/inbox` | **Planned.** A page exists and says conversations are not built. |
| Search | `/app/search` | **Planned.** |
| Chat | `/app/chat` | **Live.** Under Company, for every department. The name opens the conversation workspace; a separate arrow lists New chat, Search chats, pinned and recent chats, and All chats. One conversation is `/app/chat/[id]`; the searchable, paged history is `/app/chats`. Each chat is private to the person who started it. See `docs/chat/00-architecture.md`. |
| Services & Pricing | `/app/services` | **Live.** Under Company. Services, Pricing Studio, Research & Insights, Changes; the guided builder; templates, import and setup reached from them. Moved out of Settings on November 16, 2026; `/app/settings/services` redirects. See `docs/services/00-architecture.md`. |
| Customers & Properties | `/app/customers` | **Live.** A list and an add form; no page per customer yet. |
| Cleaners | `/app/cleaners` | **Live.** A list and an add form; no page per cleaner yet. |
| Finance | `/app/finance` | **Live** (November 17, 2026): Overview, Invoices & Payments, Expenses and Team Pay, with Payments setup at `/app/finance/setup`. Profitability shows as not built yet. Owner only. See `docs/finance/00-plan.md`. |
| Reports | `/app/reports` | **Interim** at `/app/insights`. Weekly measures only. |
| Integrations | `/app/integrations` | **Live** as a list of every integration, what it does and which agents use it. Each connection is built in phases (`docs/integrations/00-plan.md`); none connects yet. |
| Agreements | `/app/agreements` | **Live.** The company's own customer, workforce and business agreements (`docs/agreements/00-architecture.md`). Selestial's own Terms are under Settings. |
| Settings | `/app/settings` | **Live.** A routed workspace; its sections are listed in `src/lib/app/settings.ts` and described in `05-settings.md`. |

### Agent destinations

Dispatch has a workflow, and Sales › Booking Forms is live. Every other
agent's overview and tabs are planned.

| Destination | Path | Today |
|---|---|---|
| Dispatch (overview) | `/app/agents/dispatch` | **Live.** Today and tomorrow, counted, with what needs a person and what Dispatch did. |
| Dispatch › Dispatch Board | `/app/agents/dispatch/dispatch-board` | **Live.** Visits grouped by where staffing stands, as a board or a list. |
| Dispatch › Schedule | `/app/agents/dispatch/schedule` | **Live.** Cleaner lanes by day or week. `/app/schedule` redirects here. |
| Dispatch › Offers & Coverage | `/app/agents/dispatch/offers-coverage` | **Live.** Open offers, places that lost a cleaner, places nobody is asked for, and history. Starting a broadcast or a Recruiter request by hand is not built. |
| Dispatch › Live Jobs, Action Links, Playbook | `/app/agents/dispatch/<tab>` | **Live.** |
| Sales › Booking Forms | `/app/agents/sales/booking-forms` | **Live** (November 18, 2026). Titled "Booking Experiences": each experience, booking rules, recent bookings and requests. One experience's builder is `/app/agents/sales/booking-forms/[id]`; the public pages are `/b/<handle>/<slug>` on the link host. See `docs/booking/00-architecture.md`. |
| All other tabs of the other seven agents | `/app/agents/<agent>/<tab>` | **Planned.** |

The exact path of every tab is `tabPath(agent, tab)` in `navigation.ts`; tab
ids are the kebab-case of the label (`quotes-proposals`, `re-cleans`,
`team-check-ins`).

### Pages that exist and are not a destination's own path

| Existing page | Today | Becomes |
|---|---|---|
| `/app/decisions` | Redirects to Approvals. | Removed once old links have moved. |
| `/app/records` | Redirects to Customers & Properties. | Removed once old links have moved. |
| `/app/team` | Redirects to Settings. The AI Team page is retired. | Removed once old links have moved. |
| `/app/schedule` | Redirects to Dispatch › Schedule. | Removed once old links have had time to move. |
| `/app/insights` | The week's measures. | Reports at `/app/reports`, with a redirect. |
| `/app/departments/[department]` | A workspace per department. Only Operations is linked, as the stand-in for Offers & Coverage. | Nothing directly. Departments have no page. |

Every link inside the app to one of these destinations goes through
`linkTo(id)`, so a page that moves is changed in one place.

## 5. Interaction rules

The helper that implements each rule is named, so the sidebar calls it and
does not re-implement it.

1. **Remembered per person and per company.** The selected department and the
   open agents are stored under `sidebarStorageKey(userId, companyId)`.
   `parseSidebarState` ignores anything malformed or naming an agent that no
   longer exists.
2. **A new workspace starts with Operations selected, on Home.**
   `initialSidebarState()`, `LANDING_PATH`.
3. **Choosing a department does not navigate.** `selectDepartment` returns new
   sidebar state and nothing else. The page stays where it is.
4. **Opening an agent page selects its department, opens that agent and
   highlights the exact tab**, whether reached by a click or a deep link.
   `syncToPath` and `activeFor`. A company-wide page leaves the sidebar as it
   was.
5. **Several agents may be open at once.** `toggleAgent` opens or closes one
   and leaves the rest. No accordion.
6. **The name navigates; the arrow only opens and closes.** They are two
   controls. The arrow is a button with its own accessible name ("Show
   Dispatch's work tabs") and `aria-expanded`. An agent with no overview page
   yet has a name that is plain text: it neither navigates nor toggles.
7. **Approvals, Calendar and Inbox are reachable from every department.** They are in
   the persistent section, which department tabs never change.
8. **Badges state something to act on**, in words: "2 unfilled", "3 to
   review". Never a count of messages sent or a decorative activity number.
9. **A problem outranks "working".** `topBadge` shows urgent, then a decision
   needed, then something to look at, and only then working.
10. **Status never depends on color alone.** Every badge has words; a badge
    without words is not shown.
11. **On a phone the sidebar is a drawer** and closes when a destination is
    chosen. Choosing a department or pressing an arrow does not close it.
12. **Permissions decide access; hiding a link does not.** `mayShow` only
    decides whether to draw a link. Every read and write is checked in Convex.
13. **A paused agent's records stay reachable.** Pausing stops the agent from
    acting. Its tabs, and the jobs, cleaners and customers behind them, stay
    open. `mayShow` does not take the paused state as an input, on purpose.

### Badges

The definition holds no counts, no states and no badge values. The
`overview.sidebar` query counts what the record knows, and `badges.ts` turns
those counts into words. One badge per agent, one per tab, and one on
Approvals.

| Where | Badge | Kind |
|---|---|---|
| Approvals | "2 to decide" | Decision |
| Dispatch | "2 unfilled" when a visit nobody has been asked to take starts within a day | Urgent |
| Dispatch | "1 for you" when a task or proposal is waiting on a person | Decision |
| Dispatch | "2 unfilled" when the unfilled visits are further out; "Paused" | To look at |
| Dispatch | "Working", "Waiting on replies" | In progress |
| Dispatch › Offers & Coverage | "2 unfilled"; "3 awaiting reply" | Urgent or to look at; in progress |

An unbuilt agent never has a badge. While the record is loading no badge is
shown, never a guessed one.

## 6. Availability rules

- The definition is the full plan. Each destination carries its own
  availability, so the plan and what is built never get confused.
- **All eight agents are listed.** An unbuilt agent is marked "Not built yet",
  has no overview link and no badge, and its tabs are listed without links.
- **A planned destination has no link.** `hrefFor` returns nothing for it. It
  is listed, marked as not built, so the owner can see what is coming.
- **An existing record page can be available before its agent is.** Customers,
  Cleaners and the Schedule work today although Customer Care, Team
  Coordinator and most of Dispatch's tabs do not.
- **The tests keep this honest.** A destination marked live must have a page.
  A planned one must not, unless it is marked as a notice page. Every page
  under `/app` must be a destination or be listed with what replaces it. So
  building a page without updating the definition fails the build, and so does
  marking something live that is not there.
- **Which agents are built comes from the backend's catalog**
  (`convex/lib/departments.ts`). The test fails if the navigation disagrees.

### Access

`minimumRole` on a destination is the least role the link is drawn for.

| Destination | Drawn for | Note |
|---|---|---|
| Everything not listed below | Office, Manager, Owner | Actions inside each page are checked separately. |
| Approvals | Everyone | Owners and Managers decide. Office sees only tasks handed to a person. |
| Calendar | Everyone | Office sees visits, crews, cleaners' time off and Dispatch's due dates. Interviews, walkthroughs, members' time and connected calendars are for Owners and Managers. |
| Cleaners | Everyone | Pay rates are shown to the Owner only. |
| Settings | Everyone | Only the Owner changes company details, people, authority and billing. |
| Finance | Owner only | The owner's decision. |
| Integrations | Everyone sees; Owner connects | Only the Owner connects or disconnects (the owner's decision, November 16). |

## 7. What remains

### Still to build

- The two agent route patterns, and each agent overview: responsibilities and
  work, items needing attention, recent outcomes, Ask [Agent], history and
  controls. The retired AI Team page showed Dispatch's recent outcomes; nothing
  shows them until its overview exists.
- 45 of the 47 work tabs. Two (Dispatch's Schedule and Offers & Coverage) are
  served in the meantime by existing pages.
- Search, Inbox. (Finance's Profitability tab.)
- A page per customer and per cleaner.
- Badges for the seven agents that have no workflow.
- Moving Schedule and Reports to their own paths, with redirects.

### Reusable when those are built

| Existing | Reuse for |
|---|---|
| Schedule table with Today / Tomorrow / Week | Dispatch › Schedule. |
| Coverage list on the Operations workspace | Dispatch › Offers & Coverage, and the Dispatch Board's "needs staffing" column. |
| Dispatch's ranking, run trace, take-over and hand-back in the visit panel | Dispatch Board and Offers & Coverage. |
| Agent permissions and pause in Settings | Each agent overview's controls, linking to the same settings. |
| Dispatch settings in Settings | Dispatch › Playbook, which refers to them. |
| Weekly measures | Reports. |
| The shared detail panel | Every workspace that opens a visit, an approval or a task. |

### The backend

The backend's departments are Growth, Operations and Team, grouping the five
agents it knows: Sales and Retention, Dispatch and Quality, Recruiter. A test keeps that
grouping in agreement with the sidebar's.

Two gaps remain, and both wait for each new agent to be designed:

1. **Marketing and Customer Care have no id in the schema**, so they
   cannot own a task, an approval or a permission. (Quality has had one since
   it was built on November 22, 2026.)
2. **The permission catalog has no actions for them.**

## 8. Decisions and open questions

Decided by the owner on November 15, 2026:

| Question | Decision |
|---|---|
| Unbuilt agents in the sidebar | List all eight; mark the unbuilt ones "Not built yet", with no links. |
| The decision queue's path | `/app/approvals`, titled Approvals, with a redirect from `/app/decisions`. |
| Who sees Finance | The Owner only. |
| The AI Team page | Retired. Agent permissions and pause moved into Settings. |
| The backend's departments | Regroup the four existing agents now. Add the four new agents when each is designed. |

Still open:

1. **Books.** Settled November 17, 2026: no ninth agent. Finance is a shared
   area; Company Chat and the existing agents work in it within their roles.

## 9. Team Coordinator's retirement (November 22, 2026)

The boundary: **Recruiter gets a person ready for work. Dispatch decides whether that person can take a
specific visit and coordinates it. The Cleaners workspace holds the shared workforce record.**

| Responsibility | Owner |
|---|---|
| Applicant intake, follow-up, screening, interviews, offers | Recruiter |
| Onboarding checklist, documents, agreement, missing requirements | Recruiter (Onboarding & Readiness), recorded on the shared cleaner record |
| Initial skills, service areas and stated availability | Recruiter gathers them; saved to the Cleaners record |
| Presenting a person for readiness approval | Recruiter; an Owner approves (`onboarding.approve`) |
| Profiles, availability, time off, skills, areas, documents, notes | Cleaners workspace (shared, read by Dispatch) |
| Eligibility for a specific visit, offers, acceptances, declines | Dispatch |
| Coverage gaps, call-outs, replacements, reminders, check-ins | Dispatch |
| A cleaner who cannot be reached by text | Dispatch's own task, held for a person (was the Team Coordinator queue) |
| Pay records and payments | Finance › Team Pay |

What changed in code:

- The `team_coordinator` hand-off queue is no longer written. Older tasks keep it as history
  (`LEGACY_HANDOFF_QUEUES`), and `teamCoordinatorRetirement:run` moves any open one to its owner, reporting
  any it cannot place. On November 22, 2026 there were none on the live backend.
- Unanswered follow-ups stay with the agent that ran them (Recruiter for onboarding, Dispatch for
  availability), so no second workflow reminds the same person.
- Billing: Team Coordinator is gone from the plan catalog and comparisons. It was never released, Recruiter and
  Dispatch are in both plans, and no subscription or entitlement named it, so nobody gains or loses anything.
  Older usage rows keep the id (`RETIRED_AGENT_IDS`).
- Old links: `/app/agents/team-coordinator` explains the move; its tabs redirect (Onboarding, Documents &
  Training and Readiness to Recruiter › Onboarding & Readiness, Availability to Cleaners, Team Check-ins to
  Dispatch). The public `/agents/team-coordinator` redirects to `/agents/recruiter`.
- Early access requests can no longer name it. Chat no longer lists it as a specialist; older conversations
  still say "Team Coordinator" where it was named.

Business Development has been discussed as a replacement agent. It is not built or listed.
