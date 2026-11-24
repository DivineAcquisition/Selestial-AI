/**
 * Limits on Selestial's sign-in code texts, checked before Telnyx is asked (docs/sms/00-architecture.md
 * §4.6). Clerk already limits sign-in attempts per IP and locks accounts after failed codes; these limit
 * what Selestial will spend texting codes, and catch SMS pumping (fraud that requests codes to costly or
 * attacker-owned numbers in bulk):
 *
 *   destination   5 an hour, 10 a day to one number
 *   person        10 an hour to one Clerk user, whatever the number
 *   number block  20 an hour to one NPA-NXX (the first six digits): pumping rotates numbers in a block
 *   everyone      PLATFORM_SMS_CODES_PER_HOUR (default 300) for the whole platform: a circuit breaker
 *   route         standard US numbers only (convex/lib/messagingBilling/routes.ts)
 *
 * A refused code is recorded with its reason and never sent; the person sees Clerk's usual screen and can
 * use another way to sign in. Nothing here tells anyone whether an account exists.
 */
import type { MutationCtx } from "../../_generated/server";
import { smsRoute } from "../messagingBilling/routes";
import { allow } from "../rateLimit";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export type CodeRefusal = "unsupported_route" | "destination_limit" | "person_limit" | "number_block_limit" | "platform_limit";

export const REFUSAL_WORDS: Record<CodeRefusal, string> = {
  unsupported_route: "Codes are texted only to standard US numbers.",
  destination_limit: "Too many codes to this number recently.",
  person_limit: "Too many codes for this person recently.",
  number_block_limit: "Too many codes to numbers in this block recently (possible SMS pumping).",
  platform_limit: "Selestial reached its hourly limit for sign-in texts (circuit breaker).",
};

function hourlyCeiling(): number {
  const value = Number(process.env.PLATFORM_SMS_CODES_PER_HOUR);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 300;
}

/** Null when a code may be texted now; otherwise why not. Counts the attempt either way it passes. */
export async function codeRefusal(ctx: MutationCtx, input: { to: string; toKey: string; userId?: string }): Promise<CodeRefusal | null> {
  if (!smsRoute(input.to).ok) return "unsupported_route";
  if (!(await allow(ctx, `platform-code:to-hour:${input.toKey}`, 5, HOUR))) return "destination_limit";
  if (!(await allow(ctx, `platform-code:to-day:${input.toKey}`, 10, DAY))) return "destination_limit";
  if (input.userId && !(await allow(ctx, `platform-code:user:${input.userId}`, 10, HOUR))) return "person_limit";
  if (!(await allow(ctx, `platform-code:block:${input.to.slice(0, 8)}`, 20, HOUR))) return "number_block_limit";
  if (!(await allow(ctx, "platform-code:all", hourlyCeiling(), HOUR))) return "platform_limit";
  return null;
}

/**
 * A keyed hash of a phone number, so limits and records never hold the number itself. Keyed with
 * PLATFORM_SMS_KEY (or ACTION_LINK_SECRET): a plain hash of a 10-digit number is easy to reverse.
 */
export async function phoneKey(phone: string): Promise<string> {
  const secret = process.env.PLATFORM_SMS_KEY?.trim() || process.env.ACTION_LINK_SECRET?.trim() || "selestial-platform-sms-unkeyed";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`selestial.phone.v1:${phone}`)));
  return Array.from(mac.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
