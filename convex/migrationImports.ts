/**
 * Importing appointments, recurring service and history from a spreadsheet or another system's export
 * (lib/migration/records.ts), the same way clients are imported: check every row first, then commit in
 * batches kept under the key the screen sent, so a retry never imports twice.
 *
 * Each row must match one client already in Selestial, by email, then phone, then exact name. A row that
 * matches none, or more than one, is held back with the reason: a record is never attached to a guess.
 *
 * Nothing here books a visit, starts a plan, assigns a cleaner, prices anything or contacts anyone. An
 * imported appointment or schedule waits for the owner to set it up; history is kept for reference.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { managerMutation, managerQuery } from "./lib/builders";
import { digits } from "./lib/clients/directory";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { recordKindValidator, recordSourceValidator } from "./lib/migration/schema";
import {
  KIND_WORDS,
  legacyRecordKey,
  readCadence,
  readCents,
  readDay,
  readMinutes,
  readStart,
  RECORD_COMMIT_LIMIT,
  RECORD_ROW_LIMIT,
  recordKey,
  recordNotes,
  recordProblems,
  type RecordKind,
  type RecordRow,
} from "./lib/migration/records";
import { addDays } from "./lib/sales/cadence";
import { dayOf } from "./lib/services/propertyPrices";
import { text } from "./lib/text";

const rowValidator = v.object({
  clientName: v.optional(v.string()),
  clientEmail: v.optional(v.string()),
  clientPhone: v.optional(v.string()),
  street: v.optional(v.string()),
  date: v.optional(v.string()),
  time: v.optional(v.string()),
  endDate: v.optional(v.string()),
  duration: v.optional(v.string()),
  frequency: v.optional(v.string()),
  amount: v.optional(v.string()),
  reference: v.optional(v.string()),
  description: v.optional(v.string()),
  status: v.optional(v.string()),
  assignedTo: v.optional(v.string()),
});

type Directory = {
  byEmail: Map<string, Id<"customers">[]>;
  byPhone: Map<string, Id<"customers">[]>;
  byName: Map<string, Id<"customers">[]>;
  names: Map<Id<"customers">, string>;
};

const norm = (value: string | undefined) => (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const add = (map: Map<string, Id<"customers">[]>, key: string, id: Id<"customers">) => {
  if (!key) return;
  const list = map.get(key) ?? [];
  if (!list.includes(id)) list.push(id);
  map.set(key, list);
};

/** The company's active clients, indexed once per call so every row is matched the same way. */
async function directoryOf(ctx: QueryCtx, companyId: Id<"companies">): Promise<Directory> {
  const out: Directory = { byEmail: new Map(), byPhone: new Map(), byName: new Map(), names: new Map() };
  const customers = await ctx.db
    .query("customers")
    .withIndex("by_company_status", (q) => q.eq("companyId", companyId).eq("status", "active"))
    .take(5000);
  for (const customer of customers) {
    out.names.set(customer._id, customer.name);
    add(out.byEmail, norm(customer.email), customer._id);
    if (digits(customer.phone).length === 10) add(out.byPhone, digits(customer.phone), customer._id);
    add(out.byName, norm(customer.name), customer._id);
  }
  const contacts = await ctx.db.query("clientContacts").withIndex("by_company_customer", (q) => q.eq("companyId", companyId)).take(5000);
  for (const contact of contacts) {
    if (!out.names.has(contact.customerId)) continue;
    add(out.byEmail, norm(contact.email), contact.customerId);
    if (digits(contact.phone).length === 10) add(out.byPhone, digits(contact.phone), contact.customerId);
  }
  return out;
}

type Match = { customerId: Id<"customers">; name: string; by: string } | { problem: string };

/**
 * One client for the row, or why there isn't one. Email, then phone, then exact name. When the row's
 * email and phone each point at a different client, the row is held back: neither is picked silently.
 */
