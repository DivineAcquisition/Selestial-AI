/**
 * Findings: what Recruiter found about one application, explained, with the next useful step prepared.
 *
 * `derive` reads an application as it is now and says what is true and what should happen next. It is
 * the only place that decides, it changes nothing, and it can be run any number of times. `refresh` keeps
 * at most one open finding per application in step with it: when the facts a finding was prepared from
 * change (the applicant finished the form, replied, withdrew, a person took over), the unused finding
 * expires and a new one is prepared. An outdated reminder can therefore never be sent: sending runs
 * `derive` again and refuses if anything changed.
 *
 * A prepared message is shown in full beside its Send button: recipient, channel, purpose, text, link and
 * any limitation. A person choosing Send has chosen that message; it does not go through another approval
 * screen. Every check still runs when it is sent (lib/recruiter/outbox.ts and the shared sending policy).
 *
 * Hiring decisions (interview, offer, decline, hire, pay) are never prepared as messages here: they show as
 * "decision needed" in context, and the existing screens and approvals decide them.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { recordEvent, type Actor } from "../events";
import { when } from "../time";
import { firstName, isActive, setNextAction, settleTask } from "./applications";
import { CONTACT_WORDS, contactNextStep } from "./contact";
import { liveInterview, openSlots } from "./interviews";
import { applicantLinkState, liveApplicantLink } from "./links";
import { payWords } from "./offers";
import { applicationMessages } from "./outbox";
import { AWAITING_FORM, OPEN_FINDING, USABLE_CONTACT, type FindingKind, type FindingStatus, type PreparedKind } from "./schema";
import { DAY, HOUR, recruiterSettings } from "./settings";
import { followUpEmail, inquiryReplyEmail, interviewInvitationEmail, interviewReminderEmail, invitationEmail, partsFor, payReplyEmail } from "./words";
import { notifyMembers } from "../notify/route";

export type Prepared = NonNullable<Doc<"recruiterFindings">["prepared"]>;

export type Derived = {
  kind: FindingKind;
  headline: string;
  explanation: string;
  reported: string[];
  missing: string[];
  next: string;
  prepared?: Prepared;
  status: Extract<FindingStatus, "ready" | "scheduled" | "needs_attention">;
  scheduledFor?: number;
  basis: string;
  sourceMessageIds: Id<"sourceMessages">[];
};

const SOURCE_NAME: Record<string, string> = { indeed: "Indeed", ziprecruiter: "ZipRecruiter", direct: "Email", manual: "Added by hand", other: "Another site" };

/** What the applicant or a board said, as said. "Reports", never "has": nothing here is verified. */
function reportedFacts(application: Doc<"applications">, who: string): string[] {
  const out: string[] = [];
  const fact = (field: string) => application.facts.find((row) => row.field === field)?.value;
  const experience = fact("experience");
  const availability = fact("availability");
  const location = fact("location");
  if (experience) out.push(`${who} reports: "${experience}".`);
  if (availability) out.push(`${who} gave availability: "${availability}".`);
  if (location) out.push(`${who} gave a location: "${location}".`);
  if (fact("resume")) out.push(`A resume was attached (${fact("resume")}). It has not been checked.`);
  return out;
}

function missingFacts(application: Doc<"applications">): string[] {
  const has = (field: string) => application.facts.some((row) => row.field === field);
  const out: string[] = [];
  if (!has("availability") && !application.submittedAt) out.push("Availability");
  if (!has("experience") && !application.submittedAt) out.push("Experience");
  if (!USABLE_CONTACT.includes(application.contact.status)) out.push("A way to reach them");
  return out;
}

/** The address a message would go to, never invented, and what kind it is. */
function recipient(application: Doc<"applications">): Pick<Prepared, "to" | "toKind"> & { limitation?: string } {
  const contact = application.contact;
  if (!USABLE_CONTACT.includes(contact.status) || !contact.address || contact.bouncedAt) return { to: null, toKind: null };
  if (contact.status === "relay") return { to: contact.address, toKind: "relay", limitation: "Goes to the job board's forwarding address, which you confirmed reaches applicants." };
  return { to: contact.address, toKind: "direct" };
}

