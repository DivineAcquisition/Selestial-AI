/**
 * Calendar's own records: meetings, manual appointments, a member's unavailable time, training sessions
 * and inspections (convex/lib/calendar/schema.ts), and members' weekly hours. Owners and Managers make
 * and change them, by the owner's decision of November 23, 2026; Office sees visits, not these.
 *
 * Every save checks the people it takes again (convex/lib/calendar/rules.ts). A hard conflict is refused
 * unless the person overrides it with a reason, which is kept on the record. Nothing is deleted:
 * cancelling keeps the event, who cancelled it and why.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { owned } from "./lib/access";
import { companyQuery, managerMutation, managerQuery, type MemberAccess } from "./lib/builders";
import { EVENT_KINDS, type EventKind } from "./lib/calendar/schema";
import { checkEvent, type Check } from "./lib/calendar/rules";
import { notFound, userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { recordRequirement } from "./lib/recruiter/handoff";
import { localInstant } from "./lib/sales/cadence";
import { literals } from "./lib/statuses";
import { optionalText, text } from "./lib/text";
import { clock, dayName } from "./lib/time";

type Ctx = (QueryCtx | MutationCtx) & MemberAccess;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const KIND_LABEL: Record<EventKind, string> = { meeting: "Meeting", appointment: "Appointment", unavailable: "Unavailable", training: "Training session", inspection: "Inspection" };

const eventInput = {
  kind: literals(EVENT_KINDS),
  title: v.optional(v.string()),
  notes: v.optional(v.string()),
  location: v.optional(v.string()),
  startsAt: v.number(),
  endsAt: v.number(),
  allDay: v.optional(v.object({ from: v.string(), through: v.string() })),
  private: v.optional(v.boolean()),
  memberIds: v.array(v.id("members")),
  cleanerIds: v.array(v.id("cleaners")),
  leadMemberId: v.optional(v.id("members")),
  leadCleanerId: v.optional(v.id("cleaners")),
  customerId: v.optional(v.id("customers")),
  propertyId: v.optional(v.id("properties")),
  jobId: v.optional(v.id("jobs")),
  qualityCaseId: v.optional(v.id("qualityCases")),
  handoffIds: v.optional(v.array(v.id("onboardingHandoffs"))),
};
type EventInput = {
  kind: EventKind;
  title?: string;
  notes?: string;
  location?: string;
  startsAt: number;
  endsAt: number;
  allDay?: { from: string; through: string };
  private?: boolean;
  memberIds: Id<"members">[];
  cleanerIds: Id<"cleaners">[];
  leadMemberId?: Id<"members">;
  leadCleanerId?: Id<"cleaners">;
  customerId?: Id<"customers">;
  propertyId?: Id<"properties">;
  jobId?: Id<"jobs">;
  qualityCaseId?: Id<"qualityCases">;
  handoffIds?: Id<"onboardingHandoffs">[];
};

/** Whether a cleaner leads a permanent crew today: the only cleaners who inspect. */
async function isLead(ctx: Ctx, cleanerId: Id<"cleaners">): Promise<boolean> {
  const now = Date.now();
  const rows = await ctx.db
    .query("crewMemberships")
    .withIndex("by_company_cleaner", (q) => q.eq("companyId", ctx.companyId).eq("cleanerId", cleanerId))
    .take(50);
  for (const row of rows) {
    if (row.role !== "lead" || row.from > now || (row.to !== undefined && row.to <= now)) continue;
    const crew = await ctx.db.get(row.crewId);
    if (crew && crew.status === "active" && crew.kind === "permanent") return true;
  }
  return false;
}

/** A quality case this person may see. A restricted case is the Owner's alone, and is "not found" to anyone else. */
async function readableCase(ctx: Ctx, caseId: Id<"qualityCases">): Promise<Doc<"qualityCases">> {
  const row = await owned(ctx, caseId);
  if (row.restricted && ctx.role !== "owner") notFound();
  return row;
}

/**
 * Checks an event's fields and the records it names, and fills in what follows from them: an inspection's
 * property comes from its visit or case, a training session's attendees include the new hires named.
 */
