/**
 * The improvement loop: reviewed patterns become proposals, a person decides, and the effect is measured.
 *
 * Only findings a person reviewed count. Each proposal shows its sample (how many reviewed findings, out of
 * how many visits of that kind in the window), what it affects, the change, who carries it out, and how its
 * effect will be read. Adopting one changes nothing by itself beyond the named step: a checklist or inspection
 * change becomes a draft standard a person publishes; anything owned by Sales, Dispatch, Recruiter or the
 * Owner becomes a task in their queue. Results after adoption are reported with their counts, and a small
 * sample is said to be too small to conclude anything. No individual cleaner is ever the subject of a proposal.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { requestApproval } from "../approvalQueue";
import { serviceKey } from "../dispatch/templates";
import { recordEvent } from "../events";
import { openTask, setTaskState } from "../taskState";
import type { FindingCategory, ImprovementKind } from "./schema";
import { qualitySettings } from "./settings";
import { standardKey, versionsOf } from "./standards";
import { DAY, IMPROVEMENT_WORDS, QUALITY, SYSTEM } from "./words";

type Ctx = QueryCtx | MutationCtx;

const WINDOW_DAYS = 90;
/** Below this many visits on either side, a before/after comparison is reported as too small to read. */
export const SMALL_SAMPLE = 20;

const MAP: Partial<Record<FindingCategory, { kind: ImprovementKind; owner: Doc<"qualityImprovements">["owner"] }>> = {
  service_miss: { kind: "checklist_change", owner: "quality" },
  scope_misunderstanding: { kind: "scope_exclusion", owner: "sales" },
  access_limitation: { kind: "property_instruction", owner: "dispatch" },
  equipment_limitation: { kind: "equipment", owner: "owner" },
  scheduling_failure: { kind: "scheduling_assumption", owner: "dispatch" },
};

type Group = { key: string; category: FindingCategory; area: string | null; service: string | null; propertyId: Id<"properties"> | null; findings: Doc<"qualityFindings">[]; cases: Set<Id<"qualityCases">> };

/**
 * Visits in the window that the crew reported done, whether or not a manager has closed them yet: the visits
 * Quality reviews. Correction visits are not counted, so a correction never inflates the denominator.
 */
export async function visitsDoneSince(ctx: Ctx, companyId: Id<"companies">, since: number): Promise<Doc<"jobs">[]> {
  const completed = await ctx.db.query("jobs").withIndex("by_company_status_start", (q) => q.eq("companyId", companyId).eq("status", "completed").gte("startsAt", since)).take(2000);
  const reported = (await ctx.db.query("jobs").withIndex("by_company_status_start", (q) => q.eq("companyId", companyId).eq("status", "in_progress").gte("startsAt", since)).take(1000)).filter((j) => j.completionReportedAt !== undefined);
  return [...completed, ...reported].filter((j) => j.recovery === undefined);
}

async function visitsSince(ctx: Ctx, companyId: Id<"companies">, since: number, filter: (j: Doc<"jobs">) => boolean): Promise<number> {
  return (await visitsDoneSince(ctx, companyId, since)).filter(filter).length;
}

/** Groups reviewed findings in the window by what they share. Pure over the rows given. */
export function groupFindings(rows: { finding: Doc<"qualityFindings">; job: Doc<"jobs"> | null }[]): Group[] {
  const groups = new Map<string, Group>();
  for (const { finding, job } of rows) {
    if (finding.state !== "reviewed" || !MAP[finding.category]) continue;
    const areas = finding.areas.length ? finding.areas : [null];
    for (const area of areas) {
      const byProperty = finding.category === "access_limitation" || finding.category === "equipment_limitation";
      const service = job ? serviceKey(job.serviceType) : null;
      const propertyId = byProperty ? (job?.propertyId ?? null) : null;
      const key = `${finding.category}:${byProperty ? `property:${propertyId}` : `service:${service}`}:${area ?? "-"}`;
      const g = groups.get(key) ?? { key, category: finding.category, area, service: byProperty ? null : service, propertyId, findings: [], cases: new Set() };
      g.findings.push(finding);
      g.cases.add(finding.caseId);
      groups.set(key, g);
    }
  }
  return [...groups.values()];
}

