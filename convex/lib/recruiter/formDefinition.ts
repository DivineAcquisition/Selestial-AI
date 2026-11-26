/**
 * An application form, defined once by the company (docs/recruiter/09-application-builder.md).
 *
 * A definition is presentation and questions only. It decides what an applicant is asked and in what
 * order, how the page looks and what the invitation says. It cannot decide anything about a person:
 * screening reads the answers, and only a person moves an applicant forward or turns them down.
 *
 * Standard fields have names Recruiter knows (`fullName`, `experienceYears`, ...) and are answered under
 * that name, so screening, prefill and the applicant record keep working whatever the form looks like.
 * A company's own questions are answered under `f.<id>`. The role's own questions (hiringNeeds.questions)
 * are added after the form, under `q.<key>`, as they always were.
 *
 * What the application never asks, whatever the company writes: identity documents, tax identifiers or
 * bank details. Those belong to onboarding. Questions also pass the fairness guard (fairness.ts); the two
 * eligibility questions it would refuse are offered only as standard fields with fixed wording.
 */
import { v } from "convex/values";

import { userError } from "../errors";
import { literals } from "../statuses";
import { protectedWording } from "./fairness";

/** Bumped when the shape changes. A stored definition with a lower number is upgraded by `upgradeForm`. */
export const FORM_VERSION = 1;

// ── Lists ────────────────────────────────────────────────────────────────────────────────────────

