/**
 * Carrying out a decision made in the shared approvals queue on a step Client Care prepared. Approving binds
 * to exactly that step and the facts it was prepared on: if the client wrote again, or the visit, the plan,
 * the invoice or the policy changed, the approval is not carried out and Care works the request again.
 * Silence is never approval.
 */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { Actor } from "../events";
import { addEntry, isOpen, moveRequest } from "./requests";
import { carryOut, stampOf } from "./steps";

export function isCareProposal(approval: Pick<Doc<"approvals">, "proposal">): boolean {
  return approval.proposal?.kind === "care_action";
}

async function record(ctx: MutationCtx, approval: Doc<"approvals">, result: { ok: boolean; detail: string }) {
  const carriedOut = { ...result, at: Date.now() };
  await ctx.db.patch(approval._id, { carriedOut });
  return carriedOut;
}

export async function afterCareDecision(ctx: MutationCtx, approval: Doc<"approvals">, decision: "approved" | "changed" | "skipped", decidedBy: Actor) {
  const proposal = approval.proposal;
  if (proposal?.kind !== "care_action") return null;
  const company = await ctx.db.get(approval.companyId);
  const step = await ctx.db.get(proposal.stepId);
  if (!company || !step || step.companyId !== approval.companyId) return record(ctx, approval, { ok: false, detail: "Not carried out. The step no longer exists." });
  const request = (await ctx.db.get(step.requestId))!;
  if (step.status !== "awaiting_approval") return record(ctx, approval, { ok: false, detail: `Not carried out. The step was already ${step.status.replace(/_/g, " ")}.` });
  await ctx.db.patch(step._id, { approvalId: undefined, updatedAt: Date.now() });
  if (decision !== "approved") {
    await ctx.db.patch(step._id, { status: "cancelled", result: decision === "changed" ? `A person handled it another way: ${approval.note ?? ""}`.slice(0, 300) : "Not approved.", updatedAt: Date.now() });
    await addEntry(ctx, request, { kind: "decision", text: decision === "changed" ? `A person chose to handle "${step.summary}" another way: ${approval.note ?? ""}` : `A person skipped "${step.summary}".`, actor: decidedBy });
    if (isOpen(request)) await moveRequest(ctx, request, { status: "waiting_owner", waiting: { on: "owner", reason: decision === "changed" ? "A person is handling this their way." : "Client Care's step was skipped.", since: Date.now() }, blocker: "Resolve the request when it's done, or close it.", nextAction: "Do what's needed, then resolve or close the request." }, decidedBy);
    return record(ctx, approval, { ok: true, detail: "Set aside. Nothing was sent or changed." });
  }
  // Approving one step authorizes that step, as it was prepared, on the facts it was prepared on. Nothing else.
  if (proposal.stamp !== step.stamp || (await stampOf(ctx, request, step)) !== step.stamp) {
    await ctx.db.patch(step._id, { status: "cancelled", result: "The request or its records changed after it was sent for approval.", updatedAt: Date.now() });
    await addEntry(ctx, request, { kind: "problem", text: `Approved, but not carried out: "${step.summary}". The client's request or the records it rests on changed after it was prepared. Client Care prepares it again.`, actor: decidedBy });
    if (isOpen(request)) await moveRequest(ctx, request, { status: "in_progress", nextAction: "Client Care is working the request again on what is true now.", nextCheckAt: Date.now() }, decidedBy);
    return record(ctx, approval, { ok: false, detail: "Not carried out. The client's request or its records changed after this was prepared; Client Care prepares it again." });
  }
  await ctx.db.patch(step._id, { status: "proposed" });
  const routed = await carryOut(ctx, company, step._id, decidedBy, `${step.permission}: approved by a person`);
  return record(ctx, approval, { ok: routed.status === "carried_out", detail: routed.status === "carried_out" ? routed.detail : `Not carried out. ${routed.detail}` });
}

export async function afterCareExpiry(ctx: MutationCtx, approval: Doc<"approvals">): Promise<void> {
  const proposal = approval.proposal;
  if (proposal?.kind !== "care_action") return;
  const step = await ctx.db.get(proposal.stepId);
  if (!step || step.status !== "awaiting_approval") return;
  await ctx.db.patch(step._id, { status: "cancelled", approvalId: undefined, result: "Nobody decided in time, so it was not done.", updatedAt: Date.now() });
  const request = await ctx.db.get(step.requestId);
  if (request && isOpen(request)) {
    await addEntry(ctx, request, { kind: "problem", text: `Nobody decided "${step.summary}" in time, so it was not done.` });
    await moveRequest(ctx, request, { status: "waiting_owner", waiting: { on: "owner", reason: "Nobody decided Client Care's step in time.", since: Date.now() }, blocker: `"${step.summary}" waited for a decision and expired. Handle the request yourself, or close it.` });
  }
}
