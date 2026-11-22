/**
 * Recruiter's onboarding, from an accepted offer to a worker an authorized person approves as ready
 * (docs/recruiter/06-readiness.md). Recruiter owns it end to end; the requirements are the company's
 * onboarding template on the shared cleaner record, and only a person records one as done.
 *
 * The new worker is created in "onboarding". Dispatch offers work only to a cleaner a person has marked
 * "ready" (convex/lib/dispatch/eligibility.ts), so being approved, accepting an offer, or even finishing
 * this handoff never by itself makes anyone assignable. Nothing here says a document was verified or a
 * background check was passed: a requirement is "done" because a named person said so.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { userError } from "../errors";
import { recordEvent, type Actor } from "../events";
import { openTask, setTaskState } from "../taskState";
import { closeApplication, setStage } from "./applications";
import { createWorker } from "../cleaners/enroll";
import { existingPerson, handoffChecklist, linkReturningWorker, nextActionOf, presentForApproval, recordFromHandoff } from "../cleaners/handoff";
import { cleanerReadiness } from "../cleaners/records";
import { notifyMembers } from "../notify/route";
import type { RequirementView } from "../cleaners/readiness";
import type { Fact } from "./schema";
import { DAY } from "./settings";

async function ownerOf(ctx: MutationCtx, companyId: Id<"companies">): Promise<Doc<"members"> | null> {
  const members = await ctx.db
    .query("members")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .take(200);
  return members.find((member) => member.role === "owner" && member.status === "active") ?? null;
}

export async function createHandoff(ctx: MutationCtx, application: Doc<"applications">, offer: Doc<"hiringOffers">, actor: Actor): Promise<Id<"onboardingHandoffs"> | null> {
  const existing = await ctx.db
    .query("onboardingHandoffs")
    .withIndex("by_company_application", (q) => q.eq("companyId", application.companyId).eq("applicationId", application._id))
    .first();
  if (existing) return existing._id;
  if (application.stage !== "accepted" || offer.status !== "accepted") return null;
  const company = (await ctx.db.get(application.companyId))!;
  const applicant = (await ctx.db.get(application.applicantId))!;
  const owner = await ownerOf(ctx, company._id);
  if (!owner) return null;
  const session = await ctx.db
    .query("formSessions")
    .withIndex("by_company_application", (q) => q.eq("companyId", company._id).eq("applicationId", application._id))
    .first();
  const answers = session?.answers ?? {};
  const told = (field: string, value: unknown): Fact[] => (typeof value === "string" || typeof value === "number" ? [{ field, value: String(value), from: "form", where: "the application form, as the applicant wrote it" }] : []);
  const information: Fact[] = [...told("name", answers.fullName ?? applicant.name), ...told("email", answers.email), ...told("phone", answers.phone), ...told("experience_years", answers.experienceYears), ...told("hours_per_week", answers.hoursPerWeek)];
  if (Array.isArray(answers.availableDays)) information.push({ field: "available_days", value: answers.availableDays.join(", "), from: "form", where: "the application form, as the applicant wrote it" });

  // One person, one record: a returning worker keeps theirs; anyone else gets a new one with the company's
  // onboarding template. Either way it is not active, has no pay set, and is offered nothing.
  const email = typeof answers.email === "string" ? answers.email : application.contact.address;
  const phone = applicant.phone ? `+${applicant.phone}` : undefined;
  const returning = await existingPerson(ctx, company._id, email, phone);
  let cleanerId: Id<"cleaners">;
  let restricted = false;
  if (returning) {
    cleanerId = returning._id;
    restricted = (await linkReturningWorker(ctx, company, returning, application._id, actor)).restricted;
  } else {
    cleanerId = await createWorker(
      ctx,
      company,
      { name: applicant.name ?? "New hire", engagement: offer.terms.engagement, email, phone, serviceAreas: Array.isArray(answers.serviceAreas) ? answers.serviceAreas.map(String) : [], hiredFrom: application._id },
      actor,
      { template: true, source: "hiring" },
    );
  }

  const dueAt = Date.now() + 3 * DAY;
  // The checklist is the company's onboarding template, the same list the Cleaners profile shows.
  const requirements = await handoffChecklist(ctx, company, offer.terms.engagement, cleanerId);
  const outstanding = requirements.filter((row) => row.status === "outstanding");
  const nextAction = `${restricted ? "This person has a rehire restriction on their record: decide before going on. " : ""}Start onboarding ${applicant.name ?? "the new hire"}: ${outstanding.map((row) => row.label.toLowerCase()).join(", ") || "every requirement is already met"}.`;
  const taskId = await openTask(ctx, {
    companyId: company._id,
    agent: "recruiter",
    title: `Onboard ${applicant.name ?? "the new hire"} (${offer.terms.role})`,
    nextAction,
    dueAt,
    completionCondition: "Every onboarding requirement is recorded as done by a person, or the hire was cancelled",
    about: { table: "applications", id: application._id },
    key: `recruiter.onboarding:${application._id}`,
    actor,
  });
  await ctx.db.patch(taskId, { trigger: "The applicant accepted an approved offer.", escalation: "Until a person marks the worker ready, Dispatch offers them no work." });
  await setTaskState(ctx, (await ctx.db.get(taskId))!, "needs_decision", { openQuestion: `${nextAction} They accepted the offer. They are not ready for work until you say so.`, dueAt, withPersonSince: Date.now() }, actor);
  const handoffId = await ctx.db.insert("onboardingHandoffs", { companyId: company._id, applicationId: application._id, applicantId: applicant._id, needId: offer.needId, cleanerId, terms: offer.terms, information, requirements, responsibleId: owner._id, nextAction, dueAt, status: "open", taskId, createdAt: Date.now() });
  await recordEvent(ctx, { companyId: company._id, type: "onboarding.handed_off", actor, subject: { table: "onboardingHandoffs", id: handoffId }, data: { applicationId: application._id, cleanerId } });
  await setStage(ctx, application, "onboarding_handoff", actor, { nextAction: { what: nextAction, by: "owner", dueAt } });
  return handoffId;
}

/** A person records that one requirement is done, or is outstanding again. */
export async function recordRequirement(ctx: MutationCtx, handoff: Doc<"onboardingHandoffs">, key: string, done: boolean, member: Doc<"members">, note: string | undefined): Promise<void> {
  if (handoff.status !== "open") throw userError("This handoff is closed.");
  if (!handoff.requirements.some((row) => row.key === key)) throw userError("That is not one of this handoff's requirements.");
  // Recorded on the cleaner too, under the template's reviewer rule, so there is one checklist.
  await recordFromHandoff(ctx, handoff, key, done, member, note);
  const requirements = handoff.requirements.map((row) => (row.key === key ? { ...row, status: done ? ("done" as const) : ("outstanding" as const), note: note?.trim().slice(0, 500) || undefined, recordedBy: member._id, at: Date.now() } : row));
  await ctx.db.patch(handoff._id, { requirements, nextAction: nextActionOf(requirements) });
  await recordEvent(ctx, { companyId: handoff.companyId, type: "onboarding.requirement_recorded", actor: { kind: "member", memberId: member._id }, subject: { table: "onboardingHandoffs", id: handoff._id }, data: { key, done } });
  await presentForApproval(ctx, { ...handoff, requirements }, { kind: "member", memberId: member._id });
}

