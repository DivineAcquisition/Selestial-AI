/**
 * @vitest-environment edge-runtime
 *
 * Google Calendar: a change made in Google is flagged once and settled when the visit changes again in
 * Selestial or a person puts Selestial's time back; a visit rescheduled in Selestial is never mistaken for a
 * change made in Google; changes are read on the timer without a push channel; and busy times are skipped by
 * the times Selestial offers while a person is only warned. Every Google call goes to a fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { company, JOB_END, JOB_START, NOW, seedVisit, start, type T } from "../tests/harness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { calendarBusy, subtract } from "./lib/google/busy";
import { SCOPE } from "./lib/google/features";
import { openSlots } from "./lib/recruiter/interviews";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const ENV = { GOOGLE_CLIENT_ID: "client-id.apps.test", GOOGLE_CLIENT_SECRET: "client-secret-not-real", MAILBOX_TOKEN_KEY: KEY, CONVEX_SITE_URL: "https://deployment.convex.site.test", APP_ORIGIN: "https://app.selestial.test" };
const CAL = "work@alpha.test";
const HOUR = 3_600_000;
const b64url = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

type Call = { url: string; method: string };
/** A fake Google Calendar. `events` is what the change feed answers with. */
function fakeCalendar(state: { events: unknown[] }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.includes("oauth2.googleapis.com/token")) {
        return json({ access_token: "access-1", refresh_token: "refresh-1", scope: [SCOPE.openid, SCOPE.email, SCOPE.calendarList, SCOPE.calendarEvents, SCOPE.calendarFreeBusy].join(" "), expires_in: 3600, id_token: `${b64url({ alg: "none" })}.${b64url({ sub: "sub-1", email: "owner@alpha.test" })}.sig` });
      }
      if (url.includes("/events") && method === "GET") return json({ items: state.events, nextSyncToken: `token-${calls.length}` });
      if (url.includes("/events")) return json({ id: JSON.parse(String(init?.body ?? "{}")).id ?? "x" });
      return new Response(JSON.stringify({ error: "not faked" }), { status: 404 });
    }),
  );
  return calls;
}

async function connectCalendar(t: T, as: ReturnType<T["withIdentity"]>, companyId: Id<"companies">) {
  const { url } = await as.mutation(api.google.startConnect, { companyId, feature: "calendar" });
  fakeCalendar({ events: [] });
  const response = await t.fetch(`/oauth/google/callback?state=${encodeURIComponent(new URL(url).searchParams.get("state")!)}&code=c`, { method: "GET" });
  const token = new URL(response.headers.get("location")!).searchParams.get("pending")!;
  await as.mutation(api.google.confirmConnect, { companyId, token });
  return t.run(async (ctx) => {
    const connection = (await ctx.db.query("googleConnections").collect())[0];
    await ctx.db.insert("googleResources", { companyId, connectionId: connection._id, kind: "calendar_sync", externalId: CAL, label: "Work", access: "verified", addedBy: connection.connectedBy, createdAt: Date.now() });
    return connection._id;
  });
}

/** Runs one calendar sync the way the worker does. */
async function sync(t: T, companyId: Id<"companies">, connectionId: Id<"googleConnections">) {
  const jobId = await t.run((ctx) => ctx.db.insert("googleJobs", { companyId, connectionId, kind: "calendar_sync", key: `sync:${Math.random()}`, status: "running", payload: "{}", attempts: 1, nextAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }));
  await t.action(internal.googleWork.run, { jobId });
  return t.run(async (ctx) => JSON.parse((await ctx.db.get(jobId))!.result ?? "{}") as { written: number; held: number });
}

const iso = (at: number) => new Date(at).toISOString();
const googleEvent = (eventId: string, startsAt: number, endsAt: number, status = "confirmed") => ({ id: eventId, status, start: { dateTime: iso(startsAt) }, end: { dateTime: iso(endsAt) }, extendedProperties: { private: { selestial: "1" } } });
const link = (t: T) => t.run(async (ctx) => (await ctx.db.query("googleCalendarLinks").collect())[0]);
const tasks = (t: T) => t.run((ctx) => ctx.db.query("tasks").collect());
const calendarTasks = async (t: T) => (await tasks(t)).filter((task) => task.title.includes("Google Calendar event"));

