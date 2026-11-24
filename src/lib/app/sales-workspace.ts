/**
 * Where the Sales workspace sits in the navigation, and where its back link goes. Pure, so the rules are
 * tested once and every entry point uses the same ones.
 *
 * One workspace (/app/agents/sales/book/[draftId]) serves bookings and proposals. Its address says nothing
 * about which, so the draft's mode decides the tab: a booking belongs to Internal Booking, a proposal to
 * Quotes & Proposals (SALES_WORKSPACE_TAB). The back link follows the person, not the draft: `from` is where
 * they came from this time (a query parameter), then where the draft was first started, then the draft's
 * own tab.
 */
import { SALES_WORKSPACE_TAB, tabPath } from "./navigation";
import type { NavOwner } from "./navigation-helpers";

export type WorkspaceMode = keyof typeof SALES_WORKSPACE_TAB;

/** The Sales tab a draft in this mode belongs to. */
export function workspaceOwner(mode: WorkspaceMode): NavOwner {
  return { agent: "sales", tab: SALES_WORKSPACE_TAB[mode] };
}

export const INTERNAL_BOOKING_PATH = tabPath("sales", "internal-booking");
export const QUOTES_PATH = tabPath("sales", "quotes-proposals");

/** The places a workspace can be entered from, as the `from` the entry point passes. Anything else is ignored. */
const RETURNS: Record<string, { href: string | ((id?: string) => string); label: string }> = {
  "internal-booking": { href: INTERNAL_BOOKING_PATH, label: "Internal Booking" },
  quotes: { href: QUOTES_PATH, label: "Quotes & Proposals" },
  pipeline: { href: tabPath("sales", "pipeline"), label: "Pipeline" },
  "sales-agent": { href: "/app/agents/sales", label: "Sales" },
  customer: { href: (id) => (id && /^[a-z0-9]+$/i.test(id) ? `/app/clients/${id}` : "/app/clients"), label: "the customer" },
  clients: { href: "/app/clients", label: "Clients & Properties" },
  calendar: { href: "/app/calendar", label: "Calendar" },
  dispatch: { href: tabPath("dispatch", "schedule"), label: "Dispatch" },
};

export function isWorkspaceEntry(from: string | null | undefined): from is string {
  return typeof from === "string" && Object.hasOwn(RETURNS, from);
}

/**
 * Where the workspace's back link goes and what it says. `from` is this visit's entry point; `entry` is the
 * one stored when the draft was started (with the customer or opportunity it came from).
 */
export function workspaceReturn(input: { mode: WorkspaceMode; from?: string | null; entry?: { from: string; id?: string } | null }): { href: string; label: string } {
  const pick = isWorkspaceEntry(input.from) ? { from: input.from, id: input.from === input.entry?.from ? input.entry?.id : undefined } : isWorkspaceEntry(input.entry?.from) ? { from: input.entry!.from, id: input.entry!.id } : null;
  if (pick) {
    const target = RETURNS[pick.from];
    return { href: typeof target.href === "function" ? target.href(pick.id) : target.href, label: target.label };
  }
  return input.mode === "booking" ? { href: INTERNAL_BOOKING_PATH, label: "Internal Booking" } : { href: QUOTES_PATH, label: "Quotes & Proposals" };
}

/** The workspace for a draft, remembering where this visit came from. */
export function workspaceHref(draftId: string, from?: string): string {
  return `/app/agents/sales/book/${draftId}${from && isWorkspaceEntry(from) ? `?from=${from}` : ""}`;
}

/** The browser tab's title for a draft: its name, then the tab it belongs to. */
export function workspaceTitle(name: string, mode: WorkspaceMode): string {
  return `${name} · ${mode === "booking" ? "Internal Booking" : "Quotes & Proposals"} · Selestial`;
}