/**
 * The Owner closes the handoff once every requirement is recorded. This ends the hiring record. It does
 * not change the worker's status: marking them ready is its own act, on the worker's record.
 */
export async function completeHandoff(ctx: MutationCtx, handoff: Doc<"onboardingHandoffs">, member: Doc<"members">): Promise<void> {
  if (handoff.status !== "open") throw userError("This handoff is closed.");
  const left = handoff.requirements.filter((row) => row.status === "outstanding");
  if (left.length > 0) throw userError(`Still outstanding: ${left.map((row) => row.label.toLowerCase()).join(", ")}.`);
  const actor: Actor = { kind: "member", memberId: member._id };
  await ctx.db.patch(handoff._id, { status: "complete", nextAction: "Mark the worker ready on their record when they can take work." });
  if (handoff.taskId) {
    const task = await ctx.db.get(handoff.taskId);
    if (task && task.status !== "done" && task.status !== "cancelled") await setTaskState(ctx, task, "done", { outcome: "Every onboarding requirement was recorded as done.", closedAt: Date.now() }, actor);
  }
  await recordEvent(ctx, { companyId: handoff.companyId, type: "onboarding.completed", actor, subject: { table: "onboardingHandoffs", id: handoff._id }, data: { cleanerId: handoff.cleanerId } });
  const application = await ctx.db.get(handoff.applicationId);
  if (application && application.stage === "onboarding_handoff") await closeApplication(ctx, application, "hired", actor, { by: member._id });
}

