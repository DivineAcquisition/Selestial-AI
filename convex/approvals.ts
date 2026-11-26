/**
 * The one approval queue (brief, sections 2 and 7). An agent on Propose prepares an action and its
 * reason; a person approves, changes or skips it. Owners and Managers decide. Agents cannot: there is no
 * public function that creates or decides an approval on an agent's word.
 */
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { owned } from "./lib/access";
import { requestApproval } from "./lib/approvalQueue";
import { decisionNote, NEEDS_ONE_BY_ONE, reasonsFor, type DecisionReason } from "./lib/approvalReasons";
import { keepAvoidRule } from "./approvalRules";
import { managerMutation, managerQuery, type MemberAccess } from "./lib/builders";
import { departmentOf } from "./lib/departments";
import { actionDef } from "./lib/permissionCatalog";
import type { UserErrorData } from "./lib/errors";
import { afterDecision, afterExpiry, type CarriedOut } from "./lib/dispatch/workflow";
import { isOwner } from "./lib/roles";
import { afterSalesDecision, afterSalesExpiry } from "./bookings";
import { afterAgentDecision, afterAgentExpiry, isAgentProposal } from "./lib/sales/agentApprovals";
import { afterPlanDecision } from "./plans";
import { afterProposalDecision } from "./proposals";
import { afterRecruiterDecision, afterRecruiterExpiry, isRecruiterProposal } from "./lib/recruiter/approvals";
import { afterFollowUpDecision, afterFollowUpExpiry } from "./lib/cleaners/followUps";
import { afterRetentionDecision, afterRetentionExpiry, isRetentionProposal, ownerOnly } from "./lib/retention/approvals";
import { afterQualityDecision, afterQualityExpiry, isQualityProposal } from "./lib/quality/approvals";
import { afterCareDecision, afterCareExpiry, isCareProposal } from "./lib/clientCare/approvals";
import { userError } from "./lib/errors";
import { mayDecide } from "./lib/controls/readiness";
import { byMember, recordEvent } from "./lib/events";
import { approvalStatusValidator } from "./lib/statuses";
import { optionalText } from "./lib/text";
import { aboutValidator, proposalValidator } from "./schema";

export { requestApproval } from "./lib/approvalQueue";

export const request = internalMutation({
  args: {
    companyId: v.id("companies"),
    action: v.string(),
    summary: v.string(),
    reason: v.string(),
    decideBy: v.number(),
    authorizes: v.optional(v.string()),
    ifWaiting: v.optional(v.string()),
    proposal: v.optional(proposalValidator),
    about: v.optional(aboutValidator),
    taskId: v.optional(v.id("tasks")),
    suggestedReasons: v.optional(v.object({ skip: v.optional(v.array(v.object({ code: v.string(), label: v.string() }))), change: v.optional(v.array(v.object({ code: v.string(), label: v.string() }))) })),
  },
  handler: async (ctx, args) => requestApproval(ctx, args),
});

export const list = managerQuery({
  args: { status: v.optional(approvalStatusValidator) },
  handler: async (ctx, args) =>
    ctx.db
      .query("approvals")
      .withIndex("by_company_status_decideBy", (q) => q.eq("companyId", ctx.companyId).eq("status", args.status ?? "pending"))
      .take(200),
});

export const get = managerQuery({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, args) => owned(ctx, args.approvalId),
});

/**
 * approved: do it as proposed. changed: the person does it their way, and says how. skipped: do not do it.
 * A proposal that carries its action as data is carried out here, in the same step, after every check is
 * run again. The answer says whether it was carried out, and why not if it was not. A proposal without
 * one is a recommendation: deciding records the decision and a person carries it out.
 */
export const decide = managerMutation({
  args: {
    approvalId: v.id("approvals"),
    decision: v.union(v.literal("approved"), v.literal("changed"), v.literal("skipped")),
    /** One of the reasons offered for this proposal (reasonsFor). The note then adds to it. */
    reasonCode: v.optional(v.string()),
    note: v.optional(v.string()),
    /** Keep the reason as a standing rule. Only a reason that offers one (its `remember` words) can be kept. */
    remember: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ carriedOut: CarriedOut | null }> => {
    const approval = await owned(ctx, args.approvalId);
    const checked = await checkDecision(ctx, approval, args);
    return applyDecision(ctx, approval, args, checked);
  },
});

