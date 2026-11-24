/**
 * Selestial's own provider accounts, checked once an hour with a read-only call (docs/sms/00-architecture.md
 * §6, "a dead key fails silently"). Today: Telnyx. The answer is kept as an `opsSignals` row; the
 * `provider_health` operations check (convex/lib/operations/detectors.ts) turns it into an incident when the
 * key is refused, Telnyx doesn't answer, or the account is running out of money. Detectors never call a
 * provider themselves, so the call happens here and only its outcome is recorded.
 *
 *   probe   internal action, hourly: GET /v2/balance with the deployment's TELNYX_API_KEY
 *   record  internal mutation: keeps the answer, and only the last 14 days of answers
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { getBalance } from "./lib/messaging/telnyxAccount";

const DAY = 24 * 60 * 60 * 1000;
const KEEP = 14 * DAY;

export const probe = internalAction({
  args: {},
  handler: async (ctx) => {
    // Nothing to check where Telnyx isn't configured (a backend on the mock provider, for example).
    if (!process.env.TELNYX_API_KEY?.trim()) return null;
    const answer = await getBalance(fetch);
    if (answer.ok) {
      await ctx.runMutation(internal.providerHealth.record, { provider: "telnyx", outcome: "ok", detail: "Telnyx accepted the key.", ...(answer.value.units !== null ? { balanceUnits: answer.value.units } : {}) });
      return null;
    }
    const refused = answer.status === 401 || answer.status === 403;
    await ctx.runMutation(internal.providerHealth.record, { provider: "telnyx", outcome: refused ? "refused" : "unreachable", detail: answer.problem.slice(0, 300) });
    return null;
  },
});

export const record = internalMutation({
  args: { provider: v.literal("telnyx"), outcome: v.union(v.literal("ok"), v.literal("refused"), v.literal("unreachable")), detail: v.string(), balanceUnits: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("opsSignals", { kind: "provider_probe", source: args.provider, detail: args.detail, at: now, outcome: args.outcome, ...(args.balanceUnits !== undefined ? { balanceUnits: args.balanceUnits } : {}) });
    const old = await ctx.db
      .query("opsSignals")
      .withIndex("by_kind_at", (q) => q.eq("kind", "provider_probe").lt("at", now - KEEP))
      .take(100);
    for (const row of old) await ctx.db.delete(row._id);
    return null;
  },
});