function matchClient(directory: Directory, row: RecordRow): Match {
  const byEmail = row.clientEmail ? directory.byEmail.get(norm(row.clientEmail.split(/[,;\s]/)[0])) : undefined;
  const byPhone = digits(row.clientPhone).length === 10 ? directory.byPhone.get(digits(row.clientPhone)) : undefined;
  if (byEmail?.length === 1 && byPhone?.length === 1 && byEmail[0] !== byPhone[0]) {
    return { problem: `The email belongs to ${directory.names.get(byEmail[0]) ?? "one client"} and the phone to ${directory.names.get(byPhone[0]) ?? "another"}. Correct the row so both point to the same client.` };
  }
  const tries: [string, Id<"customers">[] | undefined][] = [
    ["email", byEmail],
    ["phone", byPhone],
    ["name", row.clientName ? directory.byName.get(norm(row.clientName)) : undefined],
  ];
  for (const [by, ids] of tries) {
    if (!ids?.length) continue;
    if (ids.length > 1) return { problem: `More than one client has this ${by}. Add the client's email to the row so it matches one.` };
    return { customerId: ids[0], name: directory.names.get(ids[0]) ?? "", by };
  }
  return { problem: "No client in Selestial matches this name, email or phone. Import the client first, or correct the row." };
}

/** True when `street` is this address line, or continues it after a whole word: "12 Oak, Apt 4" is at "12 Oak"; "12 Oakland Ave" is not. */
export function streetStartsWith(street: string, line1: string): boolean {
  if (!line1 || !street.startsWith(line1)) return false;
  return street.length === line1.length || !/[a-z0-9]/.test(street[line1.length]!);
}

async function propertyAt(ctx: QueryCtx, companyId: Id<"companies">, customerId: Id<"customers">, street: string | undefined): Promise<Id<"properties"> | undefined> {
  const properties = (await ctx.db.query("properties").withIndex("by_company_customer", (q) => q.eq("companyId", companyId).eq("customerId", customerId)).take(50)).filter((p) => p.status === "active");
  if (!street?.trim()) return properties.length === 1 ? properties[0]._id : undefined;
  const wanted = norm(street);
  const exact = properties.find((p) => norm(p.address.line1) === wanted);
  if (exact) return exact._id;
  // Otherwise the longest address the street continues after a whole word. Two equally good ones are not guessed between.
  const partial = properties.filter((p) => streetStartsWith(wanted, norm(p.address.line1))).sort((a, b) => norm(b.address.line1).length - norm(a.address.line1).length);
  if (partial.length > 1 && norm(partial[0].address.line1).length === norm(partial[1].address.line1).length) return undefined;
  return partial[0]?._id;
}

/**
 * The record this row was imported as before, if any. Records stored before the key named the street and
 * the date column's time are recognized by their old key, once each: the first row that matches one takes
 * it (`claimed`), so a second visit for the same client on the same day is new, not a duplicate.
 */
async function importedBefore(ctx: QueryCtx, companyId: Id<"companies">, kind: RecordKind, row: RecordRow, key: string, claimed: Set<string>): Promise<Doc<"migrationRecords"> | null> {
  const current = await ctx.db
    .query("migrationRecords")
    .withIndex("by_company_key", (q) => q.eq("companyId", companyId).eq("key", key))
    .first();
  if (current) return current;
  const legacy = legacyRecordKey(kind, row);
  if (claimed.has(legacy)) return null;
  const old = await ctx.db
    .query("migrationRecords")
    .withIndex("by_company_key", (q) => q.eq("companyId", companyId).eq("key", legacy))
    .first();
  if (old) claimed.add(legacy);
  return old;
}

/** What importing these rows would do, row by row. Nothing is written. */
export const check = managerQuery({
  args: { kind: recordKindValidator, rows: v.array(rowValidator) },
  handler: async (ctx, args) => {
    if (args.rows.length > RECORD_ROW_LIMIT) throw userError(`Import up to ${RECORD_ROW_LIMIT} rows at a time.`);
    const directory = await directoryOf(ctx, ctx.companyId);
    const today = dayOf(Date.now(), ctx.company.timezone);
    const seen = new Map<string, number>();
    const claimed = new Set<string>();
    const rows = [];
    for (const [index, row] of args.rows.entries()) {
      const problems = recordProblems(args.kind, row);
      const match = problems.length ? null : matchClient(directory, row);
      if (match && "problem" in match) problems.push(match.problem);
      const key = recordKey(args.kind, row, ctx.company.timezone);
      const before = problems.length ? null : await importedBefore(ctx, ctx.companyId, args.kind, row, key, claimed);
      const sameAsRow = seen.get(key) ?? null;
      if (sameAsRow === null) seen.set(key, index);
      rows.push({
        index,
        label: row.clientName?.trim() || row.clientEmail?.trim() || `Row ${index + 2}`,
        client: match && !("problem" in match) ? { name: match.name, by: match.by } : null,
        problems,
        notes: recordNotes(args.kind, row, today, ctx.company.timezone),
        importedBefore: before !== null,
        sameAsRow,
      });
    }
    return { rows, willCreate: rows.filter((row) => !row.problems.length && !row.importedBefore && row.sameAsRow === null).length };
  },
});

