/** The Cleaners workspace's rules for a company: the Owner's values over the defaults here. */
import type { Doc } from "../../_generated/dataModel";
import type { Engagement, RequirementEffect, RequirementKind } from "./schema";

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export type CleanersSettings = {
  availabilityConfirmDays: number;
  idleAfterDays: number;
  reminderEveryHours: number;
  maxReminders: number;
  followUpChannels: ("sms" | "email")[];
  expiryWarningDays: number;
  portalLinkDays: number;
  personnelDecider: "owner" | "owner_or_manager";
  endedAccess: "revoke" | "history_only";
};

export function cleanersSettings(company: Pick<Doc<"companies">, "cleaners">): CleanersSettings {
  const own = company.cleaners ?? {};
  const whole = (value: number | undefined, fallback: number, min: number, max: number) => (value !== undefined && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);
  return {
    availabilityConfirmDays: whole(own.availabilityConfirmDays, 30, 7, 365),
    idleAfterDays: whole(own.idleAfterDays, 21, 7, 180),
    reminderEveryHours: whole(own.reminderEveryHours, 48, 12, 24 * 14),
    maxReminders: whole(own.maxReminders, 3, 0, 10),
    followUpChannels: own.followUpChannels?.length ? own.followUpChannels : ["sms", "email"],
    expiryWarningDays: whole(own.expiryWarningDays, 30, 1, 120),
    portalLinkDays: whole(own.portalLinkDays, 30, 1, 90),
    personnelDecider: own.personnelDecider ?? "owner",
    endedAccess: own.endedAccess ?? "revoke",
  };
}

export type Definition = {
  key: string;
  label: string;
  description?: string;
  kind: RequirementKind;
  effect: RequirementEffect;
  appliesTo: Engagement[];
  reviewer: "manager" | "owner";
  validForDays?: number;
  providedBy?: "company" | "cleaner" | "crew";
  forServices: string[];
  cleanerCompletes: boolean;
  agreementDocType?: string;
  /** For an acknowledgment: when its words last changed. */
  wordsChangedAt?: number;
  /** A person checks what the cleaner did before it counts. */
  officeReview?: boolean;
  /**
   * Set from the company's published onboarding (records.ts) for a step whose content is versioned (a guide,
   * training, the supplies checklist): a completion from an earlier version than this no longer counts.
   */
  versionFloor?: number;
  /** For an acknowledgment shown as a guide: which guide of the onboarding content it shows. */
  guide?: "jobGuide" | "expectations";
  order: number;
  /** True when this is the code's default, not a row the Owner saved. */
  isDefault: boolean;
};

const ALL: Engagement[] = ["employee", "contractor", "subcontractor"];
const DIRECT: Engagement[] = ["employee", "contractor"];

/**
 * Selestial's starting template, the guided onboarding: sign, verify and confirm details, check supplies, learn
 * how jobs work, agree to expectations, set up pay, then training. It is a starting point the Owner changes,
 * not a policy: nothing here is taken from another company's rules. No step is an upload: the tax document is
 * prepared in the background (kind "tax") and asks for what it needs inside the pay step. Subcontractor
 * workers are paid and contracted through their own company, so pay, tax and the working agreement are that
 * company's, not each worker's.
 */
