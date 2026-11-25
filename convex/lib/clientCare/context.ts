/**
 * What Care reads before it answers: who is writing and what they may do, the visits they may speak for,
 * what each visit's record actually says, the plans and invoices behind them. Everything here is read from
 * the records; nothing is guessed. A visit that a migration holds is never described as confirmed.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { normalAddress } from "../compliance/recipients";
import { ACTIVE_ASSIGNMENT } from "../statuses";
import { clock, dayName } from "../time";
import { localParts } from "../availability";
import type { PlanRef } from "../retention/schema";
import type { Authority } from "./schema";

type Ctx = QueryCtx | MutationCtx;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The clients a phone number or email address belongs to, with the authority of the person who has it. */
export async function writersAt(ctx: Ctx, companyId: Id<"companies">, channel: "sms" | "email", address: string): Promise<{ customer: Doc<"customers">; authority: Authority }[]> {
  const out: { customer: Doc<"customers">; authority: Authority }[] = [];
  const seen = new Set<string>();
  const customers = await ctx.db
    .query("customers")
    .withIndex("by_company_status", (q) => q.eq("companyId", companyId).eq("status", "active"))
    .take(2000);
  for (const row of customers) {
    const own = channel === "sms" ? normalAddress("sms", row.phone) : normalAddress("email", row.email);
    if (own && own === address) {
      seen.add(row._id);
      out.push({ customer: row, authority: { as: "client", name: row.name, roles: ["primary", "billing", "signer", "site"], propertyIds: [] } });
    }
  }
  const contacts = await ctx.db
    .query("clientContacts")
    .withIndex("by_company_customer", (q) => q.eq("companyId", companyId))
    .take(4000);
  for (const c of contacts) {
    if (c.status !== "active" || seen.has(c.customerId)) continue;
    const own = channel === "sms" ? normalAddress("sms", c.phone) : normalAddress("email", c.email);
    if (!own || own !== address) continue;
    const customer = await ctx.db.get(c.customerId);
    if (!customer || customer.status !== "active") continue;
    seen.add(customer._id);
    out.push({ customer, authority: { as: "contact", contactId: c._id, name: c.name, roles: c.roles, propertyIds: c.propertyIds } });
  }
  return out;
}

/** What a person with this authority may ask Care to do. Reading a conversation grants none of this. */
export type Permit = "ask" | "visit_note" | "standing_note" | "access" | "change_visit" | "change_plan" | "billing" | "complaint" | "extra";

const NEEDS: Record<Permit, readonly Authority["roles"][number][]> = {
  ask: ["primary", "billing", "signer", "site"],
  complaint: ["primary", "billing", "signer", "site"],
  visit_note: ["primary", "signer", "site"],
  standing_note: ["primary", "signer", "site"],
  access: ["primary", "site"],
  change_visit: ["primary", "signer"],
  change_plan: ["primary", "signer"],
  extra: ["primary", "signer"],
  billing: ["primary", "billing"],
};

export function mayDo(authority: Authority, permit: Permit, propertyId?: Id<"properties"> | null): boolean {
  if (!authority.roles.some((role) => NEEDS[permit].includes(role))) return false;
  if (propertyId && authority.propertyIds.length > 0 && !authority.propertyIds.includes(propertyId)) return false;
  return true;
}

export const PERMIT_WORDS: Record<Permit, string> = {
  ask: "ask about visits",
  complaint: "report a problem",
  visit_note: "give instructions for a visit",
  standing_note: "change standing instructions",
  access: "change access instructions",
  change_visit: "move, skip or cancel a visit",
  change_plan: "pause or end the service",
  extra: "add services",
  billing: "discuss invoices and payments",
};

export async function propertiesInScope(ctx: Ctx, customer: Doc<"customers">, authority: Authority): Promise<Doc<"properties">[]> {
  const rows = await ctx.db
    .query("properties")
    .withIndex("by_company_customer", (q) => q.eq("companyId", customer.companyId).eq("customerId", customer._id))
    .take(100);
  return rows.filter((p) => p.status === "active" && (authority.propertyIds.length === 0 || authority.propertyIds.includes(p._id)));
}

/** Upcoming and current visits for the properties this person may speak for, soonest first. */
export async function visitsInScope(ctx: Ctx, customer: Doc<"customers">, authority: Authority, now: number, days = 60): Promise<Doc<"jobs">[]> {
  const rows = await ctx.db
    .query("jobs")
    .withIndex("by_company_customer_start", (q) => q.eq("companyId", customer.companyId).eq("customerId", customer._id).gte("startsAt", now - 12 * HOUR).lt("startsAt", now + days * DAY))
    .take(200);
  return rows.filter((job) => (job.status === "scheduled" || job.status === "in_progress") && (authority.propertyIds.length === 0 || authority.propertyIds.includes(job.propertyId))).sort((a, b) => a.startsAt - b.startsAt);
}

/** The visit a client means, by the day they named. Several on that day, or none named and several upcoming, is ambiguous. */
export function pickVisit(visits: Doc<"jobs">[], target: { day?: string; weekday?: number } | undefined, timezone: string, propertyId?: Id<"properties">): { kind: "one"; job: Doc<"jobs"> } | { kind: "several"; jobs: Doc<"jobs">[] } | { kind: "none" } {
  let pool = propertyId ? visits.filter((job) => job.propertyId === propertyId) : visits;
  if (target?.day || target?.weekday !== undefined) {
    pool = pool.filter((job) => {
      const parts = localParts(job.startsAt, timezone);
      return target.day ? parts.day === target.day : parts.weekday === target.weekday;
    });
    // "Friday" with no date means the next Friday: the first one in the list, unless two share that day.
    if (!target.day && pool.length > 1) {
      const first = localParts(pool[0].startsAt, timezone).day;
      pool = pool.filter((job) => localParts(job.startsAt, timezone).day === first);
    }
  }
  if (pool.length === 1) return { kind: "one", job: pool[0] };
  if (pool.length === 0) return { kind: "none" };
  return { kind: "several", jobs: pool.slice(0, 4) };
}

