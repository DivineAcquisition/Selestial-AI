/**
 * "Possibly hiring-related": mail outside what Recruiter reads by itself that might still be hiring mail
 * (lib/recruiter/boundary.ts). Nothing of it was opened. Its sender and subject are kept for 14 days so a
 * person can include it in recruiting, ignore it, or open it in Gmail; after that, or once ignored, only a
 * content-free id remains, so the same message is never filed twice.
 *
 * Including it is a person's choice for that one message: the body is then read the way any recruiting
 * message is, and nothing else from that sender is let through because of it.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { owned } from "./lib/access";
import { managerMutation, managerQuery } from "./lib/builders";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { ingestMessage, type IngestInput } from "./lib/recruiter/intake";
import { hiringModel } from "./lib/recruiter/model";
import { discoveryOf } from "./lib/recruiter/boundary";
import { openConnector, readMessage } from "./recruiterInbox";

/** Gmail's own page for a message, opened in the mailbox's account. Null for anything but Gmail. */
function gmailUrl(connection: Doc<"mailboxConnections">, messageId: string): string | null {
  if (connection.provider !== "gmail") return null;
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(connection.address)}#all/${encodeURIComponent(messageId)}`;
}

/** What is left of a message nobody included: its id and "unrelated", nothing about who sent it or what it said. */
const CLEARED = { classification: "unrelated" as const, fromAddress: undefined, replyTo: undefined, subject: undefined, reason: undefined, threadId: undefined, source: undefined, expiresAt: undefined, flag: undefined };

export const list = managerQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("sourceMessages")
      .withIndex("by_company_classification", (q) => q.eq("companyId", ctx.companyId).eq("classification", "possibly_hiring"))
      .order("desc")
      .take(100);
    const connections = new Map<string, Doc<"mailboxConnections"> | null>();
    const out = [];
    for (const row of rows) {
      if (row.decision || (row.expiresAt ?? 0) <= now) continue;
      if (!connections.has(row.connectionId)) connections.set(row.connectionId, await ctx.db.get(row.connectionId));
      const connection = connections.get(row.connectionId);
      if (!connection) continue;
      out.push({ sourceMessageId: row._id, from: row.fromAddress ?? null, subject: row.subject ?? null, why: row.reason ?? null, receivedAt: row.receivedAt, expiresAt: row.expiresAt!, mailbox: connection.address, openUrl: gmailUrl(connection, row.providerMessageId) });
    }
    return out;
  },
});

export const ignore = managerMutation({
  args: { sourceMessageId: v.id("sourceMessages") },
  handler: async (ctx, args) => {
    const row = await owned(ctx, args.sourceMessageId);
    if (row.classification !== "possibly_hiring" || row.decision) return null;
    await ctx.db.patch(row._id, { ...CLEARED, decision: { outcome: "ignored", by: ctx.member._id, at: Date.now() } });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "mailbox.possible_ignored", actor: byMember(ctx), subject: { table: "mailboxConnections", id: row.connectionId }, data: {} });
    return null;
  },
});

export const include = managerMutation({
  args: { sourceMessageId: v.id("sourceMessages") },
  handler: async (ctx, args) => {
    const row = await owned(ctx, args.sourceMessageId);
    if (row.classification !== "possibly_hiring" || row.decision) throw userError("This email was already handled.");
    const connection = await ctx.db.get(row.connectionId);
    if (!connection || connection.status === "disconnected") throw userError("The inbox this came from is no longer connected.");
    await ctx.db.patch(row._id, { decision: { outcome: "included", by: ctx.member._id, at: Date.now() } });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "mailbox.possible_included", actor: byMember(ctx), subject: { table: "mailboxConnections", id: row.connectionId }, data: {} });
    await ctx.scheduler.runAfter(0, internal.recruiterPossible.read, { sourceMessageId: row._id });
    return null;
  },
});

export const forRead = internalQuery({
  args: { sourceMessageId: v.id("sourceMessages") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.sourceMessageId);
    if (!row || row.decision?.outcome !== "included" || row.classification !== "possibly_hiring") return null;
    const connection = await ctx.db.get(row.connectionId);
    if (!connection || connection.status === "disconnected") return null;
    const members = await ctx.db
      .query("members")
      .withIndex("by_company", (q) => q.eq("companyId", connection.companyId))
      .take(200);
    return {
      connectionId: connection._id,
      provider: connection.provider,
      messageId: row.providerMessageId,
      source: row.source,
      scope: { address: connection.address, folder: connection.folder, after: 0, mode: discoveryOf(connection) },
      ours: [connection.address, ...members.map((member) => member.email)].map((value) => value.toLowerCase()),
    };
  },
});

/** Reads one included message, the way any recruiting message is read, then files it in place of the placeholder. */
export const read = internalAction({
  args: { sourceMessageId: v.id("sourceMessages") },
  handler: async (ctx, args) => {
    const start = await ctx.runQuery(internal.recruiterPossible.forRead, args);
    if (!start) return null;
    const opened = await openConnector(ctx, start.connectionId, start.provider);
    if ("failure" in opened) {
      await ctx.runMutation(internal.recruiterPossible.couldNotRead, { sourceMessageId: args.sourceMessageId });
      return null;
    }
    const message = await opened.connector.fetch(start.scope, start.messageId, { attachments: true }).catch(() => null);
    if (!message) {
      await ctx.runMutation(internal.recruiterPossible.couldNotRead, { sourceMessageId: args.sourceMessageId });
      return null;
    }
    const input = await readMessage(ctx, start.connectionId, hiringModel(), message, message, { classification: "new_application", source: start.source, reason: "Included by a person from the possibly hiring-related list." }, start.ours);
    // A person chose to include it: a reading that finds nothing still files it, as an inquiry for a person to look at.
    const filed: IngestInput = input.read ? input : { ...input, verdict: { ...input.verdict, classification: "employment_inquiry" }, read: { classification: "employment_inquiry", source: start.source ?? "direct", reason: "Included by a person.", addresses: [], forwarded: false, readBy: "rule" } };
    await ctx.runMutation(internal.recruiterPossible.file, { sourceMessageId: args.sourceMessageId, input: JSON.stringify(filed) });
    return null;
  },
});

export const file = internalMutation({
  args: { sourceMessageId: v.id("sourceMessages"), input: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.sourceMessageId);
    if (!row || row.decision?.outcome !== "included") return null;
    const connection = await ctx.db.get(row.connectionId);
    if (!connection) return null;
    // The placeholder goes; the message is filed as recruiting mail under the same id.
    await ctx.db.delete(row._id);
    await ingestMessage(ctx, connection, JSON.parse(args.input) as IngestInput);
    return null;
  },
});

export const couldNotRead = internalMutation({
  args: { sourceMessageId: v.id("sourceMessages") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.sourceMessageId);
    // Back on the list, so a person can try again or open it in Gmail.
    if (row && row.decision?.outcome === "included") await ctx.db.patch(row._id, { decision: undefined, flag: "Recruiter could not open this email. Try again, or open it in Gmail." });
    return null;
  },
});

/** Run on a schedule: what nobody decided on within 14 days keeps only its id. */
export const expire = internalMutation({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.db
      .query("sourceMessages")
      .withIndex("by_classification_expires", (q) => q.eq("classification", "possibly_hiring").lt("expiresAt", Date.now()))
      .take(500);
    for (const row of due) if (!row.decision) await ctx.db.patch(row._id, CLEARED);
    return due.length;
  },
});
