/**
 * Starting forms. A company begins from one of these and changes anything it likes. The standard
 * cleaner application follows the order of the reference company's application (contact, address,
 * getting to jobs, eligibility, experience, availability, how the work is done, supplies, then their own
 * words), without the identity document it asks for up front: that belongs to onboarding.
 */
import { BUILTINS, FORM_VERSION, type FieldKind, type FormDefinition, type FormField, type Knockout } from "./formDefinition";

function builtin(id: keyof typeof BUILTINS & string, extra: Partial<Pick<FormField, "required" | "help" | "label" | "knockout" | "placeholder">> = {}): FormField {
  const base = BUILTINS[id];
  return { id, builtin: true, kind: base.kind, label: extra.label ?? base.label, help: extra.help ?? base.help ?? "", placeholder: extra.placeholder ?? "", required: extra.required ?? false, options: base.kind === "file" ? ["resume"] : [], ...(extra.knockout ? { knockout: extra.knockout } : {}) };
}

function own(id: string, kind: FieldKind, label: string, extra: Partial<Pick<FormField, "required" | "help" | "options" | "knockout" | "showIf" | "link" | "placeholder">> = {}): FormField {
  return { id, builtin: false, kind, label, help: extra.help ?? "", placeholder: extra.placeholder ?? "", required: extra.required ?? false, options: extra.options ?? [], ...(extra.link ? { link: extra.link } : {}), ...(extra.showIf ? { showIf: extra.showIf } : {}), ...(extra.knockout ? { knockout: extra.knockout } : {}) };
}

const gate = (value: string, message: string): Knockout => ({ test: { kind: "equals", value }, message, outcome: "gate" });
const flag = (value: string): Knockout => ({ test: { kind: "equals", value }, message: "", outcome: "flag" });

const COPY = {
  title: "Apply for {role} at {company}",
  intro: "It takes about five minutes. Your answers are saved as you go, so you can leave and come back to finish.",
  submitLabel: "Submit application",
  thankYouTitle: "Your application is in",
  thankYouBody: "Thank you for applying. We read every application and will email you about the next step.",
};

const THEME = { useCompanyBrand: true, accentColor: "#6838ef", showLogo: true };

/** The form every role used before companies built their own. A role whose company has no form still uses it. */
export function classicForm(): FormDefinition {
  return {
    version: FORM_VERSION,
    display: "sections",
    theme: { ...THEME },
    copy: { ...COPY, intro: "" },
    invitation: { subject: "", body: "" },
    sections: [
      { id: "you", title: "About you", description: "", fields: [builtin("fullName", { required: true }), builtin("email", { required: true }), builtin("phone"), builtin("smsConsent"), builtin("city")] },
      { id: "experience", title: "Experience", description: "", fields: [builtin("experienceYears", { required: true }), builtin("experienceSummary")] },
      { id: "availability", title: "Availability", description: "", fields: [builtin("availableDays", { required: true }), builtin("hoursPerWeek", { required: true }), builtin("earliestStart"), builtin("serviceAreas", { required: true })] },
    ],
  };
}

const SUPPLIES = ["Vacuum", "Mop and bucket", "Microfiber cloths", "All-purpose cleaner", "Glass cleaner", "Bathroom cleaner", "Scrub brushes", "Gloves"];

