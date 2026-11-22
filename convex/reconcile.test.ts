/**
 * Settling unconfirmed texts with the provider (convex/lib/operations/reconcile.ts), and the gaps ported
 * on top of Operations: a support session's background check is rechecked when it runs, public Google
 * writes wait out a suspension, and every company function is bound to the support session.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mockOutbox, resetMockProvider } from "./lib/messaging/provider";
import { company, dispatchJob, refusal, type T } from "../tests/harness";
import { dispatchTestEnv, flush, setup } from "../tests/dispatchHarness";

const MINUTE = 60_000;
const admin = { subject: "user_ops_admin", email: "ops-admin@selestial.example", emailVerified: true, name: "Avery Admin", fva: [1, 1] };

/** A job confirmation to a cleaner who agreed to work texts, sent to a number the mock accepts and then loses the answer for. */
async function lostAnswer(s: Awaited<ReturnType<typeof setup>>, dedupeKey = "confirm-1") {
  const messageId = await s.t.run((ctx) => ctx.db.insert("messages", { companyId: s.companyId, purpose: "assignment_confirmed", channel: "sms", cleanerId: s.cleaners.Lena, to: s.phone.Lena, body: "You're confirmed for tomorrow at 9.", dedupeKey, status: "queued", attempts: 0, queuedAt: Date.now() }));
  await s.t.action(internal.messaging.deliver, { messageId }).catch(() => undefined);
  return messageId;
}

async function unconfirm(t: T, after: number) {
  vi.advanceTimersByTime(after);
  await t.mutation(internal.messaging.sweepStuck, {});
}

const check = (t: T) => t.mutation(internal.operations.runCheck, { check: "uncertain_messages" });
const incidentOf = (t: T, companyId: Id<"companies">) => t.run(async (ctx) => (await ctx.db.query("incidents").collect()).find((row) => row.key === `message_unconfirmed:${companyId}`) ?? null);

