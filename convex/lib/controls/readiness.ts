/**
 * What each action can actually do right now (docs/foundation/07-agent-controls.md §Effective status).
 *
 * The owner's choice, whether the code exists, whether the plan allows it, whether its connections and data
 * are ready, and whether a pause, a limit or a temporary level stops it are kept apart, then combined into
 * one status with a reason and a next step. Every check here is the one execution uses:
 *
 *  - level, pause, temporary expiry, unavailable: authorityFor (convex/lib/authority.ts)
 *  - texting and email: senderGaps, the send policy's own first check, and the deployment's providers
 *  - action links: linksConfigured, without which an offer or application link is not made
 *  - pricing: an active published service, without which priceOpportunity finds nothing to quote
 *  - plan: agentVerdict, applied at execution to work that opens an AI execution
 *  - allowance: the ledger permitFor reserves from (convex/lib/controls/allowance.ts)
 *
 * Missing data is never readiness: a check that cannot be made counts as not ready.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { agentVerdict } from "../billing/access";
import { readProfile } from "../compliance/profile";
import { linksConfigured } from "../dispatch/links";
import { emailProvider } from "../messaging/email";
import { senderGaps } from "../messaging/policy";
import { messagingProvider } from "../messaging/provider";
import { emailOn, preferencesOf } from "../notify/preferences";
import { actionDef, rank, type ActionDef } from "../permissionCatalog";
import { roleOf } from "../roles";
import type { Agent } from "../statuses";
import { allowanceToday, type AllowanceState } from "./allowance";
import { capabilityOf, type Need } from "./capabilities";
import { LEVEL_WORDS } from "./policy";
import type { PermissionSnapshot } from "./schema";

export type Status = "ready" | "approval_required" | "setup_required" | "paused" | "limit_reached" | "unavailable" | "off";

export const STATUS_WORDS: Record<Status, string> = {
  ready: "Ready",
  approval_required: "Approval required",
  setup_required: "Setup required",
  paused: "Paused",
  limit_reached: "Limit reached",
  unavailable: "Unavailable",
  off: "Off",
};

export type Facts = {
  company: Doc<"companies">;
  now: number;
  sms: { ok: boolean; words: string };
  email: { ok: boolean; words: string };
  links: boolean;
  pricing: boolean;
  google: { ads: boolean; business: boolean };
  plan: Record<Agent, { ok: boolean; words: string | null }>;
};

/** Everything the checks need, read once per request. */
export async function factsFor(ctx: QueryCtx, company: Doc<"companies">, now: number): Promise<Facts> {
  const profile = await readProfile(ctx, company._id);
  const smsGaps = senderGaps(profile.messaging, "sms");
  const emailGaps = senderGaps(profile.messaging, "email");
  const textProvider = messagingProvider() !== null;
  const mailProvider = emailProvider() !== null;
  const service = await ctx.db
    .query("services")
    .withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", "active"))
    .first();
  const google = async (feature: "ads" | "business_profile") =>
    (
      await ctx.db
        .query("googleConnections")
        .withIndex("by_company_feature", (q) => q.eq("companyId", company._id).eq("feature", feature))
        .take(5)
    ).some((row) => row.status === "connected");
  const verdict = (agent: Agent) => {
    const v = agentVerdict(company, agent);
    return v.ok ? { ok: true, words: null } : { ok: false, words: v.message };
  };
  return {
    company,
    now,
    sms: !textProvider ? { ok: false, words: "Texting isn't connected for Selestial yet." } : smsGaps.length ? { ok: false, words: smsGaps.map((gap) => gap.words).join(" ") } : { ok: true, words: "Business texting is ready." },
    email: !mailProvider ? { ok: false, words: "Email isn't connected for Selestial yet." } : emailGaps.length ? { ok: false, words: emailGaps.map((gap) => gap.words).join(" ") } : { ok: true, words: "Email is ready." },
    links: linksConfigured(),
    pricing: service !== null,
    google: { ads: await google("ads"), business: await google("business_profile") },
    plan: { dispatch: verdict("dispatch"), sales: verdict("sales"), recruiter: verdict("recruiter"), retention: verdict("retention"), quality: verdict("quality"), "customer-care": verdict("customer-care") },
  };
}

export type Check = { need: Need; ok: boolean; words: string; next?: { label: string; href: string } };

