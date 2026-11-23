# Agent Controls

Agent Controls is where an Owner chooses what each agent may do, sees whether it can do it right now,
tests the rules, and reviews what happened under each setting. The screen is at `/app/settings/agents`.
Each agent's playbook shows the same permission rows. There is one policy, stored in the `permissions`
table, and one writer for it, `applyPolicy` in `convex/lib/controls/policy.ts`.

## The foundations, unchanged

- **Levels.** Off, Ask me first, Act and notify me, Act automatically. Inside the code these are `off`,
  `propose`, `execute_and_report` and `execute`.
- **Who can change settings.** Only the Owner changes a setting. Managers can see the settings, test the
  rules and read the history. Selestial Support can pause an agent but cannot resume one.
- **What always needs a person.** `PERSON_ONLY` in `convex/lib/permissionCatalog.ts` is a list, not a set
  of permissions. Its wording is the published wording of the Terms and the Security Overview, and
  `person-only.test.ts` keeps them equal. That wording can change only with a newly published version,
  which the Owner dates.
- **Company isolation.** Every function is company-scoped through `lib/builders.ts`.
- **Pause.** `pauseAgent`, `resumeAgent` and `pauseAll` change one agent on the server's current list in
  one transaction, so two pauses at once cannot undo each other. The older whole-list `setPausedAgents`
  takes `expectedRevision`. Pausing takes effect immediately. Resuming does not release work that was
  refused while the agent was paused, and new work is checked again when it runs.

## Revisions and history

- Every change bumps `companies.controlsRevision` and writes one `controlChanges` row. Changes come from
  a level, routing, a preset, a restore, a pause or a resume. Each row stores the whole policy before
  and after.
- Every change also records a `permission.changed` event per action. The event carries the level, both
  limits and `until`, before and after.
- Any mutation can take `expectedRevision` and refuses with `STALE` if the settings moved since the
  person looked. `applyPreset` and `restore` require it.
- **Restore** sets the policy back to the `before` snapshot of a chosen change, and records the restore
  as a new change.
  - It does not restore pauses.
  - A temporary level that has already ended comes back as Ask me first.
  - Rows that the current rules would refuse are listed and skipped.
  - Restoring never undoes anything an agent already did.

## What each action can do (effective status)

`convex/lib/controls/readiness.ts` works out one status per action. Each status has a reason and a next
step. The checks run in this order:

1. **Unavailable.** No execution path does the action (`capabilities.ts`).
   - Sales discounts, recovering a payment, advancing a candidate, closing a visit and overriding time
     between jobs are listed here.
   - `authorityFor` returns `unavailable` for these actions, and `refusal` won't set them above Off.
2. **Paused.** Either the company is suspended or the agent is paused.
3. **Off.**
4. **Unavailable because of the plan.** Applies to AI work only, decided by `agentVerdict`.
5. **Setup required.** Each need is checked the way the send path checks it:
   - business texting, with `senderGaps` and the deployment's text provider;
   - email;
   - action links (`linksConfigured`);
   - published prices;
   - Google connections.
6. **Approval required.** The level is Ask me first, or a temporary level has run out.
7. **Limit reached.** Today's allowance is used up.
8. **Ready.**

Missing data never counts as ready. `authorityFor` enforces the temporary level (`until`) for every
caller at the moment it runs out.

## Money limits: the daily allowance

- **What counts.** `retention.remedy_within_limit` is the only money action that can run without asking.
  The others are unavailable or always ask. It counts the
  credit amount, or the estimated crew pay for a correction visit. It never counts the customer's price.
  An unknown cost is never treated as zero; that work goes to approval.
- **The day.** The allowance runs on the company's calendar day and resets at local midnight. The reset
  time is shown next to the limit.
- **The ledger.** Spending is recorded in `allowanceDays` and `allowanceReservations`.
  - `permitFor` reserves the amount in the same transaction as the check, keyed by
    `retentionActions:<id>`.
  - A retry finds its own reservation and never reserves twice.
  - Finished work commits its reservation. Failed, declined, cancelled or blocked work releases it.
  - Each reservation settles exactly once.
  - Totals are kept on the day row, so nothing is truncated.
- **Migration.** The first row of a day starts from any spend already made that day under the old
  rolling 24-hour count. Switching to the new count therefore never grants extra room.

## Presets

Presets live in `permissions.ts`.

- **Review first** sets every outside-facing action above Ask me first back down to Ask me first.
- **Routine work delegated** raises routine, implemented, non-money actions that aren't switched off to
  their standard level, capped at the ceiling.
- A preset never touches money, limits, routing, pauses or what always needs a person.
- `presetPreview` lists the changes and explains everything left as it is. `applyPreset` applies exactly
  that plan against the reviewed revision.

## Previewing a raise

`previewChange` shows what raising one action would mean:

- the new status;
- conditions, such as limits, the temporary end time and the action's caution;
- what stays blocked;
- real work that may become eligible, counted with links;
- approvals already waiting, which stay waiting because a higher level never approves them;
- how drafts are treated: drafts stay drafts.

The interface applies the change with `set` against the revision the preview returned. Lowering a level
applies at once.

## Test these rules

`controls.simulate` is a query, so it cannot write: Convex enforces that. It runs four scenarios, each
against a real record or a labeled sample:

- a cleaner declines tomorrow's visit;
- a lead hasn't answered a quote;
- an applicant is missing information;
- a customer asks for a correction visit.

It decides with the same code as live work: `authorityFor`, the readiness checks, `coverAction` and
`candidatesFor` for Dispatch, and `permitFor` without reserving for money. Every result is marked
hypothetical.

## Who decides approvals

- **Default.** Any Owner or Manager decides, as before.
- **Routing.** An Owner can route one action to Owners only, or to one Owner or Manager plus an optional
  backup. Any Owner can still decide in every case.
- **Owner-only actions.** `OWNER_DECIDES` (refunds above the limit, out-of-band prices) is always
  Owner-only and can't be routed to anyone else.
- **When someone leaves.** If the chosen person is removed or their role changes, the screen warns, and
  approvals go to the backup or to any Owner or Manager.
- **Enforcement.** `approvals.decide` checks `mayDecide`. Approval requests notify only the routed
  people.
- **Statuses.** An approval is waiting, waiting past its deadline, expired (not done), declined, approved
  and carried out, or approved and then blocked when it ran. Silence is never approval.

## Reports ("Act and notify me")

- All four agents report through `reportAction` in `convex/lib/controls/report.ts`. Recruiter reports
  are new.
- Each report names the work (`ref`) and how far it got (`stage`): prepared, queued, submitted,
  delivered or completed. The notice is keyed by agent, action, stage and ref, so a retry never sends
  a second email.
- Recipients are active Owners and Managers who have "What your agents did" turned on. The screen lists
  who receives reports, who has turned them off, the channel, and a link to preferences.

## Rules beside each permission

`convex/lib/controls/rules.ts` summarizes the playbook setting that governs each main action in one
line, with a link to it. It adds no new rule. The only structured condition on a permission is
`until`, which `authorityFor` enforces.

## Known limits

- **Recruiter's fixed-requirement decline.**
  - It remains an Owner opt-in, and the screen shows a legal-review caution.
  - The published Terms and Security Overview say no agent rejects a worker. Narrowing that wording
    needs a new published version, which counsel should review.
- **Per-action history.** It reads the last 30 days of events, up to 2,000 events, and says so when
  that cap is hit.
- **Interview scheduling.** It doesn't check a calendar for conflicts. The interview action's note says
  so.