/** Imports one batch. Sent twice under the same key, it returns the first result and writes nothing. */
export const commit = managerMutation({
  args: { importKey: v.string(), kind: recordKindValidator, source: recordSourceValidator, label: v.string(), rows: v.array(v.object({ index: v.number(), row: rowValidator })) },
  handler: async (ctx, args) => {
    const importKey = text(args.importKey, "The import key", 160);
    const existing = await ctx.db
      .query("migrationImportRuns")
      .withIndex("by_company_key", (q) => q.eq("companyId", ctx.companyId).eq("importKey", importKey))
      .first();
    if (existing) return { repeated: true, created: existing.created, skipped: existing.skipped, failed: existing.failed, results: existing.results };
    if (args.rows.length > RECORD_COMMIT_LIMIT) throw userError(`Send up to ${RECORD_COMMIT_LIMIT} rows in one batch.`);
    const now = Date.now();
    const today = dayOf(now, ctx.company.timezone);
    const directory = await directoryOf(ctx, ctx.companyId);
    const runId = await ctx.db.insert("migrationImportRuns", { companyId: ctx.companyId, importKey, kind: args.kind, source: args.source, label: text(args.label || "Spreadsheet", "The import name", 120), results: [], created: 0, skipped: 0, failed: 0, by: ctx.member._id, createdAt: now });
    const results: Doc<"migrationImportRuns">["results"] = [];
    const inBatch = new Set<string>();
    const claimed = new Set<string>();
    for (const { index, row } of args.rows) {
      const name = (row.clientName ?? row.clientEmail ?? `Row ${index + 2}`).trim().slice(0, 160);
      const problems = recordProblems(args.kind, row);
      if (problems.length) {
        results.push({ index, name, outcome: "failed", reason: problems.join(" ") });
        continue;
      }
      const match = matchClient(directory, row);
      if ("problem" in match) {
        results.push({ index, name, outcome: "failed", reason: match.problem });
        continue;
      }
      const key = recordKey(args.kind, row, ctx.company.timezone);
      const start = readStart(row, ctx.company.timezone);
      const before = await importedBefore(ctx, ctx.companyId, args.kind, row, key, claimed);
      // A record kept under the old key moves to the new one, and gains the start time the old import left out.
      if (before && before.key !== key) await ctx.db.patch(before._id, { key, ...(before.time || !start.time ? {} : { time: start.time }) });
      if (before || inBatch.has(key)) {
        results.push({ index, name, outcome: "skipped", reason: before ? "Already imported." : "The same record is in the file twice." });
        continue;
      }
      inBatch.add(key);
      const day = start.day ?? undefined;
      // A past appointment is history: it is kept for reference, never offered as a visit to book.
      const kind: RecordKind = args.kind === "appointment" && day && day < today ? "history" : args.kind;
      const clip = (value: string | undefined, max = 500) => (value?.trim() ? value.trim().slice(0, max) : undefined);
      await ctx.db.insert("migrationRecords", {
        companyId: ctx.companyId,
        customerId: match.customerId,
        propertyId: await propertyAt(ctx, ctx.companyId, match.customerId, row.street),
        kind,
        source: args.source,
        key,
        day,
        time: start.time ?? undefined,
        endDay: readDay(row.endDate) ?? undefined,
        durationMinutes: readMinutes(row.duration) ?? undefined,
        frequency: clip(row.frequency, 120),
        ...(args.kind === "recurring" ? { cadence: readCadence(row.frequency) } : {}),
        amountCents: readCents(row.amount) ?? undefined,
        reference: clip(row.reference, 120),
        description: clip(row.description, 1000),
        status: clip(row.status, 120),
        assignedTo: clip(row.assignedTo, 200),
        review: kind === "history" ? "reference" : "review",
        runId,
        createdAt: now,
      });
      results.push({ index, name: match.name, outcome: "created" });
    }
    const count = (outcome: string) => results.filter((row) => row.outcome === outcome).length;
    await ctx.db.patch(runId, { results, created: count("created"), skipped: count("skipped"), failed: count("failed") });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "migration.records_imported", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { kind: args.kind, source: args.source, created: count("created"), skipped: count("skipped"), failed: count("failed") } });
    return { repeated: false, created: count("created"), skipped: count("skipped"), failed: count("failed"), results };
  },
});

