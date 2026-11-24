/**
 * What became of a message, said the same way on every screen (docs/sms/00-architecture.md §4.3).
 *
 * Stored statuses stay few (convex/lib/statuses.ts); what a person sees is read from the row: why it is
 * held, why it was not sent, whether the carrier ever confirmed it. "Provider accepted" is never shown as
 * "Delivered", and "Delivery not confirmed" is never shown as a failure.
 *
 * Every refusal has a class, so a screen can tell an owner what to do next:
 *   hold        temporary; Selestial tries again by itself (sending hours, funds, billing, inbox)
 *   suppressed  permanent for this recipient (STOP, do-not-contact, carrier block)
 *   setup       the company has to act (number, registration, plan, permission)
 *   canceled    no longer needed, or stopped by a person or a pause
 *   policy      this message can't go as written (no address, too long, weekly limit)
 *   provider    Telnyx, Quo or the carrier did not take or deliver it
 */
import type { Doc } from "../../_generated/dataModel";

export type RefusalClass = "hold" | "suppressed" | "setup" | "canceled" | "policy" | "provider";
export type StateTone = "neutral" | "progress" | "good" | "warning" | "bad";

export type MessageState = {
  /** Stable key for screens and tests. */
  key: "scheduled" | "queued" | "held" | "sending" | "accepted" | "delivered" | "delivery_unknown" | "failed" | "unconfirmed" | "canceled" | "suppressed" | "not_sent";
  label: string;
  tone: StateTone;
  /** Set when the message did not go, or is waiting. */
  refusalClass: RefusalClass | null;
  /** Nothing more will happen to it by itself. */
  terminal: boolean;
};

type Row = Pick<Doc<"messages">, "status" | "refusal" | "holdReason" | "scheduledFor"> & { deliveryUnconfirmedAt?: number };

/** Policy, billing and domain refusal codes, by what an owner can do about them. */
const REFUSAL_CLASS: Record<string, RefusalClass> = {
  // Permanent for this recipient.
  suppressed: "suppressed",
  provider_block: "suppressed",
  // The company has to set something up.
  sender_not_ready: "setup",
  not_registered: "setup",
  no_plan: "setup",
  route_unsupported: "setup",
  no_permission: "setup",
  company_suspended: "setup",
  // Stopped on purpose, or no longer needed.
  follow_up_cancelled: "canceled",
  case_taken_over: "canceled",
  agent_paused: "canceled",
  conversation_owned: "canceled",
  no_longer_relevant: "canceled",
  canceled: "canceled",
  // This message, as written, can't go.
  no_address: "policy",
  too_long: "policy",
  frequency: "policy",
  // Waiting, retried by itself.
  quiet_hours: "hold",
  inbox_disconnected: "hold",
};

const HOLD_WORDS: Record<NonNullable<Doc<"messages">["holdReason"]>, string> = {
  quiet_hours: "Waiting until sending hours",
  messaging_balance: "Add funds to continue",
  messaging_limit: "Spending limit reached",
  billing_unavailable: "Waiting for billing to answer",
};

export function refusalClassOf(code: string | undefined | null): RefusalClass | null {
  if (!code) return null;
  return REFUSAL_CLASS[code] ?? null;
}

export function messageState(row: Row, now = Date.now()): MessageState {
  switch (row.status) {
    case "queued":
      return row.scheduledFor !== undefined && row.scheduledFor > now ? { key: "scheduled", label: "Scheduled", tone: "neutral", refusalClass: null, terminal: false } : { key: "queued", label: "Queued", tone: "progress", refusalClass: null, terminal: false };
    case "held": {
      if (row.scheduledFor !== undefined && row.scheduledFor > now && !row.holdReason && !row.refusal) return { key: "scheduled", label: "Scheduled", tone: "neutral", refusalClass: null, terminal: false };
      const label = row.holdReason ? HOLD_WORDS[row.holdReason] : row.refusal === "quiet_hours" ? HOLD_WORDS.quiet_hours : row.refusal === "inbox_disconnected" ? "Waiting for the inbox to reconnect" : "On hold";
      return { key: "held", label, tone: "warning", refusalClass: "hold", terminal: false };
    }
    case "sending":
      return { key: "sending", label: "Sending", tone: "progress", refusalClass: null, terminal: false };
    case "sent":
      return row.deliveryUnconfirmedAt !== undefined
        ? { key: "delivery_unknown", label: "Delivery not confirmed", tone: "warning", refusalClass: null, terminal: true }
        : { key: "accepted", label: "Provider accepted", tone: "neutral", refusalClass: null, terminal: false };
    case "delivered":
      return { key: "delivered", label: "Delivered", tone: "good", refusalClass: null, terminal: true };
    case "failed":
      return { key: "failed", label: "Failed", tone: "bad", refusalClass: "provider", terminal: true };
    case "unconfirmed":
      return { key: "unconfirmed", label: "Not known whether it went", tone: "warning", refusalClass: "provider", terminal: false };
    case "not_sent": {
      const refusalClass = refusalClassOf(row.refusal) ?? "policy";
      if (refusalClass === "suppressed") return { key: "suppressed", label: "Recipient opted out", tone: "bad", refusalClass, terminal: true };
      if (refusalClass === "canceled") return { key: "canceled", label: "Canceled", tone: "neutral", refusalClass, terminal: true };
      if (refusalClass === "setup") return { key: "not_sent", label: "Not sent: setup needed", tone: "bad", refusalClass, terminal: true };
      return { key: "not_sent", label: "Not sent", tone: "bad", refusalClass, terminal: true };
    }
  }
}
