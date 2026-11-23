/**
 * Drafting a reply to an applicant's question with AI (lib/recruiter/drafting.ts), charged as one
 * "Hiring reply drafted by AI" when a usable draft is produced. Asked for by a person from the finding,
 * or by Recruiter itself where the Owner switched "Answer routine questions" on. A draft the assistant
 * declines to write, or one that fails the grounding check, is not charged and not used.
 *
 * The draft is a prepared message like any other: shown in full, edited if wanted, and sent by a person's
 * choice, or by itself only under the Owner's automation setting (lib/recruiter/act.ts).
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { owned } from "./lib/access";
import { finishExecution, openExecution } from "./lib/billing/executions";
import { reserveExecution } from "./lib/billing/reserve";
import { managerMutation } from "./lib/builders";
import { userError } from "./lib/errors";
import { automate, draftable, startDraft } from "./lib/recruiter/act";
import { firstName } from "./lib/recruiter/applications";
import { checkDraft, replyDrafter, type DraftInput } from "./lib/recruiter/drafting";
import { payWords } from "./lib/recruiter/offers";
import { OPEN_FINDING } from "./lib/recruiter/schema";
import { recruiterSettings } from "./lib/recruiter/settings";
import { partsFor, replyEmail } from "./lib/recruiter/words";


/** A person asks Recruiter to draft the reply. Charged only if a usable draft comes back. */
export const request = managerMutation({
  args: { findingId: v.id("recruiterFindings") },
  handler: async (ctx, args) => {
    const finding = await owned(ctx, args.findingId);
    if (!draftable(finding)) throw userError("There is no question here to draft a reply for.");
    if (!replyDrafter()) throw userError("Drafting replies isn't available yet. Write the reply yourself.");
    await startDraft(ctx, finding, ctx.member._id);
    return null;
  },
});

export const forRun = internalQuery({
  args: { findingId: v.id("recruiterFindings") },
  handler: async (ctx, args): Promise<{ input: DraftInput; companyId: Id<"companies">; applicationId: Id<"applications"> } | null> => {
    const finding = await ctx.db.get(args.findingId);
    if (!finding || finding.draft?.state !== "drafting") return null;
    const application = await ctx.db.get(finding.applicationId);
    const applicant = application ? await ctx.db.get(application.applicantId) : null;
    const company = application ? await ctx.db.get(application.companyId) : null;
    const need = application?.needId ? await ctx.db.get(application.needId) : null;
    if (!application || !applicant || !company || !need) return null;
    const replies = (
      await ctx.db
        .query("sourceMessages")
        .withIndex("by_company_application", (q) => q.eq("companyId", company._id).eq("applicationId", application._id))
        .take(50)
    )
      .filter((row) => row.classification === "applicant_reply" && row.excerpt)
      .sort((a, b) => b.receivedAt - a.receivedAt);
    if (!replies[0]?.excerpt) return null;
    return {
      companyId: company._id,
      applicationId: application._id,
      input: {
        company: company.name,
        firstName: firstName(applicant.name),
        role: { title: need.title, location: need.location, responsibilities: need.responsibilities, availability: need.requiredAvailability, engagement: need.engagement === "employee" ? "Employee" : "Independent contractor", pay: need.compensation ? payWords(need.compensation.pay) : null, payNote: need.compensation?.note ?? null },
        faq: recruiterSettings(company).hiringFaq,
        message: replies[0].excerpt,
      },
    };
  },
});

