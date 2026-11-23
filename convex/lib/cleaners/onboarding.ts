/**
 * The company's guided onboarding content: what a new cleaner reads, checks off, acknowledges and completes.
 * The requirement template (settings.ts) says which steps a worker has and what each holds up; this says what
 * each step shows. It is versioned: an Owner edits a draft, previews it as a cleaner sees it, and publishes.
 * Publishing never resets anyone by itself. For each changed part the Owner decides whether people who
 * already completed it must do it again; that decision is kept with the version (`reack`).
 *
 * Nothing here is another company's policy. The defaults are a neutral starting point written for
 * Selestial's own cleaner pages (offers, the job page, earnings), and every word is the Owner's to change.
 */
import { v } from "convex/values";

import type { Doc } from "../../_generated/dataModel";

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────

export const guideSectionValidator = v.object({
  title: v.string(),
  body: v.string(),
  /** An image the company provides. Its words are always in `body`, so the step reads without it. */
  imageUrl: v.optional(v.string()),
  imageAlt: v.optional(v.string()),
});

export const guideValidator = v.object({
  title: v.string(),
  intro: v.string(),
  sections: v.array(guideSectionValidator),
  /** The words of the box the cleaner ticks. Reading alone never completes a guide. */
  agreeLabel: v.string(),
  imageUrl: v.optional(v.string()),
  imageAlt: v.optional(v.string()),
});

export const SUPPLY_CATEGORIES = ["solutions", "tools", "safety", "specialty"] as const;
export type SupplyCategory = (typeof SUPPLY_CATEGORIES)[number];

export const supplyItemValidator = v.object({
  id: v.string(),
  label: v.string(),
  category: v.union(...SUPPLY_CATEGORIES.map((c) => v.literal(c))),
  /** Who brings it. A company-provided item is shown, never asked. */
  provider: v.union(v.literal("cleaner"), v.literal("company")),
  /** Services (lower case) it is for. Empty means every job; a specialty item lists its services. */
  forServices: v.array(v.string()),
  /** Needed on a visit it applies to. Optional items are asked, and never hold anything up. */
  required: v.boolean(),
});

/** Methods Finance › Team Pay can record a payment by. No automatic payout exists, so none is offered. */
export const PAY_METHODS = ["zelle", "venmo", "check", "cash", "bank_transfer", "payroll"] as const;
export type PayMethod = (typeof PAY_METHODS)[number];
export const payMethodValidator = v.union(...PAY_METHODS.map((m) => v.literal(m)));

export const trainingSectionValidator = v.object({
  title: v.string(),
  body: v.string(),
  /** A question answered before moving on. The answer is checked by the server. */
  check: v.optional(v.object({ question: v.string(), options: v.array(v.string()), answer: v.number() })),
});

export const trainingModuleValidator = v.object({
  key: v.string(),
  title: v.string(),
  summary: v.optional(v.string()),
  kind: v.union(v.literal("video"), v.literal("guide")),
  required: v.boolean(),
  minutes: v.optional(v.number()),
  /** A direct video file (mp4 or webm), so the page can tell it was watched to the end. */
  videoUrl: v.optional(v.string()),
  sections: v.optional(v.array(trainingSectionValidator)),
});

export const onboardingContentValidator = v.object({
  welcome: v.optional(v.string()),
  support: v.object({ phone: v.optional(v.string()), email: v.optional(v.string()), hours: v.optional(v.string()) }),
  /** The agreement document type each relationship signs. Absent: any working agreement counts. */
  agreementTypes: v.object({ employee: v.optional(v.string()), contractor: v.optional(v.string()) }),
  supplies: v.object({
    items: v.array(supplyItemValidator),
    /** advisory: Dispatch shows a gap. required_for_visit: a visit is not offered to someone missing a required item for it. */
    rule: v.union(v.literal("advisory"), v.literal("required_for_visit")),
  }),
  jobGuide: guideValidator,
  expectations: guideValidator,
  payment: v.object({ methods: v.array(payMethodValidator), schedule: v.string(), instructions: v.optional(v.string()) }),
  training: v.object({ modules: v.array(trainingModuleValidator) }),
});

export type GuideSection = typeof guideSectionValidator.type;
export type Guide = typeof guideValidator.type;
export type SupplyItem = typeof supplyItemValidator.type;
export type TrainingModule = typeof trainingModuleValidator.type;
export type OnboardingContent = typeof onboardingContentValidator.type;

/** Which requirement a guide belongs to. A company's own acknowledgment keeps its description as its words. */
export const GUIDE_FOR_KEY: Record<string, "jobGuide" | "expectations"> = { job_day: "jobGuide", policies: "expectations" };