/** The full cleaner application, in the reference company's order. */
export function standardCleanerForm(): FormDefinition {
  return {
    version: FORM_VERSION,
    display: "one_at_a_time",
    theme: { ...THEME },
    copy: { ...COPY },
    invitation: { subject: "", body: "" },
    sections: [
      {
        id: "you",
        title: "About you",
        description: "How we reach you about your application.",
        fields: [builtin("fullName", { required: true }), builtin("email", { required: true }), builtin("phone", { required: true }), builtin("smsConsent"), builtin("address", { required: true, help: "We use it to offer you jobs near you." })],
      },
      {
        id: "getting_there",
        title: "Getting to jobs",
        description: "Jobs are at clients' homes across the area.",
        fields: [
          own("own_car", "yes_no", "Do you have a car you can use to get to jobs?", { required: true, knockout: gate("No", "Our jobs are spread across the area, so this role needs a car. If that changes, we'd be glad to hear from you again.") }),
          own("license", "yes_no", "Do you have a valid driver's license?", { required: true, showIf: { fieldId: "own_car", equals: "Yes" }, knockout: gate("No", "Driving to jobs needs a valid driver's license.") }),
          own("auto_insurance", "yes_no", "Is the car insured?", { required: true, showIf: { fieldId: "own_car", equals: "Yes" }, knockout: gate("No", "Driving to jobs needs an insured car.") }),
          own("work_as", "choice", "Are you applying on your own or as a company?", { required: true, options: ["Just me", "A company with its own team"] }),
        ],
      },
      {
        id: "eligibility",
        title: "Eligibility",
        description: "",
        fields: [builtin("over18", { required: true, knockout: gate("No", "You need to be 18 or older to work with us.") }), builtin("workAuthorized", { required: true, knockout: flag("No") })],
      },
      {
        id: "experience",
        title: "Experience",
        description: "",
        fields: [builtin("experienceYears", { required: true, help: "Count paid work only: for a company, for clients of your own, or at a hotel or office." }), builtin("experienceSummary")],
      },
      {
        id: "availability",
        title: "Availability",
        description: "",
        fields: [
          own("availability", "choice", "What kind of schedule are you looking for?", { required: true, options: ["Full-time", "Part-time, whenever needed", "Weekdays only", "Weekends only"] }),
          builtin("availableDays", { required: true }),
          builtin("hoursPerWeek", { required: true }),
          builtin("earliestStart"),
          builtin("serviceAreas", { required: true }),
        ],
      },
      {
        id: "how_we_work",
        title: "How the work is done",
        description: "Please read each one. You can ask us about any of them before you agree.",
        fields: [
          own("contractor_terms", "consent", "I understand this is an independent contractor role: I choose the jobs I accept, and I am paid per job, not as an employee.", { required: true, knockout: gate("No", "This role is for independent contractors only. If you're looking for employment, we may have other openings later.") }),
          own("background_check", "consent", "I am willing to have a background check before my first job. You will ask for my written permission separately, as the law requires.", { required: true, knockout: gate("No", "Every member of our team has a background check before their first job.") }),
          own("pay_terms", "consent", "I understand that pay for each job is set out in the offer and paid after the job is completed and checked.", { required: true }),
        ],
      },
      {
        id: "supplies",
        title: "Supplies",
        description: "",
        fields: [
          own("supplies_willing", "yes_no", "Are you willing to bring your own cleaning supplies and equipment to jobs?", { required: true, knockout: gate("No", "Our team members bring their own supplies to every job.") }),
          own("supplies_have", "multi", "Which of these do you already have?", { options: SUPPLIES, help: "None yet is fine. We share a checklist before your first job.", showIf: { fieldId: "supplies_willing", equals: "Yes" } }),
        ],
      },
      {
        id: "in_your_words",
        title: "In your own words",
        description: "",
        fields: [
          own("reliability", "long_text", "How do you make sure you arrive on time and finish every job?", { required: true }),
          own("why_us", "long_text", "Why do you want to work with us?", { required: true }),
          builtin("resume", { help: "Optional. PDF, Word, plain text, JPG or PNG, up to 10 MB." }),
        ],
      },
    ],
  };
}

/** A short form for roles where a conversation comes first. */
export function quickApplyForm(): FormDefinition {
  return {
    version: FORM_VERSION,
    display: "sections",
    theme: { ...THEME },
    copy: { ...COPY, intro: "A few quick questions. It takes about two minutes." },
    invitation: { subject: "", body: "" },
    sections: [
      { id: "you", title: "About you", description: "", fields: [builtin("fullName", { required: true }), builtin("email", { required: true }), builtin("phone"), builtin("smsConsent"), builtin("city")] },
      { id: "work", title: "Your experience and availability", description: "", fields: [builtin("experienceYears", { required: true }), builtin("availableDays", { required: true }), builtin("hoursPerWeek", { required: true }), builtin("serviceAreas", { required: true }), builtin("resume")] },
    ],
  };
}

export const FORM_TEMPLATES = [
  { key: "standard_cleaner", name: "Cleaner application", blurb: "The full application: contact, getting to jobs, eligibility, experience, availability, how the work is done, supplies and their own words.", make: standardCleanerForm },
  { key: "quick_apply", name: "Quick apply", blurb: "Contact, experience, availability and an optional resume.", make: quickApplyForm },
  { key: "classic", name: "Short form", blurb: "Recruiter's original form: contact, experience and availability, on one page.", make: classicForm },
] as const;
export type FormTemplateKey = (typeof FORM_TEMPLATES)[number]["key"];
export const formTemplateKeys = FORM_TEMPLATES.map((template) => template.key) as unknown as readonly [FormTemplateKey, FormTemplateKey, ...FormTemplateKey[]];
