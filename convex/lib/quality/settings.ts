/**
 * How Quality works for one company. Every value is the Owner's, with a default here. Nothing in this file
 * is a quality threshold, a guarantee window or a disciplinary rule: those are the company's standards
 * (convex/lib/quality/standards.ts), and what Quality may do without asking is the shared permission catalog.
 */
import type { Doc } from "../../_generated/dataModel";
import { userError } from "../errors";
import type { QualitySettingsInput } from "./schema";

export type QualitySettings = {
  linkDays: number;
  cleanerAnswerHours: number;
  combineMinutes: number;
  maxRequestsPerVisit: number;
  readPhonePlatform: boolean;
  reader: boolean;
  preserveDays: number | null;
  patternMinimum: number;
};

export const QUALITY_DEFAULTS: QualitySettings = {
  linkDays: 7,
  cleanerAnswerHours: 24,
  combineMinutes: 20,
  maxRequestsPerVisit: 2,
  readPhonePlatform: false,
  reader: false,
  preserveDays: null,
  patternMinimum: 3,
};

export function qualitySettings(company: Pick<Doc<"companies">, "quality">): QualitySettings {
  const stored = company.quality ?? {};
  return {
    linkDays: stored.linkDays ?? QUALITY_DEFAULTS.linkDays,
    cleanerAnswerHours: stored.cleanerAnswerHours ?? QUALITY_DEFAULTS.cleanerAnswerHours,
    combineMinutes: stored.combineMinutes ?? QUALITY_DEFAULTS.combineMinutes,
    maxRequestsPerVisit: stored.maxRequestsPerVisit ?? QUALITY_DEFAULTS.maxRequestsPerVisit,
    readPhonePlatform: stored.readPhonePlatform ?? QUALITY_DEFAULTS.readPhonePlatform,
    reader: stored.reader ?? QUALITY_DEFAULTS.reader,
    preserveDays: stored.preserveDays ?? null,
    patternMinimum: stored.patternMinimum ?? QUALITY_DEFAULTS.patternMinimum,
  };
}

const whole = (value: number, low: number, high: number, label: string) => {
  if (!Number.isInteger(value) || value < low || value > high) throw userError(`${label} must be a whole number from ${low} to ${high}.`);
  return value;
};

export function checkedQualitySettings(input: QualitySettingsInput): QualitySettingsInput {
  const out: QualitySettingsInput = {};
  if (input.linkDays !== undefined) out.linkDays = whole(input.linkDays, 1, 30, "Days a request link stays open");
  if (input.cleanerAnswerHours !== undefined) out.cleanerAnswerHours = whole(input.cleanerAnswerHours, 1, 24 * 7, "Hours a cleaner has to answer");
  if (input.combineMinutes !== undefined) out.combineMinutes = whole(input.combineMinutes, 0, 240, "Minutes to gather related gaps");
  if (input.maxRequestsPerVisit !== undefined) out.maxRequestsPerVisit = whole(input.maxRequestsPerVisit, 1, 5, "Requests per person per visit");
  if (input.readPhonePlatform !== undefined) out.readPhonePlatform = input.readPhonePlatform;
  if (input.reader !== undefined) out.reader = input.reader;
  if (input.preserveDays !== undefined) out.preserveDays = whole(input.preserveDays, 30, 3650, "Days preserved evidence is kept");
  if (input.patternMinimum !== undefined) out.patternMinimum = whole(input.patternMinimum, 2, 50, "Reviewed cases before a pattern is proposed");
  return out;
}
