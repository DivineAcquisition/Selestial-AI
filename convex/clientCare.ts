/**
 * Client Care's screens and the things a person does on a request (docs/care/00-architecture.md). Every line
 * is read from the records: requests, their history and steps, the messages that actually went, and the
 * records each request links to. No count is an estimate and no saving is claimed.
 *
 * Who sees what follows the shared rules: access instructions are never shown here (they live on the property,
 * for Owners and Managers), and invoice amounts and billing messages are the Owner's, as in Finance.
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { owned } from "./lib/access";
import { authorityFor } from "./lib/authority";
import { agentVerdict } from "./lib/billing/access";
import { companyMutation, companyQuery, ownerMutation, type MemberAccess } from "./lib/builders";
import { stopFollowUps } from "./lib/clients/conversations";
import { careModel } from "./lib/clientCare/model";
import { deliveryWords, heldBy } from "./lib/clientCare/outbox";
import { changeRules } from "./lib/clientCare/policy";
import { addEntry, closeRequest, entriesOf, isOpen, moveRequest, reopenRequest, resolveRequest, STATUS_WORDS, type Request } from "./lib/clientCare/requests";
import { CARE_CATEGORIES, careCategoryValidator, careSettingsValidator, OPEN_STATUSES, REQUEST_STATUSES, requestStatusValidator, type CareCategory } from "./lib/clientCare/schema";
import { careSettings, CATEGORY_WORDS } from "./lib/clientCare/settings";
import { retryMessage, stepsOf } from "./lib/clientCare/steps";
import { advance } from "./lib/clientCare/workflows";
import { senderGaps } from "./lib/messaging/policy";
import { readProfile } from "./lib/compliance/profile";
import { emailProvider } from "./lib/messaging/email";
import { textingProvider } from "./lib/quo/route";
import { purposesOf } from "./lib/inbox/mailboxes";
import { actionDef, ACTIONS } from "./lib/permissionCatalog";
import { capabilityOf } from "./lib/controls/capabilities";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { isManager } from "./lib/roles";
import { optionalText, text } from "./lib/text";
import { businessSettingsOf } from "./lib/settings/business";
import { clock, dayName } from "./lib/time";

type Ctx = QueryCtx & MemberAccess;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const STEP_WORDS: Record<Doc<"careSteps">["status"], string> = {
  proposed: "Prepared",
  awaiting_approval: "Waiting for approval",
  ready: "Under way",
  done: "Done",
  partial: "Done; the message didn't go",
  failed: "Didn't happen",
  blocked: "With a person",
  uncertain: "Not known",
  cancelled: "Set aside",
};

const PART_WORDS: Record<string, string> = { change: "Change", notify: "Client message", record: "Record", handoff: "Hand-off" };

function ownerWords(row: Request, names: Map<string, string>): string {
  if (row.owner.kind === "member") return names.get(row.owner.memberId) ?? "A team member";
  if (row.owner.kind === "specialist") return row.owner.agent;
  if (row.status === "waiting_owner") return "You";
  return row.waiting?.who ?? "Client Care";
}

async function memberNames(ctx: Ctx) {
  const rows = await ctx.db
    .query("members")
    .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
    .take(300);
  return new Map(rows.map((m) => [m._id as string, m.name]));
}

async function card(ctx: Ctx, row: Request, names: Map<string, string>, tz: string) {
  const customer = await ctx.db.get(row.customerId);
  const property = row.propertyId ? await ctx.db.get(row.propertyId) : null;
  const job = row.jobId ? await ctx.db.get(row.jobId) : null;
  return {
    id: row._id,
    customer: { id: row.customerId, name: customer?.name ?? "A former client" },
    writer: row.authority.as === "contact" ? row.authority.name : null,
    property: property ? property.label?.trim() || property.address.line1 : null,
    category: row.category,
    categoryWords: CATEGORY_WORDS[row.category],
    summary: row.summary,
    visit: job ? `${dayName(job.startsAt, tz)} at ${clock(job.startsAt, tz)}` : null,
    status: row.status,
    statusWords: STATUS_WORDS[row.status],
    waiting: row.waiting?.reason ?? null,
    urgency: row.urgency,
    urgencyReason: row.urgencyReason ?? null,
    owner: ownerWords(row, names),
    held: row.owner.kind === "member",
    nextAction: row.nextAction ?? null,
    blocker: row.blocker ?? null,
    promisedBy: row.promised?.by ?? null,
    lastClientAt: row.lastCustomerAt,
    lastUpdateAt: row.lastUpdateAt ?? null,
    channel: row.conversation.channel,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

/** Client Care's state as an agent: running, paused, not in the plan, and how it reads. */
function agentState(company: Doc<"companies">) {
  const verdict = agentVerdict(company, "customer-care");
  const paused = company.pausedAgents.includes("customer-care");
  const model = careModel();
  return {
    paused,
    available: verdict.ok,
    reason: paused ? "Client Care is paused. Messages are kept and shown here; nothing new is worked until it is resumed." : verdict.ok ? null : `${verdict.message} Requests are still recorded for your team.`,
    reader: model.name === "rules" ? "Your company's rules read each message. No AI credits are used." : "An AI reader reads each message when its credits are held; otherwise your rules do.",
  };
}

