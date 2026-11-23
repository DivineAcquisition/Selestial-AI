/**
 * A cleaner's visit pass rate: of the visits they worked in the last 90 days that Quality reviewed, how many
 * had no confirmed miss that was theirs. The Owner asked for it on November 23, 2026, for owners and managers.
 *
 * Fair by construction, and nothing more than a count:
 * - Only findings a person confirmed count. A suggestion, a rejected finding, or a report never does.
 * - Only service misses count. A scope misunderstanding, an access, equipment or scheduling problem, or
 *   evidence that settles nothing is never held against a cleaner.
 * - A miss on a checklist item counts against the cleaner who marked that item. A miss nobody marked (an
 *   item never done, or one only reported) is shared by the visit's crew, and the row says how many were shared.
 * - Correction visits and imported history are left out. Each visit counts once, at its latest review.
 * - Below 10 reviewed visits there is no rate: "too few visits to read".
 * It is computed when asked, from the records, and changes nothing: no pay, standing, schedule or message.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { DAY } from "./words";

export const PASS_WINDOW_DAYS = 90;
export const PASS_MINIMUM = 10;

export type PassRow = {
  cleanerId: Id<"cleaners">;
  name: string;
  visits: number;
  passed: number;
  missed: number;
  /** Of the missed visits, how many were shared with the crew (no one person marked the item). */
  shared: number;
  /** passed / visits, or null below the minimum. */
  rate: number | null;
  tooFew: boolean;
};

const COUNTED: readonly Doc<"qualityReviews">["status"][] = ["ready", "waiting_on_evidence", "needs_decision", "approved", "case_opened"];

/** The reviewed visits in the window, each at its latest review round, with corrections and imports left out. */
async function reviewedVisits(ctx: QueryCtx, companyId: Id<"companies">, since: number): Promise<Doc<"jobs">[]> {
  const latest = new Map<string, Doc<"qualityReviews">>();
  for (const status of COUNTED) {
    const rows = await ctx.db.query("qualityReviews").withIndex("by_company_status", (q) => q.eq("companyId", companyId).eq("status", status).gte("updatedAt", since)).take(2000);
    for (const r of rows) {
      if (r.historical || r.createdAt < since) continue;
      const prior = latest.get(r.jobId);
      if (!prior || r.round > prior.round) latest.set(r.jobId, r);
    }
  }
  const jobs: Doc<"jobs">[] = [];
  for (const jobId of latest.keys()) {
    const job = await ctx.db.get(jobId as Id<"jobs">);
    if (job && job.companyId === companyId && job.recovery === undefined) jobs.push(job);
  }
  return jobs;
}

/** Who a confirmed miss counts against: the cleaners who marked the items it rests on, or else the whole crew. */
async function missesOn(ctx: QueryCtx, job: Doc<"jobs">, crew: Id<"cleaners">[]): Promise<{ against: Set<string>; shared: boolean }[]> {
  const cases = await ctx.db.query("qualityCases").withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id)).take(20);
  const out: { against: Set<string>; shared: boolean }[] = [];
  for (const c of cases) {
    const findings = await ctx.db.query("qualityFindings").withIndex("by_company_case", (q) => q.eq("companyId", job.companyId).eq("caseId", c._id)).take(50);
    for (const f of findings.filter((x) => x.state === "reviewed" && x.category === "service_miss")) {
      const markers = new Set<string>();
      for (const s of f.supporting.filter((x) => x.table === "checklistItems")) {
        const id = ctx.db.normalizeId("checklistItems", s.id);
        const item = id ? await ctx.db.get(id) : null;
        if (item?.byCleanerId && crew.includes(item.byCleanerId)) markers.add(item.byCleanerId);
      }
      out.push(markers.size ? { against: markers, shared: false } : { against: new Set(crew.map(String)), shared: true });
    }
  }
  return out;
}

export async function passRates(ctx: QueryCtx, companyId: Id<"companies">, now: number, only?: Id<"cleaners">): Promise<PassRow[]> {
  const since = now - PASS_WINDOW_DAYS * DAY;
  const tally = new Map<string, { visits: number; missed: number; shared: number }>();
  for (const job of await reviewedVisits(ctx, companyId, since)) {
    const assignments = await ctx.db.query("assignments").withIndex("by_company_job", (q) => q.eq("companyId", companyId).eq("jobId", job._id)).take(30);
    const crew = [...new Set(assignments.filter((a) => a.status === "accepted").map((a) => a.cleanerId))];
    if (!crew.length || (only && !crew.includes(only))) continue;
    const misses = await missesOn(ctx, job, crew);
    for (const cleanerId of crew) {
      if (only && cleanerId !== only) continue;
      const row = tally.get(cleanerId) ?? { visits: 0, missed: 0, shared: 0 };
      row.visits += 1;
      const theirs = misses.filter((m) => m.against.has(cleanerId));
      if (theirs.length) {
        row.missed += 1;
        if (theirs.every((m) => m.shared)) row.shared += 1;
      }
      tally.set(cleanerId, row);
    }
  }
  const rows: PassRow[] = [];
  for (const [cleanerId, t] of tally) {
    const cleaner = await ctx.db.get(cleanerId as Id<"cleaners">);
    if (!cleaner || cleaner.companyId !== companyId) continue;
    const tooFew = t.visits < PASS_MINIMUM;
    rows.push({ cleanerId: cleaner._id, name: cleaner.name, visits: t.visits, passed: t.visits - t.missed, missed: t.missed, shared: t.shared, rate: tooFew ? null : (t.visits - t.missed) / t.visits, tooFew });
  }
  return rows.sort((a, b) => Number(a.tooFew) - Number(b.tooFew) || a.name.localeCompare(b.name));
}

/** The rate in words, never alone: always with what it counts and over how long. */
export function passWords(row: Pick<PassRow, "visits" | "passed" | "shared" | "rate" | "tooFew">): string {
  if (row.tooFew) return `${row.visits} reviewed ${row.visits === 1 ? "visit" : "visits"} in ${PASS_WINDOW_DAYS} days: too few to read a rate (at least ${PASS_MINIMUM}).`;
  const missed = row.visits - row.passed;
  return `${row.passed} of ${row.visits} reviewed visits in ${PASS_WINDOW_DAYS} days had no confirmed miss of theirs${missed ? `; ${missed} did${row.shared ? `, ${row.shared} of them shared with the crew` : ""}` : ""}.`;
}
