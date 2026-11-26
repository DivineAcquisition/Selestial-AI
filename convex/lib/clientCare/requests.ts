/**
 * A Care request's life: opened from a client's message, moved between states with the reason kept apart,
 * resolved with evidence, closed for a stated reason, reopened when the client says it isn't done. Every
 * change is an event, and an open request keeps one task so Home, Approvals and the task list show it.
 *
 * `version` counts every material change (what is asked, which visit, the status). A step prepared on an
 * earlier version is never carried out: its approval is checked against the stamp, which includes it.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { recordEvent, type Actor } from "../events";
import { liveTaskByKey, openTask, setTaskState } from "../taskState";
import { OPEN_STATUSES, type Fact, type RequestStatus } from "./schema";

type Ctx = QueryCtx | MutationCtx;
export type Request = Doc<"careRequests">;
export const CARE: Actor = { kind: "agent", agent: "customer-care" };
export const SYSTEM: Actor = { kind: "system" };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const STATUS_WORDS: Record<RequestStatus, string> = {
  new: "New",
  in_progress: "In progress",
  waiting_customer: "Waiting for client",
  waiting_team: "Waiting for team",
  waiting_owner: "Waiting for you",
  resolved: "Resolved",
  closed_no_action: "Closed without action",
};

export const isOpen = (row: Pick<Request, "status">) => OPEN_STATUSES.includes(row.status);

export async function addEntry(ctx: MutationCtx, row: Pick<Request, "_id" | "companyId">, entry: { kind: Doc<"careEntries">["kind"]; text: string; source?: Doc<"careEntries">["source"]; actor?: Actor; at?: number }) {
  await ctx.db.insert("careEntries", { companyId: row.companyId, requestId: row._id, kind: entry.kind, text: entry.text.slice(0, 800), source: entry.source, actor: entry.actor ?? CARE, at: entry.at ?? Date.now() });
}

export async function entriesOf(ctx: Ctx, row: Pick<Request, "_id">) {
  return ctx.db
    .query("careEntries")
    .withIndex("by_request", (q) => q.eq("requestId", row._id))
    .order("desc")
    .take(200);
}

export async function openRequestsFor(ctx: Ctx, companyId: Id<"companies">, customerId: Id<"customers">): Promise<Request[]> {
  const rows = await ctx.db
    .query("careRequests")
    .withIndex("by_company_customer", (q) => q.eq("companyId", companyId).eq("customerId", customerId))
    .order("desc")
    .take(50);
  return rows.filter(isOpen);
}

export async function recentRequestsFor(ctx: Ctx, companyId: Id<"companies">, customerId: Id<"customers">, since: number): Promise<Request[]> {
  const rows = await ctx.db
    .query("careRequests")
    .withIndex("by_company_customer", (q) => q.eq("companyId", companyId).eq("customerId", customerId).gte("createdAt", since))
    .order("desc")
    .take(50);
  return rows;
}

export type NewRequest = Omit<Request, "_id" | "_creationTime" | "status" | "owner" | "facts" | "reopened" | "version" | "createdAt" | "updatedAt" | "updatesSent" | "lastCustomerAt"> & { facts?: Fact[]; lastCustomerAt?: number; status?: RequestStatus };

export async function openRequest(ctx: MutationCtx, input: NewRequest, actor: Actor = CARE): Promise<Request> {
  const now = Date.now();
  const { facts, lastCustomerAt, status, ...rest } = input;
  const id = await ctx.db.insert("careRequests", {
    ...rest,
    summary: input.summary.slice(0, 300),
    requestedOutcome: input.requestedOutcome.slice(0, 300),
    status: status ?? "new",
    owner: { kind: "care" },
    facts: facts ?? [],
    reopened: [],
    version: 1,
    updatesSent: 0,
    lastCustomerAt: lastCustomerAt ?? now,
    createdAt: now,
    updatedAt: now,
  });
  await recordEvent(ctx, { companyId: input.companyId, type: "care_request.opened", actor, subject: { table: "careRequests", id }, data: { category: input.category, urgency: input.urgency } });
  const row = (await ctx.db.get(id))!;
  await syncTask(ctx, row, actor);
  return (await ctx.db.get(id))!;
}

export type RequestMove = Partial<Pick<Request, "status" | "waiting" | "blocker" | "nextAction" | "pending" | "promised" | "nextCheckAt" | "jobId" | "propertyId" | "plan" | "invoiceId" | "agreementId" | "qualityCaseId" | "retentionCaseId" | "opportunityId" | "urgency" | "urgencyReason" | "summary" | "requestedOutcome" | "ask" | "category" | "lastUpdateAt" | "updatesSent" | "lastCustomerAt" | "owner">> & {
  clear?: ("waiting" | "blocker" | "pending" | "promised" | "nextCheckAt" | "nextAction")[];
  facts?: Fact[];
  /** Counts as a material change: the version moves, and anything prepared on the old one is re-checked. */
  material?: boolean;
};

