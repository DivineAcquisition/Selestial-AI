/**
 * Where a company's business texting stands, in the eight states an owner sees on Email & texting ›
 * Business texting (docs/sms/00-architecture.md §7, phase 4). Read only from real records: the texting
 * request and its progress at Telnyx, the guided setup, the messaging profile, the Quo connection, the
 * company's pauses and its messaging balance. Never from an owner saying "I submitted it".
 */
import type { Doc } from "../../_generated/dataModel";
import { AGENTS, type Agent } from "../statuses";

export type BusinessState = "not_configured" | "setup_in_progress" | "submitted" | "under_review" | "changes_needed" | "approved" | "sending_unavailable" | "ready";

export const STATE_WORDS: Record<BusinessState, { label: string; tone: "neutral" | "progress" | "warning" | "bad" | "good"; about: string }> = {
  not_configured: { label: "Not configured", tone: "neutral", about: "Your company doesn't have a texting number yet." },
  setup_in_progress: { label: "Setup in progress", tone: "progress", about: "Your setup is saved. Finish it to send it to Selestial for review." },
  submitted: { label: "Submitted", tone: "progress", about: "Selestial is reviewing your setup before anything is filed with the carriers." },
  under_review: { label: "Under review", tone: "progress", about: "Your registration is with the carriers. This usually takes a few days." },
  changes_needed: { label: "Changes needed", tone: "warning", about: "Something in your registration needs your attention before the carriers can approve it." },
  approved: { label: "Approved", tone: "progress", about: "The carriers approved your registration. Your number is being connected; texts wait until it's done." },
  sending_unavailable: { label: "Sending unavailable", tone: "bad", about: "Texts can't go out right now. See what's blocking them below." },
  ready: { label: "Ready to send", tone: "good", about: "Your business can text." },
};

export type Blocker = { key: string; words: string; action: { label: string; href: string } | null; severity: "blocks" | "partial" };

export type StateInput = {
  request: Pick<Doc<"textingRequests">, "status" | "campaignApprovedAt" | "phoneNumber" | "step" | "needs" | "problem"> | null;
  setupStarted: boolean;
  messaging: { smsNumber?: string; senderName?: string; registration: { status: string } };
  company: Pick<Doc<"companies">, "suspendedAt" | "messagingPause" | "pausedAgents">;
  quo: Pick<Doc<"quoConnections">, "status" | "useForNew" | "selected" | "agents"> | null;
  /** Metering on and the company's messaging balance can't pay for a text. */
  outOfFunds: boolean;
};

const SETUP_HREF = "/app/texting";

function nativeReady(input: StateInput): boolean {
  return Boolean(input.messaging.smsNumber && input.messaging.senderName && input.messaging.registration.status === "approved");
}

function quoReady(input: StateInput): boolean {
  return input.quo !== null && input.quo.status === "ready" && input.quo.useForNew && input.quo.selected.length > 0;
}

export function blockersOf(input: StateInput): Blocker[] {
  const out: Blocker[] = [];
  if (input.company.suspendedAt !== undefined) out.push({ key: "suspended", words: "Selestial suspended sending for your company. Nothing is sent until Selestial lifts it.", action: { label: "Contact support", href: "mailto:support@selestial.io" }, severity: "blocks" });
  if (input.company.messagingPause) out.push({ key: "paused", words: "You paused all texting. Messages are waiting and go out when you resume.", action: null, severity: "blocks" });
  if (input.outOfFunds) out.push({ key: "funds", words: "Your messaging balance is empty. Texts wait with their words kept until you add funds.", action: { label: "Add funds to continue", href: "/app/settings/billing?tab=messaging" }, severity: "blocks" });
  if (input.request?.status === "interrupted") out.push({ key: "interrupted", words: "The carriers paused your registration. Texts from your number wait until it's resolved.", action: { label: "See what's happening", href: SETUP_HREF }, severity: "blocks" });
  if (input.quo && input.quo.useForNew && input.quo.status !== "ready" && input.quo.status !== "disconnected") out.push({ key: "quo", words: "Your Quo connection has a problem, so texts through it wait.", action: { label: "Open Quo settings", href: "/app/settings/integrations/quo" }, severity: nativeReady(input) ? "partial" : "blocks" });
  const paused = AGENTS.filter((agent) => input.company.pausedAgents.includes(agent));
  if (paused.length) out.push({ key: "agents_paused", words: `${paused.length === AGENTS.length ? "Every agent is" : `${paused.map((a) => AGENT_NAMES[a]).join(", ")} ${paused.length === 1 ? "is" : "are"}`} paused, so ${paused.length === 1 ? "it texts" : "they text"} nothing on ${paused.length === 1 ? "its" : "their"} own. People can still send.`, action: { label: "Agent permissions", href: "/app/settings/agents" }, severity: "partial" });
  return out;
}

export const AGENT_NAMES: Record<Agent, string> = { sales: "Sales", recruiter: "Recruiter", dispatch: "Dispatch", retention: "Retention", quality: "Quality" };

export function stateOf(input: StateInput): BusinessState {
  const sendable = nativeReady(input) || quoReady(input);
  if (sendable) return blockersOf(input).some((row) => row.severity === "blocks") ? "sending_unavailable" : "ready";
  const request = input.request;
  if (!request) return input.setupStarted ? "setup_in_progress" : "not_configured";
  switch (request.status) {
    case "requested":
      return "submitted";
    case "approved":
    case "provisioning":
    case "waiting_on_carriers":
    case "failed":
      return request.campaignApprovedAt !== undefined ? "approved" : "under_review";
    case "needs_you":
    case "rejected":
      return "changes_needed";
    case "active":
    case "interrupted":
      return "sending_unavailable";
    case "cancelled":
      return "setup_in_progress";
    case "released":
      return input.setupStarted ? "setup_in_progress" : "not_configured";
  }
  return "not_configured";
}

/** The one thing to do next, by state. */
export function nextActionOf(state: BusinessState, blockers: Blocker[]): { label: string; href: string } | null {
  const first = blockers.find((row) => row.severity === "blocks" && row.action);
  if (state === "sending_unavailable" && first?.action) return first.action;
  switch (state) {
    case "not_configured":
      return { label: "Set up business texting", href: SETUP_HREF };
    case "setup_in_progress":
      return { label: "Continue setup", href: SETUP_HREF };
    case "changes_needed":
      return { label: "See what's needed", href: SETUP_HREF };
    case "submitted":
    case "under_review":
    case "approved":
      return { label: "See progress", href: SETUP_HREF };
    default:
      return null;
  }
}

/** Which connection carries each agent's new texts, or none, and whether the agent is paused. */
export function workflowRoutes(input: StateInput): { agent: Agent; name: string; via: "quo" | "selestial" | "none"; paused: boolean }[] {
  return AGENTS.map((agent) => {
    const viaQuo = quoReady(input) && (input.quo!.agents as readonly string[]).includes(agent);
    const via = viaQuo ? "quo" : nativeReady(input) ? "selestial" : "none";
    return { agent, name: AGENT_NAMES[agent], via, paused: input.company.pausedAgents.includes(agent) };
  });
}
