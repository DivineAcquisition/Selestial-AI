/**
 * "Build my workspace": one action that coordinates the two existing workers behind it, and one honest
 * picture of what they made. Pure, so the server, the screen and the tests agree.
 *
 *  - Business configuration (convex/configure.ts) prepares service drafts and booking form drafts.
 *  - Activation (convex/activation.ts) runs the agents' first internal work: answers, a role draft, a
 *    coverage review, a customer review.
 *
 * Each outcome uses only the parts that move it forward. When configuration prepares services or booking
 * forms, the activation tasks that would also make them are left out, so nothing is made twice.
 *
 * Every item ends in one truthful state. Failed, waiting and needs-input items are never counted as
 * prepared, and "Published" is only said when the record itself is published.
 */
import type { TaskState } from "../activation/schema";
import type { OutputKind } from "../configure/schema";
import type { Agent } from "../statuses";
import type { Priority } from "./schema";

export type BuildPlan = {
  /** Kinds of business configuration this outcome needs. */
  configure: OutputKind[];
  /** Activation templates left out because configuration makes the same thing. */
  exclude: string[];
};

const CONFIGURE_FOR: Record<Priority, OutputKind[]> = {
  sales: ["services", "booking"],
  pricing: ["services"],
  booking: ["services", "booking"],
  dispatch: [],
  recruiter: [],
  retention: [],
};

/** What configuration makes, by the activation template that would otherwise make it too. */
const SAME_AS: Partial<Record<OutputKind, string[]>> = { services: ["sales.service_draft"], booking: ["sales.booking_page"], agreements: ["sales.agreement_draft"] };

export function buildPlan(outcome: Priority, hasCategories: boolean, secondary: Priority[] = []): BuildPlan {
  // Configuration needs to know who they clean for; without it, activation's own drafts are used instead.
  // Additional priorities add the drafts they need (a booking form for "Launch my booking form").
  const wanted = new Set([outcome, ...secondary].flatMap((value) => CONFIGURE_FOR[value]));
  const configure = hasCategories ? (["services", "booking"] as OutputKind[]).filter((kind) => wanted.has(kind)) : [];
  return { configure, exclude: configure.flatMap((kind) => SAME_AS[kind] ?? []) };
}

/** Shown before the owner presses Build, so they know exactly what it does and does not do. */
export function buildSentence(outcome: Priority, plan: BuildPlan, agentWork: string[]): string {
  const parts: string[] = [];
  if (plan.configure.includes("services")) parts.push("your service drafts");
  if (plan.configure.includes("booking")) parts.push("a booking form preview");
  const lead: Record<Priority, string> = {
    sales: "your first Sales setup",
    dispatch: "your first Dispatch coverage review",
    recruiter: "your first hiring role draft",
    retention: "your first Retention review",
    pricing: "your pricing review",
    booking: "the checks your booking form needs to go live",
  };
  if (agentWork.length || outcome === "pricing" || outcome === "booking") parts.push(lead[outcome]);
  const list = parts.length <= 1 ? (parts[0] ?? lead[outcome]) : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  return `We'll prepare ${list} using the details you confirmed.`;
}

// ── One picture of the work ─────────────────────────────────────────────────────────────────────────

export type BuildState = "preparing" | "ready" | "needs_input" | "waiting_connection" | "failed" | "published" | "done" | "not_available";

export const BUILD_STATE_WORDS: Record<BuildState, string> = {
  preparing: "Preparing",
  ready: "Ready to review",
  needs_input: "Needs your input",
  waiting_connection: "Waiting for a connection",
  failed: "Failed, retry available",
  published: "Published",
  done: "Done",
  not_available: "Not available",
};

export type BuildOutput = { label: string; href: string; state: string; flags: string[] };