function words(g: Group, serviceName: string): { title: string; change: string; benefit: string } {
  const area = g.area ?? "the same task";
  switch (MAP[g.category]!.kind) {
    case "checklist_change":
      return { title: `Make ${area} explicit on the ${serviceName} checklist`, change: `Add a checklist item for ${area} with a required photo to the ${serviceName} standard, so it is recorded on every visit.`, benefit: `Fewer reviewed misses on ${area}, and a record either way when it is raised.` };
    case "scope_exclusion":
      return { title: `Say clearly whether ${area} is included in ${serviceName}`, change: `Name ${area} in the service's "not included" wording and add a booking question about it.`, benefit: "Customers know before the visit what is and is not done." };
    case "property_instruction":
      return { title: "Add access instructions for this property", change: "Record how the crew gets in (keys, codes, who to call) on the property, and confirm them before the next visit.", benefit: "Fewer visits where work could not be done because of access." };
    case "equipment":
      return { title: `Settle the equipment for ${area}`, change: `Decide who provides the equipment or supplies for ${area} at this property and record it.`, benefit: "Fewer skips for missing equipment or supplies." };
    case "scheduling_assumption":
      return { title: `Review the time booked for ${serviceName}`, change: `Compare the time booked for ${serviceName} with how long visits take, and adjust the duration or the scope.`, benefit: "Fewer tasks skipped for time." };
    default:
      return { title: IMPROVEMENT_WORDS[MAP[g.category]!.kind], change: "", benefit: "" };
  }
}

/** Finds patterns worth a proposal and records each once. Returns how many were proposed. */
export async function scanPatterns(ctx: MutationCtx, company: Doc<"companies">, now: number): Promise<number> {
  const since = now - WINDOW_DAYS * DAY;
  const minimum = qualitySettings(company).patternMinimum;
  const reviewed = await ctx.db
    .query("qualityFindings")
    .withIndex("by_company_category", (q) => q.eq("companyId", company._id))
    .take(2000);
  const rows: { finding: Doc<"qualityFindings">; job: Doc<"jobs"> | null }[] = [];
  for (const finding of reviewed) {
    if (finding.state !== "reviewed" || (finding.reviewedAt ?? 0) < since) continue;
    const row = await ctx.db.get(finding.caseId);
    if (!row || row.historical || row.restricted) continue;
    rows.push({ finding, job: row.jobId ? await ctx.db.get(row.jobId) : null });
  }
  let proposed = 0;
  for (const g of groupFindings(rows)) {
    if (g.cases.size < minimum) continue;
    const map = MAP[g.category]!;
    const key = `pattern:${g.key}`;
    const existing = await ctx.db
      .query("qualityImprovements")
      .withIndex("by_company_key", (q) => q.eq("companyId", company._id).eq("key", key))
      .first();
    if (existing && existing.state !== "declined" && existing.state !== "withdrawn" && existing.state !== "evaluated") continue;
    const serviceName = g.service ?? "this service";
    const denominator = await visitsSince(ctx, company._id, since, (j) => (g.propertyId ? j.propertyId === g.propertyId : g.service ? serviceKey(j.serviceType) === g.service : true));
    const w = words(g, serviceName);
    await ctx.db.insert("qualityImprovements", {
      companyId: company._id,
      key: existing ? `${key}:${now}` : key,
      kind: map.kind,
      title: w.title,
      proposedChange: w.change,
      evidence: { findingIds: g.findings.map((f) => f._id).slice(0, 50), caseIds: [...g.cases].slice(0, 50), count: g.cases.size, denominator, denominatorLabel: g.propertyId ? "completed visits at this property" : `completed ${serviceName} visits`, windowDays: WINDOW_DAYS },
      affects: { services: g.service ? [g.service] : [], propertyIds: g.propertyId ? [g.propertyId] : [] },
      expectedBenefit: w.benefit,
      owner: map.owner,
      evaluation: { measure: `Reviewed ${g.category.replace(/_/g, " ")} findings${g.area ? ` about ${g.area}` : ""}, per ${g.propertyId ? "visit at the property" : `${serviceName} visit`}`, windowDays: WINDOW_DAYS, baselineCount: g.cases.size, baselineDenominator: denominator },
      state: "proposed",
      createdAt: now,
      updatedAt: now,
    });
    proposed += 1;
  }
  return proposed;
}

