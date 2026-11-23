/**
 * Recruiter's workspace: the overview, the Playbook, the hiring inbox connection, and the answer to an
 * urgent request from Dispatch. Every number is counted from records at the moment it is asked for.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { disconnectInbox } from "./inboxes";
import { owned } from "./lib/access";
import { isTimezone } from "./lib/availability";
import { companyQuery, managerMutation, managerQuery, ownerMutation } from "./lib/builders";
import { linksConfigured } from "./lib/dispatch/links";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { emailProvider } from "./lib/messaging/email";
import { messagingProvider } from "./lib/messaging/provider";
import { calendarProvider } from "./lib/recruiter/calendar";
import { automate } from "./lib/recruiter/act";
import { reminderSweep } from "./lib/recruiter/interviews";
import { followUpSweep, routeApplication } from "./lib/recruiter/invitations";
import { resolveContact } from "./lib/recruiter/contact";
import { refresh } from "./lib/recruiter/findings";
import { googleApp } from "./lib/recruiter/gmail";
import { connectorFor } from "./lib/recruiter/mailbox";
import { hiringModel } from "./lib/recruiter/model";
import { redactDue } from "./lib/recruiter/retention";
import { secretsConfigured } from "./lib/recruiter/secrets";
import { discoveryOf } from "./lib/recruiter/boundary";
import { recruiterSettingsValidator, sourceValidator, type Stage } from "./lib/recruiter/schema";

const discoveryValidator = v.union(v.literal("hiring_inbox"), v.literal("label"), v.literal("search"));
import { DAY, HOUR, recruiterSettings } from "./lib/recruiter/settings";
import { notifyMembers } from "./lib/notify/route";
import { signatureProvider } from "./lib/recruiter/signature";
import { proposeUrgentOutreach, urgentCandidates } from "./lib/recruiter/urgent";
import { email, optionalText } from "./lib/text";

/** What Recruiter depends on outside itself, and whether each is there. A screen shows "not set up yet" from this, never a guess. */
function connections() {
  return {
    applicantLinks: linksConfigured(),
    email: emailProvider()?.name ?? null,
    texting: messagingProvider()?.name ?? null,
    calendar: calendarProvider()?.name ?? null,
    signing: signatureProvider()?.name ?? null,
    reader: hiringModel().name,
  };
}

