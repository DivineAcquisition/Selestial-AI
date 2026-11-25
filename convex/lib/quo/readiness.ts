/**
 * What the Quo connection lets each agent do now, and what is still blocked, in words generated from the real
 * configuration: the connection's status and steps, the agents the Owner allowed, each agent's pause and permission
 * level, and the consent Selestial holds. Nothing here is a promise the checks don't support.
 */
import type { Doc } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { authorityFor } from "../authority";
import type { Agent } from "../statuses";

type Step = { key: "key" | "numbers" | "webhook" | "registration" | "test" | "agents"; label: string; done: boolean; detail: string };

type AgentLine = {
  agent: Agent;
  state: "ready" | "drafts" | "blocked";
  words: string;
  /** Shown before the Owner allows it: who it texts, from where, when, under what approval, and what it does. */
  workflow: { audience: string; sender: string; trigger: string; approval: string; behavior: string };
};

const NAMES: Record<Agent, string> = { sales: "Sales", recruiter: "Recruiter", dispatch: "Dispatch", retention: "Retention", quality: "Quality", "customer-care": "Client Care" };

const WORKFLOWS: Record<Agent, { action: string; audience: string; trigger: string; behavior: string; ready: string }> = {
  dispatch: { action: "dispatch.send_reminder", audience: "Cleaners on your team, about their own visits", trigger: "A visit needs a cleaner, is confirmed, or is about to start", behavior: "Texts job offers, confirmations and reminders. Replies are read against the cleaner's own visits; nothing is assigned until the job is checked again, and acceptances wait for a person.", ready: "Dispatch can send job offers, confirmations and reminders through" },
  sales: { action: "sales.follow_up", audience: "People who asked about service, with recorded permission to text", trigger: "A new inquiry, a quote to follow up, or their reply", behavior: "Answers questions from your real services, prices and availability, and follows up. Follow-ups stop on a reply, a booking, an opt-out or when a person takes over.", ready: "Sales can reply and follow up through" },
  recruiter: { action: "recruiter.follow_up", audience: "Applicants who agreed to texts, and cleaners being onboarded", trigger: "An unfinished application, an interview, or a missing onboarding item", behavior: "Sends application, interview and onboarding reminders. Documents are only ever collected through your secure forms, never by text. Hiring decisions stay with people.", ready: "Recruiter can send application, interview and onboarding reminders through" },
  retention: { action: "retention.send_case_message", audience: "Customers, about their own service", trigger: "A visit was completed, or a customer raised a concern", behavior: "Follows up after service and on open concerns. Complaints and reschedules go to the right place; refunds, credits and discounts always need your approval. Promotions are kept separate and need marketing permission.", ready: "Retention can follow up with customers through" },
  "customer-care": { action: "care.answer_question", audience: "Clients who texted the company, about their own visits, plans and invoices", trigger: "A client's text asking a question or for a change", behavior: "Answers from the visit, plan and invoice records, asks only for what is missing, and carries out changes the way your Care Setup allows. It stops when a person takes the conversation over.", ready: "Client Care can answer clients through" },
  quality: { action: "quality.request_cleaner_evidence", audience: "Cleaners who worked the visit", trigger: "A completed visit is missing required photos, or a case needs their account", behavior: "Asks for the missing photos, a short answer or their account through a private link, with one reminder. It never says anything about fault, and never texts customers: Retention does.", ready: "Quality can ask cleaners for evidence through" },
};

const LEVEL_WORDS = { off: "Off: it does nothing", propose: "Propose: it drafts each text for your approval", execute_and_report: "Act and notify me: it sends, then tells you", execute: "Act: it sends on its own within your rules" } as const;

