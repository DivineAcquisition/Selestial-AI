/**
 * Text conversations, whichever provider carries them (lib/quo/route.ts), and who answers each one.
 *
 * Every conversation has one owner at a time: the agents (each in its own workflow), a person, or the review
 * queue. Someone texting from the Quo app makes the agents step back on their own. A person takes over, pauses
 * agent replies, assigns it to a teammate, or returns it to the agents here; the send policy checks the owner
 * and the pause immediately before any agent's text goes (lib/messaging/policy.ts).
 *
 * A delivered text is not a business outcome: the thread shows "delivered" on the text and the record's own state
 * (an offer accepted, a booking made) separately.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { owned } from "./lib/access";
import { companyMutation, companyQuery, managerMutation, ownerMutation } from "./lib/builders";
import { recipientsAt } from "./lib/compliance/recipients";
import { userError } from "./lib/errors";
import { recordEvent } from "./lib/events";
import { queueMemberReply } from "./lib/messaging/outbox";
import { quoConnectionOf } from "./lib/quo/route";
import { messageState } from "./lib/messaging/lifecycle";
import { meteringOn } from "./lib/messagingBilling/ledger";
import { rateCardAt } from "./lib/messagingBilling/rates";


const ASSIGNMENT_WORDS: Record<string, string> = { offered: "Offer open", accepted: "Cleaner accepted the job", declined: "Cleaner declined", expired: "Offer expired", cancelled: "Offer withdrawn", completed: "Visit completed", in_progress: "Visit in progress" };

function ownerWords(owner: Doc<"smsConversations">["owner"], names: Map<string, string>): string {
  switch (owner.kind) {
    case "agents":
      return "Agents, each in its own workflow";
    case "member":
      return names.get(owner.memberId) ?? "A team member";
    case "external":
      return "Someone in the Quo app";
    case "review":
      return "Review queue";
  }
}

async function memberNames(ctx: QueryCtx, companyId: Id<"companies">) {
  const members = await ctx.db
    .query("members")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .take(500);
  return new Map(members.map((m) => [m._id as string, m.name]));
}

export const list = companyQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("smsConversations")
      .withIndex("by_company_activity", (q) => q.eq("companyId", ctx.companyId))
      .order("desc")
      .take(100);
    const names = await memberNames(ctx, ctx.companyId);
    const connection = await quoConnectionOf(ctx, ctx.companyId);
    const out = [];
    for (const row of rows) {
      const people = await recipientsAt(ctx, ctx.companyId, "sms", row.address);
      out.push({
        conversationId: row._id,
        address: row.address,
        people: people.map((p) => ({ kind: p.kind, name: p.name })),
        provider: row.provider,
        sender: row.sender,
        owner: row.owner.kind,
        ownerWords: ownerWords(row.owner, names),
        agentsPaused: row.agentsPausedAt !== undefined,
        lastInboundAt: row.lastInboundAt ?? null,
        lastOutboundAt: row.lastOutboundAt ?? null,
        blocked: row.provider === "quo" && (!connection || connection.status !== "ready") ? (connection?.problem?.words ?? (connection?.status === "disconnected" ? "Quo is disconnected, so nothing is sent in this conversation." : "The Quo connection isn't ready.")) : null,
      });
    }
    return out;
  },
});

export const thread = companyQuery({
  args: { conversationId: v.id("smsConversations") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.conversationId);
    if (!row || row.companyId !== ctx.companyId) return null;
    const names = await memberNames(ctx, ctx.companyId);
    const outbound = await ctx.db
      .query("messages")
      .withIndex("by_company_to", (q) => q.eq("companyId", ctx.companyId).eq("to", row.address))
      .order("desc")
      .take(100);
    const inbound = await ctx.db
      .query("smsInbound")
      .withIndex("by_conversation", (q) => q.eq("conversationId", row._id))
      .order("desc")
      .take(100);
    const items = [];
    for (const m of outbound) {
      if ((m.channel ?? "sms") !== "sms") continue;
      const assignment = m.assignmentId ? await ctx.db.get(m.assignmentId) : null;
      items.push({
        id: m._id as string,
        direction: "outgoing" as const,
        at: m.attemptedAt ?? m.queuedAt,
        body: m.body ?? "",
        provider: m.provider ?? null,
        by: m.agent ? `${m.agent[0].toUpperCase()}${m.agent.slice(1)} agent` : m.authorId ? (names.get(m.authorId) ?? "A team member") : "Selestial",
        status: m.status,
        statusWords: messageState(m).label,
        problem: m.problem ?? null,
        purpose: m.purpose,
        // The business outcome, kept apart from the text's delivery.
        outcome: assignment ? (ASSIGNMENT_WORDS[assignment.status] ?? assignment.status) : null,
      });
    }
    for (const m of inbound) items.push({ id: m._id as string, direction: "incoming" as const, at: m.receivedAt, body: m.body, provider: m.provider, by: null, status: null, statusWords: null, problem: null, purpose: null, outcome: null, routedTo: m.routedTo ?? null });
    items.sort((a, b) => a.at - b.at);
    const people = await recipientsAt(ctx, ctx.companyId, "sms", row.address);
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_company_key", (q) => q.eq("companyId", ctx.companyId).eq("key", `inbound.reply:${row.address}`))
      .take(5);
    const unknown = await ctx.db
      .query("tasks")
      .withIndex("by_company_key", (q) => q.eq("companyId", ctx.companyId).eq("key", `inbound.unknown:${row.address}`))
      .take(5);
    const connection = row.connectionId ? await ctx.db.get(row.connectionId) : null;
    return {
      conversationId: row._id,
      address: row.address,
      provider: row.provider,
      sender: row.sender,
      owner: row.owner,
      ownerWords: ownerWords(row.owner, names),
      ownerReason: row.ownerReason,
      ownerChangedAt: row.ownerChangedAt,
      agentsPaused: row.agentsPausedAt !== undefined,
      people: people.map((p) => ({ kind: p.kind, id: p.id, name: p.name })),
      openTasks: [...tasks, ...unknown].filter((t) => t.status !== "done" && t.status !== "cancelled").map((t) => ({ taskId: t._id, title: t.title, question: t.openQuestion ?? t.nextAction ?? null })),
      connection: row.provider === "quo" ? { status: connection?.status ?? "missing", problem: connection?.problem?.words ?? null } : null,
      items,
      me: ctx.member._id,
      // What a reply costs, per segment, from the company's messaging balance. Null when texts aren't metered on this
      // backend, or the conversation runs through the company's own Quo account (Quo bills those, not Selestial).
      pricePerSegment: meteringOn() && row.provider !== "quo" ? rateCardAt(Date.now()).rates.sms_out : null,
    };
  },
});

async function conversationOf(ctx: Parameters<typeof owned>[0], id: Id<"smsConversations">) {
  return owned(ctx, id);
}

/**
 * The other places a person can hold a conversation (a client's conversation, a Sales opportunity) follow
 * the Inbox: taking a conversation here holds the client's too, and returning it releases both, so agents
 * never answer in one place while a person has it in another.
 */
