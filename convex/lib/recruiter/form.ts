/**
 * The application form as an applicant answers it: the company's form (formDefinition.ts), then the
 * questions the Owner added for the role. It asks what is needed to assess an applicant and nothing kept
 * for onboarding: no tax identifier, no bank details, no identity documents.
 */
import type { Doc } from "../../_generated/dataModel";
import { userError } from "../errors";
import { isEmail } from "../text";
import { answerIs, answerKey, BUILTINS, OVER_18_WORDING, WEEKDAYS, WORK_AUTHORIZED_WORDING, type FieldKind, type FormDefinition, type Knockout } from "./formDefinition";
import { classicForm } from "./formTemplates";
import { normalizePhone, oneLine } from "./mail";
import type { Answer, Answers, Question } from "./schema";

export { WEEKDAYS };
export type { FieldKind };

/** The text permission an applicant gives, in the company's name, saying what carriers require of any opt-in. */
export function smsConsentWording(company: string): string {
  return `Text me about my application from ${company} at this number. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. This is optional.`;
}
/** The same wording where no company is in view (staff tools). An applicant always sees and agrees to their company's. */
export const SMS_CONSENT_WORDING = smsConsentWording("the company");
export const ATTEST_WORDING = "The information I have given is true and complete to the best of my knowledge.";

export type Field = {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  options?: string[];
  help?: string;
  placeholder?: string;
  /** The section's id. "role" is the role's own questions. */
  section: string;
  link?: { label: string; url: string };
  /** Shown only when the answer under `key` is `equals`. */
  showIf?: { key: string; equals: string };
  knockout?: Knockout;
};
export type Section = { id: string; title: string; description: string };

/** The fields a criterion may read. Anything else is refused when the role is saved. */
export const SCREENABLE = ["experienceYears", "availableDays", "hoursPerWeek", "serviceAreas"] as const;

export function questionField(question: Question): Field {
  return { key: `q.${question.key}`, label: question.label, kind: question.kind === "yes_no" ? "yes_no" : question.kind === "number" ? "number" : question.kind === "choice" ? "choice" : "long_text", required: question.required, options: question.options, section: "role" };
}

type NeedPart = Pick<Doc<"hiringNeeds">, "coverageAreas" | "questions"> & { title?: string };

/** The form's fields, in order, for one role. A standard field the role can't use (areas, for a role with none) is left out. */
export function fieldsFor(definition: FormDefinition, need: NeedPart, company?: string): Field[] {
  const keys = new Map<string, string>();
  const out: Field[] = [];
  for (const section of definition.sections) {
    for (const field of section.fields) {
      const key = answerKey(field);
      keys.set(field.id, key);
      if (field.id === "serviceAreas" && need.coverageAreas.length === 0) continue;
      const options = field.id === "availableDays" ? [...WEEKDAYS] : field.id === "serviceAreas" ? need.coverageAreas : field.options.length ? field.options : undefined;
      const label = field.id === "smsConsent" ? (company ? smsConsentWording(company) : SMS_CONSENT_WORDING) : field.id === "workAuthorized" ? WORK_AUTHORIZED_WORDING : field.id === "over18" ? OVER_18_WORDING : field.label;
      const parent = field.showIf ? keys.get(field.showIf.fieldId) : undefined;
      out.push({
        key,
        label,
        kind: field.kind,
        required: field.required,
        ...(options ? { options } : {}),
        ...(field.help ? { help: field.help } : {}),
        ...(field.placeholder ? { placeholder: field.placeholder } : {}),
        section: section.id,
        ...(field.link ? { link: field.link } : {}),
        ...(field.showIf && parent ? { showIf: { key: parent, equals: field.showIf.equals } } : {}),
        ...(field.knockout ? { knockout: field.knockout } : {}),
      });
    }
  }
  return [...out, ...need.questions.map(questionField)];
}

export function sectionsFor(definition: FormDefinition, need: NeedPart): Section[] {
  const sections = definition.sections.map((section) => ({ id: section.id, title: section.title, description: section.description }));
  return need.questions.length ? [...sections, { id: "role", title: need.title ? `About the ${need.title} role` : "About this role", description: "" }] : sections;
}

/** The form every role used before companies built their own. Still the form of a role whose company has none. */
export function formFields(need: NeedPart, company?: string): Field[] {
  return fieldsFor(classicForm(), need, company);
}

/** The fields an applicant sees with these answers: a field whose condition doesn't hold is not asked. */
export function visibleFields(fields: Field[], answers: Answers): Field[] {
  const shown = new Set<string>();
  return fields.filter((field) => {
    if (field.showIf && (!shown.has(field.showIf.key) || !answerIs(answers[field.showIf.key], field.showIf.equals))) return false;
    shown.add(field.key);
    return true;
  });
}

