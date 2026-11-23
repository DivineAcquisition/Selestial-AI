# Quality: what was verified, and how

Everything here ran against controlled test data: the real backend functions under `convex-test`, with fake
providers. **Nothing was verified against a live provider, a live deployment or a real customer.** No Quo key,
Anthropic key or live texting number was available to this work, and no real person was contacted.

Run the Quality tests with:

```
npx vitest run convex/qualityAgent.test.ts convex/qualityScreens.test.ts convex/lib/quality/readerEval.test.ts convex/lib/quality/fileLinks.test.ts src/components/app/screens/quality/quality.test.tsx
```

## The twenty acceptance scenarios

`convex/qualityAgent.test.ts`, built on `tests/qualityHarness.ts`. It uses Retention's and Dispatch's
harnesses, so the corrections run through their real code.

| # | Scenario | Test | What it shows |
| --- | --- | --- | --- |
| 1 | Complete evidence produces a review without an unnecessary case | "1. complete evidence…" | The review is recorded, with no case, no request and no message. |
| 2, 3 | Missing evidence makes one focused request; evidence arriving closes it | "2 and 3. missing required evidence…" | One text to the crew lead with a private link. The photo arriving marks the request satisfied and the review approvable. |
| 18 (requests) | Changed evidence invalidates a stale approval | "at Ask me first (the default)…" | A request waiting for approval is stopped when the evidence arrives first. Approving it later sends nothing. |
| 19 | Company and property standards apply deterministically | "19. company and property standards…" | Fixed precedence. Each requirement names its source and version. A later edit never changes a reviewed visit. |
| 8 | A scope misunderstanding is not a cleaner fault | "8. a scope misunderstanding…" | The finding is scope, not service. Nobody on the crew is asked. A correction is refused as outside the booked scope. |
| 9, 10 | A correction uses the existing approval and Dispatch workflows; verification and satisfaction stay separate | "9 and 10. a correction goes through Retention's remedy…" | Retention's `correction_visit` remedy, booked by the Owner's pay figure and staffed as an ordinary visit. Quality verifies the work and the case waits in Verifying. Only the customer's own answer on Retention's link makes it "confirmed". |
| 18 | A finding revised before the visit withdraws the remedy | "18. a finding revised…" | The correction is blocked and Retention's prepared action is cancelled. |
| 11 | A serious incident escalates without automatic adverse action | "11. a serious incident…" | The case is restricted, urgent and preserved. There are no findings, requests or corrections. The cleaner's status is untouched. The Owner's notice carries no one's words. Closing needs the Owner's recorded decision. |
| 16 | Restricted users cannot access sensitive cases or files | in test 11; the statement test; `convex/lib/quality/fileLinks.test.ts` | A manager who was not named cannot open the case and sees only a count of hidden cases. Statements are hidden from office staff. A file address opens one file, for a short time, and nothing else; no lasting address is minted when the deployment cannot sign. |
| 12 | Cleaner non-response is not an admission | "12. a cleaner who does not answer…" | One reminder, then "unanswered: not an admission of anything". Every accepted crew member is asked. |
| — | Statements are versioned | "a statement is kept as written…" | The original stays as written. A later answer is a supplement version. Verification codes are checked. |
| 15 | Human takeover and pauses stop external actions | "15. taking a case over and pausing…" | Takeover withdraws prepared requests. Paused runs are blocked with a reason and resume when Quality is resumed. |
| 17 | Historical imports do not trigger live outreach | "17. an imported visit…" | Reviewed for the record. No case is acted on and nobody is contacted. |
| 14 | Duplicate events and retries change nothing twice | "14. a repeated event…" | Repeated completions, webhooks, sweeps and reports produce one review, one case and one message. |
| — | Quo capabilities as checked | "connecting records only the capabilities it checked…" | Recordings and sending are "not used". The key is stored sealed. |
| 4 | An ambiguous call goes to association review | "4. a call that could be about two visits…" | Both candidates are listed with the reason. A person's link is kept with its history. |
| 7 | A customer with several properties is matched correctly | "7. a client with two properties…" | The words ("45 Oak") point to the right visit. |
| 5 | A late transcript updates the case without duplicate outreach | "5. a transcript that arrives late, then is revised…" | The transcript is versioned and its extracts are re-read. It joins the same case and nobody is asked twice. |
| 13 | A provider outage leaves a visible, recoverable state | "13. a provider outage…" | The connection shows the problem and a failure count, and recovers on the next good sync. |
| — | Signed webhooks | "a signed delivery is accepted only with the connection's own key…" | A wrong key, a tampered body or a stale timestamp is refused. |
| 6 | Quoted email content does not become a new complaint | "6. quoted email history…" | Quoted history is stripped. A repeated complaint is one complaint. |
| 20 | Model output cites actual evidence and invents no sources | "20. keeps only findings that cite real evidence…" | Invented ids and blaming words are dropped. One reading of unchanged evidence is charged once. |

