/**
 * Recommendations: what Selestial's deterministic checks find in a texting setup, each with who is
 * responsible, the issue, the rule it rests on, a proposed change, its effect, the approval it needs and
 * the next action. Pure functions, so every rule is tested without a database.
 *
 * No model is used here: every finding below is a known requirement checked exactly. A recommendation never
 * changes a confirmed business fact on its own, never invents consent (it can only point at the places and
 * evidence the owner gave), never says a document was reviewed when it was not, and never presents a check
 * as the carriers' approval.
 *
 * Each recommendation carries a fingerprint of exactly the facts it read. When those facts change, the
 * recommendation is revalidated: an approval given on the old facts no longer applies.
 */
import type { Agent } from "../statuses";
import { ACTIVITIES, chosen } from "./activities";
import { EVIDENCE_PURPOSE_WORDS, type EvidencePurpose } from "./caseSchema";
import { draftProblems } from "./checks";
import { type Config, ownerOf, templateWords } from "./config";
import { draftFor, draftGaps, type DraftInput } from "./drafts";
import { DRAFT_KEYS, type DraftKey, type SetupStep } from "./schema";

export type Proposal =
  | { kind: "draft_text"; draftKey: string; text: string }
  | { kind: "confirm_field"; field: string }
  | { kind: "add_evidence"; purpose: EvidencePurpose; place?: string }
  | { kind: "review_copy"; evidenceId: string }
  | { kind: "open_step"; step: SetupStep }
  | { kind: "start_correction" };

export type Finding = {
  key: string;
  rule: string;
  responsible: { kind: "check" } | { kind: "agent"; agent: Agent };
  stage: SetupStep;
  field?: string;
  issue: string;
  basisWords: string;
  proposal: Proposal;
  proposalWords: string;
  effect: string;
  approval: "none" | "owner" | "owner_and_charges";
  nextAction: string;
  fingerprint: string;
};

export type RecommendInput = {
  companyName: string;
  setup: {
    business: Record<string, string | undefined>;
    sources: readonly { field: string; source: string; confirmed: boolean }[];
    activities: readonly string[];
    places: readonly string[];
    hosting?: string;
    drafts: Record<string, { text: string; edited: boolean }>;
  };
  draftInput: DraftInput;
  request: { status: string; activities?: readonly string[]; needs?: { kind: string; words: string; fields: readonly string[] } | null } | null;
  evidence: readonly { id: string; key: string; purpose: string; place?: string; kind: string; visibility: string; state: string; replaced: boolean; reviewCopyOf?: string }[];
  config: Config;
};

