/**
 * Care's steps: one action each, prepared on a request, routed by the Owner's authority for that action, and
 * carried out by the function that owns the work. Nothing here re-implements another agent's rules.
 *
 *  - A step is named by `key`, so preparing it again (a retry, a repeated run) finds it instead of making a
 *    second one, and its message is planned under one dedupe key, so it is never sent twice.
 *  - `stamp` is what it was prepared on: the request's version and the records it touches. Approving it, or
 *    carrying it out, reads them again; a different stamp stops it and the request is worked again.
 *  - `parts` say which of its parts happened. A move that succeeded and a message that failed is "partial":
 *    the message is retried, never the move.
 *  - An outcome an outside system has not confirmed is "uncertain" and is never retried by itself.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { requestApproval } from "../approvalQueue";
import { authorityFor } from "../authority";
import { reportAction } from "../controls/report";
import { commitMove, planMove } from "../dispatch/reschedule";
import { recordEvent, type Actor } from "../events";
import { cancelVisit } from "../jobs/visits";
import { actionDef, type Level } from "../permissionCatalog";
import { unseal } from "../recruiter/secrets";
import { afterCareMessage } from "../retention/actions";
import { carryOutPlanChange, loadPlan, previewPlanChange } from "../retention/planChanges";
import { openRecovery } from "../retention/recovery";
import { checkCapacity } from "../sales/capacity";
import { businessSettingsOf, checkArea, checkHours } from "../settings/business";
import { openTask } from "../taskState";
import { careReplyClaimable, queueCareReply } from "./outbox";
import { addExtra } from "./extras";
import { changeRules } from "./policy";
import { addEntry, CARE, isOpen, moveRequest, resolveRequest, type Request } from "./requests";
import type { Part, StepKind, StepPayload } from "./schema";

type Ctx = QueryCtx | MutationCtx;
type Step = Doc<"careSteps">;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type NewStep = { kind: StepKind; key: string; permission: string; summary: string; payload: StepPayload; message?: Step["message"] };

export async function stepByKey(ctx: Ctx, companyId: Id<"companies">, key: string): Promise<Step | null> {
  return ctx.db
    .query("careSteps")
    .withIndex("by_company_key", (q) => q.eq("companyId", companyId).eq("key", key))
    .first();
}

export async function stepsOf(ctx: Ctx, request: Pick<Request, "_id">): Promise<Step[]> {
  return ctx.db
    .query("careSteps")
    .withIndex("by_request", (q) => q.eq("requestId", request._id))
    .take(100);
}

/** What a step was prepared on, read now. Two reads of unchanged records give the same stamp. */
export async function stampOf(ctx: Ctx, request: Request, step: Pick<Step, "kind" | "payload">): Promise<string> {
  const parts: (string | number)[] = [request.version, step.kind];
  const job = step.payload.jobId ? await ctx.db.get(step.payload.jobId) : null;
  if (step.payload.jobId) parts.push(job ? `${job.status}|${job.startsAt}|${job.endsAt}|${job.migration?.held ? "held" : ""}|${job.priceCents ?? ""}` : "gone");
  const invoice = step.payload.invoiceId ? await ctx.db.get(step.payload.invoiceId) : null;
  if (step.payload.invoiceId) parts.push(invoice ? `${invoice.status}|${invoice.totals.balanceCents}|${invoice.totals.processingCents}` : "gone");
  if (step.payload.plan) {
    const company = (await ctx.db.get(request.companyId))!;
    const plan = await loadPlan(ctx, request.companyId, step.payload.plan);
    parts.push(plan ? `${plan.state}|${plan.pausedFrom ?? ""}|${plan.endsOn ?? ""}` : "gone");
    if (plan && step.payload.change) {
      const preview = await previewPlanChange(ctx, company, plan, { change: step.payload.change, from: step.payload.from, until: step.payload.until, jobId: step.payload.jobId }, false);
      parts.push([...preview.shown].map(String).sort().join(","));
    }
  }
  if (step.kind === "reschedule" || step.kind === "skip_visit" || step.kind === "cancel_visit" || step.kind === "plan_change") {
    const company = (await ctx.db.get(request.companyId))!;
    const rules = await changeRules(ctx, company, request.customerId, request.propertyId ?? null);
    parts.push(`${rules.noticeHours ?? "none"}|${rules.agreementId ?? ""}`);
  }
  return parts.join("~");
}

