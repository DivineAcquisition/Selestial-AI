/**
 * Care Setup: what a company tells Care, with a default in code for each value. Settings that already
 * live somewhere else are read from there and never copied: the sender name and quiet hours (the compliance
 * profile), operating hours (business settings), authority (Agent Controls), pause (the company's agent list),
 * and each person's notifications (their own notice settings).
 */
import type { Doc } from "../../_generated/dataModel";
import { retentionSettings } from "../retention/settings";
import { CARE_CATEGORIES, type CareCategory } from "./schema";

export type CareSettings = {
  requestTypes: readonly CareCategory[];
  policy: { changeNoticeHours: number | null; lateChangeFeeCents: number | null; source: string | null };
  tone: "warm" | "direct" | "formal";
  signature: string | null;
  escalationMemberIds: Doc<"members">["_id"][];
  respondWithinMinutes: number;
  updateEveryHours: number;
  readInbox: boolean;
  revision: number;
};

export const CARE_DEFAULTS = { respondWithinMinutes: 30, updateEveryHours: 24, tone: "warm" as const };

export const CATEGORY_WORDS: Record<CareCategory, string> = {
  appointment: "Visit and service questions",
  preference: "Preferences",
  access: "Access instructions",
  reschedule: "Rescheduling",
  cancellation: "Skips and cancellations",
  complaint: "Complaints",
  billing: "Invoices and payments",
  extra: "Extra services",
  new_service: "New service (Sales)",
  general: "Other requests",
};

export function careSettings(company: Pick<Doc<"companies">, "clientCare" | "retention">): CareSettings {
  const saved = company.clientCare ?? {};
  return {
    requestTypes: saved.requestTypes ?? CARE_CATEGORIES,
    policy: { changeNoticeHours: saved.policy?.changeNoticeHours ?? null, lateChangeFeeCents: saved.policy?.lateChangeFeeCents ?? null, source: saved.policy?.source ?? null },
    tone: saved.tone ?? CARE_DEFAULTS.tone,
    signature: saved.signature?.trim() || null,
    escalationMemberIds: saved.escalationMemberIds ?? [],
    respondWithinMinutes: saved.respondWithinMinutes ?? CARE_DEFAULTS.respondWithinMinutes,
    updateEveryHours: saved.updateEveryHours ?? CARE_DEFAULTS.updateEveryHours,
    // The switch moved from Retention's Playbook to Care Setup (the Owner's decision of November 25, 2026).
    readInbox: saved.readInbox ?? retentionSettings(company as Doc<"companies">).readCareInbox,
    revision: saved.revision ?? 0,
  };
}