export const DEFAULT_DEFINITIONS: Definition[] = [
  { key: "agreement", label: "Working agreement", description: "Read and sign your agreement with the company.", kind: "agreement", effect: "blocks_assignments", appliesTo: DIRECT, reviewer: "owner", forServices: [], cleanerCompletes: true, order: 10, isDefault: true },
  { key: "contact", label: "Phone and details", description: "Verify your mobile number and confirm the details the company uses to reach you.", kind: "contact", effect: "blocks_assignments", appliesTo: ALL, reviewer: "manager", forServices: [], cleanerCompletes: true, order: 20, isDefault: true },
  { key: "availability", label: "Weekly availability", description: "The days and hours you can work.", kind: "availability", effect: "blocks_assignments", appliesTo: ALL, reviewer: "manager", forServices: [], cleanerCompletes: true, order: 22, isDefault: true },
  { key: "service_areas", label: "Service areas", description: "The areas you will travel to for work.", kind: "service_areas", effect: "blocks_assignments", appliesTo: ALL, reviewer: "manager", forServices: [], cleanerCompletes: true, order: 24, isDefault: true },
  { key: "equipment", label: "Supplies checklist", description: "Tell us which supplies you have. Missing something is fine: answer truthfully.", kind: "equipment", effect: "informational", appliesTo: DIRECT, reviewer: "manager", providedBy: "cleaner", forServices: [], cleanerCompletes: true, order: 30, isDefault: true },
  { key: "job_day", label: "How your jobs work", description: "From the offer to getting paid.", kind: "acknowledgment", effect: "blocks_assignments", appliesTo: ALL, reviewer: "manager", forServices: [], cleanerCompletes: true, guide: "jobGuide", order: 40, isDefault: true },
  { key: "policies", label: "Dress code and expectations", description: "The company's standards for every job.", kind: "acknowledgment", effect: "blocks_assignments", appliesTo: ALL, reviewer: "manager", forServices: [], cleanerCompletes: true, guide: "expectations", order: 50, isDefault: true },
  { key: "payment_setup", label: "How you get paid", description: "Choose how you would like to be paid. The office confirms it before your first payment.", kind: "payment", effect: "blocks_payment", appliesTo: DIRECT, reviewer: "owner", forServices: [], cleanerCompletes: true, order: 60, isDefault: true },
  { key: "tax_form", label: "Tax document", description: "Prepared from the details you give in the pay step.", kind: "tax", effect: "blocks_payment", appliesTo: ["contractor"], reviewer: "owner", forServices: [], cleanerCompletes: true, order: 65, isDefault: true },
  { key: "training", label: "Training", description: "The company's training before your first job.", kind: "training", effect: "informational", appliesTo: DIRECT, reviewer: "manager", forServices: [], cleanerCompletes: true, order: 90, isDefault: true },
];

/**
 * The starting template before the guided onboarding (until November 2026). A company that never saved its
 * own template and has not switched keeps it, so nobody already onboarding is held up by a step they were
 * never given or let through one they were. Its tax form is read as the background tax kind: it is never
 * shown as an upload any more, and a tax form already accepted stays accepted.
 */
export const V1_DEFINITIONS: Definition[] = [
  { key: "contact", label: "Contact details", description: "Confirm the phone number and email we use to reach you.", kind: "contact", effect: "blocks_assignments", appliesTo: ALL, reviewer: "manager", forServices: [], cleanerCompletes: true, order: 10, isDefault: true },
  { key: "agreement", label: "Working agreement", description: "Your agreement with the company, signed.", kind: "agreement", effect: "blocks_assignments", appliesTo: DIRECT, reviewer: "owner", forServices: [], cleanerCompletes: false, order: 20, isDefault: true },
  { key: "documents", label: "Identity documents", description: "Upload the documents the company asked for. A person checks them.", kind: "document", effect: "blocks_assignments", appliesTo: ALL, reviewer: "manager", forServices: [], cleanerCompletes: true, order: 30, isDefault: true },
  { key: "availability", label: "Weekly availability", description: "The days and hours you can work.", kind: "availability", effect: "blocks_assignments", appliesTo: ALL, reviewer: "manager", forServices: [], cleanerCompletes: true, order: 40, isDefault: true },
  { key: "service_areas", label: "Service areas", description: "The areas you will travel to for work.", kind: "service_areas", effect: "blocks_assignments", appliesTo: ALL, reviewer: "manager", forServices: [], cleanerCompletes: true, order: 50, isDefault: true },
  { key: "policies", label: "Company policies", description: "Read and acknowledge how the company works.", kind: "acknowledgment", effect: "blocks_assignments", appliesTo: ALL, reviewer: "manager", forServices: [], cleanerCompletes: true, order: 60, isDefault: true },
  { key: "training", label: "Training", description: "The company's training before your first job.", kind: "training", effect: "informational", appliesTo: DIRECT, reviewer: "manager", forServices: [], cleanerCompletes: false, order: 70, isDefault: true },
  { key: "equipment", label: "Own cleaning kit", description: "Tell us the equipment and supplies you bring.", kind: "equipment", effect: "informational", appliesTo: ["contractor"], reviewer: "manager", providedBy: "cleaner", forServices: [], cleanerCompletes: true, order: 80, isDefault: true },
  { key: "tax_form", label: "Tax form", description: "The tax form the company needs to pay you.", kind: "tax", effect: "blocks_payment", appliesTo: DIRECT, reviewer: "owner", forServices: [], cleanerCompletes: true, order: 90, isDefault: true },
  { key: "payment_setup", label: "Payment details", description: "How you get paid. Starting setup is not finishing it: the office confirms it is complete.", kind: "payment", effect: "blocks_payment", appliesTo: DIRECT, reviewer: "owner", forServices: [], cleanerCompletes: true, order: 100, isDefault: true },
];

