/**
 * Standing rules kept from approval decisions. A person who skips a proposal for a reason that will hold
 * next time ("the customer asked for someone else") can keep it, and the agent stops proposing it. Owners
 * and Managers see every rule and can remove one; the agent may then propose it again.
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { owned } from "./lib/access";
import { managerMutation, managerQuery, type MemberAccess } from "./lib/builders";
import { byMember, recordEvent } from "./lib/events";

type OfferProposal = Extract<NonNullable<Doc<"approvals">["proposal"]>, { kind: "offer_assignment" }>;

/** Dispatch will not propose this cleaner for this customer again. One rule per pair. */
export async function keepAvoidRule(ctx: MutationCtx & MemberAccess, approval: Doc<"approvals">, proposal: OfferProposal, why: string) {
  const job = await ctx.db.get(proposal.jobId);
  if (!job || job.companyId !== ctx.companyId) return;
  const existing = await ctx.db
    .query("approvalRules")
    .withIndex("by_company_customer", (q) => q.eq("companyId", ctx.companyId).eq("customerId", job.customerId))
    .take(200);
  if (existing.some((row) => row.cleanerId === proposal.cleanerId)) return;
  const ruleId = await ctx.db.insert("approvalRules", {
    companyId: ctx.companyId,
    kind: "avoid_cleaner_for_customer",
    cleanerId: proposal.cleanerId,
    customerId: job.customerId,
    why: why.slice(0, 500),
    approvalId: approval._id,
    createdBy: ctx.member._id,
    createdAt: Date.now(),
  });
  await recordEvent(ctx, { companyId: ctx.companyId, type: "approval_rule.kept", actor: byMember(ctx), subject: { table: "cleaners", id: proposal.cleanerId }, data: { kind: "avoid_cleaner_for_customer", ruleId, approvalId: approval._id, customerId: job.customerId } });
}

export type StandingRule = { ruleId: Doc<"approvalRules">["_id"]; words: string; why: string; by: string; at: number };

export const list = managerQuery({
  args: {},
  handler: async (ctx): Promise<StandingRule[]> => {
    const rows = await ctx.db
      .query("approvalRules")
      .withIndex("by_company_created", (q) => q.eq("companyId", ctx.companyId))
      .order("desc")
      .take(200);
    const out: StandingRule[] = [];
    for (const row of rows) {
      const cleaner = await ctx.db.get(row.cleanerId);
      const customer = await ctx.db.get(row.customerId);
      const member = await ctx.db.get(row.createdBy);
      out.push({ ruleId: row._id, words: `Dispatch does not propose ${cleaner?.name ?? "a removed cleaner"} for ${customer?.name ?? "a removed customer"}`, why: row.why, by: member?.name ?? "A former member", at: row.createdAt });
    }
    return out;
  },
});

export const remove = managerMutation({
  args: { ruleId: v.id("approvalRules") },
  handler: async (ctx, args) => {
    const rule = await owned(ctx, args.ruleId);
    await ctx.db.delete(rule._id);
    await recordEvent(ctx, { companyId: ctx.companyId, type: "approval_rule.removed", actor: byMember(ctx), subject: { table: "cleaners", id: rule.cleanerId }, data: { kind: rule.kind, ruleId: rule._id, customerId: rule.customerId } });
  },
});
