/**
 * Giving a texting number up (docs/texting/03-offboarding.md): the owner's request to release it or to move
 * it to another provider, and the work item Selestial opens for itself when a plan is cancelled.
 *
 * Everything here is a record and a work item for Selestial staff. Nothing in this file calls Telnyx, and
 * nothing is released or moved by asking: staff act from the staff console (convex/texting.ts), and a release
 * needs the owner's own acceptance, in the exact words below, recorded for exactly the number released.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { recordEvent } from "../events";

const DAY = 86_400_000;

export const OFFBOARDING_ROUTES = ["release", "port_out"] as const;
export type OffboardingRoute = (typeof OFFBOARDING_ROUTES)[number];

/** The exact words an owner accepts before asking for their number to be released. */
export const RELEASE_WORDING =
  "I understand that releasing my texting number is permanent: the number can't be recovered, people who text or call it won't reach my business, and its carrier registration ends. The number keeps working, and its monthly number and registration fees continue, until Selestial completes the release. Setup fees already paid aren't refunded.";

/** The exact words an owner accepts before asking to move their number to another provider. */
export const PORT_OUT_WORDING =
  "I understand that my new provider starts the transfer of my number and that it typically takes several business days. Until the transfer completes, Selestial keeps the number active and won't release it, and its monthly number and registration fees continue. Once it completes, Selestial no longer sends texts from this number. Setup fees already paid aren't refunded.";

export const wordingFor = (route: OffboardingRoute) => (route === "release" ? RELEASE_WORDING : PORT_OUT_WORDING);

/** A request whose number is bought and connected: the only kind that has a number to give up. */
export const HAS_NUMBER: Doc<"textingRequests">["status"][] = ["active", "interrupted"];

type Ctx = QueryCtx | MutationCtx;

export const isOffboarding = (row: Doc<"textingExceptions">): row is Doc<"textingExceptions"> & { assisted: NonNullable<Doc<"textingExceptions">["assisted"]> & { route: OffboardingRoute } } =>
  row.assisted?.route === "release" || row.assisted?.route === "port_out";

/** The company's request that has a number, if any (the newest one). */
export async function numberRequest(ctx: Ctx, companyId: Id<"companies">): Promise<Doc<"textingRequests"> | null> {
  const rows = await ctx.db
    .query("textingRequests")
    .withIndex("by_company_requested", (q) => q.eq("companyId", companyId))
    .order("desc")
    .take(20);
  return rows.find((row) => HAS_NUMBER.includes(row.status)) ?? null;
}

/** Open requests to give this number up, newest first. */
export async function openOffboarding(ctx: Ctx, companyId: Id<"companies">, phoneNumber: string) {
  const rows = await ctx.db
    .query("textingExceptions")
    .withIndex("by_company_updated", (q) => q.eq("companyId", companyId))
    .order("desc")
    .take(200);
  return rows.filter((row) => row.state !== "resolved" && isOffboarding(row) && row.assisted.phoneNumber === phoneNumber);
}

/** Whether the owner's own acceptance is on this item, in the exact words, for exactly this number. */
export function authorizedFor(row: Doc<"textingExceptions">, route: OffboardingRoute, phoneNumber: string): boolean {
  return row.state !== "resolved" && row.assisted?.route === route && row.assisted.phoneNumber === phoneNumber && row.assisted.authorization?.wording === wordingFor(route);
}

export const OWNER_WORDS: Record<OffboardingRoute, (number: string) => string> = {
  release: (number) => `You asked Selestial to release ${number}. Until the release completes, the number keeps working and its monthly fees continue. You can cancel this request until Selestial starts the release.`,
  port_out: (number) => `You asked to move ${number} to another provider. Your new provider starts the transfer. Until it completes, Selestial keeps the number active, won't release it, and its monthly fees continue.`,
};

/**
 * A plan was cancelled while the company still has a texting number. Opens a work item for Selestial staff,
 * once per number, so the number, its registration and their fees are not forgotten. It carries NO
 * authorization: nothing is released because of it. Only the owner's own request can authorize a release.
 */
export async function openPlanCancelledWork(ctx: MutationCtx, companyId: Id<"companies">, why: "owner_cancelled" | "unpaid"): Promise<Id<"textingExceptions"> | null> {
  const request = await numberRequest(ctx, companyId);
  if (!request) return null;
  const existing = await openOffboarding(ctx, companyId, request.phoneNumber);
  if (existing.length > 0) return existing[0]._id;
  const setup = await ctx.db
    .query("textingSetups")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .unique();
  const reason = why === "unpaid" ? "Plan cancelled after 30 days unpaid." : "Plan cancelled by the owner.";
  if (!setup) {
    // A request from the older form has no setup to hang a case on: the event is the record, and staff find it there.
    await recordEvent(ctx, { companyId, type: "texting.release_work_needed", actor: { kind: "system" }, subject: { table: "textingRequests", id: request._id }, data: { reason: why, phoneNumber: request.phoneNumber, tracked: false } });
    return null;
  }
  const now = Date.now();
  const id = await ctx.db.insert("textingExceptions", {
    companyId,
    setupId: setup._id,
    requestId: request._id,
    category: "number",
    severity: "medium",
    assignee: { kind: "staff" },
    internalWords: `${reason} The company still has ${request.phoneNumber} and its registration (campaign ${request.campaignId ?? "unknown"}). Telnyx keeps billing Selestial for both, and the monthly fees keep posting to the company while the request is active. Ask the owner whether to release or move the number. Nothing may be released without the owner's own request on the texting screen.`,
    ownerWords: `Your Selestial plan was cancelled, and your texting number ${request.phoneNumber} is still set up. Nothing has been released. Tell Selestial what you'd like done with the number: under "Stop using this number" you can release it or move it to another provider.`,
    blocker: "Nothing is blocked. The number keeps working and its monthly fees continue until it is released or moved.",
    canContinue: "Your number keeps receiving texts. Nothing is released or moved unless you ask.",
    nextAction: "Selestial contacts the owner about the number.",
    followUpAt: now + 2 * DAY,
    state: "waiting_selestial",
    assisted: { route: "release", phoneNumber: request.phoneNumber, source: "plan_cancelled", words: reason },
    history: [{ at: now, state: "waiting_selestial", words: `Opened by Selestial: ${reason}`, by: "system" }],
    reopened: 0,
    createdAt: now,
    updatedAt: now,
  });
  await recordEvent(ctx, { companyId, type: "texting.release_work_needed", actor: { kind: "system" }, subject: { table: "textingRequests", id: request._id }, data: { reason: why, phoneNumber: request.phoneNumber, tracked: true } });
  return id;
}
