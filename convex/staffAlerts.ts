/**
 * Urgent alerts by text, for Selestial staff (docs/sms/00-architecture.md §1, "Internal alerts"). Each staff
 * member may confirm one phone of their own; critical incidents are then also texted to it from
 * Selestial's notice sender, next to the grouped email (convex/lib/operations/alerts.ts). A text names the
 * incident and its reference only: no company, customer, message or secret.
 *
 *   mine          this person's alert phone: last four digits, confirmed or not
 *   startPhone    texts a 6-digit code to the number (3 an hour); the code is kept only as a keyed hash
 *   confirmPhone  the code back (5 tries, 10 minutes): the number becomes the alert phone
 *   removePhone   stops alert texts to this person
 *   textCritical  internal: one text per batch per confirmed phone
 *
 * Confirming a phone grants nothing: it is not a sign-in method and approves no staff action.
 */
import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { staffMutation, staffQuery } from "./lib/builders";
import { userError } from "./lib/errors";
import { smsRoute } from "./lib/messagingBilling/routes";
import { normalAddress } from "./lib/compliance/recipients";
import { CHECK_WORDS, checkCode, CODE_TTL_MS, codeHash, sixDigits } from "./lib/platform/phoneCheck";
import { platformSender } from "./lib/platform/senders";
import { allow } from "./lib/rateLimit";
import { queueNoticeIn } from "./platformSms";

const HOUR = 60 * 60_000;

export const mine = staffQuery({
  args: {},
  handler: async (ctx) => ({
    phoneLast4: ctx.staff.alertPhone ? ctx.staff.alertPhone.slice(-4) : null,
    confirmedAt: ctx.staff.alertPhoneVerifiedAt ?? null,
    pending: ctx.staff.alertPhoneCheck && ctx.staff.alertPhoneCheck.expiresAt > Date.now() ? { last4: ctx.staff.alertPhoneCheck.phone.slice(-4), expiresAt: ctx.staff.alertPhoneCheck.expiresAt } : null,
    senderReady: platformSender("notices") !== null,
  }),
});

export const startPhone = staffMutation({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    const phone = normalAddress("sms", args.phone);
    if (!phone || !smsRoute(phone).ok) throw userError("Enter a US mobile number.");
    if (!platformSender("notices")) throw userError("Selestial's notice sender isn't set up yet, so alert texts can't be sent.");
    if (!(await allow(ctx, `staff-alert-code:${ctx.staff._id}`, 3, HOUR))) throw userError("Too many codes in the last hour. Try again later.");
    const code = sixDigits();
    const now = Date.now();
    await ctx.db.patch(ctx.staff._id, { alertPhoneCheck: { phone, codeHash: await codeHash(`staff:${ctx.staff._id}`, phone, code), expiresAt: now + CODE_TTL_MS, attempts: 0 } });
    await queueNoticeIn(ctx, { kind: "security_notice", reason: "staff alert phone check", dedupeKey: `staff-alert-code:${ctx.staff._id}:${now}`, to: phone, staffId: ctx.staff._id, body: `Selestial: ${code} is your code to confirm this phone for staff alerts. It expires in 10 minutes.`, transient: true });
    return { last4: phone.slice(-4), expiresAt: now + CODE_TTL_MS };
  },
});

export const confirmPhone = staffMutation({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const check = ctx.staff.alertPhoneCheck;
    const now = Date.now();
    const answer = await checkCode(`staff:${ctx.staff._id}`, check, args.code, now);
    if (answer !== "ok" || !check) {
      if (answer === "wrong" && check) await ctx.db.patch(ctx.staff._id, { alertPhoneCheck: { ...check, attempts: check.attempts + 1 } });
      throw userError(CHECK_WORDS[answer === "ok" ? "expired" : answer]);
    }
    await ctx.db.patch(ctx.staff._id, { alertPhone: check.phone, alertPhoneVerifiedAt: now, alertPhoneCheck: undefined });
    await ctx.db.insert("staffAudit", { by: ctx.staff._id, staffId: ctx.staff._id, kind: "alert_phone_set", at: now });
    return { last4: check.phone.slice(-4) };
  },
});

export const removePhone = staffMutation({
  args: {},
  handler: async (ctx) => {
    if (!ctx.staff.alertPhone && !ctx.staff.alertPhoneCheck) return { changed: false };
    await ctx.db.patch(ctx.staff._id, { alertPhone: undefined, alertPhoneVerifiedAt: undefined, alertPhoneCheck: undefined });
    await ctx.db.insert("staffAudit", { by: ctx.staff._id, staffId: ctx.staff._id, kind: "alert_phone_removed", at: Date.now() });
    return { changed: true };
  },
});

/** One text per alert batch per confirmed phone, for critical incidents only. */
export const textCritical = internalMutation({
  args: { key: v.string(), lines: v.array(v.object({ title: v.string(), reference: v.string() })) },
  handler: async (ctx, args) => {
    if (args.lines.length === 0) return { queued: 0 };
    const staff = (await ctx.db.query("staff").take(200)).filter((row) => row.status === "active" && (row.role === "admin" || row.role === "support") && row.alertPhone && row.alertPhoneVerifiedAt);
    const first = args.lines[0];
    const more = args.lines.length > 1 ? ` and ${args.lines.length - 1} more` : "";
    const body = `Selestial critical: ${first.title.slice(0, 80)} (${first.reference})${more}. Details in staff Operations.`;
    let queued = 0;
    for (const person of staff) {
      await queueNoticeIn(ctx, { kind: "internal_alert", reason: "critical incident", dedupeKey: `staff-alert:${args.key}:${person._id}`, to: person.alertPhone!, staffId: person._id, body });
      queued += 1;
    }
    return { queued };
  },
});