async function holdClients(ctx: MutationCtx & { member: Doc<"members">; companyId: Id<"companies"> }, address: string, held: boolean) {
  for (const row of await recipientsAt(ctx, ctx.companyId, "sms", address)) {
    if (row.kind !== "customer") continue;
    const customer = await ctx.db.get(row.id as Id<"customers">);
    if (!customer || customer.companyId !== ctx.companyId) continue;
    if (held && !customer.conversationHeld) await ctx.db.patch(customer._id, { conversationHeld: { by: ctx.member._id, since: Date.now() } });
    if (!held && customer.conversationHeld) await ctx.db.patch(customer._id, { conversationHeld: undefined });
  }
}

/**
 * A person on the team writes in the conversation, from the Inbox. It goes through the same sending policy as
 * every business text, and the person takes the conversation (agents stop writing in it until it's returned).
 * Anything that stops it is said in words on the message.
 */
export const reply = companyMutation({
  args: { conversationId: v.id("smsConversations"), body: v.string(), clientKey: v.string() },
  handler: async (ctx, args) => {
    const row = await conversationOf(ctx, args.conversationId);
    const body = args.body.trim();
    if (!body) throw userError("Write a message first.");
    if (body.length > 1500) throw userError("That message is too long for a text. Keep it under 1,500 characters.");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(args.clientKey)) throw userError("Something went wrong preparing that message. Reload and try again.");
    const people = await recipientsAt(ctx, ctx.companyId, "sms", row.address);
    const recipient = people.length === 1 ? { kind: people[0].kind, id: people[0].id } : undefined;
    if (row.owner.kind !== "member" || row.owner.memberId !== ctx.member._id) {
      await ctx.db.patch(row._id, { owner: { kind: "member", memberId: ctx.member._id }, ownerReason: `${ctx.member.name} replied from the Inbox.`, ownerChangedAt: Date.now(), ownerChangedBy: ctx.member._id });
      await holdClients(ctx, row.address, true);
    }
    const message = await queueMemberReply(ctx, { companyId: ctx.companyId, to: row.address, memberId: ctx.member._id, body, dedupeKey: `inbox:${row._id}:${args.clientKey}`, ...(recipient ? { recipient } : {}) });
    return { messageId: message._id, status: message.status, problem: message.problem ?? null };
  },
});