describe("Google Calendar changes", () => {
  let t: T;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    t = start();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a visit rescheduled in Selestial before the sync wrote it is not flagged as moved in Google", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const connectionId = await connectCalendar(t, as, companyId);
    const { jobId } = await seedVisit(as, companyId);
    fakeCalendar({ events: [] });
    expect((await sync(t, companyId, connectionId)).written).toBe(1);
    const { eventId } = await link(t);
    // Rescheduled in Selestial; Google still shows the time Selestial wrote last.
    await t.run((ctx) => ctx.db.patch(jobId, { startsAt: JOB_START + HOUR, endsAt: JOB_END + HOUR }));
    fakeCalendar({ events: [googleEvent(eventId, JOB_START, JOB_END)] });
    await t.action(internal.googleCalendar.pullChanges, { companyId });
    expect((await link(t)).externalChange).toBeUndefined();
    expect(await calendarTasks(t)).toEqual([]);
    // The sync then writes the new time.
    const calls = fakeCalendar({ events: [] });
    expect((await sync(t, companyId, connectionId)).written).toBe(1);
    expect(calls.some((call) => call.method !== "GET" && call.url.includes("/events"))).toBe(true);
  });

  it("a change made in Google is held once, and settled when the visit changes again in Selestial", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const connectionId = await connectCalendar(t, as, companyId);
    const { jobId } = await seedVisit(as, companyId);
    fakeCalendar({ events: [] });
    await sync(t, companyId, connectionId);
    const { eventId } = await link(t);
    fakeCalendar({ events: [googleEvent(eventId, JOB_START + 2 * HOUR, JOB_END + 2 * HOUR)] });
    await t.action(internal.googleCalendar.pullChanges, { companyId });
    expect(await link(t)).toMatchObject({ externalChange: "moved", externalTimes: { startsAt: JOB_START + 2 * HOUR, endsAt: JOB_END + 2 * HOUR } });
    expect(await calendarTasks(t)).toHaveLength(1);
    // Read again: still one task. The sync does not overwrite it.
    await t.action(internal.googleCalendar.pullChanges, { companyId });
    expect(await calendarTasks(t)).toHaveLength(1);
    let calls = fakeCalendar({ events: [] });
    expect(await sync(t, companyId, connectionId)).toMatchObject({ written: 0, held: 1 });
    expect(calls.some((call) => call.method !== "GET" && call.url.includes("/events"))).toBe(false);
    expect((await as.query(api.googleCalendar.changed, { companyId })).map((c) => c.change)).toEqual(["moved"]);
    // The visit is moved in Selestial to Google's time: Selestial's version is written and the change settles.
    await t.run((ctx) => ctx.db.patch(jobId, { startsAt: JOB_START + 2 * HOUR, endsAt: JOB_END + 2 * HOUR }));
    calls = fakeCalendar({ events: [] });
    expect((await sync(t, companyId, connectionId)).written).toBe(1);
    expect(calls.some((call) => call.method !== "GET" && call.url.includes("/events"))).toBe(true);
    expect((await link(t)).externalChange).toBeUndefined();
    expect((await calendarTasks(t))[0].status).toBe("done");
    expect(await as.query(api.googleCalendar.changed, { companyId })).toEqual([]);
  });

  it("“Put Selestial’s time back” clears the flag and writes Selestial's version on the next sync", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const connectionId = await connectCalendar(t, as, companyId);
    await seedVisit(as, companyId);
    fakeCalendar({ events: [] });
    await sync(t, companyId, connectionId);
    const { eventId, _id } = await link(t);
    fakeCalendar({ events: [googleEvent(eventId, 0, 0, "cancelled")] });
    await t.action(internal.googleCalendar.pullChanges, { companyId });
    expect((await link(t)).externalChange).toBe("deleted");
    await as.mutation(api.googleCalendar.keepSelestial, { companyId, linkId: _id });
    expect((await link(t)).externalChange).toBeUndefined();
    expect((await calendarTasks(t))[0].status).toBe("done");
    const queued = await t.run(async (ctx) => (await ctx.db.query("googleJobs").collect()).filter((job) => job.kind === "calendar_sync" && job.status === "queued"));
    expect(queued).toHaveLength(1);
    const calls = fakeCalendar({ events: [] });
    expect((await sync(t, companyId, connectionId)).written).toBe(1);
    expect(calls.some((call) => call.method !== "GET" && call.url.includes("/events"))).toBe(true);
  });

  it("reads changes on the timer without a push channel, keeping its own place", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connectCalendar(t, as, companyId);
    expect(await t.run((ctx) => ctx.db.query("googleWatches").collect())).toEqual([]);
    let calls = fakeCalendar({ events: [] });
    await t.action(internal.googleCalendar.pullChanges, { companyId });
    expect(calls.some((call) => call.url.includes("/events?") && call.url.includes("timeMin"))).toBe(true);
    const [poll] = await t.run((ctx) => ctx.db.query("googleWatches").collect());
    expect(poll).toMatchObject({ kind: "calendar", target: CAL, expiresAt: 0 });
    expect(poll.syncToken).toBeTruthy();
    calls = fakeCalendar({ events: [] });
    await t.action(internal.googleCalendar.pullChanges, { companyId });
    expect(calls.some((call) => call.url.includes(`syncToken=${poll.syncToken}`))).toBe(true);
    // The sweep reads changes for every company with a sync calendar, channel or not.
    await t.mutation(internal.googleCalendar.sweep, {});
  });
});

