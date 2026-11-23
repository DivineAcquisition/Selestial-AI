/**
 * Quality Standards: what successful service means for this company, written down and versioned.
 *
 * Precedence is fixed and shown: company default < service < account < property < visit exception. Each
 * level adds requirements, replaces one with the same id, or waives one (with a reason). The result names,
 * for every requirement, the standard and version it came from.
 *
 * A visit is held to the standard in force when it was scheduled to start: a later edit or publication
 * never redefines a completed job's obligations. A visit exception is the one exception: it is agreed for
 * that visit, so the latest published version of it applies whenever it was agreed.
 *
 * With no published company standard, the company's own rules already on record are used (every checklist
 * item done or skipped with a reason, and the photo counts in Dispatch's policy), labelled as such. Nothing
 * here is presented as an industry requirement: the templates are editable starting points.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { dispatchPolicy } from "../dispatch/policy";
import { serviceKey } from "../dispatch/templates";
import { userError } from "../errors";
import { STANDARD_LEVELS, type AppliedRequirement, type Requirement, type StandardLevel, type StandardTemplate } from "./schema";

type Ctx = QueryCtx | MutationCtx;
type Standard = Doc<"qualityStandards">;

export const LEVEL_RANK: Record<StandardLevel, number> = { company: 0, service: 1, account: 2, property: 3, visit: 4 };

export function standardKey(level: StandardLevel, ref?: string): string {
  if (level === "company") return "company";
  if (!ref) throw userError("Say which service, client, property or visit this standard is for.");
  return `${level}:${level === "service" ? serviceKey(ref) : ref}`;
}

// ── Templates: editable starting points ──────────────────────────────────────────────────────────

const R = (r: Requirement): Requirement => r;

const CHECKLIST = R({ id: "checklist-complete", kind: "checklist_completion", label: "Every checklist item is marked done, or skipped with a reason", level: "required", responsible: "crew", phase: "completion" });
const AFTER = (min: number, level: "required" | "advisory" = "required") => R({ id: "after-photos", kind: "required_evidence", label: `At least ${min} after ${min === 1 ? "photo" : "photos"}`, level, responsible: "crew", phase: "completion", evidence: { photoKind: "after", minPhotos: min } });
const BEFORE = (min: number, level: "required" | "advisory" = "advisory") => R({ id: "before-photos", kind: "required_evidence", label: `At least ${min} before ${min === 1 ? "photo" : "photos"}`, level, responsible: "crew", phase: "during", evidence: { photoKind: "before", minPhotos: min } });

export const TEMPLATES: Record<StandardTemplate, { name: string; lead: string; requirements: Requirement[] }> = {
  residential_one_time: {
    name: "Residential one-time",
    lead: "A first or single visit, where the customer's expectations are least known.",
    requirements: [CHECKLIST, AFTER(4), BEFORE(2), R({ id: "first-visit-check", kind: "inspection", label: "A manager looks over the record of a customer's first visit", level: "advisory", responsible: "office", phase: "after", when: { firstVisitOnly: true } })],
  },
  residential_recurring: {
    name: "Residential recurring",
    lead: "Regular visits to the same home, where consistency matters most.",
    requirements: [CHECKLIST, AFTER(2), R({ id: "periodic-inspection", kind: "inspection", label: "Inspect the record every 6th visit", level: "advisory", responsible: "office", phase: "after", when: { recurringOnly: true, everyNthVisit: 6 } })],
  },
  deep_move_out: {
    name: "Deep and move-out",
    lead: "Larger, one-off jobs where detail is checked against a long list.",
    requirements: [CHECKLIST, AFTER(8), BEFORE(4, "required"), R({ id: "appliance-photos", kind: "required_evidence", label: "Photos of appliance interiors when they are in scope", level: "required", responsible: "crew", phase: "completion", evidence: { photoKind: "item", minPhotos: 1, checklistLabels: ["oven", "fridge", "refrigerator"] } })],
  },
  commercial: {
    name: "Commercial",
    lead: "Sites with a contract scope, access rules and set service windows.",
    requirements: [CHECKLIST, AFTER(3), R({ id: "on-time", kind: "timing", label: "Checked in within 30 minutes of the scheduled start", level: "advisory", responsible: "crew", phase: "during", evidence: { checkInWithinMinutes: 30 } })],
  },
  office: {
    name: "Office",
    lead: "Offices cleaned to a recurring task schedule, often out of hours.",
    requirements: [CHECKLIST, AFTER(2), R({ id: "secured", kind: "site_confirmation", label: "The crew confirms the site was secured on leaving", level: "advisory", responsible: "crew", phase: "completion" })],
  },
  str_turnover: {
    name: "Short-term rental turnover",
    lead: "Turnovers that must be ready before the next guest arrives.",
    requirements: [CHECKLIST, AFTER(6), R({ id: "ready-before-checkin", kind: "timing", label: "Finished at least 60 minutes before the guest's check-in", level: "required", responsible: "crew", phase: "completion", evidence: { finishBeforeDeadlineMinutes: 60 } }), R({ id: "restock", kind: "required_evidence", label: "Photos of restocked supplies", level: "advisory", responsible: "crew", phase: "completion", evidence: { photoKind: "item", minPhotos: 1, checklistLabels: ["restock", "supplies"] } })],
  },
};

// ── Validation ───────────────────────────────────────────────────────────────────────────────────

const SLUG = /^[a-z0-9][a-z0-9-]{1,47}$/;

export function checkedRequirements(input: Requirement[], level: StandardLevel): Requirement[] {
  if (input.length > 60) throw userError("A standard can hold at most 60 requirements.");
  const seen = new Set<string>();
  return input.map((r) => {
    if (!SLUG.test(r.id)) throw userError(`"${r.id}" is not a usable requirement id: lowercase letters, numbers and dashes.`);
    if (seen.has(r.id)) throw userError(`The requirement "${r.id}" is listed twice.`);
    seen.add(r.id);
    const label = r.label.trim();
    if (label.length < 3 || label.length > 200) throw userError("Each requirement needs a short label.");
    if (r.waived && level === "company") throw userError("The company default cannot waive its own requirements. Remove the requirement instead.");
    if (r.waived && r.waived.reason.trim().length < 3) throw userError("Say why the requirement is waived here.");
    const min = r.evidence?.minPhotos;
    if (min !== undefined && (!Number.isInteger(min) || min < 1 || min > 60)) throw userError("A photo requirement needs from 1 to 60 photos.");
    const nth = r.when?.everyNthVisit;
    if (nth !== undefined && (!Number.isInteger(nth) || nth < 2 || nth > 52)) throw userError("An inspection frequency is every 2nd to every 52nd visit.");
    const hours = r.escalateAfterHours;
    if (hours !== undefined && (!Number.isInteger(hours) || hours < 1 || hours > 24 * 14)) throw userError("Escalation is from 1 hour to 14 days after the visit.");
    return { ...r, label, note: r.note?.trim().slice(0, 500) || undefined, waived: r.waived ? { reason: r.waived.reason.trim().slice(0, 300) } : undefined };
  });
}

// ── Versions ─────────────────────────────────────────────────────────────────────────────────────

export async function versionsOf(ctx: Ctx, companyId: Id<"companies">, key: string): Promise<Standard[]> {
  return ctx.db
    .query("qualityStandards")
    .withIndex("by_company_key_version", (q) => q.eq("companyId", companyId).eq("key", key))
    .order("desc")
    .take(100);
}

/** The version of one standard in force at a moment: published by then, and not ended by then. */
export function inForceAt(versions: Standard[], at: number): Standard | null {
  for (const row of versions) {
    if (row.publishedAt === undefined || row.status === "draft") continue;
    if (row.publishedAt > at) continue;
    if (row.endedAt !== undefined && row.endedAt <= at) continue;
    return row;
  }
  return null;
}

