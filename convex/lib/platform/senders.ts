/**
 * Selestial's own senders (docs/sms/00-architecture.md §4.5): one for sign-in codes, one for notices, each
 * a toll-free number on its own Telnyx messaging profile, so a problem with one never stops the other.
 *
 * Settings on the deployment (set by Selestial staff once Telnyx shows the toll-free number "Verified";
 * an unverified toll-free number is blocked by US carriers, error 40329):
 *   PLATFORM_SMS_CODES_FROM, PLATFORM_SMS_CODES_PROFILE_ID
 *   PLATFORM_SMS_NOTICES_FROM, PLATFORM_SMS_NOTICES_PROFILE_ID
 *
 * Until the code sender is set, Clerk keeps delivering its own SMS ("Delivered by Clerk" stays on), so a
 * person can always get a code. Selestial never sends a company's texts from these numbers, and never
 * sends Selestial's own texts from a company's number.
 */
import type { PlatformSender } from "./schema";

export type SenderConfig = { from: string; messagingProfileId: string };

const E164 = /^\+1[2-9]\d{9}$/;

export function platformSender(which: PlatformSender): SenderConfig | null {
  const prefix = which === "codes" ? "PLATFORM_SMS_CODES" : "PLATFORM_SMS_NOTICES";
  const from = process.env[`${prefix}_FROM`]?.trim() ?? "";
  const messagingProfileId = process.env[`${prefix}_PROFILE_ID`]?.trim() ?? "";
  if (!E164.test(from) || !messagingProfileId) return null;
  return { from, messagingProfileId };
}

/** Every number Selestial itself texts from. A text arriving at one of these is Selestial's, never a company's. */
export function platformNumbers(): string[] {
  return (["codes", "notices"] as const).map((which) => platformSender(which)?.from).filter((from): from is string => Boolean(from));
}

/** What someone who replies to a Selestial number is told, at most once a day: these numbers take no replies. */
export const NO_REPLY_ANSWER = "Selestial: this number doesn't take replies. For help, email support@selestial.io or use Help in the Selestial app. Reply STOP to stop these texts.";
