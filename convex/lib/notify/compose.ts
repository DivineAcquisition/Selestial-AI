/**
 * Writing a notice at the moment it goes (convex/lib/notify/route.ts plans it). Everything is read again
 * now: the person must still be a member with the setting still on, the address not suppressed, and the
 * thing it's about still true (an approval still undecided, an inbox still disconnected). Otherwise the
 * notice isn't sent, and the row says why.
 */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { platformSender } from "../email/senders";
import { activationEmail, agentActedEmail, agentApprovalEmail, alertEmail, dispatchEscalationEmail, inboxReconnectEmail, paymentFailureEmail, securityEmail, weeklyDigestEmail, welcomeEmail, type SecurityChange } from "../email/templates/platform";
import { money, timeOf, when, type AgentId, type Email, type MemberRole } from "../email/templates/shared";
import { weeklyDigestData } from "./digest";
import { actionDef } from "../permissionCatalog";
import { readProfile } from "../compliance/profile";
import { appOrigin } from "../invitations";
import { quietUntil } from "../messaging/policy";
import { roleOf } from "../roles";
import { lockDeadlines } from "../billing/lock";
import { CATEGORY_INFO, EVENT_INFO, NIGHT, type NoticeFacts } from "./catalog";
import { emailOn, noticeSuppression, preferencesOf, SUPPRESSION_WORDS } from "./preferences";
import { unsubscribable } from "./route";
import { unsubscribeFor } from "./unsubscribe";
import { waitingMessages } from "../inbox/events";
import { OUTCOME_WORDS } from "../retention/cases";

export type Composed =
  | { ok: true; email: Email; from: string; replyTo?: string; headers: Record<string, string> }
  | { ok: false; problem: string; refusal?: string; retryAt?: number };

type Context = { companyName: string; timezone: string; role: MemberRole; origin: string | null; unsubscribeUrl: string | null };
type Built = Email | { problem: string };

const str = (facts: NoticeFacts | undefined, key: string): string | null => {
  const value = facts?.[key];
  return typeof value === "string" && value.trim() ? value : null;
};
const num = (facts: NoticeFacts | undefined, key: string): number | null => {
  const value = facts?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};