/** FNV-1a, enough to tell whether the facts a finding read have changed. Not a security measure. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(36)}.${text.length}`;
}

const LEGAL = /\b(llc|l\.l\.c\.|inc|incorporated|ltd|corp|corporation|co|company|llp|pllc)\b\.?/g;
const plainName = (value: string | undefined) => (value ?? "").toLowerCase().replace(LEGAL, "").replace(/[^a-z0-9]+/g, " ").trim();

const DRAFT_WORDS: Record<DraftKey, string> = { sms_consent: "text permission wording", marketing_consent: "marketing permission wording", terms: "texting terms", privacy: "privacy policy", help_reply: "HELP reply", stop_reply: "STOP reply", start_reply: "START reply", opt_in_flow: "opt-in description" };
const FIELD_STEP: Record<string, SetupStep> = { activities: "activities", number: "number", phoneNumber: "number", ...Object.fromEntries(DRAFT_KEYS.map((key) => [key, "permission"])) };

function responsibleFor(config: Config, task: Parameters<typeof ownerOf>[1], fallback?: Agent): Finding["responsible"] {
  const owner = ownerOf(config, task);
  if (owner !== "check") return { kind: "agent", agent: owner };
  return fallback ? { kind: "agent", agent: fallback } : { kind: "check" };
}

export function findings(input: RecommendInput): Finding[] {
  const out: Finding[] = [];
  const { setup, config } = input;
  const name = setup.business.displayName || input.companyName;

  // 1. The name customers see differs from the company's own record, and the owner hasn't confirmed it.
  const display = setup.business.displayName;
  const displaySource = setup.sources.find((row) => row.field === "displayName");
  if (display && plainName(display) !== plainName(input.companyName) && !(displaySource?.confirmed ?? false)) {
    out.push({
      key: "name_mismatch:displayName",
      rule: "name_mismatch",
      responsible: responsibleFor(config, "business"),
      stage: "business",
      field: "displayName",
      issue: templateWords(config, "recommendation.name_mismatch", `Your business name differs between two records: "{a}" here and "{b}" on your Selestial account.`, { a: display, b: input.companyName }),
      basisWords: "Carriers reject registrations whose brand name doesn't match the name on the website, samples and texts.",
      proposal: { kind: "confirm_field", field: "displayName" },
      proposalWords: `Confirm "${display}" is the name customers know you by, or change it.`,
      effect: "Confirming records that you checked it. Nothing is changed for you: Selestial never picks a name on your behalf.",
      approval: "owner",
      nextAction: "Confirm the name or change it on Your business.",
      fingerprint: fingerprint(["name", display, input.companyName, displaySource?.confirmed ?? false]),
    });
  }

  // 2. Wording the owner edited that no longer says what carriers require: offer Selestial's version.
  const states = draftProblems(setup.drafts, input.draftInput);
  const marketing = chosen(setup.activities).some((row) => row.category === "marketing");
  for (const state of states) {
    const draft = setup.drafts[state.key];
    if (!state.gaps.length) continue;
    const proposed = draftFor(state.key, input.draftInput);
    const proposedOk = draftGaps(state.key, proposed, input.draftInput).length === 0;
    const promo = state.key === "marketing_consent" && marketing;
    if (!draft?.edited && !promo) continue;
    if (!proposedOk) continue;
    const promotionsAgent = ACTIVITIES.find((row) => row.key === "promotions")?.group as Agent | undefined;
    out.push({
      key: `draft:${state.key}`,
      rule: promo ? "promotions_without_marketing_consent" : "draft_requirement",
      responsible: responsibleFor(config, "permission", promo ? promotionsAgent : undefined),
      stage: "permission",
      field: state.key,
      issue: promo ? templateWords(config, "recommendation.marketing_consent", "This registration includes promotions, but your wording doesn't ask separately for permission to send them.", { business: name }) : `Your ${DRAFT_WORDS[state.key]} needs to ${state.gaps[0]}.`,
      basisWords: promo ? "Carriers require separate, optional permission for promotional texts, naming the business, with rates and STOP." : `Carrier requirement: the ${DRAFT_WORDS[state.key]} must ${state.gaps.join("; ")}.`,
      proposal: { kind: "draft_text", draftKey: state.key, text: proposed },
      proposalWords: `Use Selestial's ${DRAFT_WORDS[state.key]}, written from your details.`,
      effect: draft?.edited ? "Replaces your edited wording in the draft. Nothing is published or filed until you publish and submit." : "Fills in the draft. Nothing is published or filed until you publish and submit.",
      approval: "owner",
      nextAction: "Apply it, edit it, or dismiss it.",
      fingerprint: fingerprint(["draft", state.key, draft?.text ?? "", proposed]),
    });
  }

  // 3. An opt-in screenshot or form that a reviewer outside Selestial would need to see: offer a review copy.
  const originals = input.evidence.filter((row) => (row.purpose === "opt_in_screenshot" || row.purpose === "opt_in_form") && row.kind === "file" && !row.replaced && !row.reviewCopyOf && row.visibility === "company");
  for (const row of originals) {
    if (input.evidence.some((copy) => copy.reviewCopyOf === row.id && !copy.replaced)) continue;
    out.push({
      key: `review_copy:${row.key}`,
      rule: "review_copy",
      responsible: responsibleFor(config, "evidence"),
      stage: "permission",
      field: row.place,
      issue: templateWords(config, "recommendation.review_copy", "This opt-in screenshot needs a blank or redacted review copy before anyone outside Selestial can see it."),
      basisWords: "Carriers may ask to see the opt-in. A real screenshot can show a person's name, number or signature, which must never leave Selestial.",
      proposal: { kind: "review_copy", evidenceId: row.id },
      proposalWords: "Add a blank or redacted copy of the same screen. It stays private until you approve showing it.",
      effect: "Keeps the original private. Only the copy can ever be shown, and only after you approve it and Selestial checks it.",
      approval: "owner",
      nextAction: "Upload a blank or redacted copy in Evidence & notes.",
      fingerprint: fingerprint(["copy", row.id]),
    });
  }

  // 4. A correction someone asked for: one finding per field, sent back to the step that holds it.
  if (input.request?.needs?.kind === "correction") {
    const fields = input.request.needs.fields.length ? input.request.needs.fields : ["details"];
    for (const field of fields.slice(0, 10)) {
      const step = FIELD_STEP[field] ?? "business";
      out.push({
        key: `correction:${field}`,
        rule: "correction_field",
        responsible: responsibleFor(config, "corrections"),
        stage: step,
        field,
        issue: templateWords(config, "recommendation.correction_field", "A correction was asked for on {field}.", { field: field === "details" ? "your details" : field }),
        basisWords: input.request.needs.words,
        proposal: { kind: "open_step", step },
        proposalWords: "Open the step, make the change, and submit the corrected details.",
        effect: "Everything else you filled in is kept. A corrected filing with the carriers may carry the correction fee you authorized.",
        approval: "owner",
        nextAction: "Correct it and submit again.",
        fingerprint: fingerprint(["correction", field, input.request.needs.words]),
      });
    }
  }

  // 5. An active registration that doesn't cover what the setup now asks for.
  if (input.request?.status === "active" && input.request.activities) {
    const filed = new Set(input.request.activities);
    const missing = chosen(setup.activities).filter((row) => !filed.has(row.key));
    if (missing.length) {
      const words = missing.map((row) => row.label.toLowerCase()).join(", ");
      const covered = chosen(input.request.activities).map((row) => row.label.toLowerCase());
      out.push({
        key: "coverage_gap",
        rule: "coverage_gap",
        responsible: responsibleFor(config, "corrections", missing[0].group as Agent),
        stage: "activities",
        field: "activities",
        issue: templateWords(config, "recommendation.coverage_gap", `Your registration covers ${covered.slice(0, 3).join(", ") || "other texts"} but not {missing}.`, { missing: words }),
        basisWords: "Texts are sent only for what the active registration covers. A new kind of text needs an updated registration.",
        proposal: { kind: "start_correction" },
        proposalWords: "Update your registration to cover these texts.",
        effect: "Approving this records that you want the update; it doesn't file or charge anything. Filing a change with the carriers happens only when you submit it and authorize its fee.",
        approval: "owner_and_charges",
        nextAction: "Review the change and submit it when ready.",
        fingerprint: fingerprint(["coverage", [...filed].sort(), [...setup.activities].sort()]),
      });
    }
  }

  // 6. Evidence the setup can't show on its own: places Selestial can't see, and configured requirements.
  const needs: { purpose: EvidencePurpose; place?: string; why: string; key: string }[] = [];
  if (setup.places.includes("other")) needs.push({ purpose: "opt_in_screenshot", place: "other", why: "Selestial can't see this place, so carriers' reviewers will need to see it.", key: "place:other" });
  if (setup.hosting === "own_site" && setup.places.includes("website")) needs.push({ purpose: "opt_in_screenshot", place: "website", why: "Your sign-up is on your own website, which Selestial doesn't record.", key: "place:website" });
  for (const rule of config.rules) {
    if (rule.type !== "evidence_required" || (rule.place && !setup.places.includes(rule.place))) continue;
    needs.push({ purpose: rule.purpose, place: rule.place, why: "Required by Selestial's current registration requirements.", key: `rule:${rule.purpose}:${rule.place ?? ""}` });
  }
  for (const need of needs) {
    const present = input.evidence.some((row) => row.purpose === need.purpose && (!need.place || !row.place || row.place === need.place) && !row.replaced && row.state !== "missing" && row.state !== "needs_replacement");
    if (present) continue;
    const label = EVIDENCE_PURPOSE_WORDS[need.purpose].label.toLowerCase();
    out.push({
      key: `evidence:${need.key}`,
      rule: "evidence_required",
      responsible: responsibleFor(config, "evidence"),
      stage: "permission",
      field: need.place,
      issue: templateWords(config, "recommendation.evidence_required", "Add evidence: {purpose}.", { purpose: label }),
      basisWords: need.why,
      proposal: { kind: "add_evidence", purpose: need.purpose, ...(need.place ? { place: need.place } : {}) },
      proposalWords: `Add a ${label} to Evidence & notes.`,
      effect: "Adds a placeholder you then fill in. It doesn't create or claim any consent.",
      approval: "none",
      nextAction: "Add the evidence.",
      fingerprint: fingerprint(["evidence", need.key, need.purpose]),
    });
  }
  return out;
}
