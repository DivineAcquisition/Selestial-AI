/**
 * Calendar's read (convex/calendar.ts): the right records for the range, nothing a role may not see,
 * each cleaner's conflicts against their own time only, and recurring occurrences projected from the
 * plan's own rules without duplicating what is booked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, HOUR, JOB_END, JOB_START, NOW, readyCleaner, refusal, start, type T } from "../tests/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { cleanerConflicts } from "./lib/calendar/conflicts";
import { visitState } from "./lib/calendar/model";
import { instantOn } from "./lib/clients/plans";
import { blankSpec, defaultModifiers, type Spec } from "./lib/services/spec";

const DAY = 24 * HOUR;
const MINUTE = 60_000;
const notice = { required: false, note: "" };
const address = { line1: "12 Elm St", city: "Austin", region: "TX", postalCode: "78701" };

type As = Awaited<ReturnType<typeof company>>["as"];

async function place(as: As, companyId: Id<"companies">, name = "Dana Whitfield") {
  const customerId = await as.mutation(api.customers.create, { companyId, name, kind: "home" });
  const propertyId = await as.mutation(api.properties.create, { companyId, customerId, kind: "home", address });
  return { customerId, propertyId };
}

async function visit(as: As, companyId: Id<"companies">, where: { customerId: Id<"customers">; propertyId: Id<"properties"> }, startsAt: number, endsAt: number) {
  return as.mutation(api.jobs.create, { companyId, ...where, serviceType: "standard", scope: "Standard clean", startsAt, endsAt });
}

/** An accepted place on a job, written directly: the offer flow is Dispatch's and has its own tests. */
async function accept(t: T, companyId: Id<"companies">, jobId: Id<"jobs">, cleanerId: Id<"cleaners">, status: "accepted" | "offered" = "accepted") {
  await t.run(async (ctx) => {
    await ctx.db.insert("assignments", { companyId, jobId, cleanerId, status, scope: "Standard clean", payCents: 8000, offeredAt: NOW, respondBy: NOW + HOUR, ...(status === "accepted" ? { respondedAt: NOW } : {}) });
  });
}

const keys = (items: { key: string }[]) => items.map((item) => item.key);