const RECONCILE_DAYS = 30;
const SOURCE_WORDS: Record<Doc<"migrationRecords">["source"], string | null> = { jobber: "Jobber", housecall_pro: "Housecall Pro", bookingkoala: "BookingKoala", csv: null };

type ReviewState = "review" | "set_up" | "dismissed";
type Bucket = { count: number; amountCents: number; unpriced: number };
const emptyBucket = (): Bucket => ({ count: 0, amountCents: 0, unpriced: 0 });
const addTo = (bucket: Bucket, row: Doc<"migrationRecords">) => {
  bucket.count += 1;
  if (row.amountCents === undefined) bucket.unpriced += 1;
  else bucket.amountCents += row.amountCents;
};

async function recordsOf(ctx: QueryCtx, companyId: Id<"companies">, kind: RecordKind, review: Doc<"migrationRecords">["review"]) {
  return ctx.db
    .query("migrationRecords")
    .withIndex("by_company_kind", (q) => q.eq("companyId", companyId).eq("kind", kind).eq("review", review))
    .take(2000);
}

/** A client's visits in Selestial that are on the calendar (not cancelled), by the company's local day. */
async function visitsByDay(ctx: QueryCtx, companyId: Id<"companies">, customerId: Id<"customers">, timezone: string, fromDay: string, toDay: string) {
  const from = Date.parse(`${addDays(fromDay, -1)}T00:00:00Z`);
  const to = Date.parse(`${addDays(toDay, 2)}T00:00:00Z`);
  const jobs = await ctx.db
    .query("jobs")
    .withIndex("by_company_customer_start", (q) => q.eq("companyId", companyId).eq("customerId", customerId).gte("startsAt", from).lte("startsAt", to))
    .take(300);
  const days = new Map<string, Doc<"jobs">[]>();
  for (const job of jobs) {
    if (job.status === "cancelled") continue;
    const day = dayOf(job.startsAt, timezone);
    days.set(day, [...(days.get(day) ?? []), job]);
  }
  return days;
}

/** The client's recurring service that is running in Selestial (active, so it is making visits), in either place a plan is kept. */
async function plansFor(ctx: QueryCtx, companyId: Id<"companies">, customerId: Id<"customers">) {
  const service = (await ctx.db.query("servicePlans").withIndex("by_company_customer", (q) => q.eq("companyId", companyId).eq("customerId", customerId)).take(50)).filter((plan) => plan.kind === "recurring" && plan.state === "active");
  const recurring = (await ctx.db.query("recurringPlans").withIndex("by_company_customer", (q) => q.eq("companyId", companyId).eq("customerId", customerId)).take(50)).filter((plan) => plan.status === "active");
  return { service, recurring };
}

/**
 * Gives each imported visit of one client on one day a Selestial visit on that day, each visit used
 * once. A record already linked to a visit keeps it; then the same property is preferred.
 */
function pairVisits(records: Doc<"migrationRecords">[], jobs: Doc<"jobs">[]): Map<Id<"migrationRecords">, Doc<"jobs">> {
  const out = new Map<Id<"migrationRecords">, Doc<"jobs">>();
  const free = [...jobs].sort((a, b) => a.startsAt - b.startsAt);
  const take = (record: Doc<"migrationRecords">, pick: (job: Doc<"jobs">) => boolean) => {
    if (out.has(record._id)) return;
    const index = free.findIndex(pick);
    if (index >= 0) out.set(record._id, free.splice(index, 1)[0]!);
  };
  const ordered = [...records].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  for (const record of ordered) if (record.jobId) take(record, (job) => job._id === record.jobId);
  for (const record of ordered) if (record.propertyId) take(record, (job) => job.propertyId === record.propertyId);
  for (const record of ordered) take(record, () => true);
  return out;
}

