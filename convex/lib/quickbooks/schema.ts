/**
 * The QuickBooks Online connection (convex/quickbooks.ts): one per company, its sealed tokens, and the
 * one-time states that protect the sign-in round trip.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const QUICKBOOKS_STATUS = ["connected", "needs_reconnect", "disconnected"] as const;

export const quickbooksTables = {
  quickbooksConnections: defineTable({
    companyId: v.id("companies"),
    /** Intuit's id for the QuickBooks company (realmId). */
    realmId: v.string(),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    /** connected; needs_reconnect: Intuit ended the authorization; disconnected: the Owner (or Intuit) disconnected. */
    status: v.union(v.literal("connected"), v.literal("needs_reconnect"), v.literal("disconnected")),
    companyName: v.optional(v.string()),
    problem: v.optional(v.string()),
    connectedBy: v.id("members"),
    connectedAt: v.number(),
    lastRefreshAt: v.optional(v.number()),
    lastCheckedAt: v.optional(v.number()),
    /** When the refresh token stops working unless it is used before then. */
    refreshExpiresAt: v.optional(v.number()),
    disconnectedAt: v.optional(v.number()),
    /** The last error from QuickBooks, kept so it can be shown to the Owner and shared with Intuit support. */
    lastError: v.optional(
      v.object({
        at: v.number(),
        kind: v.string(),
        status: v.optional(v.number()),
        /** Intuit's request id (the intuit_tid response header). */
        intuitTid: v.optional(v.string()),
        message: v.string(),
      }),
    ),
  })
    .index("by_company", ["companyId"])
    .index("by_realm", ["realmId"])
    .index("by_status", ["status"]),

  /** The sealed tokens for one connection, bound to its id. Never sent to a browser and never exported. */
  quickbooksCredentials: defineTable({
    companyId: v.id("companies"),
    connectionId: v.id("quickbooksConnections"),
    sealedRefreshToken: v.string(),
    sealedAccessToken: v.string(),
    accessExpiresAt: v.number(),
    updatedAt: v.number(),
  }).index("by_connection", ["connectionId"]),

  /** Intuit's discovery document, as last read, so a mutation can build the sign-in address without a network call. */
  quickbooksDiscovery: defineTable({
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    authorization: v.string(),
    token: v.string(),
    revocation: v.string(),
    fetchedAt: v.number(),
  }).index("by_environment", ["environment"]),

  /** A sign-in in progress. Only the state's hash is kept; it is used once, within ten minutes. */
  quickbooksStates: defineTable({
    companyId: v.id("companies"),
    memberId: v.id("members"),
    stateHash: v.string(),
    returnOrigin: v.optional(v.string()),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  }).index("by_stateHash", ["stateHash"]),
};