/** Publishes a draft: the version in force ends now, and this one starts now. Nothing earlier changes. */
export async function publishStandard(ctx: MutationCtx, draft: Standard, memberId: Id<"members">): Promise<Standard> {
  if (draft.status !== "draft") throw userError("Only a draft can be published.");
  const now = Date.now();
  for (const row of await versionsOf(ctx, draft.companyId, draft.key)) {
    if (row._id !== draft._id && row.status === "published") await ctx.db.patch(row._id, { status: "superseded", endedAt: now, updatedAt: now });
  }
  await ctx.db.patch(draft._id, { status: "published", publishedAt: now, publishedBy: memberId, updatedAt: now });
  return (await ctx.db.get(draft._id))!;
}

// ── Resolution ───────────────────────────────────────────────────────────────────────────────────

export type Resolved = {
  asOf: number;
  sources: { standardId?: Id<"qualityStandards">; level: StandardLevel; version: number; name: string }[];
  requirements: AppliedRequirement[];
  waived: { requirementId: string; label: string; reason: string; from: AppliedRequirement["from"] }[];
  /** True when no Quality standard is published and the company's rules on record were used. */
  baseline: boolean;
  baselineWords: string | null;
};

/** The levels that could apply to a visit, most general first. */
export function keysFor(job: Pick<Doc<"jobs">, "_id" | "serviceType" | "customerId" | "propertyId">): { level: StandardLevel; key: string }[] {
  return [
    { level: "company", key: "company" },
    { level: "service", key: standardKey("service", job.serviceType) },
    { level: "account", key: standardKey("account", job.customerId) },
    { level: "property", key: standardKey("property", job.propertyId) },
    { level: "visit", key: standardKey("visit", job._id) },
  ];
}

