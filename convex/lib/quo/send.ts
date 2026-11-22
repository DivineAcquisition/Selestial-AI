/**
 * Sending one text through the company's Quo account, from the outbox's deliver step (convex/messaging.ts). The
 * policy has already checked the route, the conversation's owner, consent, quiet hours and pauses at claim time.
 *
 * Immediately before an agent's conversational text goes, Quo itself is asked about the conversation since the
 * text was written: a text sent from the Quo app (by a person, or one of Quo's automations) or a newer reply wins,
 * and the agent's text is not sent. Standardized operational texts (offers, reminders, confirmations) skip this.
 *
 * Quo has no idempotency key. A send that gets no answer is left unconfirmed and checked against Quo's own message
 * list before anything is sent again (convex/quoSend.ts); it is never resent blindly, and never through another
 * provider or number.
 */
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { keyFor } from "../../quo";
import type { SendResult } from "../messaging/provider";
import { recentMessages, sendMessage, type QuoFailure } from "./api";

/** Quo's clock and Selestial's can differ a little: a reply counts as newer only past this margin. */
const SKEW_MS = 5_000;

export type QuoClaim = { connectionId: Id<"quoConnections">; senderId: string; queuedAt: number; agentWritten: boolean; operational: boolean; to: string; body: string };

const RETRYABLE: readonly QuoFailure["kind"][] = ["rate_limited", "outage"];
const CONNECTION: readonly QuoFailure["kind"][] = ["key_rejected", "no_credits", "subscription_expired", "registration", "daily_cap", "opted_out", "rate_limited", "outage"];

export async function sendThroughQuo(ctx: ActionCtx, messageId: Id<"messages">, claim: QuoClaim): Promise<SendResult> {
  const found = await keyFor(ctx, claim.connectionId);
  if (!found) return { ok: false, retryable: false, problem: "The Quo connection's key isn't available. The Owner can reconnect Quo in Settings › Integrations." };
  if (found.connection.status !== "ready") return { ok: false, retryable: false, problem: found.connection.problem?.words ?? "The Quo connection isn't ready, so nothing was sent through it." };

  if (claim.agentWritten && !claim.operational) {
    const outgoing = await recentMessages(fetch, found.key, { numberId: claim.senderId, participant: claim.to, since: claim.queuedAt, direction: "outgoing" });
    if (!outgoing.ok) return checkFailed(ctx, claim, outgoing);
    const ours = await ctx.runQuery(internal.quoSend.ourIds, { messageId });
    if (outgoing.data.some((row) => !ours.includes(row.id))) {
      await ctx.runMutation(internal.quoSend.externalSeen, { messageId });
      return { ok: false, retryable: false, problem: "Someone answered this conversation from Quo after this was written, so it wasn't sent. Agents stepped back until a person returns the conversation to them." };
    }
    const incoming = await recentMessages(fetch, found.key, { numberId: claim.senderId, participant: claim.to, since: claim.queuedAt + SKEW_MS, direction: "incoming" });
    if (!incoming.ok) return checkFailed(ctx, claim, incoming);
    if (incoming.data.length > 0) return { ok: false, retryable: false, problem: "A newer reply arrived after this was written, so it wasn't sent. The agent reads the reply first." };
  }

  const sent = await sendMessage(fetch, found.key, { fromNumberId: claim.senderId, to: claim.to, text: claim.body });
  if (sent.ok) {
    await ctx.runMutation(internal.quo.afterSend, { messageId, providerConversationId: sent.data.conversationId });
    // 202 is Quo accepting it. "Delivered" comes only from Quo's delivery event.
    return { ok: true, providerMessageId: sent.data.id, delivered: sent.data.status === "delivered" };
  }
  if (sent.kind === "uncertain") return { ok: false, retryable: false, uncertain: true, problem: "Quo didn't answer, so it isn't known whether the text went. It is checked with Quo before anything is sent again." };
  if (CONNECTION.includes(sent.kind)) await ctx.runMutation(internal.quo.sendFailed, { connectionId: claim.connectionId, kind: sent.kind, words: sent.words, to: claim.to });
  return { ok: false, retryable: RETRYABLE.includes(sent.kind), problem: sent.words };
}

async function checkFailed(ctx: ActionCtx, claim: QuoClaim, failure: QuoFailure): Promise<SendResult> {
  if (CONNECTION.includes(failure.kind)) await ctx.runMutation(internal.quo.sendFailed, { connectionId: claim.connectionId, kind: failure.kind, words: failure.words, to: claim.to });
  // Without the recheck, an agent's reply is not sent: it is tried again later, when Quo can answer.
  return { ok: false, retryable: failure.kind === "rate_limited" || failure.kind === "outage" || failure.kind === "uncertain", problem: `Selestial couldn't check the conversation in Quo before sending: ${failure.words}` };
}