// ── Overview ───────────────────────────────────────────────────────────────────────────────────

export const overview = companyQuery({
  args: { asOf: v.number() },
  handler: async (ctx, args) => {
    const tz = ctx.company.timezone;
    const names = await memberNames(ctx);
    const open: Request[] = [];
    for (const status of OPEN_STATUSES) {
      const rows = await ctx.db
        .query("careRequests")
        .withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", status))
        .order("desc")
        .take(200);
      open.push(...rows);
    }
    const week = args.asOf - 7 * DAY;
    const resolved = await ctx.db
      .query("careRequests")
      .withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", "resolved").gte("updatedAt", week))
      .take(500);
    const done = await ctx.db
      .query("careSteps")
      .withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", "done").gte("updatedAt", week))
      .take(1000);
    const troubled = [];
    for (const status of ["failed", "partial", "uncertain"] as const) {
      const rows = await ctx.db
        .query("careSteps")
        .withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", status).gte("updatedAt", week))
        .take(50);
      troubled.push(...rows);
    }
    const unread = await ctx.db
      .query("careMessages")
      .withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", "queued"))
      .take(100);
    const created = open.filter((r) => r.createdAt >= args.asOf - DAY).length;
    const decisions = open.filter((r) => r.status === "waiting_owner");
    const blocked = open.filter((r) => r.blocker && r.status !== "waiting_owner");
    const dueUpdates = open.filter((r) => r.promised && r.promised.by <= args.asOf + 4 * HOUR);
    const urgent = open.filter((r) => r.urgency === "urgent");
    const byCategory = CARE_CATEGORIES.map((category) => ({ category, words: CATEGORY_WORDS[category], open: open.filter((r) => r.category === category).length })).filter((c) => c.open > 0);
    const activity = [];
    for (const r of [...open, ...resolved].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12)) {
      const last = (await entriesOf(ctx, r)).find((e) => e.kind === "did" || e.kind === "update" || e.kind === "resolved" || e.kind === "handoff" || e.kind === "problem");
      if (last) activity.push({ requestId: r._id, customer: (await ctx.db.get(r.customerId))?.name ?? "A client", kind: last.kind, text: last.text, at: last.at });
    }
    const cards = async (rows: Request[]) => Promise.all(rows.slice(0, 8).map((r) => card(ctx, r, names, tz)));
    return {
      agent: agentState(ctx.company),
      counts: {
        open: open.length,
        newToday: created,
        waitingClient: open.filter((r) => r.status === "waiting_customer").length,
        waitingTeam: open.filter((r) => r.status === "waiting_team").length,
        decisions: decisions.length,
        blocked: blocked.length + troubled.filter((s) => open.some((r) => r._id === s.requestId)).length,
        dueUpdates: dueUpdates.length,
        resolvedWeek: resolved.length,
        stepsDoneWeek: done.filter((s) => s.createdBy.kind === "agent").length,
        unread: unread.length,
      },
      urgent: await cards(urgent),
      decisions: await cards(decisions.sort((a, b) => a.updatedAt - b.updatedAt)),
      dueUpdates: await cards(dueUpdates.sort((a, b) => a.promised!.by - b.promised!.by)),
      blocked: await cards(blocked),
      troubled: await Promise.all(troubled.filter((s) => open.some((r) => r._id === s.requestId)).slice(0, 6).map(async (s) => ({ requestId: s.requestId, stepId: s._id, summary: s.summary, status: s.status, words: STEP_WORDS[s.status], result: s.result ?? null }))),
      byCategory,
      activity,
      unread: unread.length ? { count: unread.length, oldest: Math.min(...unread.map((m) => m.receivedAt)) } : null,
    };
  },
});

