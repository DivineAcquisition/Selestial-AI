/**
 * Carrying out a finding's prepared message: once for a person's click, and the same way when the Owner
 * has switched that kind of message to automatic.
 *
 * Before anything is planned, the finding is checked against the records again (findings.ts `staleness`):
 * a reminder prepared before the applicant finished the form is refused, not sent. The send itself goes
 * through the existing send functions and the outbox, so every rule applies there too: role, do-not-contact,
 * withdrawal, application state, a usable address, the sending policy (suspension, suppression, quiet hours,
 * weekly limits, a paused agent for Recruiter's own sends), the provider, and one message per dedupe key.
 *
 * Automation is a separate question asked here (`mayAutomate`): whether the Owner turned that kind on,
 * whether Recruiter is paused, and the kind's own extra conditions. It never covers a hiring decision.
 */
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { authorityFor } from "../authority";
import { reportAction } from "../controls/report";
import type { CarriedOut } from "../dispatch/workflow";
import { recordEvent, type Actor } from "../events";
import { RECRUITER } from "./applications";
import { replyDrafter } from "./drafting";
import { answered, openFinding, refresh, staleness, type Prepared } from "./findings";
import { sendInterviewReminder, startInterview } from "./interviews";
import { autoEligible, sendFollowUp, sendInvitation } from "./invitations";
import { applicantLinkState, issueApplicantLink, liveApplicantLink } from "./links";
import { applicationMessages, queueApplicantMessage, type ApplicantPurpose } from "./outbox";
import type { PreparedKind } from "./schema";
import { DAY, recruiterSettings } from "./settings";

export const REPLY_INQUIRY = "recruiter.reply_inquiry";
export const ANSWER_QUESTIONS = "recruiter.answer_questions";

/**
 * Which Owner setting lets each kind of prepared message go by itself. Null: never automatic. Written out
 * as text, not imported, because the modules that send also call back into this one.
 */
export const AUTOMATION: Record<PreparedKind, string | null> = {
  application_link: "recruiter.send_invitation",
  inquiry_reply: REPLY_INQUIRY,
  reminder: "recruiter.follow_up",
  interview_reminder: "recruiter.interview_reminder",
  pay_reply: ANSWER_QUESTIONS,
  question_reply: ANSWER_QUESTIONS,
  // Offering interview times follows a decision to interview, which is a person's.
  interview_times: null,
};

const PURPOSE: Record<PreparedKind, ApplicantPurpose> = {
  application_link: "application_invitation",
  inquiry_reply: "application_invitation",
  reminder: "application_follow_up",
  interview_reminder: "interview_reminder",
  pay_reply: "applicant_reply",
  question_reply: "applicant_reply",
  interview_times: "interview_invitation",
};

export type Edit = { subject: string; body: string };

/** The words to send: a person's edit, or what was prepared. A message that needs a link keeps it. */
function words(prepared: Prepared, edit?: Edit): Edit | { problem: string } {
  const subject = (edit?.subject ?? prepared.subject).replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  let body = (edit?.body ?? prepared.body).replace(/\r\n/g, "\n").trim().slice(0, 5000);
  if (!body) return { problem: "Write the message first." };
  if (!subject) return { problem: "Give the message a subject." };
  if (prepared.link && !body.includes("{link}")) body = `${body}\n\n{link}`;
  if (!prepared.link) body = body.replace(/\{link\}/g, "");
  return { subject, body };
}

export type ActResult = { ok: boolean; detail: string; stale?: boolean; findingId: Id<"recruiterFindings"> };

