/**
 * The company's public application pages (docs/recruiter/09-application-builder.md): /apply/<handle> lists
 * the roles anyone may apply for, and /apply/<handle>/<role> starts an application. The page shows only
 * what is meant for every visitor: the company's public name and brand, and the role as the Owner wrote it.
 *
 * Starting goes through Selestial's own server (serverMutation), which adds a keyed hash of the visitor's
 * network address for rate limits. A start makes a new applicant and application and answers with the
 * applicant's private link, so the rest of the form is the same page an emailed invitation opens.
 *
 * Typing an address never opens someone else's application: when that address already has an open
 * application for the role, the link to continue is emailed to that address instead, and the visitor is
 * told only to check their email.
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { bookingSettingsOf } from "./lib/booking/settings";
import { isClosing, publicQuery, serverMutation } from "./lib/builders";
import { linksConfigured, tokenFor } from "./lib/dispatch/links";
import { userError } from "./lib/errors";
import { recordEvent, type Actor } from "./lib/events";
import { allow } from "./lib/rateLimit";
import { isActive } from "./lib/recruiter/applications";
import { grantApplicationEmail } from "./lib/recruiter/consent";
import { formForNeed, presentation } from "./lib/recruiter/forms";
import { issueApplicantLink, liveApplicantLink } from "./lib/recruiter/links";
import { queueApplicantMessage, sendProblem } from "./lib/recruiter/outbox";
import { DAY, recruiterSettings } from "./lib/recruiter/settings";
import { partsFor, resumeEmail } from "./lib/recruiter/words";
import { email, text } from "./lib/text";

const SYSTEM: Actor = { kind: "system" };
const WHERE = "typed by the applicant on the public application page";
const CHECK_EMAIL = "Thanks. If this email address already has an application with us, we've sent it a link to continue. Check your inbox.";

async function companyAt(ctx: QueryCtx, handle: string): Promise<Doc<"companies"> | null> {
  const settings = await ctx.db
    .query("bookingSettings")
    .withIndex("by_handle", (q) => q.eq("handle", handle.trim().toLowerCase()))
    .unique();
  const company = settings ? await ctx.db.get(settings.companyId) : null;
  if (!company || company.suspendedAt || isClosing(company)) return null;
  return company;
}

async function roleAt(ctx: QueryCtx, company: Doc<"companies">, slug: string): Promise<Doc<"hiringNeeds"> | null> {
  const need = await ctx.db
    .query("hiringNeeds")
    .withIndex("by_company_slug", (q) => q.eq("companyId", company._id).eq("slug", slug.trim().toLowerCase()))
    .first();
  return need && need.status === "open" && need.publicApply === true ? need : null;
}

async function brand(ctx: QueryCtx, company: Doc<"companies">) {
  const settings = await bookingSettingsOf(ctx, company);
  return { name: settings.profile.displayName || company.name, brandColor: settings.profile.brandColor, logoUrl: settings.profile.logo ? await ctx.storage.getUrl(settings.profile.logo) : null, website: settings.profile.website ?? null };
}

const roleCard = (need: Doc<"hiringNeeds">) => ({ slug: need.slug!, title: need.title, location: need.location, engagement: need.engagement, summary: need.responsibilities.slice(0, 280), availability: need.requiredAvailability.slice(0, 200) });

/** The careers page: the company's public name and the roles open to anyone. Null for an unknown address. */
export const careers = publicQuery({
  args: { handle: v.string() },
  handler: async (ctx, args) => {
    const company = await companyAt(ctx, args.handle);
    if (!company) return null;
    const open = await ctx.db
      .query("hiringNeeds")
      .withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", "open"))
      .take(100);
    return { company: await brand(ctx, company), roles: open.filter((need) => need.publicApply === true && need.slug).map(roleCard) };
  },
});

/** One role's page, before anyone starts. Null when the role isn't open to the public. */
export const role = publicQuery({
  args: { handle: v.string(), slug: v.string() },
  handler: async (ctx, args) => {
    const company = await companyAt(ctx, args.handle);
    if (!company) return null;
    const need = await roleAt(ctx, company, args.slug);
    if (!need) return { company: await brand(ctx, company), role: null, look: null };
    const { definition } = await formForNeed(ctx, need);
    return { company: await brand(ctx, company), role: { ...roleCard(need), responsibilities: need.responsibilities }, look: await presentation(ctx, company, definition, need.title) };
  },
});