export const run = internalAction({
  args: { findingId: v.id("recruiterFindings"), memberId: v.optional(v.id("members")) },
  handler: async (ctx, args) => {
    const loaded = await ctx.runQuery(internal.recruiterDrafts.forRun, { findingId: args.findingId });
    if (!loaded) return null;
    const drafter = replyDrafter();
    if (!drafter) {
      await ctx.runMutation(internal.recruiterDrafts.settle, { findingId: args.findingId, outcome: { kind: "unavailable", why: "Drafting replies isn't available. Write the reply yourself." } });
      return null;
    }
    const opened = await ctx.runMutation(internal.recruiterDrafts.open, { findingId: args.findingId, memberId: args.memberId });
    if (!opened.executionId) {
      await ctx.runMutation(internal.recruiterDrafts.settle, { findingId: args.findingId, outcome: { kind: "unavailable", why: `${opened.why} Write the reply yourself.`.trim() } });
      return null;
    }
    const executionId = opened.executionId;
    const held = await reserveExecution(ctx, executionId);
    if (!held.ok) {
      await ctx.runMutation(internal.recruiterDrafts.settle, { findingId: args.findingId, outcome: { kind: "unavailable", why: "Credits for drafting could not be reserved. Write the reply yourself." }, executionId });
      return null;
    }
    const draft = await drafter.draft(loaded.input);
    const problem = draft.answerable ? checkDraft(draft.reply, loaded.input) : draft.why;
    await ctx.runMutation(internal.recruiterDrafts.settle, {
      findingId: args.findingId,
      executionId,
      outcome: draft.answerable && !problem ? { kind: "drafted", text: draft.reply } : { kind: "declined", why: problem ?? "Your approved information does not answer this." },
      charged: draft.answerable && !problem && draft.byModel,
      automatic: !args.memberId,
    });
    return null;
  },
});

export const open = internalMutation({
  args: { findingId: v.id("recruiterFindings"), memberId: v.optional(v.id("members")) },
  handler: async (ctx, args) => {
    const finding = await ctx.db.get(args.findingId);
    const company = finding ? await ctx.db.get(finding.companyId) : null;
    if (!finding || !company) return { executionId: null, why: "The application is gone." };
    const drafts = (await ctx.db.query("aiExecutions").withIndex("by_company_key", (q) => q.eq("companyId", company._id).gte("key", `hiring-draft:${finding._id}:`).lt("key", `hiring-draft:${finding._id};`)).take(20)).length;
    const opened = await openExecution(ctx, {
      company,
      key: `hiring-draft:${finding._id}:${drafts}`,
      agent: "recruiter",
      task: "hiring_reply_draft",
      units: 1,
      autonomous: !args.memberId,
      memberId: args.memberId,
      origin: args.memberId ? "member" : "automatic",
      source: { table: "applications", id: finding.applicationId },
      link: { label: "Applicant", path: `/app/agents/recruiter/applicants?open=${finding.applicationId}` },
    });
    if (!opened.ok) return { executionId: null, why: opened.message || "Drafting can't be charged right now." };
    return opened.repeated ? { executionId: null, why: "This draft was already asked for." } : { executionId: opened.executionId, why: "" };
  },
});

export const settle = internalMutation({
  args: {
    findingId: v.id("recruiterFindings"),
    executionId: v.optional(v.id("aiExecutions")),
    charged: v.optional(v.boolean()),
    /** Drafted by Recruiter under "Answer routine questions", not at a person's request. */
    automatic: v.optional(v.boolean()),
    outcome: v.union(v.object({ kind: v.literal("drafted"), text: v.string() }), v.object({ kind: v.literal("declined"), why: v.string() }), v.object({ kind: v.literal("unavailable"), why: v.string() })),
  },
  handler: async (ctx, args) => {
    if (args.executionId) await finishExecution(ctx, args.executionId, args.charged ? { completedUnits: 1 } : { ended: "failed" });
    const finding = await ctx.db.get(args.findingId);
    if (!finding || !OPEN_FINDING.includes(finding.status) || !finding.prepared) return null;
    const now = Date.now();
    if (args.outcome.kind !== "drafted") {
      await ctx.db.patch(finding._id, { draft: { state: args.outcome.kind, at: now, why: args.outcome.why.slice(0, 300) }, updatedAt: now });
      return null;
    }
    const application = await ctx.db.get(finding.applicationId);
    const applicant = application ? await ctx.db.get(application.applicantId) : null;
    const company = application ? await ctx.db.get(application.companyId) : null;
    const need = application?.needId ? await ctx.db.get(application.needId) : null;
    if (!application || !applicant || !company || !need) return null;
    const email = replyEmail({ ...partsFor(company, recruiterSettings(company).fromName, applicant, need.title), text: args.outcome.text, subject: finding.prepared.subject });
    await ctx.db.patch(finding._id, { prepared: { ...finding.prepared, body: email.body, writtenBy: "assistant", reason: "Answers their question from the role's approved details and your Hiring FAQ." }, status: "ready", draft: undefined, updatedAt: now });
    // Drafted under "Answer routine questions": a grounded draft goes by itself. Asked for by a person: it waits for them.
    if (args.automatic) await automate(ctx, application._id);
    return null;
  },
});