/** Changes a request. Moving to a waiting state needs its reason; leaving one clears it. */
export async function moveRequest(ctx: MutationCtx, row: Request, move: RequestMove, actor: Actor = CARE): Promise<Request> {
  const { clear, facts, material, ...fields } = move;
  const patch: Partial<Request> = { ...fields, updatedAt: Date.now() };
  const to = move.status ?? row.status;
  if (move.status && !move.status.startsWith("waiting") && !move.waiting) patch.waiting = undefined;
  for (const key of clear ?? []) patch[key] = undefined;
  if (facts?.length) {
    const kept = row.facts.filter((f) => !facts.some((n) => n.key === f.key));
    patch.facts = [...kept, ...facts].slice(-24);
  }
  const changedStatus = move.status !== undefined && move.status !== row.status;
  // Only what the client asks for, and which visit or plan it is about, moves the version. Care's own
  // bookkeeping (waiting, asking, a task) does not, so a step waiting for approval is not made stale by it.
  if (material) patch.version = row.version + 1;
  if (!isOpen({ status: to }) && isOpen(row)) {
    patch.closedAt = Date.now();
    patch.pending = undefined;
    patch.nextCheckAt = undefined;
    patch.waiting = undefined;
  }
  await ctx.db.patch(row._id, patch);
  const fresh = (await ctx.db.get(row._id))!;
  if (changedStatus) await recordEvent(ctx, { companyId: row.companyId, type: `care_request.${to}`, actor, subject: { table: "careRequests", id: row._id }, data: { from: row.status, category: fresh.category } });
  await syncTask(ctx, fresh, actor);
  return fresh;
}

export async function resolveRequest(ctx: MutationCtx, row: Request, words: string, evidence: { table: string; id: string; label: string }[], actor: Actor = CARE): Promise<Request> {
  if (!isOpen(row)) return row;
  await addEntry(ctx, row, { kind: "resolved", text: words, actor, source: evidence[0] });
  // The resolution is written first, so the task closes with it as its outcome.
  await ctx.db.patch(row._id, { resolution: { at: Date.now(), words: words.slice(0, 400), evidence: evidence.slice(0, 6) } });
  return moveRequest(ctx, (await ctx.db.get(row._id))!, { status: "resolved", clear: ["blocker", "nextAction"] }, actor);
}

export async function closeRequest(ctx: MutationCtx, row: Request, reason: string, actor: Actor = CARE): Promise<Request> {
  if (!isOpen(row)) return row;
  await addEntry(ctx, row, { kind: "resolved", text: `Closed without action: ${reason}`, actor });
  await ctx.db.patch(row._id, { resolution: { at: Date.now(), words: reason.slice(0, 400), evidence: [] } });
  const fresh = await moveRequest(ctx, (await ctx.db.get(row._id))!, { status: "closed_no_action", clear: ["blocker", "nextAction"] }, actor);
  await cancelOpenSteps(ctx, fresh, "The request was closed first.");
  return (await ctx.db.get(fresh._id))!;
}