// ── Requests ───────────────────────────────────────────────────────────────────────────────────

export const list = companyQuery({
  args: { status: v.optional(v.union(requestStatusValidator, v.literal("open"), v.literal("closed"))), category: v.optional(careCategoryValidator), urgency: v.optional(v.union(v.literal("normal"), v.literal("high"), v.literal("urgent"))), search: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const tz = ctx.company.timezone;
    const names = await memberNames(ctx);
    const statuses = args.status === "open" || args.status === undefined ? OPEN_STATUSES : args.status === "closed" ? (["resolved", "closed_no_action"] as const) : [args.status];
    const rows: Request[] = [];
    for (const status of statuses) {
      rows.push(
        ...(await ctx.db
          .query("careRequests")
          .withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", status))
          .order("desc")
          .take(200)),
      );
    }
    const term = args.search?.trim().toLowerCase() ?? "";
    const out = [];
    for (const row of rows.sort((a, b) => (a.urgency === "urgent" ? -1 : 0) - (b.urgency === "urgent" ? -1 : 0) || b.updatedAt - a.updatedAt)) {
      if (args.category && row.category !== args.category) continue;
      if (args.urgency && row.urgency !== args.urgency) continue;
      const c = await card(ctx, row, names, tz);
      if (term && !`${c.customer.name} ${c.writer ?? ""} ${c.property ?? ""} ${c.summary} ${c.categoryWords}`.toLowerCase().includes(term)) continue;
      out.push(c);
      if (out.length >= 150) break;
    }
    return { rows: out, categories: CARE_CATEGORIES.map((c) => ({ id: c, words: CATEGORY_WORDS[c] })), statuses: REQUEST_STATUSES.map((s) => ({ id: s, words: STATUS_WORDS[s] })) };
  },
});

