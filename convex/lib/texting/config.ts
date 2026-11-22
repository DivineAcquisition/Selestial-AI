/**
 * The forms' versioned configuration (docs/texting/02-case.md §3). Staff change what is safe to change
 * without a release: labels, help and examples; supported conditional requirements; approved rule
 * parameters; which agent owns a task; recommendation and correction wording; tutorial placement; and step
 * prerequisites.
 *
 * Field order is not configurable: the steps group fields by what carriers require.
 *
 * Limits, by design:
 *  - Only the shapes and rule types below exist. Configuration is data checked against this schema; nothing
 *    in it is ever run as code, evaluated as an expression or used as a regular expression.
 *  - Rules only ADD requirements. The built-in checks (carrier requirements in checks.ts and drafts.ts) always
 *    run; configuration cannot switch one off, raise a length cap above the built-in one, or touch tenant
 *    access, billing or prices.
 *  - A new provider capability (a new Telnyx API, porting, toll-free) still needs an implemented adapter. The
 *    configuration can describe a provider requirement and its source; it cannot call anything.
 */
import { AGENTS, type Agent } from "../statuses";
import { PLACEMENTS, tutorialById } from "../tutorials/catalog";
import { EVIDENCE_PURPOSES, type EvidencePurpose } from "./caseSchema";
import { BUSINESS_FIELDS, ENTITY_TYPES, PERMISSION_PLACES, SETUP_STEPS, type Business, type SetupStep } from "./schema";

