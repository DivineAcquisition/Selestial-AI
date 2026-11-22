# Business texting: giving a number up

Companion to `00-audit.md`, `01-deployment.md` and `02-case.md`. Built 2026-11-22. Before this, nothing
released a number or a campaign: a company that left kept an `active` request, the six-hourly fee sweep
kept posting its number and registration fees, and Telnyx kept billing Selestial.

This is **staff-assisted, on purpose**. The owner asks; a person at Selestial acts. Nothing is released or
moved by asking, by a plan ending, or by any schedule.

Code: `convex/lib/texting/offboarding.ts` (wording, the work item), `convex/textingCase.ts`
(`requestOffboarding`, `cancelOffboarding`), `convex/texting.ts` (`releaseNumber`, `completeTransfer`,
`offboard`), `convex/lib/messaging/telnyxAccount.ts` (`findOwnedNumber`, `unassignNumber`, `releaseNumber`,
`deleteCampaign`), `src/components/app/texting/stop-number.tsx`, `src/components/staff/texting-case.tsx`.

## 1. What the owner sees

On **Getting you ready** (step 6 of Set up business texting), while the number is active or paused by the
carriers, a closed section at the bottom: **Stop using this number**. Only the Owner can use it; staff in a
support session cannot ask for the owner.

Two choices:

| Choice | What it means | What the owner accepts (exact words kept on the request) |
|---|---|---|
| Move my number to another provider | The owner keeps the number. Their **new provider** starts the transfer (a port-out). | `PORT_OUT_WORDING` |
| Release my number | The number is given up for good. | `RELEASE_WORDING` |

Both say, before anything is sent:

- The number keeps working, and its monthly number and registration fees continue, **until the release or
  transfer completes**.
- A transfer is started by the new provider and typically takes several business days. Selestial keeps the
  number active meanwhile and will not release it.
- Releasing is permanent: the number can't be recovered, people who text or call it won't reach the
  business, and its carrier registration ends.
- Setup fees already paid are not refunded.
- A person at Selestial reviews the request, typically within 2 business days. This is worded as what
  usually happens, never as a promise.

The acceptance box starts unticked. The request is saved as an assisted exception
(`textingExceptions.assisted.route` = `release` or `port_out`) with `assisted.authorization`: the exact
wording, the time, and the member. The owner is emailed that Selestial has the request.

Until Selestial starts, the owner can **cancel** the request from the same section. Cancelling removes the
authorization from the record, so a reopened item can never stand for the owner's yes.

Rules the server enforces:

- One request per number. Asking again for the same thing returns the request already open.
- A release is refused while a transfer is pending, and a transfer while a release is pending. A number in
  the middle of a port is never released.
- Only a request whose number is bought and connected (`active` or `interrupted`) has anything to give up.

## 2. When a plan is cancelled

When Autumn stops reporting a plan for a company (the owner's cancellation taking effect, or the plan
cancelled after 30 days unpaid), `openPlanCancelledWork` opens the same kind of exception, once per number,
with `assisted.source = "plan_cancelled"` and **no authorization**. It is a work item so the number, its
registration and their fees are not forgotten. It shows in the staff texting queue.

It releases nothing, and staff cannot release on the strength of it: `releaseNumber` refuses without the
owner's own authorization. Staff contact the owner; if the owner then uses **Stop using this number**, that
same item becomes their authorized request.

A company whose request came from the older form and never opened the guided setup has no case to hang the
item on. For those, only the event `texting.release_work_needed` (with `tracked: false`) is recorded. Search
events for it.

**Not changed:** monthly number and registration fees keep posting to a company with no active plan for as
long as its request is `active`. Whether Selestial should stop charging them at plan end, before the number
is actually released, is an open product and finance decision.

## 3. Staff procedure

Staff console › Texting. A request someone asked to give up (or whose plan was cancelled) is listed there
although it is active. Open **Evidence, notes and exceptions**; the item shows the route, whether the owner
authorized it and when, and the steps done so far.

Both actions need a staff **admin** who also holds the **Destructive actions** capability
(`records.destroy`, granted per person in Staff). Both are refused without the owner's recorded
authorization for exactly this number.

### Release

1. Read the item. Confirm the badge says **Owner authorized**, and that the number is the one on the
   request. If it says **No owner authorization**, stop: contact the owner.
2. In Telnyx Mission Control, check before acting:
   - **Numbers › My Numbers**: the number is on the account, and has **no port-out in progress**
     (Porting › Port Outs). If one is in progress, do not release. Ask the owner which they want.
   - **Messaging › 10DLC › Campaigns**: the campaign id shown on the request exists and the number is
     the only one assigned to it. If other numbers share the campaign, stop and escalate: deleting the
     campaign would unregister them too.
