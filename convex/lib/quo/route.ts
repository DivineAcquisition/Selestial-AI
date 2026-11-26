/**
 * Which provider and number a text uses, and who may answer the conversation (docs/quo/00-architecture.md).
 *
 * Routing is deterministic and sticky:
 *  1. A conversation that already exists keeps its provider and number. Only an authorized person changes it.
 *  2. A new conversation uses the company's Quo connection when the Owner chose it for new conversations and
 *     a number is selected; otherwise the company's own Selestial number (Telnyx).
 *  3. A failure never moves a conversation to another provider or number. A blocked route is reported as
 *     blocked, with the reason, and nothing is sent.
 *
 * Ownership is the conversation's: the agents answer (each in its own workflow) unless a person took it over,
 * someone answered from the Quo app, it is in the review queue, or agent replies are paused here.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { normalAddress } from "../compliance/recipients";
import type { Category, Origin } from "../compliance/schema";
import type { Agent } from "../statuses";
import type { ConversationProvider } from "./schema";
import { messagingProvider } from "../messaging/provider";

type Ctx = QueryCtx | MutationCtx;

export type SmsRoute =
  | { kind: "native" }
  | { kind: "quo"; connection: Doc<"quoConnections"> | null; senderId: string; sender: string; sticky: boolean };

export async function quoConnectionOf(ctx: Ctx, companyId: Id<"companies">): Promise<Doc<"quoConnections"> | null> {
  return ctx.db
    .query("quoConnections")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .first();
}

export async function conversationAt(ctx: Ctx, companyId: Id<"companies">, address: string): Promise<Doc<"smsConversations"> | null> {
  const to = normalAddress("sms", address) ?? address;
  return ctx.db
    .query("smsConversations")
    .withIndex("by_company_address", (q) => q.eq("companyId", companyId).eq("address", to))
    .first();
}

/** The route a text to this number takes now. Never falls back from one provider to another. */
export async function smsRouteFor(ctx: Ctx, companyId: Id<"companies">, address: string): Promise<SmsRoute> {
  const conversation = await conversationAt(ctx, companyId, address);
  if (conversation) {
    if (conversation.provider === "native") return { kind: "native" };
    const connection = conversation.connectionId ? await ctx.db.get(conversation.connectionId) : null;
    // A connection that is gone (or not this company's) leaves the conversation where it is, reported blocked.
    return { kind: "quo", connection: connection && connection.companyId === companyId ? connection : null, senderId: conversation.senderId ?? "", sender: conversation.sender, sticky: true };
  }
  const connection = await quoConnectionOf(ctx, companyId);
  if (connection && connection.useForNew && connection.status !== "disconnected" && connection.selected.length > 0) {
    return { kind: "quo", connection, senderId: connection.selected[0].id, sender: connection.selected[0].phoneNumber, sticky: false };
  }
  return { kind: "native" };
}

const STATUS_WORDS: Record<Doc<"quoConnections">["status"], string> = {
  setup_incomplete: "The Quo connection's setup isn't finished, so texts through it wait.",
  ready: "",
  degraded: "The Quo connection has a problem, so texts through it wait.",
  disconnected: "The Quo connection was disconnected, so nothing is sent through it.",
};

/** Why a text cannot go through this Quo route now. Empty means it can. */
export function quoGaps(route: Extract<SmsRoute, { kind: "quo" }>, input: { origin: Origin; agent?: Agent }): string[] {
  const { connection } = route;
  if (!connection) return ["This conversation used a Quo connection that no longer exists. A person has to choose how to continue it."];
  const gaps: string[] = [];
  if (connection.status !== "ready") gaps.push(connection.problem ? `${STATUS_WORDS[connection.status]} ${connection.problem.words}` : STATUS_WORDS[connection.status]);
  if (!connection.selected.some((row) => row.id === route.senderId)) gaps.push(`${route.sender} is no longer one of the Quo numbers Selestial may use. A person has to choose how to continue this conversation.`);
  if (input.agent && AGENT_ORIGIN.includes(input.origin) && !(connection.agents as readonly string[]).includes(input.agent)) {
    gaps.push(`${AGENT_WORDS[input.agent]} isn't allowed to text through your Quo connection. The Owner can allow it in Settings › Integrations › Quo.`);
  }
  return gaps;
}