/** Fields whose presentation can be configured: business fields and the owner-edited drafts. */
const PRESENTABLE = [...BUSINESS_FIELDS, "sms_consent", "marketing_consent", "terms", "privacy", "help_reply", "stop_reply", "start_reply", "opt_in_flow"] as const;
/** The hard caps a configured max length may lower but never raise. */
const HARD_MAX: Partial<Record<string, number>> = { displayName: 100, legalName: 100, website: 100, supportEmail: 120, street: 120, city: 120 };
/** Patterns a field may be held to. Named presets only: an administrator never supplies a pattern. */
export const PATTERN_PRESETS = {
  no_po_box: { words: "can't be a P.O. box", test: (value: string) => !/\bp\.?\s*o\.?\s*box\b/i.test(value) },
  https_only: { words: "must start with https://", test: (value: string) => /^https:\/\//i.test(value) },
  no_free_email: { words: "should be on your own domain, not a free email service", test: (value: string) => !/@(gmail|yahoo|hotmail|outlook|aol|icloud)\./i.test(value) },
} as const;
type Preset = keyof typeof PATTERN_PRESETS;

export const TASKS = ["business", "activities", "permission", "number", "review", "evidence", "corrections"] as const;
type Task = (typeof TASKS)[number];

export type FieldConfig = { field: string; label?: string; help?: string; example?: string };
export type Rule =
  | { type: "required_when_entity"; field: string; entities: string[] }
  | { type: "max_length"; field: string; max: number }
  | { type: "pattern_preset"; field: string; preset: Preset }
  | { type: "evidence_required"; purpose: EvidencePurpose; place?: string; step: SetupStep };
export type Config = {
  fields: FieldConfig[];
  rules: Rule[];
  ownership: { task: Task; owner: "check" | Agent }[];
  templates: { key: string; words: string }[];
  tutorials: { placement: string; tutorialId: string }[];
  prerequisites: { step: SetupStep; requires: SetupStep[] }[];
  providerRequirements: { key: string; words: string; sourceUrl: string; verifiedOn: string }[];
};

/** Version 0: the built-in configuration, in force until staff publish one. */
export const BUILT_IN: Config = { fields: [], rules: [], ownership: [], templates: [], tutorials: [], prerequisites: [], providerRequirements: [] };

/** Template keys staff may reword, and the only placeholders each may use. */
export const TEMPLATE_KEYS: Record<string, readonly string[]> = {
  "correction.intro": ["business"],
  "recommendation.name_mismatch": ["a", "b"],
  "recommendation.marketing_consent": ["business"],
  "recommendation.review_copy": [],
  "recommendation.correction_field": ["field"],
  "recommendation.coverage_gap": ["missing"],
  "recommendation.evidence_required": ["purpose"],
};

const PLAIN = /^[^<>{}`]*(\{[a-z]+\}[^<>{}`]*)*$/;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[<>`]/.test(value);
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

/**
 * Parses and checks a configuration body. Answers the configuration and every problem; a body with any
 * problem cannot be validated or published. `needsReview` is true when it changes requirements (rules,
 * prerequisites, provider requirements, ownership), which a second staff member must review.
 */
export function parseConfig(body: string): { config: Config | null; problems: string[]; needsReview: boolean } {
  const problems: string[] = [];
  let raw: unknown;
  if (body.length > 50_000) return { config: null, problems: ["The configuration is larger than 50,000 characters."], needsReview: false };
  try {
    raw = JSON.parse(body);
  } catch {
    return { config: null, problems: ["The configuration isn't valid JSON."], needsReview: false };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config: null, problems: ["The configuration must be an object."], needsReview: false };
  const input = raw as Record<string, unknown>;
  const known = Object.keys(BUILT_IN);
  for (const key of Object.keys(input)) if (!known.includes(key)) problems.push(`"${key}" isn't a supported part of the configuration. Supported: ${known.join(", ")}.`);
  const list = (key: keyof Config): unknown[] => {
    const value = input[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      problems.push(`"${key}" must be a list.`);
      return [];
    }
    if (value.length > 200) problems.push(`"${key}" has more than 200 entries.`);
    return value.slice(0, 200);
  };
  const config: Config = { fields: [], rules: [], ownership: [], templates: [], tutorials: [], prerequisites: [], providerRequirements: [] };

  const seenFields = new Set<string>();
  for (const [i, row] of list("fields").entries()) {
    const r = row as Record<string, unknown>;
    if (!isOneOf(PRESENTABLE, r?.field)) {
      problems.push(`fields[${i}]: "${String(r?.field)}" isn't a configurable field.`);
      continue;
    }
    if (seenFields.has(r.field)) problems.push(`fields[${i}]: ${r.field} is configured twice.`);
    seenFields.add(r.field);
    const out: FieldConfig = { field: r.field };
    for (const key of ["label", "help", "example"] as const) {
      if (r[key] === undefined) continue;
      if (!text(r[key], key === "label" ? 80 : 400)) problems.push(`fields[${i}].${key} must be plain text up to ${key === "label" ? 80 : 400} characters.`);
      else out[key] = (r[key] as string).trim();
    }
    // Order is not configurable: fields are grouped by what carriers require, and a layout change is a release.
    for (const key of Object.keys(r)) if (!["field", "label", "help", "example"].includes(key)) problems.push(`fields[${i}]: "${key}" isn't supported.`);
    config.fields.push(out);
  }

  for (const [i, row] of list("rules").entries()) {
    const r = row as Record<string, unknown>;
    switch (r?.type) {
      case "required_when_entity":
        if (!isOneOf(BUSINESS_FIELDS, r.field)) problems.push(`rules[${i}]: "${String(r.field)}" isn't a business field.`);
        else if (!Array.isArray(r.entities) || !r.entities.length || !r.entities.every((e) => isOneOf(ENTITY_TYPES, e))) problems.push(`rules[${i}].entities must list kinds of business (${ENTITY_TYPES.join(", ")}).`);
        else config.rules.push({ type: r.type, field: r.field, entities: r.entities as string[] });
        break;
      case "max_length": {
        const cap = HARD_MAX[String(r.field)];
        if (!cap) problems.push(`rules[${i}]: a length limit can be set on ${Object.keys(HARD_MAX).join(", ")}.`);
        else if (!Number.isInteger(r.max) || (r.max as number) < 1 || (r.max as number) > cap) problems.push(`rules[${i}].max must be from 1 to ${cap}: configuration can tighten a limit, never loosen it.`);
        else config.rules.push({ type: r.type, field: String(r.field), max: r.max as number });
        break;
      }
      case "pattern_preset":
        if (!isOneOf(BUSINESS_FIELDS, r.field)) problems.push(`rules[${i}]: "${String(r.field)}" isn't a business field.`);
        else if (!isOneOf(Object.keys(PATTERN_PRESETS) as Preset[], r.preset)) problems.push(`rules[${i}].preset must be one of ${Object.keys(PATTERN_PRESETS).join(", ")}.`);
        else config.rules.push({ type: r.type, field: r.field, preset: r.preset });
        break;
      case "evidence_required":
        if (!isOneOf(EVIDENCE_PURPOSES, r.purpose)) problems.push(`rules[${i}].purpose must be one of ${EVIDENCE_PURPOSES.join(", ")}.`);
        else if (r.place !== undefined && !isOneOf(PERMISSION_PLACES, r.place)) problems.push(`rules[${i}].place must be one of ${PERMISSION_PLACES.join(", ")}.`);
        else if (!isOneOf(["permission", "review"] as const, r.step)) problems.push(`rules[${i}].step must be permission or review.`);
        else config.rules.push({ type: r.type, purpose: r.purpose, step: r.step, ...(r.place ? { place: r.place as string } : {}) });
        break;
      default:
        problems.push(`rules[${i}]: "${String(r?.type)}" isn't an approved rule type. Approved: required_when_entity, max_length, pattern_preset, evidence_required.`);
    }
  }

  for (const [i, row] of list("ownership").entries()) {
    const r = row as Record<string, unknown>;
    if (!isOneOf(TASKS, r?.task)) problems.push(`ownership[${i}].task must be one of ${TASKS.join(", ")}.`);
    else if (r.owner !== "check" && !isOneOf(AGENTS, r.owner)) problems.push(`ownership[${i}].owner must be "check" or an existing agent (${AGENTS.join(", ")}). New agents can't be made here.`);
    else config.ownership.push({ task: r.task, owner: r.owner as "check" | Agent });
  }

  for (const [i, row] of list("templates").entries()) {
    const r = row as Record<string, unknown>;
    const allowed = TEMPLATE_KEYS[String(r?.key)];
    if (!allowed) {
      problems.push(`templates[${i}]: "${String(r?.key)}" isn't a template that can be reworded.`);
      continue;
    }
    if (!text(r.words, 500) || !PLAIN.test(r.words as string)) {
      problems.push(`templates[${i}].words must be plain text up to 500 characters.`);
      continue;
    }
    const used = [...(r.words as string).matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]);
    const unknown = used.filter((name) => !allowed.includes(name));
    if (unknown.length) problems.push(`templates[${i}] uses {${unknown.join("}, {")}}; it may use ${allowed.length ? allowed.map((a) => `{${a}}`).join(", ") : "no placeholders"}.`);
    else config.templates.push({ key: String(r.key), words: (r.words as string).trim() });
  }

  for (const [i, row] of list("tutorials").entries()) {
    const r = row as Record<string, unknown>;
    if (!isOneOf(PLACEMENTS, r?.placement)) problems.push(`tutorials[${i}].placement isn't a placement.`);
    else if (!tutorialById(String(r.tutorialId))) problems.push(`tutorials[${i}]: "${String(r.tutorialId)}" isn't in the tutorial catalog.`);
    else config.tutorials.push({ placement: r.placement, tutorialId: String(r.tutorialId) });
  }

  for (const [i, row] of list("prerequisites").entries()) {
    const r = row as Record<string, unknown>;
    if (!isOneOf(SETUP_STEPS, r?.step) || r.step === "progress") problems.push(`prerequisites[${i}].step must be a setup step other than progress.`);
    else if (!Array.isArray(r.requires) || !r.requires.every((s) => isOneOf(SETUP_STEPS, s) && s !== "progress" && s !== "review")) problems.push(`prerequisites[${i}].requires must list setup steps before review.`);
    else config.prerequisites.push({ step: r.step, requires: r.requires as SetupStep[] });
  }
  if (cyclic(config.prerequisites)) problems.push("The prerequisites go round in a circle, so no step could ever be started.");

  for (const [i, row] of list("providerRequirements").entries()) {
    const r = row as Record<string, unknown>;
    const ok = text(r?.key, 60) && text(r.words, 500) && typeof r.sourceUrl === "string" && /^https:\/\/[^\s]+$/.test(r.sourceUrl) && typeof r.verifiedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.verifiedOn);
    if (!ok) problems.push(`providerRequirements[${i}] needs a key, words, an https sourceUrl and the date it was verified (YYYY-MM-DD).`);
    else config.providerRequirements.push({ key: String(r.key), words: String(r.words), sourceUrl: r.sourceUrl as string, verifiedOn: r.verifiedOn as string });
  }

  const needsReview = config.rules.length > 0 || config.prerequisites.length > 0 || config.providerRequirements.length > 0 || config.ownership.length > 0;
  return { config: problems.length ? null : config, problems, needsReview };
}