/** A resolved request the client says isn't done is the same request, reopened with the reason kept. */
export async function reopenRequest(ctx: MutationCtx, row: Request, reason: string, actor: Actor = CARE): Promise<Request> {
  if (isOpen(row)) return row;
  await ctx.db.patch(row._id, { reopened: [...row.reopened, { at: Date.now(), reason: reason.slice(0, 300), from: row.status }], closedAt: undefined, resolution: undefined });
  await addEntry(ctx, row, { kind: "reopened", text: `Reopened: ${reason}`, actor });
  return moveRequest(ctx, (await ctx.db.get(row._id))!, { status: "in_progress", material: true }, actor);
}

/** Steps that have not run are set aside when the request they serve ends. A step that ran is history. */
export async function cancelOpenSteps(ctx: MutationCtx, row: Pick<Request, "_id">, why: string) {
  const steps = await ctx.db
    .query("careSteps")
    .withIndex("by_request", (q) => q.eq("requestId", row._id))
    .take(100);
  for (const step of steps) {
    if (step.status !== "proposed" && step.status !== "awaiting_approval" && step.status !== "ready") continue;
    await ctx.db.patch(step._id, { status: "cancelled", result: why, updatedAt: Date.now() });
    if (step.approvalId) {
      const approval = await ctx.db.get(step.approvalId);
      if (approval?.status === "pending") {
        await ctx.db.patch(approval._id, { status: "expired", note: why });
        await recordEvent(ctx, { companyId: approval.companyId, type: "approval.expired", actor: SYSTEM, subject: { table: "approvals", id: approval._id }, data: { action: approval.action, reason: "withdrawn" } });
      }
    }
  }
}

/** The one task an open request keeps, in the state that matches it. */
async function syncTask(ctx: MutationCtx, row: Request, actor: Actor) {
  const key = `care.request:${row._id}`;
  const task = row.taskId ? await ctx.db.get(row.taskId) : await liveTaskByKey(ctx, row.companyId, key);
  const title = row.summary.slice(0, 200);
  if (!isOpen(row)) {
    if (task && task.status !== "done" && task.status !== "cancelled") await setTaskState(ctx, task, row.status === "resolved" ? "done" : "cancelled", { outcome: (row.resolution?.words ?? (row.status === "resolved" ? "Resolved." : "Closed without action.")).slice(0, 500), closedAt: Date.now(), withPersonSince: null }, actor);
    return;
  }
  const due = row.nextCheckAt ?? Date.now() + DAY;
  let current = task && task.status !== "done" && task.status !== "cancelled" ? task : null;
  if (!current) {
    const taskId = await openTask(ctx, { companyId: row.companyId, agent: "customer-care", title, nextAction: row.nextAction ?? "Work the client's request", dueAt: due, completionCondition: "The client's request is resolved on the record and the client was told, or it was closed for a stated reason", about: { table: "careRequests", id: row._id }, key, actor });
    await ctx.db.patch(row._id, { taskId });
    current = (await ctx.db.get(taskId))!;
  }
  const person = row.owner.kind === "member" ? row.owner.since : null;
  if (row.status === "waiting_owner") {
    await setTaskState(ctx, current, "needs_decision", { openQuestion: (row.blocker ?? row.waiting?.reason ?? "This request needs a person.").slice(0, 1000), dueAt: due, withPersonSince: current.withPersonSince ?? Date.now() }, actor, { sameStatus: true });
  } else if (row.status === "waiting_customer" || row.status === "waiting_team") {
    await setTaskState(ctx, current, "waiting", { waitingOn: row.status === "waiting_customer" ? "customer" : "other", followUpAt: due, dueAt: due, withPersonSince: person }, actor, { sameStatus: true });
  } else {
    await setTaskState(ctx, current, "open", { nextAction: (row.nextAction ?? "Work the client's request").slice(0, 500), dueAt: due, withPersonSince: person }, actor, { sameStatus: true });
  }
}

/** When Care should look at a request on its own next, from what it waits on. */
export function nextCheck(row: Pick<Request, "pending" | "promised" | "status">, settings: { updateEveryHours: number }, now = Date.now()): number | undefined {
  const times: number[] = [];
  if (row.pending) times.push(row.pending.expiresAt);
  if (row.promised) times.push(row.promised.by);
  if (row.status === "waiting_team") times.push(now + settings.updateEveryHours * HOUR);
  return times.length ? Math.min(...times) : undefined;
}