async function openNeeds(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">): Promise<Doc<"hiringNeeds">[]> {
  return ctx.db
    .query("hiringNeeds")
    .withIndex("by_company_status", (q) => q.eq("companyId", companyId).eq("status", "open"))
    .take(20);
}

/**
 * The state of an application as one deterministic answer. Null when there is nothing for Recruiter to
 * prepare: the application ended, the person asked not to be contacted, or a person has taken it over.
 */
export async function derive(ctx: QueryCtx | MutationCtx, application: Doc<"applications">, now = Date.now()): Promise<Derived | null> {
  const applicant = await ctx.db.get(application.applicantId);
  const company = await ctx.db.get(application.companyId);
  if (!applicant || !company || !isActive(application) || applicant.doNotContact || applicant.redactedAt || application.redactedAt || application.withPersonSince) return null;
  const need = application.needId ? await ctx.db.get(application.needId) : null;
  const settings = recruiterSettings(company);
  const who = firstName(applicant.name) ?? applicant.name ?? "The applicant";
  const name = applicant.name ?? "An applicant";
  const role = need?.title ?? application.roleSeen ?? "a role";
  const source = SOURCE_NAME[application.source] ?? "Email";
  const parts = partsFor(company, settings.fromName, applicant, need?.title ?? application.roleSeen ?? "");
  const to = recipient(application);
  const messages = await applicationMessages(ctx, application);
  const sources = await ctx.db
    .query("sourceMessages")
    .withIndex("by_company_application", (q) => q.eq("companyId", application.companyId).eq("applicationId", application._id))
    .take(50);
  const lastReply = sources.filter((row) => row.classification === "applicant_reply").sort((a, b) => b.receivedAt - a.receivedAt)[0] ?? null;
  const interview = await liveInterview(ctx, application);
  const basis = [
    application.stage,
    need?.status ?? "-",
    application.needId ?? "-",
    `${application.contact.status}:${application.contact.address ?? ""}:${application.contact.bouncedAt ?? ""}`,
    application.followUpsSent,
    application.questionSince ?? "-",
    application.submittedAt ?? "-",
    lastReply?._id ?? "-",
    interview ? `${interview.status}:${interview.startsAt ?? ""}:${interview.reminderQueuedAt ?? ""}` : "-",
  ].join("|");
  const base = { reported: reportedFacts(application, who), missing: missingFacts(application), basis, sourceMessageIds: sources.map((row) => row._id).slice(0, 10) };
  const lastFailed = messages.filter((row) => row.channel === "email").sort((a, b) => b.queuedAt - a.queuedAt)[0];

  // 1. No way to write to them.
  if (!to.to) {
    const bounced = Boolean(application.contact.bouncedAt) || lastFailed?.status === "failed";
    const words = application.contact.bouncedAt ? "The last email to this address bounced." : CONTACT_WORDS[application.contact.status];
    return {
      ...base,
      kind: bounced ? "delivery_failed" : "contact_needed",
      headline: bounced ? `An email to ${name} did not go through` : `${name} applied for ${role}, with no address to write to`,
      explanation: `${source}. ${words}`,
      next: contactNextStep(application.contact.status),
      status: "needs_attention",
    };
  }

  // 2. They wrote to us and nobody has answered.
  if (application.questionSince && lastReply) {
    const intent = lastReply.replyIntent ?? "question";
    const said = lastReply.subject ? `Their message: "${lastReply.subject}".` : "";
    if (intent === "pay") {
      const pay = need?.compensation;
      if (!need || !pay) {
        return { ...base, kind: "pay_question", headline: `${name} asked about pay for ${role}`, explanation: `${said} There is no approved pay for this role, so Recruiter will not answer it.`, next: "Add the approved pay to the role in Hiring setup, or reply yourself.", status: "needs_attention" };
      }
      const link = AWAITING_FORM.includes(application.stage) ? await liveApplicantLink(ctx, application, "apply") : null;
      const email = payReplyEmail({ ...parts, pay: payWords(pay.pay), note: pay.note, applyLink: Boolean(link && applicantLinkState(link, now) === "active") });
      return {
        ...base,
        kind: "pay_question",
        headline: `${name} asked about pay for ${role}`,
        explanation: `${said} The role has approved pay: ${payWords(pay.pay)}.`,
        next: "Reply with the approved pay.",
        prepared: { kind: "pay_reply", channel: "email", ...to, subject: email.subject, body: email.body, link: email.body.includes("{link}") ? "apply" : null, reason: "Answers their question with the pay you approved for the role.", writtenBy: "template" },
        status: "ready",
      };
    }
    if (intent === "availability" && need) {
      const slots = await openSlots(ctx, company._id, now);
      if (slots.length === 0 || interview) {
        return { ...base, kind: "availability_given", headline: `${name} replied with their availability`, explanation: `${said} ${interview ? "An interview is already being arranged." : "There are no open interview times to offer."}`, next: interview ? "Check the interview, then mark the reply answered." : "Add interview times in Interviews, then offer them.", status: "needs_attention" };
      }
      const email = interviewInvitationEmail(parts);
      return {
        ...base,
        kind: "availability_given",
        headline: `${name} replied with their availability`,
        explanation: `${said} ${slots.length} interview ${slots.length === 1 ? "time is" : "times are"} open.`,
        next: "Offer them interview times to choose from.",
        prepared: { kind: "interview_times", channel: "email", ...to, subject: email.subject, body: email.body, link: "interview", reason: "They told you when they can work; this lets them pick an interview time.", writtenBy: "template" },
        status: "ready",
      };
    }
    // Not sent the application link yet, for an open role: the link answers "is it still open?" and lets them apply.
    const linkSent = messages.some((row) => row.purpose === "application_invitation" && row.status !== "failed" && row.status !== "not_sent");
    if (!linkSent && need?.status === "open" && (application.stage === "received" || application.stage === "invitation_awaiting_approval")) {
      const email = invitationEmail({ ...parts, source: application.source });
      return {
        ...base,
        kind: "applicant_question",
        headline: `${name} wrote about the ${need.title} role`,
        explanation: `${said} They have not been sent your application link yet.`,
        next: "Reply with your application link. It says the role is open and lets them apply.",
        prepared: { kind: "application_link", channel: "email", ...to, subject: email.subject, body: email.body, link: "apply", reason: "Answers them and collects what you need, through your application form.", writtenBy: "template" },
        status: "ready",
      };
    }
    return {
      ...base,
      kind: "applicant_question",
      headline: `${name} wrote with a question`,
      explanation: `${said} Reminders are paused until it is answered.`,
      next: "Write a reply, or have Recruiter draft one from the role and your Hiring FAQ.",
      prepared: { kind: "question_reply", channel: "email", ...to, subject: `Re: your ${role} application at ${company.name}`, body: "", link: null, reason: "Answers what they asked.", writtenBy: "person" },
      status: "needs_attention",
    };
  }

  // 3. Someone asking about work, not yet sent anything.
  const went = (row: Doc<"messages">) => row.status !== "failed" && row.status !== "not_sent";
  const invited = messages.some((row) => row.purpose === "application_invitation" && went(row));
  // Answered without a link (several roles were open): waiting for them to say which.
  if (application.intake === "inquiry" && !invited && messages.some((row) => row.purpose === "applicant_reply" && went(row))) return null;
  if (application.intake === "inquiry" && !invited && (application.stage === "received" || application.stage === "invitation_awaiting_approval")) {
    const roles = await openNeeds(ctx, company._id);
    if (roles.length === 0) {
      return { ...base, kind: "employment_inquiry", headline: `${name} asked about work`, explanation: `${source}. There are no open roles to tell them about.`, next: "Open a role in Hiring setup, or reply yourself.", status: "needs_attention" };
    }
    const one = roles.length === 1 ? roles[0] : null;
    const email = inquiryReplyEmail({ company: company.name, fromName: settings.fromName, name: applicant.name, roles: roles.map((row) => ({ title: row.title, location: row.location })), withLink: Boolean(one) });
    return {
      ...base,
      kind: "employment_inquiry",
      headline: `${name} asked about work`,
      explanation: `${source}. They have not applied yet. ${roles.length === 1 ? `One role is open: ${roles[0].title}.` : `${roles.length} roles are open.`}`,
      next: one ? "Reply with the open role and your application link." : "Reply with your open roles and ask which they want.",
      prepared: { kind: "inquiry_reply", channel: "email", ...to, subject: email.subject, body: email.body, link: one ? "apply" : null, reason: "Answers their inquiry with the roles that are open now.", writtenBy: "template", ...(one ? { needId: one._id } : {}) },
      status: "ready",
    };
  }

  // 4. No role, or a role that is not open.
  if (!need) return { ...base, kind: "role_needed", headline: `${name} applied, and the role is unclear`, explanation: `${source} named "${application.roleSeen ?? "no role"}", which matches no role, or more than one.`, next: "Choose the role they applied for, or close the application.", status: "needs_attention" };
  if (need.status !== "open") return { ...base, kind: "role_not_open", headline: `${name} applied for ${need.title}, which is ${need.status}`, explanation: `${source}. Nothing is sent for a role that is ${need.status}.`, next: "Reopen the role, move the application to another role, or close it.", status: "needs_attention" };

  // 5. A new application, not yet sent the link.
  if ((application.stage === "received" || application.stage === "invitation_awaiting_approval") && !invited) {
    const email = invitationEmail({ ...parts, source: application.source });
    return {
      ...base,
      kind: "new_application",
      headline: `${name} applied for ${need.title}`,
      explanation: `${source}. ${base.missing.length ? `Not provided yet: ${base.missing.join(", ").toLowerCase()}.` : "Nothing essential is missing."}`,
      next: "Send your application link to collect their availability, experience and service area.",
      prepared: { kind: "application_link", channel: "email", ...to, subject: email.subject, body: email.body, link: "apply", reason: "Collects what you need to review them, through your application form.", writtenBy: "template" },
      status: "ready",
    };
  }

  // 6. Invited, the form not finished.
  if (AWAITING_FORM.includes(application.stage) && application.invitedAt) {
    const attempt = application.followUpsSent + 1;
    const gap = settings.followUpHours[attempt - 1];
    const link = await liveApplicantLink(ctx, application, "apply");
    const linkOpen = link !== null && applicantLinkState(link, now) === "active";
    if (attempt > settings.maxFollowUps || gap === undefined || !linkOpen) {
      const what = linkOpen ? `No finished application after ${application.followUpsSent} reminder${application.followUpsSent === 1 ? "" : "s"}.` : "The application link has closed and the form was not finished.";
      return { ...base, kind: "follow_up_ended", headline: `${name} has not finished the ${need.title} application`, explanation: `${what} Not answering is not a no.`, next: "Send a new link, reach them another way, or close the application.", status: "needs_attention" };
    }
    // A reminder already planned for this attempt is on its way: nothing more to prepare until it settles.
    if (messages.some((row) => row.dedupeKey === `followup:${application._id}:${attempt}` && went(row))) return null;
    const due = application.invitedAt + gap * HOUR;
    const email = followUpEmail(parts);
    return {
      ...base,
      kind: "incomplete_application",
      headline: `${name} has not finished the ${need.title} application`,
      explanation: `${application.stage === "application_started" ? "They started the form and have not submitted it." : "They have not opened the form yet."} Reminder ${attempt} of ${settings.maxFollowUps}.`,
      next: now >= due ? "Send a reminder with their link." : "A reminder is due later. It stops if they finish, reply or withdraw.",
      prepared: { kind: "reminder", channel: "email", ...to, subject: email.subject, body: email.body, link: "apply", reason: "Their application is not finished; this brings them back to it.", writtenBy: "template", attempt, ...(applicant.smsConsent ? {} : { limitation: [to.limitation, "Email only: they have not agreed to texts."].filter(Boolean).join(" ") }) },
      status: now >= due ? "ready" : "scheduled",
      ...(now >= due ? {} : { scheduledFor: due }),
    };
  }

  // 7. An interview coming up.
  if (interview && interview.status === "confirmed" && interview.startsAt && interview.startsAt > now && !interview.reminderQueuedAt) {
    const due = interview.startsAt - settings.interviewReminderHours * HOUR;
    const email = interviewReminderEmail({ ...parts, when: `${when(interview.startsAt, now, company.timezone)} (${company.timezone})` });
    return {
      ...base,
      kind: "interview_soon",
      headline: `${name}'s interview is coming up`,
      explanation: `Booked for ${need.title}. One reminder is sent before it.`,
      next: now >= due ? "Send the interview reminder." : "The reminder is due a day before.",
      prepared: { kind: "interview_reminder", channel: "email", ...to, subject: email.subject, body: email.body, link: "interview", reason: "Fewer missed interviews.", writtenBy: "template", interviewId: interview._id },
      status: now >= due ? "ready" : "scheduled",
      ...(now >= due ? {} : { scheduledFor: due }),
    };
  }

  // 8. A decision that is a person's.
  if (application.stage === "application_submitted" || application.stage === "screening" || application.stage === "decision_pending") {
    return { ...base, kind: "decision_needed", headline: `${name} finished the ${need.title} application`, explanation: application.stage === "decision_pending" ? "The interview is done." : "Recruiter read it against the role's requirements. A person decides what happens next.", next: "Review it and decide: interview, hold, offer or decline.", status: "needs_attention" };
  }
  return null;
}

