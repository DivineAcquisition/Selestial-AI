/**
 * Settling a text whose outcome is unknown (an "unconfirmed" message: the send started and never answered)
 * without ever sending it twice (docs/operations/02-incidents.md §Unconfirmed messages).
 *
 * Telnyx keeps the successful response to POST /v2/messages for 24 hours under its Idempotency-Key and
 * replays it, marked `Idempotent-Replayed: true`, when the same key and body come again (verified in its
 * OpenAPI on November 21, 2026). Every attempt of one message uses the same key (`selestial-<message id>`).
 * So sending the message again through the outbox, inside that window, answers the question:
 *
 *  - the first attempt reached Telnyx: the stored answer comes back and nothing new is sent;
 *  - it never did: the text goes now, after the send policy (consent, STOP, pauses, suspension, quiet hours),
 *    billing and the record's own checks all run again, so a text that is no longer relevant is not sent;
 *  - Telnyx holds a different request under the key: still unknown, and it stays unconfirmed.
 *
 * Any refusal on the way leaves the message unconfirmed (convex/messaging.ts), never "not sent". Selestial
 * checks a fresh one by itself; an older one waits for a person, who sees what checking means first.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { openByKey } from "./incidents";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Inside Telnyx's 24-hour replay window from the first attempt, with an hour's margin. */
export const RECONCILE_WINDOW_MS = 23 * HOUR;
/** Selestial checks by itself only while the text is fresh; later a person decides whether it still matters. */
export const AUTO_RECONCILE_MS = 30 * MINUTE;

/** Providers whose send endpoint is verified to replay a stored success for the same key (the mock models Telnyx). */
const REPLAYING = new Set(["telnyx", "mock"]);

/** When the first attempt went: Telnyx's replay window runs from it, not from a later check's attempt. */
export function firstAttempt(message: Pick<Doc<"messages">, "attemptedAt" | "firstAttemptedAt">): number | undefined {
  return message.firstAttemptedAt ?? message.attemptedAt;
}

export function reconcilable(message: Pick<Doc<"messages">, "status" | "channel" | "provider" | "attemptedAt" | "firstAttemptedAt" | "purpose" | "reviewedAt">, now: number): boolean {
  const first = firstAttempt(message);
  return (
    message.status === "unconfirmed" &&
    (message.channel ?? "sms") === "sms" &&
    REPLAYING.has(message.provider ?? "") &&
    message.purpose !== "verification_code" &&
    message.purpose !== "member_notice" &&
    message.reviewedAt === undefined &&
    first !== undefined &&
    now - first < RECONCILE_WINDOW_MS
  );
}

export type ReconcileActor = { kind: "system" } | { kind: "member"; memberId: Id<"members"> } | { kind: "support"; staffId: Id<"staff">; sessionId: Id<"supportSessions"> };

/**
 * Puts an unconfirmed text back through the outbox under its own key. Returns false when a check is
 * already under way. Throws for a message that can no longer be checked.
 */
export async function startReconcile(ctx: MutationCtx, message: Doc<"messages">, actor: ReconcileActor): Promise<boolean> {
  const now = Date.now();
  if (message.reconcile) return false;
  if (!reconcilable(message, now)) throw new Error("This message can't be checked with the provider any more.");
  const by = actor.kind === "member" ? `member:${actor.memberId}` : actor.kind === "support" ? `staff:${actor.staffId}:session:${actor.sessionId}` : "system";
  await ctx.db.patch(message._id, { status: "queued", reconcile: { requestedAt: now, deadline: (firstAttempt(message) ?? now) + RECONCILE_WINDOW_MS, by }, problem: "Checking with the texting provider whether this went." });
  await ctx.scheduler.runAfter(0, internal.messaging.deliver, { messageId: message._id });
  const incident = await openByKey(ctx, `message_unconfirmed:${message.companyId}`);
  if (incident) {
    const who = actor.kind === "member" ? "Someone at the company asked" : actor.kind === "support" ? "Selestial Support asked" : "Selestial began";
    await ctx.db.insert("incidentUpdates", { incidentId: incident._id, kind: "recovery", words: `${who} to check with the texting provider whether a message went. If it did, nothing is sent again.`, by: actor.kind === "support" ? actor.staffId : "system", at: now });
    await ctx.db.patch(incident._id, { recoveryAttempts: incident.recoveryAttempts + 1, updatedAt: now });
  }
  return true;
}

/** Why a queued reconciliation must not go now, or null. Checked by the outbox at the moment it claims the message. */
export async function reconcileStop(ctx: QueryCtx, message: Doc<"messages">): Promise<string | null> {
  if (!message.reconcile) return null;
  if (Date.now() > message.reconcile.deadline) return "The check with the texting provider ran out of time, so nothing was sent again.";
  // Asked for in a Selestial support session: that session must still be live when it runs.
  const session = message.reconcile.by.match(/:session:([a-z0-9]+)$/i)?.[1];
  if (session) {
    const id = ctx.db.normalizeId("supportSessions", session);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.endedAt !== undefined || row.expiresAt <= Date.now()) return "The support session that asked for this check ended before it ran, so nothing was sent.";
  }
  return null;
}
