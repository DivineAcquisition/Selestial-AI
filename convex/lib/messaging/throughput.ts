/**
 * Sending lanes and throughput (docs/sms/00-architecture.md §4.4). Every text has a lane:
 *
 *   urgent    answers to STOP/HELP/START and sign-in codes: never wait behind anything else
 *   standard  one-to-one business texts
 *   bulk      marketing and batch sends: a smaller share, so one company's campaign never crowds out
 *             its own (or anyone else's) everyday texts
 *
 * Limits are per company (fairness: one company can't take all of Selestial's sending capacity) and per
 * sending number (carrier throughput: a number pushed faster than its campaign allows makes Telnyx queue
 * and then expire texts, 40014). A text over a limit isn't refused: it stays queued and is tried again a
 * little later, before anything is reserved or charged.
 *
 * Settings: SMS_COMPANY_PER_MINUTE (default 60), SMS_NUMBER_PER_MINUTE (default 60). Bulk gets a third
 * of the company's limit.
 */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { allow } from "../rateLimit";
import type { SendIntent } from "./outbox";

export type Lane = "urgent" | "standard" | "bulk";

const MINUTE = 60_000;

function setting(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function laneOf(message: Pick<Doc<"messages">, "purpose">, intent: Pick<SendIntent, "reply" | "origin" | "category">): Lane {
  if (intent.reply || message.purpose === "verification_code" || message.purpose === "compliance_reply") return "urgent";
  if (intent.origin === "bulk" || intent.category === "marketing") return "bulk";
  return "standard";
}

/**
 * Null when the text may go now. Otherwise how long to wait before trying again (ms), spread a little by
 * the message's id so a burst doesn't all come back in the same instant.
 */
export async function throughputWait(ctx: MutationCtx, input: { companyId: Doc<"messages">["companyId"]; messageId: string; number: string | null; lane: Lane }): Promise<number | null> {
  if (input.lane === "urgent") return null;
  const perCompany = setting("SMS_COMPANY_PER_MINUTE", 60);
  const companyLimit = input.lane === "bulk" ? Math.max(1, Math.floor(perCompany / 3)) : perCompany;
  const spread = (Array.from(input.messageId).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 20) * 1000;
  if (!(await allow(ctx, `sms-rate:company:${input.companyId}:${input.lane}`, companyLimit, MINUTE))) return 30_000 + spread;
  if (input.number && !(await allow(ctx, `sms-rate:number:${input.number}`, setting("SMS_NUMBER_PER_MINUTE", 60), MINUTE))) return 30_000 + spread;
  return null;
}