/** The starting template a company uses while it has no saved template of its own. */
export function startingDefinitions(company: Pick<Doc<"companies">, "cleaners">): Definition[] {
  return company.cleaners?.startingTemplate === "guided" ? DEFAULT_DEFINITIONS : V1_DEFINITIONS;
}

/**
 * A tax form is never an upload step any more: a saved row of kind "document" keyed tax_form is read as the
 * background tax kind.
 */
function upgrade(def: Definition): Definition {
  if (def.key === "tax_form" && def.kind === "document") return { ...def, kind: "tax" };
  return def;
}

/** Keys Recruiter's Playbook used before this workspace existed, mapped onto the template's kinds. */
const RECRUITER_KINDS: Record<string, RequirementKind> = { agreement: "agreement", documents: "document", training: "training", equipment: "equipment", payment_setup: "payment" };

/**
 * The company's template: its saved rows, or the default. A company that set its own onboarding list in
 * Recruiter's Playbook keeps it: those items become the template, each blocking assignments, with the
 * default's other items added so contact, availability and areas are still asked for.
 */
export function definitionsOf(company: Pick<Doc<"companies">, "name" | "recruiter" | "cleaners">, rows: Doc<"requirementDefinitions">[]): Definition[] {
  if (rows.length > 0) {
    return rows
      .filter((row) => row.status === "active")
      .map((row) => ({
        key: row.key,
        label: row.label,
        description: row.description,
        kind: row.kind,
        effect: row.effect,
        appliesTo: row.appliesTo,
        reviewer: row.reviewer,
        validForDays: row.validForDays,
        providedBy: row.providedBy,
        forServices: row.forServices,
        cleanerCompletes: row.cleanerCompletes,
        agreementDocType: row.agreementDocType,
        wordsChangedAt: row.wordsChangedAt,
        officeReview: row.officeReview,
        guide: row.guide,
        order: row.order,
        isDefault: false,
      }))
      .map(upgrade)
      .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  }
  const start = startingDefinitions(company);
  const custom = company.recruiter?.onboardingRequirements;
  if (!custom?.length) return start;
  const fromRecruiter: Definition[] = custom.map((item, index) => {
    const known = start.find((def) => def.key === item.key);
    return known ? { ...known, label: item.label } : { key: item.key, label: item.label, kind: RECRUITER_KINDS[item.key] ?? "custom", effect: "blocks_assignments", appliesTo: DIRECT, reviewer: "manager", forServices: [], cleanerCompletes: false, order: 100 + index, isDefault: true };
  });
  const keys = new Set(fromRecruiter.map((def) => def.key));
  return [...start.filter((def) => !keys.has(def.key) && ["contact", "availability", "service_areas"].includes(def.key)), ...fromRecruiter].map(upgrade).sort((a, b) => a.order - b.order);
}
