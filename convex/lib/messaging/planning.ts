/**
 * How a planned message starts, from what the sending policy answered (docs/sms/00-architecture.md §4.2).
 * Every place that plans a message writes these same fields, so a refusal and a hold read the same way
 * wherever the message came from:
 *
 *   queued    may go now
 *   held      "not yet": waiting for sending hours, the owner's pause, an inbox; asked again at `retryAt`
 *   not_sent  refused, with the policy's code kept as `refusal` (convex/lib/messaging/lifecycle.ts)
 *
 * The code is kept on a held message too, so a screen can say what it waits for, and an owner's pause is
 * also kept as `holdReason`, so resuming finds exactly what the pause held (companies.resumeMessaging).
 */
import type { Doc } from "../../_generated/dataModel";

export type StartingState = {
  status: "queued" | "held" | "not_sent";
  /** Spread into the inserted row. */
  fields: Pick<Doc<"messages">, "refusal" | "holdReason" | "heldAt">;
};

export function startingState(input: { problem: string | null; code: string | null | undefined; retryAt: number | undefined; now: number }): StartingState {
  const status = !input.problem ? "queued" : input.retryAt !== undefined ? "held" : "not_sent";
  if (status === "queued") return { status, fields: {} };
  const code = input.code ?? undefined;
  if (status === "not_sent") return { status, fields: code ? { refusal: code } : {} };
  return { status, fields: { ...(code ? { refusal: code } : {}), ...(code === "messaging_paused" ? { holdReason: "messaging_paused" as const, heldAt: input.now } : {}) } };
}