// ── Readiness: the checklist Recruiter shows, and the approval that hands the person to Dispatch ─────────

/** How an onboarding item stands, in the words the Owner sees. Received is never the same as approved. */
export type ChecklistState = "missing" | "received" | "awaiting_review" | "needs_changes" | "approved" | "waived" | "expired";

export type ChecklistItem = {
  key: string;
  label: string;
  state: ChecklistState;
  /** Read from the record (availability, service areas, a signed agreement) rather than reviewed by a person. */
  fromRecord: boolean;
  /** Blocks work until met. Items that only block payment, or only some services, are listed but do not hold readiness. */
  blocksWork: boolean;
  confirmedBy: string | null;
  confirmedAt: number | null;
  note: string | null;
};

function stateOf(view: RequirementView): ChecklistState {
  if (view.fromRecord) return view.met ? "approved" : "missing";
  switch (view.state) {
    case "accepted":
      return "approved";
    case "waived":
      return "waived";
    case "submitted":
      return "received";
    case "awaiting_review":
      return "awaiting_review";
    case "needs_changes":
      return "needs_changes";
    case "expired":
      return "expired";
    default:
      return "missing";
  }
}

/**
 * The readiness summary for one onboarding: every item on the company's template with who confirmed it,
 * the decisions only a person can make, and whether an authorized person may approve readiness now. It is
 * read from the shared cleaner record, so Recruiter and the Cleaners workspace always say the same thing.
 */
export async function readinessSummary(ctx: QueryCtx | MutationCtx, company: Doc<"companies">, handoff: Doc<"onboardingHandoffs">, cleaner: Doc<"cleaners">, now: number) {
  const { readiness } = await cleanerReadiness(ctx, company, cleaner, now);
  const rows = await ctx.db
    .query("workerRequirements")
    .withIndex("by_company_cleaner", (q) => q.eq("companyId", company._id).eq("cleanerId", cleaner._id))
    .take(100);
  const names = new Map<string, string>();
  const nameOf = async (id: Id<"members"> | undefined) => {
    if (!id) return null;
    if (!names.has(id)) names.set(id, (await ctx.db.get(id))?.name ?? "A former member");
    return names.get(id)!;
  };
  const items: ChecklistItem[] = [];
  for (const view of readiness.requirements) {
    const row = rows.find((item) => item.key === view.key);
    const fromHandoff = handoff.requirements.find((item) => item.key === view.key);
    const reviewer = row?.reviewedBy ?? fromHandoff?.recordedBy;
    const state = stateOf(view);
    const confirmed = state === "approved" || state === "waived";
    items.push({
      key: view.key,
      label: view.label,
      state,
      fromRecord: view.fromRecord,
      blocksWork: view.effect === "blocks_assignments" && view.forServices.length === 0,
      confirmedBy: confirmed && !view.fromRecord ? await nameOf(reviewer) : null,
      confirmedAt: confirmed && !view.fromRecord ? (row?.reviewedAt ?? fromHandoff?.at ?? null) : null,
      note: view.reviewNote ?? view.waiverReason ?? null,
    });
  }
  const decisions: string[] = [];
  if (cleaner.rehireRestriction) decisions.push("This person has a rehire restriction on their record. Decide whether to go ahead before approving.");
  if (cleaner.status === "paused" || cleaner.status === "suspended" || cleaner.status === "ended") decisions.push(`Their engagement is ${cleaner.status}. Readiness can only be approved for someone onboarding.`);
  const missing = items.filter((item) => item.blocksWork && item.state !== "approved" && item.state !== "waived");
  const unrecorded = handoff.requirements.filter((row) => row.status === "outstanding" && !items.some((item) => item.key === row.key));
  const ready = cleaner.status === "ready" && handoff.status === "complete";
  return {
    items,
    decisions,
    skillsConfirmed: cleaner.skills,
    serviceAreas: cleaner.serviceAreas,
    /** Every item that blocks work is approved or waived, and no decision is open: an authorized person may approve. */
    canApprove: !ready && handoff.status === "open" && (cleaner.status === "onboarding" || cleaner.status === "ready") && missing.length === 0 && unrecorded.length === 0 && decisions.filter((row) => !row.startsWith("This person has a rehire")).length === 0,
    approved: ready,
    stillNeeded: [...missing.map((item) => `${item.label} (${CHECKLIST_WORDS[item.state].toLowerCase()})`), ...unrecorded.map((row) => row.label)],
    dispatchEligible: readiness.eligible,
    summary: readiness.summary,
  };
}