## AI behavior against reviewed fixtures

`convex/lib/quality/readerEval.test.ts` runs over seven reviewed fixtures (`tests/fixtures/qualityEval.ts`).
Each fixture records what a reviewer decided may and may not be concluded: a clear service miss, ambiguous
evidence, a misleading transcript, scope confusion, conflicting accounts, prompt injection in a message, and
unreadable or irrelevant photos.

**Measured, not just read:**

- **False positives** (a category the reviewer ruled out) from the deterministic rules: **0 of 7 fixtures.**
- **Serious-incident detection:** correct on all 7. While building the evaluation it found that "fire the
  cleaner" was treated as a fire. The pattern now needs a fire itself ("a fire", "caught fire", "fire
  alarm").
- **Unsupported conclusions surviving the guardrails**, for deliberately bad model answers that invent ids,
  blame someone, use a non-finding category ("refund", "disciplinary_note"), or conclude "no issue" from
  photos alone: **0.** The photo-only rule was added because of this evaluation.
- **Overreach a guardrail cannot judge:** a confident category that cites real evidence, such as "service
  miss" on ambiguous or out-of-scope evidence, or taking one side of a conflict. **4 of the 7 fixtures** have
  such an answer, and each is kept only as a *suggestion*, beside the rules' own reading. This is the stated
  limit: a person reviews every suggestion before it counts, and a correction needs reviewed findings.
- The speaker-aware transcript reading hears no complaint in the office's own words, and flags an
  unidentified speaker. A provider summary is labelled as the provider's. A message cannot close the
  evidence frame.

**Live model run (not done here).** It is gated and billed:

```
AI_EVAL=1 QUALITY_MODEL=claude ANTHROPIC_API_KEY=… npx vitest run convex/lib/quality/readerEval.test.ts
```

It prints a table per fixture and fails above `AI_EVAL_MAX_FALSE_POSITIVES` (default 0). It needs an
approved key and spend.

## Screens

`convex/qualityScreens.test.ts` builds a sample company through the real backend. It has:

- a complete visit
- a visit missing its photos
- a skipped task, corrected through Retention and booked
- a scope question
- a serious concern
- Quo connected, with a call needing a link

The test checks the answers contain no score, confidence or percentage. With `QUALITY_SCREENS_OUT` set, it
writes the answers to `tests/fixtures/qualityScreens.json`.

`src/components/app/screens/quality/quality.test.tsx` renders every Quality screen and the cleaner's private
page over those answers. It checks each says what was checked, found and next; shows no score; keeps the
customer's answer apart from verification; and that office staff cannot report from a visit.

**Screenshots:** `docs/screenshots/quality/`, at Chromium 1440 and 390 wide.

- They show the screens without the app's sidebar, styled with the app's own stylesheet compiled by Tailwind.
- A script checked every page at both widths for clipped or off-screen content. It found one bug (case cards
  clipped at 390), which is fixed.
- No Convex deployment was run, so the screens were not exercised live.

Problems the screenshots found and this work fixed:

- dates shown as `2027-03-01`
- a case title reading "consider a correction"
- a double full stop in review summaries
- Insights counting only manager-closed visits (it read "0 of 0" while 5 visits had been reviewed)

## Regression

The whole suite was run after the change. The count is in the pull request.

Existing tests updated for Quality being built:

- navigation: the Quality tabs, Quality in the built agents, and live links
- the Overview's department and sidebar facts
- billing: Quality is allowed on Expand and blocked on Operate
- activation
- Early access: now uses Care as the not-built agent
- the photo-review AI test: now seeds the Operate plan explicitly
- the dispatch harness: Quality's review task is filed under Quality

## Not verified

- **Quo against the live API:** the key check, call and transcript paging, webhook creation and signature
  format, rate limits, and whether the workspace's plan returns transcripts and summaries.
- **The Claude reader against the live API**, and the evaluation's live pass.
- **Real texts** to a real cleaner's phone, the link opened on iOS and Android, and camera upload on poor
  connectivity.
- A **live deployment**: schema push, the 10-minute crons, the `/webhooks/quality-quo/` and `/quality-files/`
  routes.
- **Company Chat choosing Quality's tools** in a real conversation. The tools are tested only as functions.
