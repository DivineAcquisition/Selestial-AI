/**
 * A person's own phone for Selestial's notices to them (My notifications). Confirmed with a code Selestial
 * texts from its code sender (convex/lib/platform/phoneCheck.ts); kept per sign-in, across every company the
 * person belongs to, because it is the same phone whichever company a notice is about.
 *
 *   mine     the confirmed phone's last four digits, and whether a code is waiting
 *   start    text a code to a US mobile number (3 an hour)
 *   confirm  the code back: the number becomes the person's notification phone
 *   remove   forget it: no more texts to it
 *
 * A confirmed phone grants nothing: it is not a sign-in method, joins no company, and approves nothing.
 */
import { v } from "convex/values";

import type { MutationCtx, QueryCtx } from "./_generated/server";
import { signedInMutation, signedInQuery } from "./lib/builders";
import { userError } from "./lib/errors";
import { normalAddress } from "./lib/compliance/recipients";
import { smsRoute } from "./lib/messagingBilling/routes";
import { CHECK_WORDS, checkCode, CODE_TTL_MS, codeHash, sixDigits } from "./lib/platform/phoneCheck";
import { platformSender } from "./lib/platform/senders";
import { allow } from "./lib/rateLimit";
import { queueNoticeIn } from "./platformSms";

const HOUR = 60 * 60 * 1000;

async function rowFor(ctx: QueryCtx | MutationCtx, userId: string) {
  return ctx.db
    .query("userPhones")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

export const mine = signedInQuery({
  args: {},
  handler: async (ctx) => {
    const row = await rowFor(ctx, ctx.userId);
    const now = Date.now();
    return {
      phoneLast4: row?.phone && row.verifiedAt ? row.phone.slice(-4) : null,
      confirmedAt: row?.verifiedAt ?? null,
      pending: row?.check && row.check.expiresAt > now ? { last4: row.check.phone.slice(-4), expiresAt: row.check.expiresAt } : null,
      // Codes go from Selestial's code sender; until it is set up, phones can't be confirmed.
      available: platformSender("codes") !== null,
    };
  },
});

export const start = signedInMutation({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    const phone = normalAddress("sms", args.phone);
    if (!phone || !smsRoute(phone).ok) throw userError("Enter a US mobile number.");
    if (!platformSender("codes")) throw userError("Texting codes isn't available yet. Try again later.");
    if (!(await allow(ctx, `my-phone-code:${ctx.userId}`, 3, HOUR))) throw userError("Too many codes in the last hour. Try again later.");
    const code = sixDigits();
    const now = Date.now();
    const check = { phone, codeHash: await codeHash(`user:${ctx.userId}`, phone, code), expiresAt: now + CODE_TTL_MS, attempts: 0 };
    const row = await rowFor(ctx, ctx.userId);
    if (row) await ctx.db.patch(row._id, { check, updatedAt: now });
    else await ctx.db.insert("userPhones", { userId: ctx.userId, check, updatedAt: now });
    await queueNoticeIn(ctx, { kind: "security_notice", sender: "codes", reason: "notification phone check", dedupeKey: `my-phone-code:${ctx.userId}:${now}`, to: phone, userId: ctx.userId, body: `Selestial: ${code} is your code to confirm this phone for your Selestial notifications. It expires in 10 minutes.`, transient: true });
    return { last4: phone.slice(-4), expiresAt: check.expiresAt };
  },
});

export const confirm = signedInMutation({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const row = await rowFor(ctx, ctx.userId);
    const now = Date.now();
    const answer = await checkCode(`user:${ctx.userId}`, row?.check, args.code, now);
    if (answer !== "ok") {
      if (answer === "wrong" && row?.check) await ctx.db.patch(row._id, { check: { ...row.check, attempts: row.check.attempts + 1 } });
      throw userError(CHECK_WORDS[answer]);
    }
    await ctx.db.patch(row!._id, { phone: row!.check!.phone, verifiedAt: now, check: undefined, updatedAt: now });
    return { last4: row!.check!.phone.slice(-4) };
  },
});

export const remove = signedInMutation({
  args: {},
  handler: async (ctx) => {
    const row = await rowFor(ctx, ctx.userId);
    if (!row) return { changed: false };
    await ctx.db.delete(row._id);
    return { changed: true };
  },
});