/** Sends one finding's prepared message. `actor` is the person who chose it, or Recruiter under automation. */
export async function carryOut(ctx: MutationCtx, finding: Doc<"recruiterFindings">, actor: Actor, edit?: Edit): Promise<ActResult> {
  const id = finding._id;
  if (finding.status !== "ready" && !(finding.status === "needs_attention" && finding.prepared?.kind === "question_reply")) return { ok: false, detail: finding.status === "scheduled" ? "This is not due yet." : "This was already handled.", findingId: id };
  const stale = await staleness(ctx, finding);
  if (stale) return { ok: false, stale: true, detail: stale, findingId: id };
  const prepared = finding.prepared;
  if (!prepared) return { ok: false, detail: "Nothing was prepared to send for this. Do the next step yourself.", findingId: id };
  if (!prepared.to) return { ok: false, detail: "There is no address to send this to.", findingId: id };
  const text = words(prepared, edit);
  if ("problem" in text) return { ok: false, detail: text.problem, findingId: id };

  const application = (await ctx.db.get(finding.applicationId))!;
  const started = Date.now();
  let result: CarriedOut;
  switch (prepared.kind) {
    case "application_link":
      result = await sendInvitation(ctx, application._id, actor, { override: edit ? text : undefined });
      // Sent in answer to their message: that message is answered.
      if (result.ok && application.questionSince) await answered(ctx, (await ctx.db.get(application._id))!, actor);
      break;
    case "inquiry_reply":
      if (prepared.needId) {
        if (!application.needId) await ctx.db.patch(application._id, { needId: prepared.needId });
        result = await sendInvitation(ctx, application._id, actor, { override: text });
      } else {
        result = await reply(ctx, application, text, actor, null);
      }
      break;
    case "reminder":
      result = await sendFollowUp(ctx, application._id, prepared.attempt ?? application.followUpsSent + 1, actor, edit ? text : undefined);
      break;
    case "interview_reminder":
      result = prepared.interviewId ? await sendInterviewReminder(ctx, prepared.interviewId, actor, edit ? text : undefined) : { ok: false, detail: "The interview is gone." };
      break;
    case "pay_reply":
    case "question_reply":
      result = await reply(ctx, application, text, actor, prepared.link);
      if (result.ok) await answered(ctx, (await ctx.db.get(application._id))!, actor);
      break;
    case "interview_times": {
      const interviewId = await startInterview(ctx, application, actor);
      const interview = await ctx.db.get(interviewId);
      result = interview?.status === "proposed" ? { ok: true, detail: "They were emailed the times to choose from." } : { ok: false, detail: "No times could be offered. Add interview times first." };
      if (result.ok) await answered(ctx, (await ctx.db.get(application._id))!, actor);
      break;
    }
  }

  // The message this made, if any: the newest of its purpose planned since the click.
  const message = (await applicationMessages(ctx, application))
    .filter((row) => row.purpose === PURPOSE[prepared.kind] && row.channel === "email" && row.queuedAt >= started - 1000)
    .sort((a, b) => b.queuedAt - a.queuedAt)[0];
  const status = !result.ok || !message || message.status === "not_sent" || message.status === "failed" ? "needs_attention" : message.status === "held" ? "scheduled" : message.status === "sent" || message.status === "delivered" ? "sent" : "sending";
  const by = actor.kind === "member" ? actor.memberId : undefined;
  await ctx.db.patch(id, {
    status,
    messageId: message?._id,
    outcome: result.ok ? (status === "scheduled" ? `Waiting for sending hours. ${message?.problem ?? ""}`.trim() : result.detail) : (message?.problem ?? result.detail),
    prepared: edit ? { ...prepared, subject: text.subject, body: text.body, writtenBy: "person" } : prepared,
    automatic: actor.kind !== "member",
    ...(by ? { by } : {}),
    updatedAt: Date.now(),
  });
  await recordEvent(ctx, { companyId: finding.companyId, type: result.ok ? "finding.sent" : "finding.not_sent", actor, subject: { table: "applications", id: application._id }, data: { kind: prepared.kind, edited: Boolean(edit) } });
  // What comes next for this application, if anything.
  await refresh(ctx, application._id);
  return { ok: result.ok, detail: result.ok ? result.detail : (message?.problem ?? result.detail), findingId: id };
}

/** A reply in the applicant's conversation, with their application link when it needs one. */
async function reply(ctx: MutationCtx, application: Doc<"applications">, text: Edit, actor: Actor, link: Prepared["link"]): Promise<CarriedOut> {
  const applicant = await ctx.db.get(application.applicantId);
  const company = await ctx.db.get(application.companyId);
  if (!applicant || !company) return { ok: false, detail: "The application no longer exists." };
  let issued: Doc<"applicantLinks"> | null | undefined = undefined;
  if (link === "apply") {
    const live = await liveApplicantLink(ctx, application, "apply");
    issued = live && applicantLinkState(live, Date.now()) === "active" ? live : await issueApplicantLink(ctx, { application, purpose: "apply", expiresAt: Date.now() + recruiterSettings(company).linkTtlDays * DAY, actor });
  }
  const count = (await applicationMessages(ctx, application)).filter((row) => row.purpose === "applicant_reply").length;
  const message = await queueApplicantMessage(ctx, { company, application, applicant, purpose: "applicant_reply", channel: "email", subject: text.subject, body: text.body, link: issued, dedupeKey: `reply:${application._id}:${application.questionSince ?? 0}:${count}`, actor, immediate: true });
  return message.status === "not_sent" ? { ok: false, detail: message.problem ?? "The reply could not be sent." } : { ok: true, detail: "The reply was handed to the email service." };
}

