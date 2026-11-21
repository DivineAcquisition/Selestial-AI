/**
 * Admin support sessions (docs/operations/03-support-sessions.md): an authorized Selestial admin inside
 * one company's workspace, as themselves, for a short recorded time, with a reason.
 *
 * Policy (decided November 21, 2026): standing access, disclosed to owners under Settings › Support
 * access. Every session needs a reason; owners see each one; a switch to Manage emails the Owner, and a
 * session that changed anything ends with a summary email. The permission mechanism below does not depend
 * on that policy: an owner-granted policy would add one check to `start`.
 *
 * View is the default and refuses every write on the server. Manage needs workspace.manage, a reason and a
 * fresh sign-in with a second factor; even then each company function decides what support may do
 * (convex/lib/builders.ts `support` rules). Approvals are never decided by support.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { ownerQuery, staffMutation, staffQuery } from "./lib/builders";
import { notFound, userError } from "./lib/errors";
import { recordEvent } from "./lib/events";
import { notifyMembers } from "./lib/notify/route";
import { log } from "./lib/operations/engine";
import { roleValidator } from "./lib/roles";
import { capabilitiesOf, hasCapability } from "./lib/support/capabilities";
import { requireStrong, strongVerification } from "./lib/support/access";
import { SESSION_MINUTES, type SessionMode } from "./lib/support/schema";
import { text } from "./lib/text";

const MINUTE = 60_000;
export const SUPPORT_NAME = "Selestial Support";

/** The company's support row for this staff member: made once, reused by every later session. Never active. */
async function supportMember(ctx: MutationCtx, companyId: Id<"companies">, staff: Doc<"staff">): Promise<Id<"members">> {
  const rows = await ctx.db
    .query("members")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .take(500);
  const existing = rows.find((row) => row.status === "support" && row.supportStaffId === staff._id);
  if (existing) return existing._id;
  // No userId: the row can never be found as anyone's membership. Its name is what the company's activity shows.
  return ctx.db.insert("members", { companyId, email: "support@selestial.io", name: SUPPORT_NAME, role: "office", status: "support", supportStaffId: staff._id, createdAt: Date.now() });
}

async function mine(ctx: (QueryCtx | MutationCtx) & { staff: Doc<"staff"> }, sessionId: Id<"supportSessions">) {
  const session = await ctx.db.get(sessionId);
  if (!session || session.staffId !== ctx.staff._id) notFound();
  return session;
}

function live(session: Doc<"supportSessions">, now = Date.now()) {
  return session.endedAt === undefined && session.expiresAt > now;
}

async function action(ctx: MutationCtx, session: Doc<"supportSessions">, kind: Doc<"supportActions">["kind"], summary: string, detail?: string) {
  await ctx.db.insert("supportActions", { sessionId: session._id, companyId: session.companyId, staffId: session.staffId, kind, summary: summary.slice(0, 200), ...(detail ? { detail: detail.slice(0, 1000) } : {}), at: Date.now() });
}

/** Ends a session for good. Every request naming it is refused from this moment. */
async function end(ctx: MutationCtx, session: Doc<"supportSessions">, reason: NonNullable<Doc<"supportSessions">["endReason"]>) {
  if (session.endedAt !== undefined) return;
  const now = Date.now();
  await ctx.db.patch(session._id, { endedAt: now, endReason: reason });
  const words = { exited: "Ended by the admin", expired: "Expired", revoked: "Revoked", staff_removed: "Ended: the admin's staff access was removed" }[reason];
  await action(ctx, session, "ended", words);
  await recordEvent(ctx, { companyId: session.companyId, type: "support.session_ended", actor: { kind: "member", memberId: session.memberId }, subject: { table: "companies", id: session.companyId }, data: { mode: session.mode, changes: session.changes, reason } });
  if (session.changes > 0 && session.notified.summaryAt === undefined) {
    await ctx.db.patch(session._id, { notified: { ...session.notified, summaryAt: now } });
    await notifyMembers(ctx, { companyId: session.companyId, event: "support_session", ref: session._id, key: "summary", facts: { kind: "summary" }, now });
  }
}

// ── Staff ─────────────────────────────────────────────────────────────────────────────────────────