3. Press **Release number** and confirm. Selestial then, in order, each step recorded before the next:
   1. takes the number off its campaign (`DELETE /v2/10dlc/phone_number_campaigns/{number}`);
   2. looks the number up and deletes it (`GET /v2/phone_numbers?filter[phone_number]=`, then
      `DELETE /v2/phone_numbers/{id}`);
   3. deletes the campaign (`DELETE /v2/10dlc/campaign/{campaignId}`).
4. When all three are done the request becomes `released`: the company's texting number is cleared, its
   registration is marked not approved (so the sending policy refuses every text), the item is resolved,
   `texting.released` is recorded and the owner is emailed.
5. In Mission Control, confirm the number is gone from My Numbers and the campaign shows as deactivated.

If a step fails, the run stops and the item shows **Stopped:** with Telnyx's reason. The request stays
`active` with the finished steps recorded; it is never shown as released. From the first finished step the
company's texts are already off (the number is no longer on a campaign). Fix the cause, or do that one step
by hand in Mission Control, then press **Continue the release**: finished steps are not repeated, and a step
Telnyx reports as already gone (404) counts as done.

### Transfer to another provider (port-out)

1. The owner's new provider submits the port. Telnyx notifies Selestial's account (Porting › Port Outs).
   Approve or answer it there as Telnyx requires; Selestial has no automation for this.
2. Leave the request alone until Mission Control shows the port-out **completed** and the number is no longer
   under My Numbers. Do not press Release.
3. Press **Mark transfer complete**. Selestial first asks Telnyx whether the number is still on the account.
   If it is, nothing changes and the item says so. If it has left, the campaign is deleted and the request
   becomes `released`, exactly as in step 4 above, with `texting.transfer_completed`.

### The brand

The brand is kept in both cases. Selestial knows of no recurring Telnyx fee for a brand (check the invoice), and deleting it would force a new brand filing (and
setup fee) if the company returns. Delete it by hand in Mission Control only if the company asks for its
business details to be removed.

## 4. Fees

- Monthly number and registration fees are posted only for requests in `active`
  (`chargeMonth`, `convex/texting.ts`). A `released` request is never charged again. The month in which the
  release completes has already been charged and is not prorated or refunded.
- While a release or transfer is pending, or stopped part-way, the request is still `active` and a new month
  can be charged. Act on requests before a month boundary where possible.
- Setup and correction fees already charged are not refunded.
- Telnyx's own billing to Selestial (number rental, campaign fee) stops when the number and campaign are
  actually deleted there. Confirm on the next Telnyx invoice.

## 5. After a release

The company's setup stays as it was, read-only. Starting again is **not automated**: a new request would
file a second brand. Staff help the company by hand for now (see "Not automated").

A STOP from a person stays in force: suppressions belong to the person's number for this business, not to
the texting number.

## 6. Not automated

- Approving or answering a port-out at Telnyx.
- Telling the owner their port-out PIN or account details.
- Releasing anything on a schedule, on plan cancellation, or on a low balance.
- Stopping fees at plan end before the number is released.
- Deleting the brand.
- Setting texting up again after a release.
- A work item for an older-form request with no guided setup (event only).

## 7. Not yet exercised against live Telnyx

The release path has run only against the test stand-in (`tests/textingHarness.ts`). The request and answer
shapes were taken from Telnyx's v2 API reference on 2026-11-22 and are marked in
`convex/lib/messaging/telnyxAccount.ts`:

- `GET /v2/phone_numbers?filter[phone_number]=` returning `{ data: [{ id, phone_number, status }] }`;
- `DELETE /v2/phone_numbers/{id}`;
- `DELETE /v2/10dlc/phone_number_campaigns/{phoneNumber}`;
- `DELETE /v2/10dlc/campaign/{campaignId}` (already used by the staff Telnyx check for mock campaigns);
- that a completed port-out removes the number from `GET /v2/phone_numbers`.

Before the first real release, do one with a test number on the live account, watching Mission Control at
each step. A backend that is not production refuses every one of these writes
(`convex/lib/environment.ts`): the first step stops with "this is not the production backend" and nothing
changes, including the company's texting.

## 8. Tests

`convex/texting.test.ts`, "Giving a texting number up": the owner's request, its exact words and cancelling;
Owner only; a release refused during a pending transfer and the reverse; a staff release refused without
authorization, without the capability, or with an authorization for another number; one release, in order,
that is not repeated; fees not posted the following month; texts refused after release; a failed step that
is continued; a non-production backend changing nothing; a transfer closed only after the number has left;
and a cancelled plan opening a work item that authorizes nothing.