export type BuildItem = {
  key: string;
  source: "configure" | "activation";
  agent: Agent | null;
  title: string;
  state: BuildState;
  /** What it is doing or why it waits, in one sentence. */
  words: string;
  outputs: BuildOutput[];
  /** The one next thing to do, when there is one. */
  action: { label: string; href: string } | null;
  /** How to try again, for a failed or blocked item. */
  retry: { kind: "configure"; outputKind: OutputKind } | { kind: "activation"; taskId: string } | null;
};

export type CardLike = {
  kind: OutputKind;
  status: "not_started" | "preparing" | "ready" | "needs_info" | "approved" | "published" | "failed";
  items: { label: string; href: string; status: string; detail: string; flags: string[] }[];
  missing: { words: string; href: string }[];
  error: string | null;
};

const CARD_TITLE: Record<OutputKind, string> = { services: "Service drafts", booking: "Booking form preview", agreements: "Agreement drafts", standards: "Job standards" };

export function fromCard(card: CardLike): BuildItem | null {
  if (card.status === "not_started") return null;
  const state: BuildState =
    card.status === "preparing" ? "preparing" : card.status === "failed" ? "failed" : card.status === "needs_info" ? "needs_input" : card.status === "published" ? "published" : "ready";
  const outputs = card.items.map((item) => ({ label: item.label, href: item.href, state: item.detail, flags: item.flags }));
  const missing = card.missing[0] ?? null;
  const words =
    state === "preparing"
      ? card.kind === "booking"
        ? "Waits for your service drafts, then offers them."
        : "Preparing from the details you confirmed."
      : state === "failed"
        ? `This couldn't be prepared${card.error ? `: ${card.error}` : ""}. Everything else is unaffected.`
        : state === "needs_input"
          ? (missing?.words ?? "Something only you can decide is still open.")
          : state === "published"
            ? "Live for customers."
            : `${outputs.length} ready for your review. Nothing is published until you publish it.`;
  return {
    key: `configure:${card.kind}`,
    source: "configure",
    agent: card.kind === "standards" ? "quality" : "sales",
    title: CARD_TITLE[card.kind],
    state,
    words,
    outputs,
    action: state === "needs_input" && missing ? { label: "Add what's missing", href: missing.href } : state === "ready" && outputs[0] ? { label: "Preview and review", href: outputs[0].href } : null,
    retry: state === "failed" ? { kind: "configure", outputKind: card.kind } : null,
  };
}

export type TaskLike = {
  id: string;
  template: string;
  agent: Agent;
  title: string;
  state: TaskState;
  statusLine: string;
  outputs: { kind: string; ref: { label: string; href: string }; state: string; flags?: string[] }[];
  blocker: { kind: string; words: string; action: { label: string; href: string } } | null;
};

export function fromTask(task: TaskLike): BuildItem {
  const outputs = task.outputs.map((o) => ({ label: o.ref.label, href: o.ref.href, state: o.state, flags: o.flags ?? [] }));
  const published = outputs.length > 0 && outputs.every((o) => o.state === "published" || o.state === "active");
  const state: BuildState =
    task.state === "queued" || task.state === "working"
      ? "preparing"
      : task.state === "failed"
        ? "failed"
        : task.state === "waiting_info"
          ? "needs_input"
          : task.state === "waiting_connection"
            ? "waiting_connection"
            : task.state === "paused" || task.state === "unavailable" || task.state === "canceled"
              ? "not_available"
              : published
                ? "published"
                : outputs.length
                  ? "ready"
                  : "done";
  return {
    key: `activation:${task.template}`,
    source: "activation",
    agent: task.agent,
    title: task.title,
    state,
    words: task.blocker?.words ?? task.statusLine,
    outputs,
    action: task.blocker ? task.blocker.action : state === "ready" && outputs[0] ? { label: "Preview and review", href: outputs[0].href } : null,
    retry: state === "failed" || state === "needs_input" || state === "waiting_connection" ? { kind: "activation", taskId: task.id } : null,
  };
}