/**
 * Starts an application from the public page with the visitor's name and email. Answers with the
 * applicant's private link token, or, for an address that already applied, a note to check their email.
 * `website` is a field people never see; anything in it means a script filled the form, and nothing is made.
 */
export const start = serverMutation({
  args: { handle: v.string(), slug: v.string(), name: v.string(), email: v.string(), website: v.string(), visitorKey: v.string() },
  handler: async (ctx, args) => {
    const company = await companyAt(ctx, args.handle);
    const need = company ? await roleAt(ctx, company, args.slug) : null;
    if (!company || !need) throw userError("This role isn't taking applications here right now.", "not_found");
    if (args.website.trim()) return { checkEmail: CHECK_EMAIL };
    if (!(await allow(ctx, `apply-start:${args.visitorKey.slice(0, 80)}`, 8, 60 * 60_000))) return { refused: "Too many applications started from here. Please try again later." };
    if (!(await allow(ctx, `apply-start-role:${need._id}`, 300, 60 * 60_000))) return { refused: "This page is busy. Please try again in a few minutes." };
    if (!linksConfigured()) return { refused: "Online applications aren't available right now. Please contact the company." };
    const name = text(args.name, "Your name", 80);
    const address = email(args.email, "Your email address");
    const settings = recruiterSettings(company);

    const sameAddress = await ctx.db
      .query("applicants")
      .withIndex("by_company_email", (q) => q.eq("companyId", company._id).eq("email", address))
      .take(20);
    for (const person of sameAddress) {
      const theirs = await ctx.db
        .query("applications")
        .withIndex("by_company_applicant", (q) => q.eq("companyId", company._id).eq("applicantId", person._id))
        .take(50);
      const open = theirs.find((row) => row.needId === need._id && isActive(row));
      if (!open) continue;
      // The link to continue goes to the address on the application, which is the one typed. Nothing is shown here.
      if (!open.submittedAt && open.contact.address === address && !(await sendProblem(ctx, open, person, "application_follow_up", settings))) {
        const link = (await liveApplicantLink(ctx, open, "apply")) ?? (await issueApplicantLink(ctx, { application: open, purpose: "apply", expiresAt: Date.now() + settings.linkTtlDays * DAY, actor: SYSTEM }));
        if (link) {
          const words = resumeEmail(partsFor(company, settings.fromName, person, need.title));
          await queueApplicantMessage(ctx, { company, application: open, applicant: person, purpose: "application_follow_up", channel: "email", subject: words.subject, body: words.body, link, dedupeKey: `resume:${open._id}:${Math.floor(Date.now() / DAY)}`, actor: SYSTEM });
        }
      }
      return { checkEmail: CHECK_EMAIL };
    }

    const now = Date.now();
    // A new person, always. One with the same address is marked as possibly the same, never merged without a person.
    const applicantId = await ctx.db.insert("applicants", { companyId: company._id, name, email: address, ...(sameAddress[0] ? { possibleDuplicateOf: sameAddress[0]._id } : {}), createdAt: now });
    const { pin } = await formForNeed(ctx, need);
    const expiresAt = now + settings.linkTtlDays * DAY;
    const applicationId = await ctx.db.insert("applications", {
      companyId: company._id,
      applicantId,
      needId: need._id,
      roleSeen: need.title,
      source: "website",
      appliedAt: now,
      stage: "application_started",
      contact: { status: "direct", address, evidence: [{ address, kind: "direct", where: WHERE }] },
      facts: [{ field: "name", value: name, from: "form", where: WHERE }],
      nextAction: { what: "Finish and submit the application form", by: "applicant", dueAt: expiresAt },
      followUpsSent: 0,
      formStartedAt: now,
      createdAt: now,
    });
    const application = (await ctx.db.get(applicationId))!;
    await grantApplicationEmail(ctx, application, need.title, SYSTEM);
    const link = await issueApplicantLink(ctx, { application, purpose: "apply", expiresAt, actor: SYSTEM });
    const token = link ? await tokenFor(link) : null;
    if (!link || !token) throw userError("Online applications aren't available right now. Please contact the company.");
    await ctx.db.insert("formSessions", { companyId: company._id, applicationId, answers: { fullName: name, email: address }, ...(pin ? { form: pin } : {}), startedAt: now, savedAt: now });
    await recordEvent(ctx, { companyId: company._id, type: "application.received", actor: SYSTEM, subject: { table: "applications", id: applicationId }, data: { source: "website", contact: "direct", matchedRole: true } });
    return { token };
  },
});
