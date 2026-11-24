/**
 * Confirming that a person holds a phone, with a 6-digit code Selestial texts to it (docs/sms/00-architecture.md
 * §4.6, "verify phone for alerts"). Used for a member's notification phone (convex/myPhone.ts) and a staff
 * member's alert phone (convex/staffAlerts.ts). It is not a sign-in: Clerk alone signs people in, and a
 * confirmed phone grants nothing in any company.
 *
 * The code is kept only as a keyed hash bound to who asked and which number; its words travel only in the
 * call that texts it. 10 minutes, 5 tries, a few codes an hour.
 */
import { phoneKey } from "./guard";

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_TRIES = 5;

export type PhoneCheck = { phone: string; codeHash: string; expiresAt: number; attempts: number };

export function sixDigits(): string {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return String(value[0] % 1_000_000).padStart(6, "0");
}

export async function codeHash(scope: string, phone: string, code: string): Promise<string> {
  return phoneKey(`phone-check:${scope}:${phone}:${code}`);
}

/** "ok", or why the code was not accepted. A wrong code counts as a try. */
export async function checkCode(scope: string, check: PhoneCheck | undefined, code: string, now: number): Promise<"ok" | "expired" | "too_many" | "wrong"> {
  if (!check || check.expiresAt <= now) return "expired";
  if (check.attempts >= MAX_TRIES) return "too_many";
  return (await codeHash(scope, check.phone, code.replace(/\D/g, ""))) === check.codeHash ? "ok" : "wrong";
}

export const CHECK_WORDS = {
  expired: "That code has expired. Ask for a new one.",
  too_many: "Too many wrong codes. Ask for a new one.",
  wrong: "That code isn't right.",
} as const;