export const detail = companyQuery({
  args: { requestId: v.id("careRequests") },
  handler: async (ctx, args) => {
    const row = await owned(ctx, args.requestId);
    const tz = ctx.company.timezone;
    const names = await memberNames(ctx);
    const owner = ctx.role === "owner";
    const billing = row.category === "billing" && !owner;
    const customer = await ctx.db.get(row.customerId);
    const property = row.propertyId ? await ctx.db.get(row.propertyId) : null;
    const job = row.jobId ? await ctx.db.get(row.jobId) : null;
    const steps = (await stepsOf(ctx, row)).sort((a, b) => a.createdAt - b.createdAt);
    const entries = await entriesOf(ctx, row);
    const inbound = (
      await ctx.db
        .query("careMessages")
        .withIndex("by_company_customer", (q) => q.eq("companyId", ctx.companyId).eq("customerId", row.customerId))
        .order("desc")
        .take(80)
    ).filter((m) => m.requestIds.includes(row._id) || (m.from === row.conversation.address && m.receivedAt >= row.createdAt - HOUR && m.receivedAt <= (row.closedAt ?? Infinity)));
    const outbound = await ctx.db
      .query("messages")
      .withIndex("by_company_care_request", (q) => q.eq("companyId", ctx.companyId).eq("careRequestId", row._id))
      .take(80);
    const thread = [
      ...inbound.map((m) => ({ id: m._id, direction: "in" as const, at: m.receivedAt, channel: m.channel, body: m.text, withheld: m.withheld, by: row.authority.name, status: null as null | string, statusWords: null as null | string })),
      ...outbound.map((m) => {
        const d = deliveryWords(m);
        return { id: m._id, direction: "out" as const, at: m.queuedAt, channel: m.channel ?? "sms", body: billing && m.invoiceId ? "A message about an invoice. Billing details are the Owner's." : m.body.replace(/\{link\}/g, "[secure link]"), withheld: false, by: m.draftedBy === "agent" ? "Client Care" : m.authorId ? (names.get(m.authorId) ?? "A team member") : "Client Care", status: d.state, statusWords: d.words };
      }),
    ].sort((a, b) => a.at - b.at);
    const held = customer ? await heldBy(ctx, row, customer) : null;
    const linked = [];
    if (row.retentionCaseId) {
      const r = await ctx.db.get(row.retentionCaseId);
      if (r) linked.push({ kind: "Retention recovery case", label: r.title, state: r.status.replace(/_/g, " "), href: `/app/agents/retention/recovery?case=${r._id}` });
    }
    if (row.qualityCaseId) {
      const q = await ctx.db.get(row.qualityCaseId);
      if (q && (!q.restricted || owner)) linked.push({ kind: "Quality case", label: q.title, state: q.stage.replace(/_/g, " "), href: `/app/agents/quality/cases?case=${q._id}` });
    }
    if (row.opportunityId) {
      const o = await ctx.db.get(row.opportunityId);
      if (o) linked.push({ kind: "Sales opportunity", label: o.title, state: o.stage, href: `/app/agents/sales/pipeline?opp=${o._id}` });
    }
    if (row.invoiceId && owner) {
      const i = await ctx.db.get(row.invoiceId);
      if (i) linked.push({ kind: "Invoice", label: i.number ?? "Invoice", state: i.status, href: `/app/finance?invoice=${i._id}` });
    }
    const rules = await changeRules(ctx, ctx.company, row.customerId, row.propertyId ?? null);
    return {
      request: { ...(await card(ctx, row, names, tz)), requestedOutcome: row.requestedOutcome, authority: { as: row.authority.as, name: row.authority.name, roles: row.authority.roles, limited: row.authority.propertyIds.length > 0 }, resolution: row.resolution ?? null, reopened: row.reopened, pending: row.pending ? { question: row.pending.question, options: row.pending.options.map((o) => o.label), askedAt: row.pending.askedAt, expiresAt: row.pending.expiresAt, reminded: row.pending.reminded } : null, version: row.version, closedAt: row.closedAt ?? null },
      customer: customer ? { id: customer._id, name: customer.name, kind: customer.kind } : null,
      property: property ? { id: property._id, name: property.label?.trim() || property.address.line1, city: property.address.city, hasAccess: Boolean(property.accessInstructions) } : null,
      visit: job ? { id: job._id, when: `${dayName(job.startsAt, tz)} at ${clock(job.startsAt, tz)}`, service: job.serviceSnapshot?.name ?? job.serviceType, status: job.status, held: Boolean(job.migration?.held) } : null,
      facts: row.facts.filter((f) => !(billing && f.key === "invoice")).map((f) => ({ key: f.key, value: f.value, basis: f.basis, source: f.source ?? null, at: f.at })),
      policy: { noticeHours: rules.noticeHours, source: rules.source },
      steps: steps.map((s) => ({ id: s._id, kind: s.kind, summary: s.summary, status: s.status, statusWords: STEP_WORDS[s.status], permission: actionDef(s.permission)?.label ?? s.permission, result: s.result ?? null, message: s.message ? (billing && s.kind === "invoice_link" ? "A message with the invoice and its payment link. Billing details are the Owner's." : s.message.body.replace(/\{link\}/g, "[secure link]")) : null, parts: s.parts.map((p) => ({ name: PART_WORDS[p.name] ?? p.name, state: p.state, detail: p.detail ?? null, at: p.at })), approvalId: s.approvalId ?? null, at: s.createdAt, retry: (s.status === "partial" || s.status === "failed") && s.parts.find((p) => p.name === "notify")?.state === "failed" && s.parts.find((p) => p.name === "change")?.state !== "failed" })),
      entries: entries.map((e) => ({ id: e._id, kind: e.kind, text: e.text, at: e.at, by: e.actor.kind === "member" ? (names.get(e.actor.memberId) ?? "A team member") : e.actor.kind === "agent" ? (e.actor.agent === "customer-care" ? "Client Care" : e.actor.agent) : "Selestial", source: e.source ?? null })),
      thread,
      linked,
      conversation: { channel: row.conversation.channel, held: held?.words ?? null, inboxHref: row.conversation.smsConversationId ? `/app/inbox?conversation=${row.conversation.smsConversationId}` : null, clientHref: `/app/clients/${row.customerId}/conversations` },
      can: { takeOver: isOpen(row) && row.owner.kind !== "member", handBack: row.owner.kind === "member" && (row.owner.memberId === ctx.member._id || isManager(ctx.role)), resolve: isOpen(row), close: isOpen(row), reopen: !isOpen(row), runAgain: isOpen(row) && row.owner.kind === "care" && !ctx.company.pausedAgents.includes("customer-care") },
    };
  },
});

