/**
 * The completion review: the standard that applied, compared with what is on record for the visit.
 *
 * Deterministic: the same standard and the same facts always give the same outcome. Each requirement is
 * met, missing, contradictory, cannot be checked from the record, does not apply, or was waived. Required
 * gaps hold the review for a person; advisory gaps are noted and hold nothing. Documentation being complete
 * says nothing about how the service looked to the customer, and the summary says so.
 *
 * The review recommends; it never closes a visit, approves pay or decides anything about a cleaner.
 */
import { areasIn, sharedAreas } from "../retention/cases";
import type { JobFacts } from "./evidence";
import type { AppliedRequirement, QualitySource, Recommendation, RequirementOutcome, RequirementResult } from "./schema";
import { applies, type Resolved } from "./standards";
import { plural } from "./words";

const src = (table: string, id: string, label: string, at?: number): QualitySource => ({ table, id, label, ...(at !== undefined ? { at } : {}) });

const SERIOUS = /\b(damag\w*|broke|broken|shatter\w*|stole|stolen|theft|missing (?:jewel\w*|cash|money|item\w*)|injur\w*|hurt|unsafe|hazard\w*|bleach(?:ed)? (?:stain|my)|harass\w*|inappropriat\w*|threat\w*|assault\w*|police|lawsuit|lawyer|attorney|insurance claim|(?:a|on|caught|started a) fire|fire (?:alarm|hazard|damage)|smoke damage|flood\w*|leak\w*)\b/i;

/** A safety, damage, theft, injury or conduct signal in someone's words. A person handles these. */
export function seriousSignal(words: string | undefined | null): string | null {
  if (!words) return null;
  const match = SERIOUS.exec(words);
  return match ? `The words include "${match[0].toLowerCase()}". Safety, damage, theft, injury and conduct concerns are handled by a person.` : null;
}

export type ReviewOutput = {
  results: RequirementResult[];
  completeness: { required: number; met: number; missing: number; contradictory: number; unverifiable: number; advisoryGaps: number };
  flags: { code: string; text: string; sources: QualitySource[] }[];
  recommendation: Recommendation;
  summary: string;
  checked: string[];
  found: string[];
  /** What the crew could supply to close a required gap: photos and checklist marks. */
  askable: { cleanerIds: string[]; items: { id: string; label: string; photoKind?: "before" | "after" | "item" | "issue"; requirementId: string }[] };
  serious: string | null;
};

const lower = (s: string) => s.trim().toLowerCase();

function matching(labels: string[] | undefined, label: string): boolean {
  if (!labels?.length) return true;
  const l = lower(label);
  return labels.some((x) => l.includes(lower(x)));
}