const list = (facts: NoticeFacts | undefined, key: string): string[] =>
  (str(facts, key) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

async function welcome(ctx: MutationCtx, company: Doc<"companies">, member: Doc<"members">, c: Context): Promise<Built> {
  // Each is read through its company index; one row is enough to know.
  const services = await ctx.db.query("services").withIndex("by_company_key", (q) => q.eq("companyId", company._id)).first();
  const cleaners = await ctx.db.query("cleaners").withIndex("by_company_status", (q) => q.eq("companyId", company._id)).first();
  const authority = await ctx.db.query("permissions").withIndex("by_company_action", (q) => q.eq("companyId", company._id)).first();
  const profile = await readProfile(ctx, company._id);
  return welcomeEmail({
    ...c,
    ownerName: member.name,
    steps: [
      { label: "Company created and terms accepted", done: true },
      { label: "Add your services and prices", done: services !== null },
      { label: "Add your cleaners", done: cleaners !== null },
      { label: "Connect your texting number", done: Boolean(profile.messaging.smsNumber) },
      { label: "Choose what each agent may do on its own", done: authority !== null },
    ],
  });
}

function securityChange(facts: NoticeFacts | undefined): SecurityChange | null {
  switch (str(facts, "kind")) {
    case "role_changed":
      return str(facts, "memberName") && str(facts, "to") ? { kind: "role_changed", memberName: str(facts, "memberName")!, from: str(facts, "from"), to: str(facts, "to")! } : null;
    case "member_removed":
      return str(facts, "memberName") ? { kind: "member_removed", memberName: str(facts, "memberName")! } : null;
    case "inbox_connected":
      return str(facts, "address") ? { kind: "inbox_connected", address: str(facts, "address")!, purposes: list(facts, "purposes") } : null;
    case "inbox_disconnected":
      return str(facts, "address") ? { kind: "inbox_disconnected", address: str(facts, "address")! } : null;
    case "payout_account_changed":
      return { kind: "payout_account_changed", accountEnding: str(facts, "accountEnding") };
    case "deletion_requested":
      return num(facts, "deleteAfter") ? { kind: "deletion_requested", deleteAfter: num(facts, "deleteAfter")! } : null;
    case "export_ready":
      return num(facts, "expiresAt") ? { kind: "export_ready", expiresAt: num(facts, "expiresAt")! } : null;
    default:
      return null;
  }
}

/** Words for what an approval is about, from the record it names. */
async function aboutRows(ctx: MutationCtx, about: Doc<"approvals">["about"]): Promise<{ label: string; value: string | null }[]> {
  if (!about) return [];
  if (about.table === "customers") return [{ label: "Customer", value: (await ctx.db.get(about.id))?.name ?? null }];
  if (about.table === "cleaners") return [{ label: "Cleaner", value: (await ctx.db.get(about.id))?.name ?? null }];
  if (about.table === "jobs") {
    const job = await ctx.db.get(about.id);
    const customer = job ? await ctx.db.get(job.customerId) : null;
    return [{ label: "Visit", value: job ? (job.serviceSnapshot?.name ?? job.serviceType) : null }, { label: "Customer", value: customer?.name ?? null }];
  }
  return [];
}

async function approval(ctx: MutationCtx, ref: string | undefined, reminder: boolean, c: Context): Promise<Built> {
  const id = ref ? ctx.db.normalizeId("approvals", ref) : null;
  const row = id ? await ctx.db.get(id) : null;
  if (!row) return { problem: "The proposal no longer exists." };
  if (row.status !== "pending") return { problem: "The proposal was decided before this notice went." };
  if (row.decideBy <= Date.now()) return { problem: "The proposal's deadline passed before this notice went." };
  return agentApprovalEmail({ ...c, agent: row.agent as AgentId, approvalId: row._id, summary: row.summary, reason: row.reason, authorizes: row.authorizes, ifWaiting: row.ifWaiting, decideBy: row.decideBy, about: await aboutRows(ctx, row.about), reminder });
}

async function planPaymentFailed(ctx: MutationCtx, company: Doc<"companies">, facts: NoticeFacts | undefined, c: Context): Promise<Built> {
  const accounts = await ctx.db
    .query("billingAccounts")
    .withIndex("by_company_env", (q) => q.eq("companyId", company._id))
    .take(5);
  const pastDue = accounts.some((a) => a.subscription.pastDue);
  if (!pastDue) return { problem: "The payment was settled before this notice went." };
  return paymentFailureEmail({ ...c, planName: str(facts, "planName") ?? "Selestial", amountDueCents: num(facts, "amountDueCents"), failedAt: num(facts, "failedAt") ?? Date.now(), cardEnding: str(facts, "cardEnding"), pausesAt: num(facts, "pausesAt") });
}

async function inboxReconnect(ctx: MutationCtx, ref: string | undefined, facts: NoticeFacts | undefined, c: Context): Promise<Built> {
  const id = ref ? ctx.db.normalizeId("mailboxConnections", ref) : null;
  const mailbox = id ? await ctx.db.get(id) : null;
  if (!mailbox) return { problem: "The inbox is no longer connected to this company." };
  if (mailbox.status === "connected") return { problem: "The inbox was reconnected before this notice went." };
  if (mailbox.status === "disconnected") return { problem: "The inbox was disconnected on purpose, so there's nothing to reconnect." };
  const purposes = list(facts, "purposes");
  return inboxReconnectEmail({
    ...c,
    address: mailbox.address,
    purposes: purposes.length ? purposes : ["Hiring"],
    agents: purposes.length ? (list(facts, "agents") as AgentId[]).filter((a) => a in { sales: 1, recruiter: 1, dispatch: 1, retention: 1 }) : ["recruiter"],
    since: num(facts, "since") ?? mailbox.lastSyncAt ?? mailbox.createdAt,
    reason: mailbox.status === "expired" ? "expired" : "error",
    // Counted now, so the notice says how many are waiting at the moment it goes.
    held: (await waitingMessages(ctx, mailbox.companyId)).length,
  });
}

/** What an agent did on its own, in its permission's own words, about the record it touched. */
async function agentActed(ctx: MutationCtx, company: Doc<"companies">, facts: NoticeFacts | undefined, at: number, c: Context): Promise<Built> {
  const agent = str(facts, "agent") as AgentId | null;
  if (!agent || !["sales", "recruiter", "dispatch", "retention"].includes(agent)) return { problem: "The notice didn't say which agent acted." };
  const def = str(facts, "action") ? actionDef(str(facts, "action")!) : undefined;
  const kind = str(facts, "kind")?.replace(/_/g, " ");
  const did = def?.label ?? (kind ? `Sent a ${kind}` : null);
  if (!did) return { problem: "The notice didn't say what the agent did." };
  const about: { label: string; value: string | null }[] = [];
  let path: string | null = null;
  const jobId = str(facts, "jobId") ? ctx.db.normalizeId("jobs", str(facts, "jobId")!) : null;
  const job = jobId ? await ctx.db.get(jobId) : null;
  if (job && job.companyId === company._id) {
    const customer = await ctx.db.get(job.customerId);
    about.push({ label: "Visit", value: job.serviceSnapshot?.name ?? job.serviceType }, { label: "Customer", value: customer?.name ?? null });
    path = `/app/schedule?open=job:${job._id}`;
  }
  const cleanerId = str(facts, "cleanerId") ? ctx.db.normalizeId("cleaners", str(facts, "cleanerId")!) : null;
  const cleaner = cleanerId ? await ctx.db.get(cleanerId) : null;
  if (cleaner && cleaner.companyId === company._id) about.push({ label: "Cleaner", value: cleaner.name });
  const opportunityId = str(facts, "opportunityId") ? ctx.db.normalizeId("salesOpportunities", str(facts, "opportunityId")!) : null;
  const opportunity = opportunityId ? await ctx.db.get(opportunityId) : null;
  if (opportunity && opportunity.companyId === company._id) {
    const customer = opportunity.customerId ? await ctx.db.get(opportunity.customerId) : null;
    about.push({ label: "Customer", value: customer?.name ?? null });
    path ??= "/app/agents/sales";
  }
  const caseId = str(facts, "caseId") ? ctx.db.normalizeId("retentionCases", str(facts, "caseId")!) : null;
  const careCase = caseId ? await ctx.db.get(caseId) : null;
  if (careCase && careCase.companyId === company._id) {
    const customer = await ctx.db.get(careCase.customerId);
    about.push({ label: "Customer", value: customer?.name ?? null }, { label: "Case", value: careCase.title });
    path ??= casePath(careCase);
  }
  return agentActedEmail({ ...c, agent, did, at: num(facts, "at") ?? at, about, path });
}

const CASE_PAGE = { follow_through: "needs-attention", recovery: "recovery", continuity: "continuity-renewals", renewal: "continuity-renewals", reactivation: "re-engagement" } as const;
/** Where a case opens: its own page once closed or underway, Needs attention while it waits on a person. */
function casePath(row: Doc<"retentionCases">): string {
  const page = row.status === "needs_attention" || row.status === "needs_context" ? "needs-attention" : CASE_PAGE[row.kind];
  return `/app/agents/retention/${page}?case=${encodeURIComponent(row._id)}`;
}

/**
 * A customer case that needs a person, or how one ended. Read now: a case someone already dealt with
 * sends nothing. The customer's own words are never put in the email; the case holds them.
 */
async function retentionCase(ctx: MutationCtx, company: Doc<"companies">, event: "retention_serious" | "retention_attention" | "retention_outcome", ref: string | undefined, facts: NoticeFacts | undefined, c: Context): Promise<Built> {
  const id = ref ? ctx.db.normalizeId("retentionCases", ref) : null;
  const row = id ? await ctx.db.get(id) : null;
  if (!row || row.companyId !== company._id) return { problem: "The case no longer exists." };
  const customer = await ctx.db.get(row.customerId);
  const who = customer?.name ?? "A customer";
  const about = [
    { label: "Customer", value: customer?.name ?? null },
    { label: "Case", value: row.title },
  ];
  const button = { label: "Open the case", path: casePath(row) };
  if (event === "retention_outcome") {
    if (row.status !== "closed" || !row.outcome) return { problem: "The case was reopened before this notice went." };
    return alertEmail({
      ...c,
      eyebrow: "Retention",
      subject: `Case closed for ${who}: ${OUTCOME_WORDS[row.outcome.code].replace(/\.$/, "")}`,
      heading: "A customer case closed",
      body: OUTCOME_WORDS[row.outcome.code],
      tone: "info",
      note: "This is what the record shows. It is not a statement that the customer is satisfied unless they said so.",
      facts: [...about, { label: "Closed", value: when(row.outcome.at, c.timezone) }],
      button,
      because: "notices about what your agents and customers did are on",
    });
  }
  if (row.status === "closed") return { problem: "The case was closed before this notice went." };
  if (event === "retention_serious") {
    if (!row.serious) return { problem: "The case is no longer marked as a serious concern." };
    if (row.heldBy || row.ownerId) return { problem: "A person took the case before this notice went." };
    return alertEmail({
      ...c,
      eyebrow: "Retention",
      subject: `A serious concern from ${who} needs a person now`,
      heading: "A serious concern needs a person",
      body: `${row.serious.reason} Selestial has stopped: it proposes no remedy and writes nothing to the customer about this.`,
      tone: "danger",
      note: "Someone authorized to handle safety, damage, theft or staff-conduct concerns should take the case and contact the customer directly.",
      facts: about,
      button: { label: "Take the case", path: button.path },
      because: "urgent operations alerts are on",
    });
  }
  if (str(facts, "kind") === "overdue") {
    const dueAt = num(facts, "dueAt");
    if (dueAt === null || row.dueAt !== dueAt || row.dueAt > Date.now()) return { problem: "The commitment was met or given a new deadline before this notice went." };
    return alertEmail({
      ...c,
      eyebrow: "Retention",
      subject: `A commitment to ${who} is overdue`,
      heading: "A commitment to a customer is overdue",
      body: `"${row.title}" was due ${when(row.dueAt, c.timezone)} and is still open.`,
      tone: "warning",
      facts: [...about, { label: "Where it stands", value: row.doing }, { label: "Waiting on", value: row.needs ?? null }],
      button,
      because: "urgent operations alerts are on",
    });
  }
  if (row.status !== "needs_attention") return { problem: "The case stopped waiting on a person before this notice went." };
  if (row.heldBy) return { problem: "A person took the case before this notice went." };
  return alertEmail({
    ...c,
    eyebrow: "Retention",
    subject: `${who}'s case needs your decision`,
    heading: "A customer case needs a decision",
    body: row.needs ?? "The case is waiting for a person to decide the next step.",
    tone: "warning",
    facts: [...about, { label: "Decide by", value: when(row.dueAt, c.timezone) }],
    button,
    because: "urgent operations alerts are on",
  });
}

/** Written from the connection as it is when the notice goes: a problem already fixed sends nothing. */
async function quoAttention(ctx: MutationCtx, company: Doc<"companies">, ref: string | undefined, facts: NoticeFacts | undefined, c: Context): Promise<Built> {
  const id = ref ? ctx.db.normalizeId("quoConnections", ref) : null;
  const connection = id ? await ctx.db.get(id) : null;
  if (!connection || connection.companyId !== company._id) return { problem: "The Quo connection no longer exists." };
  const kind = str(facts, "kind");
  const base = { ...c, eyebrow: "Quo", essential: true, because: "you're the Owner, and the Quo connection is part of your account" };
  const button = { label: "Open the Quo connection", path: "/app/settings/integrations/quo" };
  if (kind === "disconnected") {
    if (connection.status !== "disconnected") return { problem: "Quo was connected again." };
    return alertEmail({ ...base, tone: "warning", subject: "Quo was disconnected from Selestial", heading: "Quo was disconnected", body: "Nothing is sent through your Quo numbers now. Conversations and history are kept, and texts that were waiting won't be sent later. Connect again whenever you're ready.", button });
  }
  if (!connection.problem || connection.status === "ready") return { problem: "The Quo problem was already fixed." };
  return alertEmail({ ...base, tone: "warning", subject: "Quo needs your attention", heading: "Texts through Quo are waiting", body: `${connection.problem.words} Texts through your Quo numbers wait until it's fixed; nothing is sent through another number instead.`, button });
}

/** Written only while it is still true: the worker is active and their onboarding was approved. */
async function workerReady(ctx: MutationCtx, company: Doc<"companies">, ref: string | undefined, c: Context): Promise<Built> {
  const id = ref ? ctx.db.normalizeId("cleaners", ref) : null;
  const cleaner = id ? await ctx.db.get(id) : null;
  if (!cleaner || cleaner.companyId !== company._id) return { problem: "The worker is no longer in the record." };
  if (cleaner.status !== "ready") return { problem: "The worker isn't active any more, so the notice wasn't sent." };
  const handoffs = await ctx.db
    .query("onboardingHandoffs")
    .withIndex("by_company_status", (q) => q.eq("companyId", company._id).eq("status", "complete"))
    .take(500);
  if (!handoffs.some((row) => row.cleanerId === cleaner._id)) return { problem: "Their onboarding isn't recorded as complete." };
  return alertEmail({
    ...c,
    eyebrow: "Team",
    subject: `${cleaner.name}'s onboarding is complete`,
    heading: `${cleaner.name}'s onboarding is complete`,
    body: `Required onboarding items have been reviewed. Dispatch can now consider ${cleaner.name} for visits that match their availability, skills, and service area.`,
    tone: "info",
    note: "Being ready doesn't guarantee work: Dispatch still checks each visit.",
    button: { label: "Open their record", path: `/app/cleaners/${encodeURIComponent(cleaner._id)}` },
    because: "notices about what your agents and team did are on",
  });
}

async function customerPaymentFailed(ctx: MutationCtx, ref: string | undefined, c: Context): Promise<Built> {
  const id = ref ? ctx.db.normalizeId("payments", ref) : null;
  const payment = id ? await ctx.db.get(id) : null;
  if (!payment) return { problem: "The payment no longer exists." };
  if (payment.status !== "failed") return { problem: "The payment went through on a later try before this notice went." };
  const customer = await ctx.db.get(payment.customerId);
  const invoice = await ctx.db.get(payment.invoiceId);
  const who = customer?.name ?? "A customer";
  return alertEmail({
    ...c,
    eyebrow: "Payments",
    subject: `A payment from ${who} didn't go through`,
    heading: "A customer payment didn't go through",
    body: `${who}'s ${money(payment.amountCents)} card payment was declined. Nothing was charged, and the invoice is still open.`,
    tone: "warning",
    facts: [
      { label: "Customer", value: customer?.name ?? null },
      { label: "Amount", value: money(payment.amountCents) },
      { label: "Invoice", value: invoice?.number ?? null },
      { label: "Reason", value: payment.problem ?? null },
    ],
    button: { label: "Open the invoice", path: `/app/finance?tab=invoices&invoice=${encodeURIComponent(payment.invoiceId)}` },
    because: "notices about what your agents and customers did are on",
  });
}

/** What Dispatch already did about this visit, from the texts it recorded. */
async function dispatchEscalation(ctx: MutationCtx, ref: string | undefined, kind: "no_check_in" | "no_show", c: Context): Promise<Built> {
  const id = ref ? ctx.db.normalizeId("assignments", ref) : null;
  const assignment = id ? await ctx.db.get(id) : null;
  if (!assignment) return { problem: "The assignment no longer exists." };
  if (assignment.status !== "accepted") return { problem: "The cleaner is no longer on this visit, so there's nothing to escalate." };
  if (assignment.checkIn) return { problem: "The cleaner checked in before this notice went." };
  const job = await ctx.db.get(assignment.jobId);
  if (!job || job.status === "cancelled") return { problem: "The visit was cancelled before this notice went." };
  const [customer, cleaner, property] = await Promise.all([ctx.db.get(job.customerId), ctx.db.get(assignment.cleanerId), ctx.db.get(job.propertyId)]);
  const texts = (
    await ctx.db
      .query("messages")
      .withIndex("by_company_assignment", (q) => q.eq("companyId", assignment.companyId).eq("assignmentId", assignment._id))
      .take(50)
  )
    .filter((m) => m.purpose === "reminder" || m.purpose === "check_in_nudge" || m.purpose === "assignment_confirmed")
    .sort((a, b) => a.queuedAt - b.queuedAt);
  const first = cleaner?.name.split(" ")[0] ?? "the cleaner";
  const tried = texts.map((m) => {
    const what = m.purpose === "check_in_nudge" ? "Asked" : m.purpose === "reminder" ? "Reminded" : "Confirmed with";
    const at = timeOf(m.sentAt ?? m.queuedAt, c.timezone);
    const delivered = m.status === "delivered" || m.status === "sent";
    return { text: `${what} ${first} by text at ${at}${delivered ? "." : ` (${m.status === "failed" ? "it didn't arrive" : "not sent"}).`}`, state: (delivered ? "done" : "failed") as "done" | "failed" };
  });
  if (assignment.contact?.contactedAt && !tried.length) tried.push({ text: `Tried to reach ${first} at ${timeOf(assignment.contact.contactedAt, c.timezone)}.`, state: "done" });
  tried.push({ text: `No check-in from ${first} yet.`, state: "failed" });
  return dispatchEscalationEmail({
    ...c,
    kind,
    jobId: job._id,
    service: job.serviceSnapshot?.name ?? job.serviceType,
    customerName: customer?.name ?? "the customer",
    area: property ? `${property.address.city}, ${property.address.postalCode}` : null,
    startsAt: job.startsAt,
    cleanerName: cleaner?.name ?? null,
    tried,
    need: kind === "no_show" ? `Confirm whether ${first} is coming, and arrange cover if not.` : `Decide whether to call ${first}, send someone else, or tell the customer the visit may start late.`,
  });
}

/**
 * The first result, or the batch summary, read from the activation's tasks as they are now. Nothing is
 * sent for a batch the Owner canceled, and a summary that would only repeat the first email is not sent.
 */
async function activation(ctx: MutationCtx, company: Doc<"companies">, kind: "first" | "summary", ref: string | undefined, c: Context): Promise<Built> {
  const id = ref ? ctx.db.normalizeId("activations", ref) : null;
  const row = id ? await ctx.db.get(id) : null;
  if (!row || row.companyId !== company._id) return { problem: "The agent work no longer exists." };
  if (row.status === "canceled") return { problem: "The agent work was canceled before this notice went." };
  const tasks = await ctx.db
    .query("activationTasks")
    .withIndex("by_activation", (q) => q.eq("activationId", row._id))
    .take(20);
  const ready = tasks.filter((t) => t.outputs.length > 0 && (t.state === "completed" || t.state === "ready_for_review"));
  if (!ready.length && kind === "first") return { problem: "No result was ready when this notice went." };
  const outputs = ready.flatMap((t) => t.outputs.map((o) => ({ text: o.ref.label, state: o.state })));
  const waiting = tasks.filter((t) => t.state === "ready_for_review").map((t) => t.statusLine);
  const blockers = tasks.filter((t) => t.blocker && (t.state === "waiting_info" || t.state === "waiting_connection" || t.state === "paused")).map((t) => t.blocker!.words);
  const failed = tasks.filter((t) => t.state === "failed").length;
  if (kind === "summary") {
    const firstAt = row.noticed.firstResultAt ?? null;
    const newer = ready.filter((t) => firstAt === null || (t.finishedAt ?? 0) > firstAt + 60_000);
    if (!newer.length && !blockers.length && !failed) return { problem: "The first result email already covered everything." };
  }
  const focusTasks = ready.filter((t) => t.priority === 1);
  const lead = (focusTasks[0] ?? ready[0] ?? tasks[0])?.agent ?? "sales";
  const FOCUS_WORDS: Record<string, string> = { sales: "Get more bookings", pricing: "Set up services and pricing", booking: "Get agreements and booking ready", recruiter: "Hire cleaners", dispatch: "Stop chasing cleaners", retention: "Keep more customers" };
  const target = ready.length === 1 && ready[0].outputs.length === 1 ? { label: "Open it", path: ready[0].outputs[0].ref.href } : { label: "See your agents' work", path: `/app?activation=${row._id}` };
  return activationEmail({ ...c, kind, agent: lead as AgentId, focus: FOCUS_WORDS[row.focus] ?? "Your first work", outputs: outputs.slice(0, 8), waiting: waiting.slice(0, 5), blockers: blockers.slice(0, 4), failed, button: target });
}

async function build(ctx: MutationCtx, message: Doc<"messages">, company: Doc<"companies">, member: Doc<"members">, c: Context): Promise<Built> {
  const notice = message.notice!;
  const facts = notice.facts;
  switch (notice.event) {
    case "welcome":
      return welcome(ctx, company, member, c);
    case "security_change": {
      const change = securityChange(facts);
      if (!change) return { problem: "The notice didn't say what changed, so it wasn't sent." };
      return securityEmail({ ...c, change, byName: str(facts, "byName") ?? "Someone in your company", at: num(facts, "at") ?? message.queuedAt });
    }
    case "approval_needed":
      return approval(ctx, notice.ref, false, c);
    case "approval_expiring":
      return approval(ctx, notice.ref, true, c);
    case "agent_acted":
      return agentActed(ctx, company, facts, message.queuedAt, c);
    case "plan_payment_failed":
      return planPaymentFailed(ctx, company, facts, c);
    case "credits_exhausted":
      return alertEmail({
        ...c,
        eyebrow: "Billing",
        subject: "Selestial Credits ran out, so AI work is paused",
        heading: "Your credits ran out",
        body: "New AI work is paused until you add credits or the monthly allowance resets.",
        tone: "warning",
        note: "Schedules, records, cleaner links and everything that doesn't use AI keep working.",
        button: { label: "Add credits", path: "/app/settings/billing" },
        essential: true,
      });
    case "customer_payment_failed":
      return customerPaymentFailed(ctx, notice.ref, c);
    case "worker_ready":
      return workerReady(ctx, company, notice.ref, c);
    case "quo_attention":
      return quoAttention(ctx, company, notice.ref, facts, c);
    case "inbox_reconnect":
      return inboxReconnect(ctx, notice.ref, facts, c);
    case "dispatch_escalation":
      return dispatchEscalation(ctx, notice.ref, notice.ref && message.dedupeKey.includes(":no_show:") ? "no_show" : "no_check_in", c);
    case "retention_serious":
    case "retention_attention":
    case "retention_outcome":
      return retentionCase(ctx, company, notice.event, notice.ref, facts, c);
    case "texting_progress":
    case "texting_attention":
      return textingNotice(ctx, company, notice.ref, facts, c);
    case "plan_access":
      return planAccess(ctx, company, notice.ref, facts, c);
    case "activation_result":
      return activation(ctx, company, "first", notice.ref, c);
    case "activation_summary":
      return activation(ctx, company, "summary", notice.ref, c);
    case "service_attention": {
      // Written from the incident as it is now: one that is already fixed sends nothing.
      const id = notice.ref ? ctx.db.normalizeId("incidents", notice.ref) : null;
      const incident = id ? await ctx.db.get(id) : null;
      if (!incident || incident.companyId !== company._id || incident.resolvedAt !== 0) return { problem: "The problem was already fixed, so the email wasn't sent." };
      return alertEmail({
        ...c,
        eyebrow: "Needs your attention",
        subject: str(facts, "title") ?? "Something in Selestial needs your attention",
        heading: str(facts, "title") ?? "Something needs your attention",
        body: str(facts, "affected") ?? "",
        tone: "warning",
        note: str(facts, "done"),
        button: { label: str(facts, "actionLabel") ?? "Open Selestial", path: str(facts, "actionPath") ?? "/app" },
        essential: true,
        because: "Selestial tells the Owner when something stops working and needs them, once per problem.",
      });
    }
    case "support_summary":
      return alertEmail({
        ...c,
        eyebrow: "Support access",
        subject: "What Selestial Support changed in your workspace",
        heading: "Selestial Support finished helping",
        body: str(facts, "summary") ?? "Selestial Support made changes in your workspace.",
        tone: "info",
        note: str(facts, "reason") ? `Why we were there: ${str(facts, "reason")}` : null,
        facts: [{ label: "Changes", value: String(num(facts, "changes") ?? 0) }],
        button: { label: "See support access history", path: "/app/settings/support-access" },
        essential: true,
        because: "Selestial tells the Owner whenever its support team changes something in the workspace.",
      });
    case "weekly_digest": {
      const weekStart = num(facts, "weekStart");
      if (weekStart === null) return { problem: "The notice didn't say which week it was for." };
      return weeklyDigestEmail({ ...c, memberName: member.name, ...(await weeklyDigestData(ctx, company, member, weekStart)) });
    }
  }
}

/**
 * A business texting moment, read from the request as it is now: a notice whose moment has passed (the
 * owner already sent the correction, texting is ready again) sends nothing.
 */
async function textingNotice(ctx: MutationCtx, company: Doc<"companies">, ref: string | undefined, facts: NoticeFacts | undefined, c: Context): Promise<Built> {
  const id = ref ? ctx.db.normalizeId("textingRequests", ref) : null;
  const row = id ? await ctx.db.get(id) : null;
  if (!row || row.companyId !== company._id) return { problem: "The texting request no longer exists." };
  const kind = str(facts, "kind");
  const number = row.phoneNumber.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3");
  const base = { ...c, eyebrow: "Business texting", essential: true, because: "you're the Owner, and business texting is part of your account" };
  const open = (step: string, label: string) => ({ label, path: `/app/texting?step=${step}` });
  switch (kind) {
    case "requested":
    case "resubmitted":
      if (row.status !== "requested") return { problem: "Selestial already acted on the request." };
      return alertEmail({ ...base, tone: "info", subject: kind === "resubmitted" ? "Your corrected texting details are with Selestial" : "Selestial received your texting setup", heading: kind === "resubmitted" ? "We have your corrections" : "We have your texting setup", body: "A person at Selestial checks it first. Nothing is filed with the carriers or charged until it's approved. We'll email you when something needs you.", button: open("progress", "See where it stands") });
    case "needs_you": {
      if (row.status !== "needs_you" || !row.needs) return { problem: "Nothing needs the Owner any more." };
      const title = row.needs.kind === "code" ? "Confirm it's you" : row.needs.kind === "number" ? "Choose another texting number" : "A change is needed for business texting";
      const step = row.needs.kind === "number" ? "number" : row.needs.kind === "code" ? "progress" : row.needs.fields.length ? "business" : "permission";
      return alertEmail({ ...base, tone: "warning", subject: title, heading: title, body: row.needs.words, note: row.needs.kind === "correction" ? "Everything you filled in is kept. Only what's asked needs changing." : null, button: open(step, row.needs.kind === "code" ? "Enter the code" : "Make the change") });
    }
    case "campaign_approved":
      if (row.status === "active" || row.campaignApprovedAt === undefined) return { problem: "Texting is already ready, or approval was withdrawn." };
      return alertEmail({ ...base, tone: "info", subject: "The carriers approved your texting registration", heading: "Approved. Your number is being connected", body: "The carriers approved how your business will text. Your number is being bought and connected now, which can take a few business days. Texts wait until it's done, and we'll email you when your agents can start.", button: open("progress", "See where it stands") });
    case "active":
      if (row.status !== "active") return { problem: "Texting isn't ready any more." };
      return alertEmail({ ...base, tone: "info", subject: `Business texting is ready on ${number}`, heading: "Your business can text", body: `Texts now go out from ${number}, under your own registration. Your agents can send the kinds of texts you registered, to people who agreed to them.`, facts: [{ label: "Number", value: number }], button: open("progress", "See what your agents can send") });
    case "interrupted":
      if (row.status !== "interrupted") return { problem: "Texting is running again." };
      return alertEmail({ ...base, tone: "danger", subject: "Business texting is paused", heading: "The carriers paused your texting", body: "Texts from your number are on hold. Selestial is looking into it with the carriers and will tell you if anything is needed from you. Nothing is sent while it's paused.", button: open("progress", "See what's happening") });
  }
  return { problem: "This texting notice is out of date." };
}

/**
 * The Selestial plan is unpaid (convex/billingLock.ts). Each notice is checked against the record as it
 * is when it goes: a payment that arrived in between means the warning is not sent.
 */
async function planAccess(ctx: MutationCtx, company: Doc<"companies">, ref: string | undefined, facts: NoticeFacts | undefined, c: Context): Promise<Built> {
  const id = ref ? ctx.db.normalizeId("billingDunning", ref) : null;
  const row = id ? await ctx.db.get(id) : null;
  if (!row || row.companyId !== company._id) return { problem: "The unpaid invoice is no longer on record." };
  const kind = str(facts, "kind");
  const amount = money(row.amountCents, row.currency);
  const base = { ...c, eyebrow: "Billing", essential: true, because: "you're the Owner, and the plan payment is part of your account" };
  const pay = { label: row.hostedUrl ? "Pay now to keep access" : "Update payment method", path: "/app" };
  const { cancelAt } = row.lockedAt ? lockDeadlines(row.lockedAt) : { cancelAt: null };
  const open = row.resolvedAt === undefined;
  switch (kind) {
    case "first_failure":
      if (!open || row.lockedAt !== undefined) return { problem: "The payment was settled, or the account already locked, before this notice went." };
      return alertEmail({
        ...base,
        tone: "warning",
        subject: "Your Selestial payment didn't go through",
        heading: "Your payment didn't go through",
        body: `We couldn't collect ${amount} for your Selestial plan. Nothing has changed yet, and we'll try again${row.nextAttemptAt ? ` on ${when(row.nextAttemptAt, c.timezone)}` : " soon"}.`,
        note: "If the next try also fails, the account locks: your team can't open the workspace and your agents pause until it's paid. Your customers' booking pages and links keep working.",
        facts: [
          { label: "Amount due", value: amount },
          { label: "Tried", value: when(row.lastFailedAt, c.timezone) },
          { label: "Reason", value: row.lastFailure ?? null },
        ],
        button: { label: "Update payment method", path: "/app/settings/billing" },
      });
    case "locked":
      if (!open || row.lockedAt === undefined) return { problem: "The account was reopened before this notice went." };
      return alertEmail({
        ...base,
        tone: "danger",
        subject: "Your Selestial account is locked until the payment goes through",
        heading: "Your account is locked",
        body: `Two payments of ${amount} for your Selestial plan didn't go through, so the workspace is locked and your agents are paused. Pay the invoice and everything opens again at once, just as you left it.`,
        note: `Your customers can still book, open quotes and pay you, and your records are safe. If it stays unpaid, the plan is canceled on ${cancelAt ? when(cancelAt, c.timezone) : "day 30"}.`,
        facts: [
          { label: "Amount due", value: amount },
          { label: "Failed attempts", value: String(row.attempts) },
          { label: "Last tried", value: when(row.lastFailedAt, c.timezone) },
          { label: "Reason", value: row.lastFailure ?? null },
        ],
        button: pay,
      });
    case "cancel_soon":
      if (!open || row.lockedAt === undefined) return { problem: "The account was reopened before this notice went." };
      return alertEmail({
        ...base,
        tone: "danger",
        subject: "Your Selestial plan will be canceled in 7 days",
        heading: "7 days left to keep your plan",
        body: `Your account has been locked since ${when(row.lockedAt, c.timezone)} because ${amount} is unpaid. On ${cancelAt ? when(cancelAt, c.timezone) : "day 30"} the plan is canceled.`,
        note: "Pay before then and everything opens again at once. Your records are kept either way.",
        facts: [{ label: "Amount due", value: amount }],
        button: pay,
      });
    case "canceled":
      return alertEmail({
        ...base,
        tone: "danger",
        subject: "Your Selestial plan was canceled",
        heading: "Your plan was canceled",
        body: `The plan stayed unpaid for 30 days, so it was canceled. Your company's records are kept, and choosing a plan again brings your workspace and agents back.`,
        facts: [{ label: "Unpaid", value: amount }],
        button: { label: "Choose a plan", path: "/app/settings/billing" },
      });
    case "reinstated":
      if (row.resolution === "canceled") return { problem: "The plan was canceled, not reinstated." };
      return alertEmail({
        ...base,
        tone: "info",
        subject: "Your Selestial account is open again",
        heading: "Thanks, you're all set",
        body: "The payment went through. Your workspace is open again and your agents are back to how you left them.",
        facts: [{ label: "Paid", value: row.resolution === "paid" ? amount : null }],
        button: { label: "Open Selestial", path: "/app" },
      });
  }
  return { problem: "This billing notice is out of date." };
}

/** The notice as it should go now, or why it shouldn't. */
export async function composeNotice(ctx: MutationCtx, message: Doc<"messages">, now: number): Promise<Composed> {
  if (!message.notice || !message.memberId || !message.to) return { ok: false, problem: "The notice is missing who it's for." };
  const member = await ctx.db.get(message.memberId);
  if (!member || member.companyId !== message.companyId || member.status !== "active") return { ok: false, problem: "The person no longer has access to this company." };
  const company = await ctx.db.get(message.companyId);
  if (!company) return { ok: false, problem: "The company no longer exists." };
  const role = roleOf(member.role);
  const info = EVENT_INFO[message.notice.event];
  if (!emailOn(await preferencesOf(ctx, company._id, member._id), info.category, role)) return { ok: false, problem: "Turned off in their notification settings before it went." };
  // An address change since it was planned: it goes to the address on the member now, or not at all.
  if (member.email.trim().toLowerCase() !== message.to) return { ok: false, problem: "The person's email address changed before it went." };
  const suppressed = await noticeSuppression(ctx, message.to);
  if (suppressed) return { ok: false, problem: SUPPRESSION_WORDS[suppressed.reason], refusal: "suppressed" };
  if (info.priority !== "critical") {
    const until = quietUntil(now, company.timezone, NIGHT);
    if (until !== null) return { ok: false, problem: "Waiting for the morning: only critical notices go overnight.", retryAt: until };
  }
  const sender = platformSender();
  if (!sender.ok) return { ok: false, problem: sender.words };
  const unsubscribe = CATEGORY_INFO[info.category].unsubscribable && unsubscribable(message.notice.event) ? await unsubscribeFor(message._id) : null;
  const context: Context = { companyName: company.name, timezone: company.timezone, role, origin: appOrigin(), unsubscribeUrl: unsubscribe?.pageUrl ?? null };
  const built = await build(ctx, message, company, member, context);
  if ("problem" in built) return { ok: false, problem: built.problem };
  return { ok: true, email: built, from: sender.from, ...(sender.replyTo ? { replyTo: sender.replyTo } : {}), headers: unsubscribe?.headers ?? {} };
}