/** Prepares one step, or answers with the one already prepared under this key. */
export async function prepareStep(ctx: MutationCtx, request: Request, input: NewStep, actor: Actor = CARE): Promise<Step> {
  const existing = await stepByKey(ctx, request.companyId, input.key);
  if (existing) return existing;
  const now = Date.now();
  const draft = { kind: input.kind, payload: input.payload };
  const id = await ctx.db.insert("careSteps", {
    companyId: request.companyId,
    requestId: request._id,
    key: input.key.slice(0, 300),
    kind: input.kind,
    permission: input.permission,
    status: "proposed",
    summary: input.summary.slice(0, 400),
    stamp: await stampOf(ctx, request, draft),
    payload: input.payload,
    message: input.message ? { ...input.message, body: input.message.body.slice(0, input.message.channel === "sms" ? 900 : 4000) } : undefined,
    attempts: 0,
    parts: [],
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  });
  return (await ctx.db.get(id))!;
}

function setPart(parts: Part[], name: Part["name"], state: Part["state"], detail?: string): Part[] {
  return [...parts.filter((p) => p.name !== name), { name, state, detail: detail?.slice(0, 300), at: Date.now() }];
}

const partState = (step: Step, name: Part["name"]) => step.parts.find((p) => p.name === name)?.state ?? null;

async function patchStep(ctx: MutationCtx, step: Step, patch: Partial<Step>): Promise<Step> {
  await ctx.db.patch(step._id, { ...patch, updatedAt: Date.now() });
  return (await ctx.db.get(step._id))!;
}

export type Routed = { status: "carried_out" | "awaiting_approval" | "blocked" | "failed"; detail: string };

/**
 * Routes a prepared step by the Owner's authority as it is now: Off and anything no execution path does
 * go to a person; Ask me first goes to the approvals queue with exactly what approving authorizes; the
 * two acting levels carry it out, checked again.
 */
export async function routeStep(ctx: MutationCtx, company: Doc<"companies">, request: Request, step: Step): Promise<Routed> {
  if (step.status !== "proposed") return { status: step.status === "awaiting_approval" ? "awaiting_approval" : "carried_out", detail: step.result ?? "Already routed." };
  const def = actionDef(step.permission);
  const authority = await authorityFor(ctx, company._id, step.permission);
  const label = def?.label.toLowerCase() ?? "this";
  const toPerson = async (words: string): Promise<Routed> => {
    await patchStep(ctx, step, { status: "blocked", result: words });
    await addEntry(ctx, request, { kind: "waiting", text: `Prepared for a person: ${step.summary}. ${words}` });
    await moveRequest(ctx, (await ctx.db.get(request._id))!, { status: "waiting_owner", waiting: { on: "owner", reason: words, since: Date.now() }, blocker: `${step.summary}. ${words}`, nextAction: "Decide and do this yourself, or change Client Care's permission for it." });
    return { status: "blocked", detail: words };
  };
  if (authority.kind === "person_only") return toPerson("This always needs a person.");
  if (authority.kind === "unknown") return toPerson("This isn't an action Client Care can take.");
  if (authority.kind === "unavailable") return toPerson(authority.why);
  if (authority.kind === "paused") return { status: "blocked", detail: "Client Care is paused." };
  if (authority.level === "off") return toPerson(`Client Care is set to Off for "${label}", so a person handles it.`);
  if (authority.level === "propose") return askFirst(ctx, company, request, step, authority.expired === true);
  return carryOut(ctx, company, step._id, CARE, `${step.permission}: ${authority.level === "execute" ? "Act automatically" : "Act and notify me"}`, authority.level);
}

