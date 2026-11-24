/**
 * Calendar's read (docs/calendar/00-architecture.md): the company's scheduled work for a date range,
 * from the records that hold it. Nothing is copied or stored here. Each item names its source record;
 * changes go through that record's own workflow.
 *
 * Access is applied before anything is returned: layers by role (LAYER_ROLES), and no pay, access
 * instructions, private notes, applicant details beyond a name, or restricted records, whatever the role.
 * Every source is read through a company-scoped index with a limit, and a source that reaches its limit
 * is reported, never cut silently.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { companyQuery, type MemberAccess } from "./lib/builders";
import { mayRead } from "./lib/agreements/access";
import { localParts } from "./lib/availability";
import { cleanerConflicts, type Away, type Commitment } from "./lib/calendar/conflicts";
import { byStart, DEFAULT_LAYERS, EVENT_ITEM_KIND, EVENT_STATUS_LABEL, INTERVIEW_LABEL, interviewTiming, KIND_LAYER, LAYERS, layersFor, MAX_RANGE_DAYS, overlaps, SOURCE_LIMIT, VISIT_STATE_LABEL, visitCategory, visitState, WALKTHROUGH_LABEL, type Item, type Kind, type Layer, type Resource } from "./lib/calendar/model";
import { projectSalesPlan, projectServicePlan } from "./lib/calendar/projections";
import { exceptionSpan } from "./lib/cleaners/schedule";
import { staffing } from "./lib/dispatch/crew";
import { arrivalEndsAt } from "./lib/dispatch/live";
import { dispatchSettings } from "./lib/dispatch/settings";
import { userError } from "./lib/errors";
import { literals } from "./lib/statuses";
import { calendarBusy } from "./lib/google/busy";
import { activeConnection } from "./lib/google/connection";
import { addDays, localInstant } from "./lib/sales/cadence";
import { versionsOf } from "./lib/sales/plans";
import { businessSettingsOf } from "./lib/settings/business";

type Ctx = QueryCtx & MemberAccess;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The longest one record can run. Reading from this far before the range finds one that started earlier. */
const LONGEST_VISIT = DAY;

const layerValidator = literals(LAYERS);

/** A cleaner's availability on their profile (src/lib/app/cleaners.ts). */
const availabilityPath = (cleanerId: string) => `/app/cleaners/${cleanerId}/availability`;

type Limit = { source: string; shown: number };

const dayOf = (at: number, timezone: string) => localParts(at, timezone).day;

/** Reads up to SOURCE_LIMIT rows and says whether there were more. */
async function bounded<T>(query: { take: (n: number) => Promise<T[]> }, source: string, limits: Limit[]): Promise<T[]> {
  const rows = await query.take(SOURCE_LIMIT + 1);
  if (rows.length > SOURCE_LIMIT) {
    limits.push({ source, shown: SOURCE_LIMIT });
    return rows.slice(0, SOURCE_LIMIT);
  }
  return rows;
}

/** Names read once per request. */
function cache<K extends string, V>(load: (id: K) => Promise<V>) {
  const held = new Map<string, Promise<V>>();
  return (id: K) => {
    if (!held.has(id)) held.set(id, load(id));
    return held.get(id)!;
  };
}

// ── Visits ──────────────────────────────────────────────────────────────────────────────────────────

