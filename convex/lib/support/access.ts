/**
 * The server side of a support session (docs/operations/03-support-sessions.md). A request reaches a
 * company's functions through a session only when every one of these holds, checked on every call:
 *
 *  - the request names the session (`supportSessionId`); a session is never found any other way, so a
 *    staff member's other tabs keep their own context and nothing changes company behind their back;
 *  - the session is for this company, has not ended and has not expired;
 *  - the caller is the staff member who started it, still active, still holding workspace.view;
 *  - it acts through that company's support row, never through anyone's membership.
 *
 * Writes need more (convex/lib/builders.ts): Manage mode, the function's own support rule, the rule's
 * capability, and for sensitive actions a fresh sign-in with a second factor.
 */
import type { UserIdentity } from "convex/server";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { signedIn, staffFor } from "../builders";
import { notFound, userError } from "../errors";
import { hasCapability, type StaffCapability } from "./capabilities";
import { STRONG_MINUTES, type SessionMode } from "./schema";

export type SupportContext = {
  sessionId: Id<"supportSessions">;
  staffId: Id<"staff">;
  mode: SessionMode;
  session: Doc<"supportSessions">;
  staff: Doc<"staff">;
};

/** What a company function declares it lets a support session do. No rule: support may not call it. */
export type SupportRule = {
  capability: StaffCapability;
  /** Readable, for the owner's support access history: "Updated booking settings". */
  summary: string;
  /** Needs a fresh sign-in and second factor (sending, publishing, money, authority). */
  sensitive?: boolean;
};

export const ENDED = "This support session has ended. Return to the staff console to start another.";

export async function requireSupport(ctx: QueryCtx | MutationCtx, identity: UserIdentity, companyId: Id<"companies">, sessionId: Id<"supportSessions">) {
  const session = await ctx.db.get(sessionId);
  // Another company's session looks like a session that does not exist.
  if (!session || session.companyId !== companyId) notFound();
  const who = signedIn(identity);
  const staff = await staffFor(ctx, who);
  if (!staff || staff === "bootstrap" || staff._id !== session.staffId || staff.userId !== who.userId) notFound();
  if (session.endedAt !== undefined || session.expiresAt <= Date.now()) throw userError(ENDED, "support_ended");
  if (!hasCapability(staff, "workspace.view")) throw userError(ENDED, "support_ended");
  const company = await ctx.db.get(companyId);
  const member = await ctx.db.get(session.memberId);
  if (!company || !member || member.companyId !== companyId || member.status !== "support" || member.supportStaffId !== staff._id) notFound();
  const support: SupportContext = { sessionId: session._id, staffId: staff._id, mode: session.mode, session, staff };
  return { identity, member, company, companyId, support };
}

/**
 * A fresh sign-in with a second factor, from Clerk's `fva` claim (factor verification age, in minutes:
 * [first factor, second factor], -1 when a factor was never used). It is a default claim on every Clerk
 * token, the record's "convex" template included. Without it, nothing sensitive is allowed.
 */
export function strongVerification(identity: UserIdentity): { ok: true } | { ok: false; words: string } {
  const fva = (identity as unknown as { fva?: unknown }).fva;
  if (!Array.isArray(fva) || fva.length < 2 || typeof fva[0] !== "number" || typeof fva[1] !== "number") {
    return { ok: false, words: "Selestial couldn't confirm a recent sign-in with two-step verification. Sign in again, then retry." };
  }
  if (fva[1] < 0) return { ok: false, words: "Turn on two-step verification for your Selestial account, sign in again, then retry." };
  if (fva[0] > STRONG_MINUTES || fva[1] > STRONG_MINUTES) return { ok: false, words: `Your last sign-in was more than ${STRONG_MINUTES} minutes ago. Sign in again with two-step verification, then retry.` };
  return { ok: true };
}

export function requireStrong(identity: UserIdentity) {
  const check = strongVerification(identity);
  if (!check.ok) throw userError(check.words, "verify");
}

/** Secrets and long text never reach the support log. */
const SECRET = /token|secret|password|key|card|cvc|ssn|ein|tax|account|routing|code/i;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 140 ? `${value.slice(0, 139)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 3) return "…";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 25)) out[key] = SECRET.test(key) ? "[removed]" : redact(item, depth + 1);
    return out;
  }
  return String(value);
}

/** Records a change a support session made, for staff and for the owner's history, and counts it. */
export async function recordSupportChange(ctx: MutationCtx, support: SupportContext, rule: SupportRule, args: Record<string, unknown>) {
  const now = Date.now();
  const detail = JSON.stringify(redact(args)).slice(0, 1500);
  await ctx.db.insert("supportActions", { sessionId: support.sessionId, companyId: support.session.companyId, staffId: support.staffId, kind: rule.sensitive ? "external" : "changed", summary: rule.summary, detail, capability: rule.capability, at: now });
  const session = await ctx.db.get(support.sessionId);
  if (session) await ctx.db.patch(session._id, { changes: session.changes + 1 });
}