// ── Follow-ups ─────────────────────────────────────────────────────────────────────────────────

export const followUps = companyQuery({
  args: { asOf: v.number() },
  handler: async (ctx, args) => {
    const tz = ctx.company.timezone;
    const names = await memberNames(ctx);
    const out = [];
    for (const status of ["waiting_customer", "waiting_team", "waiting_owner", "in_progress", "new"] as const) {
      const rows = await ctx.db
        .query("careRequests")
        .withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", status))
        .take(200);
      for (const row of rows) {
        const steps = await stepsOf(ctx, row);
        const waitingApproval = steps.find((s) => s.status === "awaiting_approval");
        const blockedStep = steps.find((s) => s.status === "blocked" || s.status === "partial" || s.status === "uncertain" || s.status === "failed");
        const mode = row.owner.kind === "member" ? "held" : ctx.company.pausedAgents.includes("customer-care") ? "paused" : waitingApproval ? "approval" : row.status === "waiting_owner" || blockedStep ? "blocked" : "automatic";
        const next = row.pending ? (row.pending.reminded ? "Hand to you if there's still no answer" : "One reminder to the client") : row.promised ? "Send the promised update" : row.status === "waiting_owner" ? "Wait for your decision" : row.status === "waiting_team" ? `Check on ${row.waiting?.who ?? "the team"}` : (row.nextAction ?? "Work the request");
        out.push({ ...(await card(ctx, row, names, tz)), waitingFor: row.status === "waiting_customer" ? row.authority.name : row.status === "waiting_owner" ? "You" : row.status === "waiting_team" ? (row.waiting?.who ?? "The team") : "Client Care", reason: row.waiting?.reason ?? row.blocker ?? row.nextAction ?? null, nextCheckAt: row.nextCheckAt ?? null, planned: next, mode, approvalId: waitingApproval?.approvalId ?? null, overdue: (row.promised?.by ?? Infinity) < args.asOf || (row.pending?.expiresAt ?? Infinity) < args.asOf });
      }
    }
    return out.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.nextCheckAt ?? Infinity) - (b.nextCheckAt ?? Infinity));
  },
});

// ── Care Setup ─────────────────────────────────────────────────────────────────────────────────