export function visitLabel(job: Doc<"jobs">, property: Doc<"properties"> | null, timezone: string, withPlace: boolean): string {
  const place = property ? property.label?.trim() || property.address.line1 : null;
  return `${dayName(job.startsAt, timezone)} at ${clock(job.startsAt, timezone)}${withPlace && place ? `, ${place}` : ""}`;
}

export type VisitState = {
  /** requested · payment_pending · booked · offered · accepted · in_progress · held */
  state: "booked" | "offered" | "accepted" | "in_progress" | "held";
  words: string;
  confirmed: boolean;
  crewNames: string[];
  arrival: string;
  late: string | null;
};

/** What a visit's own record says, in the order a client needs it. Coverage is read from its assignments, never inferred. */
export async function visitState(ctx: Ctx, job: Doc<"jobs">, timezone: string): Promise<VisitState> {
  const window = job.arrivalWindowMinutes ? `between ${clock(job.startsAt, timezone)} and ${clock(job.startsAt + job.arrivalWindowMinutes * 60_000, timezone)}` : `at ${clock(job.startsAt, timezone)}`;
  const arrival = `${dayName(job.startsAt, timezone)} ${window}`;
  if (job.migration?.held) return { state: "held", words: `The visit on ${arrival} came over from your previous system and the office is still checking it, so it isn't confirmed yet.`, confirmed: false, crewNames: [], arrival, late: null };
  const assignments = await ctx.db
    .query("assignments")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .take(30);
  const active = assignments.filter((row) => ACTIVE_ASSIGNMENT.includes(row.status));
  const accepted = active.filter((row) => row.status === "accepted");
  const crew = Math.max(1, job.requiredCrew ?? 1);
  const names: string[] = [];
  for (const row of accepted) {
    const cleaner = await ctx.db.get(row.cleanerId);
    // A first name only, and only of someone who accepted the visit.
    if (cleaner) names.push(cleaner.name.trim().split(/\s+/)[0] ?? cleaner.name);
  }
  const lateRow = accepted.find((row) => row.late && row.late.etaAt > Date.now() - HOUR);
  const late = lateRow?.late ? `The cleaner reported running late; their own estimate is ${clock(lateRow.late.etaAt, timezone)}.` : null;
  if (job.status === "in_progress") {
    const checkedIn = accepted.find((row) => row.checkIn);
    return { state: "in_progress", words: checkedIn ? `Your visit is under way: the cleaner checked in.` : "Your visit is marked as under way.", confirmed: true, crewNames: names, arrival, late };
  }
  if (accepted.length >= crew) return { state: "accepted", words: `Your visit is booked for ${arrival}, and ${names.length ? names.join(" and ") : "your cleaner"} ${names.length > 1 ? "have" : "has"} accepted it.`, confirmed: true, crewNames: names, arrival, late };
  if (active.length > 0) return { state: "offered", words: `Your visit is booked for ${arrival}. A cleaner has been asked and hasn't confirmed yet.`, confirmed: false, crewNames: [], arrival, late };
  return { state: "booked", words: `Your visit is booked for ${arrival}. A cleaner hasn't been confirmed for it yet.`, confirmed: false, crewNames: [], arrival, late };
}

/** Bookings that are not visits yet: asked for, or waiting for payment. */
export async function openBookings(ctx: Ctx, customer: Doc<"customers">): Promise<Doc<"bookings">[]> {
  const rows = await ctx.db
    .query("bookings")
    .withIndex("by_company_customer", (q) => q.eq("companyId", customer.companyId).eq("customerId", customer._id))
    .take(50);
  return rows.filter((row) => (row.status === "requested" || row.status === "awaiting") && !row.jobId);
}

/** The recurring plan a visit belongs to, in the shape Retention's plan-change code takes. */
export async function planOf(ctx: Ctx, job: Doc<"jobs">): Promise<PlanRef | null> {
  if (job.planId) return { kind: "service", id: job.planId };
  const visit = await ctx.db
    .query("planVisits")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .first();
  return visit ? { kind: "sales", id: visit.planId } : null;
}

/** The client's recurring plans that are running or paused, for the properties in scope. */
export async function plansInScope(ctx: Ctx, customer: Doc<"customers">, authority: Authority): Promise<{ ref: PlanRef; propertyId: Id<"properties">; label: string }[]> {
  const out: { ref: PlanRef; propertyId: Id<"properties">; label: string }[] = [];
  const service = await ctx.db
    .query("servicePlans")
    .withIndex("by_company_customer", (q) => q.eq("companyId", customer.companyId).eq("customerId", customer._id))
    .take(50);
  for (const row of service) if (row.kind === "recurring" && (row.state === "active" || row.state === "paused") && !row.migration?.held) out.push({ ref: { kind: "service", id: row._id }, propertyId: row.propertyId, label: "Recurring service" });
  const sales = await ctx.db
    .query("recurringPlans")
    .withIndex("by_company_customer", (q) => q.eq("companyId", customer.companyId).eq("customerId", customer._id))
    .take(50);
  for (const row of sales) if (row.status === "active" || row.status === "paused") out.push({ ref: { kind: "sales", id: row._id }, propertyId: row.propertyId, label: "Recurring service" });
  return out.filter((row) => authority.propertyIds.length === 0 || authority.propertyIds.includes(row.propertyId));
}
