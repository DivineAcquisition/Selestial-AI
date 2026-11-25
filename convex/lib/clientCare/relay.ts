/**
 * One voice for a client's request (the Owner's decision of November 25, 2026). When Retention carries out a
 * customer-facing step on a recovery case that is linked to an open Care request (a remedy to review, a
 * question, "did the correction work?"), Care sends it, in the request's own thread, exactly as Retention
 * prepared and authorized it. Retention's link is made at the moment of sending (outbox.ts). The result goes
 * back to Retention's action when the provider answers (steps.ts afterCareReply), so its case reads true.
 *
 * Kept small on purpose: Retention imports it, so it imports nothing of Retention's beyond its links.
 */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { queueCareReply } from "./outbox";
import { addEntry, isOpen, type Request } from "./requests";

/** The open Care request this recovery case belongs to, if Care holds the conversation for it. */
export async function careRequestForCase(ctx: QueryCtx | MutationCtx, row: Pick<Doc<"retentionCases">, "_id" | "companyId">): Promise<Request | null> {
  const rows = await ctx.db
    .query("careRequests")
    .withIndex("by_company_retention_case", (q) => q.eq("companyId", row.companyId).eq("retentionCaseId", row._id))
    .take(10);
  return rows.find((r) => isOpen(r) && r.owner.kind === "care") ?? null;
}

/** Sends Retention's prepared message through the Care request instead. Null: Care doesn't hold this case's conversation. */
export async function relayToCare(ctx: MutationCtx, company: Doc<"companies">, row: Doc<"retentionCases">, action: Doc<"retentionActions">): Promise<Doc<"messages"> | null> {
  if (!action.message) return null;
  const request = await careRequestForCase(ctx, row);
  if (!request) return null;
  const key = `${request._id}:relay:${action._id}`;
  let step = await ctx.db
    .query("careSteps")
    .withIndex("by_company_key", (q) => q.eq("companyId", company._id).eq("key", key))
    .first();
  if (!step) {
    const now = Date.now();
    const id = await ctx.db.insert("careSteps", {
      companyId: company._id,
      requestId: request._id,
      key,
      kind: "relay",
      // Authorized by Retention's own permission for the step; Care only carries the words.
      permission: action.permission,
      status: "ready",
      summary: `Send Retention's step to the client: ${action.summary}`.slice(0, 400),
      stamp: `relay:${action._id}`,
      payload: { retentionActionId: action._id, retentionCaseId: row._id, staleSafe: true, awaitsClient: true },
      message: { channel: request.conversation.channel, subject: action.message.subject, body: action.message.body },
      attempts: 1,
      parts: [],
      createdBy: { kind: "agent", agent: "retention" },
      createdAt: now,
      updatedAt: now,
    });
    step = (await ctx.db.get(id))!;
  }
  const message = await queueCareReply(ctx, { company, request, step, body: action.message.body, subject: action.message.subject, dedupeKey: `care:${step._id}:1`, actor: { kind: "agent", agent: "customer-care" } });
  await ctx.db.patch(step._id, { messageId: message._id, parts: [{ name: "notify", state: message.status === "not_sent" ? "failed" : "pending", detail: message.problem ?? "Queued", at: Date.now() }], updatedAt: Date.now() });
  await addEntry(ctx, request, { kind: "handoff", text: `Retention prepared a step for the client (${action.summary}). Care is sending it in this conversation.`, source: { table: "retentionCases", id: row._id, label: "Recovery case" } });
  return message;
}