async function askFirst(ctx: MutationCtx, company: Doc<"companies">, request: Request, step: Step, expired: boolean): Promise<Routed> {
  const stamp = await stampOf(ctx, request, step);
  const approvalId = await requestApproval(ctx, {
    companyId: company._id,
    action: step.permission,
    summary: step.summary,
    reason: `${request.authority.name} asked: ${request.summary}`.slice(0, 600),
    authorizes: step.message ? `${step.summary}. The client is sent: "${step.message.body.slice(0, 400)}"` : step.summary,
    ifWaiting: "Nothing happens until someone decides. Care tells the client the request is with the team if it waits longer than promised.",
    decideBy: Date.now() + (step.kind === "reply" ? 6 * HOUR : DAY),
    proposal: { kind: "care_action", stepId: step._id, stamp },
    about: { table: "careRequests", id: request._id },
    taskId: request.taskId,
  });
  await patchStep(ctx, step, { status: "awaiting_approval", approvalId, stamp, result: expired ? "Waiting for approval: the temporary permission ran out." : "Waiting for approval." });
  await addEntry(ctx, request, { kind: "waiting", text: `Waiting for your approval: ${step.summary}`, source: { table: "approvals", id: approvalId, label: "Approval" } });
  const fresh = (await ctx.db.get(request._id))!;
  if (isOpen(fresh)) await moveRequest(ctx, fresh, { status: "waiting_owner", waiting: { on: "owner", reason: "Your approval is needed before Client Care goes ahead.", since: Date.now() }, nextAction: "Approve, change or skip it in Approvals." });
  return { status: "awaiting_approval", detail: "Waiting for approval." };
}

/** Carries out an authorized step, after checking that nothing it rests on has moved. Safe to call again. */
export async function carryOut(ctx: MutationCtx, company: Doc<"companies">, stepId: Id<"careSteps">, by: Actor, authorization: string, level?: Level): Promise<Routed> {
  let step = (await ctx.db.get(stepId))!;
  const request = (await ctx.db.get(step.requestId))!;
  if (step.status === "done" || step.status === "cancelled" || step.status === "uncertain") return { status: step.status === "done" ? "carried_out" : "failed", detail: step.result ?? step.status };
  if (!isOpen(request) && !step.payload.staleSafe) {
    await patchStep(ctx, step, { status: "cancelled", result: "The request was closed first." });
    return { status: "failed", detail: "The request was closed first." };
  }
  if (company.pausedAgents.includes("customer-care") && by.kind === "agent") return { status: "blocked", detail: "Client Care is paused." };
  // A retry never redoes a part that already happened.
  const changeDone = partState(step, "change") === "done";
  if (!changeDone && (await stampOf(ctx, request, step)) !== step.stamp) {
    step = await patchStep(ctx, step, { status: "cancelled", result: "What this was prepared on changed (the client's request, the visit, the plan, the invoice or the policy). It was not carried out; Client Care works the request again." });
    await addEntry(ctx, request, { kind: "problem", text: `Not carried out: ${step.summary}. What it was prepared on has changed since.` });
    await moveRequest(ctx, request, { status: "in_progress", nextAction: "Client Care is working the request again on what the record says now.", nextCheckAt: Date.now() });
    return { status: "failed", detail: "What this was prepared on has changed, so it was not carried out." };
  }
  step = await patchStep(ctx, step, { status: "ready", attempts: step.attempts + 1, result: authorization.slice(0, 300) });
  let result: { ok: boolean; detail: string; evidence?: { table: string; id: string; label: string } };
  try {
    result = changeDone ? { ok: true, detail: partsDetail(step, "change") ?? "Already done." } : await doChange(ctx, company, request, step, by);
  } catch (error) {
    const words = error instanceof Error && "data" in error ? String((error as { data?: { message?: string } }).data?.message ?? "It could not be done.") : "It could not be done.";
    result = { ok: false, detail: words };
  }
  step = (await ctx.db.get(stepId))!;
  if (!result.ok) {
    step = await patchStep(ctx, step, { status: "failed", parts: setPart(step.parts, "change", "failed", result.detail), result: result.detail });
    await addEntry(ctx, request, { kind: "problem", text: `Could not ${step.summary.charAt(0).toLowerCase()}${step.summary.slice(1)}: ${result.detail}` });
    const fresh = (await ctx.db.get(request._id))!;
    if (isOpen(fresh)) await moveRequest(ctx, fresh, { status: "in_progress", blocker: result.detail, nextAction: "Client Care is offering what can be done instead.", nextCheckAt: Date.now() });
    await recordEvent(ctx, { companyId: company._id, type: "care_step.failed", actor: by, subject: { table: "careSteps", id: step._id }, data: { kind: step.kind } });
    return { status: "failed", detail: result.detail };
  }
  if (step.kind !== "reply" && step.kind !== "update" && step.kind !== "relay" && step.kind !== "invoice_link") {
    step = await patchStep(ctx, step, { parts: setPart(step.parts, "change", "done", result.detail) });
    if (!changeDone) {
      await addEntry(ctx, request, { kind: "did", text: result.detail, source: result.evidence, actor: by });
      await recordEvent(ctx, { companyId: company._id, type: "care_step.done", actor: by, subject: { table: "careSteps", id: step._id }, data: { kind: step.kind } });
    }
  }
  // The client hears about it through the one door, under one key, whatever happened before.
  if (step.message) {
    const message = await queueCareReply(ctx, { company, request: (await ctx.db.get(request._id))!, step, body: step.message.body, subject: step.message.subject, invoiceId: step.kind === "invoice_link" ? step.payload.invoiceId : undefined, dedupeKey: `care:${step._id}:${step.attempts > 1 && partState(step, "notify") === "failed" ? `retry${step.attempts}` : "1"}`, actor: by });
    step = await patchStep(ctx, step, { messageId: message._id, parts: setPart(step.parts, "notify", "pending", message.status === "held" ? (message.problem ?? "Held") : "Queued") });
    await afterCareReply(ctx, message);
  } else {
    step = await patchStep(ctx, step, { status: "done" });
    await settled(ctx, (await ctx.db.get(step._id))!);
  }
  if (level) await reportAction(ctx, { companyId: company._id, agent: "customer-care", action: step.permission, level, subject: { table: "careRequests", id: request._id }, ref: step._id, stage: step.message ? "queued" : "completed", kind: step.kind });
  return { status: "carried_out", detail: result.detail };
}