describe("Unconfirmed texts are settled with the provider, never sent twice", () => {
  let undo: () => void;
  beforeEach(() => {
    undo = dispatchTestEnv();
    resetMockProvider();
  });
  afterEach(() => undo());

  test("a provider that accepted and timed out replays its answer: one send, the record says sent", async () => {
    const s = await setup(["Lena"], { Lena: "+15550100006" });
    const messageId = await lostAnswer(s);
    expect(mockOutbox.map((row) => row.result)).toEqual(["accepted"]);
    await unconfirm(s.t, 6 * MINUTE);
    expect((await s.t.run((ctx) => ctx.db.get(messageId)))?.status).toBe("unconfirmed");

    // The monitor checks a fresh one by itself, under the message's own key.
    await check(s.t);
    expect(await incidentOf(s.t, s.companyId)).toMatchObject({ kind: "message_unconfirmed", state: "recovering" });
    await flush(s.t);
    const after = await s.t.run((ctx) => ctx.db.get(messageId));
    expect(after).toMatchObject({ status: "sent", providerMessageId: `mock-${messageId}` });
    expect(after?.replayedAt).toBeTypeOf("number");
    expect(mockOutbox.map((row) => row.result)).toEqual(["accepted", "replayed"]);
    // Settled by the record, not by the click: the next check closes the incident.
    await check(s.t);
    expect((await incidentOf(s.t, s.companyId))?.resolvedAt).toBeGreaterThan(0);
  });

  test("work that moved on is not sent: Dispatch already offered the visit to someone else", async () => {
    const s = await setup(["Lena"], { Lena: "+15550100006" });
    await s.autonomous();
    await dispatchJob(s.as, s.companyId, s.place);
    await flush(s.t);
    await unconfirm(s.t, 6 * MINUTE);
    await check(s.t);
    await flush(s.t);
    const offer = await s.t.run(async (ctx) => (await ctx.db.query("messages").collect()).find((m) => m.purpose === "offer")!);
    expect(offer.status).toBe("unconfirmed");
    expect(offer.problem).toMatch(/Not checked with the provider: The link was closed/);
    expect(mockOutbox.map((row) => row.result)).toEqual(["accepted"]);
  });

  test("a suspension that lands before the check runs stops it, and the message stays unconfirmed", async () => {
    const s = await setup(["Lena"], { Lena: "+15550100006" });
    const messageId = await lostAnswer(s);
    await unconfirm(s.t, 6 * MINUTE);
    await check(s.t);
    await s.t.run((ctx) => ctx.db.patch(s.companyId, { suspendedAt: Date.now() }));
    await flush(s.t);
    const message = await s.t.run((ctx) => ctx.db.get(messageId));
    expect(message).toMatchObject({ status: "unconfirmed" });
    expect(message?.problem).toMatch(/Not checked with the provider/);
    expect(mockOutbox.map((row) => row.result)).toEqual(["accepted"]);
  });

  test("an older one waits for a person, who can check it or leave it; leaving sends nothing and stops tracking it", async () => {
    const s = await setup(["Lena"], { Lena: "+15550100006" });
    const first = await lostAnswer(s, "confirm-a");
    const second = await lostAnswer(s, "confirm-b");
    await unconfirm(s.t, 45 * MINUTE);
    vi.advanceTimersByTime(30 * MINUTE);
    await check(s.t);
    await flush(s.t);
    expect(mockOutbox.map((row) => row.result)).toEqual(["accepted", "accepted"]);
    const incident = (await incidentOf(s.t, s.companyId))!;
    expect(incident.state).toBe("needs_staff");
    // The owner's card offers the review, with the masked recipient and no message words.
    const issues = await s.as.query(api.operations.issues, { companyId: s.companyId });
    expect(issues.open[0].action).toMatchObject({ kind: "messages" });
    const rows = await s.as.query(api.operations.uncertainMessages, { companyId: s.companyId, incidentId: incident._id });
    expect(rows.map((row) => row.to)).toEqual(["…0006", "…0006"]);
    expect(JSON.stringify(rows)).not.toContain("confirmed for tomorrow");
    // Check one: the provider replays it. Leave the other.
    await s.as.mutation(api.operations.checkMessage, { companyId: s.companyId, messageId: first });
    await s.as.mutation(api.operations.leaveMessage, { companyId: s.companyId, messageId: second });
    await flush(s.t);
    expect((await s.t.run((ctx) => ctx.db.get(first)))?.status).toBe("sent");
    expect((await s.t.run((ctx) => ctx.db.get(second)))).toMatchObject({ status: "unconfirmed" });
    expect(mockOutbox.map((row) => row.result)).toEqual(["accepted", "accepted", "replayed"]);
    await check(s.t);
    expect((await incidentOf(s.t, s.companyId))?.resolvedAt).toBeGreaterThan(0);
  });

  test("past the provider's 24-hour window nothing can be checked, and another company can't act on it", async () => {
    const s = await setup(["Lena"], { Lena: "+15550100006" });
    const messageId = await lostAnswer(s);
    await unconfirm(s.t, 25 * 60 * MINUTE);
    await check(s.t);
    expect(await refusal(s.as.mutation(api.operations.checkMessage, { companyId: s.companyId, messageId }))).toMatch(/too late/);
    const other = await company(s.t, "owner-z", "Zeta");
    expect(await refusal(other.as.mutation(api.operations.checkMessage, { companyId: other.companyId, messageId }))).toBe("Not found.");
  });
});