describe("busy times from Google Calendar", () => {
  let t: T;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    t = start();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("mirrors Calendar's own events, a private one only as Busy, removes a cancelled one, and syncs right after a change", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    const connectionId = await connectCalendar(t, as, companyId);
    const ownerId = await t.run(async (ctx) => (await ctx.db.query("members").collect())[0]._id);
    const meetingId = await as.mutation(api.calendarEvents.create, { companyId, kind: "meeting", title: "Weekly ops", notes: "Budget review", location: "Office", startsAt: JOB_START, endsAt: JOB_START + HOUR, memberIds: [ownerId], cleanerIds: [] });
    await as.mutation(api.calendarEvents.create, { companyId, kind: "appointment", title: "Doctor", notes: "Private", location: "Clinic", startsAt: JOB_START + 2 * HOUR, endsAt: JOB_START + 3 * HOUR, memberIds: [ownerId], cleanerIds: [], private: true });
    // Each change asked for a sync at once; changes in the same minute share one.
    const queued = await t.run((ctx) => ctx.db.query("googleJobs").collect());
    expect(queued.filter((job) => job.key.startsWith("calendar_sync:soon:"))).toHaveLength(1);

    const bodies: { method: string; body: { summary?: string; description?: string; location?: string } }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "a", expires_in: 3600 }), { status: 200 });
        if (url.includes("/events") && method !== "GET") bodies.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });
        return new Response(JSON.stringify(url.includes("/events") && method === "GET" ? { items: [] } : { id: "x" }), { status: 200 });
      }),
    );
    expect((await sync(t, companyId, connectionId)).written).toBe(2);
    const written = bodies.map((row) => row.body);
    expect(written).toContainEqual(expect.objectContaining({ summary: "Weekly ops", location: "Office" }));
    expect(written.find((row) => row.description?.includes("Budget review"))).toBeDefined();
    // The private one: only "Busy", nothing of what it is.
    const busy = written.find((row) => row.summary === "Busy")!;
    expect(busy.location).toBeUndefined();
    expect(JSON.stringify(busy)).not.toMatch(/Doctor|Clinic|Private/);

    // Cancelled in Selestial: removed from Google on the next sync, and the event itself is kept in Selestial.
    await as.mutation(api.calendarEvents.cancel, { companyId, eventId: meetingId, expectedRevision: 1, reason: "Not needed." });
    bodies.length = 0;
    await sync(t, companyId, connectionId);
    expect(bodies.some((row) => row.method === "DELETE")).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(meetingId)))?.status).toBe("cancelled");
  });

  it("takes an interview whose time was cancelled, and a visit moved past the horizon, off the calendar, and keeps past ones", async () => {
    const { isStale } = await import("./googleCalendar");
    const now = NOW;
    const job = (fields: object) => ({ table: "jobs" as const, doc: { status: "scheduled", startsAt: now + HOUR, ...fields } as never });
    const interview = (status: string) => ({ table: "interviews" as const, doc: { status } as never });
    expect(isStale({ table: "jobs", id: "j" as never }, null, now)).toBe(true);
    expect(isStale({ table: "jobs", id: "j" as never }, job({}), now)).toBe(false);
    expect(isStale({ table: "jobs", id: "j" as never }, job({ status: "cancelled" }), now)).toBe(true);
    expect(isStale({ table: "jobs", id: "j" as never }, job({ startsAt: now + 61 * 24 * HOUR }), now)).toBe(true);
    expect(isStale({ table: "jobs", id: "j" as never }, job({ status: "completed", startsAt: now - 30 * 24 * HOUR }), now)).toBe(false);
    // cancelInterviewTime puts the interview back to "proposed": its old time comes off the calendar.
    expect(isStale({ table: "interviews", id: "i" as never }, interview("proposed"), now)).toBe(true);
    expect(isStale({ table: "interviews", id: "i" as never }, interview("confirmed"), now)).toBe(false);
    expect(isStale({ table: "interviews", id: "i" as never }, interview("completed"), now)).toBe(false);
  });

  it("takes Selestial's own events out of a busy block", () => {
    expect(subtract({ start: 0, end: 100 }, [{ startsAt: 20, endsAt: 40 }])).toEqual([{ start: 0, end: 20 }, { start: 40, end: 100 }]);
    expect(subtract({ start: 0, end: 100 }, [{ startsAt: 0, endsAt: 100 }])).toEqual([]);
    expect(subtract({ start: 0, end: 100 }, [{ startsAt: 200, endsAt: 300 }])).toEqual([{ start: 0, end: 100 }]);
  });

  async function withBusy(as: ReturnType<T["withIdentity"]>, companyId: Id<"companies">, calendarId: string, busy: { start: number; end: number }[]) {
    const connectionId = await connectCalendar(t, as, companyId);
    await t.run(async (ctx) => {
      const connection = (await ctx.db.get(connectionId))!;
      await ctx.db.insert("googleResources", { companyId, connectionId, kind: "calendar_busy", externalId: calendarId, label: "Personal", access: "verified", addedBy: connection.connectedBy, createdAt: Date.now() });
      await ctx.db.insert("googleBusy", { companyId, calendarId, from: NOW, to: NOW + 14 * 24 * HOUR, busy, fetchedAt: Date.now() });
    });
  }

  it("warns a person choosing a busy time without refusing it", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await withBusy(as, companyId, "me@alpha.test", [{ start: JOB_START, end: JOB_START + HOUR }]);
    const busy = await as.query(api.sales.capacity, { companyId, startsAt: JOB_START, minutes: 120, crew: 1 });
    expect(busy).toMatchObject({ calendarBusy: true, calendarNote: expect.stringContaining("busy") });
    expect(busy.blockers.join(" ")).not.toMatch(/calendar/i);
    const free = await as.query(api.sales.capacity, { companyId, startsAt: JOB_START + 3 * HOUR, minutes: 60, crew: 1 });
    expect(free).toMatchObject({ calendarBusy: false, calendarNote: null });
    // Visits a person scheduled over a busy time are listed on the calendar card.
    await seedVisit(as, companyId);
    expect((await as.query(api.googleCalendar.overBusy, { companyId })).map((row) => row.what)).toEqual(["visit"]);
  });

  it("does not offer applicants an interview time that is busy", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await withBusy(as, companyId, "me@alpha.test", [{ start: JOB_START, end: JOB_START + HOUR }]);
    const offered = await t.run(async (ctx) => {
      const owner = (await ctx.db.query("members").collect()).find((m) => m.companyId === companyId)!;
      await ctx.db.insert("interviewSlots", { companyId, interviewerId: owner._id, startsAt: JOB_START, endsAt: JOB_START + HOUR / 2, status: "open" });
      await ctx.db.insert("interviewSlots", { companyId, interviewerId: owner._id, startsAt: JOB_START + 2 * HOUR, endsAt: JOB_START + 2.5 * HOUR, status: "open" });
      return openSlots(ctx, companyId, Date.now());
    });
    expect(offered.map((slot) => slot.startsAt)).toEqual([JOB_START + 2 * HOUR]);
  });

  it("does not count Selestial's own visits as busy when the sync calendar is also chosen for busy times", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await withBusy(as, companyId, CAL, [{ start: JOB_START, end: JOB_END }]);
    await seedVisit(as, companyId);
    expect(await t.run((ctx) => calendarBusy(ctx, companyId, NOW, NOW + 3 * 24 * HOUR))).toEqual([]);
    expect(await as.query(api.googleCalendar.overBusy, { companyId })).toEqual([]);
  });

  it("is empty when Calendar is disconnected", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await withBusy(as, companyId, "me@alpha.test", [{ start: JOB_START, end: JOB_END }]);
    await as.mutation(api.google.disconnect, { companyId, feature: "calendar" });
    expect(await t.run((ctx) => calendarBusy(ctx, companyId, NOW, NOW + 3 * 24 * HOUR))).toEqual([]);
  });
});
