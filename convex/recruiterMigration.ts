/**
 * Moving existing companies onto findings, once, without sending anything.
 *
 *   1. Choices kept: interview reminders used to go by themselves whenever interviews were on, so a company
 *      that had interviews on keeps automatic interview reminders. Every other new automatic send starts off.
 *   2. Routine approvals waiting in the queue (an application invitation, a reminder) become prepared
 *      messages. The approval is closed as moved; nothing is sent, and the old approval can no longer be
 *      approved, so the same message cannot go twice by both paths.
 *   3. Every open application gets its finding.
 *
 * Safe to run again: each step looks before it writes. Run with `npx convex run recruiterMigration:start`.
 *
 * Retention: `inventory` counts what earlier builds kept from mail now outside the recruiting boundary. Nothing
 * is deleted by it. `clearOutside` clears that content, and runs only when someone runs it on purpose.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { authorityFor } from "./lib/authority";
import { snapshotOf, writePermission } from "./lib/controls/policy";
import { recordEvent } from "./lib/events";
import { actionDef } from "./lib/permissionCatalog";
import { setStage, SYSTEM } from "./lib/recruiter/applications";
import { refresh } from "./lib/recruiter/findings";
import { ACTIVE_STAGES } from "./lib/recruiter/schema";

const MOVED = "Moved to Recruiter's prepared messages when routine messages stopped needing approval. Nothing was sent.";

export async function migrateCompany(ctx: MutationCtx, company: Doc<"companies">): Promise<{ kept: string[]; moved: number; findings: number }> {
  const kept: string[] = [];
  const owner = (
    await ctx.db
      .query("members")
      .withIndex("by_company", (q) => q.eq("companyId", company._id))
      .take(200)
  ).find((member) => member.role === "owner" && member.status === "active");

  // 1. Interview reminders keep going by themselves where they did.
  const reminder = actionDef("recruiter.interview_reminder")!;
  const existing = await ctx.db
    .query("permissions")
    .withIndex("by_company_action", (q) => q.eq("companyId", company._id).eq("action", reminder.key))
    .unique();
  if (!existing && owner) {
    const interviews = await authorityFor(ctx, company._id, "recruiter.run_interview");
    const level = interviews.kind === "level" && interviews.level !== "off" ? "execute" : interviews.kind === "paused" ? "execute" : "off";
    await writePermission(ctx, company._id, reminder, { ...snapshotOf(reminder, undefined), level }, owner._id, undefined);
    kept.push(`interview reminders: ${level}`);
  }

  // 2. Routine approvals waiting in the queue.
  let moved = 0;
  const pending = await ctx.db
    .query("approvals")
    .withIndex("by_company_status_decideBy", (q) => q.eq("companyId", company._id).eq("status", "pending"))
    .take(500);
  for (const approval of pending) {
    const kind = approval.proposal?.kind;
    if (kind !== "send_invitation" && kind !== "send_follow_up") continue;
    await ctx.db.patch(approval._id, { status: "expired", carriedOut: { ok: false, detail: MOVED, at: Date.now() } });
    if (kind === "send_invitation") {
      const application = await ctx.db.get(approval.proposal!.applicationId);
      if (application?.stage === "invitation_awaiting_approval") await setStage(ctx, application, "received", SYSTEM, { invitationApprovalId: undefined, nextAction: { what: "Send the application link", by: "owner", dueAt: Date.now() + 86_400_000 } });
    }
    moved += 1;
  }

  // 3. A finding for every open application. Nothing is carried out here.
  let findings = 0;
  for (const stage of ACTIVE_STAGES) {
    const rows = await ctx.db
      .query("applications")
      .withIndex("by_company_stage", (q) => q.eq("companyId", company._id).eq("stage", stage))
      .take(500);
    for (const row of rows) if (await refresh(ctx, row._id)) findings += 1;
  }
  if (kept.length || moved || findings) await recordEvent(ctx, { companyId: company._id, type: "recruiter.moved_to_findings", actor: SYSTEM, subject: { table: "companies", id: company._id }, data: { moved, findings, kept: kept.join("; ") } });
  return { kept, moved, findings };
}

/** Starts the move for every company, a few at a time. */
export const start = internalMutation({
  args: { after: v.optional(v.id("companies")) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("companies")
      .filter((q) => (args.after ? q.gt(q.field("_id"), args.after) : true))
      .take(10);
    for (const company of page) await migrateCompany(ctx, company);
    if (page.length === 10) await ctx.scheduler.runAfter(0, internal.recruiterMigration.start, { after: page[page.length - 1]._id });
    return page.length;
  },
});

/**
 * What earlier builds kept from mail now outside the boundary: board advertising and suggested candidates
 * with a sender or subject, and "needs review" mail with an excerpt that was never filed under an application.
 */
export const inventory = internalQuery({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const counts: Record<string, { rows: number; withSender: number; withSubject: number; withText: number }> = {};
    for (const classification of ["promotion", "suggested_candidate", "needs_review", "unrelated"] as const) {
      const rows = await ctx.db
        .query("sourceMessages")
        .withIndex("by_company_classification", (q) => q.eq("companyId", args.companyId).eq("classification", classification))
        .take(5000);
      const outside = rows.filter((row) => !row.applicationId);
      counts[classification] = { rows: outside.length, withSender: outside.filter((row) => row.fromAddress).length, withSubject: outside.filter((row) => row.subject).length, withText: outside.filter((row) => row.excerpt).length };
    }
    return counts;
  },
});

/** Clears what `inventory` found, for one company: only content, never the id that stops a message being filed twice. */
export const clearOutside = internalMutation({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    let cleared = 0;
    for (const classification of ["promotion", "suggested_candidate", "needs_review"] as const) {
      const rows = await ctx.db
        .query("sourceMessages")
        .withIndex("by_company_classification", (q) => q.eq("companyId", args.companyId).eq("classification", classification))
        .take(2000);
      for (const row of rows) {
        if (row.applicationId || (!row.fromAddress && !row.subject && !row.excerpt && !row.replyTo)) continue;
        await ctx.db.patch(row._id, { fromAddress: undefined, replyTo: undefined, subject: undefined, excerpt: undefined, attachments: undefined, reason: undefined, flag: undefined, ...(classification === "needs_review" ? { classification: "unrelated" as const } : {}) });
        cleared += 1;
      }
    }
    await recordEvent(ctx, { companyId: args.companyId, type: "recruiter.cleared_outside_boundary", actor: SYSTEM, subject: { table: "companies", id: args.companyId }, data: { cleared } });
    return cleared;
  },
});

export type MigrationResult = Awaited<ReturnType<typeof migrateCompany>>;