/** The company directory for "Open company workspace": names and operational state, nothing inside. */
export const companies = staffQuery({
  capability: "workspace.view",
  args: { search: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const search = args.search?.trim().toLowerCase() ?? "";
    const rows = (await ctx.db.query("companies").order("desc").take(1000)).filter((row) => !search || row.name.toLowerCase().includes(search) || row._id === search);
    return Promise.all(
      rows.slice(0, 100).map(async (row) => {
        const open = await ctx.db
          .query("incidents")
          .withIndex("by_company_open", (q) => q.eq("companyId", row._id).eq("open", true))
          .take(50);
        return {
          id: row._id,
          name: row.name,
          createdAt: row.createdAt,
          plan: row.plan ?? null,
          pausedAgents: row.pausedAgents,
          suspended: row.suspendedAt !== undefined,
          outboundStopped: row.outboundStop !== undefined,
          openIncidents: open.length,
          worst: open.reduce<string | null>((worst, inc) => (worst === null || ["critical", "high", "medium", "low"].indexOf(inc.severity) < ["critical", "high", "medium", "low"].indexOf(worst) ? inc.severity : worst), null),
        };
      }),
    );
  },
});

export const start = staffMutation({
  capability: "workspace.view",
  args: {
    companyId: v.id("companies"),
    reason: v.string(),
    reference: v.optional(v.string()),
    incidentId: v.optional(v.id("incidents")),
    minutes: v.optional(v.number()),
    previewRole: v.optional(roleValidator),
  },
  handler: async (ctx, args) => {
    if (ctx.staff._id === ("bootstrap" as Id<"staff">)) throw userError("Add yourself as staff first.");
    const company = await ctx.db.get(args.companyId);
    if (!company) notFound();
    const reason = text(args.reason, "The reason", 300);
    if (reason.length < 10) throw userError("Say why you need access, in a sentence. The owner sees it.");
    if (args.incidentId) {
      const incident = await ctx.db.get(args.incidentId);
      if (!incident || incident.companyId !== company._id) throw userError("That incident is for another company.");
    }
    const minutes = Math.min(Math.max(Math.round(args.minutes ?? SESSION_MINUTES.default), SESSION_MINUTES.min), SESSION_MINUTES.max);
    const now = Date.now();
    // One live session per admin and company: opening it again ends the earlier one.
    const earlier = await ctx.db
      .query("supportSessions")
      .withIndex("by_staff_started", (q) => q.eq("staffId", ctx.staff._id))
      .order("desc")
      .take(50);
    for (const row of earlier) if (row.companyId === company._id && live(row, now)) await end(ctx, row, "exited");
    const memberId = await supportMember(ctx, company._id, ctx.staff);
    const reference = args.reference?.trim() ? text(args.reference, "The reference", 80) : undefined;
    const sessionId = await ctx.db.insert("supportSessions", {
      companyId: company._id,
      staffId: ctx.staff._id,
      memberId,
      mode: "view",
      previewRole: args.previewRole ?? "owner",
      reason,
      ...(reference ? { reference } : {}),
      ...(args.incidentId ? { incidentId: args.incidentId } : {}),
      startedAt: now,
      expiresAt: now + minutes * MINUTE,
      changes: 0,
      notified: {},
    });
    const session = (await ctx.db.get(sessionId))!;
    await action(ctx, session, "started", `Opened the workspace (View) for ${minutes} minutes`, reason);
    await recordEvent(ctx, { companyId: company._id, type: "support.session_started", actor: { kind: "member", memberId }, subject: { table: "companies", id: company._id }, data: { mode: "view", minutes } });
    if (args.incidentId) await log(ctx, { incidentId: args.incidentId, companyId: company._id, kind: "staff_action", words: "Selestial Support opened your workspace to look into this.", detail: reason, actor: { kind: "staff", staffId: ctx.staff._id, sessionId } });
    await ctx.scheduler.runAt(session.expiresAt, internal.support.expire, { sessionId });
    return sessionId;
  },
});