export const overview = companyQuery({
  args: {},
  handler: async (ctx) => {
    const count = async (stage: Stage) =>
      (
        await ctx.db
          .query("applications")
          .withIndex("by_company_stage", (q) => q.eq("companyId", ctx.companyId).eq("stage", stage))
          .take(1000)
      );
    const stages = { received: await count("received"), contact_needed: await count("contact_needed"), invitation_awaiting_approval: await count("invitation_awaiting_approval"), invited: await count("invited"), application_started: await count("application_started"), application_submitted: await count("application_submitted"), screening: await count("screening"), interview: await count("interview"), decision_pending: await count("decision_pending"), offer_sent: await count("offer_sent"), accepted: await count("accepted"), onboarding_handoff: await count("onboarding_handoff") };
    const needs = await ctx.db
      .query("hiringNeeds")
      .withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", "open"))
      .take(200);
    const mailboxes = await ctx.db
      .query("mailboxConnections")
      .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
      .take(20);
    const now = Date.now();
    const failed = (
      await ctx.db
        .query("messages")
        .withIndex("by_company_queued", (q) => q.eq("companyId", ctx.companyId).gt("queuedAt", now - 14 * DAY))
        .take(2000)
    ).filter((row) => row.applicationId && (row.status === "failed" || row.status === "unconfirmed" || row.status === "not_sent"));
    const flagged = (
      await ctx.db
        .query("sourceMessages")
        .withIndex("by_company_received", (q) => q.eq("companyId", ctx.companyId).gt("receivedAt", now - 14 * DAY))
        .take(2000)
    ).filter((row) => row.flag !== undefined && !row.redactedAt);
    const awaitingForm = [...stages.invited, ...stages.application_started];
    return {
      asOf: now,
      openHiringNeeds: needs.length,
      newApplications: stages.received.length,
      contactNeeded: stages.contact_needed.length,
      invitationsAwaitingApproval: stages.invitation_awaiting_approval.length,
      /** Invited or started, and Recruiter has run out of reminders or the applicant asked something. */
      incompleteNeedingFollowUp: awaitingForm.filter((row) => row.nextAction?.by === "owner" || row.questionSince !== undefined).length,
      incompleteApplications: awaitingForm.length,
      awaitingScreening: stages.application_submitted.length + stages.screening.length,
      awaitingInterview: stages.interview.length,
      decisionsAwaitingOwner: stages.decision_pending.length,
      offersOut: stages.offer_sent.length,
      awaitingOnboardingHandoff: stages.accepted.length,
      inOnboarding: stages.onboarding_handoff.length,
      inbox: mailboxes.map((row) => ({ connectionId: row._id, address: row.address, provider: row.provider, status: row.status, problem: row.problem ?? null, lastSyncAt: row.lastSyncAt ?? null, connectorBuilt: row.provider === "gmail" || connectorFor(row.provider) !== null, sendsApplicantEmail: row.provider === "gmail" && row.status === "connected" && row.canSend === true, discovery: discoveryOf(row), label: row.folder ?? null })),
      /** Whether this deployment can connect a Gmail inbox: a Google app and a key to seal its authorization. */
      gmailAvailable: googleApp() !== null && (await secretsConfigured()),
      inboxConnected: mailboxes.some((row) => row.status === "connected"),
      failures: { messages: failed.length, flaggedMessages: flagged.length, mailboxes: mailboxes.filter((row) => row.status !== "connected").length },
      connections: connections(),
      paused: ctx.company.pausedAgents.includes("recruiter"),
    };
  },
});

// ── Playbook ─────────────────────────────────────────────────────────────────────────────────────

export const playbook = companyQuery({
  args: {},
  handler: async (ctx) => ({ settings: recruiterSettings(ctx.company), timezone: ctx.company.timezone, connections: connections() }),
});

