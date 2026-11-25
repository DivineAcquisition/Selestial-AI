/**
 * Selestial Founding Access: the customer-facing name for the early-user offer that billing already sells
 * (convex/lib/billing/earlyOffer.ts, the Owner's terms of November 22–23, 2026). This file adds nothing
 * commercial. It names the offer, versions it, and adds the one thing the billing rule did not have: a
 * single, shared 90-day ENROLLMENT WINDOW.
 *
 *   The window is when a company may start a founding claim. It is not a trial, not the length of the
 *   founding price (that is EARLY_OFFER.months, counted per company from its first paid period), and not
 *   an account expiry. It is set once, by staff, when the campaign is deliberately activated
 *   (convex/founding.ts, `activate`). Nothing else starts or moves it: not a page load, a sign-up, a deploy
 *   or a visitor's browser. Every visitor sees the same deadline, read from the server.
 *
 * Pure: no database, no clock of its own. Callers pass `now`.
 */
import { AUTUMN, EARLY_BONUS_AGENTS, EARLY_OFFER, PLANS } from "../billing/catalog";

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The offer as one versioned record. Raise `version` whenever a customer-facing term changes; each claim
 * keeps the version it was made under (earlyOffers.offerVersion, foundingClaims.offerVersion).
 */
export const FOUNDING_OFFER = {
  id: "founding-access",
  version: "2026-11-25.1",
  name: "Selestial Founding Access",
  /** Length of the shared enrollment window, from the moment staff activate it. */
  enrollmentDays: 90,
  /** The zone dates are shown in on the public page. Not a legal choice: change it with the Owner's say. */
  displayTimezone: "America/Chicago",
  /** The capacity limit the billing rule enforces (first N companies whose first plan payment succeeds). */
  capacity: EARLY_OFFER.places,
  billing: {
    /** The Autumn plan a founding claim is billed on. */
    autumnPlanId: AUTUMN.earlyPlan,
    /** The plan it renews onto after the founding months. */
    renewsOntoAutumnPlanId: AUTUMN.plans[EARLY_OFFER.plan],
    foundingMonthlyCents: EARLY_OFFER.monthlyCents,
    foundingMonths: EARLY_OFFER.months,
    renewalMonthlyCents: PLANS[EARLY_OFFER.plan].monthlyCents,
    trial: false,
  },
  /** Agents beyond the plan that a claimed place keeps, also after the founding months. */
  bonusAgents: EARLY_BONUS_AGENTS,
} as const;

export type Campaign = {
  status: "draft" | "open" | "closed";
  enrollmentStartsAt?: number;
  enrollmentEndsAt?: number;
  closedAt?: number;
};

export type EnrollmentState = "not_open" | "open" | "closed_deadline" | "closed_full" | "closed";

/**
 * Whether a founding claim may start now. `placesUsed` is the billing rule's own count (claimed + ended +
 * live reservations), so "full" here and "full" at checkout are the same fact.
 */
export function enrollmentState(campaign: Campaign | null, placesUsed: number, now: number): EnrollmentState {
  if (!campaign || campaign.status === "draft" || campaign.enrollmentStartsAt === undefined || campaign.enrollmentEndsAt === undefined) return "not_open";
  if (campaign.status === "closed") return "closed";
  if (now < campaign.enrollmentStartsAt) return "not_open";
  if (now >= campaign.enrollmentEndsAt) return "closed_deadline";
  if (placesUsed >= FOUNDING_OFFER.capacity) return "closed_full";
  return "open";
}

export function enrollmentOpen(campaign: Campaign | null, placesUsed: number, now: number): boolean {
  return enrollmentState(campaign, placesUsed, now) === "open";
}

/** The window an activation at `at` sets. */
export function windowFrom(at: number): { enrollmentStartsAt: number; enrollmentEndsAt: number } {
  return { enrollmentStartsAt: at, enrollmentEndsAt: at + FOUNDING_OFFER.enrollmentDays * DAY_MS };
}