export const CHECKLIST_WORDS: Record<ChecklistState, string> = {
  missing: "Missing",
  received: "Received",
  awaiting_review: "Awaiting review",
  needs_changes: "Needs changes",
  approved: "Approved",
  waived: "Waived",
  expired: "Expired",
};

/**
 * An authorized person approves readiness: the handoff closes (the hiring record ends as hired), the worker's
 * engagement becomes active, and Dispatch may consider them, still checking every visit on its own. Only an
 * Owner approves, as only an Owner closed a hiring handoff before. Approving again changes nothing and sends
 * nothing: the notice is keyed to the handoff.
 */
export async function approveReadiness(ctx: MutationCtx, handoff: Doc<"onboardingHandoffs">, member: Doc<"members">, options: { acknowledgeRestriction?: boolean } = {}): Promise<{ changed: boolean; detail: string }> {
  const company = (await ctx.db.get(handoff.companyId))!;
  const cleaner = await ctx.db.get(handoff.cleanerId);
  if (!cleaner || cleaner.companyId !== company._id) throw userError("The worker is no longer in the record.");
  if (handoff.status === "cancelled") throw userError("This onboarding was cancelled.");
  if (cleaner.status === "ready" && handoff.status === "complete") return { changed: false, detail: `${cleaner.name} is already approved as ready.` };
  const summary = await readinessSummary(ctx, company, handoff, cleaner, Date.now());
  const blocking = summary.decisions.filter((row) => !row.startsWith("This person has a rehire"));
  if (blocking.length > 0) throw userError(blocking[0]);
  if (cleaner.rehireRestriction && !options.acknowledgeRestriction) throw userError("This person has a rehire restriction on their record. Confirm you have decided to go ahead.");
  if (summary.stillNeeded.length > 0) throw userError(`Not ready yet. Still needed: ${summary.stillNeeded.join(", ")}.`);
  const actor: Actor = { kind: "member", memberId: member._id };
  if (handoff.status === "open") await completeHandoff(ctx, handoff, member);
  if (cleaner.status === "onboarding") {
    await ctx.db.patch(cleaner._id, { status: "ready", statusChangedAt: Date.now(), updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: company._id, type: "cleaner.status_changed", actor, subject: { table: "cleaners", id: cleaner._id }, data: { from: "onboarding", to: "ready" } });
  }
  await recordEvent(ctx, {
    companyId: company._id,
    type: "onboarding.ready_approved",
    actor,
    subject: { table: "cleaners", id: cleaner._id },
    data: { handoffId: handoff._id, applicationId: handoff.applicationId, confirmed: summary.items.filter((item) => item.confirmedBy).length, fromRecord: summary.items.filter((item) => item.fromRecord).length, restrictionAcknowledged: Boolean(cleaner.rehireRestriction) },
  });
  await notifyMembers(ctx, { companyId: company._id, event: "worker_ready", ref: cleaner._id, key: handoff._id, facts: { name: cleaner.name }, except: [member._id] });
  return { changed: true, detail: `${cleaner.name}'s onboarding is complete. Dispatch can now consider them for visits that match their availability, skills and service area.` };
}