/** The open finding for an application, if any. */
export async function openFinding(ctx: QueryCtx | MutationCtx, applicationId: Id<"applications">): Promise<Doc<"recruiterFindings"> | null> {
  const rows = await ctx.db
    .query("recruiterFindings")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .order("desc")
    .take(10);
  return rows.find((row) => OPEN_FINDING.includes(row.status)) ?? null;
}

/**
 * Brings the application's finding in step with its records. Returns the open finding afterwards. A
 * finding a person edited keeps their words as long as the facts are the same.
 */
export async function refresh(ctx: MutationCtx, applicationId: Id<"applications">, now = Date.now()): Promise<Doc<"recruiterFindings"> | null> {
  const application = await ctx.db.get(applicationId);
  if (!application) return null;
  const derived = await derive(ctx, application, now);
  const open = await openFinding(ctx, applicationId);
  if (open && derived && open.kind === derived.kind && open.basis === derived.basis) {
    // The same facts: only the timing can have moved (a scheduled reminder that is now due).
    const kept = open.prepared?.writtenBy === "person" || open.prepared?.writtenBy === "assistant";
    const prepared = kept ? open.prepared : derived.prepared;
    // Words a person or the drafting assistant wrote make a reply ready that the records alone could not.
    const status = kept && derived.status === "needs_attention" && prepared?.body.trim() ? "ready" : derived.status;
    if (open.status !== status || open.scheduledFor !== derived.scheduledFor) await ctx.db.patch(open._id, { status, scheduledFor: derived.scheduledFor, prepared, updatedAt: now });
    return (await ctx.db.get(open._id))!;
  }
  if (open) await ctx.db.patch(open._id, { status: open.status === "needs_attention" ? "done" : "expired", outcome: open.status === "needs_attention" ? "Things moved on." : "The facts changed before it was used, so it was not sent.", updatedAt: now });
  const latest = (
    await ctx.db
      .query("recruiterFindings")
      .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
      .order("desc")
      .take(1)
  )[0];
  if (!derived) {
    // A dismissal ends when a person takes the application over: handed back, Recruiter prepares again.
    if (latest?.status === "dismissed" && application.withPersonSince) await ctx.db.patch(latest._id, { status: "done", outcome: `${latest.outcome ?? "Dismissed."} Then taken over by a person.`, updatedAt: now });
    return null;
  }
  // Already done or dismissed on exactly these facts: it is not prepared again until something changes.
  if (latest && latest._id !== open?._id && latest.kind === derived.kind && latest.basis === derived.basis && (latest.status === "dismissed" || latest.status === "sending" || latest.status === "sent")) return null;
  const id = await ctx.db.insert("recruiterFindings", {
    companyId: application.companyId,
    applicationId,
    applicantId: application.applicantId,
    sourceMessageIds: derived.sourceMessageIds,
    kind: derived.kind,
    headline: derived.headline,
    explanation: derived.explanation,
    reported: derived.reported,
    missing: derived.missing,
    next: derived.next,
    prepared: derived.prepared,
    status: derived.status,
    basis: derived.basis,
    scheduledFor: derived.scheduledFor,
    discoveredAt: now,
    updatedAt: now,
  });
  return (await ctx.db.get(id))!;
}