/**
 * For the migration review: what came in, by kind, with the prices the other system had, split into
 * waiting, set up and skipped; and the reconciliation an owner needs before they stop using the old
 * system: of the imported visits in the next 30 days, how many have a visit on the same day for the same
 * client in Selestial, which don't, and what the two add up to. Read only: nothing is booked from here.
 */
export const summary = managerQuery({
  args: {},
  handler: async (ctx) => {
    const tz = ctx.company.timezone;
    const today = dayOf(Date.now(), tz);
    const through = addDays(today, RECONCILE_DAYS);
    const clientRuns = await ctx.db.query("clientImportRuns").withIndex("by_company_key", (q) => q.eq("companyId", ctx.companyId)).take(500);
    const states: ReviewState[] = ["review", "set_up", "dismissed"];
    const appointments = { review: await recordsOf(ctx, ctx.companyId, "appointment", "review"), set_up: await recordsOf(ctx, ctx.companyId, "appointment", "set_up"), dismissed: await recordsOf(ctx, ctx.companyId, "appointment", "dismissed") };
    const recurring = { review: await recordsOf(ctx, ctx.companyId, "recurring", "review"), set_up: await recordsOf(ctx, ctx.companyId, "recurring", "set_up"), dismissed: await recordsOf(ctx, ctx.companyId, "recurring", "dismissed") };
    const history = await recordsOf(ctx, ctx.companyId, "history", "reference");
    const totals = (rows: Record<ReviewState, Doc<"migrationRecords">[]>, keep: (row: Doc<"migrationRecords">) => boolean) => {
      const out = { waiting: emptyBucket(), setUp: emptyBucket(), skipped: emptyBucket() };
      for (const state of states) for (const row of rows[state]) if (keep(row)) addTo(state === "review" ? out.waiting : state === "set_up" ? out.setUp : out.skipped, row);
      return out;
    };
    const upcoming = (row: Doc<"migrationRecords">) => row.day !== undefined && row.day >= today;

    // Upcoming visits in the next 30 days, against the calendar.
    const inWindow = (row: Doc<"migrationRecords">) => row.day !== undefined && row.day >= today && row.day <= through;
    const live = [...appointments.review, ...appointments.set_up].filter(inWindow);
    const byClient = new Map<Id<"customers">, Doc<"migrationRecords">[]>();
    for (const row of live) byClient.set(row.customerId, [...(byClient.get(row.customerId) ?? []), row]);
    const visits = { total: live.length, scheduled: 0, waiting: 0, confirmedByYou: 0, skipped: appointments.dismissed.filter(inWindow).length, importedCents: 0, importedUnpriced: 0, scheduledCents: 0 };
    const missing: { id: Id<"migrationRecords">; customerId: Id<"customers">; client: string; day: string; time: string | null; amountCents: number | null; state: "waiting" | "confirmed_by_you" }[] = [];
    for (const [customerId, rows] of byClient) {
      const days = await visitsByDay(ctx, ctx.companyId, customerId, tz, today, through);
      const client = (await ctx.db.get(customerId))?.name ?? "";
      const perDay = new Map<string, Doc<"migrationRecords">[]>();
      for (const row of rows) perDay.set(row.day!, [...(perDay.get(row.day!) ?? []), row]);
      for (const [day, dayRows] of perDay) {
        const pairs = pairVisits(dayRows, days.get(day) ?? []);
        for (const row of dayRows) {
          if (row.amountCents === undefined) visits.importedUnpriced += 1;
          else visits.importedCents += row.amountCents;
          const job = pairs.get(row._id);
          if (job) {
            visits.scheduled += 1;
            visits.scheduledCents += job.priceCents ?? 0;
            continue;
          }
          const state = row.review === "set_up" ? ("confirmed_by_you" as const) : ("waiting" as const);
          if (state === "waiting") visits.waiting += 1;
          else visits.confirmedByYou += 1;
          missing.push({ id: row._id, customerId, client, day, time: row.time ?? null, amountCents: row.amountCents ?? null, state });
        }
      }
    }
    missing.sort((a, b) => a.day.localeCompare(b.day) || (a.time ?? "").localeCompare(b.time ?? "") || a.client.localeCompare(b.client));

    // Recurring schedules, against the plans running in Selestial for the same client.
    const liveSchedules = [...recurring.review, ...recurring.set_up];
    const schedules = { total: liveSchedules.length, withPlan: 0, waiting: 0, confirmedByYou: 0, skipped: recurring.dismissed.length, importedCents: 0, importedUnpriced: 0, scheduledCents: 0 };
    const plansByClient = new Map<Id<"customers">, Awaited<ReturnType<typeof plansFor>>>();
    for (const row of liveSchedules) {
      if (row.amountCents === undefined) schedules.importedUnpriced += 1;
      else schedules.importedCents += row.amountCents;
      if (!plansByClient.has(row.customerId)) plansByClient.set(row.customerId, await plansFor(ctx, ctx.companyId, row.customerId));
      const plans = plansByClient.get(row.customerId)!;
      // Each plan answers for one imported schedule.
      const service = plans.service.find((plan) => plan._id === row.servicePlanId) ?? (row.recurringPlanId ? undefined : plans.service[0]);
      const other = service ? undefined : (plans.recurring.find((plan) => plan._id === row.recurringPlanId) ?? plans.recurring[0]);
      if (service) {
        plans.service.splice(plans.service.indexOf(service), 1);
        schedules.withPlan += 1;
        schedules.scheduledCents += service.priceCents ?? 0;
      } else if (other) {
        plans.recurring.splice(plans.recurring.indexOf(other), 1);
        schedules.withPlan += 1;
        const version = await ctx.db
          .query("recurringPlanVersions")
          .withIndex("by_plan_version", (q) => q.eq("planId", other._id).eq("version", other.currentVersion))
          .unique();
        schedules.scheduledCents += version?.visitPriceCents ?? 0;
      } else if (row.review === "set_up") schedules.confirmedByYou += 1;
      else schedules.waiting += 1;
    }

    const sources = new Map<string, number>();
    for (const row of [...live, ...liveSchedules, ...appointments.dismissed, ...recurring.dismissed]) {
      const words = SOURCE_WORDS[row.source];
      if (words) sources.set(words, (sources.get(words) ?? 0) + 1);
    }
    const from = [...sources.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const appointmentTotals = totals(appointments, upcoming);
    const recurringTotals = totals(recurring, () => true);
    return {
      clients: clientRuns.reduce((sum, run) => sum + run.created, 0),
      appointments: { waiting: appointments.review.length, setUp: appointments.set_up.length, skipped: appointments.dismissed.length, upcoming: appointmentTotals },
      recurring: { waiting: recurring.review.length, setUp: recurring.set_up.length, skipped: recurring.dismissed.length, totals: recurringTotals },
      history: history.length,
      reconciliation: {
        /** The other system's name when the records came from one, for "Before you stop using …". */
        from,
        days: RECONCILE_DAYS,
        today,
        through,
        visits,
        schedules,
        missing: missing.slice(0, 50),
        missingCount: missing.length,
        /** Nothing upcoming is still waiting: every imported visit and schedule is on the calendar, confirmed by the owner, or deliberately skipped. */
        settled: visits.waiting === 0 && schedules.waiting === 0,
      },
    };
  },
});

/** Imported appointments and schedules still waiting for the owner, with their client, for the review screen. */
export const waiting = managerQuery({
  args: { kind: v.union(v.literal("appointment"), v.literal("recurring")) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("migrationRecords").withIndex("by_company_kind", (q) => q.eq("companyId", ctx.companyId).eq("kind", args.kind).eq("review", "review")).take(1000);
    const out = [];
    for (const row of rows) {
      const customer = await ctx.db.get(row.customerId);
      out.push({ id: row._id, customerId: row.customerId, client: customer?.name ?? "", day: row.day ?? null, time: row.time ?? null, durationMinutes: row.durationMinutes ?? null, frequency: row.frequency ?? null, cadence: row.cadence ?? null, amountCents: row.amountCents ?? null, description: row.description ?? null, assignedTo: row.assignedTo ?? null, hasProperty: Boolean(row.propertyId) });
    }
    return out.sort((a, b) => (a.day ?? "").localeCompare(b.day ?? ""));
  },
});

/** A client's imported records, newest first, for the client page. */
export const forClient = managerQuery({
  args: { customerId: v.id("customers") },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("migrationRecords").withIndex("by_company_customer", (q) => q.eq("companyId", ctx.companyId).eq("customerId", args.customerId)).take(200);
    return rows
      .map((row) => ({ id: row._id, kind: row.kind, day: row.day ?? null, time: row.time ?? null, frequency: row.frequency ?? null, cadence: row.cadence ?? null, amountCents: row.amountCents ?? null, reference: row.reference ?? null, description: row.description ?? null, status: row.status ?? null, review: row.review, source: row.source }))
      .sort((a, b) => (b.day ?? "").localeCompare(a.day ?? ""));
  },
});

