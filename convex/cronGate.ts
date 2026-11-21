/**
 * The one door every scheduled job goes through (convex/crons.ts). On a backend holding restored data
 * (SELESTIAL_DEPLOYMENT=restore) nothing runs: no offer expires, no reminder is prepared, no sweep retries
 * work that already happened before the backup was taken. Everywhere else the job runs as it always did,
 * one scheduler hop later. Docs: docs/operations/02-isolation-and-restore.md.
 */
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { jobsAllowed } from "./lib/operations/deployment";

type Job = FunctionReference<"mutation" | "action", "internal">;

const JOBS: Record<string, Job> = {
  "assignments.expireDue": internal.assignments.expireDue,
  "approvals.expireDue": internal.approvals.expireDue,
  "setupProgress.catchUp": internal.setupProgress.catchUp,
  "dispatch.sweep": internal.dispatch.sweep,
  "dispatchOps.monitor": internal.dispatchOps.monitor,
  "financeStripe.reconcile": internal.financeStripe.reconcile,
  "financeMessages.sweep": internal.financeMessages.sweep,
  "teamPay.sweep": internal.teamPay.sweep,
  "messaging.sweepStuck": internal.messaging.sweepStuck,
  "notifications.hourly": internal.notifications.hourly,
  "dataRights.expireExports": internal.dataRights.expireExports,
  "retention.purge": internal.retention.purge,
  "recruiterInbox.sweep": internal.recruiterInbox.sweep,
  "recruiter.followUps": internal.recruiter.followUps,
  "recruiter.interviewReminders": internal.recruiter.interviewReminders,
  "recruiter.retention": internal.recruiter.retention,
  "chatRuns.sweep": internal.chatRuns.sweep,
  "agreementSigning.sweep": internal.agreementSigning.sweep,
  "agreementRenewals.sweep": internal.agreementRenewals.sweep,
  "servicePlans.bookAll": internal.servicePlans.bookAll,
  "propertyPrices.sweep": internal.propertyPrices.sweep,
  "agreementFiles.cleanup": internal.agreementFiles.cleanup,
  "media.sweep": internal.media.sweep,
  "billing.sweep": internal.billing.sweep,
  "messagingBilling.sweep": internal.messagingBilling.sweep,
  "texting.chargeNumbers": internal.texting.chargeNumbers,
  "texting.reconcile": internal.texting.reconcile,
  "texting.checkAllActive": internal.texting.checkAllActive,
  "googleWork.tick": internal.googleWork.tick,
  "googleCalendar.sweep": internal.googleCalendar.sweep,
  "googleBusiness.sweep": internal.googleBusiness.sweep,
  "googleAds.sweepLocalServices": internal.googleAds.sweepLocalServices,
  "googleAds.sweepConversions": internal.googleAds.sweepConversions,
  "googleRoutes.sweep": internal.googleRoutes.sweep,
  "recruiterGmailWatch.sweep": internal.recruiterGmailWatch.sweep,
  "cleanerFollowUps.sweep": internal.cleanerFollowUps.sweep,
  "requirements.expireDue": internal.requirements.expireDue,
  "bookingOps.sweep": internal.bookingOps.sweep,
  "bookings.sweep": internal.bookings.sweep,
  "plans.sweep": internal.plans.sweep,
  "proposals.sweep": internal.proposals.sweep,
  "pipeline.sweep": internal.pipeline.sweep,
  "salesAgent.sweep": internal.salesAgent.sweep,
  "retentionWork.sweep": internal.retentionWork.sweep,
  "retentionInbox.sweep": internal.retentionInbox.sweep,
  "activation.sweep": internal.activation.sweep,
  "operations.monitor": internal.operations.monitor,
};

export const JOB_NAMES: string[] = Object.keys(JOBS);

export const gate = internalMutation({
  args: { job: v.string() },
  handler: async (ctx, args) => {
    const job = JOBS[args.job];
    if (!job) throw new Error(`Unknown job ${args.job}`);
    if (!jobsAllowed()) return "held" as const;
    await ctx.scheduler.runAfter(0, job, {});
    return "scheduled" as const;
  },
});