/** What the banner shows. A session that ended still answers, so the tab can say so and go back. */
export const current = staffQuery({
  args: { sessionId: v.id("supportSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.staffId !== ctx.staff._id) return null;
    const company = await ctx.db.get(session.companyId);
    if (!company) return null;
    const now = Date.now();
    return {
      id: session._id,
      company: { id: company._id, name: company.name, timezone: company.timezone },
      mode: session.mode,
      previewRole: session.previewRole,
      reason: session.reason,
      reference: session.reference ?? null,
      incidentId: session.incidentId ?? null,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      ended: !live(session, now) || !hasCapability(ctx.staff, "workspace.view"),
      endReason: session.endReason ?? (session.expiresAt <= now ? "expired" : null),
      changes: session.changes,
      canManage: hasCapability(ctx.staff, "workspace.manage"),
      capabilities: [...capabilitiesOf(ctx.staff)],
    };
  },
});

/** Whether this sign-in is strong enough for Manage and sensitive actions right now. */
export const verification = staffQuery({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    return identity ? strongVerification(identity) : { ok: false as const, words: "Not signed in." };
  },
});

export const setMode = staffMutation({
  capability: "workspace.view",
  args: { sessionId: v.id("supportSessions"), mode: v.union(v.literal("view"), v.literal("manage")), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const session = await mine(ctx, args.sessionId);
    if (!live(session)) throw userError("This support session has ended.", "support_ended");
    if (session.mode === args.mode) return null;
    const now = Date.now();
    if (args.mode === "view") {
      await ctx.db.patch(session._id, { mode: "view" as SessionMode });
      await action(ctx, session, "mode", "Switched back to View");
      return null;
    }
    if (!hasCapability(ctx.staff, "workspace.manage")) throw userError("Your staff role can't manage workspaces. Ask a Selestial admin.", "not_allowed");
    const reason = text(args.reason ?? "", "Why you need Manage", 300);
    if (reason.length < 10) throw userError("Say what you need to change and why. The owner is emailed this.");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) notFound();
    requireStrong(identity);
    // Manage always acts as the Owner's screens would show; writes are still limited by each function's support rule.
    await ctx.db.patch(session._id, { mode: "manage", manageReason: reason, manageAt: now, verifiedAt: now, previewRole: "owner" });
    await action(ctx, session, "mode", "Switched to Manage", reason);
    await recordEvent(ctx, { companyId: session.companyId, type: "support.session_manage", actor: { kind: "member", memberId: session.memberId }, subject: { table: "companies", id: session.companyId }, data: { mode: "manage" } });
    if (session.notified.manageAt === undefined) {
      await ctx.db.patch(session._id, { notified: { ...session.notified, manageAt: now } });
      await notifyMembers(ctx, { companyId: session.companyId, event: "support_session", ref: session._id, key: "manage", facts: { kind: "manage" }, now });
    }
    if (session.incidentId) await log(ctx, { incidentId: session.incidentId, companyId: session.companyId, kind: "staff_action", words: "Selestial Support is making a correction in your workspace.", detail: reason, actor: { kind: "staff", staffId: ctx.staff._id, sessionId: session._id } });
    return null;
  },
});

/** "View as": see the workspace as an Owner, Manager or Office member would. It grants nothing. */
export const setPreview = staffMutation({
  capability: "workspace.view",
  args: { sessionId: v.id("supportSessions"), role: roleValidator },
  handler: async (ctx, args) => {
    const session = await mine(ctx, args.sessionId);
    if (!live(session)) throw userError("This support session has ended.", "support_ended");
    if (session.mode === "manage") throw userError("Switch back to View to preview another role.");
    await ctx.db.patch(session._id, { previewRole: args.role });
    await action(ctx, session, "mode", `Previewing as ${args.role}`);
    return null;
  },
});

export const exit = staffMutation({
  args: { sessionId: v.id("supportSessions") },
  handler: async (ctx, args) => {
    const session = await mine(ctx, args.sessionId);
    await end(ctx, session, "exited");
    return null;
  },
});

/** Pages opened in a session, for the record. Repeats of the same page within ten minutes are one entry. */
export const noteView = staffMutation({
  args: { sessionId: v.id("supportSessions"), label: v.string() },
  handler: async (ctx, args) => {
    const session = await mine(ctx, args.sessionId);
    if (!live(session)) return null;
    const summary = `Viewed ${text(args.label, "The page", 80)}`;
    const recent = await ctx.db
      .query("supportActions")
      .withIndex("by_session_at", (q) => q.eq("sessionId", session._id).gte("at", Date.now() - 10 * MINUTE))
      .take(100);
    if (recent.some((row) => row.kind === "viewed" && row.summary === summary)) return null;
    await action(ctx, session, "viewed", summary);
    return null;
  },
});