/** The Selestial visit or plan an imported record corresponds to, if there is one no other record already answers for. */
async function matchFor(ctx: MutationCtx, row: Doc<"migrationRecords">, timezone: string): Promise<{ jobId?: Id<"jobs">; servicePlanId?: Id<"servicePlans">; recurringPlanId?: Id<"recurringPlans"> } | null> {
  const others = (await ctx.db.query("migrationRecords").withIndex("by_company_customer", (q) => q.eq("companyId", row.companyId).eq("customerId", row.customerId).eq("kind", row.kind)).take(500)).filter((other) => other._id !== row._id && other.review === "set_up");
  if (row.kind === "appointment") {
    if (!row.day) return null;
    const taken = new Set(others.map((other) => other.jobId));
    const jobs = ((await visitsByDay(ctx, row.companyId, row.customerId, timezone, row.day, row.day)).get(row.day) ?? []).filter((job) => !taken.has(job._id));
    const job = (row.propertyId ? jobs.find((j) => j.propertyId === row.propertyId) : undefined) ?? jobs[0];
    return job ? { jobId: job._id } : null;
  }
  const plans = await plansFor(ctx, row.companyId, row.customerId);
  const service = plans.service.filter((plan) => !others.some((other) => other.servicePlanId === plan._id));
  const servicePlan = (row.propertyId ? service.find((plan) => plan.propertyId === row.propertyId) : undefined) ?? service[0];
  if (servicePlan) return { servicePlanId: servicePlan._id };
  const recurring = plans.recurring.filter((plan) => !others.some((other) => other.recurringPlanId === plan._id));
  const recurringPlan = (row.propertyId ? recurring.find((plan) => plan.propertyId === row.propertyId) : undefined) ?? recurring[0];
  return recurringPlan ? { recurringPlanId: recurringPlan._id } : null;
}