function partsDetail(step: Step, name: Part["name"]): string | undefined {
  return step.parts.find((p) => p.name === name)?.detail;
}

/** The change itself, by the function that owns it. Throws a person's words, or answers why not. */
async function doChange(ctx: MutationCtx, company: Doc<"companies">, request: Request, step: Step, by: Actor): Promise<{ ok: boolean; detail: string; evidence?: { table: string; id: string; label: string } }> {
  const p = step.payload;
  const tz = company.timezone;
  switch (step.kind) {
    case "reply":
    case "update":
    case "relay":
    case "invoice_link":
      return { ok: true, detail: "A message." };
    case "reschedule": {
      const job = p.jobId ? await ctx.db.get(p.jobId) : null;
      if (!job || job.companyId !== company._id || p.startsAt === undefined || p.endsAt === undefined || !p.moveVersion) return { ok: false, detail: "The visit is no longer on record." };
      if (job.customerId !== request.customerId) return { ok: false, detail: "That visit belongs to a different client." };
      const move = { startsAt: p.startsAt, endsAt: p.endsAt };
      const settings = businessSettingsOf(company);
      const property = await ctx.db.get(job.propertyId);
      if (property) checkArea(settings, property.address.postalCode);
      checkHours(settings, move, tz);
      // A time that was offered is not a reservation: it is checked again now, in the same transaction as the move.
      const capacity = await checkCapacity(ctx, company, move, Math.max(1, job.requiredCrew ?? 1));
      if (capacity.state !== "fits" && capacity.state !== "tight") return { ok: false, detail: `That time is no longer available: ${capacity.why}` };
      const plan = await planMove(ctx, company, job, move);
      if (plan.plan.problems.length) return { ok: false, detail: plan.plan.problems[0] };
      if (plan.plan.version !== p.moveVersion) return { ok: false, detail: "The visit changed since the time was offered (its crew or its time), so it was not moved." };
      const done = await commitMove(ctx, company, job, move, p.moveVersion, by);
      await recordEvent(ctx, { companyId: company._id, type: "job.moved_by_care", actor: by, subject: { table: "jobs", id: job._id }, data: { from: job.startsAt, to: move.startsAt, askedAgain: done.crew.filter((c) => c.outcome === "asked_again").length } });
      return { ok: true, detail: `Moved the visit from ${whenOf(job.startsAt, tz)} to ${whenOf(move.startsAt, tz)}. Dispatch asks the crew again for the new time.`, evidence: { table: "jobs", id: job._id, label: "The visit" } };
    }
    case "skip_visit":
    case "plan_change": {
      if (!p.plan || !p.change || !p.shown) return { ok: false, detail: "There is no plan change to carry out." };
      const outcome = await carryOutPlanChange(ctx, company, request.customerId, { change: p.change, plan: p.plan, from: p.from, until: p.until, jobId: p.jobId, shown: p.shown, reason: `${request.authority.name} asked by ${request.conversation.channel === "sms" ? "text" : "email"}.`, requestedBy: "customer" }, by, "client_care");
      return { ok: outcome.ok, detail: outcome.detail, evidence: { table: p.plan.kind === "service" ? "servicePlans" : "recurringPlans", id: p.plan.id, label: "The service plan" } };
    }
    case "cancel_visit": {
      const job = p.jobId ? await ctx.db.get(p.jobId) : null;
      if (!job || job.companyId !== company._id || job.customerId !== request.customerId) return { ok: false, detail: "The visit is no longer on record." };
      if (job.status !== "scheduled") return { ok: false, detail: "Only a visit that hasn't started can be cancelled." };
      await cancelVisit({ ...ctx, companyId: company._id }, job, `Cancelled at the client's request (${request.authority.name}, by ${request.conversation.channel === "sms" ? "text" : "email"}).`, by);
      // Money already paid for it is Finance's: a person is told, and nothing is refunded or changed here.
      const invoice = await ctx.db.query("invoices").withIndex("by_company_job", (q) => q.eq("companyId", company._id).eq("jobId", job._id)).first();
      if (invoice && invoice.totals.paidCents > 0) await openTask(ctx, { companyId: company._id, agent: "customer-care", title: `Payment on a cancelled visit for ${request.authority.name}`, nextAction: "Decide in Finance what happens to the payment already made for this visit.", dueAt: Date.now() + DAY, completionCondition: "A person decided what happens to the payment", about: { table: "careRequests", id: request._id }, key: `care.paid_cancelled:${job._id}`, actor: by });
      return { ok: true, detail: `Cancelled the visit on ${whenOf(job.startsAt, tz)}.${invoice && invoice.totals.paidCents > 0 ? " A payment was already made for it: Finance has a task, and nothing was refunded." : ""}`, evidence: { table: "jobs", id: job._id, label: "The visit" } };
    }
    case "preference": {
      const text = (p.text ?? "").trim();
      if (!text) return { ok: false, detail: "There is no preference to record." };
      const stamp = `${dayOf(Date.now(), tz)}, from ${request.authority.name}: ${text}`.slice(0, 400);
      if (p.scope === "one_visit") {
        const job = p.jobId ? await ctx.db.get(p.jobId) : null;
        if (!job || job.companyId !== company._id || job.status !== "scheduled") return { ok: false, detail: "That visit is no longer booked." };
        await ctx.db.patch(job._id, { instructions: [job.instructions, `For this visit only (${stamp})`].filter(Boolean).join("\n").slice(0, 2000) });
        return { ok: true, detail: `Added to the visit on ${whenOf(job.startsAt, tz)} only. The rest of the schedule is unchanged.`, evidence: { table: "jobs", id: job._id, label: "The visit" } };
      }
      if (p.scope === "customer") {
        const customer = (await ctx.db.get(request.customerId))!;
        await ctx.db.patch(customer._id, { preferences: [customer.preferences, stamp].filter(Boolean).join("\n").slice(0, 2000), revision: (customer.revision ?? 0) + 1, updatedAt: Date.now() });
        return { ok: true, detail: "Recorded as the client's standing preference.", evidence: { table: "customers", id: customer._id, label: "The client" } };
      }
      const property = p.propertyId ? await ctx.db.get(p.propertyId) : null;
      if (!property || property.companyId !== company._id || property.customerId !== request.customerId) return { ok: false, detail: "The property is no longer on record." };
      await ctx.db.patch(property._id, { crewNotes: [property.crewNotes, stamp].filter(Boolean).join("\n").slice(0, 2000), revision: (property.revision ?? 0) + 1, updatedAt: Date.now() });
      return { ok: true, detail: `Added to the crew notes for ${property.label?.trim() || property.address.line1}, for every visit there from now on.`, evidence: { table: "properties", id: property._id, label: "The property" } };
    }
    case "access": {
      const property = p.propertyId ? await ctx.db.get(p.propertyId) : null;
      if (!property || property.companyId !== company._id || property.customerId !== request.customerId) return { ok: false, detail: "The property is no longer on record." };
      const text = p.sealed ? await unseal(p.sealed, step.requestId) : null;
      if (!text) return { ok: false, detail: "The new access details could not be read back securely, so nothing was changed. Read them in the conversation and enter them on the property yourself." };
      await ctx.db.patch(property._id, { accessInstructions: [`Updated ${dayOf(Date.now(), tz)} by ${request.authority.name}: ${text}`, property.accessInstructions ? `Earlier: ${property.accessInstructions}` : null].filter(Boolean).join("\n").slice(0, 2000), revision: (property.revision ?? 0) + 1, updatedAt: Date.now() });
      await ctx.db.patch(step._id, { payload: { ...p, sealed: undefined } });
      // The code itself is never in an event, an entry or a notice.
      await recordEvent(ctx, { companyId: company._id, type: "property.access_updated", actor: by, subject: { table: "properties", id: property._id }, data: { via: "client_care" } });
      return { ok: true, detail: `Updated the access instructions for ${property.label?.trim() || property.address.line1}. Only Owners, Managers and the crew on an accepted visit see them.`, evidence: { table: "properties", id: property._id, label: "The property" } };
    }
    case "complaint": {
      const customer = (await ctx.db.get(request.customerId))!;
      const job = p.jobId ? await ctx.db.get(p.jobId) : null;
      const property = job ? await ctx.db.get(job.propertyId) : p.propertyId ? await ctx.db.get(p.propertyId) : null;
      const opened = await openRecovery(ctx, company, { customer, property, job, words: p.text ?? request.summary, origin: "conversation", actor: by });
      await ctx.db.patch(request._id, { retentionCaseId: opened.row._id });
      return { ok: true, detail: opened.created ? "Opened a recovery case for the visit; Quality investigates it and Retention prepares any remedy. Client Care keeps the client informed." : "Added this to the recovery case already open for the visit.", evidence: { table: "retentionCases", id: opened.row._id, label: "Recovery case" } };
    }
    case "extra": {
      const job = p.jobId ? await ctx.db.get(p.jobId) : null;
      if (!job || job.companyId !== company._id || job.customerId !== request.customerId) return { ok: false, detail: "The visit is no longer on record." };
      if (!p.addOnId || p.extraCents === undefined || p.extraMinutes === undefined) return { ok: false, detail: "There is no extra to add." };
      const outcome = await addExtra(ctx, company, job, p.text ?? "", { addOnId: p.addOnId, extraCents: p.extraCents, extraMinutes: p.extraMinutes }, by);
      return { ...outcome, evidence: { table: "jobs", id: job._id, label: "The visit" } };
    }
    case "hand_off": {
      if (p.taskId) return { ok: true, detail: "Already handed over." };
      const to = p.handoffTo ?? "owner";
      const agent = to === "sales" ? "sales" : to === "dispatch" ? "dispatch" : to === "quality" ? "quality" : to === "retention" ? "retention" : "customer-care";
      const taskId = await openTask(ctx, { companyId: company._id, agent, title: step.summary.slice(0, 200), nextAction: (request.nextAction ?? "Take this request and tell Client Care what happens next").slice(0, 500), dueAt: Date.now() + DAY, completionCondition: "The team member decided or did what the client asked, and the request shows it", about: { table: "careRequests", id: request._id }, key: `care.handoff:${step._id}`, actor: by });
      if (to === "finance") await ctx.db.patch(taskId, { handoffTo: "finance" });
      await ctx.db.patch(step._id, { payload: { ...p, taskId } });
      return { ok: true, detail: `Handed to ${to === "owner" ? "the office" : to.charAt(0).toUpperCase() + to.slice(1)}.`, evidence: { table: "tasks", id: taskId, label: "Task" } };
    }
  }
}