/** A change support tried and the server refused (a refusal rolls back its own transaction, so the tab reports it). */
export const noteRefusal = staffMutation({
  args: { sessionId: v.id("supportSessions"), words: v.string() },
  handler: async (ctx, args) => {
    const session = await mine(ctx, args.sessionId);
    await action(ctx, session, "refused", `Refused: ${text(args.words, "What was refused", 200)}`);
    return null;
  },
});

export const expire = internalMutation({
  args: { sessionId: v.id("supportSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.endedAt !== undefined) return null;
    if (session.expiresAt > Date.now()) {
      await ctx.scheduler.runAt(session.expiresAt, internal.support.expire, { sessionId: session._id });
      return null;
    }
    await end(ctx, session, "expired");
    return null;
  },
});

/** Ends every live session a staff member holds (called when their access is removed or narrowed). */
export async function endSessionsOf(ctx: MutationCtx, staffId: Id<"staff">, reason: "staff_removed" | "revoked") {
  const rows = await ctx.db
    .query("supportSessions")
    .withIndex("by_staff_started", (q) => q.eq("staffId", staffId))
    .order("desc")
    .take(100);
  for (const row of rows) if (row.endedAt === undefined) await end(ctx, row, reason);
}

/** Recent sessions across companies, for staff: who, where, why, and what changed. */
export const sessions = staffQuery({
  capability: "operations.view",
  args: { companyId: v.optional(v.id("companies")) },
  handler: async (ctx, args) => {
    const rows = args.companyId
      ? await ctx.db
          .query("supportSessions")
          .withIndex("by_company_started", (q) => q.eq("companyId", args.companyId!))
          .order("desc")
          .take(50)
      : await ctx.db
          .query("supportSessions")
          .withIndex("by_started")
          .order("desc")
          .take(50);
    const now = Date.now();
    return Promise.all(
      rows.map(async (row) => ({
        id: row._id,
        company: (await ctx.db.get(row.companyId))?.name ?? "A company",
        companyId: row.companyId,
        staff: (await ctx.db.get(row.staffId))?.name ?? "Staff",
        mine: row.staffId === ctx.staff._id,
        mode: row.mode,
        reason: row.reason,
        reference: row.reference ?? null,
        startedAt: row.startedAt,
        expiresAt: row.expiresAt,
        endedAt: row.endedAt ?? null,
        endReason: row.endReason ?? null,
        live: live(row, now),
        changes: row.changes,
      })),
    );
  },
});

export const sessionActions = staffQuery({
  capability: "operations.view",
  args: { sessionId: v.id("supportSessions") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("supportActions")
      .withIndex("by_session_at", (q) => q.eq("sessionId", args.sessionId))
      .take(300);
    return rows.map((row) => ({ id: row._id, at: row.at, kind: row.kind, summary: row.summary, detail: row.detail ?? null, capability: row.capability ?? null }));
  },
});

// ── Owners ────────────────────────────────────────────────────────────────────────────────────────

/** Settings › Support access: when Selestial entered the workspace, why, how, and what it changed. */
export const history = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("supportSessions")
      .withIndex("by_company_started", (q) => q.eq("companyId", ctx.companyId))
      .order("desc")
      .take(50);
    const now = Date.now();
    return Promise.all(
      rows.map(async (row) => {
        const actions = await ctx.db
          .query("supportActions")
          .withIndex("by_session_at", (q) => q.eq("sessionId", row._id))
          .take(300);
        return {
          id: row._id,
          startedAt: row.startedAt,
          endedAt: row.endedAt ?? (row.expiresAt <= now ? row.expiresAt : null),
          live: live(row, now),
          mode: row.mode,
          everManaged: row.manageAt !== undefined,
          reason: row.reason,
          manageReason: row.manageReason ?? null,
          reference: row.reference ?? null,
          changes: actions.filter((a) => a.kind === "changed" || a.kind === "external").map((a) => ({ at: a.at, summary: a.summary, detail: a.detail ?? null })),
          viewed: actions.filter((a) => a.kind === "viewed").length,
        };
      }),
    );
  },
});
