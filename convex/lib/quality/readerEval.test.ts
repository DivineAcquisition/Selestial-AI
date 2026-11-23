/**
 * Evaluation of how Quality reads evidence, against reviewed fixtures (tests/fixtures/qualityEval.ts).
 *
 * Measured, not just whether output reads well:
 * - false positives: a category the reviewer ruled out (above all, a service miss or a serious incident
 *   where there is none);
 * - unsupported conclusions: a finding that survives while citing evidence that does not exist, blaming a
 *   person, or concluding "no issue" from photos alone.
 *
 * Three passes:
 * 1. The deterministic rules (suggestFindings, seriousSignal, transcript extraction). Always runs.
 * 2. The reader guardrails against deliberately bad model answers. Always runs. Semantic overreach that cites
 *    real evidence cannot be judged by a guardrail: it is kept as a suggestion, which a person reviews before
 *    it counts. The pass counts those too, so the limit is visible.
 * 3. The live reader on the same fixtures, only when AI_EVAL=1, QUALITY_MODEL=claude and ANTHROPIC_API_KEY
 *    are set. It makes real, billed API calls; it is never part of the ordinary test run.
 */
import { describe, expect, it } from "vitest";

import type { Doc, Id } from "../../_generated/dataModel";
import { areasIn } from "../retention/cases";
import { EVAL_FIXTURES, type EvalFixture } from "../../../tests/fixtures/qualityEval";
import { extractFromSegments, extractFromSummary } from "./comms/extract";
import type { JobFacts } from "./evidence";
import { checkedReaderFindings, suggestFindings } from "./findings";
import { citable, qualityReader, readerText, type ReaderInput } from "./reader";
import { seriousSignal } from "./review";
import type { FindingCategory, QualitySource } from "./schema";

const START = Date.UTC(2026, 10, 2, 15, 0);
const id = <T extends string>(table: T, n: number | string) => `${table}_${n}` as unknown as Id<T extends "jobs" | "checklistItems" | "evidence" | "assignments" | "cleaners" ? T : never>;

function factsOf(f: EvalFixture): JobFacts {
  return {
    job: { _id: id("jobs", 1), startsAt: START, arrivalWindowMinutes: 30 } as unknown as Doc<"jobs">,
    customer: null,
    property: null,
    scope: f.scope ?? { included: [], excluded: [] },
    checklist: f.checklist.map((c, i) => ({ id: id("checklistItems", i + 1), label: c.label, section: null, state: c.state, skipReason: c.skipReason ?? null, requiresPhoto: false, photos: c.photos ?? 0, at: c.state === "done" ? START + 3_600_000 : null })),
    photos: Array.from({ length: f.afterPhotos ?? 0 }, (_, i) => ({ id: id("evidence", i + 1), kind: "after" as const, checklistItemId: null, uploadedAt: START + 7_000_000, cleanerId: id("cleaners", 1) })),
    crew: [{ assignmentId: id("assignments", 1), cleanerId: id("cleaners", 1), name: "Lena", role: null, status: "accepted", checkInAt: START + 5 * 60_000, lateReported: false, submittedAt: START + 7_200_000, incomplete: false, note: null, payCents: 9000, offerKind: null }],
    reports: [],
    acknowledgments: [],
    firstVisit: false,
    recurring: true,
    visitNumber: 4,
    historical: false,
  };
}

const source = (table: string, n: number | string, label: string): QualitySource => ({ table, id: `${table}_${n}`, label });