export function checkNeed(need: Need, facts: Facts): Check {
  switch (need) {
    case "sms":
      return { need, ok: facts.sms.ok, words: facts.sms.ok ? "business texting" : facts.sms.words, ...(facts.sms.ok ? {} : { next: { label: "Set up business texting", href: "/app/texting" } }) };
    case "email":
      return { need, ok: facts.email.ok, words: facts.email.ok ? "email" : facts.email.words, ...(facts.email.ok ? {} : { next: { label: "Open Email & texting", href: "/app/settings/messaging" } }) };
    case "outreach": {
      const ok = facts.sms.ok || facts.email.ok;
      return { need, ok, words: ok ? (facts.sms.ok && facts.email.ok ? "texting and email" : facts.sms.ok ? "business texting" : "email") : `Neither texting nor email can reach customers yet. ${facts.sms.words}`, ...(ok ? {} : { next: { label: "Set up business texting", href: "/app/texting" } }) };
    }
    case "links":
      return { need, ok: facts.links, words: facts.links ? "action links" : "Action links aren't set up on Selestial's side yet, so the link a person answers with can't be made.", ...(facts.links ? {} : { next: { label: "Contact Selestial support", href: "/app/settings/compliance" } }) };
    case "pricing":
      return { need, ok: facts.pricing, words: facts.pricing ? "published prices" : "No service has published prices yet, so nothing can be quoted from your rules.", ...(facts.pricing ? {} : { next: { label: "Publish your services and prices", href: "/app/services" } }) };
    case "google_ads":
      return { need, ok: facts.google.ads, words: facts.google.ads ? "Google Ads" : "Google Ads isn't connected.", ...(facts.google.ads ? {} : { next: { label: "Connect Google Ads", href: "/app/settings/integrations?tool=ads" } }) };
    case "google_business":
      return { need, ok: facts.google.business, words: facts.google.business ? "Google Business Profile" : "Google Business Profile isn't connected.", ...(facts.google.business ? {} : { next: { label: "Connect Google Business Profile", href: "/app/settings/integrations?tool=business_profile" } }) };
  }
}

export type Effective = {
  status: Status;
  words: string;
  /** The specific explanation. */
  reason: string;
  next: { label: string; href: string } | null;
  checks: Check[];
  allowance: (AllowanceState & { perDayCents: number; perActionCents: number | null }) | null;
  /** A temporary level that ran out: the action asks first now. */
  expired: boolean;
};

const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

/** One action's effective status, from the owner's setting and the facts. */
export async function effective(ctx: QueryCtx, def: ActionDef, snap: PermissionSnapshot, facts: Facts): Promise<Effective> {
  const capability = capabilityOf(def.key);
  const company = facts.company;
  const checks = capability.needs.map((need) => checkNeed(need, facts));
  const base = { checks, allowance: null as Effective["allowance"], expired: false };
  const label = lower(def.label);
  if (!capability.implemented) return { ...base, status: "unavailable", words: STATUS_WORDS.unavailable, reason: capability.unavailable ?? "This isn't something an agent can do.", next: null };
  if (company.suspendedAt !== undefined) return { ...base, status: "paused", words: STATUS_WORDS.paused, reason: "Selestial has suspended this company's outbound activity. Nothing runs until it is lifted.", next: { label: "Contact Selestial support", href: "/app/settings/compliance" } };
  if (company.pausedAgents.includes(def.agent)) return { ...base, status: "paused", words: STATUS_WORDS.paused, reason: `The agent is paused, so it won't ${label} on its own. Inbound messages, delivery reports and opt-outs keep working.`, next: { label: "Resume the agent", href: "/app/settings/agents" } };
  if (snap.level === "off") return { ...base, status: "off", words: STATUS_WORDS.off, reason: "Switched off. The agent leaves this to your team.", next: null };
  if (capability.ai && !facts.plan[def.agent].ok) return { ...base, status: "unavailable", words: STATUS_WORDS.unavailable, reason: facts.plan[def.agent].words ?? "Your plan doesn't include this.", next: { label: "Open Plan & Usage", href: "/app/settings/billing" } };
  const missing = checks.filter((check) => !check.ok);
  if (missing.length) return { ...base, status: "setup_required", words: STATUS_WORDS.setup_required, reason: `Blocked: ${missing.map((check) => check.words).join(" ")}`, next: missing[0].next ?? null };
  const expired = snap.until !== undefined && facts.now >= snap.until && rank(snap.level) > rank("propose");
  const level = expired ? "propose" : snap.level;
  let allowance: Effective["allowance"] = null;
  if (def.money && snap.perDayCents !== undefined) {
    const today = await allowanceToday(ctx, company, def.key, facts.now);
    allowance = { ...today, perDayCents: snap.perDayCents, perActionCents: snap.perActionCents ?? null };
  }
  const using = checks.map((check) => check.words).join(" and ");
  const ready = checks.length ? ` ${using.charAt(0).toUpperCase()}${using.slice(1)} ${checks.length === 1 ? "is" : "are"} ready.` : "";
  if (level === "propose") {
    return { ...base, allowance, expired, status: "approval_required", words: STATUS_WORDS.approval_required, reason: expired ? `The temporary ${LEVEL_WORDS[snap.level]} ended, so the agent prepares this and asks first.${ready}` : `The agent prepares this and waits for a decision.${ready}`, next: null };
  }
  if (allowance && allowance.usedCents >= allowance.perDayCents) {
    return { ...base, allowance, status: "limit_reached", words: STATUS_WORDS.limit_reached, reason: "Today's limit is used up, so anything more goes to approval until it resets at midnight.", next: null };
  }
  return { ...base, allowance, status: "ready", words: STATUS_WORDS.ready, reason: `${level === "execute" ? "It does this without asking." : "It does this without asking and emails a report each time."}${ready}`, next: null };
}