export const updatePlaybook = ownerMutation({
  args: { settings: recruiterSettingsValidator },
  handler: async (ctx, args) => {
    const next = { ...(ctx.company.recruiter ?? {}), ...args.settings };
    const within = (value: number | undefined, min: number, max: number, label: string) => {
      if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) throw userError(`${label} must be between ${min} and ${max}.`);
    };
    within(next.maxFollowUps, 0, 5, "The number of reminders");
    within(next.linkTtlDays, 1, 60, "Days an application link works");
    within(next.offerTtlDays, 1, 30, "Days an offer stays open");
    within(next.retentionDays, 30, 2555, "Days applicant records are kept");
    within(next.interviewMinutes, 10, 240, "Interview length");
    within(next.interviewReminderHours, 1, 72, "Hours before an interview the reminder goes");
    within(next.decideWithinHours, 1, 336, "Hours to decide a proposal");
    within(next.sendFromMinute, 0, 1439, "The start of sending hours");
    within(next.sendUntilMinute, 1, 1440, "The end of sending hours");
    if ((next.followUpHours ?? []).length > 5 || (next.followUpHours ?? []).some((hours) => !Number.isFinite(hours) || hours < 12 || hours > 720)) throw userError("Reminders are at most five, each between 12 hours and 30 days after the invitation.");
    const reminders = next.followUpHours ?? [];
    if (new Set(reminders).size !== reminders.length) throw userError("Two reminders are set for the same time. Each reminder needs its own delay.");
    if (next.maxFollowUps !== undefined && (!Number.isInteger(next.maxFollowUps) || next.maxFollowUps > reminders.length)) throw userError("The number of reminders must be a whole number and no more than the reminders you have scheduled.");
    if (next.sendFromMinute !== undefined && next.sendUntilMinute !== undefined && next.sendFromMinute >= next.sendUntilMinute) throw userError("Sending hours must end after they start.");
    if (next.sendDays !== undefined && next.sendDays.length === 0) throw userError("Choose at least one day messages may be sent.");
    if (next.onboardingRequirements !== undefined) {
      const items = next.onboardingRequirements.map((item) => ({ key: item.key.trim().toLowerCase(), label: item.label.trim() }));
      if (items.length === 0) throw userError("A new worker needs at least one onboarding requirement.");
      if (items.some((item) => !/^[a-z0-9_]{1,40}$/.test(item.key) || !item.label || item.label.length > 120)) throw userError("Each onboarding requirement needs a short key of letters, numbers or underscores, and a label.");
      if (new Set(items.map((item) => item.key)).size !== items.length) throw userError("Two onboarding requirements share a key.");
      next.onboardingRequirements = items;
    }
    if ((next.sendDays ?? []).some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw userError("Sending days are numbered 0 (Sunday) to 6 (Saturday).");
    if (next.replyTo !== undefined) next.replyTo = next.replyTo.trim() ? email(next.replyTo, "The reply address") : undefined;
    next.fromName = optionalText(next.fromName, "The sender name", 80);
    next.recruitingRules = optionalText(next.recruitingRules, "Recruiting rules", 4000);
    next.communicationPolicy = optionalText(next.communicationPolicy, "The communication policy", 4000);
    next.escalationRules = optionalText(next.escalationRules, "Escalation rules", 4000);
    next.hiringFaq = optionalText(next.hiringFaq, "The Hiring FAQ", 6000);
    if (!isTimezone(ctx.company.timezone)) throw userError("Set the company's time zone first.");
    await ctx.db.patch(ctx.companyId, { recruiter: next });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "recruiter.playbook_changed", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId } });
    return null;
  },
});

// ── The hiring inbox ─────────────────────────────────────────────────────────────────────────────

/**
 * Records which mailbox is the hiring inbox and from when to read it. Authorizing Selestial to read it
 * happens with the mailbox provider; no credential is passed through or stored by this function.
 */
export const connectMailbox = ownerMutation({
  args: {
    provider: v.union(v.literal("gmail"), v.literal("microsoft"), v.literal("mock")),
    address: v.string(),
    folder: v.optional(v.string()),
    sources: v.optional(v.array(sourceValidator)),
    /** Read mail received from this time on. Earlier than now is an explicit historical import. */
    processFrom: v.optional(v.number()),
    discovery: v.optional(discoveryValidator),
  },
  handler: async (ctx, args) => {
    // A Gmail inbox is connected by signing in to Google (recruiterMailbox.startGmailConnect), which is
    // the only way Selestial gets permission to read it.
    if (args.provider === "gmail") throw userError("Connect Gmail by signing in to Google from the Recruiting settings.");
    const address = email(args.address, "The hiring inbox");
    const now = Date.now();
    const processFrom = args.processFrom ?? now;
    if (processFrom < now - 180 * DAY) throw userError("A historical import can go back at most 180 days.");
    const existing = await ctx.db
      .query("mailboxConnections")
      .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
      .take(20);
    if (existing.some((row) => row.address === address && row.status !== "disconnected")) throw userError("That inbox is already connected.");
    const folder = optionalText(args.folder, "The folder or label", 200);
    if (args.discovery === "label" && !folder) throw userError("Name the label Recruiter should read.");
    const connectionId = await ctx.db.insert("mailboxConnections", { companyId: ctx.companyId, provider: args.provider, address, folder, ...(args.discovery ? { discovery: args.discovery } : {}), sources: args.sources ?? [], processFrom, status: "connected", failures: 0, createdBy: ctx.member._id, createdAt: now });
    // Replies to Recruiter's emails go to the hiring inbox unless the Owner has named another address.
    if (!ctx.company.recruiter?.replyTo) await ctx.db.patch(ctx.companyId, { recruiter: { ...(ctx.company.recruiter ?? {}), replyTo: address } });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "mailbox.connected", actor: byMember(ctx), subject: { table: "mailboxConnections", id: connectionId }, data: { provider: args.provider, historical: processFrom < now } });
    return connectionId;
  },
});

