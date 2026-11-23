/**
 * Selestial-hosted signing: a signer opens their own link, reads the exact approved version, types their
 * name and agrees. The signature records the version and its hash, the words they agreed to, and when.
 * The request is completed through the same path an outside provider's report takes
 * (lib/agreements/signingStore.ts applyEvent), so every downstream step behaves the same.
 *
 * A staff note that terms were discussed never stands in for this.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { applyEvent } from "./lib/agreements/signingStore";
import { HOSTED } from "./lib/agreements/signing";
import { CONSENT, recordHostedSignature, signerState } from "./lib/agreements/hostedSign";
import { salesLinkMutation, salesLinkQuery } from "./lib/builders";
import { userError } from "./lib/errors";
import { optionalText } from "./lib/text";

export { CONSENT };

async function resolve(ctx: QueryCtx | MutationCtx, publicId: string) {
  const link = await ctx.db
    .query("agreementSigningLinks")
    .withIndex("by_publicId", (q) => q.eq("publicId", publicId))
    .unique();
  if (!link) return null;
  const request = await ctx.db.get(link.requestId);
  const agreement = await ctx.db.get(link.agreementId);
  const company = await ctx.db.get(link.companyId);
  if (!request || !agreement || !company) return null;
  return { link, request, agreement, company };
}

type Resolved = NonNullable<Awaited<ReturnType<typeof resolve>>>;

const state = (r: Resolved) => signerState(r);

export const view = salesLinkQuery({
  kind: "sign",
  resolve,
  args: {},
  handler: async (ctx) => {
    const r = ctx.link;
    if (!r) return null;
    const version = await ctx.db
      .query("agreementVersions")
      .withIndex("by_company_agreement_version", (q) => q.eq("companyId", r.request.companyId).eq("agreementId", r.request.agreementId).eq("version", r.request.version))
      .unique();
    // Only the version the request names is ever shown, and only if its text is unchanged.
    if (!version || version.hash !== r.request.hash) return { state: "closed" as const, company: r.company.name, title: r.agreement.title };
    return {
      state: state(r),
      company: r.company.name,
      title: r.agreement.title,
      markdown: version.markdown,
      version: version.version,
      hash: version.hash,
      signer: { name: r.link.signerName, email: r.link.signerEmail },
      signature: r.link.signature ? { typedName: r.link.signature.typedName, at: r.link.signature.at } : null,
      others: r.request.signers.filter((s) => s.email !== r.link.signerEmail).map((s) => ({ name: s.name, signed: s.status === "signed" })),
      expiresAt: r.request.expiresAt,
      consent: CONSENT,
    };
  },
});

/** Notes the first time the signer opened the document. Opening changes nothing else. */
export const opened = salesLinkMutation({
  kind: "sign",
  resolve,
  args: {},
  handler: async (ctx) => {
    const r = ctx.link as Resolved;
    if (r.link.viewedAt || state(r) !== "open") return null;
    await ctx.db.patch(r.link._id, { viewedAt: Date.now() });
    if (r.request.provider === HOSTED && r.request.providerRequestId) await applyEvent(ctx, HOSTED, { eventId: `viewed:${r.link._id}`, requestId: r.request.providerRequestId, type: "viewed", signerEmail: r.link.signerEmail, at: Date.now() });
    return null;
  },
});

export const signNow = salesLinkMutation({
  kind: "sign",
  resolve,
  args: { typedName: v.string(), hash: v.string(), agreed: v.boolean(), userAgent: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const result = await recordHostedSignature(ctx, ctx.link as Resolved, { ...args, via: "signing_link" });
    return { signed: true, already: result.already };
  },
});

export const decline = salesLinkMutation({
  kind: "sign",
  resolve,
  args: { reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const r = ctx.link as Resolved;
    if (r.link.signature || r.link.declined) return null;
    if (state(r) !== "open") throw userError("This document can no longer be answered here.");
    const at = Date.now();
    await ctx.db.patch(r.link._id, { declined: { at, reason: optionalText(args.reason, "Reason", 1000) } });
    if (r.request.providerRequestId) await applyEvent(ctx, HOSTED, { eventId: `declined:${r.link._id}`, requestId: r.request.providerRequestId, type: "declined", signerEmail: r.link.signerEmail, at });
    await ctx.scheduler.runAfter(0, internal.bookings.agreementChanged, { agreementId: r.agreement._id });
    return null;
  },
});

export type SignView = Doc<"agreementSigningLinks">;
