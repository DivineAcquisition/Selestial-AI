/**
 * Recording one signer's signature on a Selestial-hosted request. Both ways a signer reaches it go through
 * here: their own signing link (convex/sign.ts) and, for a worker, the onboarding step of their portal
 * (convex/onboarding.ts). The signature keeps the version and its hash, the exact consent words, the typed
 * name and the time; the request moves through the same path an outside provider's report takes, so a
 * signature is never recorded twice and a document whose text moved cannot be signed.
 */
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { userError } from "../errors";
import { recordEvent } from "../events";
import { optionalText, text } from "../text";
import { HOSTED } from "./signing";
import { applyEvent, isOpen } from "./signingStore";

export const CONSENT = "I have read this agreement, I agree to its terms, and I intend my typed name below to be my electronic signature. I agree to sign electronically.";

export type HostedSigner = { link: Doc<"agreementSigningLinks">; request: Doc<"agreementSignatureRequests">; agreement: Doc<"agreements"> };

export function signerState(r: HostedSigner, now = Date.now()): "open" | "signed" | "declined" | "expired" | "withdrawn" | "closed" {
  if (r.link.signature) return "signed";
  if (r.link.declined) return "declined";
  if (r.request.status === "expired" || r.request.expiresAt < now) return "expired";
  if (r.request.status === "withdrawn") return "withdrawn";
  return isOpen(r.request.status) ? "open" : "closed";
}

export async function recordHostedSignature(
  ctx: MutationCtx,
  r: HostedSigner,
  input: { typedName: string; hash: string; agreed: boolean; userAgent?: string; via: "signing_link" | "worker_portal" },
): Promise<{ signed: true; already: boolean; completed: boolean }> {
  // Signing twice from two tabs records one signature.
  if (r.link.signature) return { signed: true, already: true, completed: false };
  const now = signerState(r);
  if (now !== "open") throw userError(now === "expired" ? "This signing request has expired. Ask the company for a new one." : "This document can no longer be signed here.");
  if (!input.agreed) throw userError("Check the box to agree before signing.");
  if (input.hash !== r.request.hash) throw userError("The document changed since you opened it. Reload and read the current version.");
  const typed = text(input.typedName, "Your full name", 120);
  if (typed.replace(/[^a-z]/gi, "").length < 2) throw userError("Type your full name to sign.");
  if (r.request.provider !== HOSTED || !r.request.providerRequestId) throw userError("This document is signed through another service.");
  const at = Date.now();
  await ctx.db.patch(r.link._id, { signature: { typedName: typed, at, hash: r.request.hash, version: r.request.version, consent: CONSENT, userAgent: optionalText(input.userAgent, "Browser", 300) } });
  const result = await applyEvent(ctx, HOSTED, { eventId: `signed:${r.link._id}`, requestId: r.request.providerRequestId, type: "signed", signerEmail: r.link.signerEmail, at });
  await recordEvent(ctx, { companyId: r.request.companyId, type: "agreement.signer_signed", actor: { kind: "system" }, subject: { table: "agreements", id: r.agreement._id }, data: { version: r.request.version, via: input.via === "worker_portal" ? "worker_portal" : HOSTED } });
  if (result.completed) await ctx.scheduler.runAfter(0, internal.bookings.agreementChanged, { agreementId: r.agreement._id });
  return { signed: true, already: false, completed: Boolean(result.completed) };
}