/**
 * How Recruiter finds hiring mail in one inbox (lib/recruiter/boundary.ts). A change starts the next read
 * from the beginning of the reading window with the new boundary; what was already filed is not filed again.
 */
export const setDiscovery = ownerMutation({
  args: { connectionId: v.id("mailboxConnections"), mode: discoveryValidator, label: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await owned(ctx, args.connectionId);
    if (row.status === "disconnected") throw userError("This inbox is disconnected. Connect it again first.");
    const label = args.mode === "label" ? optionalText(args.label, "The label", 200) : undefined;
    if (args.mode === "label" && !label) throw userError("Name the Gmail label you file hiring mail under.");
    const changed = discoveryOf(row) !== args.mode || (args.mode === "label" && row.folder !== label);
    await ctx.db.patch(row._id, { discovery: args.mode, folder: args.mode === "label" ? label : undefined, ...(changed ? { cursor: undefined } : {}) });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "mailbox.discovery_changed", actor: byMember(ctx), subject: { table: "mailboxConnections", id: row._id }, data: { mode: args.mode } });
    if (changed) await ctx.scheduler.runAfter(0, internal.recruiterInbox.sync, { connectionId: row._id });
    return null;
  },
});

/** After the Owner has authorized the mailbox again. */
export const reconnectMailbox = ownerMutation({
  args: { connectionId: v.id("mailboxConnections") },
  handler: async (ctx, args) => {
    const connection = await owned(ctx, args.connectionId);
    if (connection.provider === "gmail") throw userError("Sign in to Google again to reconnect this inbox.");
    await ctx.db.patch(connection._id, { status: "connected", problem: undefined, failures: 0 });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "mailbox.connected", actor: byMember(ctx), subject: { table: "mailboxConnections", id: connection._id }, data: { provider: connection.provider, historical: false } });
    await ctx.scheduler.runAfter(0, internal.recruiterInbox.sync, { connectionId: connection._id });
    return null;
  },
});

/** The same disconnect as Connected apps (convex/inboxes.ts): one path, so neither page leaves Google's grant or a push watch behind. */
export const disconnectMailbox = ownerMutation({
  args: { connectionId: v.id("mailboxConnections") },
  handler: async (ctx, args) => {
    await disconnectInbox(ctx, await owned(ctx, args.connectionId));
    return null;
  },
});

/** Reads the inbox now instead of at the next scheduled run. */
export const readInboxNow = managerMutation({
  args: { connectionId: v.id("mailboxConnections") },
  support: { capability: "agents.recover", summary: "read the hiring inbox again" },
  handler: async (ctx, args) => {
    const connection = await owned(ctx, args.connectionId);
    if (connection.status === "disconnected") throw userError("That inbox is disconnected.");
    await ctx.scheduler.runAfter(0, internal.recruiterInbox.sync, { connectionId: connection._id });
    return null;
  },
});

/** What was seen in the inbox, newest first. Unrelated mail appears only as a count: nothing about it was kept. */
export const inboxMessages = managerQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("sourceMessages")
      .withIndex("by_company_received", (q) => q.eq("companyId", ctx.companyId))
      .order("desc")
      .take(Math.min(args.limit ?? 100, 300));
    return {
      unrelated: rows.filter((row) => row.classification === "unrelated").length,
      messages: rows
        .filter((row) => row.classification !== "unrelated")
        .map((row) => ({ sourceMessageId: row._id, classification: row.classification, classifiedBy: row.classifiedBy, reason: row.reason ?? null, source: row.source ?? null, from: row.fromAddress ?? null, subject: row.subject ?? null, receivedAt: row.receivedAt, applicationId: row.applicationId ?? null, flag: row.flag ?? null })),
    };
  },
});