export const setup = companyQuery({
  args: {},
  handler: async (ctx) => {
    const settings = careSettings(ctx.company);
    const profile = await readProfile(ctx, ctx.companyId);
    const smsGaps = senderGaps(profile.messaging, "sms").map((g) => g.words);
    const texting = await textingProvider(ctx, ctx.companyId, null);
    const inboxes = (
      await ctx.db
        .query("mailboxConnections")
        .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
        .take(20)
    ).filter((row) => purposesOf(row).includes("care"));
    const permissions = [];
    for (const def of ACTIONS.filter((a) => a.agent === "customer-care")) {
      const found = await authorityFor(ctx, ctx.companyId, def.key);
      const capability = capabilityOf(def.key);
      permissions.push({ key: def.key, label: def.label, standard: def.standard, ceiling: def.ceiling, money: def.money, level: found.kind === "level" ? found.level : null, state: found.kind, note: capability.implemented ? (capability.note ?? null) : (capability.unavailable ?? null), implemented: capability.implemented });
    }
    const members = await ctx.db
      .query("members")
      .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
      .take(200);
    const hours = businessSettingsOf(ctx.company).hours;
    return {
      settings: { ...settings, requestTypes: [...settings.requestTypes] },
      categories: CARE_CATEGORIES.map((c) => ({ id: c, words: CATEGORY_WORDS[c] })),
      permissions,
      channels: {
        sms: !texting ? { ready: false, words: "Texting isn't connected for Selestial yet." } : smsGaps.length ? { ready: false, words: smsGaps.join(" ") } : { ready: true, words: `Texting is ready from ${profile.messaging.smsNumber ?? "your number"}.` },
        email: inboxes.find((i) => i.status === "connected") ? { ready: true, words: `Replies go from ${inboxes.find((i) => i.status === "connected")!.address}.${settings.readInbox ? " Client Care reads clients' emails there." : " Reading clients' emails there is off."}` } : inboxes.length ? { ready: false, words: `${inboxes[0].address} needs reconnecting. Care email waits until it is.` } : emailProvider() ? { ready: true, words: `No Care & Retention inbox is connected: email goes as "${profile.messaging.senderName ?? ctx.company.name} via Selestial", and clients' replies go to your own mailbox, which Selestial doesn't see.` } : { ready: false, words: "Email isn't connected for Selestial yet." },
        sender: profile.messaging.senderName ?? ctx.company.name,
      },
      hours: hours.map((h) => ({ weekday: h.weekday, from: h.startMinute, to: h.endMinute })),
      escalation: members.filter((m) => m.status === "active" && (m.role === "owner" || m.role === "manager")).map((m) => ({ id: m._id, name: m.name, role: m.role, chosen: settings.escalationMemberIds.includes(m._id) })),
      agent: agentState(ctx.company),
      canEdit: ctx.role === "owner",
      readerNote: "Client Care's AI reading has no approved credit price yet, so your rules read every message and nothing is charged.",
    };
  },
});

export const saveSetup = ownerMutation({
  args: { settings: careSettingsValidator, expectedRevision: v.number() },
  handler: async (ctx, args) => {
    const current = careSettings(ctx.company);
    if (current.revision !== args.expectedRevision) throw userError("Care Setup changed since you opened it. Reload to see the latest, then save again.");
    const s = args.settings;
    const hours = (n: number | undefined, max: number, what: string) => {
      if (n === undefined) return undefined;
      if (!Number.isFinite(n) || n < 0 || n > max) throw userError(`${what} must be between 0 and ${max}.`);
      return Math.round(n);
    };
    for (const id of s.escalationMemberIds ?? []) {
      const m = await ctx.db.get(id);
      if (!m || m.companyId !== ctx.companyId || m.status !== "active") throw userError("Choose active members of your team.");
    }
    const next = {
      ...(s.requestTypes ? { requestTypes: [...new Set(s.requestTypes)] } : {}),
      policy: s.policy ? { changeNoticeHours: hours(s.policy.changeNoticeHours, 336, "The change notice"), lateChangeFeeCents: hours(s.policy.lateChangeFeeCents, 100_000, "The late-change fee"), source: optionalText(s.policy.source, "The source", 200) || undefined } : undefined,
      tone: s.tone,
      signature: optionalText(s.signature, "The signature", 300) || undefined,
      escalationMemberIds: s.escalationMemberIds,
      respondWithinMinutes: hours(s.respondWithinMinutes, 1440, "The first answer time"),
      updateEveryHours: hours(s.updateEveryHours, 168, "The update interval"),
      readInbox: s.readInbox,
      revision: current.revision + 1,
    };
    await ctx.db.patch(ctx.companyId, { clientCare: next });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "care.setup_saved", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { revision: next.revision } });
    return { revision: next.revision };
  },
});

