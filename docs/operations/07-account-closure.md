# Account closure: export, closing and deletion requests

What Selestial staff do when a company wants a copy of its records, wants to leave, or asks for its records
to be deleted, **as the code supports it today**. Nothing here is automatic unless it says so.

Code: `convex/dataRights.ts`, `convex/requests.ts`, `convex/retention.ts`, `convex/billingLock.ts`,
`convex/lib/trust/erase.ts`. Related: `docs/billing/04-unpaid-plan.md`, `docs/texting/03-offboarding.md`
(releasing a company's texting number and registration; being written), `05-recovery-runbook.md`.

## What exists and what does not

| | Today |
|---|---|
| Export of a company's records | **Built, self-serve.** Owner only, Settings › Privacy & messaging. Three a day; the file is downloadable for 24 hours, then deleted. Works while the account is locked for an unpaid plan (`whileLocked`). |
| Erasing one customer's or one cleaner's personal details | **Built, self-serve.** Owner only, with a deletion record. Opt-outs are kept. |
| Asking for the whole company to be deleted | **A request only.** `requestCompanyDeletion` files a privacy request for staff, due in 90 days. It deletes nothing. |
| Deleting a company's records | **Not built.** No function deletes a company. Staff have no tool for it; it would be done by hand in the Convex dashboard, table by table, which is slow and easy to get wrong. |
| A deletion clock when a plan is cancelled for non-payment | **Not built.** After 30 days locked the plan is cancelled (`convex/billingLock.ts` `cancelUnpaid`, `CANCEL_AFTER_MS`). The company's records stay; no request is opened and nothing is scheduled. |
| A path to export from the locked screen | **Missing in the screen.** The backend allows export while locked; `src/components/app/billing/locked.tsx` offers only paying and switching business. |

## 1. Export request

1. The Owner does it themselves: Settings › Privacy & messaging › Export. If they cannot sign in, verify who
   they are first (`docs/operations/03-support-sessions.md`); staff do not make or download an export for them.
2. If the account is locked for an unpaid plan, export still works by function, but the locked screen has no
   button for it yet (see the gap list, item 3). Until it does, the only way in is for a staff member with
   billing adjustments to lift the lock (`/staff/unpaid`, `billingLock.lift`, with a written reason). Lifting
   ends the lock for that invoice rather than pausing it, so it is a decision, not a routine step.
3. Very large companies: the export has not been tested at size. If it fails, the export row says why.

## 2. A company wants to leave (closure)

Reconcile these **before** anything is closed or deleted, in this order:

1. **Money owed to the company's customers and by them.** Open and overdue invoices, card payments
   `processing` or `checking`, refunds in progress (Finance). Let them settle or have the Owner void them.
2. **Stripe Connect.** The connected account is the company's own; Selestial does not close it. Confirm no
   payment or refund is in flight, then the Owner disconnects it or keeps it. Disputes can arrive for months:
   tell the Owner they are handled in Stripe.
3. **Selestial's own plan.** Cancel in Autumn (Settings › Billing, or staff). Unused prepaid messaging
   balance and credits: decide refund or forfeit per the Terms; record what was done.
4. **Texting.** The number, brand and campaign are registered with the carriers in the company's name and
   keep costing money until released. Follow `docs/texting/03-offboarding.md`. Do not release a number while
   customers may still reply STOP to it without recording those opt-outs first.
5. **Connections.** Google, inboxes, Jobber: the Owner disconnects (Settings › Integrations), which revokes
   Selestial's access at the provider. Queued Google work is cancelled by disconnecting.
6. **Agents and sending.** Pause every agent; if anything could still go out, suspend outbound
   (`compliance.setSuspended`, with a note).
7. **Export.** Remind the Owner to export first. After closure they cannot.

There is no "closed" state on a company. Closure today is: plan cancelled, agents paused, outbound
suspended, connections removed, and a note on the request.

## 3. Deletion request

1. It arrives as a privacy request (kind `privacy`, subtype `deletion`), from Settings (already verified as
   the signed-in Owner) or from the public form (verify first). Due date: 90 days.
2. Acknowledge it, and confirm with the Owner in writing that they want the whole company deleted and have
   exported what they need. A request made by mistake is closed with a note.
3. Do the closure steps in section 2.
4. **Deleting the records is not built.** Until the owner decides how (gap list, item 1), the honest
   options are: (a) erase personal details customer by customer and cleaner by cleaner with the built tools,
   which leaves the company's own rows; or (b) delete by hand in the Convex dashboard under a written,
   reviewed plan. Do not improvise (b).
5. Record what was done and what was kept on the request, and close it as completed or "closed with
   limitation", saying which.

## What is kept, and why

| Kept | Why | Where it says so |
|---|---|---|
| Opt-out records | So a person who said stop is never contacted again, by this company or after a re-import. | Privacy Notice (privacy.ts:155); `convex/lib/trust/erase.ts` |
| The record that a deletion was done, and privacy and security requests | Proof of what was done; three years after closing, then deleted by a daily job. | Privacy Notice (privacy.ts:153); `convex/retention.ts` |
| The activity log, without personal details | It keeps record ids of what happened. | Privacy Notice (privacy.ts:156) |
| Backups | Managed by Convex; not rewritten when a record is erased. They age out on Convex's schedule (not verified). | Privacy Notice (privacy.ts:157) |
| Invoices, payments, refunds, payouts | Tax and accounting duties of the company and of Selestial; Stripe keeps its own copy regardless. | **Not in the Privacy Notice.** Gap list, item 4. |
| Message logs: who was sent what kind of message, when, with what permission | Carrier (10DLC) rules expect consent and sending records to be producible on request. | **Not in the Privacy Notice.** Gap list, item 4. |

## Legal copy vs. behaviour: gaps for the owner and counsel to decide

**These are open. Nothing here has been changed in the legal documents.** Each needs a decision: build what
the sentence promises, or change the sentence (a new version of the document, with notice where the Terms
require it).

1. **"When a company leaves, we delete its records within 90 days."**
   `src/lib/trust/documents/privacy.ts:152`. Also the trust register,
   `src/lib/trust/register.ts:55` ("deleted within 90 days of leaving … staff carry it out"), and
   `convex/dataRights.ts:42-43` (`COMPANY_DELETION_DAYS = 90`).
   *Behaviour:* nothing deletes a company. A request from Settings gets a 90-day due date and a person; there
   is no tool to carry it out. A company that simply stops using Selestial, or stops paying, gets no request
   and no clock at all. "Leaves" is not defined anywhere in code.
   *Decide:* what "leaves" means (asked to be deleted / plan cancelled / inactive for N days); whether to
   build a reviewed, staff-run purge; or reword to "when a company asks us to".

2. **"Settings includes tools to export your records and to delete them."**
   `src/lib/trust/documents/terms.ts:161`.
   *Behaviour:* export is a tool. Deleting one customer or one cleaner is a tool. Deleting the company is a
   request to staff (`convex/dataRights.ts:313`, `requestCompanyDeletion`), and the in-app text now says so.
   *Decide:* reword to say which deletions are self-serve and which are requests, or build it.

3. **"You may stop using Selestial at any time. Export what you need first."**
   `src/lib/trust/documents/terms.ts:179`, and the unpaid-plan flow (`docs/billing/04-unpaid-plan.md`): the
   plan is cancelled after 30 days locked (`convex/lib/billing/lock.ts:17`, `convex/billingLock.ts:333`).
   *Behaviour:* export now works while locked at the backend (`convex/dataRights.ts:50,74,98`), but the
   locked screen (`src/components/app/billing/locked.tsx`) has no way to reach it, so a locked Owner still
   cannot export without help. After cancellation nothing is deleted and nothing tells the Owner how long
   their records are kept.
   *Decide:* add an export action to the locked screen (engineering); say in the cancellation notice what
   happens to the records and for how long.

4. **Retention the Privacy Notice does not mention.**
   `src/lib/trust/documents/privacy.ts:150-158` lists what is kept after deletion: opt-outs, deletion
   records, the activity log without details, backups. It does not mention financial records or message
   and consent logs. The in-app text beside "Ask Selestial to delete the company"
   (`src/components/app/screens/compliance.tsx:628-629`) now says these are kept, because a deletion done
   today would have to keep them.
   *Decide:* confirm the retention and its periods with counsel and add it to the notice, or decide they
   are deleted too and change the in-app text back.

5. **Customer payments are built; the public documents do not say so.**
   The trust register said "Not built … no money moves"; it now describes Stripe Connect payments
   (`src/lib/trust/register.ts:58`, marked not for public pages). A second register row with the same id
   `billing` (`src/lib/trust/register.ts:57`) still says "No payment provider; nothing is charged through
   the service", which contradicts the row at line 40 and is out of date. Stripe is not named for customer
   payments in `src/lib/trust/documents/*`.
   *Decide:* name Stripe (and what it receives) on the Subprocessors page and in the Privacy Notice; remove
   or correct the stale register row.

6. **A restored or test backend holds a copy of real data.** `docs/foundation/06-deployments.md` step 8
   says the old backend's copy "is cleared … after a week". Whether that was done is not recorded. A
   deletion carried out on production does not reach that copy or any backup.
   *Decide:* clear the test backend's copy and record it; state the backup retention period.
