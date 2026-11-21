/**
 * Operations: incidents, detection, recovery and controls, as scenarios (docs/operations/04-verification.md).
 * Providers are the repository's stand-ins: the mock text service (with a number that is accepted and then
 * loses its answer), the mock email service and the fake Autumn sandbox.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mockOutbox, resetMockProvider } from "./lib/messaging/provider";
import { CHECKS } from "./lib/operations/checks";
import { stripeConfig } from "./lib/finance/stripe";
import { autumnConfig } from "./lib/billing/autumn";
import { company, dispatchJob, HOUR, NOW, readyMessaging, refusal, start, type T } from "../tests/harness";
import { dispatchTestEnv, flush, setup } from "../tests/dispatchHarness";

const MINUTE = 60_000;
const ADMIN = { subject: "user_staff_admin", email: "ops-admin@selestial.example", emailVerified: true, name: "Avery Ops", issuer: "https://clerk.selestial.test" };

async function runChecks(t: T) {
  for (const check of CHECKS) await t.mutation(internal.operations.runCheck, { name: check.name });
}

async function ownerMember(t: T, companyId: Id<"companies">) {
  return t.run(async (ctx) => (await ctx.db.query("members").withIndex("by_company", (q) => q.eq("companyId", companyId)).collect()).find((m) => m.role === "owner")!._id);
}

async function openIncidents(t: T, companyId?: Id<"companies">) {
  return t.run(async (ctx) => (await ctx.db.query("incidents").collect()).filter((row) => row.open && (!companyId || row.companyId === companyId)));
}

async function expiredMailbox(t: T, companyId: Id<"companies">, address = "hiring@example.com") {
  const createdBy = await ownerMember(t, companyId);
  return t.run((ctx) => ctx.db.insert("mailboxConnections", { companyId, provider: "gmail", address, sources: [], processFrom: 0, status: "expired", problem: "invalid_grant", failures: 1, purposes: ["hiring"], createdBy, createdAt: Date.now() }));
}

describe("Operations: a provider that accepts a text and then times out", () => {
  let undo: () => void;
  beforeEach(() => {
    undo = dispatchTestEnv();
    resetMockProvider();
  });
  afterEach(() => undo());

  test("is reconciled under the message's own key and never sent twice", async () => {
    const s = await setup(["Lena"], { Lena: "+15550100006" });
    // A confirmation to a cleaner who agreed to work texts: still relevant after the first attempt.
    const messageId = await s.t.run((ctx) => ctx.db.insert("messages", { companyId: s.companyId, purpose: "assignment_confirmed", channel: "sms", cleanerId: s.cleaners.Lena, to: s.phone.Lena, body: "You're confirmed for tomorrow at 9.", dedupeKey: "confirm-1", status: "queued", attempts: 0, queuedAt: Date.now() }));
    await s.t.action(internal.messaging.deliver, { messageId }).catch(() => undefined);
    // The mock accepted the text, then the answer was lost: the message is stuck "sending".
    expect(mockOutbox.map((row) => row.result)).toEqual(["accepted"]);
    vi.advanceTimersByTime(6 * MINUTE);
    await s.t.mutation(internal.messaging.sweepStuck, {});
    expect((await s.t.run((ctx) => ctx.db.get(messageId)))?.status).toBe("unconfirmed");

    // The monitor finds it, tells the owner what is happening, and checks with the provider by itself.
    await runChecks(s.t);
    const [incident] = await openIncidents(s.t, s.companyId);
    expect(incident).toMatchObject({ kind: "comms.unconfirmed", state: "recovering", ownerVisible: true });
    await flush(s.t);

    // The provider replayed its stored answer: the original had gone. Exactly one send, one replay.
    const after = await s.t.run((ctx) => ctx.db.get(messageId));
    expect(after).toMatchObject({ status: "sent", providerMessageId: `mock-${messageId}` });
    expect(after?.replayedAt).toBeTypeOf("number");
    expect(mockOutbox.map((row) => row.result)).toEqual(["accepted", "replayed"]);

    // Verified on the next run: no retry click ever closes it.
    await runChecks(s.t);
    const closed = await s.t.run((ctx) => ctx.db.get(incident._id));
    expect(closed).toMatchObject({ open: false, state: "resolved", resolution: { how: "verified" } });
  });

  test("is not sent when the work moved on: Dispatch already offered the visit to someone else", async () => {
    const s = await setup(["Lena"], { Lena: "+15550100006" });
    await s.autonomous();
    await dispatchJob(s.as, s.companyId, s.place);
    await flush(s.t);
    vi.advanceTimersByTime(6 * MINUTE);
    await s.t.mutation(internal.messaging.sweepStuck, {});
    await runChecks(s.t);
    await flush(s.t);
    const offer = await s.t.run(async (ctx) => (await ctx.db.query("messages").collect()).find((m) => m.purpose === "offer")!);
    // The old offer's link was closed when Dispatch moved on, so the check refused to send it, and it stays unconfirmed.
    expect(offer).toMatchObject({ status: "unconfirmed" });
    expect(offer.problem).toMatch(/Not checked with the provider: The link was closed/);
    expect(mockOutbox.map((row) => row.result)).toEqual(["accepted"]);
  });

  test("a company that pauses the agent before the check runs gets nothing sent; the message stays unconfirmed", async () => {
    const s = await setup(["Lena"], { Lena: "+15550100006" });
    await s.autonomous();
    await dispatchJob(s.as, s.companyId, s.place);
    await flush(s.t);
    vi.advanceTimersByTime(6 * MINUTE);
    await s.t.mutation(internal.messaging.sweepStuck, {});
    await runChecks(s.t);
    // Paused between the reconcile being queued and it running.
    await s.as.mutation(api.companies.setPausedAgents, { companyId: s.companyId, agents: ["dispatch"] });
    await flush(s.t);
    const offer = await s.t.run(async (ctx) => (await ctx.db.query("messages").collect()).find((m) => m.purpose === "offer")!);
    expect(offer.status).toBe("unconfirmed");
    expect(offer.problem).toMatch(/Not checked with the provider/);
    expect(mockOutbox.map((row) => row.result)).toEqual(["accepted"]);
  });

  test("an owner can leave an unconfirmed message; it is no longer tracked, and nothing is sent", async () => {
    const s = await setup(["Lena"], { Lena: "+15550100006" });
    await s.autonomous();
    await dispatchJob(s.as, s.companyId, s.place);
    await flush(s.t);
    vi.advanceTimersByTime(40 * MINUTE);
    await s.t.mutation(internal.messaging.sweepStuck, {});
    await runChecks(s.t);
    // Older than the automatic window: a person decides.
    const [incident] = await openIncidents(s.t, s.companyId);
    expect(incident.state).toBe("waiting_owner");
    const rows = await s.as.query(api.operations.uncertainMessages, { companyId: s.companyId, incidentId: incident._id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ canCheck: true, to: "…0006" });
    await s.as.mutation(api.operations.leaveMessage, { companyId: s.companyId, messageId: rows[0].id });
    await runChecks(s.t);
    expect(await openIncidents(s.t, s.companyId)).toHaveLength(0);
    expect(mockOutbox.map((row) => row.result)).toEqual(["accepted"]);
  });
});

describe("Operations: detection, deduplication and verified resolution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.EMAIL_PROVIDER = "mock";
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.EMAIL_PROVIDER;
  });

  test("an expired hiring inbox is one incident however often it is seen, the owner is emailed once, and it closes when reconnected", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Brightside Cleaning Co.");
    const mailbox = await expiredMailbox(t, companyId);
    await runChecks(t);
    await runChecks(t);
    const open = await openIncidents(t, companyId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: "Your hiring inbox needs reconnecting", state: "waiting_owner", action: { kind: "reconnect", href: "/app/settings/integrations?tool=gmail" } });
    // What the owner sees: plain words, the one action, no provider codes.
    const view = await as.query(api.operations.forCompany, { companyId });
    expect(view.issues).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain("invalid_grant");
    // One notice planned for the hour, however many runs.
    const notices = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.purpose === "member_notice" && m.notice?.event === "operations_attention"));
    expect(notices).toHaveLength(1);

    // Reconnecting (the record changing) is the evidence; the next run closes it and plans the recovery notice.
    await t.run((ctx) => ctx.db.patch(mailbox, { status: "connected", problem: undefined }));
    await runChecks(t);
    expect(await openIncidents(t, companyId)).toHaveLength(0);
    const [closed] = await t.run((ctx) => ctx.db.query("incidents").collect());
    expect(closed.resolution?.evidence).toMatch(/no longer found/);
  });

  test("a worker that stops mid-task is tracked until the task record itself moves on", async () => {
    const t = start();
    const { companyId } = await company(t, "owner-a", "Brightside Cleaning Co.");
    const startedBy = await ownerMember(t, companyId);
    const taskId = await t.run(async (ctx) => {
      const activationId = await ctx.db.insert("activations", { companyId, focus: "sales", secondary: [], source: "workspace", contextVersion: "v1", context: [], status: "running", startedBy, startedAt: NOW - HOUR, budget: { estimatedCredits: 10, ceilingCredits: 20, allowance: "none" }, noticed: {}, updatedAt: NOW });
      return ctx.db.insert("activationTasks", { companyId, activationId, template: "sales.booking_page", agent: "sales", title: "Draft your booking page", objective: "o", sources: [], expectedOutput: "e", prerequisites: [], authority: { action: null, words: "" }, estimate: { credits: 1, externalCents: 0, words: "" }, priority: 1, dependsOn: [], completion: "c", state: "working", statusLine: "Working", steps: [], outputs: [], attempts: 2, leaseUntil: NOW - 30 * MINUTE, nextRunAt: NOW, charges: [], approvals: [], createdAt: NOW - HOUR, updatedAt: NOW - 30 * MINUTE });
    });
    await runChecks(t);
    const [incident] = await openIncidents(t, companyId);
    expect(incident).toMatchObject({ kind: "agent.activation_stalled", state: "needs_staff", recoveryAttempts: 2 });
    await t.run((ctx) => ctx.db.patch(taskId, { state: "completed", leaseUntil: undefined, finishedAt: NOW }));
    await runChecks(t);
    expect(await openIncidents(t, companyId)).toHaveLength(0);
  });

  test("three companies losing Google authorization share a platform incident; each keeps its own", async () => {
    const t = start();
    const boxes: Id<"mailboxConnections">[] = [];
    for (const name of ["One", "Two", "Three"]) {
      const { companyId } = await company(t, `owner-${name}`, `${name} Cleaning`);
      boxes.push(await expiredMailbox(t, companyId, `${name.toLowerCase()}@example.com`));
    }
    await runChecks(t);
    const open = await openIncidents(t);
    const platform = open.filter((row) => row.scope === "platform");
    expect(platform).toHaveLength(1);
    expect(platform[0]).toMatchObject({ severity: "critical", occurrences: 3 });
    expect(open.filter((row) => row.scope === "company" && row.parentId === platform[0]._id)).toHaveLength(3);
    // Two reconnect: one company left, so the platform incident closes and the last company keeps its own.
    await t.run(async (ctx) => {
      await ctx.db.patch(boxes[0], { status: "connected" });
      await ctx.db.patch(boxes[1], { status: "connected" });
    });
    await runChecks(t);
    const after = await openIncidents(t);
    expect(after.map((row) => row.scope)).toEqual(["company"]);
  });

  test("messages waiting for funds keep their words, and the owner is asked to add funds", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Brightside Cleaning Co.");
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i += 1) await ctx.db.insert("messages", { companyId, purpose: "reminder", channel: "sms", to: `+1512555000${i}`, body: "See you tomorrow", dedupeKey: `held-${i}`, status: "held", holdReason: "messaging_balance", heldAt: NOW - HOUR, attempts: 0, queuedAt: NOW - HOUR });
    });
    await runChecks(t);
    const view = await as.query(api.operations.forCompany, { companyId, area: "billing" });
    expect(view.issues[0]).toMatchObject({ title: "2 messages are waiting for funds", action: { kind: "add_funds", href: "/app/settings/billing?tab=messaging#add-funds" } });
    expect(view.issues[0].done).toMatch(/Kept every message and its words/);
  });

  test("monitoring that stopped reads stale, to owners and to staff", async () => {
    process.env.STAFF_BOOTSTRAP_EMAIL = ADMIN.email;
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Brightside Cleaning Co.");
    await runChecks(t);
    expect((await as.query(api.operations.forCompany, { companyId })).stale).toBe(false);
    vi.advanceTimersByTime(3 * HOUR);
    expect((await as.query(api.operations.forCompany, { companyId })).stale).toBe(true);
    const overview = await t.withIdentity(ADMIN).query(api.operations.overview, { asOf: Date.now() });
    expect(overview.monitorStale).toBe(true);
    expect(overview.monitor.every((row) => row.stale)).toBe(true);
    delete process.env.STAFF_BOOTSTRAP_EMAIL;
  });

  test("another company cannot read or act on an incident", async () => {
    const t = start();
    const a = await company(t, "owner-a", "Alpha");
    const b = await company(t, "owner-b", "Beta");
    await expiredMailbox(t, a.companyId);
    await runChecks(t);
    const [incident] = await openIncidents(t, a.companyId);
    expect((await b.as.query(api.operations.forCompany, { companyId: b.companyId })).issues).toHaveLength(0);
    expect(await refusal(b.as.mutation(api.operations.requestSupport, { companyId: b.companyId, incidentId: incident._id }))).toBe("Not found.");
    expect(await refusal(b.as.query(api.operations.forCompany, { companyId: a.companyId }))).toBe("Not found.");
  });

  test("asking for support attaches what Selestial knows and is recorded once an hour", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha");
    await expiredMailbox(t, companyId);
    await runChecks(t);
    const [incident] = await openIncidents(t, companyId);
    const ref = await as.mutation(api.operations.requestSupport, { companyId, incidentId: incident._id, note: "It keeps asking me" });
    expect(ref).toMatch(/^INC-[A-Z0-9]{6}$/);
    await as.mutation(api.operations.requestSupport, { companyId, incidentId: incident._id });
    const log = await t.run(async (ctx) => (await ctx.db.query("opsLog").collect()).filter((row) => row.kind === "support_requested"));
    expect(log).toHaveLength(1);
    const view = await as.query(api.operations.forCompany, { companyId });
    expect(view.issues[0].supportRequestedAt).toBeTypeOf("number");
  });
});

describe("Operations: staff actions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.STAFF_BOOTSTRAP_EMAIL = ADMIN.email;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.STAFF_BOOTSTRAP_EMAIL;
  });

  test("a reviewer can look but not act; an admin's actions are logged with their name and reason", async () => {
    const t = start();
    const { companyId } = await company(t, "owner-a", "Alpha");
    await expiredMailbox(t, companyId);
    await runChecks(t);
    const [incident] = await openIncidents(t, companyId);
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.staff.add, { email: "reviewer@selestial.example", name: "Rae Reviewer", role: "reviewer" });
    const reviewer = t.withIdentity({ subject: "user_reviewer", email: "reviewer@selestial.example", emailVerified: true, name: "Rae" });
    expect((await reviewer.query(api.operations.incidents, { view: "attention" })).length).toBe(1);
    expect(await refusal(reviewer.mutation(api.operations.assign, { id: incident._id }))).toBe("Not allowed.");
    expect(await refusal(reviewer.mutation(api.operations.stopOutbound, { companyId, reason: "Testing the stop control" }))).toBe("Not allowed.");
    await admin.mutation(api.operations.assign, { id: incident._id });
    await admin.mutation(api.operations.note, { id: incident._id, words: "Owner says they changed their Google password." });
    const detail = await admin.query(api.operations.incident, { id: incident._id });
    expect(detail.assignedTo).toBe("Avery Ops");
    expect(detail.log.map((row) => row.actor)).toContain("Avery Ops");
    // Staff notes never reach the owner's card.
    const owner = t.withIdentity({ subject: "owner-a", email: "owner-a@example.com", emailVerified: true, name: "owner-a", issuer: "https://clerk.selestial.test", tokenIdentifier: "https://clerk.selestial.test|owner-a" });
    expect(JSON.stringify(await owner.query(api.operations.forCompany, { companyId }))).not.toContain("Google password");
  });

  test("dismissing needs a reason, and the same problem stays dismissed for a week unless it grows", async () => {
    const t = start();
    const { companyId } = await company(t, "owner-a", "Alpha");
    await expiredMailbox(t, companyId);
    await runChecks(t);
    const [incident] = await openIncidents(t, companyId);
    const admin = t.withIdentity(ADMIN);
    expect(await refusal(admin.mutation(api.operations.dismiss, { id: incident._id, reason: "no" }))).toMatch(/Say why/);
    await admin.mutation(api.operations.dismiss, { id: incident._id, reason: "Company is closing; owner asked us to ignore this inbox." });
    await runChecks(t);
    expect(await openIncidents(t, companyId)).toHaveLength(0);
  });

  test("verify resolves only when the check no longer finds the problem", async () => {
    const t = start();
    const { companyId } = await company(t, "owner-a", "Alpha");
    const box = await expiredMailbox(t, companyId);
    await runChecks(t);
    const [incident] = await openIncidents(t, companyId);
    const admin = t.withIdentity(ADMIN);
    expect(await admin.mutation(api.operations.verify, { id: incident._id })).toEqual({ open: true });
    await t.run((ctx) => ctx.db.patch(box, { status: "connected" }));
    expect(await admin.mutation(api.operations.verify, { id: incident._id })).toEqual({ open: false });
  });
});

describe("Operations: Selestial's outbound stop", () => {
  let undo: () => void;
  beforeEach(() => {
    undo = dispatchTestEnv();
    resetMockProvider();
    process.env.STAFF_BOOTSTRAP_EMAIL = ADMIN.email;
  });
  afterEach(() => {
    undo();
    delete process.env.STAFF_BOOTSTRAP_EMAIL;
  });

  test("refuses every outbound text while set, keeps STOP answers flowing, and releases nothing on resume", async () => {
    const s = await setup(["Lena"]);
    await s.autonomous();
    const admin = s.t.withIdentity(ADMIN);
    await admin.mutation(api.operations.stopOutbound, { companyId: s.companyId, reason: "Investigating duplicate texts reported by the owner" });
    await dispatchJob(s.as, s.companyId, s.place);
    await flush(s.t);
    expect(mockOutbox.filter((row) => row.result === "accepted")).toHaveLength(0);
    const offer = await s.t.run(async (ctx) => (await ctx.db.query("messages").collect()).find((m) => m.purpose === "offer")!);
    expect(offer).toMatchObject({ status: "not_sent", refusal: "outbound_stopped" });
    // A STOP from the cleaner is still honored and answered.
    await s.t.mutation(internal.inbound.sms, { to: s.smsNumber, from: s.phone.Lena, body: "STOP", receivedAt: Date.now() });
    await flush(s.t);
    expect(mockOutbox.filter((row) => row.result === "accepted" && row.to === s.phone.Lena)).toHaveLength(1);
    await admin.mutation(api.operations.resumeOutbound, { companyId: s.companyId, reason: "Cause found and fixed" });
    await flush(s.t);
    expect((await s.t.run((ctx) => ctx.db.get(offer._id)))?.status).toBe("not_sent");
    const overview = await admin.query(api.operations.overview, { asOf: Date.now() });
    expect(overview.outboundStops).toHaveLength(0);
  });
});

describe("Deployment isolation", () => {
  let undo: () => void;
  beforeEach(() => {
    undo = dispatchTestEnv();
    resetMockProvider();
  });
  afterEach(() => {
    undo();
    process.env.SELESTIAL_DEPLOYMENT = "local";
    delete process.env.SELESTIAL_TEST_RECIPIENTS;
    delete process.env.STRIPE_SECRET_KEY;
  });

  test("a test backend texts only its listed recipients", async () => {
    process.env.SELESTIAL_DEPLOYMENT = "test";
    process.env.SELESTIAL_TEST_RECIPIENTS = "+15550102020, qa@selestial.example";
    const s = await setup(["Lena", "Rosa"]);
    await s.autonomous();
    await dispatchJob(s.as, s.companyId, s.place);
    await flush(s.t);
    const messages = await s.t.run((ctx) => ctx.db.query("messages").collect());
    const lena = messages.find((m) => m.to === s.phone.Lena);
    expect(lena).toMatchObject({ status: "not_sent", refusal: "not_test_recipient" });
    expect(mockOutbox.some((row) => row.to === s.phone.Lena)).toBe(false);
  });

  test("a restored backend runs no scheduled job, sends nothing and calls no payment provider", async () => {
    process.env.SELESTIAL_DEPLOYMENT = "restore";
    const t = start();
    expect(await t.mutation(internal.cronGate.gate, { job: "assignments.expireDue" })).toBe("held");
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    expect(stripeConfig()).toBeNull();
    expect(autumnConfig()).toBeNull();
    process.env.SELESTIAL_DEPLOYMENT = "test";
    process.env.STRIPE_SECRET_KEY = "sk_live_123";
    expect(stripeConfig()).toBeNull();
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    expect(stripeConfig()).toMatchObject({ livemode: false });
    expect(await t.mutation(internal.cronGate.gate, { job: "assignments.expireDue" })).toBe("scheduled");
    const { companyId } = await company(t, "owner-x", "Xeno");
    await readyMessaging(t, companyId);
  });
});
