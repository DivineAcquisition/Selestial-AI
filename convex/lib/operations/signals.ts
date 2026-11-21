/**
 * Small facts a code path reports when no record of its own keeps them: an inbound text to a number no
 * company uses, a billing email that bypassed the outbox and failed. The monitor reads them
 * (convex/lib/operations/checks.ts). Never message text, never a full phone number or address.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

const KEEP_MS = 14 * 24 * 60 * 60_000;

export async function reportSignal(ctx: MutationCtx, signal: { companyId?: Id<"companies">; kind: "inbound_unknown_number" | "inbound_bad_number" | "notice_email_failed"; detail: string }) {
  const now = Date.now();
  await ctx.db.insert("opsSignals", { ...(signal.companyId ? { companyId: signal.companyId } : {}), kind: signal.kind, detail: signal.detail.slice(0, 200), at: now });
  // Bounded: the oldest signal of this kind past two weeks goes as a new one arrives.
  const old = await ctx.db
    .query("opsSignals")
    .withIndex("by_kind_at", (q) => q.eq("kind", signal.kind).lt("at", now - KEEP_MS))
    .take(5);
  for (const row of old) await ctx.db.delete(row._id);
}
