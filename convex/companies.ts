import { v } from "convex/values";

import { internal } from "./_generated/api";

import { companyQuery, ownerMutation, signedInMutation, signedInQuery } from "./lib/builders";
import { AGENTS } from "./lib/statuses";
import { isTimezone } from "./lib/availability";
import { acceptTerms, NOT_CURRENT } from "./lib/compliance/agreements";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { roleOf } from "./lib/roles";
import { agentValidator } from "./lib/statuses";
import { applyPolicy } from "./lib/controls/policy";
import { text } from "./lib/text";
import { startSetup } from "./setup";
import { currentVersion } from "./lib/trust/documents";
import { reconnectAfterSignInMove } from "./lib/reconnect";

function timezone(value: string): string {
  const zone = value.trim();
  if (!isTimezone(zone)) throw userError("That is not a time zone. Enter the IANA name of your zone.");
  return zone;
}

/** A setup key is chosen by the browser, once for one setup. It only has to be hard to repeat by accident. */
function setupKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length < 8 || value.length > 80) throw userError("The setup key must be 8 to 80 characters.");
  return value;
}

/**
 * Whoever creates a company is its Owner. This is the only way an Owner comes to exist.
 *
 * With a setup key, the same person sending the same key again (a double click, a retry on a bad
 * connection) gets the company they already made and nothing new is created.
 */
export const create = signedInMutation({
  args: { name: v.string(), timezone: v.string(), setupKey: v.optional(v.string()), acceptTerms: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const key = setupKey(args.setupKey);
    if (key !== undefined) {
      const made = await ctx.db
        .query("companies")
        .withIndex("by_creator_setupKey", (q) => q.eq("createdBy", ctx.userId).eq("setupKey", key))
        .first();
      if (made) return made._id;
    }
    // The terms the creator agreed to on the setup screen must be the ones in force now.
    if (args.acceptTerms !== undefined && args.acceptTerms !== currentVersion("terms").id) throw userError(NOT_CURRENT);
    const now = Date.now();
    const companyId = await ctx.db.insert("companies", {
      name: text(args.name, "Company name", 160),
      timezone: timezone(args.timezone),
      pausedAgents: [],
      // A new company starts on the guided cleaner onboarding (lib/cleaners/settings.ts).
      cleaners: { startingTemplate: "guided" },
      createdBy: ctx.userId,
      ...(key !== undefined ? { setupKey: key } : {}),
      createdAt: now,
    });
    const memberId = await ctx.db.insert("members", { companyId, userId: ctx.userId, userIssuer: ctx.issuer, email: ctx.email, name: ctx.name, role: "owner", status: "active", createdAt: now });
    await recordEvent(ctx, { companyId, type: "company.created", actor: { kind: "member", memberId }, subject: { table: "companies", id: companyId } });
    // In the same transaction as the company, so a company never exists without the acceptance it was made with.
    if (args.acceptTerms !== undefined) await acceptTerms(ctx, { companyId, documentId: args.acceptTerms, memberId, userId: ctx.userId });
    // A new company starts in setup. Companies made before setup existed have no row and are never sent through it.
    await startSetup(ctx, companyId);
    return companyId;
  },
});

/**
 * After the sign-in service changes, a person's memberships still point at their old sign-in id. The app
 * calls this when someone signed in has no company, before offering to create one.
 */
export const reconnect = signedInMutation({
  args: {},
  handler: async (ctx) => ({ reconnected: await reconnectAfterSignInMove(ctx) }),
});

/** The companies the signed-in person belongs to. */
export const mine = signedInQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("members")
      .withIndex("by_user", (q) => q.eq("userId", ctx.userId))
      .take(50);
    const out: { companyId: string; name: string; role: string; locked: boolean; closing?: true }[] = [];
    for (const row of rows) {
      if (row.status !== "active") continue;
      const company = await ctx.db.get(row.companyId);
      // `locked`: the plan is unpaid after two failed payments (convex/billingLock.ts); the app shows the payment screen instead.
      // `closing`: Selestial is deleting the company (convex/companyDeletion.ts); the app shows its status instead.
      if (company) out.push({ companyId: company._id, name: company.name, role: roleOf(row.role), locked: company.billingLockedAt !== undefined, ...(company.closingAt !== undefined || company.deletedAt !== undefined ? { closing: true as const } : {}) });
    }
    return out;
  },
});

export const get = companyQuery({
  args: {},
  handler: async (ctx) => ({
    id: ctx.company._id,
    name: ctx.company.name,
    timezone: ctx.company.timezone,
    pausedAgents: ctx.company.pausedAgents,
    role: ctx.role,
  }),
});

export const update = ownerMutation({
  args: { name: v.optional(v.string()), timezone: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await ctx.db.patch(ctx.companyId, {
      ...(args.name !== undefined ? { name: text(args.name, "Company name", 160) } : {}),
      ...(args.timezone !== undefined ? { timezone: timezone(args.timezone) } : {}),
      // A change here is a change to the business settings, so a stale tab must not save over it.
      settingsRevision: (ctx.company.settingsRevision ?? 0) + 1,
    });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "company.updated", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId } });
    return null;
  },
});

