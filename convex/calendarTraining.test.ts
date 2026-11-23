/**
 * @vitest-environment edge-runtime
 *
 * A training session for a real new hire: attendance counts toward onboarding only when a person records
 * it and names the requirement, through Recruiter's own step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { refusal } from "../tests/harness";
import { DAY, HOUR, recruiterTestEnv, setup, submitted, tokenFor } from "../tests/recruiterHarness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

describe("Calendar: training sessions and onboarding", () => {
  let undo = () => {};
  beforeEach(() => {
    undo = recruiterTestEnv();
  });
  afterEach(() => undo());

  it("records a new hire's training only when a person says so, and only the requirement they name", async () => {
    const s = await setup();
    const invite = await submitted(s);
    await s.as.mutation(api.hiringNeeds.setCompensation, { companyId: s.companyId, needId: s.needId, pay: { kind: "share", shareBps: 4500 } });
    await s.as.mutation(api.applications.decide, { companyId: s.companyId, applicationId: invite.applicationId, decision: "offer" });
    const offerId = await s.as.mutation(api.hiringOffers.draft, { companyId: s.companyId, applicationId: invite.applicationId, startConditions: "After onboarding.", expectations: "Two weekdays." });
    await s.as.mutation(api.hiringOffers.requestSend, { companyId: s.companyId, offerId });
    await s.approveAll();
    await s.t.mutation(api.applicantPages.acceptOffer, { token: tokenFor("maria.lopez@example.test", "hiring-offer") });
    const [handoff] = await s.as.query(api.onboarding.queue, { companyId: s.companyId });
    const ownerId = (await s.as.query(api.members.list, { companyId: s.companyId }))[0].id as Id<"members">;

    // The form offers the open onboarding, and the session takes the new hire as an attendee.
    expect((await s.as.query(api.calendarEvents.options, { companyId: s.companyId })).handoffs).toEqual([expect.objectContaining({ handoffId: handoff.handoffId, name: "Maria Lopez" })]);
    const startsAt = Date.now() + DAY;
    const eventId = await s.as.mutation(api.calendarEvents.create, { companyId: s.companyId, kind: "training", title: "First-day training", startsAt, endsAt: startsAt + 2 * HOUR, memberIds: [], cleanerIds: [], leadMemberId: ownerId, handoffIds: [handoff.handoffId] });
    const session = await s.as.query(api.calendarEvents.get, { companyId: s.companyId, eventId });
    if (!session.visible) throw new Error("expected visible");
    expect(session.cleaners).toEqual([{ id: handoff.cleanerId, name: "Maria Lopez" }]);
    expect(session.handoffs[0].outstanding.map((row) => row.key)).toContain("training");

    vi.setSystemTime(startsAt + 3 * HOUR);
    // Saying someone attended changes nothing about onboarding by itself.
    await s.as.mutation(api.calendarEvents.recordAttendance, { companyId: s.companyId, eventId, cleanerId: handoff.cleanerId as Id<"cleaners">, attended: true });
    const training = async () => (await s.as.query(api.onboarding.queue, { companyId: s.companyId }))[0].requirements.find((row) => row.key === "training")!.status;
    expect(await training()).toBe("outstanding");
    // Absence never counts.
    expect(await refusal(s.as.mutation(api.calendarEvents.recordAttendance, { companyId: s.companyId, eventId, cleanerId: handoff.cleanerId as Id<"cleaners">, attended: false, requirement: { handoffId: handoff.handoffId, key: "training" } }))).toBe("Only attendance can count toward onboarding.");
    // Naming the requirement records it, by this person, through Recruiter's step.
    await s.as.mutation(api.calendarEvents.recordAttendance, { companyId: s.companyId, eventId, cleanerId: handoff.cleanerId as Id<"cleaners">, attended: true, requirement: { handoffId: handoff.handoffId, key: "training" } });
    expect(await training()).toBe("done");
    expect(await s.as.query(api.calendarEvents.get, { companyId: s.companyId, eventId })).toMatchObject({ status: "completed", attendance: [{ attended: true, requirementKey: "training" }] });
  });
});