describe("Calendar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("shows each role only the layers it may see, and refuses another company's calendar", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const office = await addMember(t, as, companyId, "office-a", "office");
    const where = await place(as, companyId);
    const jobId = await visit(as, companyId, where, JOB_START, JOB_END);
    const cleanerId = await readyCleaner(as, companyId, "Rosa");
    const ownerMemberId = await t.run(async (ctx) => (await ctx.db.query("members").collect()).find((row) => row.role === "owner")!._id);
    await t.run(async (ctx) => {
      const applicantId = await ctx.db.insert("applicants", { companyId, name: "Maria Lopez", createdAt: NOW });
      const applicationId = await ctx.db.insert("applications", { companyId, applicantId, source: "manual", appliedAt: NOW, stage: "received", contact: { status: "missing", evidence: [] }, facts: [], followUpsSent: 0, createdAt: NOW });
      await ctx.db.insert("interviews", { companyId, applicationId, status: "confirmed", interviewerId: ownerMemberId, startsAt: JOB_START + 3 * HOUR, endsAt: JOB_START + 4 * HOUR, reschedules: 0, createdAt: NOW });
      await ctx.db.insert("timeOff", { companyId, cleanerId, startsAt: JOB_START + 5 * HOUR, endsAt: JOB_START + 6 * HOUR, note: "Doctor", createdAt: NOW });
    });
    const range = { companyId, from: JOB_START - 10 * HOUR, to: JOB_START + 14 * HOUR };

    const forOwner = await as.query(api.calendar.range, { ...range, layers: ["jobs", "hiring", "availability"] });
    expect(keys(forOwner.items)).toEqual(expect.arrayContaining([`jobs:${jobId}`]));
    expect(forOwner.items.find((item) => item.kind === "interview")).toMatchObject({ title: "Interview · Maria Lopez", timing: "appointment", statusLabel: "Confirmed" });
    expect(forOwner.items.find((item) => item.kind === "time_off")).toMatchObject({ title: "Rosa · time off", detail: "Doctor", timing: "availability" });

    // Office asks for interviews too and gets none: the layer is not theirs, and nobody's private note is in it.
    const forOffice = await office.query(api.calendar.range, { ...range, layers: ["jobs", "hiring", "availability", "external", "business"] });
    expect(forOffice.layers).toEqual(["jobs", "availability", "deadlines"]);
    expect(forOffice.items.some((item) => item.layer === "hiring")).toBe(false);
    expect(forOffice.items.find((item) => item.kind === "time_off")).toMatchObject({ detail: null });
    expect(forOffice.resources.members).toEqual([]);
    expect(forOffice.external).toBeNull();

    // Another company's owner cannot read this calendar at all, and is told nothing about it.
    const other = await company(t, "owner-b", "Beta Cleaning");
    expect(await refusal(other.as.query(api.calendar.range, range))).toBe("Not found.");
    // Nor is anything of Alpha's in Beta's own calendar.
    expect((await other.as.query(api.calendar.range, { ...range, companyId: other.companyId })).items).toEqual([]);
  });

  it("finds a visit on every day it touches, and not on the day after it ends", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const where = await place(as, companyId);
    // 23:00 to 01:00 in Chicago, across midnight, written directly: business hours are not what is tested here.
    const startsAt = Date.UTC(2027, 2, 3, 5, 0);
    const jobId = await t.run(async (ctx) => ctx.db.insert("jobs", { companyId, ...where, serviceType: "overnight", scope: "Office", requiredSkills: [], startsAt, endsAt: startsAt + 2 * HOUR, status: "scheduled", createdAt: NOW }));
    const tuesday = { from: Date.UTC(2027, 2, 2, 6, 0), to: Date.UTC(2027, 2, 3, 6, 0) };
    const wednesday = { from: tuesday.to, to: Date.UTC(2027, 2, 4, 6, 0) };
    expect(keys((await as.query(api.calendar.range, { companyId, ...tuesday })).items)).toContain(`jobs:${jobId}`);
    expect(keys((await as.query(api.calendar.range, { companyId, ...wednesday })).items)).toContain(`jobs:${jobId}`);
    // A range that starts exactly when it ends does not include it.
    expect(keys((await as.query(api.calendar.range, { companyId, from: startsAt + 2 * HOUR, to: startsAt + 10 * HOUR })).items)).not.toContain(`jobs:${jobId}`);

    // Too long a range is refused rather than cut short.
    expect(await refusal(as.query(api.calendar.range, { companyId, from: NOW, to: NOW + 60 * DAY }))).toBe("Calendar shows at most 45 days at a time.");
  });

  it("marks a cleaner's overlapping visits as theirs, and leaves another cleaner at the same time alone", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const where = await place(as, companyId);
    const rosa = await readyCleaner(as, companyId, "Rosa");
    const lena = await readyCleaner(as, companyId, "Lena");
    const first = await visit(as, companyId, where, JOB_START, JOB_END);
    const second = await visit(as, companyId, where, JOB_START + HOUR, JOB_END + HOUR);
    const third = await visit(as, companyId, where, JOB_START, JOB_END);
    await accept(t, companyId, first, rosa);
    await accept(t, companyId, second, rosa, "offered");
    await accept(t, companyId, third, lena);
    const data = await as.query(api.calendar.range, { companyId, from: JOB_START - 6 * HOUR, to: JOB_START + 12 * HOUR, layers: ["jobs"] });
    const item = (jobId: Id<"jobs">) => data.items.find((row) => row.key === `jobs:${jobId}`)!;
    expect(item(first).problems).toContain("Rosa: Overlaps a visit held for them by an offer");
    expect(item(second).problems).toContain("Rosa: Overlaps a visit held for them by an offer");
    expect(item(third).problems.filter((words) => words.startsWith("Lena"))).toEqual([]);
    expect(item(first)).toMatchObject({ status: "fully_staffed", statusLabel: "Fully staffed", resources: [{ kind: "cleaner", name: "Rosa", state: "accepted" }] });
    expect(item(second)).toMatchObject({ status: "offer_sent" });
  });

  it("projects a recurring plan's later visits from its own rules, after what is booked, at the right local time across a clock change", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const serviceId = await publish(as, companyId);
    const result = await as.mutation(api.clients.create, { companyId, type: "person", name: "Dana Whitfield", kind: "home", contact: { name: "Dana Whitfield", phone: "512-555-0100" }, property: { address, kind: "home" }, addAnyway: true });
    if (!result.created) throw new Error("not created");
    const profile = await as.query(api.clients.profile, { companyId, customerId: result.customerId });
    const { planId } = await as.mutation(api.servicePlans.create, { companyId, customerId: result.customerId, propertyId: profile.properties[0].id as Id<"properties">, serviceId, kind: "recurring", cadence: "every_7_days", startsOn: "2027-03-02", startTime: "10:00", arrivalWindowMinutes: 30, quoteInput: { bedrooms: 2, bathrooms: 1 }, start: true });

    // Booked through four weeks. Clocks went forward on March 14: a 10:00 visit on March 16 is 15:00 UTC, not 16:00.
    const jobs = (await t.run(async (ctx) => ctx.db.query("jobs").collect())).filter((job) => job.planId === planId).sort((a, b) => a.startsAt - b.startsAt);
    expect(jobs.find((job) => job.planDate === "2027-03-16")?.startsAt).toBe(Date.UTC(2027, 2, 16, 15, 0));
    expect(jobs.find((job) => job.planDate === "2027-03-09")?.startsAt).toBe(Date.UTC(2027, 2, 9, 16, 0));
    const bookedThrough = jobs[jobs.length - 1].planDate!;

    const data = await as.query(api.calendar.range, { companyId, from: Date.UTC(2027, 2, 22, 5, 0), to: Date.UTC(2027, 3, 21, 5, 0), layers: ["jobs"] });
    const projected = data.items.filter((item) => item.timing === "projected");
    const booked = data.items.filter((item) => item.kind === "visit");
    // Every projected day comes after the last booked day, and no day is both.
    expect(projected.length).toBeGreaterThan(0);
    for (const item of projected) expect(item.key.split(":").pop()! > bookedThrough).toBe(true);
    expect(new Set(projected.map((item) => item.key.split(":").pop())).size).toBe(projected.length);
    expect(projected[0]).toMatchObject({ kind: "projected_visit", status: "projected", statusLabel: "Projected · books automatically nearer the day", resources: [] });
    expect(projected.every((item) => item.startsAt % DAY === 15 * HOUR)).toBe(true);
    expect(booked.length).toBeGreaterThan(0);
  });
});