/** A person sends a proposal for decision. The Owner decides (the approvals queue). */
export async function submitImprovement(ctx: MutationCtx, company: Doc<"companies">, improvement: Doc<"qualityImprovements">): Promise<void> {
  if (improvement.state !== "proposed") return;
  const approvalId = await requestApproval(ctx, {
    companyId: company._id,
    action: "quality.propose_improvement",
    summary: improvement.title,
    reason: `${improvement.evidence.count} reviewed ${improvement.evidence.count === 1 ? "case" : "cases"} out of ${improvement.evidence.denominator} ${improvement.evidence.denominatorLabel} in ${improvement.evidence.windowDays} days. ${improvement.expectedBenefit}`,
    authorizes: `${improvement.proposedChange} Carried out by ${improvement.owner === "quality" ? "Quality as a draft standard you publish" : improvement.owner === "owner" ? "you" : improvement.owner}. Nothing else changes.`,
    ifWaiting: "Nothing changes.",
    decideBy: Date.now() + 14 * DAY,
    proposal: { kind: "quality_improvement", improvementId: improvement._id },
  });
  await ctx.db.patch(improvement._id, { state: "awaiting_approval", approvalId, updatedAt: Date.now() });
}

/** Carries out an approved proposal: a draft standard, or a task for the record's owner. Nothing is published here. */
export async function adoptImprovement(ctx: MutationCtx, company: Doc<"companies">, improvement: Doc<"qualityImprovements">, memberId: Id<"members">): Promise<{ ok: boolean; detail: string }> {
  const now = Date.now();
  let detail: string;
  if (improvement.kind === "checklist_change" || improvement.kind === "inspection_frequency") {
    const service = improvement.affects.services[0];
    const propertyId = improvement.affects.propertyIds[0];
    const level = propertyId ? "property" : service ? "service" : "company";
    const key = level === "company" ? "company" : standardKey(level, propertyId ?? service);
    const versions = await versionsOf(ctx, company._id, key);
    const latest = versions.find((v) => v.status === "published") ?? versions[0];
    const area = improvement.title.match(/explicit on|Make (.+?) explicit/)?.[1] ?? "the task";
    const requirement = improvement.kind === "checklist_change"
      ? { id: `photo-${area.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 30) || "task"}`, kind: "required_evidence" as const, label: `A photo of ${area}`, level: "required" as const, responsible: "crew" as const, phase: "completion" as const, evidence: { photoKind: "item" as const, minPhotos: 1, checklistLabels: [area] } }
      : { id: "periodic-inspection", kind: "inspection" as const, label: "Inspect the record every 4th visit", level: "advisory" as const, responsible: "office" as const, phase: "after" as const, when: { everyNthVisit: 4 } };
    const requirements = [...(latest?.requirements ?? []).filter((r) => r.id !== requirement.id), requirement];
    const draftId = await ctx.db.insert("qualityStandards", { companyId: company._id, level, key, serviceKey: level === "service" ? service : undefined, propertyId: level === "property" ? propertyId : undefined, version: (versions[0]?.version ?? 0) + 1, status: "draft", name: latest?.name ?? (level === "service" ? `${service} standard` : level === "property" ? "Property standard" : "Company standard"), requirements, remedy: latest?.remedy, changeNote: `From an approved improvement: ${improvement.title}`, createdBy: QUALITY, createdAt: now, updatedAt: now });
    detail = "A draft standard with the change is ready in Standards. It applies once a person publishes it, to visits scheduled after that.";
    await recordEvent(ctx, { companyId: company._id, type: "quality_standard.drafted", actor: QUALITY, subject: { table: "qualityStandards", id: draftId }, data: { from: "improvement" } });
  } else {
    const agent = improvement.owner === "sales" ? "sales" : improvement.owner === "dispatch" ? "dispatch" : improvement.owner === "recruiter" ? "recruiter" : "quality";
    const taskId = await openTask(ctx, { companyId: company._id, agent, title: improvement.title.slice(0, 200), nextAction: improvement.proposedChange.slice(0, 500), dueAt: now + 14 * DAY, completionCondition: "The change is made in the record it belongs to, or a person recorded why not.", key: `quality.improvement:${improvement._id}`, actor: SYSTEM });
    await setTaskState(ctx, (await ctx.db.get(taskId))!, "needs_decision", { openQuestion: `${improvement.proposedChange} (approved from Quality's improvement proposals)`.slice(0, 1000), dueAt: now + 14 * DAY, withPersonSince: now }, SYSTEM);
    detail = `Handed to ${improvement.owner === "owner" ? "the Owner" : improvement.owner} as a task. It is not done until the change is made.`;
  }
  await ctx.db.patch(improvement._id, { state: "adopted", approvalId: undefined, decidedBy: memberId, decidedAt: now, adoptedAt: now, updatedAt: now });
  await recordEvent(ctx, { companyId: company._id, type: "quality_improvement.adopted", actor: { kind: "member", memberId }, subject: { table: "qualityImprovements", id: improvement._id }, data: { kind: improvement.kind } });
  return { ok: true, detail };
}

