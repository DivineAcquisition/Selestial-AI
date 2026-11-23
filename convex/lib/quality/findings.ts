/**
 * Findings: what the evidence supports, one statement each, with what supports it, what conflicts with it
 * and what is missing. A finding is "suggested" until a person reviews it; only reviewed findings count in
 * patterns, corrections and insights.
 *
 * The rules here never blame a person. A reported area that was listed as not included is a scope
 * misunderstanding, not a cleaner's fault. A skip because of locked rooms is an access limitation. A crew
 * record that says "done" against a customer who says "not done" is conflicting evidence, and photos do not
 * settle it. No finding is a disciplinary decision, a penalty or an accusation, and none can be made into one.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { recordEvent, type Actor } from "../events";
import { userError } from "../errors";
import { areasIn, sharedAreas } from "../retention/cases";
import type { JobFacts } from "./evidence";
import { FINDING_CATEGORIES, type FindingCategory, type QualitySource } from "./schema";
import { addEntry } from "./cases";
import { FINDING_WORDS, QUALITY } from "./words";

type Ctx = QueryCtx | MutationCtx;
type Finding = Doc<"qualityFindings">;

/** Words a finding may not use, whoever wrote it: they accuse, conclude about a person, or decide a consequence. */
const BLAME = /\b(fault|blame\w*|negligen\w*|lazy|careless\w*|lied|lying|dishonest\w*|guilty|incompeten\w*|disciplin\w*|penal\w*|punish\w*|terminat\w*|fire (?:him|her|them)|suspend\w*|dock(?:ed)? (?:pay|wages)|strike against|write(?:-| )?up|misconduct|should be (?:let go|removed))\b/i;

export function blameIn(text: string): string | null {
  const m = BLAME.exec(text);
  return m ? m[0] : null;
}

export type SuggestedFinding = { category: FindingCategory; statement: string; areas: string[]; supporting: QualitySource[]; conflicting: { text: string; source?: QualitySource }[]; missing: string[] };

