/**
 * Calendar's own events (convex/calendarEvents.ts): who may make them, whose time they take, what a
 * private event shows to others, and that a change or cancellation keeps its history.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, HOUR, JOB_END, JOB_START, NOW, readyCleaner, refusal, start, type T } from "../tests/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const address = { line1: "12 Elm St", city: "Austin", region: "TX", postalCode: "78701" };
type As = Awaited<ReturnType<typeof company>>["as"];

async function setup() {
  const t = start();
  const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
  const manager = await addMember(t, as, companyId, "manager-a", "manager");
  const office = await addMember(t, as, companyId, "office-a", "office");
  const ids = await t.run(async (ctx) => {
    const rows = await ctx.db.query("members").collect();
    const find = (role: string) => rows.find((row) => row.companyId === companyId && row.role === role)!._id;
    return { owner: find("owner"), manager: find("manager"), office: find("office") };
  });
  return { t, as, companyId, manager, office, ids };
}

const range = (companyId: Id<"companies">) => ({ companyId, from: JOB_START - 12 * HOUR, to: JOB_START + 12 * HOUR, layers: ["jobs" as const, "business" as const, "hiring" as const, "quality" as const] });

async function visitWith(t: T, as: As, companyId: Id<"companies">, cleanerId: Id<"cleaners">) {
  const customerId = await as.mutation(api.customers.create, { companyId, name: "Dana Whitfield", kind: "home" });
  const propertyId = await as.mutation(api.properties.create, { companyId, customerId, kind: "home", address });
  const jobId = await as.mutation(api.jobs.create, { companyId, customerId, propertyId, serviceType: "standard", scope: "Standard clean", startsAt: JOB_START, endsAt: JOB_END });
  await t.run(async (ctx) => {
    await ctx.db.insert("assignments", { companyId, jobId, cleanerId, status: "accepted", scope: "Standard clean", payCents: 8000, offeredAt: NOW, respondBy: NOW + HOUR, respondedAt: NOW });
  });
  return { customerId, propertyId, jobId };
}

describe("Calendar events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("lets Owners and Managers make a meeting, keeps it from Office, and shows a private one as Busy to others", async () => {
    const s = await setup();
    const meeting = { companyId: s.companyId, kind: "meeting" as const, title: "Weekly ops", startsAt: JOB_START, endsAt: JOB_START + HOUR, memberIds: [s.ids.owner, s.ids.manager], cleanerIds: [] };
    expect(await refusal(s.office.mutation(api.calendarEvents.create, meeting))).toBe("Not allowed.");
    const meetingId = await s.as.mutation(api.calendarEvents.create, meeting);
    const privateId = await s.as.mutation(api.calendarEvents.create, { ...meeting, kind: "appointment", title: "Accountant", memberIds: [s.ids.owner], private: true });

    const forManager = await s.manager.query(api.calendar.range, range(s.companyId));
    expect(forManager.items.find((item) => item.key === `calendarEvents:${meetingId}`)).toMatchObject({ title: "Weekly ops", kind: "meeting", layer: "business", statusLabel: "Scheduled" });
    // The manager is not on the owner's private appointment: they see that the owner is busy, and nothing else.
    expect(forManager.items.find((item) => item.key === `calendarEvents:${privateId}`)).toMatchObject({ title: "Busy", detail: null, statusLabel: "Busy · private", customerId: null });
    expect(await s.manager.query(api.calendarEvents.get, { companyId: s.companyId, eventId: privateId })).toMatchObject({ visible: false, title: "Busy" });
    expect(await s.as.query(api.calendarEvents.get, { companyId: s.companyId, eventId: privateId })).toMatchObject({ visible: true, title: "Accountant" });

    // Office sees neither, whatever layers it asks for.
    const forOffice = await s.office.query(api.calendar.range, range(s.companyId));
    expect(forOffice.items.some((item) => item.source.table === "calendarEvents")).toBe(false);
    expect(await refusal(s.office.query(api.calendarEvents.get, { companyId: s.companyId, eventId: meetingId }))).toBe("Not found.");
  });

  it("refuses to put a cleaner in two places unless overridden with a reason, and flags their visit", async () => {
    const s = await setup();
    const rosa = await readyCleaner(s.as, s.companyId, "Rosa");
    const { jobId } = await visitWith(s.t, s.as, s.companyId, rosa);
    const training = { companyId: s.companyId, kind: "training" as const, title: "Kitchen standards", startsAt: JOB_START + HOUR, endsAt: JOB_START + 3 * HOUR, memberIds: [], cleanerIds: [rosa], leadMemberId: s.ids.manager };

    const preview = await s.as.query(api.calendarEvents.preview, training);
    expect(preview).toMatchObject({ ready: true });
    expect(preview.hard[0]).toMatch(/^Rosa is on a visit then/);
    expect(await refusal(s.as.mutation(api.calendarEvents.create, training))).toMatch(/^This can't be saved as it is: Rosa is on a visit then .* give a reason to override\.$/);

    const eventId = await s.as.mutation(api.calendarEvents.create, { ...training, overrideReason: "Rosa leaves the visit early; agreed with the client." });
    const saved = await s.as.query(api.calendarEvents.get, { companyId: s.companyId, eventId });
    expect(saved).toMatchObject({ visible: true, override: { reason: "Rosa leaves the visit early; agreed with the client.", byName: "owner-a" } });
    const data = await s.as.query(api.calendar.range, range(s.companyId));
    expect(data.items.find((item) => item.key === `jobs:${jobId}`)?.problems).toContain("Rosa: During a training session");
    expect(data.items.find((item) => item.key === `calendarEvents:${eventId}`)).toMatchObject({ kind: "training", layer: "hiring", agent: "recruiter" });
  });

  it("treats a member's own time away as a hard conflict for them alone, and a private appointment never blocks a cleaner", async () => {
    const s = await setup();
    const rosa = await readyCleaner(s.as, s.companyId, "Rosa");
    await s.as.mutation(api.calendarEvents.create, { companyId: s.companyId, kind: "unavailable", startsAt: JOB_START - 2 * HOUR, endsAt: JOB_START + 6 * HOUR, memberIds: [s.ids.owner], cleanerIds: [], private: true });
    const forOwner = await s.as.query(api.calendarEvents.preview, { companyId: s.companyId, kind: "meeting", startsAt: JOB_START, endsAt: JOB_START + HOUR, memberIds: [s.ids.owner], cleanerIds: [] });
    expect(forOwner.hard).toEqual([expect.stringMatching(/^owner-a is unavailable then/)]);
    const forManager = await s.as.query(api.calendarEvents.preview, { companyId: s.companyId, kind: "meeting", startsAt: JOB_START, endsAt: JOB_START + HOUR, memberIds: [s.ids.manager], cleanerIds: [] });
    expect(forManager.hard).toEqual([]);
    const forCleaner = await s.as.query(api.calendarEvents.preview, { companyId: s.companyId, kind: "training", startsAt: JOB_START, endsAt: JOB_START + HOUR, memberIds: [], cleanerIds: [rosa], leadMemberId: s.ids.manager });
    expect(forCleaner.hard).toEqual([]);
  });

  it("refuses a stale change, keeps the old and new times, and cancels without deleting", async () => {
    const s = await setup();
    const eventId = await s.as.mutation(api.calendarEvents.create, { companyId: s.companyId, kind: "meeting", title: "Planning", startsAt: JOB_START, endsAt: JOB_START + HOUR, memberIds: [s.ids.owner], cleanerIds: [] });
    const moved = { companyId: s.companyId, eventId, kind: "meeting" as const, title: "Planning", startsAt: JOB_START + 2 * HOUR, endsAt: JOB_START + 3 * HOUR, memberIds: [s.ids.owner], cleanerIds: [] };
    await s.manager.mutation(api.calendarEvents.update, { ...moved, expectedRevision: 1 });
    expect(await refusal(s.as.mutation(api.calendarEvents.update, { ...moved, title: "Planning (long)", expectedRevision: 1 }))).toBe("This event changed since you opened it. Look at it again, then make your change.");
    expect(await refusal(s.as.mutation(api.calendarEvents.cancel, { companyId: s.companyId, eventId, expectedRevision: 2, reason: " " }))).toBe("The reason is required.");
    await s.as.mutation(api.calendarEvents.cancel, { companyId: s.companyId, eventId, expectedRevision: 2, reason: "Moved to next week." });
    const row = await s.as.query(api.calendarEvents.get, { companyId: s.companyId, eventId });
    expect(row).toMatchObject({ status: "cancelled", cancelled: { reason: "Moved to next week." }, startsAt: JOB_START + 2 * HOUR });
    if (!row.visible) throw new Error("expected visible");
    expect(row.history.map((entry) => [entry.type, entry.by])).toEqual([
      ["calendar_event.cancelled", "owner-a"],
      ["calendar_event.rescheduled", "manager-a"],
      ["calendar_event.created", "owner-a"],
    ]);
    expect(row.history[1].data).toMatchObject({ from: "Tue, Mar 2 10:00 AM to 11:00 AM", to: "Tue, Mar 2 12:00 PM to 1:00 PM" });
  });

  it("records training attendance and an inspection result only after they start, and only a crew lead or a member inspects", async () => {
    const s = await setup();
    const rosa = await readyCleaner(s.as, s.companyId, "Rosa");
    const lena = await readyCleaner(s.as, s.companyId, "Lena");
    const { jobId } = await visitWith(s.t, s.as, s.companyId, lena);
    const trainingId = await s.as.mutation(api.calendarEvents.create, { companyId: s.companyId, kind: "training", startsAt: JOB_START - 6 * HOUR, endsAt: JOB_START - 4 * HOUR, memberIds: [], cleanerIds: [rosa], leadMemberId: s.ids.owner });
    expect(await refusal(s.as.mutation(api.calendarEvents.recordAttendance, { companyId: s.companyId, eventId: trainingId, cleanerId: rosa, attended: true }))).toBe("Attendance can be recorded once the session has started.");

    const inspection = { companyId: s.companyId, kind: "inspection" as const, startsAt: JOB_END + HOUR, endsAt: JOB_END + 2 * HOUR, memberIds: [], cleanerIds: [], leadCleanerId: rosa, jobId };
    expect(await refusal(s.as.mutation(api.calendarEvents.create, inspection))).toBe("Only a cleaner who leads a crew can inspect.");
    expect(await refusal(s.as.mutation(api.calendarEvents.create, { ...inspection, leadCleanerId: undefined, memberIds: [s.ids.manager], jobId: undefined }))).toBe("Choose the visit, quality case or property to inspect.");
    const inspectionId = await s.as.mutation(api.calendarEvents.create, { ...inspection, leadCleanerId: undefined, memberIds: [s.ids.manager] });
    const saved = await s.as.query(api.calendarEvents.get, { companyId: s.companyId, eventId: inspectionId });
    expect(saved).toMatchObject({ visible: true, property: { label: "12 Elm St" }, jobId, customer: { name: "Dana Whitfield" } });

    vi.setSystemTime(JOB_START + 20 * HOUR);
    await s.as.mutation(api.calendarEvents.recordAttendance, { companyId: s.companyId, eventId: trainingId, cleanerId: rosa, attended: true });
    expect(await s.as.query(api.calendarEvents.get, { companyId: s.companyId, eventId: trainingId })).toMatchObject({ status: "completed", attendance: [{ name: "Rosa", attended: true, byName: "owner-a" }] });
    expect(await refusal(s.as.mutation(api.calendarEvents.recordInspection, { companyId: s.companyId, eventId: inspectionId, result: "issues_found", note: "" }))).toBe("What was found is required.");
    await s.manager.mutation(api.calendarEvents.recordInspection, { companyId: s.companyId, eventId: inspectionId, result: "issues_found", note: "Oven not cleaned." });
    expect(await s.as.query(api.calendarEvents.get, { companyId: s.companyId, eventId: inspectionId })).toMatchObject({ status: "completed", inspection: { result: "issues_found", note: "Oven not cleaned.", byName: "manager-a" } });
  });

  it("keeps a restricted quality case from a Manager", async () => {
    const s = await setup();
    const caseId = await s.t.run(async (ctx) =>
      ctx.db.insert("qualityCases", { companyId: s.companyId, key: "case-1", stage: "investigating", origin: "owner_report", title: "Damage report", happened: "Reported.", doing: "Looking.", cleanerIds: [], areas: [], urgency: "urgent", restricted: true, dueAt: NOW + HOUR, revision: 1, createdAt: NOW, updatedAt: NOW }),
    );
    const inspection = { companyId: s.companyId, kind: "inspection" as const, startsAt: JOB_START, endsAt: JOB_START + HOUR, memberIds: [s.ids.manager], cleanerIds: [], qualityCaseId: caseId };
    expect(await refusal(s.manager.mutation(api.calendarEvents.create, inspection))).toBe("Not found.");
    expect((await s.manager.query(api.calendarEvents.options, { companyId: s.companyId })).cases).toEqual([]);
  });
});