const AGENT_ORIGIN: readonly Origin[] = ["agent", "dispatch", "follow_up", "win_back", "recruiting"];
const AGENT_WORDS: Record<Agent, string> = { sales: "Sales", recruiter: "Recruiter", dispatch: "Dispatch", retention: "Retention", quality: "Quality", "customer-care": "Care" };

/**
 * Whether an automated send may go to this conversation given who owns it. Operational texts (a job offer, a
 * reminder, a confirmation) are standardized and still go; anything an agent writes in conversation waits for
 * the person who has it. A person's own send always goes.
 */
export function ownerBlocks(conversation: Doc<"smsConversations"> | null, input: { origin: Origin; agent?: Agent; category: Category }): string | null {
  if (!conversation || !input.agent || !AGENT_ORIGIN.includes(input.origin) || input.category === "operational") return null;
  if (conversation.agentsPausedAt !== undefined) return "Agent replies are paused in this conversation. A person can still send.";
  switch (conversation.owner.kind) {
    case "member":
      return "A person took over this conversation, so agents don't answer in it until it's returned.";
    case "external":
      return "Someone answered this conversation from Quo, so agents stepped back until a person returns it to them.";
    case "review":
      return "This conversation is waiting in the review queue for a person.";
    default:
      return null;
  }
}

/**
 * The conversation's row, created on its first text either way. Its route is fixed then; it changes only when an
 * authorized person moves it (convex/smsConversations.ts).
 */
export async function ensureConversation(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  address: string,
  route: { provider: ConversationProvider; sender: string; connectionId?: Id<"quoConnections">; senderId?: string; providerConversationId?: string },
): Promise<Doc<"smsConversations">> {
  const to = normalAddress("sms", address) ?? address;
  const existing = await conversationAt(ctx, companyId, to);
  if (existing) {
    if (route.providerConversationId && !existing.providerConversationId && existing.provider === route.provider) await ctx.db.patch(existing._id, { providerConversationId: route.providerConversationId });
    return (await ctx.db.get(existing._id))!;
  }
  const now = Date.now();
  const id = await ctx.db.insert("smsConversations", {
    companyId,
    address: to,
    provider: route.provider,
    sender: route.sender,
    connectionId: route.connectionId,
    senderId: route.senderId,
    providerConversationId: route.providerConversationId,
    owner: { kind: "agents" },
    ownerReason: "New conversation: agents answer in their own workflows.",
    ownerChangedAt: now,
    createdAt: now,
  });
  return (await ctx.db.get(id))!;
}

/**
 * The provider a text from this company would use: its Quo connection where the route says so, otherwise the
 * deployment's own provider. With no address, whether the company can text at all through either one.
 */
export async function textingProvider(ctx: Ctx, companyId: Id<"companies">, to?: string | null): Promise<{ name: string } | null> {
  if (to) {
    const route = await smsRouteFor(ctx, companyId, to);
    if (route.kind === "quo") return route.connection ? { name: "quo" } : null;
    return messagingProvider();
  }
  const own = messagingProvider();
  if (own) return own;
  const connection = await quoConnectionOf(ctx, companyId);
  return connection && connection.status !== "disconnected" ? { name: "quo" } : null;
}

/**
 * Why the company can't text new conversations yet, in words. A Quo connection that is ready and used for new
 * conversations answers for it; otherwise the company's own Selestial number's gaps (lib/messaging/policy.ts).
 */
export async function newConversationGaps(ctx: Ctx, companyId: Id<"companies">, nativeGaps: { key: string; words: string }[]): Promise<{ key: string; words: string }[]> {
  const connection = await quoConnectionOf(ctx, companyId);
  if (connection && connection.useForNew && connection.status !== "disconnected") {
    return connection.status === "ready" ? [] : [{ key: "quo", words: connection.problem?.words ?? "The Quo connection's setup isn't finished." }];
  }
  return nativeGaps;
}