/**
 * The requirements that applied to a visit, merged by the fixed precedence. Pure over the versions given,
 * so the same inputs always give the same answer.
 */
export function mergeStandards(chosen: Standard[], asOf: number): Omit<Resolved, "baseline" | "baselineWords"> {
  const ordered = [...chosen].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
  const merged = new Map<string, AppliedRequirement>();
  const waived = new Map<string, Resolved["waived"][number]>();
  for (const standard of ordered) {
    const from = { standardId: standard._id, level: standard.level, version: standard.version, name: standard.name };
    for (const requirement of standard.requirements) {
      if (requirement.waived) {
        const existing = merged.get(requirement.id);
        merged.delete(requirement.id);
        waived.set(requirement.id, { requirementId: requirement.id, label: existing?.requirement.label ?? requirement.label, reason: requirement.waived.reason, from });
        continue;
      }
      waived.delete(requirement.id);
      merged.set(requirement.id, { requirement, from });
    }
  }
  return {
    asOf,
    sources: ordered.map((s) => ({ standardId: s._id, level: s.level, version: s.version, name: s.name })),
    requirements: [...merged.values()].sort((a, b) => (a.requirement.id < b.requirement.id ? -1 : a.requirement.id > b.requirement.id ? 1 : 0)),
    waived: [...waived.values()],
  };
}

export async function resolveStandard(ctx: Ctx, company: Doc<"companies">, job: Doc<"jobs">, now = Date.now()): Promise<Resolved> {
  const asOf = Math.min(job.startsAt, now);
  const chosen: Standard[] = [];
  for (const { level, key } of keysFor(job)) {
    const versions = await versionsOf(ctx, company._id, key);
    // A visit exception is agreed for this visit, whenever that happened.
    const row = level === "visit" ? inForceAt(versions, now) : inForceAt(versions, asOf);
    if (row && row.status !== "retired") chosen.push(row);
  }
  const merged = mergeStandards(chosen, asOf);
  if (chosen.some((s) => s.level === "company")) return { ...merged, baseline: false, baselineWords: null };
  // No company standard: the company's own rules already on record, never an invented threshold.
  const policy = dispatchPolicy(company);
  const baseline: Requirement[] = [CHECKLIST];
  if (policy.afterPhotosRequired > 0) baseline.push({ ...AFTER(policy.afterPhotosRequired), label: `At least ${policy.afterPhotosRequired} after ${policy.afterPhotosRequired === 1 ? "photo" : "photos"} (Dispatch's rule)` });
  if (policy.beforePhotosRequired > 0) baseline.push({ ...BEFORE(policy.beforePhotosRequired, "required"), label: `At least ${policy.beforePhotosRequired} before ${policy.beforePhotosRequired === 1 ? "photo" : "photos"} (Dispatch's rule)` });
  const ids = new Set(merged.requirements.map((r) => r.requirement.id));
  const waivedIds = new Set(merged.waived.map((w) => w.requirementId));
  const pseudo = { level: "company" as const, version: 0, name: "Company rules on record" };
  const requirements = [...baseline.filter((r) => !ids.has(r.id) && !waivedIds.has(r.id)).map((requirement) => ({ requirement, from: pseudo })), ...merged.requirements];
  return {
    ...merged,
    requirements: requirements.sort((a, b) => (a.requirement.id < b.requirement.id ? -1 : 1)),
    baseline: true,
    baselineWords: "No Quality standard is published yet, so this visit was reviewed against the rules already on record: the checklist, and Dispatch's photo counts.",
  };
}

export function isBaseline(from: AppliedRequirement["from"]): boolean {
  return from.version === 0;
}

/** Whether a requirement applies to this visit, from its `when`. */
export function applies(requirement: Requirement, facts: { serviceType: string; propertyKind: string | null; firstVisit: boolean; recurring: boolean; visitNumber: number }): boolean {
  const when = requirement.when;
  if (!when) return true;
  if (when.services?.length && !when.services.map(serviceKey).includes(serviceKey(facts.serviceType))) return false;
  if (when.propertyKinds?.length && (!facts.propertyKind || !when.propertyKinds.includes(facts.propertyKind))) return false;
  if (when.firstVisitOnly && !facts.firstVisit) return false;
  if (when.recurringOnly && !facts.recurring) return false;
  if (when.everyNthVisit && facts.visitNumber % when.everyNthVisit !== 0) return false;
  return true;
}

export { STANDARD_LEVELS };
