/**
 * Email & texting › Business texting (docs/sms/00-architecture.md §7, phase 4): where the company's texting
 * stands, its number and provider, which connection carries each agent's texts, what is blocking sending
 * and the next useful step, and how its texts fared this week.
 *
 *   overview  everything the panel shows, from real records only (convex/lib/texting/businessState.ts)
 *   sendTest  one controlled test text, through the same sending path as every business text, to the
 *             Owner's own confirmed phone only (convex/myPhone.ts), a few an hour
 */
import { companyQuery, ownerMutation } from "./lib/builders";
import { userError } from "./lib/errors";
import { readProfile } from "./lib/compliance/profile";
import { accountFor, billingState } from "./lib/billing/access";
import { meteringOn } from "./lib/messagingBilling/ledger";
import { messageState } from "./lib/messaging/lifecycle";
import { queueOwnerTest } from "./lib/messaging/outbox";
import { quoConnectionOf } from "./lib/quo/route";
import { allow } from "./lib/rateLimit";
import { blockersOf, nextActionOf, stateOf, STATE_WORDS, workflowRoutes, type StateInput } from "./lib/texting/businessState";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

async function inputFor(ctx: QueryCtx, companyId: Id<"companies">): Promise<StateInput> {
  const company = (await ctx.db.get(companyId))!;
  const request = await ctx.db
    .query("textingRequests")
    .withIndex("by_company_requested", (q) => q.eq("companyId", companyId))
    .order("desc")
    .first();
  const setup = await ctx.db
    .query("textingSetups")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .first();
  const profile = await readProfile(ctx, companyId);
  const quo = await quoConnectionOf(ctx, companyId);
  const billing = billingState();
  const account = meteringOn() && billing.connected ? await accountFor(ctx, companyId, billing.env) : null;
  return {
    request,
    setupStarted: setup !== null,
    messaging: profile.messaging,
    company,
    quo,
    outOfFunds: meteringOn() && account?.messaging !== undefined && account.messaging.remaining <= 0,
  };
}

export const overview = companyQuery({
  args: {},
  handler: async (ctx) => {
    const input = await inputFor(ctx, ctx.companyId);
    const state = stateOf(input);
    const blockers = blockersOf(input);
    const now = Date.now();
    // This week's texts, by what became of them. Read from the outbox; no message words.
    const week = await ctx.db
      .query("messages")
      .withIndex("by_company_queued", (q) => q.eq("companyId", ctx.companyId).gt("queuedAt", now - 7 * DAY))
      .take(2000);
    const counts = { delivered: 0, accepted: 0, waiting: 0, notConfirmed: 0, failed: 0, notSent: 0 };
    for (const message of week) {
      if ((message.channel ?? "sms") !== "sms" || message.purpose === "member_notice") continue;
      const key = messageState(message, now).key;
      if (key === "delivered") counts.delivered += 1;
      else if (key === "accepted") counts.accepted += 1;
      else if (key === "delivery_unknown" || key === "unconfirmed") counts.notConfirmed += 1;
      else if (key === "failed") counts.failed += 1;
      else if (key === "not_sent" || key === "suppressed" || key === "canceled") counts.notSent += 1;
      else counts.waiting += 1;
    }
    const quoReady = input.quo !== null && input.quo.status === "ready" && input.quo.selected.length > 0;
    return {
      state,
      ...STATE_WORDS[state],
      step: input.request?.step ?? null,
      number: input.messaging.registration.status === "approved" ? (input.messaging.smsNumber ?? null) : null,
      senderName: input.messaging.senderName ?? null,
      provider: { selestial: input.messaging.registration.status === "approved" && Boolean(input.messaging.smsNumber), quo: quoReady ? { numbers: input.quo!.selected.map((row) => row.phoneNumber), forNew: input.quo!.useForNew } : null },
      routes: workflowRoutes(input),
      blockers,
      next: nextActionOf(state, blockers),
      paused: input.company.messagingPause ? { at: input.company.messagingPause.at, reason: input.company.messagingPause.reason ?? null } : null,
      week: counts,
      canTest: state === "ready" && ctx.role === "owner",
    };
  },
});

/**
 * One test text to the Owner's own confirmed phone, through the same path as every business text: the
 * company's number, its profile, the policy and the provider. Never to anyone else, so it can't be used to
 * message a customer. Selestial pays for it.
 */
export const sendTest = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const userId = ctx.member.userId;
    const phone = userId
      ? await ctx.db
          .query("userPhones")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .first()
      : null;
    if (!phone?.phone || !phone.verifiedAt) throw userError("Confirm your own phone in My notifications first. Test texts only go to your own confirmed phone.");
    if (!(await allow(ctx, `texting-test:${ctx.companyId}`, 5, HOUR))) throw userError("You've sent 5 test texts in the last hour. Try again later.");
    const now = Date.now();
    const company = (await ctx.db.get(ctx.companyId))!;
    const message = await queueOwnerTest(ctx, { companyId: ctx.companyId, to: phone.phone, memberId: ctx.member._id, body: `${company.name}: this is a test text from your business number, sent from Selestial. No reply needed.`, dedupeKey: `texting-test:${now}` });
    return { messageId: message._id, status: message.status, problem: message.problem ?? null, last4: phone.phone.slice(-4) };
  },
});