// ── What a person does on a request ────────────────────────────────────────────────────────────

/** A person takes the request, and with it the client's conversation: no agent writes to the client until it is handed back. */
export const takeOver = companyMutation({
  args: { requestId: v.id("careRequests") },
  handler: async (ctx, args) => {
    const row = await owned(ctx, args.requestId);
    if (!isOpen(row)) throw userError("This request is closed.");
    const customer = await ctx.db.get(row.customerId);
    if (customer && !customer.conversationHeld) await ctx.db.patch(customer._id, { conversationHeld: { by: ctx.member._id, since: Date.now() } });
    if (row.conversation.smsConversationId) {
      const thread = await ctx.db.get(row.conversation.smsConversationId);
      if (thread && thread.companyId === ctx.companyId) await ctx.db.patch(thread._id, { owner: { kind: "member", memberId: ctx.member._id }, ownerReason: `${ctx.member.name} took over a Client Care request.`, ownerChangedAt: Date.now(), ownerChangedBy: ctx.member._id });
    }
    // Anything an agent queued for this client that hasn't gone yet stops now.
    const stopped = customer ? await stopFollowUps(ctx, ctx.companyId, customer._id, "taken_over", byMember(ctx)) : 0;
    const queued = await ctx.db
      .query("messages")
      .withIndex("by_company_care_request", (q) => q.eq("companyId", ctx.companyId).eq("careRequestId", row._id))
      .take(50);
    let withdrawn = 0;
    for (const m of queued) {
      if ((m.status === "queued" || m.status === "held") && m.draftedBy === "agent") {
        await ctx.db.patch(m._id, { status: "not_sent", problem: `${ctx.member.name} took over the request before this went out.`, refusal: "taken_over" });
        withdrawn += 1;
      }
    }
    const fresh = await moveRequest(ctx, row, { owner: { kind: "member", memberId: ctx.member._id, since: Date.now() }, status: "in_progress", nextAction: `${ctx.member.name} is handling this.` }, byMember(ctx));
    await addEntry(ctx, fresh, { kind: "decision", text: `${ctx.member.name} took the request over. Agents won't write to the client until it is handed back.${withdrawn + stopped ? ` ${withdrawn + stopped} queued ${withdrawn + stopped === 1 ? "message was" : "messages were"} stopped.` : ""}`, actor: byMember(ctx) });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "care_request.taken_over", actor: byMember(ctx), subject: { table: "careRequests", id: row._id } });
    return { withdrawn: withdrawn + stopped };
  },
});