export async function readinessOf(ctx: QueryCtx, company: Doc<"companies">, c: Doc<"quoConnections"> | null) {
  const steps: Step[] = [
    { key: "key", label: "API key accepted by Quo", done: !!c && c.status !== "disconnected" && c.checkedAt !== undefined && c.problem?.kind !== "key_rejected", detail: !c ? "Not connected." : c.checkedAt === undefined ? "Checking with Quo…" : c.problem?.kind === "key_rejected" ? c.problem.words : `Key ending ${c.keyHint}.` },
    { key: "numbers", label: "Numbers chosen", done: !!c && c.selected.length > 0, detail: c && c.selected.length > 0 ? c.selected.map((row) => row.phoneNumber).join(", ") : "Choose which Quo numbers Selestial may text from." },
    { key: "webhook", label: "Replies and delivery updates come to Selestial", done: !!c?.webhook, detail: c?.webhook ? "Quo sends replies and delivery updates for the chosen numbers to Selestial." : "Set up automatically once numbers are chosen." },
    {
      key: "registration",
      label: "Carrier registration",
      done: !!c && (c.registration.status === "approved" || c.registration.confirmedAt !== undefined),
      detail: !c
        ? "US business texting needs an approved carrier registration in Quo."
        : c.registration.status === "approved"
          ? "Quo shows the registration as approved."
          : c.registration.confirmedAt !== undefined
            ? "Confirmed by the Owner. Quo couldn't show it, so Selestial hasn't verified it."
            : c.registration.status === "pending"
              ? "Quo shows the registration as pending. Texts wait until it's approved."
              : c.registration.status === "rejected" || c.registration.status === "failed"
                ? `Quo shows the registration as ${c.registration.status}. Fix it in Quo first.`
                : "Quo doesn't show a registration for this workspace (for example, a toll-free number). Confirm it yourself once it's approved.",
    },
    { key: "test", label: "Test text and reply", done: !!c?.replyVerifiedAt, detail: c?.replyVerifiedAt ? "Your reply reached Selestial." : c?.test?.problem ? `The test didn't go: ${c.test.problem}` : c?.test ? "Reply to the test text from your phone." : "Send yourself a test text and reply to it." },
    { key: "agents", label: "Agents allowed", done: !!c && c.agents.length > 0, detail: c && c.agents.length > 0 ? c.agents.map((agent) => NAMES[agent]).join(", ") : "Choose which agents may text through Quo." },
  ];
  const ready = c?.status === "ready";
  const sender = c?.selected[0]?.phoneNumber ?? "your chosen Quo number";
  const consent = await ctx.db
    .query("consentDisclosures")
    .withIndex("by_company_channel_category", (q) => q.eq("companyId", company._id).eq("channel", "sms"))
    .first();
  const agents: AgentLine[] = [];
  for (const agent of ["dispatch", "sales", "recruiter", "retention", "customer-care"] as const) {
    const wf = WORKFLOWS[agent];
    const authority = await authorityFor(ctx, company._id, wf.action);
    const approval = authority.kind === "level" ? LEVEL_WORDS[authority.level] : authority.kind === "paused" ? `${NAMES[agent]} is paused` : "A person sends";
    const workflow = { audience: wf.audience, sender: c?.useForNew ? `${sender} (new conversations; existing ones keep their number)` : `${sender}, only for conversations already on Quo (new conversations use your Selestial number)`, trigger: wf.trigger, approval, behavior: wf.behavior };
    let state: AgentLine["state"] = "blocked";
    let words: string;
    if (!c || c.status === "disconnected") words = `${NAMES[agent]} can't text through Quo: it isn't connected.`;
    else if (!ready && !c.replyVerifiedAt) words = "Automatic replies stay paused until the reply test is complete.";
    else if (!ready) words = `${NAMES[agent]} waits until the connection is ready: ${steps.filter((step) => !step.done && step.key !== "agents").map((step) => step.label.toLowerCase()).join(", ") || c.problem?.words || "a problem needs fixing"}.`;
    else if (!c.agents.includes(agent)) words = `${NAMES[agent]} isn't allowed to use Quo yet.`;
    else if (authority.kind === "paused") words = `${NAMES[agent]} is paused, so it sends nothing. Replies are still received and routed.`;
    else if (agent === "sales" && !consent) words = "Sales follow-up needs approved messaging consent: publish your texting sign-up wording first.";
    else if (authority.kind === "level" && authority.level === "off") words = `${NAMES[agent]}'s texting is switched off in its permissions.`;
    else if (authority.kind === "level" && authority.level === "propose") {
      state = "drafts";
      words = `${NAMES[agent]} is ready to prepare texts for your approval through ${sender}.`;
    } else {
      state = "ready";
      words = `${wf.ready} ${sender}.`;
    }
    agents.push({ agent, state, words, workflow });
  }
  return {
    steps,
    agents,
    limitations: [
      "Quo shows carrier registration for the whole workspace, not for each number.",
      "Texts sent from the Quo app are detected from Quo's delivery events and checked again in Quo before an agent replies. If Quo doesn't report them, agents still step back when the recheck finds them.",
      "Quo doesn't report opt-outs ahead of time. A number that opted out in Quo is added to Selestial's own do-not-text list the first time Quo refuses a text to it.",
      "Turn off Quo auto-replies and AI agents on numbers you give Selestial. Their texts look like a person answering, so agents would step back.",
    ],
  };
}