// ── Urgent requests from Dispatch ────────────────────────────────────────────────────────────────

/** Dispatch's open requests for hiring help. A request is a question for a person: it opens no role and approves no pay. */
export const staffingRequests = companyQuery({
  args: {},
  handler: async (ctx) => {
    const tasks = [];
    for (const status of ["open", "needs_decision", "waiting"] as const) {
      tasks.push(
        ...(await ctx.db
          .query("tasks")
          .withIndex("by_company_agent_status", (q) => q.eq("companyId", ctx.companyId).eq("agent", "recruiter").eq("status", status))
          .take(200)),
      );
    }
    return tasks
      .filter((task) => task.key?.startsWith("recruiter.urgent_hire:") || task.key?.startsWith("recruiter.staffing_gap:"))
      .map((task) => ({ taskId: task._id, kind: task.key!.startsWith("recruiter.urgent_hire:") ? ("urgent_hire" as const) : ("staffing_gap" as const), title: task.title, what: task.nextAction ?? task.openQuestion ?? null, dueAt: task.dueAt, about: task.about ?? null }));
  },
});

export const urgentRequest = managerQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await owned(ctx, args.taskId);
    return { title: task.title, dueAt: task.dueAt, ...(await urgentCandidates(ctx, task)) };
  },
});

/** Asks a person to approve contacting these existing applicants about an urgent need. Nothing is sent here. */
export const prepareUrgentOutreach = managerMutation({
  args: { taskId: v.id("tasks"), applicationIds: v.array(v.id("applications")) },
  handler: async (ctx, args) => {
    const task = await owned(ctx, args.taskId);
    const out = [];
    for (const applicationId of args.applicationIds.slice(0, 20)) out.push({ applicationId, ...(await proposeUrgentOutreach(ctx, task, await owned(ctx, applicationId))) });
    return out;
  },
});

// ── Kept on a schedule ───────────────────────────────────────────────────────────────────────────

export const followUps = internalMutation({ args: {}, handler: async (ctx) => followUpSweep(ctx, Date.now()) });
export const interviewReminders = internalMutation({
  args: {},
  handler: async (ctx) =>
    reminderSweep(ctx, Date.now(), async (applicationId) => {
      await automate(ctx, applicationId);
    }),
});
export const retention = internalMutation({ args: {}, handler: async (ctx) => redactDue(ctx, Date.now()) });

// ── Background work: runs and summaries ─────────────────────────────────────────────────────────────

/** The latest reads of each hiring inbox, as they really happened. */
export const inboxRuns = managerQuery({
  args: {},
  handler: async (ctx) => {
    const connections = await ctx.db
      .query("mailboxConnections")
      .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
      .take(20);
    const out = [];
    for (const connection of connections.filter((row) => row.status !== "disconnected")) {
      const runs = await ctx.db
        .query("inboxRuns")
        .withIndex("by_connection_started", (q) => q.eq("connectionId", connection._id))
        .order("desc")
        .take(8);
      out.push({ connectionId: connection._id, address: connection.address, status: connection.status, problem: connection.problem ?? null, lastSyncAt: connection.lastSyncAt ?? null, runs: runs.map((run) => ({ startedAt: run.startedAt, finishedAt: run.finishedAt ?? null, outcome: run.outcome ?? null, filed: run.filed, opened: run.opened, possible: run.possible, problem: run.problem ?? null })) });
    }
    return out;
  },
});

/**
 * Run hourly: one summary per company of the new applicants and inquiries Recruiter found in the hour
 * before, instead of a notice per email. Each hour is summarized once.
 */
