/**
 * Selestial's own texts (docs/sms/00-architecture.md §4.1, §4.6): sign-in codes Clerk asks Selestial to
 * deliver, security and account notices to the people who use Selestial, and alerts to Selestial staff.
 * They belong to no company: they are never in a company's records, exports or erasure, never charged to a
 * company's messaging balance, and never sent from a company's number. What Telnyx charged is kept as
 * Selestial's own spend.
 *
 *  platformMessages  one text from Selestial's code sender or notice sender, and what became of it
 *
 * A sign-in code's words are never stored: they travel only in the call that sends them. The destination
 * is kept as a keyed hash (for limits) and its last four digits (for people reading the record); a
 * notice's full number is kept only until the text is settled.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const PLATFORM_KINDS = ["auth_code", "security_notice", "account_notice", "internal_alert", "no_reply_answer"] as const;
export type PlatformKind = (typeof PLATFORM_KINDS)[number];
export const platformKindValidator = v.union(...PLATFORM_KINDS.map((kind) => v.literal(kind)));

export const PLATFORM_SENDERS = ["codes", "notices"] as const;
export type PlatformSender = (typeof PLATFORM_SENDERS)[number];

export const platformStatusValidator = v.union(v.literal("queued"), v.literal("sending"), v.literal("sent"), v.literal("delivered"), v.literal("failed"), v.literal("unconfirmed"), v.literal("not_sent"));

export const platformTables = {
  platformMessages: defineTable({
    kind: platformKindValidator,
    sender: v.union(v.literal("codes"), v.literal("notices")),
    /** What asked for it: a Clerk template slug (verification code, reset), a security event, an incident. */
    reason: v.string(),
    /** One text per request: Clerk's webhook delivery id, or the notice's own key. */
    dedupeKey: v.string(),
    /** The Clerk user it is for, when known. Never a company membership. */
    userId: v.optional(v.string()),
    staffId: v.optional(v.id("staff")),
    /** Keyed hash of the destination (for limits) and its last four digits. */
    toKey: v.string(),
    toLast4: v.string(),
    /** A notice's number, kept only until it settles. Never set for a sign-in code. */
    to: v.optional(v.string()),
    /** A notice's words. Never set for a sign-in code. */
    body: v.optional(v.string()),
    segments: v.optional(v.number()),
    status: platformStatusValidator,
    /** Why it was not sent: a limit, a sender that isn't ready, an unsupported number. */
    refusal: v.optional(v.string()),
    problem: v.optional(v.string()),
    attempts: v.number(),
    provider: v.optional(v.string()),
    providerMessageId: v.optional(v.string()),
    /** What Telnyx charged Selestial for it, in units of $0.0001. Selestial's own spend, never a company's. */
    providerCost: v.optional(v.number()),
    queuedAt: v.number(),
    sentAt: v.optional(v.number()),
    deliveredAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
    deliveryUnconfirmedAt: v.optional(v.number()),
  })
    .index("by_dedupe", ["dedupeKey"])
    .index("by_provider_message", ["provider", "providerMessageId"])
    .index("by_kind_queued", ["kind", "queuedAt"])
    .index("by_to_queued", ["toKey", "queuedAt"])
    .index("by_status_queued", ["status", "queuedAt"]),
};
