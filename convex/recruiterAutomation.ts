/**
 * The five kinds of message Recruiter can send without asking, each switched on or off by the Owner. A
 * switch is the action's permission level underneath (Agent Controls shows the same thing), so there is
 * one source of truth. On means "Act automatically"; off means "Ask me first": the message is still
 * prepared, ready for a person to send.
 *
 * New companies start with all five off (the Owner's decision of November 23, 2026). A company that had
 * something on before keeps it (convex/recruiterMigration.ts). Nothing here covers a hiring decision.
 */
import { v } from "convex/values";

import { byMember } from "./lib/events";
import { authorityFor } from "./lib/authority";
import { activeRateCard } from "./lib/billing/rateCards";
import { companyQuery, ownerMutation } from "./lib/builders";
import { applyPolicy, LEVEL_WORDS, policyOf } from "./lib/controls/policy";
import { actionDef } from "./lib/permissionCatalog";
import { replyDrafter } from "./lib/recruiter/drafting";
import { recruiterSettings } from "./lib/recruiter/settings";

export const AUTOMATIONS = [
  {
    key: "application_links",
    action: "recruiter.send_invitation",
    title: "Send application links to new applicants",
    trigger: "A new application arrives with one clear address and a clear name, for a role that is open.",
    message: "Your application invitation, with the applicant's own link to your application form.",
    stops: "Not sent, and left for you, when the address is unclear or only a job board's unconfirmed forwarding address, the person may already be on file, a message about them was flagged, or the role is not open.",
  },
  {
    key: "inquiry_replies",
    action: "recruiter.reply_inquiry",
    title: "Reply to people asking about work",
    trigger: "Someone writes to the hiring inbox asking about work without applying.",
    message: "A reply naming your open roles. With one open role it includes the application link; with several it asks which they want.",
    stops: "Not sent when no role is open. One reply per inquiry.",
  },
  {
    key: "reminders",
    action: "recruiter.follow_up",
    title: "Remind applicants who haven't finished",
    trigger: "An applicant was sent the link and hasn't submitted the form by each reminder time you set.",
    message: "A reminder with their link, by email; by text only if they agreed to texts.",
    stops: "Stops when they submit, reply, withdraw or ask not to be contacted, an interview is booked, the role closes, a person takes over, the link expires, or the reminder limit is reached.",
  },
  {
    key: "interview_reminders",
    action: "recruiter.interview_reminder",
    title: "Remind applicants of booked interviews",
    trigger: "An interview is booked and the reminder time before it arrives.",
    message: "One reminder with the time and a link to change or cancel.",
    stops: "Not sent if the interview was moved, cancelled or the application ended. One per booked time.",
  },
  {
    key: "routine_answers",
    action: "recruiter.answer_questions",
    title: "Answer routine questions",
    trigger: "An applicant asks something your approved information answers: pay, the work, hours, equipment.",
    message: "Pay questions get your approved pay (no credits). Other questions get a reply drafted by AI from the role's details and your Hiring FAQ (1 credit each).",
    stops: "Never answers what your approved information does not say, never speaks of a hiring decision; those wait for you. Stops for the same reasons as every message: withdrawal, do-not-contact, a person taking over, a pause.",
  },
] as const;

type Key = (typeof AUTOMATIONS)[number]["key"];
const ON = new Set(["execute", "execute_and_report"]);

export const list = companyQuery({
  args: {},
  handler: async (ctx) => {
    const settings = recruiterSettings(ctx.company);
    const paused = ctx.company.pausedAgents.includes("recruiter");
    const out = [];
    for (const item of AUTOMATIONS) {
      const authority = await authorityFor(ctx, ctx.companyId, item.action);
      const level = authority.kind === "level" ? authority.level : null;
      const on = level !== null && ON.has(level) && (item.key !== "application_links" || settings.invitationMode === "auto");
      const limitation =
        item.key === "routine_answers" && !replyDrafter()
          ? "Drafting with AI isn't available here yet, so only pay questions are answered."
          : item.key === "routine_answers" && !activeRateCard()?.rates.hiring_reply_draft
            ? "Drafted replies have no credit rate in force yet, so only pay questions are answered."
            : null;
      out.push({ ...item, on, level: level ? LEVEL_WORDS[level] : authority.kind === "paused" ? "Paused" : "Unavailable", limitation });
    }
    return { paused, items: out };
  },
});

export const set = ownerMutation({
  args: { key: v.union(...AUTOMATIONS.map((item) => v.literal(item.key))), on: v.boolean() },
  handler: async (ctx, args) => {
    const item = AUTOMATIONS.find((row) => row.key === (args.key as Key))!;
    const def = actionDef(item.action)!;
    const policy = await policyOf(ctx, ctx.company);
    const current = policy.permissions.find((row) => row.action === def.key)!;
    const level = args.on ? "execute" : "propose";
    await applyPolicy(ctx, ctx.company, { kind: "permission", summary: `${def.label}: ${LEVEL_WORDS[current.level]} → ${LEVEL_WORDS[level]}`, permissions: [{ ...current, level, until: undefined }], by: ctx.member._id, actor: byMember(ctx) });
    // Application links also follow the Playbook's invitation mode, which the switch keeps in step.
    if (item.key === "application_links") await ctx.db.patch(ctx.companyId, { recruiter: { ...(ctx.company.recruiter ?? {}), invitationMode: args.on ? "auto" : "review" } });
    return null;
  },
});