/** Days, hours and minutes left, never below zero. Seconds are left out on purpose: the timer is calm. */
export function remaining(endsAt: number, now: number): { days: number; hours: number; minutes: number; done: boolean } {
  const ms = Math.max(0, endsAt - now);
  const totalMinutes = Math.floor(ms / 60_000);
  return { days: Math.floor(totalMinutes / 1440), hours: Math.floor((totalMinutes % 1440) / 60), minutes: totalMinutes % 60, done: ms === 0 };
}

// ── What a claim collects ───────────────────────────────────────────────────────────────────────

export const CURRENT_SOFTWARE = [
  ["jobber", "Jobber"],
  ["housecall_pro", "Housecall Pro"],
  ["bookingkoala", "BookingKoala"],
  ["gohighlevel", "GoHighLevel"],
  ["another_platform", "Another platform"],
  ["manual", "Spreadsheets, calendar or mostly manual"],
] as const;

/** The same values as setup's "People who clean" (convex/lib/setup/facts.ts SCALE_CHOICES), so the answer carries over as is. */
export const TEAM_SIZES = [
  ["1", "Just me"],
  ["2-5", "2 to 5"],
  ["6-15", "6 to 15"],
  ["16-40", "16 to 40"],
  ["41+", "More than 40"],
] as const;

/** Setup's priority (convex/lib/setup/path.ts) for each founding priority. */
export const SETUP_PRIORITY: Record<Priority, "sales" | "dispatch" | "recruiter" | "retention"> = { bookings: "sales", staffing: "dispatch", recruiting: "recruiter", retention: "retention" };

/** The words for a booking platform, for setup's "Other tools"; manual tools have no platform. */
export function platformName(software: string): string | null {
  if (software === "manual" || software === "another_platform") return null;
  return CURRENT_SOFTWARE.find(([key]) => key === software)?.[1] ?? null;
}

export const PRIORITIES = [
  ["bookings", "Bookings"],
  ["staffing", "Staffing"],
  ["recruiting", "Recruiting"],
  ["retention", "Retention"],
] as const;

type Keys<T extends readonly (readonly [string, string])[]> = T[number][0];
export type CurrentSoftware = Keys<typeof CURRENT_SOFTWARE>;
export type TeamSize = Keys<typeof TEAM_SIZES>;
export type Priority = Keys<typeof PRIORITIES>;

const has = (list: readonly (readonly [string, string])[], value: string) => list.some(([key]) => key === value);

export type ClaimAnswers = { companyName: string; currentSoftware: CurrentSoftware; teamSize: TeamSize; priority: Priority };

/** Checks a claim's answers. Null when anything is missing or not one of the listed choices. */
export function checkedClaim(input: { companyName: string; currentSoftware: string; teamSize: string; priority: string }): ClaimAnswers | null {
  const companyName = input.companyName.trim().replace(/\s+/g, " ");
  if (!companyName || companyName.length > 160) return null;
  if (!has(CURRENT_SOFTWARE, input.currentSoftware) || !has(TEAM_SIZES, input.teamSize) || !has(PRIORITIES, input.priority)) return null;
  return { companyName, currentSoftware: input.currentSoftware as CurrentSoftware, teamSize: input.teamSize as TeamSize, priority: input.priority as Priority };
}

/**
 * Campaign attribution that may be kept: the three standard UTM fields, short, from a plain character set.
 * Anything else (an email address, a click id, free text) is dropped rather than stored.
 */
export function checkedAttribution(input: { source?: string; medium?: string; campaign?: string } | undefined): { source?: string; medium?: string; campaign?: string } {
  const clean = (value: string | undefined) => {
    const text = value?.trim().toLowerCase();
    return text && /^[a-z0-9._-]{1,60}$/.test(text) ? text : undefined;
  };
  const out: { source?: string; medium?: string; campaign?: string } = {};
  const source = clean(input?.source);
  const medium = clean(input?.medium);
  const campaign = clean(input?.campaign);
  if (source) out.source = source;
  if (medium) out.medium = medium;
  if (campaign) out.campaign = campaign;
  return out;
}
