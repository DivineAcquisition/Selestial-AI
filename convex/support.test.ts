/**
 * Admin support sessions (docs/operations/03-support-sessions.md): the acceptance tests from the brief.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mockOutbox, resetMockProvider } from "./lib/messaging/provider";
import { company, NOW, refusal, start, type T } from "../tests/harness";
import { dispatchTestEnv, flush, setup } from "../tests/dispatchHarness";

const MINUTE = 60_000;
const ISSUER = "https://clerk.selestial.test";
const ADMIN = { subject: "user_ops_admin", email: "admin@selestial.example", emailVerified: true, name: "Avery Admin", issuer: ISSUER };
const fresh = { fva: [2, 2] };

function staffIdentity(name: string, extra: Record<string, unknown> = {}) {
  return { subject: `user_${name}`, email: `${name}@selestial.example`, emailVerified: true, name, issuer: ISSUER, ...extra };
}

async function staffWith(t: T, name: string, role: "support" | "support_lead" | "billing" | "reviewer") {
  await t.withIdentity(ADMIN).mutation(api.staff.add, { email: `${name}@selestial.example`, name, role });
  return { plain: t.withIdentity(staffIdentity(name)), strong: t.withIdentity(staffIdentity(name, fresh)) };
}

async function begin(t: T, as: ReturnType<T["withIdentity"]>, companyId: Id<"companies">) {
  return as.mutation(api.support.start, { companyId, reason: "Owner reported their hiring inbox stopped syncing" });
}

describe("Admin support sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.STAFF_BOOTSTRAP_EMAIL = ADMIN.email;
    process.env.EMAIL_PROVIDER = "mock";
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.STAFF_BOOTSTRAP_EMAIL;
    delete process.env.EMAIL_PROVIDER;
  });

  test("only staff holding workspace access can start a session, and only with a reason", async () => {
    const t = start();
    const { companyId } = await company(t, "owner-a", "Brightside Cleaning Co.");
    await t.withIdentity(ADMIN).query(api.staff.me, {});
    const reviewer = await staffWith(t, "rae", "reviewer");
    const outsider = t.withIdentity({ subject: "user_x", email: "x@example.com", emailVerified: true, name: "X", issuer: ISSUER });
    expect(await refusal(outsider.mutation(api.support.start, { companyId, reason: "Just looking around" }))).toBe("Not found.");
    expect(await refusal(reviewer.plain.mutation(api.support.start, { companyId, reason: "Just looking around" }))).toBe("Not allowed.");
    const support = await staffWith(t, "sam", "support");
    expect(await refusal(support.plain.mutation(api.support.start, { companyId, reason: "hi" }))).toMatch(/Say why/);
    expect(await begin(t, support.plain, companyId)).toBeTruthy();
  });

  test("View mode reads the workspace and refuses every write on the server", async () => {
    const t = start();
    const { companyId } = await company(t, "owner-a", "Brightside Cleaning Co.");
    await t.withIdentity(ADMIN).query(api.staff.me, {});
    const support = await staffWith(t, "sam", "support");
    const sessionId = await begin(t, support.plain, companyId);
    expect(await support.plain.query(api.companies.get, { companyId, supportSessionId: sessionId })).toMatchObject({ name: "Brightside Cleaning Co." });
    expect(await refusal(support.plain.mutation(api.companies.setPausedAgents, { companyId, supportSessionId: sessionId, agents: ["sales"] }))).toMatch(/View only/);
    // Without naming the session, the admin is nobody in this company: other tabs never change context.
    expect(await refusal(support.plain.query(api.companies.get, { companyId }))).toBe("Not found.");
  });

  test("a session reaches only its own company, and each tab keeps its own session", async () => {
    const t = start();
    const a = await company(t, "owner-a", "Alpha");
    const b = await company(t, "owner-b", "Beta");
    await t.withIdentity(ADMIN).query(api.staff.me, {});
    const support = await staffWith(t, "sam", "support");
    const sessionA = await begin(t, support.plain, a.companyId);
    const sessionB = await begin(t, support.plain, b.companyId);
    expect(await refusal(support.plain.query(api.companies.get, { companyId: b.companyId, supportSessionId: sessionA }))).toBe("Not found.");
    expect((await support.plain.query(api.companies.get, { companyId: a.companyId, supportSessionId: sessionA })).name).toBe("Alpha");
    expect((await support.plain.query(api.companies.get, { companyId: b.companyId, supportSessionId: sessionB })).name).toBe("Beta");
    // Another staff member cannot use someone else's session.
    const other = await staffWith(t, "kim", "support");
    expect(await refusal(other.plain.query(api.companies.get, { companyId: a.companyId, supportSessionId: sessionA }))).toBe("Not found.");
  });

  test("Manage needs the capability, a reason and a fresh two-step sign-in; the owner is emailed once", async () => {
    const t = start();
    const { companyId } = await company(t, "owner-a", "Brightside Cleaning Co.");
    await t.withIdentity(ADMIN).query(api.staff.me, {});
    const billing = await staffWith(t, "bea", "billing");
    const billingSession = await begin(t, billing.strong, companyId);
    expect(await refusal(billing.strong.mutation(api.support.setMode, { sessionId: billingSession, mode: "manage", reason: "Fix their pricing draft" }))).toMatch(/can't manage/);
    const support = await staffWith(t, "sam", "support");
    const sessionId = await begin(t, support.plain, companyId);
    expect(await refusal(support.plain.mutation(api.support.setMode, { sessionId, mode: "manage", reason: "Pause Sales while we fix the inbox" }))).toMatch(/two-step verification/);
    const stale = t.withIdentity(staffIdentity("sam", { fva: [90, 90] }));
    expect(await refusal(stale.mutation(api.support.setMode, { sessionId, mode: "manage", reason: "Pause Sales while we fix the inbox" }))).toMatch(/more than 15 minutes/);
    await support.strong.mutation(api.support.setMode, { sessionId, mode: "manage", reason: "Pause Sales while we fix the inbox" });
    await support.strong.mutation(api.support.setMode, { sessionId, mode: "view" });
    await support.strong.mutation(api.support.setMode, { sessionId, mode: "manage", reason: "Pause Sales while we fix the inbox" });
    const notices = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.notice?.event === "support_session"));
    expect(notices).toHaveLength(1);
  });

  test("in Manage, only functions with a support rule run; approvals stay the owner's; every change names Selestial Support", async () => {
    const t = start();
    const { as: owner, companyId } = await company(t, "owner-a", "Brightside Cleaning Co.");
    await t.withIdentity(ADMIN).query(api.staff.me, {});
    const support = await staffWith(t, "sam", "support");
    const sessionId = await begin(t, support.plain, companyId);
    await support.strong.mutation(api.support.setMode, { sessionId, mode: "manage", reason: "Pause Sales while we fix the inbox" });
    // No support rule: refused, even in Manage.
    expect(await refusal(support.strong.mutation(api.companies.update, { companyId, supportSessionId: sessionId, name: "Hacked" }))).toMatch(/can't make this change/);
    const approvalId = await t.run((ctx) => ctx.db.insert("approvals", { companyId, agent: "sales", action: "sales.send_quote", summary: "Send a quote", reason: "r", status: "pending", decideBy: NOW + 60 * MINUTE, createdAt: NOW }));
    expect(await refusal(support.strong.mutation(api.approvals.decide, { companyId, supportSessionId: sessionId, approvalId, decision: "approved" }))).toMatch(/can't make this change/);
    // A support rule: it runs, and the record says who did it.
    await support.strong.mutation(api.companies.setPausedAgents, { companyId, supportSessionId: sessionId, agents: ["sales"] });
    expect((await owner.query(api.companies.get, { companyId })).pausedAgents).toEqual(["sales"]);
    const event = await t.run(async (ctx) => (await ctx.db.query("events").collect()).find((e) => e.type === "company.agents_paused_changed")!);
    const actor = await t.run(async (ctx) => (event.actor.kind === "member" ? ctx.db.get(event.actor.memberId) : null));
    expect(actor).toMatchObject({ name: "Selestial Support", status: "support" });
    // The support row is never one of the team, and never one of the admin's companies.
    expect((await owner.query(api.members.list, { companyId })).map((m) => m.name)).not.toContain("Selestial Support");
    expect(await support.plain.query(api.companies.mine, {})).toEqual([]);
    // The owner's history shows the session, why, and what changed; exiting ends it and sends one summary.
    await support.plain.mutation(api.support.exit, { sessionId });
    const history = await owner.query(api.support.history, { companyId });
    expect(history[0]).toMatchObject({ everManaged: true, reason: "Owner reported their hiring inbox stopped syncing", live: false });
    expect(history[0].changes.map((c) => c.summary)).toEqual(["Changed which agents are paused"]);
    const summaries = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.notice?.event === "support_session" && m.notice.facts?.kind === "summary"));
    expect(summaries).toHaveLength(1);
    expect(await refusal(support.plain.query(api.companies.get, { companyId, supportSessionId: sessionId }))).toMatch(/ended/);
  });

  test("an expired session stops working at once, and removing staff access revokes it", async () => {
    const t = start();
    const { companyId } = await company(t, "owner-a", "Brightside Cleaning Co.");
    await t.withIdentity(ADMIN).query(api.staff.me, {});
    const support = await staffWith(t, "sam", "support");
    const sessionId = await support.plain.mutation(api.support.start, { companyId, reason: "Check onboarding readiness", minutes: 10 });
    vi.advanceTimersByTime(11 * MINUTE);
    expect(await refusal(support.plain.query(api.companies.get, { companyId, supportSessionId: sessionId }))).toMatch(/ended/);
    await t.mutation(internal.support.expire, { sessionId });
    expect((await support.plain.query(api.support.current, { sessionId }))?.endReason).toBe("expired");

    const second = await begin(t, support.plain, companyId);
    const sam = (await t.withIdentity(ADMIN).query(api.staff.list, {})).find((row) => row.name === "sam")!;
    await t.withIdentity(ADMIN).mutation(api.staff.remove, { staffId: sam.id as Id<"staff"> });
    expect(await refusal(support.plain.query(api.companies.get, { companyId, supportSessionId: second }))).toBe("Not found.");
  });
});

describe("Admin support sessions: background work rechecks the session", () => {
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

  test("a check support asked for does not run after the session ended, and no retry can send twice", async () => {
    const s = await setup(["Lena"], { Lena: "+15550100006" });
    await s.t.withIdentity(ADMIN).query(api.staff.me, {});
    const lead = await staffWith(s.t, "lee", "support_lead");
    const messageId = await s.t.run((ctx) => ctx.db.insert("messages", { companyId: s.companyId, purpose: "assignment_confirmed", channel: "sms", cleanerId: s.cleaners.Lena, to: s.phone.Lena, body: "You're confirmed for tomorrow at 9.", dedupeKey: "confirm-2", status: "queued", attempts: 0, queuedAt: Date.now() }));
    await s.t.action(internal.messaging.deliver, { messageId }).catch(() => undefined);
    vi.advanceTimersByTime(40 * MINUTE);
    await s.t.mutation(internal.messaging.sweepStuck, {});
    const sessionId = await begin(s.t, lead.plain, s.companyId);
    await lead.strong.mutation(api.support.setMode, { sessionId, mode: "manage", reason: "Check the unconfirmed confirmation text" });
    await lead.strong.mutation(api.operations.checkMessage, { companyId: s.companyId, supportSessionId: sessionId, messageId });
    // The admin leaves before the scheduled send runs.
    await lead.plain.mutation(api.support.exit, { sessionId });
    await flush(s.t);
    const message = await s.t.run((ctx) => ctx.db.get(messageId));
    expect(message).toMatchObject({ status: "unconfirmed" });
    expect(message?.problem).toMatch(/support session that asked for this check ended/);
    expect(mockOutbox.map((row) => row.result)).toEqual(["accepted"]);
    const actions = await s.t.run(async (ctx) => (await ctx.db.query("supportActions").collect()).filter((row) => row.kind === "external"));
    expect(actions.map((row) => row.summary)).toEqual(["Checked with the texting provider whether a message went"]);
  });
});

describe("Admin support sessions: every company function is bound to the session", () => {
  test("every public function that takes a companyId also takes supportSessionId (it goes through the company builders)", async () => {
    const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./_generated/**", "!./lib/**"], { eager: true }) as Record<string, Record<string, unknown>>;
    const missing: string[] = [];
    for (const [path, mod] of Object.entries(modules)) {
      for (const [name, fn] of Object.entries(mod)) {
        if (typeof fn !== "function") continue;
        const f = fn as unknown as { isPublic?: boolean; exportArgs?: () => string };
        if (!f.isPublic || typeof f.exportArgs !== "function") continue;
        const args = JSON.parse(f.exportArgs()) as { type: string; value?: Record<string, unknown> };
        if (args.type !== "object" || !args.value) continue;
        if ("companyId" in args.value && !("supportSessionId" in args.value)) missing.push(`${path}:${name}`);
      }
    }
    // Staff functions that name a company (credits, suspension, the outbound stop) act from the staff console, not inside a workspace.
    // members.join runs before a person has any membership (the onboarding screen), never inside a workspace.
    const STAFF_CONSOLE = ["./members.ts:join", "./compliance.ts:setRegistration", "./requests.ts:route", "./messagingFunds.ts:supportCredit", "./compliance.ts:setSuspended", "./operations.ts:stopOutbound", "./operations.ts:resumeOutbound", "./operations.ts:incidents", "./support.ts:start", "./support.ts:sessions"];
    expect(missing.filter((name) => !STAFF_CONSOLE.includes(name))).toEqual([]);
  });
});
