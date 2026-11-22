/**
 * Recruiter › Onboarding & Readiness (docs/recruiter/06-readiness.md). Each onboarding lists what the new
 * worker still needs, read from the shared cleaner record; a named person records each item. When every item
 * is met, an Owner approves readiness: the hiring record closes as hired, the engagement becomes active, and
 * Dispatch may consider the worker, still checking each visit itself.
 */
import { v } from "convex/values";

import { owned } from "./lib/access";
import { companyQuery, managerMutation, ownerMutation } from "./lib/builders";
import { payWords } from "./lib/recruiter/offers";
import { approveReadiness, completeHandoff, readinessSummary, recordRequirement } from "./lib/recruiter/handoff";

export const queue = companyQuery({
  args: { status: v.optional(v.union(v.literal("open"), v.literal("complete"), v.literal("cancelled"))) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("onboardingHandoffs")
      .withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", args.status ?? "open"))
      .take(200);
    const out = [];
    for (const handoff of rows) {
      const applicant = await ctx.db.get(handoff.applicantId);
      const cleaner = await ctx.db.get(handoff.cleanerId);
      const responsible = await ctx.db.get(handoff.responsibleId);
      const readiness = cleaner ? await readinessSummary(ctx, ctx.company, handoff, cleaner, Date.now()) : null;
      out.push({
        handoffId: handoff._id,
        applicationId: handoff.applicationId,
        applicant: applicant?.name ?? cleaner?.name ?? null,
        role: handoff.terms.role,
        // Pay is the Owner's. Everyone else sees the role and the relationship, never the terms.
        approvedTerms: ctx.role === "owner" ? { ...handoff.terms, payWords: payWords(handoff.terms.pay) } : { role: handoff.terms.role, engagement: handoff.terms.engagement },
        /** What the applicant told us. None of it is verified by being here. */
        information: handoff.information,
        requirements: handoff.requirements,
        responsible: responsible?.name ?? null,
        nextAction: handoff.nextAction,
        dueAt: handoff.dueAt,
        status: handoff.status,
        cleanerId: handoff.cleanerId,
        workerStatus: cleaner?.status ?? null,
        /** The readiness summary: each item's state and who confirmed it, open decisions, and whether it can be approved. */
        readiness,
        /** Ready for assignments: an active engagement with every requirement for work met (lib/cleaners/readiness.ts). */
        dispatchReady: readiness?.dispatchEligible ?? false,
      });
    }
    return out;
  },
});

export const record = managerMutation({
  args: { handoffId: v.id("onboardingHandoffs"), requirement: v.string(), done: v.boolean(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await recordRequirement(ctx, await owned(ctx, args.handoffId), args.requirement, args.done, ctx.member, args.note);
    return null;
  },
});

export const complete = ownerMutation({
  args: { handoffId: v.id("onboardingHandoffs") },
  handler: async (ctx, args) => {
    await completeHandoff(ctx, await owned(ctx, args.handoffId), ctx.member);
    return null;
  },
});

/** An Owner approves readiness. Approving again changes nothing and sends nothing. */
export const approve = ownerMutation({
  args: { handoffId: v.id("onboardingHandoffs"), acknowledgeRestriction: v.optional(v.boolean()) },
  handler: async (ctx, args) => approveReadiness(ctx, await owned(ctx, args.handoffId), ctx.member, { acknowledgeRestriction: args.acknowledgeRestriction }),
});