const BUILTIN_LIMIT = 160;

function clean(field: Field, value: Answer): Answer | undefined {
  switch (field.kind) {
    case "yes_no":
    case "consent":
      return typeof value === "boolean" ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000 ? value : undefined;
    case "multi":
      return Array.isArray(value) ? [...new Set(value.filter((entry) => field.options?.includes(entry)))] : undefined;
    case "choice":
      return typeof value === "string" && field.options?.includes(value) ? value : undefined;
    case "email": {
      const email = typeof value === "string" ? value.trim().toLowerCase() : "";
      return isEmail(email) ? email : undefined;
    }
    case "phone": {
      const phone = typeof value === "string" ? normalizePhone(value) : null;
      return phone ?? undefined;
    }
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
    case "address": {
      if (!Array.isArray(value)) return undefined;
      const parts = [0, 1, 2, 3].map((index) => oneLine(String(value[index] ?? ""), index === 0 ? 200 : 80));
      return parts.some(Boolean) ? parts : undefined;
    }
    // Files are recorded by upload (applicantAttachments), never written as an answer.
    case "file":
    case "statement":
      return undefined;
    default: {
      if (typeof value !== "string") return undefined;
      const text = field.kind === "long_text" ? value.replace(/\r/g, "").trim().slice(0, 2000) : oneLine(value, BUILTINS[field.key] ? BUILTIN_LIMIT : 300);
      return text || undefined;
    }
  }
}

/** Keeps only answers to this form's own questions, each in its proper shape. Anything else is dropped. */
export function cleanAnswers(fields: Field[], answers: Answers): Answers {
  const out: Answers = {};
  for (const field of fields) {
    const value = answers[field.key];
    if (value === undefined) continue;
    const cleaned = clean(field, value);
    if (cleaned !== undefined) out[field.key] = cleaned;
  }
  return out;
}

/** The answers to the questions the applicant was actually shown. What they answered and then hid by changing an earlier answer is dropped. */
export function shownAnswers(fields: Field[], answers: Answers): Answers {
  const out: Answers = {};
  for (const field of visibleFields(fields, answers)) if (answers[field.key] !== undefined) out[field.key] = answers[field.key];
  return out;
}

function unanswered(field: Field, value: Answer | undefined): boolean {
  if (field.kind === "consent") return value !== true;
  if (field.kind === "address") return !Array.isArray(value) || value.some((part, index) => index < 4 && !part);
  return value === undefined || (Array.isArray(value) && value.length === 0) || value === "";
}

/** The questions still unanswered that must be answered before submitting. Only questions the applicant is shown count. */
export function missingRequired(fields: Field[], answers: Answers): Field[] {
  return visibleFields(fields, answers).filter((field) => field.required && field.kind !== "statement" && unanswered(field, answers[field.key]));
}

export function assertSubmittable(fields: Field[], answers: Answers): void {
  const missing = missingRequired(fields, answers);
  if (missing.length > 0) throw userError(`Please answer: ${missing.map((field) => field.label).join("; ")}.`);
  if (answers.smsConsent === true && !answers.phone) throw userError("Add a phone number, or untick the permission to text.");
}

/** How much of the required part is done, as counts. Not a percentage of anything else. */
export function completion(fields: Field[], answers: Answers): { answered: number; required: number } {
  const required = visibleFields(fields, answers).filter((field) => field.required && field.kind !== "statement");
  return { answered: required.length - missingRequired(fields, answers).length, required: required.length };
}

/** The files recorded on an application, as answers to its file questions. Files from before file questions existed answer "resume". */
export function withFiles(fields: Field[], answers: Answers, files: { field?: string; kind: "resume" | "supporting"; fileName: string }[]): Answers {
  const out = { ...answers };
  for (const field of fields) {
    if (field.kind !== "file") continue;
    const names = files.filter((file) => (file.field ?? (file.kind === "resume" ? "resume" : undefined)) === field.key).map((file) => file.fileName);
    if (names.length) out[field.key] = names;
    else delete out[field.key];
  }
  return out;
}

export function answerWords(value: Answer | undefined, kind?: FieldKind): string {
  if (value === undefined) return "not answered";
  if (typeof value === "boolean") return kind === "consent" ? (value ? "Agreed" : "Did not agree") : value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length > 0 ? (kind === "address" ? value.filter(Boolean).join(", ") : value.join(", ")) : "none";
  return String(value);
}
