/**
 * Shared by the Quality scenario tests: a texting company on the Expand plan (the plan Quality is on), a
 * customer with a phone and permission, two cleaners, and helpers that bring a visit to "reported done" the
 * way the crew would, with a checklist and photos.
 */
import { vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { qualityOnCompletionReported, qualityOnEvidence } from "../convex/lib/quality/hooks";
import { handOff } from "../convex/lib/dispatch/handoffs";
import { reviewKey } from "../convex/lib/dispatch/live";
import type { Requirement } from "../convex/lib/quality/schema";
import { mockOutbox } from "../convex/lib/messaging/provider";
import { dispatchJob, HOUR, JOB_END, JOB_START } from "./harness";
import { CUSTOMER_PHONE, DAY, flush, retentionSetup } from "./retentionHarness";

export { CUSTOMER_PHONE, DAY, flush, HOUR, JOB_END, JOB_START };

export const textsToPhone = (phone: string) => mockOutbox.filter((row) => row.to.endsWith(phone.replace(/\D/g, "")) && row.result === "accepted").map((row) => row.body);

/** The newest Quality link texted to this number. */
export function qualityLink(phone: string): string {
  for (const text of textsToPhone(phone).reverse()) {
    const match = text.match(/\/c\/quality\/([A-Za-z0-9_.-]+)/);
    if (match) return match[1].replace(/\.$/, "");
  }
  throw new Error(`no quality link was texted to ${phone}`);
}

export const STANDARD: Requirement[] = [
  { id: "checklist-complete", kind: "checklist_completion", label: "Every checklist item is marked done, or skipped with a reason", level: "required", responsible: "crew", phase: "completion" },
  { id: "after-photos", kind: "required_evidence", label: "At least 2 after photos", level: "required", responsible: "crew", phase: "completion", evidence: { photoKind: "after", minPhotos: 2 } },
];

export type Item = { label: string; state: "done" | "skipped" | "pending"; skipReason?: string; requiresPhoto?: boolean };

export async function qualitySetup(options: { plan?: "expand" | "operate" | null } = {}) {
  const s = await retentionSetup();
  const { t, as, companyId } = s;
  await t.run(async (ctx) => {
    await ctx.db.patch(companyId, { plan: options.plan === undefined ? "expand" : (options.plan ?? undefined) });
  });
  const db = <R>(work: Parameters<typeof t.run>[0]) => t.run(work) as Promise<R>;
  const helpers = {
    ...s,
    /** Publishes the company default standard. */
    publishCompany: async (requirements: Requirement[] = STANDARD) => {
      const { standardId } = await as.mutation(api.quality.createDraft, { companyId, level: "company", name: "Company standard" });
      await as.mutation(api.quality.saveDraft, { companyId, standardId, name: "Company standard", requirements });
      await as.mutation(api.quality.publish, { companyId, standardId });
      return standardId;
    },
    /**
     * A visit the crew reported done: an accepted assignment (checked in, submitted), its checklist, and
     * photos. Quality is told the way Dispatch tells it, and the scheduled work runs.
     */
    submitted: async (fields: { startsAt?: number; scope?: string; checklist?: Item[]; after?: number; before?: number; cleaners?: ("Lena" | "Rosa")[]; propertyId?: Id<"properties">; customerId?: Id<"customers">; incomplete?: string; report?: string; historical?: boolean } = {}) => {
      const startsAt = fields.startsAt ?? JOB_START;
      const jobId = await dispatchJob(as, companyId, { customerId: fields.customerId ?? s.place.customerId, propertyId: fields.propertyId ?? s.place.propertyId }, { startsAt, endsAt: startsAt + 2 * HOUR });
      if (Date.now() < startsAt + 2 * HOUR + 1) vi.setSystemTime(startsAt + 2 * HOUR + 1);
      await t.run(async (ctx) => {
        if (fields.scope) await ctx.db.patch(jobId, { scope: fields.scope });
        if (fields.historical) {
          const by = (await ctx.db.query("members").collect()).find((m) => m.companyId === companyId)!._id;
          const runId = await ctx.db.insert("migrationImportRuns", { companyId, importKey: `history:${jobId}`, kind: "history", source: "csv", label: "History", results: [], created: 1, skipped: 0, failed: 0, by, createdAt: Date.now() });
          await ctx.db.insert("migrationRecords", { companyId, customerId: fields.customerId ?? s.place.customerId, kind: "history", source: "csv", key: `history:${jobId}`, review: "reference", jobId, runId, selfConfirmed: false, createdAt: Date.now() });
        }
        await ctx.db.patch(jobId, { status: "in_progress", completionReportedAt: startsAt + 2 * HOUR });
        let first: Id<"assignments"> | null = null;
        for (const name of fields.cleaners ?? ["Lena"]) {
          const assignmentId = await ctx.db.insert("assignments", { companyId, jobId, cleanerId: s.cleaners[name], status: "accepted", scope: "As booked", payCents: 8000, offeredAt: startsAt - DAY, respondBy: startsAt - HOUR, respondedAt: startsAt - 2 * HOUR, checkIn: { at: startsAt + 5 * 60_000 }, completion: { submittedAt: startsAt + 2 * HOUR, incomplete: fields.incomplete !== undefined, note: fields.incomplete } });
          first = first ?? assignmentId;
        }
        let order = 0;
        for (const item of fields.checklist ?? []) await ctx.db.insert("checklistItems", { companyId, jobId, order: (order += 1), label: item.label, requiresPhoto: item.requiresPhoto ?? false, state: item.state, skipReason: item.skipReason, byCleanerId: s.cleaners.Lena });
        for (let i = 0; i < (fields.after ?? 0); i += 1) await ctx.db.insert("evidence", { companyId, jobId, assignmentId: first!, cleanerId: s.cleaners.Lena, kind: "after", storageId: await ctx.storage.store(new Blob([`after-${i}`], { type: "image/jpeg" })), clientKey: `after-${jobId}-${i}`, uploadedAt: startsAt + HOUR });
        for (let i = 0; i < (fields.before ?? 0); i += 1) await ctx.db.insert("evidence", { companyId, jobId, assignmentId: first!, cleanerId: s.cleaners.Lena, kind: "before", storageId: await ctx.storage.store(new Blob([`before-${i}`], { type: "image/jpeg" })), clientKey: `before-${jobId}-${i}`, uploadedAt: startsAt + 10 * 60_000 });
        if (fields.report) await ctx.db.insert("jobReports", { companyId, jobId, assignmentId: first!, cleanerId: s.cleaners.Lena, kind: "condition", text: fields.report, status: "acknowledged", createdAt: startsAt + HOUR });
        if (fields.incomplete) await ctx.db.insert("jobReports", { companyId, jobId, assignmentId: first!, cleanerId: s.cleaners.Lena, kind: "incomplete", text: fields.incomplete, status: "acknowledged", createdAt: startsAt + HOUR });
        // What Dispatch does when every crew member has submitted (convex/lib/dispatch/live.ts submitCompletion).
        await handOff(ctx, { companyId, to: "quality", key: reviewKey(jobId), title: "Review the completed visit", question: "The crew reported this visit complete. Review it, then close the visit or send it back.", trigger: "Every cleaner on the visit submitted completion.", completionCondition: "A person reviewed the evidence and closed the visit or arranged corrective work", escalation: "The visit stays open until someone reviews it.", dueAt: Date.now() + DAY, about: { table: "jobs", id: jobId }, actor: { kind: "agent", agent: "dispatch" } });
        await qualityOnCompletionReported(ctx, (await ctx.db.get(jobId))!);
      });
      await flush(t);
      return jobId;
    },
    /** A cleaner adds a photo after submitting (as through a link), and Quality hears of it. */
    addPhoto: async (jobId: Id<"jobs">, kind: "after" | "before" | "item" = "after") => {
      await t.run(async (ctx) => {
        const assignment = (await ctx.db.query("assignments").withIndex("by_company_job", (q) => q.eq("companyId", companyId).eq("jobId", jobId)).collect()).find((a) => a.status === "accepted")!;
        await ctx.db.insert("evidence", { companyId, jobId, assignmentId: assignment._id, cleanerId: assignment.cleanerId, kind, storageId: await ctx.storage.store(new Blob(["late"], { type: "image/jpeg" })), clientKey: `late-${Math.random()}`, uploadedAt: Date.now() });
        await qualityOnEvidence(ctx, (await ctx.db.get(jobId))!);
      });
    },
    /** Lets time pass (the combine window, a due date) and runs what is due, including Quality's sweep. */
    later: async (ms: number) => {
      // Fake timers move the clock and fire what was scheduled for then (a delayed review, a due date).
      vi.advanceTimersByTime(ms);
      await t.finishInProgressScheduledFunctions();
      await t.mutation(internal.qualityWork.sweep, {});
      await flush(t);
    },
    reviews: () => db<Doc<"qualityReviews">[]>(async (ctx) => (await ctx.db.query("qualityReviews").collect()).filter((r) => r.companyId === companyId)),
    qcases: () => db<Doc<"qualityCases">[]>(async (ctx) => (await ctx.db.query("qualityCases").collect()).filter((r) => r.companyId === companyId)),
    findings: () => db<Doc<"qualityFindings">[]>(async (ctx) => (await ctx.db.query("qualityFindings").collect()).filter((r) => r.companyId === companyId)),
    requests: () => db<Doc<"qualityRequests">[]>(async (ctx) => (await ctx.db.query("qualityRequests").collect()).filter((r) => r.companyId === companyId)),
    corrections: () => db<Doc<"qualityCorrections">[]>(async (ctx) => (await ctx.db.query("qualityCorrections").collect()).filter((r) => r.companyId === companyId)),
    runs: () => db<Doc<"qualityRuns">[]>(async (ctx) => (await ctx.db.query("qualityRuns").collect()).filter((r) => r.companyId === companyId)),
    qualityMessages: () => db<Doc<"messages">[]>(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.companyId === companyId && m.qualityRequestId !== undefined)),
    qualityApprovals: async () => (await as.query(api.approvals.list, { companyId })).filter((row) => row.agent === "quality"),
    /** The Owner lets Quality ask cleaners without asking first. */
    trustRequests: async () => {
      for (const action of ["quality.request_cleaner_evidence", "quality.remind_outstanding"]) await as.mutation(api.permissions.set, { companyId, action, level: "execute" });
    },
    caseDetail: (caseId: Id<"qualityCases">) => as.query(api.quality.caseDetail, { companyId, caseId }),
  };
  return helpers;
}