const ACCESS = /\b(lock\w*|no key|key didn'?t|couldn'?t (?:get|access)|no access|access|gate code|alarm|door code|blocked|occupied|guest (?:was )?still)\b/i;
const EQUIPMENT = /\b(vacuum|equipment|supplies|supply|product|ran out of (?:product|solution|bags)|broken (?:mop|vacuum)|no (?:ladder|step stool)|tools?)\b/i;
const TIME = /\b(ran out of time|not enough time|out of time|time ran out|over ?ran|overtime|running late)\b/i;
const LATE_WORDS = /\b(late|didn'?t show|no[- ]show|never (?:came|showed)|wrong (?:day|time))\b/i;

const src = (table: string, id: string, label: string, at?: number): QualitySource => ({ table, id, label, ...(at !== undefined ? { at } : {}) });

/**
 * The rules' reading of a concern against the visit's record. Pure: the same inputs give the same findings.
 * `report` is the concern's own source (feedback, a message, a call extract), when there is one.
 */
export function suggestFindings(input: { facts: JobFacts; areas: string[]; words?: string; report?: QualitySource; serious: string | null }): SuggestedFinding[] {
  const { facts } = input;
  const out: SuggestedFinding[] = [];
  const jobSrc = src("jobs", facts.job._id, "The visit's record", facts.job.startsAt);
  const reportSupport = input.report ? [input.report] : [];
  if (input.serious) {
    out.push({ category: "serious_incident", statement: "A possible safety, damage, theft, injury or conduct concern was reported. A person reviews it; nothing has been concluded.", areas: input.areas, supporting: reportSupport, conflicting: [], missing: ["What happened, from each person involved", "Any photos or records of the condition"] });
    return out;
  }
  const words = input.words ?? "";
  if (LATE_WORDS.test(words)) {
    const accepted = facts.crew.filter((c) => c.status === "accepted");
    const late = accepted.filter((c) => c.lateReported || (c.checkInAt !== null && c.checkInAt > facts.job.startsAt + ((facts.job.arrivalWindowMinutes ?? 0) + 15) * 60_000));
    const noCheck = accepted.length === 0 || accepted.every((c) => c.checkInAt === null);
    out.push({
      category: late.length || noCheck ? "scheduling_failure" : "insufficient_evidence",
      statement: late.length ? "The record shows a late arrival on this visit, matching the timing concern reported." : noCheck ? "No check-in is on record for this visit, matching the timing concern reported." : "A timing concern was reported, but the check-in times on record are inside the arrival window.",
      areas: [],
      supporting: [...reportSupport, ...late.map((c) => src("assignments", c.assignmentId, c.name, c.checkInAt ?? undefined))],
      conflicting: late.length || noCheck ? [] : accepted.filter((c) => c.checkInAt !== null).map((c) => ({ text: `${c.name} checked in on time by the record.`, source: src("assignments", c.assignmentId, c.name, c.checkInAt!) })),
      missing: noCheck ? ["A check-in time for the crew"] : [],
    });
  }
  for (const area of input.areas) {
    const excluded = facts.scope.excluded.find((line) => sharedAreas(areasIn(line), [area]).length > 0);
    const included = facts.scope.included.find((line) => sharedAreas(areasIn(line), [area]).length > 0);
    const items = facts.checklist.filter((c) => sharedAreas(areasIn(c.label), [area]).length > 0);
    if (excluded && !included) {
      out.push({ category: "scope_misunderstanding", statement: `"${excluded}" was listed as not included in the service booked for this visit. The concern about the ${area} is about work outside the booked scope.`, areas: [area], supporting: [...reportSupport, jobSrc], conflicting: [], missing: ["Whether the customer was told what the service excluded when they booked"] });
      continue;
    }
    if (!items.length) {
      out.push({ category: "insufficient_evidence", statement: `The concern about the ${area} has no matching checklist item, so the visit's record says nothing about it either way.`, areas: [area], supporting: reportSupport, conflicting: [], missing: [`A checklist item or photo covering the ${area}`] });
      continue;
    }
    for (const item of items) {
      const itemSrc = src("checklistItems", item.id, item.label);
      if (item.state === "skipped" && item.skipReason && ACCESS.test(item.skipReason)) {
        out.push({ category: "access_limitation", statement: `"${item.label}" was skipped because of access: "${item.skipReason}". The crew could not do it as booked.`, areas: [area], supporting: [...reportSupport, itemSrc], conflicting: [], missing: ["Whether access was arranged for this visit"] });
      } else if (item.state === "skipped" && item.skipReason && EQUIPMENT.test(item.skipReason)) {
        out.push({ category: "equipment_limitation", statement: `"${item.label}" was skipped for equipment or supplies: "${item.skipReason}".`, areas: [area], supporting: [...reportSupport, itemSrc], conflicting: [], missing: ["Which equipment or supplies were missing, and who provides them"] });
      } else if (item.state === "skipped" && item.skipReason && TIME.test(item.skipReason)) {
        out.push({ category: "scheduling_failure", statement: `"${item.label}" was skipped for time: "${item.skipReason}". The time booked may not fit the scope.`, areas: [area], supporting: [...reportSupport, itemSrc], conflicting: [], missing: ["How long the scope usually takes at this property"] });
      } else if (item.state === "skipped" || item.state === "pending") {
        out.push({ category: "service_miss", statement: `"${item.label}" was in the visit's checklist and was ${item.state === "skipped" ? `skipped${item.skipReason ? ` ("${item.skipReason}")` : " with no reason given"}` : "never marked done"}. The concern about the ${area} matches the record.`, areas: [area], supporting: [...reportSupport, itemSrc], conflicting: [], missing: item.state === "pending" ? ["The crew's account of this task"] : [] });
      } else {
        // Marked done, and reported as not done. Neither settles it: photos show a limited view.
        out.push({
          category: "insufficient_evidence",
          statement: `"${item.label}" is marked done on the checklist${item.photos ? ` with ${item.photos} ${item.photos === 1 ? "photo" : "photos"}` : ""}, and the concern says ${area} was not done well. The record does not settle which is right.`,
          areas: [area],
          supporting: reportSupport,
          conflicting: [{ text: `The crew marked "${item.label}" done.`, source: itemSrc }],
          missing: ["A look at the area (an inspection or a photo from the customer)", "The crew's account of this task"],
        });
      }
    }
  }
  if (!out.length && input.report) out.push({ category: "insufficient_evidence", statement: "A concern was reported without naming a task or area, so there is nothing yet to compare with the visit's record.", areas: [], supporting: reportSupport, conflicting: [], missing: ["Which rooms or tasks the concern is about"] });
  // One finding per category and area.
  const seen = new Set<string>();
  return out.filter((f) => {
    const key = `${f.category}:${f.areas.join(",")}:${f.supporting.map((s) => s.id).join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A reader's (model's) suggestions, kept only where they cite sources that really are in the evidence and use no blaming words. */
export function checkedReaderFindings(raw: unknown, known: Map<string, QualitySource>): { kept: SuggestedFinding[]; dropped: { reason: string }[] } {
  const kept: SuggestedFinding[] = [];
  const dropped: { reason: string }[] = [];
  if (!Array.isArray(raw)) return { kept, dropped: [{ reason: "not a list" }] };
  for (const item of raw.slice(0, 8)) {
    const f = item as { category?: unknown; statement?: unknown; sourceIds?: unknown; conflicting?: unknown; missing?: unknown; areas?: unknown };
    if (typeof f.category !== "string" || !(FINDING_CATEGORIES as readonly string[]).includes(f.category)) {
      dropped.push({ reason: "unknown category" });
      continue;
    }
    if (typeof f.statement !== "string" || f.statement.trim().length < 10) {
      dropped.push({ reason: "no statement" });
      continue;
    }
    const blamed = blameIn(f.statement);
    if (blamed) {
      dropped.push({ reason: `uses "${blamed}"` });
      continue;
    }
    const ids = Array.isArray(f.sourceIds) ? f.sourceIds.filter((x): x is string => typeof x === "string") : [];
    const sources = ids.map((id) => known.get(id)).filter((s): s is QualitySource => s !== undefined);
    // Every cited source must exist. A finding that cites nothing real, or cites anything invented, is not kept.
    if (!sources.length || sources.length !== ids.length) {
      dropped.push({ reason: "cites a source that is not in the evidence" });
      continue;
    }
    // A photo shows a limited view: photos alone never establish that there was no issue.
    if (f.category === "no_issue_established" && sources.every((s) => s.table === "evidence")) {
      dropped.push({ reason: "concludes there was no issue from photos alone" });
      continue;
    }
    kept.push({
      category: f.category as FindingCategory,
      statement: f.statement.trim().slice(0, 400),
      areas: Array.isArray(f.areas) ? f.areas.filter((a): a is string => typeof a === "string").slice(0, 6) : [],
      supporting: sources,
      conflicting: Array.isArray(f.conflicting) ? f.conflicting.filter((c): c is string => typeof c === "string").slice(0, 4).map((text) => ({ text: text.slice(0, 300) })) : [],
      missing: Array.isArray(f.missing) ? f.missing.filter((m): m is string => typeof m === "string").slice(0, 4).map((m) => m.slice(0, 200)) : [],
    });
  }
  return { kept, dropped };
}

export async function findingsOf(ctx: Ctx, row: Pick<Doc<"qualityCases">, "_id" | "companyId">): Promise<Finding[]> {
  return ctx.db
    .query("qualityFindings")
    .withIndex("by_company_case", (q) => q.eq("companyId", row.companyId).eq("caseId", row._id))
    .take(60);
}

/** Records suggested findings once: the same category, statement and sources already on the case are not added again. */
export async function recordSuggestions(ctx: MutationCtx, row: Doc<"qualityCases">, suggestions: SuggestedFinding[], by: string, actor: Actor = QUALITY): Promise<number> {
  const existing = await findingsOf(ctx, row);
  let added = 0;
  for (const s of suggestions) {
    const blamed = blameIn(s.statement);
    if (blamed) continue;
    if (existing.some((e) => e.category === s.category && e.statement === s.statement && e.state !== "rejected")) continue;
    const now = Date.now();
    const id = await ctx.db.insert("qualityFindings", { companyId: row.companyId, caseId: row._id, category: s.category, statement: s.statement, areas: s.areas, state: "suggested", supporting: s.supporting, conflicting: s.conflicting, missing: s.missing, suggestedBy: by, revision: 1, history: [{ at: now, by: actor, change: `Suggested by ${by === "rules" ? "the company's rules" : by}` }], createdAt: now, updatedAt: now });
    await addEntry(ctx, row, { kind: "finding", basis: "analysis", text: `Suggested finding (${FINDING_WORDS[s.category]}): ${s.statement}`, source: { table: "qualityFindings", id, label: "Finding" }, actor });
    added += 1;
  }
  return added;
}

/** A person confirms, rejects or revises a finding. Every change is kept in its history; nothing is overwritten silently. */
export async function reviewFinding(ctx: MutationCtx, finding: Finding, input: { action: "confirm" | "reject" | "revise"; statement?: string; category?: FindingCategory; note?: string; memberId: Id<"members"> }): Promise<Finding> {
  const actor: Actor = { kind: "member", memberId: input.memberId };
  const now = Date.now();
  if (input.action === "revise") {
    const statement = input.statement?.trim();
    if (!statement || statement.length < 10) throw userError("Write the finding as one sentence that says what the evidence shows.");
    const blamed = blameIn(statement);
    if (blamed) throw userError(`A finding says what the evidence shows, not who is at fault. Remove "${blamed}".`);
    await ctx.db.patch(finding._id, { statement: statement.slice(0, 400), category: input.category ?? finding.category, state: "reviewed", reviewedBy: input.memberId, reviewedAt: now, revision: finding.revision + 1, history: [...finding.history, { at: now, by: actor, change: `Revised${input.note ? `: ${input.note}` : ""}`, statement: finding.statement, category: finding.category, state: finding.state }].slice(-40), updatedAt: now });
  } else {
    await ctx.db.patch(finding._id, { state: input.action === "confirm" ? "reviewed" : "rejected", reviewedBy: input.memberId, reviewedAt: now, revision: finding.revision + 1, history: [...finding.history, { at: now, by: actor, change: input.action === "confirm" ? `Reviewed and confirmed${input.note ? `: ${input.note}` : ""}` : `Rejected${input.note ? `: ${input.note}` : ""}`, state: finding.state }].slice(-40), updatedAt: now });
  }
  const fresh = (await ctx.db.get(finding._id))!;
  const row = (await ctx.db.get(finding.caseId))!;
  await addEntry(ctx, row, { kind: "finding", basis: "fact", text: `${input.action === "confirm" ? "Finding reviewed" : input.action === "reject" ? "Finding rejected" : "Finding revised"}: ${fresh.statement}`, source: { table: "qualityFindings", id: fresh._id, label: "Finding" }, actor });
  await recordEvent(ctx, { companyId: finding.companyId, type: `quality_finding.${input.action === "confirm" ? "reviewed" : input.action === "reject" ? "rejected" : "revised"}`, actor, subject: { table: "qualityFindings", id: finding._id }, data: { category: fresh.category } });
  await ctx.db.patch(row._id, { revision: row.revision + 1, updatedAt: now, ...(row.firstActionAt === undefined ? { firstActionAt: now } : {}) });
  return fresh;
}
