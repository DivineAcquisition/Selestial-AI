/**
 * @vitest-environment edge-runtime
 *
 * Moving a visit from Calendar (convex/calendarMoves.ts): Dispatch's own move, with Calendar's preview of
 * everything it touches, the person's choice of notices, and a client notice that never undoes a move.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accepted, dispatchTestEnv, flush, setup } from "../tests/dispatchHarness";
import { addMember, HOUR, JOB_START, refusal } from "../tests/harness";
import { api } from "./_generated/api";

describe("Calendar: moving a visit", () => {
  let undo = () => {};
  beforeEach(() => {
    undo = dispatchTestEnv();
  });
  afterEach(() => undo());

  it("shows who is asked again and what goes, refuses a stale preview, and moves the visit, for Office too", async () => {
    const s = await setup();
    const a = await accepted(s);
    const office = await addMember(s.t, s.as, s.companyId, "office-a", "office");
    const to = { startsAt: JOB_START + 3 * HOUR, endsAt: JOB_START + 5 * HOUR };
    // Office reschedules, as in Dispatch.
    expect((await office.query(api.calendarMoves.previewVisit, { companyId: s.companyId, jobId: a.jobId, ...to })).blocking).toEqual([]);

    const preview = await s.as.query(api.calendarMoves.previewVisit, { companyId: s.companyId, jobId: a.jobId, ...to });
    expect(preview.blocking).toEqual([]);
    expect(preview.crewNotices).toEqual([expect.objectContaining({ name: "Lena", kind: "asked_again", optional: false })]);
    expect(preview.commitments).toContain("The client was told Tue, Mar 2 at 10:00 AM.");
    expect(preview.travel).toMatch(/Drive times between properties are not looked up/);
    expect(preview.series).toBeNull();

    // Someone else changes the visit in between: the move that was previewed is refused, nothing happens.
    expect(await refusal(s.as.mutation(api.calendarMoves.moveVisit, { companyId: s.companyId, jobId: a.jobId, ...to, version: "stale", notifyCustomer: false, quiet: [] }))).toBe("This visit changed since you looked at the move. Review what the move does again, then confirm it.");
    const result = await office.mutation(api.calendarMoves.moveVisit, { companyId: s.companyId, jobId: a.jobId, ...to, version: preview.plan.version, notifyCustomer: false, quiet: [], reason: "Client asked for the afternoon." });
    expect(result).toMatchObject({ askedAgain: 1, placesReopened: 0, customerNotice: { status: "not_chosen" } });
    expect((await s.job(a.jobId)).job.startsAt).toBe(to.startsAt);
    // The same visit shows the new time in Calendar and in Dispatch: one record.
    const calendar = await s.as.query(api.calendar.range, { companyId: s.companyId, from: JOB_START - 6 * HOUR, to: JOB_START + 12 * HOUR, layers: ["jobs"] });
    expect(calendar.items.find((item) => item.key === `jobs:${a.jobId}`)).toMatchObject({ startsAt: to.startsAt, status: "offer_sent" });
    expect((await s.board(a.jobId)).startsAt).toBe(to.startsAt);
  });

  it("leaves out a crew notice the person turned off, keeps the new offer, and says so in the record", async () => {
    const s = await setup();
    const a = await accepted(s);
    // Outside Lena's hours (she works Tuesdays 8 to 5): her place reopens.
    const to = { startsAt: JOB_START + 8 * HOUR, endsAt: JOB_START + 9 * HOUR };
    const preview = await s.as.query(api.calendarMoves.previewVisit, { companyId: s.companyId, jobId: a.jobId, ...to });
    const lena = preview.crewNotices.find((row) => row.name === "Lena")!;
    expect(lena).toMatchObject({ kind: "ended", optional: true });
    await s.as.mutation(api.calendarMoves.moveVisit, { companyId: s.companyId, jobId: a.jobId, ...to, version: preview.plan.version, notifyCustomer: false, quiet: [lena.assignmentId] });
    await flush(s.t);
    const texts = await s.t.run(async (ctx) => ctx.db.query("messages").collect());
    expect(texts.filter((row) => row.purpose === "assignment_ended")).toEqual([]);
    const events = await s.t.run(async (ctx) => ctx.db.query("events").collect());
    expect(events.find((row) => row.type === "job.rescheduled")?.data).toMatchObject({ placesReopened: 1, noticesNotSent: 1 });
    expect(events.find((row) => row.type === "job.moved_from_calendar")?.data).toMatchObject({ crewNoticesSkipped: 1, customerNotice: "not_chosen" });
  });

  it("saves the move even when the client can't be told, and reports that separately", async () => {
    const s = await setup();
    const a = await accepted(s);
    const to = { startsAt: JOB_START + 2 * HOUR, endsAt: JOB_START + 4 * HOUR };
    const preview = await s.as.query(api.calendarMoves.previewVisit, { companyId: s.companyId, jobId: a.jobId, ...to });
    // The seeded client has no phone or email: the preview says so before anything is saved.
    expect(preview.customerNotice).toEqual({ ready: false, words: "Not possible: Dana Whitfield has no phone number or email on file." });
    const result = await s.as.mutation(api.calendarMoves.moveVisit, { companyId: s.companyId, jobId: a.jobId, ...to, version: preview.plan.version, notifyCustomer: true, quiet: [] });
    expect(result.customerNotice).toEqual({ status: "not_sent", words: "Dana Whitfield has no phone number or email on file." });
    expect((await s.job(a.jobId)).job.startsAt).toBe(to.startsAt);
    const events = await s.t.run(async (ctx) => ctx.db.query("events").collect());
    expect(events.some((row) => row.type === "job.move_notice_not_sent")).toBe(true);
  });

  it("refuses a time outside the company's hours before anything is touched", async () => {
    const s = await setup();
    const a = await accepted(s);
    // The company works Tuesdays 8 to 5.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { businessSettings: { hours: [{ weekday: 2, startMinute: 8 * 60, endMinute: 17 * 60 }] } });
    });
    const to = { startsAt: JOB_START + 9 * HOUR, endsAt: JOB_START + 10 * HOUR };
    const preview = await s.as.query(api.calendarMoves.previewVisit, { companyId: s.companyId, jobId: a.jobId, ...to });
    expect(preview.blocking.length).toBeGreaterThan(0);
    expect(await refusal(s.as.mutation(api.calendarMoves.moveVisit, { companyId: s.companyId, jobId: a.jobId, ...to, version: preview.plan.version, notifyCustomer: false, quiet: [] }))).toBe(preview.blocking[0]);
    expect((await s.job(a.jobId)).job.startsAt).toBe(JOB_START);
  });
  it("queues one text to the client when they can be texted, and sending twice queues it once", async () => {
    // Customer texts go only inside sending hours, 8 AM to 9 PM the customer's time. The harness clock is 6 AM in
    // Chicago, so this runs at 8 AM.
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    const s = await setup();
    const a = await accepted(s);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.place.customerId, { phone: "+15125550188" });
    });
    const to = { startsAt: JOB_START + 2 * HOUR, endsAt: JOB_START + 4 * HOUR };
    // Without the client's permission for service texts, nothing would go, and the preview says why.
    const refused = await s.as.query(api.calendarMoves.previewVisit, { companyId: s.companyId, jobId: a.jobId, ...to });
    expect(refused.customerNotice).toEqual({ ready: false, words: "Not possible: There is no recorded permission to send service texts to this person." });
    await s.as.mutation(api.consent.record, { companyId: s.companyId, recipient: { kind: "customer", id: s.place.customerId }, channel: "sms", category: "operational", status: "granted", source: "web_form", evidence: "Agreed on the booking form." });
    const preview = await s.as.query(api.calendarMoves.previewVisit, { companyId: s.companyId, jobId: a.jobId, ...to });
    expect(preview.customerNotice.ready).toBe(true);
    expect(preview.customerNotice.words).toBe("A text to Dana Whitfield: “Alpha Cleaning: your standard visit on Tue, Mar 2 at 10:00 AM has moved to Tue, Mar 2 at 12:00 PM. Reply to this message with any questions.”");
    const result = await s.as.mutation(api.calendarMoves.moveVisit, { companyId: s.companyId, jobId: a.jobId, ...to, version: preview.plan.version, notifyCustomer: true, quiet: [] });
    expect(result.customerNotice.status).toBe("queued");
    const notices = (await s.t.run(async (ctx) => ctx.db.query("messages").collect())).filter((row) => row.purpose === "customer_message");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ customerId: s.place.customerId, jobId: a.jobId, channel: "sms", draftedBy: "person" });
    // The same notice for the same move is never queued twice, however often it is asked for.
    await s.t.run(async (ctx) => {
      const { queueMoveNotice } = await import("./lib/calendar/customerNotice");
      const company = (await ctx.db.get(s.companyId))!;
      const member = (await ctx.db.query("members").collect()).find((row) => row.companyId === s.companyId)!;
      await queueMoveNotice(ctx, { company, customer: (await ctx.db.get(s.place.customerId))!, job: (await ctx.db.get(a.jobId))!, from: JOB_START, to: to.startsAt, member, actor: { kind: "member", memberId: member._id } });
    });
    expect((await s.t.run(async (ctx) => ctx.db.query("messages").collect())).filter((row) => row.purpose === "customer_message")).toHaveLength(1);
  });
});
