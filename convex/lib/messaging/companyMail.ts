/**
 * How a company's email leaves through Selestial's shared sender (docs/email/06-branding.md): from the
 * company's own address on Selestial's verified sending domain, under its branded sender name
 * (convex/lib/email/senders.ts), set in its email branding, with a footer saying it was sent via Selestial
 * and why the person got it. The words are exactly what was written; nothing is added to them.
 *
 * Email that goes from the company's own connected Gmail doesn't come through here: it's sent as a
 * plain, threaded message from that inbox.
 */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { brandedCompanySender, companySender } from "../email/senders";
import { brandedLetter } from "../email/templates/company";
import { genericReplies, replyFor, versionForSend } from "../email/brandingStore";
import { readProfile } from "../compliance/profile";

/** Who the person is to the company, for the footer's "why you got this". */
function reasonFor(message: Doc<"messages">, company: string): string {
  if (message.applicationId) return `You're getting this because you applied to ${company}.`;
  if (message.cleanerId || message.portalLinkId || message.followUpId || message.purpose === "earnings_statement") return `You're getting this because you work with ${company}.`;
  if (message.invoiceId || message.customerId || message.bookingSessionId) return `You're getting this because you're a customer of ${company}.`;
  return `You're getting this because you were in touch with ${company}.`;
}

/** The names workflows put on company mail when nothing more particular was chosen. */
async function genericNames(ctx: MutationCtx, company: Doc<"companies">): Promise<Set<string>> {
  const booking = await ctx.db
    .query("bookingSettings")
    .withIndex("by_company", (q) => q.eq("companyId", company._id))
    .first();
  const texting = (await readProfile(ctx, company._id)).messaging.senderName;
  return new Set(["", company.name, texting, booking?.profile.displayName].filter((n): n is string => n !== undefined && n !== null).map((n) => n.trim().toLowerCase()));
}

/**
 * The From, Reply-To and HTML for a company email sent through Selestial, or why it can't go.
 *
 * The company's email branding (Settings › Email & texting › Email branding) is applied here, the one
 * place every such email passes: Sales, Recruiter, Retention, Quality, Finance, Booking, Cleaners and
 * messages a person writes. The branding version is settled on the first attempt and kept on the
 * message, so a retry renders the same email (convex/lib/email/brandingStore.ts).
 */
export async function companyEmail(ctx: MutationCtx, message: Doc<"messages">, input: { fromName: string; text: string }): Promise<{ ok: true; from: string; html: string; text: string; replyTo: string | undefined } | { ok: false; problem: string }> {
  const company = await ctx.db.get(message.companyId);
  if (!company) return { ok: false, problem: "The company no longer exists." };
  // Not configured: it waits with the reason. It never goes from another identity instead.
  const basic = companySender(company.name);
  if (!basic.ok) return { ok: false, problem: basic.words };
  const version = await versionForSend(ctx, message, company);
  const branding = version.branding;
  // A sender a workflow chose on purpose (Recruiter's "… Hiring Team") is kept. The generic names
  // workflows used before branding (the company's name, its texting name, its booking page name) give way
  // to the branded sender name.
  const sender = brandedCompanySender((await genericNames(ctx, company)).has(input.fromName.trim().toLowerCase()) ? branding.senderName : input.fromName, version.local);
  if (!sender.ok) return { ok: false, problem: sender.words };
  const test = message.purpose === "email_branding_test";
  const letter = brandedLetter({ branding, text: input.text, reason: test ? "You're getting this because you asked for a test of your email branding in Selestial." : reasonFor(message, branding.companyName), test });
  const replyTo = replyFor(message.replyTo, version.replyTo, await genericReplies(ctx, message.companyId));
  return { ok: true, from: sender.from, html: letter.html, text: letter.text, replyTo };
}