export const summaries = internalMutation({
  args: {},
  handler: async (ctx) => {
    const bucket = Math.floor(Date.now() / HOUR) * HOUR;
    const rows = await ctx.db
      .query("recruiterFindings")
      .withIndex("by_discovered", (q) => q.gte("discoveredAt", bucket - HOUR).lt("discoveredAt", bucket))
      .take(2000);
    const byCompany = new Map<string, { companyId: (typeof rows)[number]["companyId"]; applied: Set<string>; asked: Set<string>; ready: Set<string> }>();
    for (const row of rows) {
      if (row.kind !== "new_application" && row.kind !== "employment_inquiry" && row.kind !== "contact_needed") continue;
      const entry = byCompany.get(row.companyId) ?? { companyId: row.companyId, applied: new Set(), asked: new Set(), ready: new Set() };
      (row.kind === "employment_inquiry" ? entry.asked : entry.applied).add(row.applicationId);
      if (row.status === "ready") entry.ready.add(row.applicationId);
      byCompany.set(row.companyId, entry);
    }
    for (const entry of byCompany.values()) {
      await notifyMembers(ctx, { companyId: entry.companyId, event: "recruiter_activity", ref: entry.companyId, key: `summary:${bucket}`, facts: { kind: "summary", applied: entry.applied.size, asked: entry.asked.size, ready: entry.ready.size } });
    }
    return byCompany.size;
  },
});

// ── Job boards' forwarding addresses ───────────────────────────────────────────────────────────────

/**
 * The Owner confirms (or withdraws) that a job board's per-applicant forwarding address reaches applicants.
 * Applications already on file from that board are looked at again, a page at a time: a confirmed relay
 * becomes an address Recruiter can prepare messages to; a withdrawn one goes back to needing a contact.
 * Nothing is sent by this: messages are prepared, and go only by a person's choice or an automatic switch.
 */
export const setVerifiedRelays = ownerMutation({
  args: { sources: v.array(v.union(v.literal("indeed"), v.literal("ziprecruiter"))) },
  handler: async (ctx, args) => {
    const before = recruiterSettings(ctx.company).verifiedRelays;
    const after = [...new Set(args.sources)];
    await ctx.db.patch(ctx.companyId, { recruiter: { ...(ctx.company.recruiter ?? {}), verifiedRelays: after } });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "recruiter.relays_confirmed", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { sources: after.join(",") } });
    for (const source of ["indeed", "ziprecruiter"] as const) {
      if (before.includes(source) !== after.includes(source)) await ctx.scheduler.runAfter(0, internal.recruiter.recheckRelays, { companyId: ctx.companyId, source, cursor: null });
    }
    return null;
  },
});

export const recheckRelays = internalMutation({
  args: { companyId: v.id("companies"), source: v.union(v.literal("indeed"), v.literal("ziprecruiter")), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const company = await ctx.db.get(args.companyId);
    if (!company) return 0;
    const verified = recruiterSettings(company).verifiedRelays;
    const page = await ctx.db
      .query("applications")
      .withIndex("by_company_source", (q) => q.eq("companyId", args.companyId).eq("source", args.source))
      .paginate({ numItems: 50, cursor: args.cursor });
    let changed = 0;
    for (const row of page.page) {
      if (row.redactedAt || row.contact.resolvedBy || row.stage === "closed" || row.stage === "withdrawn") continue;
      if (row.contact.status !== "relay" && row.contact.status !== "relay_unverified") continue;
      const contact = { ...resolveContact(row.contact.evidence, row.source, verified), bouncedAt: row.contact.bouncedAt };
      if (contact.status === row.contact.status) continue;
      await ctx.db.patch(row._id, { contact });
      if (contact.status === "relay") {
        const applicant = await ctx.db.get(row.applicantId);
        if (applicant && !applicant.email && contact.address) await ctx.db.patch(applicant._id, { email: contact.address });
      }
      await routeApplication(ctx, row._id);
      await refresh(ctx, row._id);
      changed += 1;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.recruiter.recheckRelays, { ...args, cursor: page.continueCursor });
    return changed;
  },
});
