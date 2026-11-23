/**
 * @vitest-environment edge-runtime
 *
 * A sample company for Quality's screens, built through the real backend (convex-test) with fake providers:
 * a visit with a complete record, one missing its photos, a skipped task corrected through Retention and
 * Dispatch, a scope question, a serious concern, and a call that needs a person to link it. The test checks
 * what the screens' queries return; with QUALITY_SCREENS_OUT set it also writes those answers to that file,
 * which the screen tests (src/components/app/screens/quality/quality.test.tsx) render.
 */
import { writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchTestEnv, PHONES } from "../tests/dispatchHarness";
import { CUSTOMER_PHONE, DAY, flush, JOB_START, qualityLink, qualitySetup } from "../tests/qualityHarness";
import { api, internal } from "./_generated/api";
import { mockQuo, QuoError, type QuoApi } from "./lib/quality/comms/quo";
import { fakeQuo as sharedFakeQuo, QUO_NUMBER as SHARED_NUMBER } from "../tests/fakeQuo";

let undo: () => void;
beforeEach(() => {
  undo = dispatchTestEnv();
});
afterEach(() => {
  undo();
  mockQuo.api = null;
  vi.unstubAllGlobals();
});

const SCOPE = "A full clean of the home.\n- Bathroom: Clean the shower\n- Kitchen: Wipe kitchen counters\nNot included: Inside the oven.";
const DONE = [
  { label: "Clean the shower", state: "done" as const },
  { label: "Wipe kitchen counters", state: "done" as const },
];

function fakeQuo(): QuoApi {
  return {
    async numbers() {
      return [{ id: "PN1", number: "+15125550000", name: "Office" }];
    },
    async calls() {
      return { calls: [], next: null };
    },
    async transcripts() {
      throw new QuoError("unavailable", "Not used here.");
    },
    async createWebhook() {
      return { id: "WH1", key: `whsec_${btoa("0123456789abcdef0123456789abcdef")}` };
    },
    async deleteWebhook() {},
  };
}