export function reviewFacts(standard: Pick<Resolved, "requirements" | "waived" | "baseline" | "baselineWords">, facts: JobFacts, extra: { openConcernAtProperty: boolean; complaintsInComms: QualitySource[] }): ReviewOutput {
  const job = facts.job;
  const jobSrc = src("jobs", job._id, "This visit", job.startsAt);
  const accepted = facts.crew.filter((c) => c.status === "accepted");
  const crewIds = accepted.map((c) => c.cleanerId as string);
  const submittedAt = accepted.reduce((latest, c) => Math.max(latest, c.submittedAt ?? 0), 0) || null;
  const incompleteWords = [...accepted.filter((c) => c.incomplete).map((c) => c.note ?? ""), ...facts.reports.filter((r) => r.kind === "incomplete").map((r) => r.text)].join(" ");
  const incompleteAreas = areasIn(incompleteWords);
  const results: RequirementResult[] = [];
  const askable: ReviewOutput["askable"] = { cleanerIds: crewIds, items: [] };
  const checked: string[] = [];
  const visit = { serviceType: job.serviceType, propertyKind: facts.property?.kind ?? null, firstVisit: facts.firstVisit, recurring: facts.recurring, visitNumber: facts.visitNumber };

  const push = (applied: AppliedRequirement, outcome: RequirementOutcome, detail: string, sources: QualitySource[] = [jobSrc]) => {
    const r = applied.requirement;
    results.push({ requirementId: r.id, label: r.label, level: r.level, responsible: r.responsible, outcome, detail, sources, from: applied.from.version === 0 ? undefined : applied.from });
  };

  for (const applied of standard.requirements) {
    const r = applied.requirement;
    if (!applies(r, visit)) {
      push(applied, "not_applicable", "Does not apply to this visit.");
      continue;
    }
    switch (r.kind) {
      case "checklist_completion": {
        const items = facts.checklist.filter((c) => matching(r.evidence?.checklistLabels, c.label));
        checked.push(`${plural(items.length, "checklist item")} against "${r.label}"`);
        if (!facts.checklist.length) {
          push(applied, "unverifiable", "This visit has no checklist, so there is no record of which tasks were marked.");
          break;
        }
        if (!items.length) {
          push(applied, "not_applicable", "No checklist item on this visit matches it.");
          break;
        }
        const pending = items.filter((c) => c.state === "pending");
        const noReason = items.filter((c) => c.state === "skipped" && !c.skipReason);
        const contradicted = items.filter((c) => c.state === "done" && sharedAreas(areasIn(c.label), incompleteAreas).length > 0);
        if (contradicted.length) {
          push(applied, "contradictory", `${contradicted.map((c) => `"${c.label}"`).join(", ")} ${contradicted.length === 1 ? "is" : "are"} marked done, but the crew also reported that area left unfinished.`, contradicted.map((c) => src("checklistItems", c.id, c.label)));
        } else if (pending.length || noReason.length) {
          const parts = [pending.length ? `${plural(pending.length, "item")} never marked (${pending.slice(0, 4).map((c) => `"${c.label}"`).join(", ")})` : "", noReason.length ? `${plural(noReason.length, "item")} skipped with no reason` : ""].filter(Boolean);
          push(applied, "missing", `${parts.join("; ")}.`, [...pending, ...noReason].map((c) => src("checklistItems", c.id, c.label)));
          if (r.level === "required") for (const c of [...pending, ...noReason]) askable.items.push({ id: `mark:${c.id}`, label: `Mark "${c.label}" done, or say why it was skipped`, requirementId: r.id });
        } else push(applied, "met", `All ${plural(items.length, "item")} marked: ${items.filter((c) => c.state === "done").length} done, ${items.filter((c) => c.state === "skipped").length} skipped with a reason.`);
        break;
      }
      case "required_evidence": {
        const kind = r.evidence?.photoKind;
        const min = r.evidence?.minPhotos ?? 1;
        const labels = r.evidence?.checklistLabels;
        if (labels?.length) {
          const items = facts.checklist.filter((c) => matching(labels, c.label) && c.state !== "skipped");
          checked.push(`photos for ${plural(items.length, "matching checklist item")}`);
          if (!items.length) {
            push(applied, "not_applicable", "No matching task was in scope on this visit.");
            break;
          }
          const short = items.filter((c) => c.photos < min);
          if (short.length) {
            push(applied, "missing", `${short.map((c) => `"${c.label}"`).join(", ")} ${short.length === 1 ? "has" : "have"} fewer than ${plural(min, "photo")}.`, short.map((c) => src("checklistItems", c.id, c.label)));
            if (r.level === "required") for (const c of short) askable.items.push({ id: `photo:${c.id}`, label: `A photo of "${c.label}"`, photoKind: "item", requirementId: r.id });
          } else push(applied, "met", `Each matching task has at least ${plural(min, "photo")}.`);
          break;
        }
        const have = facts.photos.filter((p) => !kind || p.kind === kind);
        checked.push(`${plural(have.length, `${kind ?? ""} photo`.trim())} against "${r.label}"`);
        const late = submittedAt ? have.filter((p) => p.uploadedAt > submittedAt) : [];
        if (have.length >= min) push(applied, "met", `${plural(have.length, `${kind ?? ""} photo`.trim())} on record${late.length ? `, ${late.length} uploaded after the crew submitted (when they were taken is not recorded)` : ""}.`);
        else {
          push(applied, "missing", `${plural(have.length, `${kind ?? ""} photo`.trim())} on record; the standard asks for ${min}.`);
          if (r.level === "required") askable.items.push({ id: `photos:${r.id}`, label: `${min - have.length} more ${kind ?? ""} ${min - have.length === 1 ? "photo" : "photos"}`.replace(/\s+/g, " "), photoKind: kind ?? "after", requirementId: r.id });
        }
        // A done task that the checklist itself says needs a photo, with none, is a gap too.
        break;
      }
      case "guide_acknowledgment":
      case "document": {
        const name = r.evidence?.documentName ? lower(r.evidence.documentName) : null;
        checked.push(`${r.kind === "document" ? "documents" : "acknowledgments"} for ${plural(accepted.length, "crew member")}`);
        if (!name) {
          push(applied, "unverifiable", "The requirement does not name the guide or document to look for.");
          break;
        }
        const missingFor = accepted.filter((c) => !facts.acknowledgments.some((a) => a.cleanerId === c.cleanerId && (lower(a.label).includes(name) || lower(a.key).includes(name)) && (r.kind === "document" ? a.accepted : a.acknowledgedAt !== null)));
        if (!accepted.length) push(applied, "unverifiable", "No crew is on record for this visit.");
        else if (missingFor.length) push(applied, "missing", `${missingFor.map((c) => c.name).join(", ")} ${missingFor.length === 1 ? "has" : "have"} no ${r.kind === "document" ? "accepted document" : "acknowledgment"} of "${r.evidence!.documentName}" on record.`, missingFor.map((c) => src("cleaners", c.cleanerId, c.name)));
        else push(applied, "met", `Every crew member has it on record.`);
        break;
      }
      case "inspection":
        checked.push("whether an inspection is due");
        push(applied, "unverifiable", "An inspection is due for this visit. A person records it on the review.");
        break;
      case "site_confirmation":
        push(applied, "unverifiable", "No record in Selestial holds this confirmation yet. A person confirms it on the review.");
        break;
      case "timing": {
        const within = r.evidence?.checkInWithinMinutes;
        const before = r.evidence?.finishBeforeDeadlineMinutes;
        if (within !== undefined) {
          const first = accepted.map((c) => c.checkInAt).filter((x): x is number => x !== null).sort((a, b) => a - b)[0];
          const allowed = job.startsAt + ((job.arrivalWindowMinutes ?? 0) + within) * 60_000;
          checked.push("check-in time against the arrival window");
          if (first === undefined) push(applied, "unverifiable", "No check-in time is on record.");
          else if (first <= allowed) push(applied, "met", "The first check-in was inside the window.");
          else push(applied, "missing", `The first check-in was ${Math.round((first - allowed) / 60_000)} minutes after the window.`, accepted.filter((c) => c.checkInAt === first).map((c) => src("assignments", c.assignmentId, c.name, first)));
        } else if (before !== undefined) {
          checked.push("finish time against the guest's check-in");
          if (job.hardDeadlineAt === undefined) push(applied, "not_applicable", "This visit has no hard deadline.");
          else if (!submittedAt) push(applied, "unverifiable", "No finish time is on record yet.");
          else if (submittedAt <= job.hardDeadlineAt - before * 60_000) push(applied, "met", "The crew submitted in time before the deadline.");
          else push(applied, "missing", `The crew submitted ${Math.round((submittedAt - (job.hardDeadlineAt - before * 60_000)) / 60_000)} minutes later than the standard allows before the deadline.`);
        } else push(applied, "unverifiable", "The timing requirement does not say what to measure.");
        break;
      }
    }
  }
  // A task the checklist says needs a photo, done without one, whatever the standard says.
  for (const c of facts.checklist) {
    if (c.requiresPhoto && c.state === "done" && c.photos === 0 && !results.some((r) => r.sources.some((s) => s.id === c.id))) {
      results.push({ requirementId: `photo-required:${c.id}`, label: `"${c.label}" needs a photo (set on the checklist)`, level: "required", responsible: "crew", outcome: "missing", detail: "Marked done with no photo attached.", sources: [src("checklistItems", c.id, c.label)] });
      askable.items.push({ id: `photo:${c.id}`, label: `A photo of "${c.label}"`, photoKind: "item", requirementId: `photo-required:${c.id}` });
    }
  }

  const required = results.filter((r) => r.level === "required" && r.outcome !== "not_applicable" && r.outcome !== "waived");
  const completeness = {
    required: required.length,
    met: required.filter((r) => r.outcome === "met").length,
    missing: required.filter((r) => r.outcome === "missing").length,
    contradictory: required.filter((r) => r.outcome === "contradictory").length,
    unverifiable: required.filter((r) => r.outcome === "unverifiable").length,
    advisoryGaps: results.filter((r) => r.level === "advisory" && (r.outcome === "missing" || r.outcome === "contradictory")).length,
  };

  // ── Flags: things a person should know, each with its source ──
  const flags: ReviewOutput["flags"] = [];
  for (const c of accepted.filter((c) => c.incomplete)) flags.push({ code: "incomplete_reported", text: `${c.name} submitted the visit as incomplete${c.note ? `: "${c.note.slice(0, 160)}"` : ""}.`, sources: [src("assignments", c.assignmentId, c.name)] });
  const inScope = facts.scope.included.map(lower);
  for (const c of facts.checklist.filter((c) => c.state === "skipped")) {
    const scoped = inScope.some((line) => line.includes(lower(c.label)) || sharedAreas(areasIn(line), areasIn(c.label)).length > 0);
    if (scoped) flags.push({ code: "skipped_in_scope", text: `"${c.label}" was in the booked scope and was skipped${c.skipReason ? `: ${c.skipReason}` : ""}. A skip is the crew's report, not a finding.`, sources: [src("checklistItems", c.id, c.label)] });
  }
  for (const r of facts.reports.filter((r) => r.kind === "condition")) flags.push({ code: "condition_reported", text: `The crew reported a condition at the property: "${r.text.slice(0, 160)}".`, sources: [src("jobReports", r.id, "Crew report", r.at)] });
  for (const r of facts.reports.filter((r) => r.kind === "addon_request" && r.status === "awaiting_decision")) flags.push({ code: "scope_request_open", text: `A request to add to the scope is waiting for a decision: "${r.text.slice(0, 120)}".`, sources: [src("jobReports", r.id, "Crew request", r.at)] });
  if (!facts.photos.length) flags.push({ code: "no_photos", text: "No photos were uploaded for this visit.", sources: [jobSrc] });
  if ((job.completionReturns ?? 0) > 0) flags.push({ code: "returned_before", text: `The report was sent back ${plural(job.completionReturns ?? 0, "time")} before this submission.`, sources: [jobSrc] });
  if (extra.openConcernAtProperty) flags.push({ code: "open_concern_here", text: "There is an open quality or recovery case at this property.", sources: [] });
  for (const s of extra.complaintsInComms) flags.push({ code: "concern_in_conversation", text: "A conversation linked to this visit contains a concern. It is a report, not a finding.", sources: [s] });
  if (facts.historical) flags.push({ code: "historical", text: "Imported from another system: reviewed for the record only. Nobody is contacted about it.", sources: [jobSrc] });

  const serious = seriousSignal([incompleteWords, ...facts.reports.map((r) => r.text)].join(" "));
  if (serious) flags.push({ code: "serious_signal", text: serious, sources: facts.reports.map((r) => src("jobReports", r.id, "Crew report", r.at)) });

  // ── Recommendation ──
  let recommendation: Recommendation = "approve";
  const hasAsk = askable.items.length > 0;
  if (serious || completeness.contradictory > 0) recommendation = "investigate";
  else if (flags.some((f) => f.code === "incomplete_reported" || f.code === "skipped_in_scope")) recommendation = "correct";
  else if (completeness.missing > 0 && hasAsk && !facts.historical) recommendation = "request_information";
  else if (completeness.missing > 0 || completeness.unverifiable > 0) recommendation = "investigate";
  if (recommendation === "investigate" && completeness.contradictory === 0 && !serious && completeness.missing === 0 && completeness.unverifiable > 0 && required.every((r) => r.outcome !== "missing")) {
    // Only things a person confirms on the review (an inspection, a site confirmation): ask the person, not the crew.
    recommendation = "investigate";
  }

  const found: string[] = [];
  found.push(completeness.required ? `${completeness.met} of ${plural(completeness.required, "required item")} met` : "No required items applied");
  if (completeness.missing) found.push(`${completeness.missing} missing`);
  if (completeness.contradictory) found.push(`${completeness.contradictory} contradictory`);
  if (completeness.unverifiable) found.push(`${completeness.unverifiable} a person must confirm`);
  if (completeness.advisoryGaps) found.push(`${plural(completeness.advisoryGaps, "advisory gap")}, which hold nothing`);
  for (const f of flags.slice(0, 4)) found.push(f.text);

  const head =
    recommendation === "approve"
      ? "The visit's record meets the standard that applied."
      : recommendation === "request_information"
        ? "Something the standard asks for is not on record yet, and the crew can supply it."
        : recommendation === "correct"
          ? "The crew's own record shows work in the booked scope was not done."
          : "The record does not settle this visit on its own. A person should look.";
  const summary = `${head} ${found.slice(0, 3).map((f) => f.replace(/\.+$/, "")).join("; ")}. ${standard.baseline && standard.baselineWords ? `${standard.baselineWords} ` : ""}A complete record is not proof of how the service looked; it is what was documented.`.replace(/\s+/g, " ").trim();
  return { results, completeness, flags, recommendation, summary, checked, found, askable, serious };
}