async function visits(ctx: Ctx, from: number, to: number, limits: Limit[], names: { cleaner: (id: Id<"cleaners">) => Promise<string> }) {
  const jobs = (
    await bounded(
      ctx.db.query("jobs").withIndex("by_company_start", (q) => q.eq("companyId", ctx.companyId).gte("startsAt", from - LONGEST_VISIT).lt("startsAt", to)),
      "visits",
      limits,
    )
  ).filter((job) => overlaps(job, from, to));

  // A Sales plan's visit carries no planId on the job; its plan is found through planVisits.
  const salesPlanOf = new Map<string, Id<"recurringPlans">>();
  const fromDay = dayOf(from - DAY, ctx.company.timezone);
  const toDay = dayOf(to + DAY, ctx.company.timezone);
  for (const state of ["scheduled", "moved"] as const) {
    const rows = await ctx.db
      .query("planVisits")
      .withIndex("by_company_state", (q) => q.eq("companyId", ctx.companyId).eq("state", state).gte("date", fromDay).lte("date", toDay))
      .take(SOURCE_LIMIT * 2);
    for (const row of rows) if (row.jobId) salesPlanOf.set(row.jobId, row.planId);
  }

  const customers = cache((id: Id<"customers">) => ctx.db.get(id));
  const properties = cache((id: Id<"properties">) => ctx.db.get(id));
  const items: Item[] = [];
  const commitments = new Map<string, Commitment[]>();
  const bookedPlanDays = new Map<string, Set<string>>();

  for (const job of jobs) {
    if (job.planId && job.planDate) {
      const set = bookedPlanDays.get(job.planId) ?? new Set<string>();
      set.add(job.planDate);
      bookedPlanDays.set(job.planId, set);
    }
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_company_job", (q) => q.eq("companyId", ctx.companyId).eq("jobId", job._id))
      .take(200);
    const staff = staffing(job, assignments);
    const state = visitState(job, staff);
    const customer = await customers(job.customerId);
    const property = await properties(job.propertyId);
    const category = visitCategory({ planId: job.planId ?? salesPlanOf.get(job._id), recovery: job.recovery }, property?.kind ?? null);
    const resources: Resource[] = [];
    for (const row of assignments) {
      if (row.status !== "accepted" && row.status !== "offered") continue;
      resources.push({ kind: "cleaner", id: row.cleanerId, name: await names.cleaner(row.cleanerId), state: row.status === "accepted" ? "accepted" : "offered" });
      if (job.status !== "cancelled" && job.status !== "completed") {
        const list = commitments.get(row.cleanerId) ?? [];
        list.push({ key: `jobs:${job._id}`, startsAt: job.startsAt, endsAt: job.endsAt, held: row.status === "offered" });
        commitments.set(row.cleanerId, list);
      }
    }
    const problems: string[] = [];
    if (job.status === "scheduled" && staff.open > 0) problems.push(staff.accepted === 0 ? (staff.offersOut > 0 ? "No cleaner has accepted yet" : "Nobody is assigned") : `${staff.open} of ${staff.required} places still open`);
    if (job.hardDeadlineAt !== undefined && job.endsAt > job.hardDeadlineAt) problems.push("Ends after its deadline");
    const where = property ? (property.label ?? property.address.line1) : null;
    items.push({
      key: `jobs:${job._id}`,
      source: { table: "jobs", id: job._id },
      kind: job.recovery ? "correction_visit" : "visit",
      layer: "jobs",
      timing: "appointment",
      title: customer?.name ?? "Unknown client",
      detail: [job.serviceType, category.id === "one_time" ? null : category.label, where].filter(Boolean).join(" · ") || null,
      startsAt: job.startsAt,
      endsAt: job.endsAt,
      allDay: null,
      arrivalEndsAt: job.arrivalWindowMinutes ? arrivalEndsAt(job) : null,
      timezone: property?.timezone ?? ctx.company.timezone,
      status: state,
      statusLabel: `${VISIT_STATE_LABEL[state]}${staff.required > 1 && state !== "cancelled" ? ` · ${staff.accepted} of ${staff.required}` : ""}`,
      resources,
      customerId: job.customerId,
      propertyId: job.propertyId,
      agent: job.recovery ? "retention" : "dispatch",
      problems,
      href: null,
      version: job._creationTime + assignments.reduce((sum, row) => sum + (row.respondedAt ?? row.offeredAt), 0),
    });
  }
  return { items, commitments, bookedPlanDays, salesPlanOf };
}

// ── Recurring occurrences beyond the booking horizon ────────────────────────────────────────────────

