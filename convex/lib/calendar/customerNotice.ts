/**
 * Telling a client their visit moved, through the same path as any message a person sends a client
 * (convex/clientConversations.ts): the client's own phone or email, the company's sending policy
 * (permission, quiet hours, a sender that is ready), and the same record of what was sent and why.
 *
 * The move is saved first. Whether the notice can go, and later whether it was delivered, is reported
 * separately: a notice that cannot go never undoes or hides a move that was made.
 */
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { intentFor, sendCheck, targetsOf, type Target } from "../clients/conversations";
import { readProfile } from "../compliance/profile";
import { recordEvent, type Actor } from "../events";
import { emailProvider } from "../messaging/email";
import { textingProvider } from "../quo/route";
import { clock, dayName } from "../time";

type Ctx = QueryCtx | MutationCtx;

export type NoticePlan =
  | { ready: true; channel: "sms" | "email"; to: string; name: string; target: Target; words: string }
  | { ready: false; channel: null; to: null; name: string; target: null; words: string };

/** Where the notice would go: a text to the client's own phone if the policy allows it now, else their email. */
export async function noticePlan(ctx: Ctx, customer: Doc<"customers">): Promise<NoticePlan> {
  const own = (await targetsOf(ctx, customer))[0];
  const reasons: string[] = [];
  for (const channel of ["sms", "email"] as const) {
    const to = own.address[channel];
    if (!to) continue;
    const answer = await sendCheck(ctx, customer, own, channel, "person");
    if (answer.ok) return { ready: true, channel, to, name: own.name, target: own, words: channel === "sms" ? `A text to ${own.name}` : `An email to ${own.name}` };
    reasons.push(answer.words);
  }
  return { ready: false, channel: null, to: null, name: own.name, target: null, words: reasons[0] ?? `${own.name} has no phone number or email on file.` };
}

export function noticeBody(company: Doc<"companies">, job: Pick<Doc<"jobs">, "serviceType" | "arrivalWindowMinutes">, from: number, to: number): string {
  const timezone = company.timezone;
  const window = job.arrivalWindowMinutes ? ` (arriving between ${clock(to, timezone)} and ${clock(to + job.arrivalWindowMinutes * 60_000, timezone)})` : "";
  return `${company.name}: your ${job.serviceType} visit on ${dayName(from, timezone)} at ${clock(from, timezone)} has moved to ${dayName(to, timezone)} at ${clock(to, timezone)}${window}. Reply to this message with any questions.`;
}

/** Queues the notice. Sending twice for the same move to the same time queues one message. */
export async function queueMoveNotice(ctx: MutationCtx, input: { company: Doc<"companies">; customer: Doc<"customers">; job: Doc<"jobs">; from: number; to: number; member: Doc<"members">; actor: Actor }): Promise<{ status: "queued" | "not_sent"; words: string; messageId: Id<"messages"> | null }> {
  const plan = await noticePlan(ctx, input.customer);
  if (!plan.ready) {
    await recordEvent(ctx, { companyId: input.company._id, type: "job.move_notice_not_sent", actor: input.actor, subject: { table: "jobs", id: input.job._id }, data: { reason: plan.words } });
    return { status: "not_sent", words: plan.words, messageId: null };
  }
  const dedupeKey = `calendar-move:${input.job._id}:${input.to}`;
  const existing = await ctx.db
    .query("messages")
    .withIndex("by_company_dedupe", (q) => q.eq("companyId", input.company._id).eq("dedupeKey", dedupeKey))
    .first();
  if (existing) return { status: "queued", words: plan.words, messageId: existing._id };
  const provider = plan.channel === "email" ? emailProvider() : await textingProvider(ctx, input.company._id, null);
  const replyTo = plan.channel === "email" ? ((await readProfile(ctx, input.company._id)).identity.supportEmail ?? undefined) : undefined;
  const now = Date.now();
  const messageId = await ctx.db.insert("messages", {
    companyId: input.company._id,
    purpose: "customer_message",
    channel: plan.channel,
    subject: plan.channel === "email" ? `Your visit with ${input.company.name} has moved` : undefined,
    replyTo,
    customerId: input.customer._id,
    authorId: input.member._id,
    draftedBy: "person",
    about: { table: "jobs", id: input.job._id, label: `${input.job.serviceType}, ${dayName(input.to, input.company.timezone)}` },
    jobId: input.job._id,
    to: plan.to,
    body: noticeBody(input.company, input.job, input.from, input.to),
    dedupeKey,
    status: "queued",
    attempts: 0,
    provider: provider?.name,
    queuedAt: now,
  });
  await ctx.db.insert("sendIntents", { companyId: input.company._id, messageId, channel: plan.channel, address: plan.to, at: now, ...intentFor(input.customer, plan.target, plan.channel, "person") });
  await recordEvent(ctx, { companyId: input.company._id, type: "message.queued", actor: input.actor, subject: { table: "messages", id: messageId }, data: { purpose: "customer_message", channel: plan.channel, customerId: input.customer._id, jobId: input.job._id } });
  await ctx.scheduler.runAfter(0, internal.messaging.deliver, { messageId });
  return { status: "queued", words: plan.words, messageId };
}