async function normalize(ctx: Ctx, input: EventInput) {
  const kind = input.kind;
  if (!Number.isSafeInteger(input.startsAt) || !Number.isSafeInteger(input.endsAt) || input.endsAt <= input.startsAt) throw userError("Choose an end after the start.");
  const longest = kind === "unavailable" ? 31 * DAY : DAY;
  if (input.endsAt - input.startsAt > longest) throw userError(kind === "unavailable" ? "Unavailable time can be at most 31 days at once." : "An event can be at most a day long.");
  if (input.startsAt > Date.now() + 400 * DAY) throw userError("Choose a time within the next year.");
  let { startsAt, endsAt } = input;
  if (input.allDay) {
    if (!DATE.test(input.allDay.from) || !DATE.test(input.allDay.through) || input.allDay.through < input.allDay.from) throw userError("Choose the days it covers.");
    startsAt = localInstant(input.allDay.from, 0, ctx.company.timezone);
    const after = new Date(Date.parse(`${input.allDay.through}T12:00:00Z`) + DAY).toISOString().slice(0, 10);
    endsAt = localInstant(after, 0, ctx.company.timezone);
  }

  const memberIds = [...new Set(input.memberIds)];
  for (const id of memberIds) {
    const member = await owned(ctx, id);
    if (member.status !== "active") throw userError(`${member.name} is not an active member.`);
  }
  const cleanerIds = [...new Set(input.cleanerIds)];
  for (const id of cleanerIds) {
    const cleaner = await owned(ctx, id);
    if (cleaner.status === "ended" || cleaner.status === "suspended") throw userError(`${cleaner.name} is not working with the company now.`);
  }
  if (input.leadMemberId) await owned(ctx, input.leadMemberId);
  if (input.leadCleanerId) await owned(ctx, input.leadCleanerId);
  if (input.customerId) await owned(ctx, input.customerId);

  let propertyId = input.propertyId;
  let customerId = input.customerId;
  if (propertyId) {
    const property = await owned(ctx, propertyId);
    customerId ??= property.customerId;
  }
  if (input.jobId) {
    const job = await owned(ctx, input.jobId);
    propertyId ??= job.propertyId;
    customerId ??= job.customerId;
  }
  if (input.qualityCaseId) {
    const row = await readableCase(ctx, input.qualityCaseId);
    propertyId ??= row.propertyId;
    customerId ??= row.customerId;
  }

  const handoffIds = [...new Set(input.handoffIds ?? [])];
  const attendees = new Set(cleanerIds);
  for (const id of handoffIds) {
    const handoff = await owned(ctx, id);
    if (handoff.status !== "open") throw userError("That new hire's onboarding is already closed.");
    attendees.add(handoff.cleanerId);
  }

  if (kind === "unavailable") {
    if (memberIds.length !== 1) throw userError("Choose the one person who is unavailable.");
    if (cleanerIds.length > 0) throw userError("A cleaner's time off is recorded on their record in Cleaners.");
  } else if (kind === "training") {
    if (!input.leadMemberId && !input.leadCleanerId) throw userError("Choose who leads the session.");
    if (attendees.size === 0) throw userError("Choose at least one new hire or cleaner to attend.");
  } else if (kind === "inspection") {
    const inspectors = memberIds.length + (input.leadCleanerId ? 1 : 0);
    if (inspectors !== 1) throw userError("Choose one inspector: an Owner, a Manager or a lead cleaner.");
    if (input.leadCleanerId && !(await isLead(ctx, input.leadCleanerId))) throw userError("Only a cleaner who leads a crew can inspect.");
    if (!propertyId) throw userError("Choose the visit, quality case or property to inspect.");
    if (cleanerIds.length > 0) throw userError("An inspection takes only its inspector.");
  } else if (memberIds.length === 0) {
    throw userError("Choose who it is for.");
  }

  const title = input.title?.trim() ? text(input.title, "The title", 120) : KIND_LABEL[kind];
  return {
    kind,
    title,
    notes: optionalText(input.notes, "The notes", 2000) || undefined,
    location: optionalText(input.location, "The place", 300) || undefined,
    startsAt,
    endsAt,
    ...(input.allDay ? { allDay: input.allDay } : {}),
    timezone: ctx.company.timezone,
    // Training and inspections are work others need to see; only meetings, appointments and time away can be private.
    private: kind === "training" || kind === "inspection" ? false : Boolean(input.private),
    memberIds,
    cleanerIds: [...attendees],
    ...(input.leadMemberId ? { leadMemberId: input.leadMemberId } : {}),
    ...(input.leadCleanerId ? { leadCleanerId: input.leadCleanerId } : {}),
    ...(customerId ? { customerId } : {}),
    ...(propertyId ? { propertyId } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.qualityCaseId ? { qualityCaseId: input.qualityCaseId } : {}),
    ...(handoffIds.length ? { handoffIds } : {}),
  };
}

