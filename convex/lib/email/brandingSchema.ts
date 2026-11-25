/**
 * Email branding's records (docs/email/06-branding.md).
 *
 *   emailBranding          one per company: what the Owner chose, its revision, and the reply address
 *   emailSenderAddresses   one per company, unique across all companies: its own address on Selestial's
 *                          shared sending domain. Assigned once and never reassigned.
 *   emailBrandingVersions  what a send used, never edited. Each email through Selestial points at one,
 *                          so a retry renders exactly as the first attempt did.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

const layout = v.union(v.literal("classic"), v.literal("banner"), v.literal("letter"));
const header = v.union(v.literal("light"), v.literal("dark"));
const align = v.union(v.literal("left"), v.literal("center"));

export const signatureValidator = v.object({
  include: v.boolean(),
  name: v.optional(v.string()),
  closing: v.optional(v.string()),
  phone: v.optional(v.string()),
  website: v.optional(v.string()),
  address: v.optional(v.string()),
  supportEmail: v.optional(v.string()),
  showAddress: v.boolean(),
});

/** What the page edits and saves. A missing value means the company's own detail is used. */
export const brandingChoicesValidator = v.object({
  senderName: v.optional(v.string()),
  logoSource: v.union(v.literal("company"), v.literal("custom"), v.literal("none")),
  logo: v.optional(v.id("_storage")),
  accent: v.optional(v.string()),
  button: v.optional(v.string()),
  header,
  layout,
  logoAlign: align,
  signature: signatureValidator,
});

export const resolvedBrandingValidator = v.object({
  companyName: v.string(),
  senderName: v.string(),
  logoUrl: v.union(v.string(), v.null()),
  accent: v.string(),
  button: v.string(),
  header,
  layout,
  logoAlign: align,
  signature: v.object({
    include: v.boolean(),
    name: v.union(v.string(), v.null()),
    closing: v.union(v.string(), v.null()),
    phone: v.union(v.string(), v.null()),
    website: v.union(v.string(), v.null()),
    supportEmail: v.union(v.string(), v.null()),
  }),
  address: v.union(v.string(), v.null()),
});

export const emailBrandingTables = {
  emailBranding: defineTable({
    companyId: v.id("companies"),
    /** Counts saves, so a stale tab can't overwrite a newer save. */
    revision: v.number(),
    choices: brandingChoicesValidator,
    /** The verified address replies go to. Stays in use until a replacement is verified. */
    reply: v.optional(v.object({ address: v.string(), verifiedAt: v.number(), verifiedBy: v.id("members"), how: v.union(v.literal("code"), v.literal("sign_in"), v.literal("connected_inbox")) })),
    /** A replacement waiting for its code. Only the code's hash is kept. */
    pendingReply: v.optional(
      v.object({
        address: v.string(),
        codeHash: v.string(),
        expiresAt: v.number(),
        attempts: v.number(),
        requestedBy: v.id("members"),
        requestedAt: v.number(),
        /** What became of the email carrying the code. */
        delivery: v.union(v.literal("queued"), v.literal("sent"), v.literal("failed")),
        problem: v.optional(v.string()),
      }),
    ),
    updatedBy: v.optional(v.id("members")),
    updatedAt: v.optional(v.number()),
  }).index("by_company", ["companyId"]),

  emailSenderAddresses: defineTable({
    companyId: v.id("companies"),
    /** The part before the @. Unique across every company. */
    local: v.string(),
    createdAt: v.number(),
  })
    .index("by_local", ["local"])
    .index("by_company", ["companyId"]),

  emailBrandingVersions: defineTable({
    companyId: v.id("companies"),
    /** Names the content, so the same branding is stored once however many messages use it. */
    hash: v.string(),
    branding: resolvedBrandingValidator,
    /** The sending address's local part and the verified reply address, as they were. */
    local: v.string(),
    replyTo: v.union(v.string(), v.null()),
    /** The settings revision it came from; 0 means the company's own details with nothing saved. */
    revision: v.number(),
    createdAt: v.number(),
  }).index("by_company_hash", ["companyId", "hash"]),
};