function whenOf(at: number, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(at));
}
function dayOf(at: number, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(new Date(at));
}

/**
 * A Care message's outcome, as the provider reported it. Accepted is not delivered, and neither is the
 * request resolved unless the step resolves it. A change that is done and a message that failed leaves the
 * request waiting for a person, with the change kept.
 */
export async function afterCareReply(ctx: MutationCtx, message: Doc<"messages">): Promise<void> {
  const step = message.careStepId ? await ctx.db.get(message.careStepId) : null;
  if (!step || step.messageId !== message._id) return;
  const state: Part["state"] = message.status === "sent" || message.status === "delivered" ? "done" : message.status === "failed" || message.status === "not_sent" ? "failed" : message.status === "unconfirmed" ? "uncertain" : "pending";
  const words = message.status === "delivered" ? "Delivery confirmed" : message.status === "sent" ? "Accepted by the provider" : message.status === "unconfirmed" ? "Not known whether it went" : (message.problem ?? message.status.replace(/_/g, " "));
  let fresh = await patchStep(ctx, step, { parts: setPart(step.parts, "notify", state, words) });
  if (step.kind === "relay" && step.payload.retentionActionId && state !== "pending") await afterCareMessage(ctx, { ...message, retentionActionId: step.payload.retentionActionId });
  // Held for the company's messaging funds, its spending limit, billing being unreachable, or the Owner's pause:
  // nothing is lost, and the request says so where a person will see it. Quiet hours are not a person's problem.
  if (message.status === "held" && message.holdReason && message.holdReason !== "quiet_hours") {
    const request = await ctx.db.get(step.requestId);
    const words = `${HELD}${(message.problem ?? "it can't go yet").replace(/\.$/, "")}. It goes as soon as that is fixed.`;
    if (request && isOpen(request) && !request.blocker?.startsWith(words)) {
      await addEntry(ctx, request, { kind: "problem", text: words, source: { table: "messages", id: message._id, label: "Message" } });
      const blocker = request.blocker && !request.blocker.startsWith(HELD) ? `${words}${BEFORE}${request.blocker}` : words;
      await moveRequest(ctx, request, { status: "waiting_owner", waiting: { on: "owner", reason: words, since: Date.now() }, blocker: blocker.slice(0, 900), nextAction: message.holdReason === "messaging_paused" ? "Resume texting when ready." : "Add messaging funds or raise the limit in Plan & usage." });
    }
    return;
  }
  if (state === "pending") return;
  const changed = partState(fresh, "change");
  if (state === "done") fresh = await patchStep(ctx, fresh, { status: "done" });
  else if (state === "uncertain") fresh = await patchStep(ctx, fresh, { status: changed === "done" ? "partial" : "uncertain", result: "It is not known whether the message went. It was not sent again." });
  else fresh = await patchStep(ctx, fresh, { status: changed === "done" ? "partial" : "failed", result: changed === "done" ? words : `The message did not go: ${words}` });
  if (message.status === "delivered" && step.parts.find((p) => p.name === "notify")?.state === "done") return;
  await settled(ctx, fresh, message);
}