async function projected(ctx: Ctx, from: number, to: number, booked: Map<string, Set<string>>, limits: Limit[]): Promise<Item[]> {
  const timezone = ctx.company.timezone;
  // Nothing is projected into the past or today: those days are booked or they are not.
  const fromDay = [dayOf(from, timezone), addDays(dayOf(Date.now(), timezone), 1)].sort().pop()!;
  const throughDay = dayOf(to - 1, timezone);
  if (fromDay > throughDay) return [];
  const out: Item[] = [];
  const customers = cache((id: Id<"customers">) => ctx.db.get(id));

  const servicePlans = await bounded(ctx.db.query("servicePlans").withIndex("by_company_state", (q) => q.eq("companyId", ctx.companyId).eq("state", "active")), "recurring plans (Clients)", limits);
  for (const plan of servicePlans) {
    const service = await ctx.db.get(plan.serviceId);
    for (const row of projectServicePlan(plan, fromDay, throughDay, timezone, booked.get(plan._id) ?? new Set())) {
      out.push({
        key: `servicePlans:${plan._id}:${row.date}`,
        source: { table: "servicePlans", id: plan._id },
        kind: "projected_visit",
        layer: "jobs",
        timing: "projected",
        title: (await customers(plan.customerId))?.name ?? "Unknown client",
        detail: [service?.name ?? null, "Recurring · not booked yet"].filter(Boolean).join(" · "),
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        allDay: null,
        arrivalEndsAt: row.arrivalEndsAt,
        timezone,
        status: "projected",
        statusLabel: "Projected · books automatically nearer the day",
        resources: [],
        customerId: plan.customerId,
        propertyId: plan.propertyId,
        agent: "dispatch",
        problems: [],
        href: `/app/clients/${plan.customerId}/services`,
        version: plan.revision,
      });
    }
  }

  const hours = businessSettingsOf(ctx.company).hours;
  const closed = new Set(hours.length ? [0, 1, 2, 3, 4, 5, 6].filter((day) => !hours.some((h) => h.weekday === day)) : []);
  const salesPlans = await bounded(ctx.db.query("recurringPlans").withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", "active")), "recurring plans (Sales)", limits);
  for (const plan of salesPlans) {
    const versions = await versionsOf(ctx, plan._id);
    const existing = await ctx.db
      .query("planVisits")
      .withIndex("by_plan_date", (q) => q.eq("planId", plan._id).gte("date", fromDay).lte("date", throughDay))
      .take(400);
    const days = new Set(existing.filter((row) => !(row.state === "cancelled" && row.exception?.startsWith("Replaced"))).map((row) => row.date));
    for (const row of projectSalesPlan(plan, versions, fromDay, throughDay, closed, days)) {
      out.push({
        key: `recurringPlans:${plan._id}:${row.date}`,
        source: { table: "recurringPlans", id: plan._id },
        kind: "projected_visit",
        layer: "jobs",
        timing: "projected",
        title: (await customers(plan.customerId))?.name ?? "Unknown client",
        detail: "Recurring · not booked yet",
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        allDay: null,
        arrivalEndsAt: row.arrivalEndsAt,
        timezone: plan.timezone,
        status: "projected",
        statusLabel: "Projected · books automatically nearer the day",
        resources: [],
        customerId: plan.customerId,
        propertyId: plan.propertyId,
        agent: "dispatch",
        problems: [],
        href: `/app/agents/sales/plans/${plan._id}`,
        version: plan.updatedAt,
      });
    }
  }
  return out.filter((item) => overlaps(item, from, to));
}

// ── Hiring ──────────────────────────────────────────────────────────────────────────────────────────

async function hiring(ctx: Ctx, from: number, to: number, limits: Limit[], member: (id: Id<"members">) => Promise<string>): Promise<Item[]> {
  const out: Item[] = [];
  const interviews = await bounded(
    ctx.db.query("interviews").withIndex("by_company_start", (q) => q.eq("companyId", ctx.companyId).gte("startsAt", from - 12 * HOUR).lt("startsAt", to)),
    "interviews",
    limits,
  );
  for (const interview of interviews) {
    if (interview.startsAt === undefined || interview.endsAt === undefined || !overlaps({ startsAt: interview.startsAt, endsAt: interview.endsAt }, from, to)) continue;
    const application = await ctx.db.get(interview.applicationId);
    const applicant = application ? await ctx.db.get(application.applicantId) : null;
    const resources: Resource[] = interview.interviewerId ? [{ kind: "member", id: interview.interviewerId, name: await member(interview.interviewerId), state: "assigned" }] : [];
    out.push({
      key: `interviews:${interview._id}`,
      source: { table: "interviews", id: interview._id },
      kind: "interview",
      layer: "hiring",
      timing: interviewTiming(interview.status),
      // A name and nothing else from the application: screening notes and documents stay in Recruiter.
      title: applicant?.name ? `Interview · ${applicant.name}` : "Interview",
      detail: interview.how ?? null,
      startsAt: interview.startsAt,
      endsAt: interview.endsAt,
      allDay: null,
      arrivalEndsAt: null,
      timezone: ctx.company.timezone,
      status: interview.status,
      statusLabel: INTERVIEW_LABEL[interview.status],
      resources,
      customerId: null,
      propertyId: null,
      agent: "recruiter",
      problems: interview.status === "confirmed" && !interview.interviewerId ? ["No interviewer"] : [],
      href: "/app/agents/recruiter/interviews",
      version: interview.reschedules,
    });
  }
  const slots = await bounded(
    ctx.db.query("interviewSlots").withIndex("by_company_start", (q) => q.eq("companyId", ctx.companyId).gte("startsAt", from - 12 * HOUR).lt("startsAt", to)),
    "interview times",
    limits,
  );
  for (const slot of slots) {
    if (slot.status !== "open" || !overlaps(slot, from, to)) continue;
    out.push({
      key: `interviewSlots:${slot._id}`,
      source: { table: "interviewSlots", id: slot._id },
      kind: "interview_slot",
      layer: "hiring",
      timing: "availability",
      title: "Open interview time",
      detail: null,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      allDay: null,
      arrivalEndsAt: null,
      timezone: ctx.company.timezone,
      status: "open",
      statusLabel: "Free for an interview · not booked",
      resources: [{ kind: "member", id: slot.interviewerId, name: await member(slot.interviewerId), state: "assigned" }],
      customerId: null,
      propertyId: null,
      agent: "recruiter",
      problems: [],
      href: "/app/agents/recruiter/interviews",
      version: slot._creationTime,
    });
  }
  return out;
}

// ── Sales ───────────────────────────────────────────────────────────────────────────────────────────

async function walkthroughs(ctx: Ctx, from: number, to: number, limits: Limit[], member: (id: Id<"members">) => Promise<string>): Promise<Item[]> {
  const rows = await bounded(
    ctx.db.query("assessments").withIndex("by_company_scheduled", (q) => q.eq("companyId", ctx.companyId).gte("scheduledAt", from - 12 * HOUR).lt("scheduledAt", to)),
    "walkthroughs",
    limits,
  );
  const out: Item[] = [];
  for (const row of rows) {
    if (row.scheduledAt === undefined) continue;
    const span = { startsAt: row.scheduledAt, endsAt: row.scheduledAt + row.durationMinutes * MINUTE };
    if (!overlaps(span, from, to)) continue;
    const customer = await ctx.db.get(row.customerId);
    const property = await ctx.db.get(row.propertyId);
    out.push({
      key: `assessments:${row._id}`,
      source: { table: "assessments", id: row._id },
      kind: "walkthrough",
      layer: "sales",
      timing: "appointment",
      title: `Walkthrough · ${customer?.name ?? "Unknown client"}`,
      detail: property ? (property.label ?? property.address.line1) : null,
      ...span,
      allDay: null,
      arrivalEndsAt: null,
      timezone: property?.timezone ?? ctx.company.timezone,
      status: row.status,
      statusLabel: WALKTHROUGH_LABEL[row.status],
      resources: row.assessorMemberId ? [{ kind: "member", id: row.assessorMemberId, name: await member(row.assessorMemberId), state: "assigned" }] : [],
      customerId: row.customerId,
      propertyId: row.propertyId,
      agent: "sales",
      problems: row.status === "scheduled" && !row.assessorMemberId ? ["Nobody is going yet"] : [],
      href: row.draftId ? `/app/agents/sales/book/${row.draftId}?from=calendar` : `/app/clients/${row.customerId}`,
      version: row.updatedAt,
    });
  }
  return out;
}

// ── Availability ────────────────────────────────────────────────────────────────────────────────────

async function away(ctx: Ctx, from: number, to: number, limits: Limit[], cleaner: (id: Id<"cleaners">) => Promise<string>, manager: boolean) {
  const items: Item[] = [];
  const byCleaner = new Map<string, Away[]>();
  const note = (id: string, entry: Away) => byCleaner.set(id, [...(byCleaner.get(id) ?? []), entry]);
  const timeOff = await bounded(ctx.db.query("timeOff").withIndex("by_company_end", (q) => q.eq("companyId", ctx.companyId).gt("endsAt", from)), "time off", limits);
  for (const row of timeOff) {
    if (row.startsAt >= to) continue;
    note(row.cleanerId, { startsAt: row.startsAt, endsAt: row.endsAt, label: "their time off" });
    const name = await cleaner(row.cleanerId);
    items.push({
      key: `timeOff:${row._id}`,
      source: { table: "timeOff", id: row._id },
      kind: "time_off",
      layer: "availability",
      timing: "availability",
      title: `${name} · time off`,
      // The reason someone gave is for Owners and Managers.
      detail: manager ? (row.note ?? null) : null,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      allDay: null,
      arrivalEndsAt: null,
      timezone: ctx.company.timezone,
      status: "away",
      statusLabel: "Not available",
      resources: [{ kind: "cleaner", id: row.cleanerId, name, state: "away" }],
      customerId: null,
      propertyId: null,
      agent: null,
      problems: [],
      href: availabilityPath(row.cleanerId),
      version: row.createdAt ?? row._creationTime,
    });
  }
  const fromDay = dayOf(from, ctx.company.timezone);
  const toDay = dayOf(to - 1, ctx.company.timezone);
  const exceptions = await bounded(
    ctx.db.query("availabilityExceptions").withIndex("by_company_date", (q) => q.eq("companyId", ctx.companyId).gte("date", fromDay).lte("date", toDay)),
    "availability changes",
    limits,
  );
  for (const row of exceptions) {
    if (row.kind !== "unavailable") continue;
    const span = exceptionSpan(row, ctx.company.timezone);
    note(row.cleanerId, { ...span, label: "a day they marked unavailable" });
    const name = await cleaner(row.cleanerId);
    const whole = row.startMinute === undefined;
    items.push({
      key: `availabilityExceptions:${row._id}`,
      source: { table: "availabilityExceptions", id: row._id },
      kind: "unavailable",
      layer: "availability",
      timing: "availability",
      title: `${name} · unavailable`,
      detail: manager ? (row.note ?? null) : null,
      ...span,
      allDay: whole ? row.date : null,
      arrivalEndsAt: null,
      timezone: ctx.company.timezone,
      status: "away",
      statusLabel: whole ? "Unavailable all day" : "Unavailable",
      resources: [{ kind: "cleaner", id: row.cleanerId, name, state: "away" }],
      customerId: null,
      propertyId: null,
      agent: null,
      problems: [],
      href: availabilityPath(row.cleanerId),
      version: row._creationTime,
    });
  }
  return { items, byCleaner };
}

// ── Deadlines ───────────────────────────────────────────────────────────────────────────────────────

async function deadlines(ctx: Ctx, from: number, to: number, limits: Limit[], manager: boolean): Promise<Item[]> {
  const out: Item[] = [];
  for (const status of ["open", "waiting", "needs_decision"] as const) {
    const tasks = await bounded(
      ctx.db.query("tasks").withIndex("by_company_status_due", (q) => q.eq("companyId", ctx.companyId).eq("status", status).gte("dueAt", from).lt("dueAt", to)),
      `tasks (${status.replace("_", " ")})`,
      limits,
    );
    for (const task of tasks) {
      // Office works Dispatch's queue; other agents' work is for Owners and Managers.
      if (!manager && task.agent !== "dispatch") continue;
      out.push({
        key: `tasks:${task._id}`,
        source: { table: "tasks", id: task._id },
        kind: "task_due",
        layer: "deadlines",
        timing: "due",
        title: task.title,
        detail: status === "needs_decision" ? (task.openQuestion ?? null) : (task.nextAction ?? null),
        startsAt: task.dueAt,
        endsAt: task.dueAt,
        allDay: null,
        arrivalEndsAt: null,
        timezone: ctx.company.timezone,
        status,
        statusLabel: status === "needs_decision" ? "Due · needs a decision" : status === "waiting" ? "Due · waiting on someone" : "Due",
        resources: [],
        customerId: task.about?.table === "customers" ? task.about.id : null,
        propertyId: task.about?.table === "properties" ? task.about.id : null,
        agent: task.agent,
        problems: [],
        href: null,
        version: task._creationTime,
      });
    }
  }
  if (manager) {
    const fromDay = dayOf(from, ctx.company.timezone);
    const toDay = dayOf(to - 1, ctx.company.timezone);
    const agreements = await bounded(
      ctx.db.query("agreements").withIndex("by_company_renewal", (q) => q.eq("companyId", ctx.companyId).gte("lifecycle.renewalOn", fromDay).lte("lifecycle.renewalOn", toDay)),
      "agreement renewals",
      limits,
    );
    for (const agreement of agreements) {
      const date = agreement.lifecycle?.renewalOn;
      // Each agreement is shown only to someone who may read it (workforce and pay documents are narrower).
      if (!date || !mayRead(ctx.role, agreement.access)) continue;
      const start = dayStartOf(date, ctx.company.timezone);
      out.push({
        key: `agreements:${agreement._id}`,
        source: { table: "agreements", id: agreement._id },
        kind: "renewal_due",
        layer: "deadlines",
        timing: "due",
        title: `Renewal · ${agreement.title}`,
        detail: null,
        startsAt: start,
        endsAt: start,
        allDay: date,
        arrivalEndsAt: null,
        timezone: ctx.company.timezone,
        status: "renewal",
        statusLabel: "Renews this day",
        resources: [],
        customerId: null,
        propertyId: null,
        agent: null,
        problems: [],
        href: `/app/agreements/${agreement._id}`,
        version: agreement._creationTime,
      });
    }
  }
  return out;
}

/** Midnight at the start of a company-calendar date. */
const dayStartOf = (date: string, timezone: string) => localInstant(date, 0, timezone);

// ── Calendar's own events ───────────────────────────────────────────────────────────────────────────

/**
 * Meetings, appointments, members' time away, training and inspections. A private event shows as "Busy"
 * to anyone who is not on it and did not make it: its title, notes and place are not returned.
 * Cleaners' time in these events counts against them, so a visit that overlaps a training is flagged.
 */
async function ownEvents(ctx: Ctx, from: number, to: number, limits: Limit[], member: (id: Id<"members">) => Promise<string>, cleaner: (id: Id<"cleaners">) => Promise<string>) {
  const rows = (
    await bounded(
      ctx.db.query("calendarEvents").withIndex("by_company_start", (q) => q.eq("companyId", ctx.companyId).gte("startsAt", from - 32 * DAY).lt("startsAt", to)),
      "calendar events",
      limits,
    )
  ).filter((row) => overlaps(row, from, to));
  const items: Item[] = [];
  const cleanerTime = new Map<string, Away[]>();
  for (const row of rows) {
    if (row.status !== "cancelled") {
      for (const id of [...row.cleanerIds, ...(row.leadCleanerId ? [row.leadCleanerId] : [])]) {
        cleanerTime.set(id, [...(cleanerTime.get(id) ?? []), { startsAt: row.startsAt, endsAt: row.endsAt, label: row.kind === "training" ? "a training session" : row.kind === "inspection" ? "an inspection" : "another event" }]);
      }
    }
    const mine = row.memberIds.includes(ctx.member._id) || (row.createdBy.kind === "member" && row.createdBy.memberId === ctx.member._id);
    const hidden = row.private && !mine;
    const resources: Resource[] = [];
    for (const id of row.memberIds) resources.push({ kind: "member", id, name: await member(id), state: row.kind === "unavailable" ? "away" : "assigned" });
    if (row.leadMemberId && !row.memberIds.includes(row.leadMemberId)) resources.push({ kind: "member", id: row.leadMemberId, name: await member(row.leadMemberId), state: "assigned" });
    if (!hidden) for (const id of [...(row.leadCleanerId ? [row.leadCleanerId] : []), ...row.cleanerIds]) resources.push({ kind: "cleaner", id, name: await cleaner(id), state: "assigned" });
    const kind = EVENT_ITEM_KIND[row.kind];
    const problems: string[] = [];
    if (row.status === "scheduled" && row.kind === "inspection" && row.endsAt < Date.now() && !row.inspection) problems.push("No result recorded yet");
    if (row.status === "scheduled" && row.kind === "training" && row.endsAt < Date.now() && (row.attendance ?? []).length < row.cleanerIds.length) problems.push("Attendance not recorded yet");
    if (row.override && row.status === "scheduled") problems.push(`Saved over a conflict: ${row.override.reason}`);
    items.push({
      key: `calendarEvents:${row._id}`,
      source: { table: "calendarEvents", id: row._id },
      kind,
      layer: KIND_LAYER[kind],
      timing: row.kind === "unavailable" ? "availability" : "appointment",
      title: hidden ? "Busy" : row.kind === "unavailable" ? `${resources[0]?.name ?? "Someone"} · ${row.title === "Unavailable" ? "unavailable" : row.title}` : row.title,
      detail: hidden ? null : (row.location ?? null),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      allDay: row.allDay && row.allDay.from === row.allDay.through ? row.allDay.from : null,
      arrivalEndsAt: null,
      timezone: row.timezone,
      status: row.status === "scheduled" ? row.kind : row.status,
      statusLabel: hidden ? "Busy · private" : row.kind === "inspection" && row.inspection ? (row.inspection.result === "no_issues" ? "Inspected · no issues" : row.inspection.result === "issues_found" ? "Inspected · issues found" : "Not done") : EVENT_STATUS_LABEL[row.status],
      resources,
      customerId: hidden ? null : (row.customerId ?? null),
      propertyId: hidden ? null : (row.propertyId ?? null),
      agent: row.kind === "training" ? "recruiter" : row.kind === "inspection" ? "quality" : null,
      problems: hidden ? [] : problems,
      href: null,
      version: row.revision,
    });
  }
  return { items, cleanerTime };
}

// ── External busy time ──────────────────────────────────────────────────────────────────────────────

async function external(ctx: Ctx, from: number, to: number) {
  const connection = await activeConnection(ctx, ctx.companyId, "calendar");
  const state = !connection ? "not_connected" : connection.status === "expired" ? "reconnect" : "connected";
  const busy = state === "connected" ? await calendarBusy(ctx, ctx.companyId, from, to) : [];
  const rows = state === "connected" ? await ctx.db.query("googleBusy").withIndex("by_company_calendar", (q) => q.eq("companyId", ctx.companyId)).take(20) : [];
  const items: Item[] = busy.map((block) => ({
    key: `googleBusy:${block.start}:${block.end}`,
    source: { table: "googleBusy", id: "" },
    kind: "external_busy" as const,
    layer: "external" as const,
    timing: "availability" as const,
    // Free/busy is all Selestial is allowed to read from these calendars, so "Busy" is all it can say.
    title: "Busy",
    detail: "Connected calendar",
    startsAt: block.start,
    endsAt: block.end,
    allDay: null,
    arrivalEndsAt: null,
    timezone: ctx.company.timezone,
    status: "busy",
    statusLabel: "Busy on a connected calendar",
    resources: [],
    customerId: null,
    propertyId: null,
    agent: null,
    problems: [],
    href: null,
    version: 0,
  }));
  return {
    items,
    status: {
      state,
      email: connection?.email ?? null,
      problem: connection?.problem ?? rows.find((row) => row.problem)?.problem ?? null,
      fetchedAt: rows.length ? Math.min(...rows.map((row) => row.fetchedAt)) : null,
    },
  };
}

// ── The read ────────────────────────────────────────────────────────────────────────────────────────

export const range = companyQuery({
  args: { from: v.number(), to: v.number(), layers: v.optional(v.array(layerValidator)) },
  handler: async (ctx, args) => readCalendar(ctx, args),
});

/**
 * The read itself, shared by the page and Company Chat's calendar tools, so both answer from the same
 * records with the same access: the person asking, with their role.
 */
export async function readCalendar(ctx: Ctx, args: { from: number; to: number; layers?: Layer[] }) {
  {
    if (!Number.isFinite(args.from) || !Number.isFinite(args.to) || args.to <= args.from) throw userError("Choose a range that ends after it starts.");
    if (args.to - args.from > MAX_RANGE_DAYS * DAY + 2 * HOUR) throw userError(`Calendar shows at most ${MAX_RANGE_DAYS} days at a time.`);
    const manager = ctx.role === "owner" || ctx.role === "manager";
    const allowed = layersFor(ctx.role);
    const wanted = new Set<Layer>((args.layers ?? DEFAULT_LAYERS).filter((layer) => allowed.includes(layer)));
    const limits: Limit[] = [];
    const cleaner = cache(async (id: Id<"cleaners">) => (await ctx.db.get(id))?.name ?? "A cleaner");
    const member = cache(async (id: Id<"members">) => (await ctx.db.get(id))?.name ?? "A member");

    let items: Item[] = [];
    // Calendar's own events are for Owners and Managers; a cleaner's time in them still counts in their conflicts for everyone.
    const own = await ownEvents(ctx, args.from, args.to, limits, member, cleaner);
    // Visits are read whenever availability is shown too: a cleaner's conflicts need both.
    const jobs = wanted.has("jobs") || wanted.has("availability") ? await visits(ctx, args.from, args.to, limits, { cleaner }) : null;
    const absent = wanted.has("jobs") || wanted.has("availability") ? await away(ctx, args.from, args.to, limits, cleaner, manager) : null;
    if (jobs && absent) {
      // Each cleaner's own commitments against their own hours and time off: one person's problem never marks another's visit.
      const windows = new Map<string, Doc<"availabilityWindows">[]>();
      const buffer = dispatchSettings(ctx.company).travelBufferMinutes;
      const byKey = new Map(jobs.items.map((item) => [item.key, item]));
      for (const [cleanerId, list] of jobs.commitments) {
        if (!windows.has(cleanerId)) {
          windows.set(cleanerId, await ctx.db.query("availabilityWindows").withIndex("by_company_cleaner", (q) => q.eq("companyId", ctx.companyId).eq("cleanerId", cleanerId as Id<"cleaners">)).take(100));
        }
        const found = cleanerConflicts({ commitments: list, windows: windows.get(cleanerId)!, away: [...(absent.byCleaner.get(cleanerId) ?? []), ...(own.cleanerTime.get(cleanerId) ?? [])], bufferMinutes: buffer, timezone: ctx.company.timezone });
        const name = await cleaner(cleanerId as Id<"cleaners">);
        for (const [key, problems] of found) {
          const item = byKey.get(key);
          if (item) for (const words of problems) item.problems.push(`${name}: ${words}`);
        }
      }
    }
    if (wanted.has("jobs") && jobs) items.push(...jobs.items, ...(await projected(ctx, args.from, args.to, jobs.bookedPlanDays, limits)));
    if (wanted.has("availability") && absent) items.push(...absent.items);
    if (wanted.has("hiring")) items.push(...(await hiring(ctx, args.from, args.to, limits, member)));
    if (wanted.has("sales")) items.push(...(await walkthroughs(ctx, args.from, args.to, limits, member)));
    if (wanted.has("deadlines")) items.push(...(await deadlines(ctx, args.from, args.to, limits, manager)));
    if (manager) items.push(...own.items);
    const outside = allowed.includes("external") ? await external(ctx, args.from, wanted.has("external") ? args.to : args.from) : null;
    if (outside && wanted.has("external")) items.push(...outside.items);

    // A layer nobody may see is never in the answer, however it was asked for.
    items = items.filter((item) => wanted.has(item.layer) && allowed.includes(KIND_LAYER[item.kind as Kind]));
    items.sort(byStart);
    const customerName = cache(async (id: string) => (await ctx.db.get(id as Id<"customers">))?.name ?? null);
    for (const item of items) item.customerName = item.customerId ? await customerName(item.customerId) : null;
    const waiting = await waitingWork(ctx, items, manager);

    const cleaners = await ctx.db
      .query("cleaners")
      .withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", "ready"))
      .take(SOURCE_LIMIT);
    const resources = {
      cleaners: await Promise.all(
        cleaners.map(async (row) => ({
          id: row._id,
          name: row.name,
          windows: (await ctx.db.query("availabilityWindows").withIndex("by_company_cleaner", (q) => q.eq("companyId", ctx.companyId).eq("cleanerId", row._id)).take(100)).map((window) => ({ weekday: window.weekday, startMinute: window.startMinute, endMinute: window.endMinute })),
        })),
      ),
      cleanersLimited: cleaners.length === SOURCE_LIMIT,
      crews: await crews(ctx),
      // Members and their weekly hours, for Owners and Managers. Hours none have set are an empty list, not "never".
      members: manager
        ? await Promise.all(
            (await ctx.db.query("members").withIndex("by_company", (q) => q.eq("companyId", ctx.companyId)).take(200))
              .filter((row) => row.status === "active")
              .map(async (row) => ({
                id: row._id,
                name: row.name,
                role: row.role,
                windows: (await ctx.db.query("memberHours").withIndex("by_company_member", (q) => q.eq("companyId", ctx.companyId).eq("memberId", row._id)).take(50)).map((window) => ({ weekday: window.weekday, startMinute: window.startMinute, endMinute: window.endMinute })),
              })),
          )
        : [],
    };

    return {
      timezone: ctx.company.timezone,
      role: ctx.role,
      layers: allowed,
      shown: [...wanted],
      items,
      resources,
      limits,
      external: outside?.status ?? null,
      waiting,
      bufferMinutes: dispatchSettings(ctx.company).travelBufferMinutes,
      asOf: Date.now(),
    };
  }
}

/**
 * Work that needs a time or a decision, for Needs attention: changes made in the connected calendar
 * (attached to the item they are about when it is in view), applicants waiting for an interview time, and
 * approved corrections no visit has been booked for yet. Each comes with the record it is about.
 */
async function waitingWork(ctx: Ctx, items: Item[], manager: boolean) {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const googleChanges: { linkId: string; what: "visit" | "interview" | "event"; change: string; key: string; title: string | null }[] = [];
  const links = await ctx.db.query("googleCalendarLinks").withIndex("by_company_subject", (q) => q.eq("companyId", ctx.companyId)).take(2000);
  for (const link of links) {
    if (!link.externalChange) continue;
    // Office sees changes to visits only, as everywhere else.
    if (!manager && link.subject.table !== "jobs") continue;
    const key = `${link.subject.table}:${link.subjectId}`;
    const item = byKey.get(key);
    const change = { linkId: link._id, change: link.externalChange, startsAt: link.externalTimes?.startsAt ?? null, endsAt: link.externalTimes?.endsAt ?? null };
    if (item) {
      item.googleChange = change;
      item.problems.push(link.externalChange === "deleted" ? "Deleted in Google Calendar; Selestial did not change it" : link.externalChange === "moved" ? "Moved in Google Calendar; Selestial did not change it" : "Edited in Google Calendar");
    }
    googleChanges.push({ linkId: link._id, what: link.subject.table === "jobs" ? "visit" : link.subject.table === "interviews" ? "interview" : "event", change: link.externalChange, key, title: item?.title ?? null });
    if (googleChanges.length >= 50) break;
  }
  if (!manager) return { googleChanges, interviews: [], corrections: [] };
  const interviews = [];
  for (const status of ["awaiting_slots", "proposed"] as const) {
    for (const row of await ctx.db.query("interviews").withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", status)).take(25)) {
      const application = await ctx.db.get(row.applicationId);
      const applicant = application ? await ctx.db.get(application.applicantId) : null;
      interviews.push({ interviewId: row._id, applicant: applicant?.name ?? "An applicant", status });
    }
  }
  const corrections = [];
  for (const row of await ctx.db.query("qualityCorrections").withIndex("by_company_state", (q) => q.eq("companyId", ctx.companyId).eq("state", "approved")).take(50)) {
    if (row.correctionJobId) continue;
    const kase = await ctx.db.get(row.caseId);
    // A restricted case is the Owner's alone.
    if (!kase || (kase.restricted && ctx.role !== "owner")) continue;
    corrections.push({ correctionId: row._id, title: kase.title, by: row.timeSensitive?.by ?? null });
  }
  return { googleChanges, interviews, corrections };
}

async function crews(ctx: Ctx) {
  const rows = await ctx.db
    .query("crews")
    .withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", "active"))
    .take(100);
  const now = Date.now();
  const out = [];
  for (const crew of rows.filter((row) => row.kind === "permanent")) {
    const members = await ctx.db
      .query("crewMemberships")
      .withIndex("by_company_crew", (q) => q.eq("companyId", ctx.companyId).eq("crewId", crew._id))
      .take(50);
    out.push({ id: crew._id, name: crew.name, cleanerIds: members.filter((row) => row.from <= now && (row.to === undefined || row.to > now)).map((row) => row.cleanerId) });
  }
  return out;
}