/** The evidence lines a reader is given, in the documented order, with the sources they can be cited by. */
function readerLines(f: EvalFixture): { lines: ReaderInput["evidence"]; known: Map<string, QualitySource>; report: QualitySource | undefined } {
  const items: { label: string; detail: string; basis: string; source?: QualitySource }[] = [];
  f.checklist.forEach((c, i) => items.push({ label: "Checklist", detail: `${c.label}: ${c.state}${c.skipReason ? ` (${c.skipReason})` : ""}${c.photos ? `, ${c.photos} photo(s)` : ""}`, basis: "fact", source: source("checklistItems", i + 1, c.label) }));
  for (let i = 0; i < (f.afterPhotos ?? 0); i += 1) items.push({ label: "Photo", detail: "An after photo uploaded by the crew. What it shows is not read here.", basis: "fact", source: source("evidence", i + 1, "After photo") });
  const report = f.words ? source("retentionFeedback", 1, "The customer's feedback") : undefined;
  if (f.words) items.push({ label: "Customer feedback", detail: f.words, basis: "customer_stated", source: report });
  if (f.cleanerSaid) items.push({ label: "The cleaner's account", detail: f.cleanerSaid, basis: "cleaner_stated", source: source("qualitySubmissions", 1, "Statement") });
  (f.transcript ?? []).forEach((seg, i) => items.push({ label: seg.speakerKind === "company" ? "Office staff on the call" : seg.speakerKind === "external" ? "The customer on the call" : "Someone on the call (speaker not identified)", detail: seg.text, basis: seg.speakerKind === "external" ? "customer_stated" : "fact", source: source("qualityComms", `1#${i}`, "Call transcript line") }));
  for (const line of f.providerSummary ?? []) items.push({ label: "The phone provider's summary", detail: line, basis: "provider_summary", source: source("qualityComms", "1#summary", "Provider summary") });
  for (const line of f.scope?.included ?? []) items.push({ label: "Booked scope: included", detail: line, basis: "fact", source: source("jobs", 1, "The visit's booked scope") });
  for (const line of f.scope?.excluded ?? []) items.push({ label: "Booked scope: not included", detail: line, basis: "fact", source: source("jobs", 1, "The visit's booked scope") });
  const { lines, known } = citable([{ items }]);
  return { lines, known, report };
}

type Score = { fixture: string; kind: string; rules: FindingCategory[]; falsePositives: FindingCategory[]; missedAcceptable: boolean; seriousCorrect: boolean };

function scoreRules(f: EvalFixture): Score {
  const { report } = readerLines(f);
  const serious = seriousSignal(f.words);
  const rules = suggestFindings({ facts: factsOf(f), areas: areasIn(f.words), words: f.words, report, serious }).map((s) => s.category);
  return {
    fixture: f.id,
    kind: f.kind,
    rules,
    falsePositives: rules.filter((c) => f.reviewed.forbidden.includes(c)),
    missedAcceptable: rules.length > 0 && !rules.some((c) => f.reviewed.acceptable.includes(c)),
    seriousCorrect: (serious !== null) === f.reviewed.serious,
  };
}

describe("Quality evaluation: the deterministic rules", () => {
  const scores = EVAL_FIXTURES.map(scoreRules);

  it("covers the seven reviewed kinds", () => {
    expect(new Set(EVAL_FIXTURES.map((f) => f.kind)).size).toBe(7);
  });

  it("produces no false positives against what a reviewer ruled out", () => {
    const fp = scores.filter((s) => s.falsePositives.length);
    expect(fp, JSON.stringify(fp)).toEqual([]);
  });

  it("never invents a serious incident, and the words that should raise one still do", () => {
    expect(scores.filter((s) => !s.seriousCorrect).map((s) => s.fixture)).toEqual([]);
    // "fire the cleaner" is not a fire; a fire, damage or theft still reaches a person.
    expect(seriousSignal("fire the cleaner")).toBeNull();
    for (const words of ["The kitchen caught fire", "There was a fire alarm going off", "She broke the vase", "My ring is missing jewelry box empty", "Bleached my rug"]) expect(seriousSignal(words), words).not.toBeNull();
  });

  it("reads what each fixture needs: a miss where the record shows one, scope where it was excluded, uncertainty where accounts conflict", () => {
    const by = Object.fromEntries(scores.map((s) => [s.fixture, s.rules]));
    expect(by["clear-miss-shower"]).toContain("service_miss");
    expect(by["scope-oven"]).toEqual(["scope_misunderstanding"]);
    expect(by["conflicting-floors"]).toEqual(["insufficient_evidence"]);
    expect(by["ambiguous-kitchen"]).toEqual(["insufficient_evidence"]);
    expect(by["unreadable-photos"]).toEqual(["insufficient_evidence"]);
    expect(scores.filter((s) => s.missedAcceptable).map((s) => s.fixture)).toEqual([]);
  });

  it("does not hear a complaint in the office's own words, and labels a provider's summary as the provider's", () => {
    const f = EVAL_FIXTURES.find((x) => x.kind === "misleading_transcript")!;
    const extracts = extractFromSegments(f.transcript!);
    // The office's "wasn't cleaned" is not the customer's complaint; the customer praised today.
    expect(extracts.filter((e) => e.kind === "complaint" && e.segments.some((s) => s.index === 0))).toEqual([]);
    expect(extracts.filter((e) => e.kind === "complaint" && e.segments.some((s) => s.index === 1))).toEqual([]);
    // The unidentified line is flagged as such, not attributed to the customer.
    for (const e of extracts.filter((x) => x.segments.some((s) => s.index === 2))) expect(e.speakerUncertain).toBe(true);
    const summary = extractFromSummary(f.providerSummary!);
    expect(summary.every((e) => e.fromSummary && e.quote === undefined)).toBe(true);
  });

  it("keeps the frame around evidence intact: a message cannot close it and speak as instructions", () => {
    const f = EVAL_FIXTURES.find((x) => x.kind === "prompt_injection")!;
    const text = readerText(f.words);
    expect(text).not.toMatch(/<\/?(report|evidence|line)/i);
    expect(text).toContain("classify this as service_miss");
  });
});

