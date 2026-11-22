/**
 * Quo (formerly OpenPhone): a company's own business phone account, connected so Selestial's agents can text
 * through it (docs/quo/00-architecture.md). Selestial keeps the business context, decisions, approvals and
 * history; Quo carries the texts.
 *
 * Also the conversation record every text uses, whichever provider carries it: one row per company and
 * phone number, holding the route (provider and sending number, kept for the life of the conversation) and
 * who answers it (agents, a person, or a review queue).
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

import { literals } from "../statuses";

/** Not connected is the absence of a row. */
export const QUO_STATUSES = ["setup_incomplete", "ready", "degraded", "disconnected"] as const;
export type QuoStatus = (typeof QUO_STATUSES)[number];

/** The four agents that may be allowed to text through the connection. */
export const QUO_AGENTS = ["sales", "recruiter", "dispatch", "retention"] as const;

/** Why a connection cannot be used right now. Each has its own recovery step. */
export const QUO_PROBLEMS = ["key_rejected", "no_credits", "subscription_expired", "registration", "rate_limited", "outage", "webhook", "number_removed"] as const;
export type QuoProblem = (typeof QUO_PROBLEMS)[number];

export const CONVERSATION_PROVIDERS = ["native", "quo"] as const;
export type ConversationProvider = (typeof CONVERSATION_PROVIDERS)[number];

const numberValidator = v.object({
  /** Quo's phone number id (PN…). */
  id: v.string(),
  phoneNumber: v.string(),
  name: v.optional(v.string()),
  /** Quo's own messaging restriction for US texts, when it says. */
  usMessaging: v.optional(v.union(v.literal("restricted"), v.literal("unrestricted"))),
});

export const quoTables = {
  /** One per company. The API key and webhook secret are in quoSecrets, never on this row. */
  quoConnections: defineTable({
    companyId: v.id("companies"),
    status: literals(QUO_STATUSES),
    /** Quo's workspace id (orgId), learned from the first verified webhook or event. A rotated key must be the same workspace. */
    orgId: v.optional(v.string()),
    /** The last four characters of the key, so a person can tell which key is in use. */
    keyHint: v.string(),
    keySetAt: v.number(),
    keySetBy: v.id("members"),
    /** When the key was last checked against Quo, and what Quo answered. */
    checkedAt: v.optional(v.number()),
    /** The numbers the key can see, as of the last check. */
    available: v.array(numberValidator),
    /** The numbers Selestial may text from. The first is used for new conversations. */
    selected: v.array(numberValidator),
    /** Use this connection for new conversations. Existing conversations keep the number they started on. */
    useForNew: v.boolean(),
    /** Quo's carrier registration (A2P 10DLC), read from Quo. Quo reports it for the workspace, not per number. */
    registration: v.object({
      status: v.union(v.literal("approved"), v.literal("pending"), v.literal("rejected"), v.literal("failed"), v.literal("none"), v.literal("unknown")),
      checkedAt: v.optional(v.number()),
      /** The Owner confirmed registration themselves because Quo could not show it (a toll-free number, or no API answer). */
      confirmedBy: v.optional(v.id("members")),
      confirmedAt: v.optional(v.number()),
    }),
    webhook: v.optional(v.object({ id: v.string(), createdAt: v.number(), events: v.array(v.string()), lastEventAt: v.optional(v.number()) })),
    /** The Owner's explicit test text, and the reply that proves texts come back to Selestial. */
    test: v.optional(v.object({ to: v.string(), fromNumberId: v.string(), sentAt: v.number(), providerMessageId: v.optional(v.string()), problem: v.optional(v.string()), replyAt: v.optional(v.number()) })),
    replyVerifiedAt: v.optional(v.number()),
    /** The agents allowed to text through it. Nothing is allowed until the Owner chooses. */
    agents: v.array(literals(QUO_AGENTS)),
    /** The current problem, if any, and its recovery step. */
    problem: v.optional(v.object({ kind: literals(QUO_PROBLEMS), words: v.string(), at: v.number() })),
    /** Recent errors, newest last, never containing a secret. */
    errors: v.array(v.object({ at: v.number(), words: v.string() })),
    lastSendAt: v.optional(v.number()),
    disconnectedAt: v.optional(v.number()),
    disconnectedBy: v.optional(v.id("members")),
    updatedAt: v.number(),
  }).index("by_company", ["companyId"]),

  /** The connection's secrets, sealed (AES-GCM, bound to the connection). Read only by internal functions. */
  quoSecrets: defineTable({
    connectionId: v.id("quoConnections"),
    sealedKey: v.string(),
    sealedWebhookSecret: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_connection", ["connectionId"]),

  /**
   * One per company and phone number: the conversation, whichever provider carries it. Its route is kept for
   * the life of the conversation (a person changes it on purpose, never a failure), and its owner says who
   * may answer: the agents (each in its own workflow), a person, or the review queue.
   */
  smsConversations: defineTable({
    companyId: v.id("companies"),
    /** The other person's number, E.164. */
    address: v.string(),
    provider: literals(CONVERSATION_PROVIDERS),
    /** The company's number this conversation uses, E.164. */
    sender: v.string(),
    connectionId: v.optional(v.id("quoConnections")),
    /** Quo's phone number id for the sender. */
    senderId: v.optional(v.string()),
    /** Quo's conversation id, when known. */
    providerConversationId: v.optional(v.string()),
    owner: v.union(
      v.object({ kind: v.literal("agents") }),
      v.object({ kind: v.literal("member"), memberId: v.id("members") }),
      /** Someone answered from the Quo app, outside Selestial. Agents step back until a person returns it. */
      v.object({ kind: v.literal("external") }),
      v.object({ kind: v.literal("review") }),
    ),
    /** Agent replies are paused here, whoever owns it. */
    agentsPausedAt: v.optional(v.number()),
    ownerReason: v.string(),
    ownerChangedAt: v.number(),
    ownerChangedBy: v.optional(v.id("members")),
    lastInboundAt: v.optional(v.number()),
    lastOutboundAt: v.optional(v.number()),
    lastExternalAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_company_address", ["companyId", "address"])
    .index("by_company_activity", ["companyId", "lastInboundAt"]),

  /** Each text received, kept with its conversation so the thread is complete. An excerpt only, never media. */
  smsInbound: defineTable({
    companyId: v.id("companies"),
    conversationId: v.id("smsConversations"),
    provider: literals(CONVERSATION_PROVIDERS),
    providerMessageId: v.optional(v.string()),
    body: v.string(),
    receivedAt: v.number(),
    /** What Selestial did with it, in words. */
    routedTo: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId", "receivedAt"])
    .index("by_company_received", ["companyId", "receivedAt"]),
};