/** After an adopted change has had its window, reads the same measure again and says what may be concluded. */
export async function evaluateImprovements(ctx: MutationCtx, company: Doc<"companies">, now: number): Promise<number> {
  const adopted = await ctx.db
    .query("qualityImprovements")
    .withIndex("by_company_state", (q) => q.eq("companyId", company._id).eq("state", "adopted"))
    .take(50);
  let n = 0;
  for (const imp of adopted) {
    if (!imp.adoptedAt || now < imp.adoptedAt + imp.evaluation.windowDays * DAY) continue;
    const denominator = await visitsSince(ctx, company._id, imp.adoptedAt, (j) => (imp.affects.propertyIds.length ? imp.affects.propertyIds.includes(j.propertyId) : imp.affects.services.length ? imp.affects.services.includes(serviceKey(j.serviceType)) : true));
    const findings = await ctx.db
      .query("qualityFindings")
      .withIndex("by_company_category", (q) => q.eq("companyId", company._id))
      .take(2000);
    const sample = imp.evidence.findingIds.length ? await ctx.db.get(imp.evidence.findingIds[0]) : null;
    const after = new Set(findings.filter((f) => f.state === "reviewed" && sample && f.category === sample.category && (f.reviewedAt ?? 0) >= imp.adoptedAt! && (!sample.areas.length || f.areas.some((a) => sample.areas.includes(a)))).map((f) => f.caseId)).size;
    const small = denominator < SMALL_SAMPLE || imp.evaluation.baselineDenominator < SMALL_SAMPLE;
    const words = `${after} of ${denominator} visits since the change, against ${imp.evaluation.baselineCount} of ${imp.evaluation.baselineDenominator} before. ${small ? `With fewer than ${SMALL_SAMPLE} visits on one side, this is too small to say whether the change made a difference.` : "This is a before-and-after count; other things changed too, so it does not prove the change caused the difference."}`;
    await ctx.db.patch(imp._id, { state: "evaluated", result: { at: now, count: after, denominator, words }, updatedAt: now });
    n += 1;
  }
  return n;
}
