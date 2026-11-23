/**
 * Quality reads calls, transcripts, summaries and incoming texts through the company's one Quo connection
 * (convex/quo.ts), never through a second key. Quo's events reach Selestial at /webhooks/quo/<connection>,
 * signed with that connection's secret and handled once (convex/quo.ts `ingest`); lib/quo/events.ts passes
 * them here after its own routing. Nothing here sends, records or changes anything at Quo.
 *
 * An event is read only while the Owner has Quality reading that connection (a `qualityConnections` row that
 * is not stopped) and "Read calls and texts from the connected phone platform" is on. Otherwise it is ignored.
 */
import type { Doc } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { qualitySettings } from "../settings";
import { applySummary, applyTranscripts, ingestCall, ingestMessage } from "./ingest";
import { parseQuoEvent } from "./quo";

/** Call events Quality asks Quo to send to the shared webhook, only while it reads calls. */
export const QUO_CALL_EVENTS = ["call.completed", "call.missed", "call.voicemail.completed", "call.transcript.completed", "call.summary.completed"] as const;

export async function qualityReaderFor(ctx: QueryCtx | MutationCtx, quo: Pick<Doc<"quoConnections">, "_id" | "companyId">): Promise<Doc<"qualityConnections"> | null> {
  const row = await ctx.db.query("qualityConnections").withIndex("by_quo_connection", (q) => q.eq("quoConnectionId", quo._id)).first();
  if (!row || row.status === "disconnected") return null;
  const company = await ctx.db.get(quo.companyId);
  return company && qualitySettings(company).readPhonePlatform ? row : null;
}

type RawEvent = { id?: string; type?: string; createdAt?: string; data?: { resource?: Record<string, unknown>; context?: Record<string, unknown>; links?: unknown } };

/**
 * One Quo event, already verified and deduplicated by the shared webhook. The connection's context (which
 * number, who sent it) is folded into the resource, so a call or text reads the same whichever way it came.
 */
export async function qualityOnQuoEvent(ctx: MutationCtx, quo: Doc<"quoConnections">, eventId: string, raw: RawEvent): Promise<string> {
  const reader = await qualityReaderFor(ctx, quo);
  if (!reader) return "quality is not reading";
  const resource = raw.data?.resource ?? {};
  const context = raw.data?.context ?? {};
  const merged = {
    ...resource,
    phoneNumberId: resource.phoneNumberId ?? context.phoneNumberId,
    from: resource.from ?? context.senderIdentifier,
    to: resource.to ?? context.recipientIdentifiers,
    conversationId: resource.conversationId ?? context.conversationId,
  };
  const event = parseQuoEvent(JSON.stringify({ id: raw.id ?? eventId, type: raw.type, createdAt: raw.createdAt, data: { resource: merged, links: raw.data?.links } }));
  if (!event) return "unreadable";
  // Only the numbers the Owner gave Selestial: another number's call is not this connection's to read.
  const selected = new Set(quo.selected.map((n) => n.id));
  if (event.kind === "call" && event.call.phoneNumberId && !selected.has(event.call.phoneNumberId)) return "not a selected number";
  if (event.kind === "call") return (await ingestCall(ctx, reader, event.call)) ? "call" : "before the start date";
  if (event.kind === "message") return event.message.direction === "incoming" && (await ingestMessage(ctx, reader, event.message)) ? "message" : "not read";
  const comm = event.kind === "transcript" || event.kind === "summary" ? await ctx.db.query("qualityComms").withIndex("by_connection_provider_id", (q) => q.eq("connectionId", reader._id).eq("providerId", event.callId)).first() : null;
  // A transcript can arrive before its call: the poll fetches the call and the transcript together later.
  if (!comm) return "call not seen yet";
  if (event.kind === "transcript") return applyTranscripts(ctx, reader, comm, [event.transcript]);
  if (event.kind === "summary") {
    await applySummary(ctx, comm, event.summary);
    return "summary";
  }
  return "ignored";
}