function cyclic(rows: Config["prerequisites"]): boolean {
  const edges = new Map<string, string[]>();
  for (const row of rows) edges.set(row.step, [...(edges.get(row.step) ?? []), ...row.requires]);
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (node: string): boolean => {
    if (done.has(node)) return false;
    if (visiting.has(node)) return true;
    visiting.add(node);
    for (const next of edges.get(node) ?? []) if (visit(next)) return true;
    visiting.delete(node);
    done.add(node);
    return false;
  };
  return [...edges.keys()].some(visit);
}

export type ConfigProblem = { step: SetupStep; field?: string; words: string };

/** The extra requirements a configuration adds to one setup. Built-in checks run separately and always. */
export function configProblems(config: Config, input: { business: Business; places: readonly string[]; evidence: readonly { purpose: string; place?: string; state: string }[] }): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const label = (field: string) => config.fields.find((row) => row.field === field)?.label ?? field;
  for (const rule of config.rules) {
    if (rule.type === "required_when_entity") {
      const value = input.business[rule.field as keyof Business];
      if (rule.entities.includes(input.business.entityType ?? "") && !value) out.push({ step: "business", field: rule.field, words: `Enter ${label(rule.field)}: it's required for this kind of business.` });
    } else if (rule.type === "max_length") {
      const value = input.business[rule.field as keyof Business] ?? "";
      if (value.length > rule.max) out.push({ step: "business", field: rule.field, words: `${label(rule.field)} can be up to ${rule.max} characters.` });
    } else if (rule.type === "pattern_preset") {
      const value = input.business[rule.field as keyof Business];
      if (value && !PATTERN_PRESETS[rule.preset].test(value)) out.push({ step: "business", field: rule.field, words: `${label(rule.field)} ${PATTERN_PRESETS[rule.preset].words}.` });
    } else if (rule.type === "evidence_required") {
      if (rule.place && !input.places.includes(rule.place)) continue;
      const has = input.evidence.some((row) => row.purpose === rule.purpose && (!rule.place || !row.place || row.place === rule.place) && row.state !== "missing" && row.state !== "needs_replacement");
      if (!has) out.push({ step: rule.step, field: rule.place, words: `Add evidence: ${rule.purpose.replace(/_/g, " ")}${rule.place ? ` for ${rule.place.replace(/_/g, " ")}` : ""}.` });
    }
  }
  return out;
}

/** A configured template with its placeholders filled, or the built-in words. */
export function templateWords(config: Config, key: string, fallback: string, values: Record<string, string> = {}): string {
  const words = config.templates.find((row) => row.key === key)?.words ?? fallback;
  return words.replace(/\{([a-z]+)\}/g, (_, name: string) => values[name] ?? "");
}

/** Who owns a task under this configuration. Default: Selestial's own checks. */
export function ownerOf(config: Config, task: Task): "check" | Agent {
  return config.ownership.find((row) => row.task === task)?.owner ?? "check";
}

/** Steps whose problems a new configuration adds for this setup, with the first new problem in each. */
export function reopenedSteps(before: ConfigProblem[], after: ConfigProblem[]): { step: SetupStep; words: string }[] {
  const old = new Set(before.map((row) => `${row.step}|${row.words}`));
  const fresh = after.filter((row) => !old.has(`${row.step}|${row.words}`));
  const steps = new Map<SetupStep, string>();
  for (const row of fresh) if (!steps.has(row.step)) steps.set(row.step, row.words);
  return [...steps.entries()].map(([step, words]) => ({ step, words }));
}