export const PAY_METHOD_WORDS: Record<PayMethod, { label: string; detail: string }> = {
  zelle: { label: "Zelle", detail: "Paid to the email or mobile number registered with your Zelle." },
  venmo: { label: "Venmo", detail: "Paid to your Venmo username." },
  check: { label: "Check", detail: "A paper check, mailed or handed to you." },
  cash: { label: "Cash", detail: "Paid in cash, with a record of each payment." },
  bank_transfer: { label: "Direct deposit", detail: "Into your bank account. The office sends a secure form for your account details; they are never typed here." },
  payroll: { label: "Payroll", detail: "Through the company's payroll. The office sets it up with you." },
};

// ── Defaults ─────────────────────────────────────────────────────────────────────────────────────

const supply = (id: string, label: string, category: SupplyCategory, required: boolean, forServices: string[] = [], provider: "cleaner" | "company" = "cleaner"): SupplyItem => ({ id, label, category, provider, forServices, required });

export const DEFAULT_CONTENT: OnboardingContent = {
  support: {},
  agreementTypes: {},
  supplies: {
    rule: "advisory",
    items: [
      supply("all_purpose", "All-purpose cleaner", "solutions", true),
      supply("glass", "Glass and mirror cleaner", "solutions", true),
      supply("disinfectant", "Disinfectant", "solutions", true),
      supply("bathroom", "Bathroom cleaner", "solutions", true),
      supply("degreaser", "Kitchen degreaser", "solutions", true),
      supply("vacuum", "Vacuum with attachments", "tools", true),
      supply("mop", "Mop and bucket", "tools", true),
      supply("microfiber", "Microfiber cloths", "tools", true),
      supply("scrub_brush", "Scrub brushes", "tools", true),
      supply("caddy", "Caddy or tote for your kit", "tools", false),
      supply("gloves", "Cleaning gloves", "safety", true),
      supply("non_slip", "Non-slip shoes", "safety", false),
      supply("oven", "Oven cleaner", "specialty", true, ["deep clean", "move out"]),
      supply("step_stool", "Step stool", "specialty", false, ["deep clean", "move out"]),
      supply("floor_machine", "Floor scrubber or buffer", "specialty", true, ["commercial"]),
    ],
  },
  jobGuide: {
    title: "How your jobs work",
    intro: "Every job follows the same path, from the offer to getting paid. Each stop below is a page you will use.",
    agreeLabel: "I understand how jobs work and where to find each step.",
    sections: [
      { title: "You receive an offer", body: "Offers come by text or email with a link. The offer shows the day, time, area, service and the pay for the job before you decide." },
      { title: "Accept or decline", body: "Open the link and tap Accept or Decline. Declining is fine and is never held against you. An offer you do not answer expires, and the job goes to someone else." },
      { title: "Review the job instructions", body: "Once you accept, the job page shows the full address, access notes, the checklist and anything the client asked for. Read it before you leave." },
      { title: "Arrive and check in", body: "Arrive inside your arrival window. Tap Check in on the job page when you get there, so the office knows you started." },
      { title: "Report a delay or a problem", body: "Running late? Send your arrival time from the job page before your window starts. Locked out, a safety concern, or something broken? Report it on the job page or call the office straight away." },
      { title: "Work through the checklist", body: "Tick each item as you finish it. If something cannot be done, say why on the item instead of skipping it." },
      { title: "Add the photos asked for", body: "Some jobs ask for before and after photos, or a photo of a particular item. Add them on the job page; they protect you if a question comes up later." },
      { title: "Check out and see your earnings", body: "When everything is done, tap Complete. The office reviews the job, and its pay appears on your earnings statement once it is approved." },
    ],
  },
  expectations: {
    title: "Dress code and expectations",
    intro: "You are a guest in a client's home or workplace. These are the company's standards for every job.",
    agreeLabel: "I agree to follow these expectations on every job.",
    sections: [
      { title: "What to wear", body: "Clean, neat clothes you can bend and kneel in comfortably. Closed-toe shoes with a good grip." },
      { title: "On arrival", body: "Arrive inside your window, introduce yourself, and follow the client's notes about pets, alarms and parking." },
      { title: "In the home", body: "Treat the client's belongings with care. Ask before moving anything heavy, and put things back where they were." },
      { title: "Phones and guests", body: "Keep personal calls for breaks. Do not bring anyone to a job who is not assigned to it." },
      { title: "Privacy and safety", body: "Do not photograph the home except for photos the job asks for. If something feels unsafe, leave and call the office." },
    ],
  },
  payment: {
    methods: ["zelle", "check"],
    schedule: "Approved jobs are paid on the company's regular pay run. The office confirms the day with you.",
  },
  training: {
    modules: [
      {
        key: "job_page",
        title: "Using your job page",
        summary: "A short walkthrough of the page you use on every job.",
        kind: "guide",
        required: true,
        minutes: 4,
        sections: [
          { title: "Opening the job", body: "Your job link opens the job page. It shows the address once the job is yours, the arrival window, access notes and the checklist.", check: { question: "When do you see the full address of a job?", options: ["When the offer arrives", "Once you have accepted the job", "Only on the day"], answer: 1 } },
          { title: "Checking in and running late", body: "Tap Check in when you arrive. If you will be late, send your arrival time before your window starts so the client can be told.", check: { question: "You will be 20 minutes late. What do you do?", options: ["Nothing, just arrive", "Send your arrival time from the job page before the window starts", "Cancel the job"], answer: 1 } },
          { title: "The checklist and photos", body: "Tick items as you finish them. Add the before and after photos the job asks for. If an item cannot be done, say why on the item." },
          { title: "Finishing the job", body: "Tap Complete when everything is done. The office reviews the job and approves its pay; your earnings statement shows what was approved and paid.", check: { question: "When does a job's pay show as approved?", options: ["As soon as you tap Complete", "After the office reviews and approves it"], answer: 1 } },
        ],
      },
    ],
  },
};