export const FIELD_KINDS = ["text", "long_text", "email", "phone", "number", "yes_no", "choice", "multi", "date", "address", "file", "consent", "statement"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export const fieldKindValidator = literals(FIELD_KINDS);

export const FIELD_KIND_LABELS: Record<FieldKind, string> = {
  text: "Short answer",
  long_text: "Paragraph",
  email: "Email",
  phone: "Phone",
  number: "Number",
  yes_no: "Yes or no",
  choice: "One choice",
  multi: "Several choices",
  date: "Date",
  address: "Home address",
  file: "File upload",
  consent: "Agreement checkbox",
  statement: "Text only (no answer)",
};

/** Kinds a company can add as its own question. Email, phone and address are standard fields only. */
export const CUSTOM_KINDS: readonly FieldKind[] = ["text", "long_text", "number", "yes_no", "choice", "multi", "date", "file", "consent", "statement"];

export const DISPLAYS = ["one_at_a_time", "sections"] as const;
export type Display = (typeof DISPLAYS)[number];
export const DISPLAY_LABELS: Record<Display, { label: string; blurb: string }> = {
  one_at_a_time: { label: "One question at a time", blurb: "A full-screen question with a progress bar, like a conversation. Best on phones." },
  sections: { label: "One page with sections", blurb: "Every question on one page, grouped under headings." },
};

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const ADDRESS_PARTS = ["Street address", "City", "State", "ZIP code"] as const;

/** The two eligibility questions, in the only wording the builder allows. */
export const WORK_AUTHORIZED_WORDING = "Are you legally authorized to work in the United States?";
export const OVER_18_WORDING = "Are you 18 or older?";

type Builtin = {
  kind: FieldKind;
  label: string;
  help?: string;
  /** required: always required. wording: the label and choices cannot change. */
  locked?: readonly ("required" | "wording")[];
  options?: readonly string[];
  /** What the builder calls it in its list of standard fields. */
  name: string;
};

/**
 * The standard fields. Each is answered under its own name. Screening criteria read `experienceYears`,
 * `availableDays`, `hoursPerWeek` and `serviceAreas` (form.ts SCREENABLE).
 */
export const BUILTINS: Record<string, Builtin> = {
  fullName: { name: "Full name", kind: "text", label: "Full name", locked: ["required"] },
  email: { name: "Email", kind: "email", label: "Email address", locked: ["required"] },
  phone: { name: "Phone", kind: "phone", label: "Phone number" },
  smsConsent: { name: "Permission to text", kind: "consent", label: "Permission to text", locked: ["wording"], help: "The wording is set by what phone carriers require, with your company's name." },
  city: { name: "City or area", kind: "text", label: "City or area you live in", help: "A general area is enough. We do not need your street address." },
  address: { name: "Home address", kind: "address", label: "Where do you live?" },
  experienceYears: { name: "Years of experience", kind: "number", label: "Years of paid cleaning experience" },
  experienceSummary: { name: "Experience in their words", kind: "long_text", label: "Tell us about your relevant experience" },
  availableDays: { name: "Days available", kind: "multi", label: "Days you can usually work", options: WEEKDAYS, locked: ["wording"] },
  hoursPerWeek: { name: "Hours per week", kind: "number", label: "Hours you want to work in a week" },
  earliestStart: { name: "Earliest start", kind: "text", label: "When could you start?" },
  serviceAreas: { name: "Areas they can work in", kind: "multi", label: "Areas you can work in", help: "The choices are the role's coverage areas. Shown only for a role that has them.", locked: ["wording"] },
  workAuthorized: { name: "Work authorization", kind: "yes_no", label: WORK_AUTHORIZED_WORDING, locked: ["wording"], help: "Fixed wording. Have your counsel confirm how and when you ask this in your state." },
  over18: { name: "18 or older", kind: "yes_no", label: OVER_18_WORDING, locked: ["wording"], help: "Fixed wording. Have your counsel confirm how and when you ask this in your state." },
  resume: { name: "Resume", kind: "file", label: "Resume", help: "PDF, Word, plain text, JPG or PNG, up to 10 MB." },
};
export const BUILTIN_KEYS = Object.keys(BUILTINS);

/** Wording an application never asks for, in a label, help text or choice. Onboarding collects these, privately. */
const SENSITIVE: { pattern: RegExp; about: string }[] = [
  { pattern: /\b(driver'?s? licen[cs]e (number|no\.?|#)|licen[cs]e number|passport|photo ?id|government[- ]issued id|state id|identity (card|document)|id (card|document|photo|upload)|upload (your|a) (photo|picture) id)\b/i, about: "an identity document" },
  { pattern: /\b(ssn|social security|tax ?id|tin\b|itin|ein\b|taxpayer identification|w-?9|w-?4)\b/i, about: "a tax identifier" },
  { pattern: /\b(bank account|routing number|account number|iban|swift|direct deposit|card number|credit card|debit card)\b/i, about: "bank or card details" },
];

export function sensitiveWording(value: string): string | null {
  return SENSITIVE.find((entry) => entry.pattern.test(value))?.about ?? null;
}

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────

/**
 * An answer that ends the applicant's chances under a published requirement. gate: the applicant is told
 * at once, with the company's message, and can change the answer or send the application as it is.
 * flag: nothing is said to the applicant; screening lists it for a person. Either way, a decline without
 * a person happens only when the Owner allowed it for fixed requirements (decisions.ts).
 */
export const knockoutValidator = v.object({
  test: v.union(v.object({ kind: v.literal("equals"), value: v.string() }), v.object({ kind: v.literal("below"), value: v.number() })),
  message: v.string(),
  outcome: v.union(v.literal("gate"), v.literal("flag")),
});
export type Knockout = typeof knockoutValidator.type;

export const formFieldValidator = v.object({
  /** A standard field's name, or the company's own short id. */
  id: v.string(),
  builtin: v.boolean(),
  kind: fieldKindValidator,
  label: v.string(),
  help: v.string(),
  placeholder: v.string(),
  required: v.boolean(),
  /** For choice and multi. For file: "resume" or "supporting". */
  options: v.array(v.string()),
  /** A policy the applicant can read, for an agreement checkbox or text. */
  link: v.optional(v.object({ label: v.string(), url: v.string() })),
  /** Shown only when an earlier field's answer is this. Yes-or-no answers are "Yes" and "No". */
  showIf: v.optional(v.object({ fieldId: v.string(), equals: v.string() })),
  knockout: v.optional(knockoutValidator),
});
export type FormField = typeof formFieldValidator.type;

export const formSectionValidator = v.object({
  id: v.string(),
  title: v.string(),
  description: v.string(),
  fields: v.array(formFieldValidator),
});
export type FormSection = typeof formSectionValidator.type;

export const formDefinitionValidator = v.object({
  version: v.number(),
  display: literals(DISPLAYS),
  theme: v.object({
    /** Use the brand color and logo from the company's public profile (Booking rules). */
    useCompanyBrand: v.boolean(),
    accentColor: v.string(),
    showLogo: v.boolean(),
  }),
  /** "{role}" and "{company}" are filled in. */
  copy: v.object({
    title: v.string(),
    intro: v.string(),
    submitLabel: v.string(),
    thankYouTitle: v.string(),
    thankYouBody: v.string(),
  }),
  /** The email that carries the application link. Empty: Recruiter's standard wording. "{link}" is required in a body. */
  invitation: v.object({ subject: v.string(), body: v.string() }),
  sections: v.array(formSectionValidator),
});
export type FormDefinition = typeof formDefinitionValidator.type;

// ── Checking ─────────────────────────────────────────────────────────────────────────────────────

export const FORM_LIMITS = {
  sections: 12,
  fields: 60,
  label: 300,
  help: 600,
  placeholder: 120,
  options: 20,
  option: 80,
  title: 120,
  intro: 1200,
  button: 40,
  subject: 160,
  body: 3000,
  knockoutMessage: 600,
  linkLabel: 80,
  url: 400,
} as const;

const ID = /^[a-z][a-z0-9_]{0,39}$/;
const HEX = /^#[0-9a-f]{6}$/;

function plain(value: string, label: string, max: number, allowEmpty = true): string {
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!allowEmpty && !cleaned) throw userError(`${label} can't be empty.`);
  if (cleaned.length > max) throw userError(`${label} can be at most ${max} characters.`);
  if (/<\s*\/?\s*[a-z!]/i.test(cleaned)) throw userError(`${label} must be plain text, without HTML.`);
  return cleaned;
}

function guard(value: string, what: string, fairness: boolean) {
  const sensitive = sensitiveWording(value);
  if (sensitive) throw userError(`${what} asks for ${sensitive}. An application never collects that; onboarding does, privately.`);
  if (!fairness) return;
  const about = protectedWording(value);
  if (about) throw userError(`${what} appears to be about ${about}. Recruiter does not ask about or screen on that. If you believe this is a lawful, job-related requirement, have it reviewed by counsel first.`);
}

function url(value: string): string {
  const trimmed = plain(value, "A policy link", FORM_LIMITS.url, false);
  if (!/^https:\/\/[^\s]+$/i.test(trimmed)) throw userError("A policy link must start with https://.");
  return trimmed;
}

/** The answer key a field is stored under. */
export function answerKey(field: Pick<FormField, "id" | "builtin">): string {
  return field.builtin ? field.id : `f.${field.id}`;
}

function field(input: FormField, earlier: Map<string, FormField>): FormField {
  const builtin = input.builtin ? BUILTINS[input.id] : undefined;
  if (input.builtin && !builtin) throw userError(`"${input.id}" is not a standard field.`);
  if (!input.builtin && !ID.test(input.id)) throw userError("Each question needs its own short id of lower-case letters, digits and underscores.");
  if (!input.builtin && BUILTINS[input.id]) throw userError(`"${input.id}" is the name of a standard field. Choose another id.`);
  const kind: FieldKind = builtin ? builtin.kind : input.kind;
  if (!builtin && !CUSTOM_KINDS.includes(kind)) throw userError(`A question of your own can't be a ${FIELD_KIND_LABELS[kind].toLowerCase()} field. Use the standard one.`);
  const lockedWording = builtin?.locked?.includes("wording") ?? false;
  const label = lockedWording ? builtin!.label : plain(input.label, "A question", FORM_LIMITS.label, false);
  const what = `The question "${label.slice(0, 60)}"`;
  // An agreement's wording and a block of text are statements to the applicant, not questions about them.
  const fairness = !lockedWording && kind !== "consent" && kind !== "statement";
  guard(label, what, fairness);
  const help = plain(input.help, "A question's help text", FORM_LIMITS.help);
  guard(help, `The help text of "${label.slice(0, 60)}"`, fairness);
  const placeholder = plain(input.placeholder, "A placeholder", FORM_LIMITS.placeholder);

  let options: string[] = [];
  if (kind === "choice" || kind === "multi") {
    if (lockedWording) options = [];
    else {
      options = input.options.map((option) => plain(option, "An answer choice", FORM_LIMITS.option, false));
      if (options.length < 2) throw userError(`"${label}" needs at least two choices.`);
      if (options.length > FORM_LIMITS.options) throw userError(`"${label}" can offer at most ${FORM_LIMITS.options} choices.`);
      if (new Set(options).size !== options.length) throw userError(`"${label}" lists the same choice twice.`);
      for (const option of options) guard(option, `The choice "${option}"`, true);
    }
  } else if (kind === "file") {
    options = builtin ? ["resume"] : [input.options[0] === "resume" ? "resume" : "supporting"];
  }

  const required = builtin?.locked?.includes("required") ? true : kind === "statement" || input.id === "smsConsent" ? false : input.required;
  const out: FormField = { id: input.id, builtin: input.builtin, kind, label, help, placeholder, required, options };
  if (input.link && (kind === "consent" || kind === "statement")) out.link = { label: plain(input.link.label, "A policy link's words", FORM_LIMITS.linkLabel, false), url: url(input.link.url) };
  if (input.showIf) {
    const parent = earlier.get(input.showIf.fieldId);
    if (!parent) throw userError(`"${label}" depends on a question that isn't asked before it.`);
    out.showIf = { fieldId: parent.id, equals: plain(input.showIf.equals, "A condition's answer", FORM_LIMITS.option, false) };
  }
  if (input.knockout) {
    if (kind === "statement" || kind === "file" || kind === "address" || kind === "email" || kind === "phone") throw userError(`"${label}" can't end an application by its answer.`);
    const test = input.knockout.test;
    if (test.kind === "below" && kind !== "number") throw userError(`"${label}" can only use "less than" when it asks for a number.`);
    if (test.kind === "below" && (!Number.isFinite(test.value) || test.value < 0 || test.value > 10_000)) throw userError(`"${label}" needs a minimum from 0 to 10,000.`);
    if (test.kind === "equals") {
      const allowed = kind === "yes_no" || kind === "consent" ? ["Yes", "No"] : kind === "choice" || kind === "multi" ? options.length ? options : [...(builtin?.options ?? [])] : null;
      if (allowed && !allowed.includes(test.value)) throw userError(`"${label}" can only end an application on one of its own answers.`);
    }
    out.knockout = {
      test: test.kind === "equals" ? { kind: "equals", value: plain(test.value, "The answer that ends an application", FORM_LIMITS.option, false) } : { kind: "below", value: test.value },
      message: plain(input.knockout.message, "The message for that answer", FORM_LIMITS.knockoutMessage),
      outcome: input.knockout.outcome,
    };
  }
  return out;
}

/** Checks and tidies a whole definition. Throws a person-readable error for the first problem. */
export function normalizeForm(input: FormDefinition): FormDefinition {
  if (input.version > FORM_VERSION) throw userError("This form was saved by a newer version of Selestial. Reload the page.");
  const def = upgradeForm(input);
  if (def.sections.length === 0) throw userError("A form needs at least one section.");
  if (def.sections.length > FORM_LIMITS.sections) throw userError(`A form can have at most ${FORM_LIMITS.sections} sections.`);
  const sectionIds = new Set<string>();
  const earlier = new Map<string, FormField>();
  let count = 0;
  const sections = def.sections.map((section) => {
    if (!ID.test(section.id) || sectionIds.has(section.id)) throw userError("Each section needs its own short id.");
    sectionIds.add(section.id);
    const fields = section.fields.map((input) => {
      if (earlier.has(input.id)) throw userError(`Two questions share the id "${input.id}".`);
      const checked = field(input, earlier);
      earlier.set(checked.id, checked);
      count += 1;
      return checked;
    });
    const title = plain(section.title, "A section title", FORM_LIMITS.title, false);
    const description = plain(section.description, "A section's description", FORM_LIMITS.help);
    guard(`${title} ${description}`, `The section "${title}"`, false);
    return { id: section.id, title, description, fields };
  });
  if (count > FORM_LIMITS.fields) throw userError(`A form can ask at most ${FORM_LIMITS.fields} questions.`);
  for (const required of ["fullName", "email"]) if (!earlier.get(required)?.builtin) throw userError(`The form must ask for the applicant's ${required === "email" ? "email address" : "full name"}.`);
  if (earlier.get("smsConsent") && !earlier.get("phone")) throw userError("Permission to text needs the phone number field on the form too.");

  const subject = plain(def.invitation.subject, "The invitation subject", FORM_LIMITS.subject);
  const body = plain(def.invitation.body, "The invitation email", FORM_LIMITS.body);
  if (body && !body.includes("{link}")) throw userError("The invitation email must include {link}, where the application link goes.");
  if (!subject !== !body) throw userError("Write both the invitation subject and its text, or leave both empty for the standard wording.");
  const accent = def.theme.accentColor.trim().toLowerCase();
  if (!HEX.test(accent)) throw userError("The accent color must be a color like #6838ef.");
  return {
    version: FORM_VERSION,
    display: def.display,
    theme: { useCompanyBrand: def.theme.useCompanyBrand, accentColor: accent, showLogo: def.theme.showLogo },
    copy: {
      title: plain(def.copy.title, "The form's title", FORM_LIMITS.title, false),
      intro: plain(def.copy.intro, "The introduction", FORM_LIMITS.intro),
      submitLabel: plain(def.copy.submitLabel, "The submit button", FORM_LIMITS.button) || "Submit application",
      thankYouTitle: plain(def.copy.thankYouTitle, "The thank-you title", FORM_LIMITS.title) || "Application submitted",
      thankYouBody: plain(def.copy.thankYouBody, "The thank-you text", FORM_LIMITS.intro),
    },
    invitation: { subject, body },
    sections,
  };
}

/** Upgrades a stored definition to the current shape. Version 1 is current; later versions add defaults here. */
export function upgradeForm(stored: FormDefinition): FormDefinition {
  if (stored.version === FORM_VERSION) return stored;
  return { ...stored, version: FORM_VERSION };
}

/** Fills "{role}" and "{company}" in a form's own words. */
export function fill(template: string, values: { role: string; company: string }): string {
  return template.replace(/\{role\}/g, values.role).replace(/\{company\}/g, values.company);
}

// ── Answers: shared by the server and the applicant's page ───────────────────────────────────────

type Value = string | number | boolean | string[] | undefined;

/** True when an answer is the given value. Yes-or-no answers read "Yes" and "No"; several choices match on any. */
export function answerIs(value: Value, equals: string): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return (value ? "Yes" : "No") === equals;
  if (Array.isArray(value)) return value.includes(equals);
  return String(value) === equals;
}

/** True when this answer is the one the field's knockout names. Unanswered never is. */
export function knockedOut(knockout: Knockout | undefined, value: Value): boolean {
  if (!knockout || value === undefined) return false;
  if (knockout.test.kind === "below") return typeof value === "number" && value < knockout.test.value;
  // An agreement left unticked reads as "No".
  return answerIs(value, knockout.test.value);
}

export function knockoutWords(knockout: Knockout): string {
  return knockout.test.kind === "below" ? `less than ${knockout.test.value}` : `"${knockout.test.value}"`;
}
