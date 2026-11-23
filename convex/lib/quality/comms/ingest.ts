/**
 * Keeping what a phone platform reports, with its provenance, once.
 *
 * A call or text is kept by the provider's id: a duplicate or a late, out-of-order delivery updates the same
 * row. A transcript arrives after its call; a revised transcript replaces the stored one, counts a new
 * version and marks earlier readings stale. Content the provider later deletes is marked unavailable, and
 * what was read is kept with that mark. The company's own numbers are never a customer match.
 */
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordEvent } from "../../events";
import { normalAddress, recipientsAt } from "../../compliance/recipients";
import { clientsAtPhone } from "../../clients/conversations";
import { enqueueQualityRun } from "../runs";
import { SYSTEM, MINUTE, DAY } from "../words";
import type { HighLevelMessage, HighLevelSentence } from "./highlevel";
import type { QuoCall, QuoMessage, QuoTranscript } from "./quo";

type Connection = Doc<"qualityConnections">;
type Comm = Doc<"qualityComms">;

/** A transcript is re-checked a few times after a call: providers finish them minutes to hours later. */
export const RECHECK_MINUTES = [5, 20, 60, 180, 720];

async function hash(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let out = "";
  for (const b of digest.slice(0, 12)) out += b.toString(16).padStart(2, "0");
  return out;
}

function ownNumbers(connection: Connection): Set<string> {
  return new Set(connection.numbers.map((n) => normalAddress("sms", n.number)).filter((n): n is string => n !== null));
}

async function people(ctx: MutationCtx, companyId: Id<"companies">, counterpart: string | undefined, channel: "sms" | "email" = "sms"): Promise<{ customers: Id<"customers">[]; cleaners: Id<"cleaners">[] }> {
  if (!counterpart) return { customers: [], cleaners: [] };
  const found = await recipientsAt(ctx, companyId, channel, counterpart);
  const customers = channel === "sms" ? (await clientsAtPhone(ctx, companyId, counterpart)).map((c) => c.customerId) : found.filter((r) => r.kind === "customer").map((r) => r.id as Id<"customers">);
  const cleaners = found.filter((r) => r.kind === "cleaner").map((r) => r.id as Id<"cleaners">);
  return { customers: [...new Set(customers)], cleaners: [...new Set(cleaners)] };
}

async function existing(ctx: MutationCtx, connection: Connection, providerId: string): Promise<Comm | null> {
  return ctx.db
    .query("qualityComms")
    .withIndex("by_connection_provider_id", (q) => q.eq("connectionId", connection._id).eq("providerId", providerId))
    .first();
}

/** A call, from a webhook or a poll. Returns the row and whether it is new. Never reads before the connection's start. */
export async function ingestCall(ctx: MutationCtx, connection: Connection, call: QuoCall): Promise<{ comm: Comm; created: boolean } | null> {
  if (call.createdAt < connection.readFrom) return null;
  const own = ownNumbers(connection);
  const counterpart = call.participants.map((p) => normalAddress("sms", p)).find((p): p is string => p !== null && !own.has(p));
  const found = await existing(ctx, connection, call.id);
  const now = Date.now();
  const fields = {
    status: call.status,
    completedAt: call.completedAt,
    durationSec: call.duration,
    ...(call.summary ? { providerSummary: { status: call.summary.status, lines: call.summary.lines.slice(0, 20).map((l) => l.slice(0, 500)), nextSteps: call.summary.nextSteps.slice(0, 10).map((l) => l.slice(0, 300)), fetchedAt: now } } : {}),
  };
  if (found) {
    await ctx.db.patch(found._id, fields);
    return { comm: (await ctx.db.get(found._id))!, created: false };
  }
  const matched = await people(ctx, connection.companyId, counterpart);
  const answered = call.status === "completed" || (call.duration ?? 0) > 0;
  const id = await ctx.db.insert("qualityComms", {
    companyId: connection.companyId,
    connectionId: connection._id,
    provider: "quo",
    kind: call.status === "voicemail" ? "voicemail" : "call",
    providerId: call.id,
    phoneNumberId: call.phoneNumberId,
    direction: call.direction,
    counterpart,
    occurredAt: call.createdAt,
    ingestedAt: now,
    matchedCustomerIds: matched.customers,
    matchedCleanerIds: matched.cleaners,
    recheckAt: answered && connection.capabilities.readTranscripts !== "unavailable" ? now + RECHECK_MINUTES[0] * MINUTE : undefined,
    rechecks: 0,
    ...fields,
  });
  await recordEvent(ctx, { companyId: connection.companyId, type: "quality_comm.received", actor: SYSTEM, subject: { table: "qualityComms", id }, data: { kind: "call", direction: call.direction } });
  await enqueueQualityRun(ctx, { companyId: connection.companyId, kind: "message_received", key: `comm:${id}`, commId: id, historical: call.createdAt < connection.connectedAt });
  return { comm: (await ctx.db.get(id))!, created: true };
}

