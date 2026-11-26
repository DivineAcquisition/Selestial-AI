/**
 * @vitest-environment edge-runtime
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, dispatchCleaner, dispatchJob, dispatchPlace, HOUR, JOB_END, JOB_START, NOW, start } from "../tests/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/** A company with Dispatch on Propose and three visits the same day, each with an offer waiting for approval. */
async function setup() {
  const t = start();
  const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
  const place = await dispatchPlace(as, companyId);
  for (const name of ["Rosa", "Lena"]) await dispatchCleaner(as, companyId, name);
  const jobs: Id<"jobs">[] = [];
  for (const offset of [0, 3, 6]) jobs.push(await dispatchJob(as, companyId, place, { startsAt: JOB_START + offset * HOUR - 2 * HOUR, endsAt: JOB_END + offset * HOUR - 2 * HOUR }));
  const pending = () => as.query(api.approvals.list, { companyId });
  /** A pending approval that must be read on its own: a hiring offer. Only the approval row is needed. */
  const hiringOffer = (summary: string) =>
    t.run((ctx) =>
      ctx.db.insert("approvals", {
        companyId,
        agent: "recruiter",
        action: "recruiter.send_offer",
        summary,
        reason: "The interview went well.",
        proposal: { kind: "send_hiring_offer", offerId: "00000000000000000000099999hiringOffers" as Id<"hiringOffers"> },
        status: "pending",
        decideBy: NOW + 6 * HOUR,
        createdAt: NOW,
      }),
    );
  return { t, as, companyId, jobs, pending, hiringOffer };
}

describe("deciding the approval queue in bulk", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sums up the whole queue in groups, past the 200 the page shows", async () => {
    const s = await setup();
    await s.hiringOffer("Send Maya the hiring offer");
    // Many more of the same kind, as a busy company would have.
    const real = (await s.pending()).find((row) => row.proposal?.kind === "offer_assignment")!;
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 230; i += 1) {
        await ctx.db.insert("approvals", { companyId: s.companyId, agent: "dispatch", action: "dispatch.request_acceptance", summary: `Offer visit ${i}`, reason: "x", proposal: real.proposal, status: "pending", decideBy: i < 10 ? NOW - HOUR : NOW + DAY_MS, createdAt: NOW });
      }
    });

    const summary = await s.as.query(api.approvals.queueSummary, { companyId: s.companyId, asOf: NOW });
    expect(summary.total).toBe(234);
    expect(summary.overdue).toBe(10);
    const offers = summary.groups.find((group) => group.actionLabel.length > 0 && group.agent === "dispatch")!;
    expect(offers).toMatchObject({ count: 233, risk: "routine", canDecide: true, overdue: 10 });
    expect(offers.ids).toHaveLength(233);
    expect(offers.samples).toHaveLength(5);
    expect(offers.skipReasons.map((reason) => reason.code)).toContain("not_a_fit");
    expect(summary.groups.find((group) => group.agent === "recruiter")).toMatchObject({ count: 1, risk: "review", samples: ["Send Maya the hiring offer"] });
  });

  it("marks a price change as the Owner's to decide when a Manager looks", async () => {
    const s = await setup();
    await s.t.run((ctx) =>
      ctx.db.insert("approvals", { companyId: s.companyId, agent: "sales", action: "sales.discount_out_of_band", summary: "Change Dana's price to $120.00", reason: "Asked for a discount.", proposal: { kind: "sales_price_override", bookingId: "00000000000000000000099999bookings" as Id<"bookings"> }, status: "pending", decideBy: NOW + HOUR, createdAt: NOW }),
    );
    const manager = await addMember(s.t, s.as, s.companyId, "mgr-a", "manager");
    const price = (await manager.query(api.approvals.queueSummary, { companyId: s.companyId, asOf: NOW })).groups.find((group) => group.agent === "sales");
    expect(price).toMatchObject({ risk: "review", canDecide: false, notYours: "Only the Owner decides price changes." });
    expect((await s.as.query(api.approvals.queueSummary, { companyId: s.companyId, asOf: NOW })).groups.find((group) => group.agent === "sales")).toMatchObject({ canDecide: true, notYours: null });
  });

  it("approves a batch, carrying each one out, and reports what it could not decide", async () => {
    const s = await setup();
    const offers = await s.pending();
    expect(offers).toHaveLength(3);
    const offerId = await s.hiringOffer("Send Maya the hiring offer");
    // One was already decided by someone else.
    await s.as.mutation(api.approvals.decide, { companyId: s.companyId, approvalId: offers[2]._id, decision: "skipped" });

    const results = await s.as.mutation(api.approvals.decideMany, { companyId: s.companyId, approvalIds: [offers[0]._id, offers[1]._id, offers[2]._id, offerId], decision: "approved" });
    expect(results).toMatchObject([
      { id: offers[0]._id, ok: true, carriedOut: { ok: true } },
      { id: offers[1]._id, ok: true, carriedOut: { ok: true } },
      { id: offers[2]._id, ok: false, message: "This was already skipped." },
      { id: offerId, ok: false, message: "This one needs to be reviewed on its own." },
    ]);
    // The offers went out: each visit has a cleaner asked.
    for (const jobId of s.jobs.slice(0, 2)) {
      const assignments = await s.t.run((ctx) => ctx.db.query("assignments").filter((q) => q.eq(q.field("jobId"), jobId)).collect());
      expect(assignments.map((row) => row.status)).toEqual(["offered"]);
    }
    // The hiring offer still waits for a person to read it.
    expect((await s.t.run((ctx) => ctx.db.get(offerId)))?.status).toBe("pending");
  });

  it("skips a batch with one shared reason, refuses more than ten, and keeps Office out", async () => {
    const s = await setup();
    const offers = await s.pending();
    const offerId = await s.hiringOffer("Send Maya the hiring offer");
    const ids = [...offers.map((row) => row._id), offerId];
    const results = await s.as.mutation(api.approvals.decideMany, { companyId: s.companyId, approvalIds: ids, decision: "skipped", reasonCode: "not_hiring" });
    // "Not hiring right now" is offered for hiring offers but not for Dispatch offers, so those are reported and left.
    expect(results.filter((row) => row.ok).map((row) => row.id)).toEqual([offerId]);
    expect(results.find((row) => row.id === offers[0]._id)?.message).toBe("Choose one of the reasons offered, or write your own.");
    expect(await s.t.run((ctx) => ctx.db.get(offerId))).toMatchObject({ status: "skipped", reasonCode: "not_hiring", note: "Not hiring for this right now" });

    const skipped = await s.as.mutation(api.approvals.decideMany, { companyId: s.companyId, approvalIds: offers.map((row) => row._id), decision: "skipped", reasonCode: "pay_wrong" });
    expect(skipped.every((row) => row.ok)).toBe(true);
    for (const row of offers) expect((await s.t.run((ctx) => ctx.db.get(row._id)))?.note).toBe("The pay doesn't look right");

    await expect(s.as.mutation(api.approvals.decideMany, { companyId: s.companyId, approvalIds: Array(11).fill(offerId), decision: "skipped" })).rejects.toThrow("at most 10");
    const office = await addMember(s.t, s.as, s.companyId, "office-a", "office");
    await expect(office.mutation(api.approvals.decideMany, { companyId: s.companyId, approvalIds: [offerId], decision: "skipped" })).rejects.toThrow();
    await expect(office.query(api.approvals.queueSummary, { companyId: s.companyId, asOf: NOW })).rejects.toThrow();
  });
});

const DAY_MS = 24 * HOUR;