/**
 * The owner marks an imported appointment or schedule as set up, or sets it aside. Only the record's own
 * review state changes: no visit or plan is made or changed here.
 *
 * "Set up" is tied to what it means. When the client has a visit on that day (or a recurring plan) in
 * Selestial, the record is linked to it. When there is none, nothing is marked: the answer asks the owner
 * to say plainly that they set it up themselves (`confirmSelf`), and that choice is what is recorded.
 */
export const decide = managerMutation({
  args: { recordId: v.id("migrationRecords"), review: v.union(v.literal("set_up"), v.literal("dismissed"), v.literal("review")), confirmSelf: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.recordId);
    if (!row || row.companyId !== ctx.companyId) throw userError("That record is no longer here.", "not_found");
    if (row.kind === "history") throw userError(`A ${KIND_WORDS.history.one} is kept for reference only.`);
    const cleared = { jobId: undefined, servicePlanId: undefined, recurringPlanId: undefined, selfConfirmed: undefined };
    const stamp = { decidedBy: ctx.member._id, decidedAt: Date.now() };
    if (args.review !== "set_up") {
      await ctx.db.patch(row._id, { review: args.review, ...cleared, ...stamp });
      return { outcome: args.review === "dismissed" ? ("skipped" as const) : ("waiting" as const) };
    }
    const match = await matchFor(ctx, row, ctx.company.timezone);
    if (match) {
      await ctx.db.patch(row._id, { review: "set_up", ...cleared, ...match, ...stamp });
      return { outcome: "linked" as const, to: row.kind === "appointment" ? ("visit" as const) : ("plan" as const) };
    }
    if (!args.confirmSelf) {
      return {
        outcome: "confirm_needed" as const,
        message:
          row.kind === "appointment"
            ? `Selestial has no visit for this client on ${row.day ?? "that day"}. Book it from the client's page, or confirm that you've set it up yourself.`
            : "Selestial has no recurring plan for this client yet. Set one up from the client's page, or confirm that you've set it up yourself.",
      };
    }
    await ctx.db.patch(row._id, { review: "set_up", ...cleared, selfConfirmed: true, ...stamp });
    return { outcome: "confirmed_by_you" as const };
  },
});
