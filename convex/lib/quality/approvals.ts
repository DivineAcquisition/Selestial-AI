/**
 * Carrying out a decision made in the shared approvals queue on something Quality prepared. Every check runs
 * again at that moment: approving one request grants nothing beyond it, a request whose evidence moved on is
 * not sent, and silence is never approval.
 */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { Actor } from "../events";
import { recordEvent } from "../events";
import { carryOutRequest } from "./requests";
import { adoptImprovement } from "./improvements";

export function isQualityProposal(approval: Pick<Doc<"approvals">, "proposal">): boolean {
  return approval.proposal?.kind === "quality_request" || approval.proposal?.kind === "quality_improvement";
}

async function record(ctx: MutationCtx, approval: Doc<"approvals">, result: { ok: boolean; detail: string }) {
  const carriedOut = { ...result, at: Date.now() };
  await ctx.db.patch(approval._id, { carriedOut });
  return carriedOut;
}

export async function afterQualityDecision(ctx: MutationCtx, approval: Doc<"approvals">, decision: "approved" | "changed" | "skipped", decidedBy: Actor) {
  const proposal = approval.proposal;
  if (!proposal) return null;
  const company = await ctx.db.get(approval.companyId);
  if (!company) return record(ctx, approval, { ok: false, detail: "Not carried out. The company no longer exists." });
  const member = decidedBy.kind === "member" ? await ctx.db.get(decidedBy.memberId) : null;
  if (!member) return record(ctx, approval, { ok: false, detail: "Not carried out. Only a person can decide this." });
  if (proposal.kind === "quality_request") {
    const request = await ctx.db.get(proposal.requestId);
    if (!request || request.companyId !== approval.companyId) return record(ctx, approval, { ok: false, detail: "Not carried out. The request no longer exists." });
    if (request.status !== "awaiting_approval") return record(ctx, approval, { ok: false, detail: `Not carried out. The request was already ${request.status.replace(/_/g, " ")}.` });
    await ctx.db.patch(request._id, { approvalId: undefined });
    if (decision !== "approved") {
      await ctx.db.patch(request._id, { status: "cancelled", result: decision === "changed" ? `A person handled it another way: ${approval.note ?? ""}`.slice(0, 400) : "Not approved.", updatedAt: Date.now() });
      return record(ctx, approval, { ok: true, detail: "Set aside. Nothing was sent." });
    }
    if (proposal.stamp !== request.stamp) return record(ctx, approval, { ok: false, detail: "Not carried out. The request was changed after it was sent for approval." });
    await ctx.db.patch(request._id, { status: "prepared" });
    const result = await carryOutRequest(ctx, company, (await ctx.db.get(request._id))!, decidedBy, `${request.permission}: approved by a person`);
    return record(ctx, approval, { ok: result.status === "sent", detail: result.status === "sent" ? result.detail : `Not carried out. ${result.detail}` });
  }
  if (proposal.kind === "quality_improvement") {
    const improvement = await ctx.db.get(proposal.improvementId);
    if (!improvement || improvement.companyId !== approval.companyId) return record(ctx, approval, { ok: false, detail: "Not carried out. The proposal no longer exists." });
    if (improvement.state !== "awaiting_approval") return record(ctx, approval, { ok: false, detail: `Not carried out. It was already ${improvement.state}.` });
    if (decision !== "approved") {
      await ctx.db.patch(improvement._id, { state: "declined", approvalId: undefined, decidedBy: member._id, decidedAt: Date.now(), decisionNote: approval.note, updatedAt: Date.now() });
      await recordEvent(ctx, { companyId: company._id, type: "quality_improvement.declined", actor: decidedBy, subject: { table: "qualityImprovements", id: improvement._id }, data: {} });
      return record(ctx, approval, { ok: true, detail: "Not adopted. Nothing changed." });
    }
    const result = await adoptImprovement(ctx, company, improvement, member._id);
    return record(ctx, approval, result);
  }
  return null;
}

export async function afterQualityExpiry(ctx: MutationCtx, approval: Doc<"approvals">): Promise<void> {
  const proposal = approval.proposal;
  if (proposal?.kind === "quality_request") {
    const request = await ctx.db.get(proposal.requestId);
    if (request && request.status === "awaiting_approval") await ctx.db.patch(request._id, { status: "cancelled", approvalId: undefined, result: "Nobody decided in time, so it was not sent.", updatedAt: Date.now() });
  }
  if (proposal?.kind === "quality_improvement") {
    const improvement = await ctx.db.get(proposal.improvementId);
    if (improvement && improvement.state === "awaiting_approval") await ctx.db.patch(improvement._id, { state: "proposed", approvalId: undefined, updatedAt: Date.now() });
  }
}