const HELD = "Client Care's message is ready but held: ";
const BEFORE = " Before that: ";

/** What a finished (or stuck) step means for its request. */
async function settled(ctx: MutationCtx, step: Step, message?: Doc<"messages">) {
  const request = await ctx.db.get(step.requestId);
  if (!request) return;
  const notify = partState(step, "notify");
  if (step.status === "done") {
    if (message) await addEntry(ctx, request, { kind: "update", text: `${message.status === "delivered" ? "Delivered" : "Sent (accepted by the provider)"}: "${message.body.slice(0, 300)}"`, source: { table: "messages", id: message._id, label: "Message" } });
    await ctx.db.patch(request._id, { lastUpdateAt: Date.now(), updatesSent: request.updatesSent + (message ? 1 : 0) });
    let now = (await ctx.db.get(request._id))!;
    // A message that was held went once the funds, limit or pause were fixed: what it was waiting on is over.
    if (isOpen(now) && now.blocker?.startsWith(HELD)) {
      const earlier = now.blocker.includes(BEFORE) ? now.blocker.slice(now.blocker.indexOf(BEFORE) + BEFORE.length) : null;
      now = earlier
        ? await moveRequest(ctx, now, { blocker: earlier, waiting: { on: "owner", reason: earlier, since: Date.now() } })
        : await moveRequest(ctx, now, { status: "in_progress", clear: ["blocker", "nextAction"] });
    }
    if (step.payload.resolves && isOpen(now)) {
      await resolveRequest(ctx, now, step.payload.resolves, [{ table: "careSteps", id: step._id, label: step.summary.slice(0, 80) }]);
      return;
    }
    if (step.payload.awaitsClient && isOpen(now) && now.status !== "waiting_owner") await moveRequest(ctx, now, { status: "waiting_customer", waiting: { on: "customer", reason: now.pending?.question ? `Waiting for the client to answer: ${now.pending.question}` : "Waiting for the client's answer.", since: Date.now() } });
    return;
  }
  if (!isOpen(request) && !step.payload.staleSafe) return;
  const problem = step.status === "partial"
    ? notify === "uncertain"
      ? `${(partsDetail(step, "change") ?? "The change was made").replace(/\.$/, "")}. It is not known whether the message telling the client went; it was not sent again. Check with the client before sending another.`
      : `${(partsDetail(step, "change") ?? "The change was made").replace(/\.$/, "")}. The message telling the client did not go: ${(partsDetail(step, "notify") ?? "it could not be sent").replace(/\.$/, "")}. Retry it or reach them another way.`
    : notify === "uncertain"
      ? "It is not known whether Client Care's message went. It was not sent again. Check with the client before sending another."
      : `Client Care's message did not go: ${(partsDetail(step, "notify") ?? "it could not be sent").replace(/\.$/, "")}.`;
  await addEntry(ctx, request, { kind: "problem", text: problem, ...(message ? { source: { table: "messages", id: message._id, label: "Message" } } : {}) });
  // What the request already needed a person for stays in view beside the message problem.
  const blocker = request.blocker && !request.blocker.includes(problem) ? `${problem} Before that: ${request.blocker}` : problem;
  await moveRequest(ctx, request, { status: "waiting_owner", waiting: { on: "owner", reason: problem, since: Date.now() }, blocker: blocker.slice(0, 900), nextAction: step.status === "partial" && notify === "failed" ? "Retry the message, or reach the client another way." : "Reach the client yourself, or fix what stopped the message and retry it." });
  await recordEvent(ctx, { companyId: request.companyId, type: "care_request.needs_attention", actor: CARE, subject: { table: "careRequests", id: request._id }, data: { kind: "message_failed" } });
}

/** A person asks for a failed or held message to be tried again. The change is never redone; an uncertain message is never resent. */
export async function retryMessage(ctx: MutationCtx, company: Doc<"companies">, step: Step, by: Actor): Promise<{ ok: boolean; detail: string }> {
  if (step.status !== "partial" && step.status !== "failed") return { ok: false, detail: "There is nothing to retry on this step." };
  if (partState(step, "notify") === "uncertain") return { ok: false, detail: "It is not known whether the first message went, so it is not sent again. Check with the client first." };
  if (partState(step, "change") === "failed") return { ok: false, detail: "The change itself did not happen, so there is nothing to tell the client." };
  if (!step.message) return { ok: false, detail: "This step has no message." };
  const request = (await ctx.db.get(step.requestId))!;
  if (!(await careReplyClaimable(ctx, request))) return { ok: false, detail: "Client Care can't write in this conversation right now." };
  const routed = await carryOut(ctx, company, step._id, by, "Retried by a person");
  return { ok: routed.status === "carried_out", detail: routed.detail };
}