export async function ingestMessage(ctx: MutationCtx, connection: Connection, message: QuoMessage): Promise<{ comm: Comm; created: boolean } | null> {
  if (message.createdAt < connection.readFrom) return null;
  const own = ownNumbers(connection);
  const raw = message.direction === "incoming" ? [message.from] : message.to;
  const counterpart = raw.map((p) => normalAddress("sms", p)).find((p): p is string => p !== null && !own.has(p));
  const found = await existing(ctx, connection, message.id);
  if (found) return { comm: found, created: false };
  const matched = await people(ctx, connection.companyId, counterpart);
  const now = Date.now();
  const id = await ctx.db.insert("qualityComms", {
    companyId: connection.companyId,
    connectionId: connection._id,
    provider: "quo",
    kind: "sms",
    providerId: message.id,
    conversationId: message.conversationId,
    phoneNumberId: message.phoneNumberId,
    direction: message.direction,
    counterpart,
    occurredAt: message.createdAt,
    ingestedAt: now,
    body: message.text.slice(0, 1600),
    matchedCustomerIds: matched.customers,
    matchedCleanerIds: matched.cleaners,
    rechecks: 0,
  });
  await recordEvent(ctx, { companyId: connection.companyId, type: "quality_comm.received", actor: SYSTEM, subject: { table: "qualityComms", id }, data: { kind: "sms", direction: message.direction } });
  await enqueueQualityRun(ctx, { companyId: connection.companyId, kind: "message_received", key: `comm:${id}`, commId: id, historical: message.createdAt < connection.connectedAt });
  return { comm: (await ctx.db.get(id))!, created: true };
}

/** Who spoke, as far as the provider says. A line it could not attribute stays "unknown". */
export function speakerKind(connection: Connection, comm: Pick<Comm, "counterpart">, line: { identifier: string | null; actorId: string | null }): "company" | "external" | "unknown" {
  const own = ownNumbers(connection);
  if (line.actorId && /^(US|SYU)/.test(line.actorId)) return "company";
  const id = normalAddress("sms", line.identifier ?? undefined);
  if (id && own.has(id)) return "company";
  if (id && comm.counterpart && id === comm.counterpart) return "external";
  return "unknown";
}

/**
 * A transcript for a call, whenever it arrives. The same transcript again changes nothing; a revised one is
 * a new version and marks earlier readings stale. Several recordings are kept in order as one transcript.
 */
export async function applyTranscripts(ctx: MutationCtx, connection: Connection, comm: Comm, transcripts: QuoTranscript[]): Promise<"unchanged" | "pending" | "stored" | "revised" | "unavailable"> {
  const now = Date.now();
  const completed = transcripts.filter((t) => t.status === "completed");
  const pending = transcripts.some((t) => t.status === "in_progress");
  if (!completed.length) {
    const failed = transcripts.length > 0 && transcripts.every((t) => t.status === "failed" || t.status === "absent");
    const nextIndex = comm.rechecks + 1;
    const recheckAt = !failed && nextIndex < RECHECK_MINUTES.length ? now + RECHECK_MINUTES[nextIndex] * MINUTE : undefined;
    const state = pending ? "in_progress" : transcripts.length === 0 ? "absent" : failed ? (transcripts.some((t) => t.status === "failed") ? "failed" : "absent") : "in_progress";
    await ctx.db.patch(comm._id, { transcript: comm.transcript?.status === "completed" ? comm.transcript : { status: state, version: comm.transcript?.version ?? 0, segments: [], fetchedAt: now }, recheckAt, rechecks: nextIndex });
    return failed ? "unavailable" : "pending";
  }
  const segments = completed.flatMap((t) => t.dialogue.map((d) => ({ start: d.start, end: d.end, speaker: d.identifier ?? d.actorId ?? undefined, speakerKind: speakerKind(connection, comm, d), text: d.content.slice(0, 2000), recordingId: t.recordingId }))).slice(0, 600);
  const h = await hash(segments.map((s) => `${s.start}:${s.speaker ?? "?"}:${s.text}`).join("\n"));
  if (comm.transcript?.hash === h) {
    await ctx.db.patch(comm._id, { recheckAt: pending ? now + 60 * MINUTE : undefined });
    return "unchanged";
  }
  const revised = comm.transcript?.status === "completed";
  const version = (comm.transcript?.version ?? 0) + 1;
  await ctx.db.patch(comm._id, { transcript: { status: "completed", version, hash: h, segments, fetchedAt: now, revisedAt: revised ? now : undefined }, recheckAt: pending ? now + 60 * MINUTE : undefined });
  if (revised) {
    const extracts = await ctx.db.query("qualityExtracts").withIndex("by_company_comm", (q) => q.eq("companyId", comm.companyId).eq("commId", comm._id)).take(100);
    for (const e of extracts) if (e.version < version && e.state !== "rejected") await ctx.db.patch(e._id, { state: "stale" });
  }
  await enqueueQualityRun(ctx, { companyId: comm.companyId, kind: "transcript_available", key: `transcript:${comm._id}:${version}`, commId: comm._id, jobId: comm.jobId, historical: comm.occurredAt < connection.connectedAt });
  return revised ? "revised" : "stored";
}