describe("Quality's screens over a sample company", () => {
  it("answers every screen's query from the record, with no score anywhere", async () => {
    const s = await qualitySetup();
    await s.publishCompany();
    await s.trustRequests();
    const { companyId, as } = s;

    // A visit with everything on record.
    await s.submitted({ scope: SCOPE, checklist: DONE, after: 3, startsAt: JOB_START - 3 * DAY });
    // A visit held to the published standard, missing its after photos: one focused request to the crew.
    await s.submitted({ scope: SCOPE, checklist: DONE, after: 0, startsAt: JOB_START + 2 * DAY });
    await s.later(25 * 60_000);
    // A skipped task: confirmed, corrected through Retention's remedy, booked by the Owner's pay.
    await s.submitted({ scope: SCOPE, checklist: [{ label: "Clean the shower", state: "skipped", skipReason: "Not done" }, DONE[1]], after: 3, startsAt: JOB_START - DAY });
    const missCase = (await s.qcases()).find((c) => c.origin === "completion_review")!;
    const [miss] = (await s.findings()).filter((f) => f.caseId === missCase._id);
    await as.mutation(api.quality.reviewFindingAction, { companyId, findingId: miss._id, action: "confirm" });
    await as.mutation(api.quality.proposeCorrectionAction, { companyId, caseId: missCase._id, findingIds: [miss._id], areas: ["shower"], scope: "targeted", afterPhotos: 1, checklistLabels: ["shower"], inspection: false });
    await s.setPay(5000);
    await s.later(11 * 60_000);
    // A customer's concern about work the service did not include.
    const scopeVisit = await s.submitted({ scope: SCOPE, checklist: DONE, after: 3 });
    await as.mutation(api.retentionAgent.openCase, { companyId, customerId: s.place.customerId, jobId: scopeVisit, description: "The oven was not cleaned inside.", origin: "staff" });
    await flush(s.t);
    // A serious concern: restricted to the Owner, preserved, nothing automatic.
    const seriousVisit = await s.submitted({ scope: SCOPE, checklist: DONE, after: 2, startsAt: JOB_START + DAY });
    await as.mutation(api.retentionAgent.openCase, { companyId, customerId: s.place.customerId, jobId: seriousVisit, description: "A picture frame in the hallway was broken after the visit.", origin: "staff" });
    await flush(s.t);
    // Quo connected, and a call that could be about two visits.
    process.env.MAILBOX_TOKEN_KEY = btoa("k".repeat(32));
    process.env.CONVEX_SITE_URL = "https://example.convex.site";
    mockQuo.api = fakeQuo();
    const shared = sharedFakeQuo();
    vi.stubGlobal("fetch", shared.fetcher);
    await as.mutation(api.quo.connect, { companyId, apiKey: shared.state.key });
    await flush(s.t);
    await as.mutation(api.quo.selectNumbers, { companyId, numberIds: [SHARED_NUMBER.id] });
    await flush(s.t);
    const quoConnectionId = (await s.t.run(async (ctx) => ctx.db.query("quoConnections").collect())).find((c) => c.companyId === companyId)!._id;
    await as.mutation(api.quality.saveSettings, { companyId, settings: { readPhonePlatform: true } });
    await as.mutation(api.qualityComms.startQuoReading, { companyId, readDays: 30 });
    await flush(s.t);
    await s.t.mutation(internal.quo.ingest, { connectionId: quoConnectionId, eventId: "d1", event: JSON.stringify({ id: "EV-1", type: "call.completed", apiVersion: "2026-03-30", createdAt: new Date().toISOString(), data: { resource: { id: "AC1", direction: "incoming", status: "completed", participants: [CUSTOMER_PHONE], createdAt: new Date().toISOString(), duration: 95 }, context: { phoneNumberId: SHARED_NUMBER.id, orgId: "OR1" } } }) });
    await flush(s.t);

    const overview = await as.query(api.quality.overview, { companyId });
    const reviews = await as.query(api.quality.reviews, { companyId });
    const firstReview = reviews.find((r) => r.status === "approved" || r.status === "ready") ?? reviews[0];
    const review = await as.query(api.quality.review, { companyId, reviewId: firstReview.id });
    const cases = await as.query(api.quality.cases, { companyId, stage: "open" });
    const caseDetail = await s.caseDetail(missCase._id);
    const corrections = await as.query(api.quality.corrections, { companyId });
    const standards = await as.query(api.quality.standards, { companyId });
    const standard = await as.query(api.quality.standard, { companyId, standardId: standards.groups[0].current!.id });
    const insights = await as.query(api.quality.insights, { companyId, days: 90 });
    const playbook = await as.query(api.quality.playbook, { companyId });
    const associations = await as.query(api.qualityComms.associations, { companyId });
    const permissions = await as.query(api.permissions.list, { companyId });
    const forJob = await as.query(api.quality.forJob, { companyId, jobId: scopeVisit });
    const cleanerRates = await as.query(api.quality.cleanerRates, { companyId });
    // What the cleaner sees from the photo request: the day and town, nothing anyone said.
    const linkView = await s.t.query(api.qualityLinks.view, { token: qualityLink(PHONES.Lena) });
    expect(linkView).toMatchObject({ state: "active", purpose: "missing_evidence" });
    expect(JSON.stringify(linkView)).not.toMatch(/oven|frame|broken/i);

    expect(cases.cases.length).toBeGreaterThanOrEqual(3);
    expect(cases.cases.some((c) => c.serious)).toBe(true);
    expect(corrections[0]).toMatchObject({ state: "scheduled" });
    expect(associations).toHaveLength(1);
    expect(playbook.quo.reader?.status).toBe("connected");
    const everything = JSON.stringify({ overview, reviews, review, cases, caseDetail, corrections, standards, insights, playbook, associations, forJob });
    expect(everything).not.toMatch(/"score"|confidence|"percent"/i);

    const out = process.env.QUALITY_SCREENS_OUT;
    if (out) writeFileSync(out, JSON.stringify({ overview, reviews, review, cases, caseDetail, corrections, standards, standard, insights, playbook, associations, permissions, forJob, linkView, cleanerRates }, null, 1));
  });
});