export type BuildCounts = { total: number; preparing: number; ready: number; needsInput: number; waitingConnection: number; failed: number; published: number; notAvailable: number; usable: number };

/** Counted from the states, once each. Only ready and published work with something to open counts as usable. */
export function summarize(items: BuildItem[]): BuildCounts {
  const n = (state: BuildState) => items.filter((item) => item.state === state).length;
  return {
    total: items.length,
    preparing: n("preparing"),
    ready: n("ready"),
    needsInput: n("needs_input"),
    waitingConnection: n("waiting_connection"),
    failed: n("failed"),
    published: n("published"),
    notAvailable: n("not_available"),
    usable: items.filter((item) => (item.state === "ready" || item.state === "published") && item.outputs.length > 0).length,
  };
}

/** The items that answer each outcome first, in order. */
const LEAD: Record<Priority, string[]> = {
  sales: ["configure:booking", "activation:sales.booking_page", "activation:sales.faq_answers", "activation:sales.inquiry_follow_through", "configure:services"],
  pricing: ["configure:services", "activation:sales.service_draft"],
  booking: ["configure:booking", "activation:sales.booking_page", "configure:services"],
  dispatch: ["activation:dispatch.coverage_review", "activation:dispatch.readiness"],
  recruiter: ["activation:recruiter.role_draft", "activation:recruiter.applicant_review"],
  retention: ["activation:retention.review", "activation:retention.care_setup"],
};

/**
 * The result to lead with: the outcome's own work, preferring one that is usable now, then one that needs
 * the owner. Other items follow, usable first, so a failed or blocked item never hides a good one.
 */
export function ordered(outcome: Priority, items: BuildItem[]): { lead: BuildItem | null; rest: BuildItem[] } {
  const rank = (item: BuildItem) => {
    const at = LEAD[outcome].indexOf(item.key);
    return at === -1 ? 100 : at;
  };
  const usable = (item: BuildItem) => (item.state === "ready" || item.state === "published") && item.outputs.length > 0;
  const own = items.filter((item) => rank(item) < 100).sort((a, b) => Number(usable(b)) - Number(usable(a)) || rank(a) - rank(b));
  const lead = own[0] ?? null;
  const order: BuildState[] = ["ready", "published", "needs_input", "waiting_connection", "preparing", "failed", "done", "not_available"];
  const rest = items.filter((item) => item !== lead).sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || rank(a) - rank(b));
  return { lead, rest };
}

const READY_HEADLINE: Record<string, string> = {
  "configure:booking": "Your booking form draft is ready",
  "activation:sales.booking_page": "Your booking form draft is ready",
  "configure:services": "Your service drafts are ready",
  "activation:sales.service_draft": "Your service draft is ready",
  "activation:sales.faq_answers": "Answers to common customer questions are ready",
  "activation:sales.inquiry_follow_through": "Follow-ups for your open inquiries are ready",
  "activation:recruiter.role_draft": "Your hiring role draft is ready",
  "activation:recruiter.applicant_review": "Your applicants are ready to review",
  "activation:dispatch.coverage_review": "Your coverage review is ready",
  "activation:dispatch.readiness": "Your dispatch setup is ready",
  "activation:retention.review": "Your customer review is ready",
  "activation:retention.care_setup": "Your follow-up setup is ready",
};

/** The headline for the lead result, in the owner's words, saying what that item actually is. */
export function leadHeadline(_outcome: Priority, lead: BuildItem | null): string {
  if (!lead) return "Your workspace is being prepared";
  if (lead.state === "preparing") return `${lead.title}: preparing now`;
  if (lead.state === "failed") return `${lead.title} couldn't be prepared`;
  if (lead.state === "needs_input" || lead.state === "waiting_connection") return `${lead.title} needs one thing from you`;
  if (lead.state === "published") return `${lead.title} is live`;
  return READY_HEADLINE[lead.key] ?? `${lead.title} is ready`;
}