/**
 * The owner can pause one agent or all of them (brief, section 7). The whole list form is kept for older
 * callers, but it now refuses to overwrite a newer change: pass `expectedRevision`, or use pauseAgent /
 * resumeAgent, which change one agent on the server's current list and can't undo someone else's change.
 */
export const setPausedAgents = ownerMutation({
  args: { agents: v.array(agentValidator), expectedRevision: v.optional(v.number()) },
  support: { capability: "agents.recover", summary: "paused agents" },
  handler: async (ctx, args) => {
    const pausedAgents = [...new Set(args.agents)];
    // Selestial Support may pause an agent to stop a problem spreading. Only the company resumes one.
    if (ctx.support && ctx.company.pausedAgents.some((agent) => !pausedAgents.includes(agent))) {
      throw userError("Only the company can resume an agent. Selestial Support can pause one.", "not_allowed");
    }
    const resuming = ctx.company.pausedAgents.some((agent) => !pausedAgents.includes(agent));
    await applyPolicy(ctx, ctx.company, { kind: resuming ? "resume" : "pause", summary: pausedAgents.length ? `Paused: ${pausedAgents.join(", ")}` : "Every agent resumed", paused: pausedAgents, expectedRevision: args.expectedRevision, by: ctx.member._id, actor: byMember(ctx) });
    return null;
  },
});

/**
 * Pauses one agent, at once, on the list as it stands on the server. It stops new work the agent would do
 * on its own; inbound texts, delivery reports, opt-outs and billing reconciliation keep working. Work a
 * provider already accepted can't be recalled. Pausing twice is harmless.
 */
export const pauseAgent = ownerMutation({
  args: { agent: agentValidator },
  support: { capability: "agents.recover", summary: "paused an agent" },
  handler: async (ctx, args) => {
    if (ctx.company.pausedAgents.includes(args.agent)) return { changed: false };
    await applyPolicy(ctx, ctx.company, { kind: "pause", summary: `Paused ${args.agent}`, paused: [...ctx.company.pausedAgents, args.agent], by: ctx.member._id, actor: byMember(ctx) });
    return { changed: true };
  },
});

/**
 * Resumes one agent. Nothing that was refused while it was paused is sent now (refusals are final), and
 * every piece of new work is checked again against the current settings as it runs.
 */
export const resumeAgent = ownerMutation({
  args: { agent: agentValidator },
  handler: async (ctx, args) => {
    if (!ctx.company.pausedAgents.includes(args.agent)) return { changed: false };
    await applyPolicy(ctx, ctx.company, { kind: "resume", summary: `Resumed ${args.agent}`, paused: ctx.company.pausedAgents.filter((agent) => agent !== args.agent), by: ctx.member._id, actor: byMember(ctx) });
    return { changed: true };
  },
});

/**
 * Pauses every outgoing text and email to the company's contacts, whoever prepared it: people, agents,
 * reminders. Nothing is refused or lost: each message waits, held with its words kept, and goes when the
 * Owner resumes. A person's own STOP, HELP or START is still answered, and incoming texts keep arriving.
 */
export const pauseMessaging = ownerMutation({
  args: { reason: v.optional(v.string()) },
  support: { capability: "agents.recover", summary: "paused the company's texting" },
  handler: async (ctx, args) => {
    if (ctx.company.messagingPause) return { changed: false };
    const reason = args.reason?.trim().slice(0, 300) || undefined;
    await ctx.db.patch(ctx.companyId, { messagingPause: { at: Date.now(), by: ctx.member._id, ...(reason ? { reason } : {}) } });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "messaging.paused", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: reason ? { reason } : {} });
    return { changed: true };
  },
});

/** Resumes texting. What waited for the pause is checked again and sent now, a few at a time. */
export const resumeMessaging = ownerMutation({
  args: {},
  handler: async (ctx) => {
    if (!ctx.company.messagingPause) return { changed: false, released: 0 };
    await ctx.db.patch(ctx.companyId, { messagingPause: undefined });
    const held = await ctx.db
      .query("messages")
      .withIndex("by_company_hold", (q) => q.eq("companyId", ctx.companyId).eq("holdReason", "messaging_paused"))
      .take(1000);
    let released = 0;
    for (const message of held) {
      if (message.status !== "held") continue;
      await ctx.db.patch(message._id, { status: "queued", holdReason: undefined });
      // Every message passes the whole sending policy again as it goes (quiet hours, STOP, funds).
      await ctx.scheduler.runAfter(released * 200, internal.messaging.deliver, { messageId: message._id });
      released += 1;
    }
    await recordEvent(ctx, { companyId: ctx.companyId, type: "messaging.resumed", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { released } });
    return { changed: true, released };
  },
});

/** Pauses every agent at once: the emergency stop. */
export const pauseAll = ownerMutation({
  args: {},
  support: { capability: "agents.recover", summary: "paused every agent" },
  handler: async (ctx) => {
    // Every agent there is, Quality included: the emergency stop must leave nothing sending on its own.
    const all = AGENTS;
    if (all.every((agent) => ctx.company.pausedAgents.includes(agent))) return { changed: false };
    await applyPolicy(ctx, ctx.company, { kind: "pause", summary: "Paused every agent", paused: [...new Set([...ctx.company.pausedAgents, ...all])], by: ctx.member._id, actor: byMember(ctx) });
    return { changed: true };
  },
});