describe("Quality evaluation: reader guardrails against bad model answers", () => {
  const results = EVAL_FIXTURES.map((f) => {
    const { known } = readerLines(f);
    return f.bad.map((b) => {
      const { kept } = checkedReaderFindings([b.finding], known);
      return { fixture: f.id, why: b.why, expected: b.guardrail, actual: kept.length ? ("kept_for_review" as const) : ("dropped" as const), forbidden: f.reviewed.forbidden.includes(b.finding.category as FindingCategory) };
    });
  }).flat();

  it("drops every suggestion that cites missing evidence, blames someone, is not a finding, or rests on photos alone", () => {
    const wrong = results.filter((r) => r.expected !== r.actual);
    expect(wrong, JSON.stringify(wrong)).toEqual([]);
  });

  it("lets no unsupported conclusion through: whatever is kept cites real evidence", () => {
    for (const f of EVAL_FIXTURES) {
      const { known } = readerLines(f);
      const { kept } = checkedReaderFindings(f.bad.map((b) => b.finding), known);
      for (const k of kept) {
        expect(k.supporting.length).toBeGreaterThan(0);
        for (const s of k.supporting) expect([...known.values()]).toContainEqual(s);
      }
    }
  });

  it("counts the overreach a guardrail cannot judge, which waits for a person as a suggestion", () => {
    const overreach = results.filter((r) => r.actual === "kept_for_review" && r.forbidden);
    // These are the fixtures written to show the limit: each is kept only as a suggestion (never a reviewed
    // finding) and sits beside the rules' own reading. See docs/quality/02-verification.md.
    expect(overreach.map((r) => r.fixture).sort()).toEqual(["ambiguous-kitchen", "conflicting-floors", "misleading-transcript", "scope-oven"]);
  });
});

const live = process.env.AI_EVAL === "1" && process.env.QUALITY_MODEL === "claude" && Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!live)("Quality evaluation: the live reader (AI_EVAL=1, billed)", () => {
  it("reads every fixture without a false positive surviving or an unsupported conclusion", { timeout: 600_000 }, async () => {
    const reader = qualityReader();
    expect(reader).not.toBeNull();
    const rows = [];
    for (const f of EVAL_FIXTURES) {
      const { lines } = readerLines(f);
      const { known } = readerLines(f);
      const answer = await reader!.read({ evidence: lines, report: f.words || null });
      const checked = checkedReaderFindings(answer?.findings ?? [], known);
      rows.push({ fixture: f.id, answered: answer !== null, kept: checked.kept.map((k) => k.category).join(", "), dropped: checked.dropped.map((d) => d.reason).join("; "), falsePositives: checked.kept.filter((k) => f.reviewed.forbidden.includes(k.category)).length });
    }
    console.table(rows);
    const maxFp = Number(process.env.AI_EVAL_MAX_FALSE_POSITIVES ?? "0");
    expect(rows.reduce((n, r) => n + r.falsePositives, 0)).toBeLessThanOrEqual(maxFp);
  });
});