describe("Calendar rules", () => {
  it("reads a visit's state from its job and crew, never one from the other", () => {
    const job = { status: "scheduled" as const, completionReportedAt: undefined, completionReview: undefined };
    expect(visitState(job, { open: 1, accepted: 0, offersOut: 0 })).toBe("booked");
    expect(visitState(job, { open: 1, accepted: 0, offersOut: 1 })).toBe("offer_sent");
    expect(visitState(job, { open: 1, accepted: 1, offersOut: 0 })).toBe("partly_staffed");
    expect(visitState(job, { open: 0, accepted: 2, offersOut: 0 })).toBe("fully_staffed");
    expect(visitState({ ...job, status: "in_progress", completionReportedAt: NOW }, { open: 0, accepted: 1, offersOut: 0 })).toBe("under_review");
    expect(visitState({ ...job, status: "completed" }, { open: 0, accepted: 1, offersOut: 0 })).toBe("completed");
  });

  it("checks one cleaner's time against their own hours, time off and the time kept between visits", () => {
    const tuesday = { weekday: 2, startMinute: 8 * 60, endMinute: 17 * 60 };
    const found = cleanerConflicts({
      commitments: [
        { key: "a", startsAt: JOB_START, endsAt: JOB_END, held: false },
        { key: "b", startsAt: JOB_END + 10 * MINUTE, endsAt: JOB_END + 70 * MINUTE, held: false },
        { key: "c", startsAt: JOB_START + 9 * HOUR, endsAt: JOB_START + 10 * HOUR, held: false },
      ],
      windows: [tuesday],
      away: [{ startsAt: JOB_START + 9 * HOUR, endsAt: JOB_START + 12 * HOUR, label: "their time off" }],
      bufferMinutes: 30,
      timezone: "America/Chicago",
    });
    expect(found.get("a")).toBeUndefined();
    expect(found.get("b")).toEqual(["Starts 10 min after another visit; 30 min is kept between visits"]);
    expect(found.get("c")).toEqual(["Outside the hours they said they can work", "During their time off"]);
  });

  it("books a local time of day correctly on both sides of a clock change", () => {
    expect(instantOn("2027-03-13", "09:00", "America/Chicago")).toBe(Date.UTC(2027, 2, 13, 15, 0));
    expect(instantOn("2027-03-14", "09:00", "America/Chicago")).toBe(Date.UTC(2027, 2, 14, 14, 0));
    expect(instantOn("2027-11-07", "09:00", "America/Chicago")).toBe(Date.UTC(2027, 10, 7, 15, 0));
  });
});

/** A published home service, as Services & Pricing publishes one. */
async function publish(as: As, companyId: Id<"companies">) {
  const spec: Spec = {
    ...blankSpec("residential"),
    name: "Standard clean",
    summary: "A full clean.",
    included: [{ id: "counters", label: "Wipe kitchen counters", section: "Kitchen", requiresPhoto: false }],
    pricing: { method: "bed_bath", baseCents: 12000, includedBedrooms: 1, includedBathrooms: 1, perBedroomCents: 2000, perBathroomCents: 2500, perHalfBathCents: 1000, baseLaborMinutes: 120, perBedroomMinutes: 30, perBathroomMinutes: 30, perHalfBathMinutes: 15 },
    modifiers: { ...defaultModifiers(), recurring: { enabled: true, options: [{ schedule: "every_7_days", discount: { kind: "percent", value: 10 } }] } },
  };
  const { serviceId } = await as.mutation(api.services.startDraft, { companyId, category: spec.category, spec, origin: "manual" });
  const { changeId } = await as.mutation(api.services.submit, { companyId, serviceId, expectedRevision: 1, reason: "Launch.", customerNotice: notice, contractReview: notice });
  const change = await as.query(api.services.change, { companyId, changeId });
  await as.mutation(api.services.approve, { companyId, changeId, hash: change.hash, publish: true });
  return serviceId;
}