// ── Who decides, and who is told ─────────────────────────────────────────────────────────────────

/** Approvals only an Owner may decide, whatever the routing (convex/approvals.ts decide). */
export const OWNER_DECIDES = new Set(["retention.refund_above_limit", "sales.discount_out_of_band"]);

export type Approvers = { words: string; people: { memberId: Id<"members">; name: string; role: string }[]; warning: string | null };

/** Who can decide this action's approvals now, after removed members and changed roles. */
export async function approversFor(ctx: QueryCtx, company: Doc<"companies">, snap: PermissionSnapshot, members?: Doc<"members">[]): Promise<Approvers> {
  const all =
    members ??
    (await ctx.db
      .query("members")
      .withIndex("by_company", (q) => q.eq("companyId", company._id))
      .collect());
  const active = all.filter((m) => m.status === "active");
  const owners = active.filter((m) => roleOf(m.role) === "owner");
  const deciders = active.filter((m) => roleOf(m.role) === "owner" || roleOf(m.role) === "manager");
  const person = (m: Doc<"members">) => ({ memberId: m._id, name: m.name, role: roleOf(m.role) });
  if (OWNER_DECIDES.has(snap.action) || snap.approver?.kind === "owner") {
    return { words: OWNER_DECIDES.has(snap.action) ? "Owners only (always, for this action)" : "Owners only", people: owners.map(person), warning: null };
  }
  if (snap.approver?.kind === "member") {
    const primary = deciders.find((m) => m._id === (snap.approver as { memberId: Id<"members"> }).memberId);
    const backup = snap.backupMemberId ? deciders.find((m) => m._id === snap.backupMemberId) : undefined;
    const people = [primary, backup, ...owners].filter((m): m is Doc<"members"> => Boolean(m)).filter((m, i, list) => list.findIndex((x) => x._id === m._id) === i);
    if (!primary) {
      return {
        words: backup ? `${backup.name} (backup), or any Owner` : "Any Owner or Manager",
        people: backup ? people.map(person) : deciders.map(person),
        warning: "The person chosen to decide is no longer an active Owner or Manager, so their approvals go to the backup or any Owner or Manager.",
      };
    }
    return { words: `${primary.name}${backup ? `, with ${backup.name} as backup` : ""}, or any Owner`, people: people.map(person), warning: snap.backupMemberId && !backup ? "The backup is no longer an active Owner or Manager." : null };
  }
  return { words: `Any Owner or Manager (${deciders.length} ${deciders.length === 1 ? "person" : "people"})`, people: deciders.map(person), warning: null };
}

/** Whether this member may decide an approval for this action, by the routing (owner-only kinds are checked separately). */
export async function mayDecide(ctx: QueryCtx, company: Doc<"companies">, action: string, member: Doc<"members">): Promise<{ ok: true } | { ok: false; words: string }> {
  const role = roleOf(member.role);
  if (role === "owner") return { ok: true };
  if (role !== "manager") return { ok: false, words: "Only an Owner or Manager decides approvals." };
  const def = actionDef(action);
  if (!def) return { ok: true };
  const row = await ctx.db
    .query("permissions")
    .withIndex("by_company_action", (q) => q.eq("companyId", company._id).eq("action", action))
    .unique();
  if (!row?.approver) return { ok: true };
  if (row.approver.kind === "owner") return { ok: false, words: "Only an Owner decides this. The Owner chose that in Agent Controls." };
  const approvers = await approversFor(ctx, company, { action, level: row.level, approver: row.approver, backupMemberId: row.backupMemberId });
  return approvers.people.some((p) => p.memberId === member._id) ? { ok: true } : { ok: false, words: `This is decided by ${approvers.words}. The Owner chose that in Agent Controls.` };
}

/** Who gets the email when an agent set to "Act and notify me" acts: active Owners and Managers with "What your agents did" on. */
export async function reportRecipients(ctx: QueryCtx, company: Doc<"companies">, members?: Doc<"members">[]) {
  const all =
    members ??
    (await ctx.db
      .query("members")
      .withIndex("by_company", (q) => q.eq("companyId", company._id))
      .collect());
  const audience = all.filter((m) => m.status === "active" && (roleOf(m.role) === "owner" || roleOf(m.role) === "manager"));
  const on: string[] = [];
  const off: string[] = [];
  for (const m of audience) (emailOn(await preferencesOf(ctx, company._id, m._id), "activity", roleOf(m.role)) ? on : off).push(m.name);
  return { on, off, channel: "Email, outside night hours on your company's clock", settings: "/app/settings/notifications" };
}