type DecisionInput = { decision: "approved" | "changed" | "skipped"; reasonCode?: string; note?: string; remember?: boolean };
type Checked = { reason: DecisionReason | null; note: string | undefined };

/**
 * Every rule that can refuse a decision, run before anything is written. A refusal here leaves the
 * approval and everything around it exactly as it was, so a batch can turn one item away and go on.
 */
async function checkDecision(ctx: MutationCtx & MemberAccess, approval: Doc<"approvals">, args: DecisionInput): Promise<Checked> {
  if (approval.status !== "pending") throw userError(`This was already ${approval.status}.`);
  // Who decides is the Owner's routing for this action (Agent Controls). It never lets anyone past an owner-only rule below.
  const routed = await mayDecide(ctx, ctx.company, approval.action, ctx.member);
  if (!routed.ok) throw userError(routed.words, "not_allowed");
  const owner = ownerDecides(approval, args.decision);
  if (owner && !isOwner(ctx.role)) throw userError(owner);
  const words = optionalText(args.note, "The note", 2000);
  let reason: DecisionReason | null = null;
  if (args.reasonCode !== undefined) {
    if (args.decision === "approved") throw userError("Approving takes no reason.");
    const offered = reasonsFor(approval)[args.decision === "changed" ? "change" : "skip"];
    reason = offered.find((row) => row.code === args.reasonCode) ?? null;
    if (!reason) throw userError("Choose one of the reasons offered, or write your own.");
  }
  const note = decisionNote(reason, words);
  if (args.decision === "changed" && !note) throw userError("Say what to change.");
  if (args.remember && !reason?.remember) throw userError("That reason cannot be kept as a standing rule.");
  return { reason, note };
}

/** Why only the Owner may make this decision, or null. */
function ownerDecides(approval: Doc<"approvals">, decision: DecisionInput["decision"]): string | null {
  // Prices are the Owner's: a changed price, a recurring price change and custom proposal rates wait for them.
  const kind = approval.proposal?.kind;
  if (kind === "sales_price_override" || kind === "plan_change" || kind === "proposal_rates") return "Only the Owner decides price changes.";
  if (kind === "retention_action" && ownerOnly(approval) && decision === "approved") return "Only the Owner approves refunds and compensation above the limit.";
  return null;
}

async function applyDecision(ctx: MutationCtx & MemberAccess, approval: Doc<"approvals">, args: DecisionInput, { reason, note }: Checked): Promise<{ carriedOut: CarriedOut | null }> {
  const kind = approval.proposal?.kind;
  // The rule is in place before the agent looks again below, so its next proposal already follows it.
  if (args.remember && note && approval.proposal?.kind === "offer_assignment") await keepAvoidRule(ctx, approval, approval.proposal, note);
  const decided = { status: args.decision, decidedBy: ctx.member._id, decidedAt: Date.now(), note, ...(reason ? { reasonCode: reason.code } : {}) };
  await ctx.db.patch(approval._id, decided);
  await recordEvent(ctx, { companyId: ctx.companyId, type: `approval.${args.decision}`, actor: byMember(ctx), subject: { table: "approvals", id: approval._id }, data: { action: approval.action, ...(reason ? { reasonCode: reason.code } : {}) } });
  const decidedApproval = { ...approval, ...decided };
  // Each agent carries out its own proposals. Whichever it is, every check runs again at this moment.
  if (approval.proposal?.kind === "send_cleaner_follow_up") {
    const result = await afterFollowUpDecision(ctx, decidedApproval, args.decision, byMember(ctx));
    const carriedOut = { ok: result.ok, detail: result.detail, at: Date.now() };
    await ctx.db.patch(approval._id, { carriedOut });
    return { carriedOut };
  }
  if (isRecruiterProposal(approval)) return { carriedOut: await afterRecruiterDecision(ctx, decidedApproval, args.decision, byMember(ctx)) };
  if (isAgentProposal(approval)) return { carriedOut: await afterAgentDecision(ctx, decidedApproval, args.decision, byMember(ctx)) };
  if (isRetentionProposal(approval)) return { carriedOut: await afterRetentionDecision(ctx, decidedApproval, args.decision, byMember(ctx)) };
  if (isQualityProposal(approval)) return { carriedOut: await afterQualityDecision(ctx, decidedApproval, args.decision, byMember(ctx)) };
  if (isCareProposal(approval)) return { carriedOut: await afterCareDecision(ctx, decidedApproval, args.decision, byMember(ctx)) };
  if (kind === "sales_payment_link" || kind === "sales_price_override" || kind === "plan_change" || kind === "proposal_rates") {
    const carriedOut = kind === "plan_change" ? await afterPlanDecision(ctx, decidedApproval, args.decision) : kind === "proposal_rates" ? await afterProposalDecision(ctx, decidedApproval, args.decision) : await afterSalesDecision(ctx, decidedApproval, args.decision);
    await ctx.db.patch(approval._id, { carriedOut });
    return { carriedOut };
  }
  return { carriedOut: await afterDecision(ctx, decidedApproval, args.decision, byMember(ctx)) };
}