export async function applySummary(ctx: MutationCtx, comm: Comm, summary: NonNullable<QuoCall["summary"]>): Promise<void> {
  await ctx.db.patch(comm._id, { providerSummary: { status: summary.status, lines: summary.lines.slice(0, 20).map((l) => l.slice(0, 500)), nextSteps: summary.nextSteps.slice(0, 10).map((l) => l.slice(0, 300)), fetchedAt: Date.now() } });
}

/** The content is gone at the provider. What was read stays, marked. */
export async function markUnavailable(ctx: MutationCtx, comm: Comm): Promise<void> {
  if (comm.unavailableAt === undefined) await ctx.db.patch(comm._id, { unavailableAt: Date.now(), recheckAt: undefined });
}

export const LOOKBACK = { visitsBefore: 14 * DAY, visitsAfter: 2 * DAY };

/**
 * A HighLevel text, email, call or voicemail, from its webhook or a poll, kept once by its message id. The
 * other side is the sender (incoming) or the recipient (outgoing); an email is matched by address, the rest by
 * phone. A call is re-checked a few times for its transcription. Never read before the connection's start.
 */
export async function ingestHighLevel(ctx: MutationCtx, connection: Connection, message: HighLevelMessage): Promise<{ comm: Comm; created: boolean } | null> {
  if (message.occurredAt < connection.readFrom || message.kind === "other") return null;
  const found = await existing(ctx, connection, message.id);
  if (found) {
    if (message.callDuration !== undefined || message.callStatus) await ctx.db.patch(found._id, { durationSec: message.callDuration ?? found.durationSec, status: message.callStatus ?? found.status });
    return { comm: found, created: false };
  }
  const channel = message.kind === "email" ? "email" : "sms";
  const raw = message.direction === "incoming" ? message.from : message.to;
  const counterpart = normalAddress(channel, raw) ?? undefined;
  const matched = await people(ctx, connection.companyId, counterpart, channel);
  const now = Date.now();
  const isCall = message.kind === "call" || message.kind === "voicemail";
  const id = await ctx.db.insert("qualityComms", {
    companyId: connection.companyId,
    connectionId: connection._id,
    provider: "highlevel",
    kind: message.kind === "voicemail" ? "voicemail" : message.kind,
    providerId: message.id,
    conversationId: message.conversationId,
    direction: message.direction,
    counterpart,
    status: message.callStatus,
    occurredAt: message.occurredAt,
    ingestedAt: now,
    durationSec: message.callDuration,
    ...(isCall ? {} : { body: `${message.subject ? `${message.subject}\n` : ""}${message.body}`.slice(0, message.kind === "email" ? 8000 : 1600) }),
    matchedCustomerIds: matched.customers,
    matchedCleanerIds: matched.cleaners,
    recheckAt: isCall && (message.callDuration ?? 0) > 0 && connection.capabilities.readTranscripts !== "unavailable" ? now + RECHECK_MINUTES[0] * MINUTE : undefined,
    rechecks: 0,
  });
  await recordEvent(ctx, { companyId: connection.companyId, type: "quality_comm.received", actor: SYSTEM, subject: { table: "qualityComms", id }, data: { kind: message.kind, direction: message.direction } });
  await enqueueQualityRun(ctx, { companyId: connection.companyId, kind: "message_received", key: `comm:${id}`, commId: id, historical: message.occurredAt < connection.connectedAt });
  return { comm: (await ctx.db.get(id))!, created: true };
}

/** HighLevel names no speaker, only a media channel: every line stays "speaker not identified". */
export async function applyHighLevelTranscription(ctx: MutationCtx, connection: Connection, comm: Comm, sentences: HighLevelSentence[]) {
  return applyTranscripts(ctx, connection, comm, [{ status: sentences.length ? "completed" : "in_progress", dialogue: sentences.map((s) => ({ content: s.text, start: s.start, end: s.end, identifier: null, actorId: null })) }]);
}