/** Whether this finding may go without a person: the Owner turned its kind on, and its own conditions hold. */
export async function mayAutomate(ctx: MutationCtx, finding: Doc<"recruiterFindings">): Promise<{ ok: boolean; level?: "execute" | "execute_and_report" }> {
  const prepared = finding.prepared;
  if (finding.status !== "ready" || !prepared?.to || !prepared.body) return { ok: false };
  const key = AUTOMATION[prepared.kind];
  if (!key) return { ok: false };
  const authority = await authorityFor(ctx, finding.companyId, key);
  if (authority.kind !== "level" || authority.level === "off" || authority.level === "propose") return { ok: false };
  const application = await ctx.db.get(finding.applicationId);
  const applicant = application ? await ctx.db.get(application.applicantId) : null;
  const company = application ? await ctx.db.get(application.companyId) : null;
  if (!application || !applicant || !company) return { ok: false };
  if (prepared.kind === "application_link") {
    // As before: application links go by themselves only with automatic invitations on, and only when nothing about the application needs a look.
    if (recruiterSettings(company).invitationMode !== "auto") return { ok: false };
    if (!(await autoEligible(ctx, application, applicant)).ok) return { ok: false };
  }
  // An answer to a question goes by itself only when it was written from approved information (a template, or a grounded draft).
  if (prepared.kind === "question_reply" && prepared.writtenBy !== "assistant") return { ok: false };
  return { ok: true, level: authority.level };
}

/** Carries out the application's ready finding if the Owner's automation allows it. Safe to call again at any time. */
export async function automate(ctx: MutationCtx, applicationId: Id<"applications">): Promise<ActResult | null> {
  const finding = (await refresh(ctx, applicationId)) ?? null;
  if (!finding) return null;
  const allowed = await mayAutomate(ctx, finding);
  if (!allowed.ok) return null;
  const result = await carryOut(ctx, finding, RECRUITER);
  if (result.ok && finding.prepared) {
    await reportAction(ctx, { companyId: finding.companyId, agent: "recruiter", action: AUTOMATION[finding.prepared.kind]!, level: allowed.level!, subject: { table: "applications", id: applicationId }, ref: `${finding._id}`, stage: "queued", kind: finding.prepared.kind, data: { applicationId } });
  }
  return result;
}

export { openFinding };

export function draftable(finding: Doc<"recruiterFindings"> | null): finding is Doc<"recruiterFindings"> {
  return finding !== null && (finding.status === "ready" || finding.status === "needs_attention") && finding.prepared?.kind === "question_reply" && finding.draft?.state !== "drafting";
}

/** Starts drafting a reply with AI (convex/recruiterDrafts.ts). `by`: the person who asked; null when Recruiter does it itself. */
export async function startDraft(ctx: MutationCtx, finding: Doc<"recruiterFindings">, by: Id<"members"> | null): Promise<void> {
  await ctx.db.patch(finding._id, { draft: { state: "drafting", at: Date.now() }, updatedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.recruiterDrafts.run, { findingId: finding._id, memberId: by ?? undefined });
}

/** Where the Owner switched "Answer routine questions" on, Recruiter drafts the reply to a question itself. */
export async function draftAutomatically(ctx: MutationCtx, applicationId: Id<"applications">): Promise<boolean> {
  const finding = await openFinding(ctx, applicationId);
  if (!draftable(finding) || !replyDrafter()) return false;
  const authority = await authorityFor(ctx, finding.companyId, ANSWER_QUESTIONS);
  if (authority.kind !== "level" || authority.level === "off" || authority.level === "propose") return false;
  await startDraft(ctx, finding, null);
  return true;
}