/** Approvals a person should read one at a time: prices, money above the limit, and hiring outcomes. Never approved in bulk. */
export function needsOneByOne(approval: Doc<"approvals">): boolean {
  const kind = approval.proposal?.kind;
  if (kind && (NEEDS_ONE_BY_ONE as readonly string[]).includes(kind)) return true;
  return kind === "retention_action" && ownerOnly(approval);
}

const MAX_BATCH = 10;

export type BatchResult = { id: Id<"approvals">; ok: boolean; message?: string; carriedOut?: CarriedOut | null };

/**
 * Deciding up to ten approvals in one step, each with every check its own decision runs. One that is
 * refused (already decided, not this person's, needs reading one by one) is reported and the rest go on.
 */
export const decideMany = managerMutation({
  args: {
    approvalIds: v.array(v.id("approvals")),
    decision: v.union(v.literal("approved"), v.literal("skipped")),
    reasonCode: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<BatchResult[]> => {
    if (args.approvalIds.length > MAX_BATCH) throw userError(`Decide at most ${MAX_BATCH} at a time.`);
    const out: BatchResult[] = [];
    for (const id of new Set(args.approvalIds)) {
      const approval = await ctx.db.get(id);
      if (!approval || approval.companyId !== ctx.companyId) {
        out.push({ id, ok: false, message: "This approval no longer exists." });
        continue;
      }
      if (args.decision === "approved" && needsOneByOne(approval)) {
        out.push({ id, ok: false, message: "This one needs to be reviewed on its own." });
        continue;
      }
      const input = { decision: args.decision, reasonCode: args.reasonCode, note: args.note };
      let checked: Checked;
      try {
        checked = await checkDecision(ctx, approval, input);
      } catch (caught) {
        if (!(caught instanceof ConvexError)) throw caught;
        out.push({ id, ok: false, message: (caught.data as UserErrorData).message });
        continue;
      }
      // Past the checks nothing is caught: a failure while carrying one out undoes the whole batch, never half of one.
      const { carriedOut } = await applyDecision(ctx, approval, input, checked);
      out.push({ id, ok: true, carriedOut });
    }
    return out;
  },
});

export type QueueGroup = {
  key: string;
  department: string;
  agent: Doc<"approvals">["agent"];
  actionLabel: string;
  count: number;
  earliestDeadline: number;
  overdue: number;
  samples: string[];
  ids: Id<"approvals">[];
  /** "review": prices, money above the limit or hiring outcomes, read one by one. */
  risk: "routine" | "review";
  canDecide: boolean;
  /** Why this person cannot decide these, when they cannot. */
  notYours: string | null;
  /** Skip reasons every approval in the group offers. */
  skipReasons: DecisionReason[];
};

const SUMMARY_LIMIT = 2000;

/** The whole pending queue in groups, by department and kind of action, read from the approvals alone so it stays cheap at any size. */
export const queueSummary = managerQuery({
  args: { asOf: v.number() },
  handler: async (ctx, args): Promise<{ total: number; overdue: number; groups: QueueGroup[]; truncated: boolean }> => {
    const pending = await ctx.db
      .query("approvals")
      .withIndex("by_company_status_decideBy", (q) => q.eq("companyId", ctx.companyId).eq("status", "pending"))
      .take(SUMMARY_LIMIT + 1);
    const truncated = pending.length > SUMMARY_LIMIT;
    const rows = pending.slice(0, SUMMARY_LIMIT);
    const routing = new Map<string, Awaited<ReturnType<typeof mayDecide>>>();
    const groups = new Map<string, QueueGroup>();
    for (const approval of rows) {
      const risk = needsOneByOne(approval) ? "review" : "routine";
      const key = `${approval.action}:${risk}`;
      if (!routing.has(approval.action)) routing.set(approval.action, await mayDecide(ctx, ctx.company, approval.action, ctx.member));
      const routed = routing.get(approval.action)!;
      const owner = ownerDecides(approval, "approved");
      const notYours = !routed.ok ? routed.words : owner && !isOwner(ctx.role) ? owner : null;
      const skip = reasonsFor(approval).skip.filter((reason) => !reason.suggested).map(({ code, label }) => ({ code, label }));
      let group = groups.get(key);
      if (!group) {
        group = { key, department: departmentOf(approval.agent).name, agent: approval.agent, actionLabel: actionDef(approval.action)?.label ?? approval.action, count: 0, earliestDeadline: approval.decideBy, overdue: 0, samples: [], ids: [], risk, canDecide: true, notYours: null, skipReasons: skip };
        groups.set(key, group);
      }
      group.count += 1;
      group.ids.push(approval._id);
      group.earliestDeadline = Math.min(group.earliestDeadline, approval.decideBy);
      if (approval.decideBy <= args.asOf) group.overdue += 1;
      if (group.samples.length < 5) group.samples.push(approval.summary);
      if (notYours) {
        group.canDecide = false;
        group.notYours = notYours;
      }
      group.skipReasons = group.skipReasons.filter((reason) => skip.some((row) => row.code === reason.code));
    }
    const list = [...groups.values()].sort((a, b) => a.department.localeCompare(b.department) || b.count - a.count || a.actionLabel.localeCompare(b.actionLabel));
    return { total: rows.length, overdue: list.reduce((sum, group) => sum + group.overdue, 0), groups: list, truncated };
  },
});

/** Run on a schedule: a proposal nobody decided in time expires. It is never treated as approved. */
export const expireDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.db
      .query("approvals")
      .withIndex("by_status_decideBy", (q) => q.eq("status", "pending").lt("decideBy", Date.now()))
      .take(100);
    for (const approval of due) {
      await ctx.db.patch(approval._id, { status: "expired" });
      await recordEvent(ctx, { companyId: approval.companyId, type: "approval.expired", actor: { kind: "system" }, subject: { table: "approvals", id: approval._id }, data: { action: approval.action } });
      if (approval.proposal?.kind === "send_cleaner_follow_up") await afterFollowUpExpiry(ctx, { ...approval, status: "expired" });
      else if (isRecruiterProposal(approval)) await afterRecruiterExpiry(ctx, { ...approval, status: "expired" });
      else if (approval.proposal?.kind === "sales_payment_link") await afterSalesExpiry(ctx, approval);
      else if (isAgentProposal(approval)) await afterAgentExpiry(ctx, { ...approval, status: "expired" });
      else if (isRetentionProposal(approval)) await afterRetentionExpiry(ctx, { ...approval, status: "expired" });
      else if (isQualityProposal(approval)) await afterQualityExpiry(ctx, { ...approval, status: "expired" });
      else if (isCareProposal(approval)) await afterCareExpiry(ctx, { ...approval, status: "expired" });
      else await afterExpiry(ctx, { ...approval, status: "expired" });
    }
    return due.length;
  },
});