/** A person takes the conversation: agents don't write in it until it is returned. */
export const takeOver = companyMutation({
  args: { conversationId: v.id("smsConversations") },
  handler: async (ctx, args) => {
    const row = await conversationOf(ctx, args.conversationId);
    await ctx.db.patch(row._id, { owner: { kind: "member", memberId: ctx.member._id }, ownerReason: `${ctx.member.name} took over the conversation.`, ownerChangedAt: Date.now(), ownerChangedBy: ctx.member._id });
    await holdClients(ctx, row.address, true);
    await recordEvent(ctx, { companyId: ctx.companyId, type: "conversation.taken_over", actor: { kind: "member", memberId: ctx.member._id }, subject: { table: "companies", id: ctx.companyId } });
    return null;
  },
});

/** Pause or resume agent replies here, whoever owns it. Replies are still received and routed. */
export const pauseAgents = companyMutation({
  args: { conversationId: v.id("smsConversations"), paused: v.boolean() },
  handler: async (ctx, args) => {
    const row = await conversationOf(ctx, args.conversationId);
    await ctx.db.patch(row._id, { agentsPausedAt: args.paused ? Date.now() : undefined, ownerChangedBy: ctx.member._id });
    await recordEvent(ctx, { companyId: ctx.companyId, type: args.paused ? "conversation.agents_paused" : "conversation.agents_resumed", actor: { kind: "member", memberId: ctx.member._id }, subject: { table: "companies", id: ctx.companyId } });
    return null;
  },
});

export const assign = managerMutation({
  args: { conversationId: v.id("smsConversations"), memberId: v.id("members") },
  handler: async (ctx, args) => {
    const row = await conversationOf(ctx, args.conversationId);
    const member = await ctx.db.get(args.memberId);
    if (!member || member.companyId !== ctx.companyId || member.status !== "active") throw userError("Choose an active member of your team.");
    await ctx.db.patch(row._id, { owner: { kind: "member", memberId: member._id }, ownerReason: `${ctx.member.name} assigned it to ${member.name}.`, ownerChangedAt: Date.now(), ownerChangedBy: ctx.member._id });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "conversation.assigned", actor: { kind: "member", memberId: ctx.member._id }, subject: { table: "companies", id: ctx.companyId } });
    return null;
  },
});

/** Back to the agents, each in its own workflow, with agent replies resumed. */
export const returnToAgents = companyMutation({
  args: { conversationId: v.id("smsConversations") },
  handler: async (ctx, args) => {
    const row = await conversationOf(ctx, args.conversationId);
    await ctx.db.patch(row._id, { owner: { kind: "agents" }, agentsPausedAt: undefined, ownerReason: `${ctx.member.name} returned it to the agents.`, ownerChangedAt: Date.now(), ownerChangedBy: ctx.member._id });
    await holdClients(ctx, row.address, false);
    await recordEvent(ctx, { companyId: ctx.companyId, type: "conversation.returned_to_agents", actor: { kind: "member", memberId: ctx.member._id }, subject: { table: "companies", id: ctx.companyId } });
    return null;
  },
});

/**
 * Move a conversation to another number on purpose: the Owner's decision, never a fallback. Only to the company's own
 * Selestial number or one of its selected Quo numbers.
 */
export const changeRoute = ownerMutation({
  args: { conversationId: v.id("smsConversations"), to: v.union(v.object({ provider: v.literal("native") }), v.object({ provider: v.literal("quo"), senderId: v.string() })) },
  handler: async (ctx, args) => {
    const row = await conversationOf(ctx, args.conversationId);
    if (args.to.provider === "native") {
      const profile = await ctx.db
        .query("complianceProfiles")
        .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
        .first();
      const own = profile?.messaging.smsNumber;
      if (!own) throw userError("Your company doesn't have its own Selestial texting number.");
      await ctx.db.patch(row._id, { provider: "native", sender: own, connectionId: undefined, senderId: undefined, providerConversationId: undefined });
    } else {
      const connection = await quoConnectionOf(ctx, ctx.companyId);
      const number = connection?.selected.find((n) => n.id === (args.to as { senderId: string }).senderId);
      if (!connection || connection.status === "disconnected" || !number) throw userError("Choose one of your selected Quo numbers.");
      await ctx.db.patch(row._id, { provider: "quo", sender: number.phoneNumber, connectionId: connection._id, senderId: number.id, providerConversationId: undefined });
    }
    await recordEvent(ctx, { companyId: ctx.companyId, type: "conversation.route_changed", actor: { kind: "member", memberId: ctx.member._id }, subject: { table: "companies", id: ctx.companyId }, data: { provider: args.to.provider } });
    return null;
  },
});