/** Settles a finding once the message it sent is known to have gone, or failed. */
export async function afterFindingMessage(ctx: MutationCtx, message: Doc<"messages">, event: "accepted" | "delivered" | "failed"): Promise<void> {
  const finding = await ctx.db
    .query("recruiterFindings")
    .withIndex("by_message", (q) => q.eq("messageId", message._id))
    .first();
  if (!finding) return;
  const now = Date.now();
  if (event === "failed") {
    const problem = message.problem ?? (message.status === "unconfirmed" ? "It is not known whether it went. It was not sent again." : "It could not be sent.");
    await ctx.db.patch(finding._id, { status: "needs_attention", outcome: problem, updatedAt: now });
    await notifyMembers(ctx, { companyId: finding.companyId, event: "recruiter_attention", ref: finding.applicationId, key: `failed:${message._id}`, facts: { kind: "failed", problem } });
  }
  else await ctx.db.patch(finding._id, { status: "sent", outcome: event === "delivered" ? "Delivered, as the email service reports." : "Accepted by the email service. Delivery is not confirmed yet.", updatedAt: now });
}

/** The finding's prepared kind, for tests and the screens. */
export type { PreparedKind };

/** A finding the facts have moved past: it is ended so it cannot be used, and the next one prepared. */
export async function staleness(ctx: MutationCtx, finding: Doc<"recruiterFindings">): Promise<string | null> {
  const application = await ctx.db.get(finding.applicationId);
  if (!application) return "The application no longer exists.";
  const derived = await derive(ctx, application);
  if (derived && derived.kind === finding.kind && derived.basis === finding.basis) return null;
  await refresh(ctx, application._id);
  return derived ? `This changed since it was prepared: ${derived.headline.toLowerCase()}. Look again before sending.` : "This no longer needs doing: the application moved on.";
}

/** Clears the "waiting for a reply" state after a reply was sent, so reminders can resume. */
export async function answered(ctx: MutationCtx, application: Doc<"applications">, actor: Actor): Promise<void> {
  if (!application.questionSince) return;
  await ctx.db.patch(application._id, { questionSince: undefined });
  await settleTask(ctx, application, "reply", "The reply was answered.", actor);
  await setNextAction(ctx, application, { what: "Wait for the applicant", by: "applicant", dueAt: Date.now() + 3 * DAY });
  await recordEvent(ctx, { companyId: application.companyId, type: "application.reply_answered", actor, subject: { table: "applications", id: application._id }, data: {} });
}