// ── Reading and checking ─────────────────────────────────────────────────────────────────────────

const clean = (value: string | undefined, max: number) => {
  const out = (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return out || undefined;
};
const httpsOnly = (value: string | undefined) => {
  const url = clean(value, 500);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
};
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

function cleanGuide(guide: Guide, fallback: Guide): Guide {
  const sections = guide.sections
    .map((section) => ({ title: clean(section.title, 80) ?? "", body: (section.body ?? "").trim().slice(0, 1200), imageUrl: httpsOnly(section.imageUrl), imageAlt: clean(section.imageAlt, 200) }))
    .filter((section) => section.title && section.body)
    .slice(0, 12);
  return {
    title: clean(guide.title, 80) ?? fallback.title,
    intro: (guide.intro ?? "").trim().slice(0, 600),
    sections: sections.length ? sections : fallback.sections,
    agreeLabel: clean(guide.agreeLabel, 160) ?? fallback.agreeLabel,
    imageUrl: httpsOnly(guide.imageUrl),
    imageAlt: clean(guide.imageAlt, 200),
  };
}

/**
 * The content as it is kept: trimmed, bounded, unknown or unsafe values dropped (only https images and
 * videos), ids made unique. A problem a person must fix is returned as words, never silently changed.
 */
export function normalizeContent(input: OnboardingContent): { content: OnboardingContent; problems: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();
  const items: SupplyItem[] = [];
  for (const item of input.supplies.items.slice(0, 80)) {
    const label = clean(item.label, 80);
    if (!label) continue;
    let id = slug(item.id || label) || "item";
    while (seen.has(id)) id = `${id}_2`;
    seen.add(id);
    items.push({ id, label, category: item.category, provider: item.provider, required: item.required, forServices: [...new Set(item.forServices.map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 10) });
  }
  const methods = [...new Set(input.payment.methods)];
  if (methods.length === 0) problems.push("Choose at least one way the company pays people.");
  const moduleKeys = new Set<string>();
  const modules: TrainingModule[] = [];
  for (const lesson of input.training.modules.slice(0, 20)) {
    const title = clean(lesson.title, 100);
    if (!title) continue;
    let key = slug(lesson.key || title) || "module";
    while (moduleKeys.has(key)) key = `${key}_2`;
    moduleKeys.add(key);
    const videoUrl = httpsOnly(lesson.videoUrl);
    const sections = (lesson.sections ?? [])
      .map((section) => {
        const options = (section.check?.options ?? []).map((o) => clean(o, 120) ?? "").filter(Boolean).slice(0, 5);
        const check = section.check && clean(section.check.question, 200) && options.length >= 2 && Number.isInteger(section.check.answer) && section.check.answer >= 0 && section.check.answer < options.length ? { question: clean(section.check.question, 200)!, options, answer: section.check.answer } : undefined;
        return { title: clean(section.title, 80) ?? "", body: (section.body ?? "").trim().slice(0, 1500), check };
      })
      .filter((section) => section.title && section.body)
      .slice(0, 15);
    if (lesson.kind === "video" && !videoUrl) problems.push(`"${title}" needs a video address starting with https://, to a video file such as .mp4.`);
    if (lesson.kind === "guide" && sections.length === 0) problems.push(`"${title}" needs at least one section.`);
    const minutes = lesson.minutes !== undefined && Number.isFinite(lesson.minutes) ? Math.min(240, Math.max(1, Math.round(lesson.minutes))) : undefined;
    modules.push({ key, title, summary: clean(lesson.summary, 200), kind: lesson.kind, required: lesson.required, minutes, videoUrl: lesson.kind === "video" ? videoUrl : undefined, sections: lesson.kind === "guide" ? sections : undefined });
  }
  const content: OnboardingContent = {
    welcome: clean(input.welcome, 400),
    support: { phone: clean(input.support.phone, 40), email: clean(input.support.email, 120), hours: clean(input.support.hours, 120) },
    agreementTypes: { employee: clean(input.agreementTypes.employee, 60), contractor: clean(input.agreementTypes.contractor, 60) },
    supplies: { rule: input.supplies.rule, items },
    jobGuide: cleanGuide(input.jobGuide, DEFAULT_CONTENT.jobGuide),
    expectations: cleanGuide(input.expectations, DEFAULT_CONTENT.expectations),
    payment: { methods: methods.length ? methods : DEFAULT_CONTENT.payment.methods, schedule: (input.payment.schedule ?? "").trim().slice(0, 400) || DEFAULT_CONTENT.payment.schedule, instructions: clean(input.payment.instructions, 600) },
    training: { modules },
  };
  return { content, problems };
}

/** A short, stable fingerprint of a part of the content, so a change can be seen without comparing text by eye. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = stable(item);
    }
    return out;
  }
  return value;
}

export function fingerprint(value: unknown): string {
  // Key order and absent fields do not change the fingerprint: only the content does.
  const text = JSON.stringify(stable(value));
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The parts of the content a cleaner completes, by the requirement key they belong to, with their fingerprints. */
export function partsOf(content: OnboardingContent): Record<string, string> {
  return {
    job_day: fingerprint(content.jobGuide),
    policies: fingerprint(content.expectations),
    training: fingerprint(content.training.modules.filter((m) => m.required).map((m) => ({ key: m.key, kind: m.kind, videoUrl: m.videoUrl, sections: m.sections }))),
    equipment: fingerprint(content.supplies.items.filter((i) => i.provider === "cleaner")),
  };
}

export const PART_WORDS: Record<string, string> = { job_day: "How your jobs work", policies: "Dress code and expectations", training: "Required training", equipment: "Supplies checklist" };

export type PublishedOnboarding = {
  version: number;
  content: OnboardingContent;
  /** Requirement key → the version from which an earlier completion no longer counts. */
  reack: Record<string, number>;
  publishedAt: number | null;
};

/** The version in force: the latest published one, or Selestial's starting content as version 0. */
export function publishedOf(rows: Doc<"onboardingConfigs">[]): PublishedOnboarding {
  const live = rows.filter((row) => row.status === "published").sort((a, b) => b.version - a.version)[0];
  if (!live) return { version: 0, content: DEFAULT_CONTENT, reack: {}, publishedAt: null };
  return { version: live.version, content: live.content, reack: live.reack, publishedAt: live.publishedAt ?? null };
}

/** The required modules a cleaner must complete, from the content in force. */
export function requiredModules(content: OnboardingContent): TrainingModule[] {
  return content.training.modules.filter((lesson) => lesson.required);
}

/** Catalog items the cleaner is asked about, and the ones that apply to a visit of a service. */
export function askedSupplies(content: OnboardingContent): SupplyItem[] {
  return content.supplies.items.filter((item) => item.provider === "cleaner");
}

export function suppliesForVisit(content: OnboardingContent, service: string | null, skills: string[] = []): SupplyItem[] {
  const wanted = [service?.trim().toLowerCase() ?? "", ...skills.map((s) => s.toLowerCase())].filter(Boolean);
  return askedSupplies(content).filter((item) => item.required && (item.forServices.length === 0 || item.forServices.some((name) => wanted.includes(name))));
}

/** What a cleaner is missing for a visit, by label. Answers come from their submitted checklist. */
export function supplyGap(content: OnboardingContent, answers: Record<string, "have" | "missing"> | undefined, service: string | null, skills: string[] = []): string[] {
  if (!answers) return [];
  return suppliesForVisit(content, service, skills)
    .filter((item) => answers[item.id] !== "have")
    .map((item) => item.label);
}