describe("A support session's check is rechecked when it runs", () => {
  let undo: () => void;
  beforeEach(() => {
    undo = dispatchTestEnv();
    resetMockProvider();
    process.env.STAFF_BOOTSTRAP_EMAIL = admin.email;
    process.env.SUPPORT_ACCESS = "on";
  });
  afterEach(() => {
    undo();
    delete process.env.STAFF_BOOTSTRAP_EMAIL;
    delete process.env.SUPPORT_ACCESS;
  });

  test("needs communications.send, and does not run once the session has ended", async () => {
    const s = await setup(["Lena"], { Lena: "+15550100006" });
    const staff = s.t.withIdentity(admin);
    const messageId = await lostAnswer(s);
    await unconfirm(s.t, 45 * MINUTE);
    await s.as.mutation(api.support.grantManage, { companyId: s.companyId, hours: 4 });
    const sessionId = await staff.mutation(api.support.start, { companyId: s.companyId, reason: "Owner asked about an unconfirmed text" });
    await staff.mutation(api.support.switchToManage, { sessionId, reason: "Check the unconfirmed confirmation text" });
    // Reaching a person is granted per person: an admin without it is refused.
    expect(await refusal(staff.mutation(api.operations.checkMessage, { companyId: s.companyId, supportSessionId: sessionId, messageId }))).toBe("Not allowed.");
    const me = (await staff.query(api.staff.list, {})).find((row) => row.email === admin.email)!;
    await staff.mutation(api.staff.grantCapability, { staffId: me.id, capability: "communications.send", reason: "Settles unconfirmed texts" });
    await staff.mutation(api.operations.checkMessage, { companyId: s.companyId, supportSessionId: sessionId, messageId });
    // The admin leaves before the scheduled send runs: nothing goes.
    await staff.mutation(api.support.exit, { sessionId });
    await flush(s.t);
    const message = await s.t.run((ctx) => ctx.db.get(messageId));
    expect(message).toMatchObject({ status: "unconfirmed" });
    expect(message?.problem).toMatch(/support session that asked for this check ended/);
    expect(mockOutbox.map((row) => row.result)).toEqual(["accepted"]);
  });
});

describe("A suspension holds public Google writes", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a review reply waits while the company is suspended, and runs again once it is lifted", async () => {
    const t = (await import("../tests/harness")).start();
    const { companyId } = await company(t, "owner-a", "Alpha");
    const jobId = await t.run((ctx) => ctx.db.insert("googleJobs", { companyId, kind: "review_reply", key: "reply-1", status: "queued", payload: "{}", attempts: 0, nextAt: Date.now() - 1000, createdAt: Date.now(), updatedAt: Date.now() }));
    await t.run((ctx) => ctx.db.patch(companyId, { suspendedAt: Date.now() }));
    await t.mutation(internal.googleWork.tick, {});
    expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status: "queued", attempts: 0, lastError: expect.stringMatching(/Held/) });
    await t.run((ctx) => ctx.db.patch(companyId, { suspendedAt: undefined }));
    vi.advanceTimersByTime(16 * MINUTE);
    await t.mutation(internal.googleWork.tick, {});
    expect((await t.run((ctx) => ctx.db.get(jobId)))?.status).toBe("running");
  });
});

describe("Every company function is bound to the support session", () => {
  test("each public function that takes a companyId also takes supportSessionId, so it goes through the company builders", async () => {
    const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./_generated/**", "!./lib/**"], { eager: true }) as Record<string, Record<string, unknown>>;
    const missing: string[] = [];
    for (const [path, mod] of Object.entries(modules)) {
      for (const [name, fn] of Object.entries(mod)) {
        if (typeof fn !== "function") continue;
        const f = fn as unknown as { isPublic?: boolean; exportArgs?: () => string };
        if (!f.isPublic || typeof f.exportArgs !== "function") continue;
        const args = JSON.parse(f.exportArgs()) as { type: string; value?: Record<string, unknown> };
        if (args.type === "object" && args.value && "companyId" in args.value && !("supportSessionId" in args.value)) missing.push(`${path}:${name}`);
      }
    }
    // Staff console functions that name a company, and joining before any membership exists. None runs inside a workspace.
    const outsideWorkspace = new Set(["./members.ts:join", "./compliance.ts:setRegistration", "./compliance.ts:setSuspended", "./requests.ts:route", "./messagingFunds.ts:supportCredit", "./support.ts:start", "./operations.ts:list"]);
    expect(missing.filter((name) => !outsideWorkspace.has(name))).toEqual([]);
  });
});