export const handBack = companyMutation({
  args: { requestId: v.id("careRequests") },
  handler: async (ctx, args) => {
    const row = await owned(ctx, args.requestId);
    if (row.owner.kind !== "member") return null;
    if (row.owner.memberId !== ctx.member._id && !isManager(ctx.role)) throw userError("Only the person who took over, or an Owner or Manager, can hand it back.", "not_allowed");
    const customer = await ctx.db.get(row.customerId);
    if (customer?.conversationHeld) await ctx.db.patch(customer._id, { conversationHeld: undefined });
    if (row.conversation.smsConversationId) {
      const thread = await ctx.db.get(row.conversation.smsConversationId);
      if (thread && thread.owner.kind === "member") await ctx.db.patch(thread._id, { owner: { kind: "agents" }, ownerReason: `${ctx.member.name} handed the request back to Client Care.`, ownerChangedAt: Date.now(), ownerChangedBy: ctx.member._id });
    }
    const fresh = await moveRequest(ctx, row, { owner: { kind: "care" }, status: "in_progress", nextCheckAt: Date.now(), material: true }, byMember(ctx));
    await addEntry(ctx, fresh, { kind: "decision", text: `${ctx.member.name} handed the request back to Client Care.`, actor: byMember(ctx) });
    if (isOpen(fresh) && !ctx.company.pausedAgents.includes("customer-care")) await advance(ctx, ctx.company, fresh._id);
    return null;
  },
});

export const resolve = companyMutation({
  args: { requestId: v.id("careRequests"), note: v.string() },
  handler: async (ctx, args) => {
    const row = await owned(ctx, args.requestId);
    const note = text(args.note, "What happened", 400);
    await resolveRequest(ctx, row, `${ctx.member.name}: ${note}`, [], byMember(ctx));
    return null;
  },
});

export const close = companyMutation({
  args: { requestId: v.id("careRequests"), reason: v.string() },
  handler: async (ctx, args) => {
    const row = await owned(ctx, args.requestId);
    await closeRequest(ctx, row, `${ctx.member.name}: ${text(args.reason, "The reason", 400)}`, byMember(ctx));
    return null;
  },
});

export const reopen = companyMutation({
  args: { requestId: v.id("careRequests"), reason: v.string() },
  handler: async (ctx, args) => {
    const row = await owned(ctx, args.requestId);
    await reopenRequest(ctx, row, `${ctx.member.name}: ${text(args.reason, "The reason", 300)}`, byMember(ctx));
    return null;
  },
});

export const note = companyMutation({
  args: { requestId: v.id("careRequests"), body: v.string() },
  handler: async (ctx, args) => {
    const row = await owned(ctx, args.requestId);
    await addEntry(ctx, row, { kind: "note", text: text(args.body, "The note", 800), actor: byMember(ctx) });
    return null;
  },
});

/** Client Care works the request again on what the record says now. */
export const runAgain = companyMutation({
  args: { requestId: v.id("careRequests") },
  handler: async (ctx, args) => {
    const row = await owned(ctx, args.requestId);
    if (!isOpen(row)) throw userError("This request is closed.");
    if (row.owner.kind !== "care") throw userError("Hand the request back to Client Care first.");
    if (ctx.company.pausedAgents.includes("customer-care")) throw userError("Client Care is paused. Resume it first.");
    const fresh = await moveRequest(ctx, row, { status: "in_progress", material: true, clear: ["blocker", "pending"] }, byMember(ctx));
    await addEntry(ctx, fresh, { kind: "decision", text: `${ctx.member.name} asked Client Care to work the request again.`, actor: byMember(ctx) });
    await advance(ctx, ctx.company, fresh._id);
    return null;
  },
});

/** The message telling the client about a change that was made is sent again. The change is never redone. */
export const retry = companyMutation({
  args: { stepId: v.id("careSteps") },
  handler: async (ctx, args) => {
    const step = await owned(ctx, args.stepId);
    return retryMessage(ctx, ctx.company, step, byMember(ctx));
  },
});

/** For the sidebar: what a person can act on, in words. */
export const badges = companyQuery({
  args: {},
  handler: async (ctx) => {
    const waiting = await ctx.db
      .query("careRequests")
      .withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", "waiting_owner"))
      .take(100);
    const urgent = waiting.filter((r) => r.urgency === "urgent").length;
    return { decisions: waiting.length, urgent };
  },
});

export type CareCard = Awaited<ReturnType<typeof card>>;
export type { CareCategory };
