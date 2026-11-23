/**
 * Recruiter's findings, for the screens: what it found, the message it prepared, and what became of it.
 *
 * Sending is the person's own choice, made beside the full message (recipient, channel, purpose, text,
 * link, limitation): there is no second approval step. Every check runs again when it goes
 * (lib/recruiter/act.ts). Owners and Managers may send; the Office role sees but does not send.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { owned } from "./lib/access";
import { companyQuery, managerMutation } from "./lib/builders";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { carryOut, type ActResult } from "./lib/recruiter/act";
import { refresh } from "./lib/recruiter/findings";
import { OPEN_FINDING } from "./lib/recruiter/schema";

const SOURCE: Record<string, string> = { indeed: "Indeed", ziprecruiter: "ZipRecruiter", direct: "Email", manual: "Added by hand", other: "Another site" };

/** The message as the applicant will read it, with the link shown as a placeholder. */
function preview(body: string): string {
  return body.replace(/\{link\}/g, "[your application link]");
}

async function shape(ctx: QueryCtx, row: Doc<"recruiterFindings">) {
  const application = await ctx.db.get(row.applicationId);
  const applicant = await ctx.db.get(row.applicantId);
  const need = application?.needId ? await ctx.db.get(application.needId) : null;
  const message = row.messageId ? await ctx.db.get(row.messageId) : null;
  return {
    findingId: row._id,
    applicationId: row.applicationId,
    kind: row.kind,
    status: row.status,
    name: applicant?.redactedAt ? null : (applicant?.name ?? null),
    role: need?.title ?? application?.roleSeen ?? null,
    source: application ? (SOURCE[application.source] ?? "Email") : null,
    stage: application?.stage ?? null,
    headline: row.headline,
    explanation: row.explanation,
    reported: row.reported,
    missing: row.missing,
    next: row.next,
    prepared: row.prepared ? { kind: row.prepared.kind, channel: row.prepared.channel, to: row.prepared.to, toKind: row.prepared.toKind, subject: row.prepared.subject, body: row.prepared.body, preview: preview(row.prepared.body), link: row.prepared.link, reason: row.prepared.reason, limitation: row.prepared.limitation ?? null, writtenBy: row.prepared.writtenBy } : null,
    scheduledFor: row.scheduledFor ?? null,
    outcome: row.outcome ?? null,
    automatic: row.automatic ?? false,
    // What the email service said, kept apart from what was planned: accepted is not delivered.
    delivery: message ? { status: message.status, deliveredAt: message.deliveredAt ?? null, bouncedAt: message.bouncedAt ?? null } : null,
    discoveredAt: row.discoveredAt,
    updatedAt: row.updatedAt,
  };
}

export type FindingView = Awaited<ReturnType<typeof shape>>;

/** Open findings (newest first) and recent outcomes. */
export const list = companyQuery({
  args: { outcomesSince: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const open: Doc<"recruiterFindings">[] = [];
    for (const status of OPEN_FINDING) {
      open.push(
        ...(await ctx.db
          .query("recruiterFindings")
          .withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", status))
          .order("desc")
          .take(200)),
      );
    }
    const since = args.outcomesSince ?? 0;
    const recent = await ctx.db
      .query("recruiterFindings")
      .withIndex("by_company_updated", (q) => q.eq("companyId", ctx.companyId).gt("updatedAt", since))
      .order("desc")
      .take(150);
    const outcomes = recent.filter((row) => row.status === "sent" || row.status === "sending" || (row.status === "done" && row.by !== undefined) || row.status === "dismissed").slice(0, 40);
    const views = [];
    for (const row of open.sort((a, b) => b.updatedAt - a.updatedAt)) views.push(await shape(ctx, row));
    const done = [];
    for (const row of outcomes) done.push(await shape(ctx, row));
    return { open: views, outcomes: done };
  },
});

/** Every finding for one application, newest first: the prepared step and what was done before. */
export const forApplication = companyQuery({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    await owned(ctx, args.applicationId);
    const rows = await ctx.db
      .query("recruiterFindings")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .order("desc")
      .take(30);
    const out = [];
    for (const row of rows) if (row.status !== "expired") out.push(await shape(ctx, row));
    return out;
  },
});

const editValidator = v.optional(v.object({ subject: v.string(), body: v.string() }));

async function ownFinding(ctx: Parameters<typeof owned>[0], findingId: Id<"recruiterFindings">) {
  return owned(ctx, findingId);
}

/** Sends one prepared message, as written or as edited. The person's click is the authorization. */
export const send = managerMutation({
  args: { findingId: v.id("recruiterFindings"), edit: editValidator },
  handler: async (ctx, args): Promise<ActResult> => {
    const finding = await ownFinding(ctx, args.findingId);
    return carryOut(ctx, finding, byMember(ctx), args.edit);
  },
});

/**
 * Sends several prepared messages a person has looked at together. Each one is checked again on its own,
 * so one that changed is skipped and the rest still go.
 */
export const sendMany = managerMutation({
  args: { findingIds: v.array(v.id("recruiterFindings")) },
  handler: async (ctx, args): Promise<ActResult[]> => {
    if (args.findingIds.length > 50) throw userError("Send at most 50 at a time.");
    const out: ActResult[] = [];
    for (const id of [...new Set(args.findingIds)]) {
      const finding = await ownFinding(ctx, id);
      out.push(await carryOut(ctx, finding, byMember(ctx)));
    }
    return out;
  },
});

/** Keeps a person's own words on a prepared message without sending it. */
export const saveDraft = managerMutation({
  args: { findingId: v.id("recruiterFindings"), subject: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const finding = await ownFinding(ctx, args.findingId);
    if (!OPEN_FINDING.includes(finding.status) || !finding.prepared) throw userError("This can no longer be changed.");
    const body = args.body.replace(/\r\n/g, "\n").slice(0, 5000);
    await ctx.db.patch(finding._id, { prepared: { ...finding.prepared, subject: args.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 200), body, writtenBy: "person" }, status: body.trim() && finding.status === "needs_attention" && finding.prepared.kind === "question_reply" ? "ready" : finding.status, updatedAt: Date.now() });
    return null;
  },
});

/** Not doing this one. Nothing is sent; it comes back only if the facts change. */
export const dismiss = managerMutation({
  args: { findingId: v.id("recruiterFindings") },
  handler: async (ctx, args) => {
    const finding = await ownFinding(ctx, args.findingId);
    if (!OPEN_FINDING.includes(finding.status)) return null;
    await ctx.db.patch(finding._id, { status: "dismissed", by: ctx.member._id, outcome: `Dismissed by ${ctx.member.name}.`, updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "finding.dismissed", actor: byMember(ctx), subject: { table: "applications", id: finding.applicationId }, data: { kind: finding.kind } });
    return null;
  },
});

/** Brings one application's finding up to date now (the screens call this when one is opened). */
export const refreshOne = managerMutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    await owned(ctx, args.applicationId);
    await refresh(ctx, args.applicationId);
    return null;
  },
});