type Normalized = Awaited<ReturnType<typeof normalize>>;

const scheduleWords = (row: { startsAt: number; endsAt: number }, timezone: string) => `${dayName(row.startsAt, timezone)} ${clock(row.startsAt, timezone)} to ${clock(row.endsAt, timezone)}`;

/** Refuses a hard conflict unless it is overridden with a reason; returns what to keep on the record. */
function settle(ctx: Ctx, check: Check, overrideReason: string | undefined) {
  if (check.hard.length === 0) return undefined;
  const reason = overrideReason?.trim();
  if (!reason) throw userError(`This can't be saved as it is: ${check.hard.join(" ")} Change the time or people, or give a reason to override.`);
  return { conflicts: check.hard, reason: text(reason, "The reason", 500), by: ctx.member._id, at: Date.now() };
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────────

/** What saving this would run into, for the form. The same check runs again inside the save. */
export const preview = managerQuery({
  args: { ...eventInput, eventId: v.optional(v.id("calendarEvents")) },
  handler: async (ctx, args) => {
    const { eventId, ...input } = args;
    let event: Normalized;
    try {
      event = await normalize(ctx, input);
    } catch (error) {
      const message = (error as { data?: { message?: string } }).data?.message;
      if (message) return { ready: false as const, problem: message, hard: [], warnings: [], notes: [] };
      throw error;
    }
    const check = await checkEvent(ctx, event, event, { ignore: eventId, kind: event.kind });
    return { ready: true as const, problem: null, ...check };
  },
});

/** One event, as the person asking may see it. Someone not on a private event gets only "Busy". */
export const get = companyQuery({
  args: { eventId: v.id("calendarEvents") },
  handler: async (ctx, args) => {
    if (ctx.role === "office") notFound();
    const row = await owned(ctx, args.eventId);
    const mine = row.memberIds.includes(ctx.member._id) || (row.createdBy.kind === "member" && row.createdBy.memberId === ctx.member._id);
    const name = async (id: Id<"members"> | Id<"cleaners">) => ((await ctx.db.get(id)) as { name?: string } | null)?.name ?? "Someone";
    const base = { eventId: row._id, kind: row.kind, status: row.status, startsAt: row.startsAt, endsAt: row.endsAt, allDay: row.allDay ?? null, timezone: row.timezone, revision: row.revision, private: row.private };
    if (row.private && !mine) return { ...base, visible: false as const, title: "Busy", members: await Promise.all(row.memberIds.map(async (id) => ({ id, name: await name(id) }))) };
    const caseRow = row.qualityCaseId ? await ctx.db.get(row.qualityCaseId) : null;
    const caseVisible = caseRow && (!caseRow.restricted || ctx.role === "owner");
    const handoffs = [];
    for (const id of row.handoffIds ?? []) {
      const handoff = await ctx.db.get(id);
      if (!handoff) continue;
      handoffs.push({ handoffId: id, cleanerId: handoff.cleanerId, name: await name(handoff.cleanerId), status: handoff.status, outstanding: handoff.requirements.filter((req) => req.status === "outstanding").map((req) => ({ key: req.key, label: req.label })) });
    }
    const history = await ctx.db
      .query("events")
      .withIndex("by_company_subject_at", (q) => q.eq("companyId", ctx.companyId).eq("subjectId", row._id))
      .order("desc")
      .take(30);
    const customer = row.customerId ? await ctx.db.get(row.customerId) : null;
    const property = row.propertyId ? await ctx.db.get(row.propertyId) : null;
    return {
      ...base,
      visible: true as const,
      title: row.title,
      notes: row.notes ?? null,
      location: row.location ?? null,
      members: await Promise.all(row.memberIds.map(async (id) => ({ id, name: await name(id) }))),
      cleaners: await Promise.all(row.cleanerIds.map(async (id) => ({ id, name: await name(id) }))),
      lead: row.leadMemberId ? { kind: "member" as const, id: row.leadMemberId, name: await name(row.leadMemberId) } : row.leadCleanerId ? { kind: "cleaner" as const, id: row.leadCleanerId, name: await name(row.leadCleanerId) } : null,
      customer: customer ? { id: customer._id, name: customer.name } : null,
      // The property by its label or street. Access instructions stay on the property.
      property: property ? { id: property._id, label: property.label ?? property.address.line1 } : null,
      jobId: row.jobId ?? null,
      qualityCase: caseVisible ? { id: caseRow._id, title: caseRow.title } : row.qualityCaseId ? { id: null, title: "A restricted quality case" } : null,
      handoffs,
      attendance: await Promise.all((row.attendance ?? []).map(async (entry) => ({ ...entry, name: await name(entry.cleanerId), byName: await name(entry.by) }))),
      inspection: row.inspection ? { ...row.inspection, byName: await name(row.inspection.by) } : null,
      override: row.override ? { ...row.override, byName: await name(row.override.by) } : null,
      cancelled: row.cancelled ?? null,
      history: await Promise.all(
        history.map(async (entry) => ({
          at: entry.at,
          type: entry.type,
          by: entry.actor.kind === "member" ? await name(entry.actor.memberId) : entry.actor.kind === "agent" ? `${entry.actor.agent} agent` : "Selestial",
          data: entry.data ?? null,
        })),
      ),
    };
  },
});

/** What the forms choose from: members, cleaners (with which lead a crew), open new-hire onboarding, open quality cases and recent visits. */
export const options = managerQuery({
  args: {},
  handler: async (ctx) => {
    const members = (await ctx.db.query("members").withIndex("by_company", (q) => q.eq("companyId", ctx.companyId)).take(200)).filter((row) => row.status === "active");
    const cleaners = (await ctx.db.query("cleaners").withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", "ready")).take(400)).concat(
      await ctx.db.query("cleaners").withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", "onboarding")).take(200),
    );
    const leads = new Set<string>();
    for (const row of cleaners) if (await isLead(ctx, row._id)) leads.add(row._id);
    const handoffs = [];
    for (const row of await ctx.db.query("onboardingHandoffs").withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", "open")).take(100)) {
      handoffs.push({ handoffId: row._id, cleanerId: row.cleanerId, name: (await ctx.db.get(row.cleanerId))?.name ?? "New hire", role: row.terms.role });
    }
    const cases = [];
    for (const stage of ["needs_context", "investigating", "needs_decision", "action_underway", "verifying"] as const) {
      const rows = await ctx.db
        .query("qualityCases")
        .withIndex("by_company_stage", (q) => q.eq("companyId", ctx.companyId).eq("stage", stage))
        .take(50);
      for (const row of rows) if (!row.restricted || ctx.role === "owner") cases.push({ caseId: row._id, title: row.title, propertyId: row.propertyId ?? null });
    }
    const now = Date.now();
    const recent = await ctx.db
      .query("jobs")
      .withIndex("by_company_start", (q) => q.eq("companyId", ctx.companyId).gte("startsAt", now - 30 * DAY).lt("startsAt", now + 14 * DAY))
      .take(300);
    const visits = [];
    for (const job of recent.filter((row) => row.status !== "cancelled").sort((a, b) => b.startsAt - a.startsAt).slice(0, 100)) {
      visits.push({ jobId: job._id, label: `${(await ctx.db.get(job.customerId))?.name ?? "Client"} · ${dayName(job.startsAt, ctx.company.timezone)} · ${job.serviceType}` });
    }
    return {
      timezone: ctx.company.timezone,
      me: ctx.member._id,
      members: members.map((row) => ({ id: row._id, name: row.name, role: row.role })),
      cleaners: cleaners.map((row) => ({ id: row._id, name: row.name, status: row.status, lead: leads.has(row._id) })),
      handoffs,
      cases,
      visits,
    };
  },
});

/** A member's weekly hours. Any member may read them; Owners and Managers set them. */
export const memberHours = managerQuery({
  args: { memberId: v.id("members") },
  handler: async (ctx, args) => {
    await owned(ctx, args.memberId);
    const rows = await ctx.db.query("memberHours").withIndex("by_company_member", (q) => q.eq("companyId", ctx.companyId).eq("memberId", args.memberId)).take(50);
    return rows.map((row) => ({ weekday: row.weekday, startMinute: row.startMinute, endMinute: row.endMinute })).sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  },
});

// ── Writes ──────────────────────────────────────────────────────────────────────────────────────────

export const create = managerMutation({
  args: { ...eventInput, overrideReason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { overrideReason, ...input } = args;
    const event = await normalize(ctx, input);
    const override = settle(ctx, await checkEvent(ctx, event, event, { kind: event.kind }), overrideReason);
    const now = Date.now();
    const eventId = await ctx.db.insert("calendarEvents", { companyId: ctx.companyId, ...event, status: "scheduled", ...(override ? { override } : {}), revision: 1, createdBy: byMember(ctx), createdAt: now, updatedAt: now });
    await recordEvent(ctx, {
      companyId: ctx.companyId,
      type: "calendar_event.created",
      actor: byMember(ctx),
      subject: { table: "calendarEvents", id: eventId },
      data: { kind: event.kind, startsAt: event.startsAt, endsAt: event.endsAt, overridden: Boolean(override), ...(override ? { reason: override.reason } : {}) },
    });
    return eventId;
  },
});

/** A change to an event, against the version the person was looking at. The old and new times are kept in its history. */
export const update = managerMutation({
  args: { ...eventInput, eventId: v.id("calendarEvents"), expectedRevision: v.number(), overrideReason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { eventId, expectedRevision, overrideReason, ...input } = args;
    const row = await owned(ctx, eventId);
    if (row.revision !== expectedRevision) throw userError("This event changed since you opened it. Look at it again, then make your change.");
    if (row.status !== "scheduled") throw userError(`This event is ${row.status}, so it can't be changed.`);
    if (input.kind !== row.kind) throw userError("An event's kind can't change. Cancel it and make a new one.");
    const event = await normalize(ctx, input);
    const override = settle(ctx, await checkEvent(ctx, event, event, { ignore: row._id, kind: event.kind }), overrideReason);
    await ctx.db.patch(row._id, { ...event, override, revision: row.revision + 1, updatedAt: Date.now() });
    const moved = row.startsAt !== event.startsAt || row.endsAt !== event.endsAt;
    await recordEvent(ctx, {
      companyId: ctx.companyId,
      type: moved ? "calendar_event.rescheduled" : "calendar_event.changed",
      actor: byMember(ctx),
      subject: { table: "calendarEvents", id: row._id },
      data: { from: scheduleWords(row, row.timezone), to: scheduleWords(event, event.timezone), overridden: Boolean(override), ...(override ? { reason: override.reason } : {}) },
    });
    return null;
  },
});

/** Cancels an event and keeps it, with who cancelled it and why. */
export const cancel = managerMutation({
  args: { eventId: v.id("calendarEvents"), expectedRevision: v.number(), reason: v.string() },
  handler: async (ctx, args) => {
    const row = await owned(ctx, args.eventId);
    if (row.revision !== args.expectedRevision) throw userError("This event changed since you opened it. Look at it again first.");
    if (row.status !== "scheduled") throw userError(`This event is already ${row.status}.`);
    const reason = text(args.reason, "The reason", 500);
    await ctx.db.patch(row._id, { status: "cancelled", cancelled: { reason, by: byMember(ctx), at: Date.now() }, revision: row.revision + 1, updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "calendar_event.cancelled", actor: byMember(ctx), subject: { table: "calendarEvents", id: row._id }, data: { reason } });
    return null;
  },
});

/**
 * Records whether one attendee came to a training session. Only when the person also names an onboarding
 * requirement is that requirement recorded as done, through Recruiter's own step, by this person.
 */
export const recordAttendance = managerMutation({
  args: { eventId: v.id("calendarEvents"), cleanerId: v.id("cleaners"), attended: v.boolean(), requirement: v.optional(v.object({ handoffId: v.id("onboardingHandoffs"), key: v.string() })) },
  handler: async (ctx, args) => {
    const row = await owned(ctx, args.eventId);
    if (row.kind !== "training") throw userError("Attendance is recorded for training sessions.");
    if (row.status === "cancelled") throw userError("This session was cancelled.");
    if (row.startsAt > Date.now()) throw userError("Attendance can be recorded once the session has started.");
    if (!row.cleanerIds.includes(args.cleanerId)) throw userError("That person was not invited to this session.");
    let requirementKey: string | undefined;
    if (args.requirement) {
      if (!args.attended) throw userError("Only attendance can count toward onboarding.");
      if (!(row.handoffIds ?? []).includes(args.requirement.handoffId)) throw userError("That onboarding is not linked to this session.");
      const handoff = await owned(ctx, args.requirement.handoffId);
      if (handoff.cleanerId !== args.cleanerId) throw userError("That onboarding belongs to someone else.");
      await recordRequirement(ctx, handoff, args.requirement.key, true, ctx.member, `Attended "${row.title}" on ${dayName(row.startsAt, row.timezone)}.`);
      requirementKey = args.requirement.key;
    }
    const attendance = [...(row.attendance ?? []).filter((entry) => entry.cleanerId !== args.cleanerId), { cleanerId: args.cleanerId, attended: args.attended, by: ctx.member._id, at: Date.now(), ...(requirementKey ? { requirementKey } : {}) }];
    const everyone = row.cleanerIds.every((id) => attendance.some((entry) => entry.cleanerId === id));
    await ctx.db.patch(row._id, { attendance, ...(everyone ? { status: "completed" as const } : {}), revision: row.revision + 1, updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "calendar_event.attendance_recorded", actor: byMember(ctx), subject: { table: "calendarEvents", id: row._id }, data: { cleanerId: args.cleanerId, attended: args.attended, requirement: requirementKey ?? null } });
    return null;
  },
});

/** What the inspector found, in their words. It completes the inspection; it is not a quality decision. */
export const recordInspection = managerMutation({
  args: { eventId: v.id("calendarEvents"), result: v.union(v.literal("no_issues"), v.literal("issues_found"), v.literal("not_done")), note: v.string() },
  handler: async (ctx, args) => {
    const row = await owned(ctx, args.eventId);
    if (row.kind !== "inspection") throw userError("Only an inspection has a result.");
    if (row.status === "cancelled") throw userError("This inspection was cancelled.");
    if (row.startsAt > Date.now()) throw userError("A result can be recorded once the inspection has started.");
    const note = args.result === "no_issues" ? (optionalText(args.note, "The note", 2000) ?? "") : text(args.note, "What was found", 2000);
    await ctx.db.patch(row._id, { inspection: { result: args.result, note, by: ctx.member._id, at: Date.now() }, status: "completed", revision: row.revision + 1, updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "calendar_event.inspection_recorded", actor: byMember(ctx), subject: { table: "calendarEvents", id: row._id }, data: { result: args.result, qualityCaseId: row.qualityCaseId ?? null } });
    return null;
  },
});

/** Replaces a member's weekly hours. None at all means "not set", which Calendar treats as no limit. */
export const setMemberHours = managerMutation({
  args: { memberId: v.id("members"), hours: v.array(v.object({ weekday: v.number(), startMinute: v.number(), endMinute: v.number() })) },
  handler: async (ctx, args) => {
    const member = await owned(ctx, args.memberId);
    if (member.status !== "active") throw userError("That person is not an active member.");
    if (args.hours.length > 21) throw userError("At most three stretches a day.");
    for (const row of args.hours) {
      if (!Number.isInteger(row.weekday) || row.weekday < 0 || row.weekday > 6 || !Number.isInteger(row.startMinute) || !Number.isInteger(row.endMinute) || row.startMinute < 0 || row.endMinute > 1440 || row.endMinute <= row.startMinute) throw userError("Each stretch needs a day, and an end after its start.");
    }
    const existing = await ctx.db.query("memberHours").withIndex("by_company_member", (q) => q.eq("companyId", ctx.companyId).eq("memberId", member._id)).take(50);
    for (const row of existing) await ctx.db.delete(row._id);
    for (const row of args.hours) await ctx.db.insert("memberHours", { companyId: ctx.companyId, memberId: member._id, ...row });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "member.hours_set", actor: byMember(ctx), subject: { table: "members", id: member._id }, data: { stretches: args.hours.length } });
    return null;
  },
});

