/**
 * @vitest-environment edge-runtime
 *
 * Agent Controls (docs/foundation/07-agent-controls.md): one policy, changed only by the Owner, applied
 * against the revision that was reviewed, with readiness and "Test these rules" decided by the same
 * checks live work uses.
 */
import { describe, expect, it } from "vitest";

import { addMember, company, HOUR, readyMessaging, refusal, seedVisit, start, type T } from "../tests/harness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { authorityFor } from "./lib/authority";
import { allowanceToday, localDay, reserve, settle } from "./lib/controls/allowance";
import { capabilityOf } from "./lib/controls/capabilities";
import { STALE } from "./lib/controls/policy";
import { reportAction } from "./lib/controls/report";
import { ACTIONS } from "./lib/permissionCatalog";
import { permitFor } from "./lib/retention/cases";

const REMEDY = "retention.remedy_within_limit";

async function memberId(as: ReturnType<T["withIdentity"]>, companyId: Id<"companies">, name: string) {
  return (await as.query(api.members.list, { companyId })).find((m) => m.name === name)!.id;
}

async function counts(t: T) {
  return t.run(async (ctx) => {
    const tables = ["messages", "assignments", "approvals", "events", "tasks", "allowanceReservations", "allowanceDays", "controlChanges", "permissions", "retentionActions", "salesFollowUps", "jobs"] as const;
    const out: Record<string, number> = {};
    for (const table of tables) out[table] = (await ctx.db.query(table).collect()).length;
    return out;
  });
}

describe("Agent Controls: who may change what", () => {
  it("keeps every change with the Owner, and every company's settings to itself", async () => {
    const t = start();
    const a = await company(t, "owner-a", "Alpha Cleaning");
    const b = await company(t, "owner-b", "Beta Cleaning");
    const manager = await addMember(t, a.as, a.companyId, "manager-a", "manager");

    // Each call starts only when it is checked, so no refusal goes unobserved while an earlier one is awaited.
    const refused = [
      () => manager.mutation(api.permissions.set, { companyId: a.companyId, action: "dispatch.send_reminder", level: "execute" }),
      () => manager.mutation(api.permissions.applyPreset, { companyId: a.companyId, preset: "routine", expectedRevision: 0 }),
      () => manager.mutation(api.permissions.setRouting, { companyId: a.companyId, action: "dispatch.send_reminder", approver: { kind: "owner" } }),
      () => manager.mutation(api.companies.pauseAgent, { companyId: a.companyId, agent: "sales" }),
    ];
    for (const run of refused) expect(await refusal(run())).toBe("Not allowed.");
    // A manager sees the workspace and can test rules, but cannot edit.
    expect((await manager.query(api.controls.workspace, { companyId: a.companyId })).canEdit).toBe(false);

    // Another company's owner reaches nothing of Alpha's.
    expect(await refusal(b.as.query(api.controls.workspace, { companyId: a.companyId }))).toBeTruthy();
    expect(await refusal(b.as.query(api.controls.actionHistory, { companyId: a.companyId, action: REMEDY }))).toBeTruthy();
    expect(await refusal(b.as.mutation(api.permissions.set, { companyId: a.companyId, action: "dispatch.send_reminder", level: "execute" }))).toBeTruthy();

    // Alpha's change leaves Beta's settings and history untouched.
    await a.as.mutation(api.permissions.set, { companyId: a.companyId, action: "dispatch.send_reminder", level: "off" });
    expect(await t.run((ctx) => authorityFor(ctx, b.companyId, "dispatch.send_reminder"))).not.toEqual({ kind: "level", level: "off" });
    expect((await b.as.query(api.permissions.changes, { companyId: b.companyId })).rows).toEqual([]);
  });

  it("refuses what always needs a person, and what no agent can do, at any level", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    expect(await refusal(as.mutation(api.permissions.set, { companyId, action: "person.pay_run", level: "propose" }))).toContain("always needs a person");
    for (const action of ["sales.discount_in_band", "sales.discount_out_of_band", "retention.recover_payment", "dispatch.close_visit"]) {
      expect(await refusal(as.mutation(api.permissions.set, { companyId, action, level: "propose" })), action).toBeTruthy();
      expect((await t.run((ctx) => authorityFor(ctx, companyId, action))).kind, action).toBe("unavailable");
    }
    // Recruiter's fixed-requirement decline stays an Owner opt-in, and shows the legal caution.
    await as.mutation(api.permissions.set, { companyId, action: "recruiter.decline_fixed_requirement", level: "execute_and_report" });
    expect(await t.run((ctx) => authorityFor(ctx, companyId, "recruiter.decline_fixed_requirement"))).toEqual({ kind: "level", level: "execute_and_report" });
    const decline = (await as.query(api.permissions.list, { companyId })).actions.find((row) => row.key === "recruiter.decline_fixed_requirement")!;
    expect(decline.note).toContain("counsel");
    expect(decline.label).toContain("never on judgment");
  });
});

describe("Agent Controls: changes against what was reviewed", () => {
  it("refuses a change made from a stale view, and records each change with before and after", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const { revision } = await as.query(api.permissions.list, { companyId });
    await as.mutation(api.permissions.set, { companyId, action: "dispatch.send_reminder", level: "off", expectedRevision: revision });
    // A second tab still holding the old revision cannot save over it.
    expect(await refusal(as.mutation(api.permissions.set, { companyId, action: "dispatch.send_reminder", level: "execute", expectedRevision: revision }))).toBe(STALE);
    expect(await refusal(as.mutation(api.permissions.applyPreset, { companyId, preset: "routine", expectedRevision: revision }))).toBe(STALE);

    const history = await as.query(api.controls.actionHistory, { companyId, action: "dispatch.send_reminder" });
    expect(history.setting).toMatchObject({ level: "off", changedBy: "owner-a", isDefault: false });
    expect(history.changes[0]).toMatchObject({ kind: "permission", to: "Off", by: "owner-a" });
  });

  it("previews a preset, applies exactly that, and restores the earlier settings as a new change", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const before = await as.query(api.permissions.list, { companyId });
    const preview = await as.query(api.permissions.presetPreview, { companyId, preset: "routine" });
    // A preset never touches money, never enables what can't run, and says why.
    for (const change of preview.changes) {
      const def = ACTIONS.find((row) => row.key === change.action)!;
      expect(def.money, change.action).toBe(false);
      expect(before.actions.find((row) => row.key === change.action)!.implemented, change.action).toBe(true);
    }
    // Something changed in between: the reviewed preview no longer applies.
    await as.mutation(api.permissions.set, { companyId, action: "sales.follow_up", level: "off" });
    expect(await refusal(as.mutation(api.permissions.applyPreset, { companyId, preset: "routine", expectedRevision: preview.revision }))).toBe(STALE);
    const fresh = await as.query(api.permissions.presetPreview, { companyId, preset: "routine" });
    expect(fresh.kept.find((row) => row.action === "sales.follow_up")?.why).toContain("switched this off");
    const applied = await as.mutation(api.permissions.applyPreset, { companyId, preset: "routine", expectedRevision: fresh.revision });
    expect(applied.changed).toBe(fresh.changes.length);
    expect((await as.query(api.controls.workspace, { companyId })).preset).not.toBe("review_first");

    // Restore the settings from before the preset: a new revision, recorded as a restore.
    const changes = await as.query(api.permissions.changes, { companyId });
    const presetChange = changes.rows.find((row) => row.kind === "preset")!;
    const restorePreview = await as.query(api.permissions.restorePreview, { companyId, revision: presetChange.revision });
    expect(restorePreview.changes.length).toBe(fresh.changes.length);
    expect(restorePreview.notes.join(" ")).toContain("does not undo");
    await as.mutation(api.permissions.restore, { companyId, revision: presetChange.revision, expectedRevision: restorePreview.revision });
    const after = await as.query(api.permissions.list, { companyId });
    for (const change of fresh.changes) expect(after.actions.find((row) => row.key === change.action)!.level, change.action).toBe(change.from);
    expect((await as.query(api.permissions.changes, { companyId })).rows[0].kind).toBe("restore");
  });

  it("previews raising an action with the real work it would touch, and leaves waiting approvals waiting", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await t.mutation(internal.approvals.request, { companyId, action: REMEDY, summary: "Correction visit", reason: "Kitchen missed", decideBy: Date.now() + HOUR });
    const preview = await as.query(api.permissions.previewChange, { companyId, action: REMEDY, level: "execute_and_report", perActionCents: 5000, perDayCents: 20000 });
    expect(preview.raising).toBe(true);
    expect(preview.refused).toBeNull();
    expect(preview.pending.count).toBe(1);
    expect(preview.pending.words).toContain("stay waiting");
    expect(preview.drafts).toContain("Drafts stay drafts");
    expect(preview.conditions.join(" ")).toContain("resetting at midnight");
    // Without limits, money cannot be delegated, and the preview says so before anything is applied.
    const bare = await as.query(api.permissions.previewChange, { companyId, action: REMEDY, level: "execute" });
    expect(bare.refused).toContain("Set a limit");
    // Applying keeps the waiting approval waiting.
    await as.mutation(api.permissions.set, { companyId, action: REMEDY, level: "execute_and_report", perActionCents: 5000, perDayCents: 20000, expectedRevision: preview.revision });
    expect(await t.run(async (ctx) => (await ctx.db.query("approvals").collect()).map((row) => row.status))).toEqual(["pending"]);
  });
});

describe("Agent Controls: the daily allowance", () => {
  async function withLimit(t: T, perDayCents: number) {
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await as.mutation(api.permissions.set, { companyId, action: REMEDY, level: "execute", perActionCents: Math.min(5000, perDayCents), perDayCents });
    return { as, companyId };
  }
  const source = { table: "retentionActions", id: "x" };

  it("counts every reservation, far past the old 200-row window", async () => {
    const t = start();
    const { companyId } = await withLimit(t, 100_000);
    await t.run(async (ctx) => {
      const company = (await ctx.db.get(companyId))!;
      for (let i = 0; i < 250; i++) expect((await reserve(ctx, company, { action: REMEDY, key: `k${i}`, amountCents: 100, perDayCents: 100_000, source })).ok).toBe(true);
      expect((await allowanceToday(ctx, company, REMEDY, Date.now())).usedCents).toBe(25_000);
      expect((await reserve(ctx, company, { action: REMEDY, key: "big", amountCents: 75_001, perDayCents: 100_000, source })).ok).toBe(false);
      expect((await reserve(ctx, company, { action: REMEDY, key: "fits", amountCents: 75_000, perDayCents: 100_000, source })).ok).toBe(true);
    });
  });

  it("never reserves twice for a retry, and settles each piece of work exactly once", async () => {
    const t = start();
    const { companyId } = await withLimit(t, 10_000);
    await t.run(async (ctx) => {
      const company = (await ctx.db.get(companyId))!;
      const first = await reserve(ctx, company, { action: REMEDY, key: "work-1", amountCents: 4000, perDayCents: 10_000, source });
      const retry = await reserve(ctx, company, { action: REMEDY, key: "work-1", amountCents: 4000, perDayCents: 10_000, source });
      expect(first).toMatchObject({ ok: true, repeated: false });
      expect(retry).toMatchObject({ ok: true, repeated: true });
      expect((await allowanceToday(ctx, company, REMEDY, Date.now())).usedCents).toBe(4000);
      // Failed or cancelled work gives its share back; completed work keeps it. Neither happens twice.
      expect(await settle(ctx, companyId, "work-1", "released")).toBe(true);
      expect(await settle(ctx, companyId, "work-1", "released")).toBe(false);
      expect((await allowanceToday(ctx, company, REMEDY, Date.now())).usedCents).toBe(0);
      await reserve(ctx, company, { action: REMEDY, key: "work-2", amountCents: 6000, perDayCents: 10_000, source });
      expect(await settle(ctx, companyId, "work-2", "committed")).toBe(true);
      expect(await settle(ctx, companyId, "work-2", "released")).toBe(false);
      expect(await allowanceToday(ctx, company, REMEDY, Date.now())).toMatchObject({ committedCents: 6000, reservedCents: 0 });
      // permitFor, the one execution check, now sends anything over the rest of today to approval.
      expect((await permitFor(ctx, companyId, REMEDY, { cents: 4001 }, { key: "work-3", source })).mode).toBe("ask");
      expect((await permitFor(ctx, companyId, REMEDY, { cents: 4000 }, { key: "work-3", source })).mode).toBe("act");
      expect((await permitFor(ctx, companyId, REMEDY, { cents: 4000 }, { key: "work-3", source })).mode).toBe("act");
      expect((await allowanceToday(ctx, company, REMEDY, Date.now())).usedCents).toBe(10_000);
      // An unknown cost is never treated as zero.
      expect((await permitFor(ctx, companyId, REMEDY, { cents: null })).mode).toBe("ask");
    });
  });

  it("lets only one of two concurrent spends through when both would go over", async () => {
    const t = start();
    const { companyId } = await withLimit(t, 10_000);
    const spend = (key: string) =>
      t.run(async (ctx) => {
        const company = (await ctx.db.get(companyId))!;
        return (await reserve(ctx, company, { action: REMEDY, key, amountCents: 6000, perDayCents: 10_000, source })).ok;
      });
    const results = await Promise.all([spend("a"), spend("b")]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("resets on the company's calendar day, not a rolling 24 hours", async () => {
    const t = start();
    const { companyId } = await withLimit(t, 10_000);
    // Chicago is UTC-6 in March 2027: 23:30 on March 1 local is 05:30 UTC on March 2.
    const lateMonday = Date.UTC(2027, 2, 2, 5, 30);
    const earlyTuesday = Date.UTC(2027, 2, 2, 6, 30);
    expect(localDay(lateMonday, "America/Chicago")).toBe("2027-03-01");
    expect(localDay(earlyTuesday, "America/Chicago")).toBe("2027-03-02");
    await t.run(async (ctx) => {
      const company = (await ctx.db.get(companyId))!;
      expect((await reserve(ctx, company, { action: REMEDY, key: "mon", amountCents: 10_000, perDayCents: 10_000, source }, lateMonday)).ok).toBe(true);
      expect((await reserve(ctx, company, { action: REMEDY, key: "mon-2", amountCents: 1, perDayCents: 10_000, source }, lateMonday + 60_000)).ok).toBe(false);
      // An hour later it is a new local day, so the allowance is whole again.
      expect((await reserve(ctx, company, { action: REMEDY, key: "tue", amountCents: 10_000, perDayCents: 10_000, source }, earlyTuesday)).ok).toBe(true);
      const today = await allowanceToday(ctx, company, REMEDY, earlyTuesday);
      expect(today).toMatchObject({ day: "2027-03-02", usedCents: 10_000 });
      expect(today.resetsAt).toBe(Date.UTC(2027, 2, 3, 6, 0));
    });
  });
});

describe("Agent Controls: pause and resume", () => {
  it("pauses one agent atomically, at execution, without losing a concurrent pause", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await Promise.all([as.mutation(api.companies.pauseAgent, { companyId, agent: "dispatch" }), as.mutation(api.companies.pauseAgent, { companyId, agent: "sales" })]);
    expect((await as.query(api.companies.get, { companyId })).pausedAgents.sort()).toEqual(["dispatch", "sales"]);
    expect(await t.run((ctx) => authorityFor(ctx, companyId, "dispatch.send_reminder"))).toEqual({ kind: "paused" });
    const list = await as.query(api.permissions.list, { companyId });
    expect(list.actions.filter((row) => row.agent === "dispatch" && row.implemented).every((row) => row.status.status === "paused")).toBe(true);

    // The whole-list form refuses to overwrite a change it didn't see.
    expect(await refusal(as.mutation(api.companies.setPausedAgents, { companyId, agents: [], expectedRevision: 0 }))).toBe(STALE);
    await as.mutation(api.companies.resumeAgent, { companyId, agent: "dispatch" });
    expect((await t.run((ctx) => authorityFor(ctx, companyId, "dispatch.send_reminder"))).kind).toBe("level");
    expect(await t.run((ctx) => authorityFor(ctx, companyId, "sales.follow_up"))).toEqual({ kind: "paused" });
    await as.mutation(api.companies.pauseAll, { companyId });
    expect((await as.query(api.companies.get, { companyId })).pausedAgents.sort()).toEqual(["dispatch", "recruiter", "retention", "sales"]);
    const kinds = (await as.query(api.permissions.changes, { companyId })).rows.map((row) => row.kind);
    expect(kinds).toEqual(["pause", "resume", "pause", "pause"]);
  });

  it("ends a temporary level at the moment it runs out, for execution and for the screen alike", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await as.mutation(api.permissions.set, { companyId, action: "sales.follow_up", level: "execute", until: Date.now() + HOUR });
    expect(await t.run((ctx) => authorityFor(ctx, companyId, "sales.follow_up"))).toEqual({ kind: "level", level: "execute" });
    const later = Date.now() + 2 * HOUR;
    expect(await t.run((ctx) => authorityFor(ctx, companyId, "sales.follow_up", later))).toMatchObject({ kind: "level", level: "propose", expired: true });
    expect(await refusal(as.mutation(api.permissions.set, { companyId, action: "sales.follow_up", level: "execute", until: Date.now() - 1 }))).toContain("future");
  });
});

describe("Agent Controls: readiness agrees with execution", () => {
  it("never calls an action ready that execution would refuse, and never treats missing setup as ready", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await as.mutation(api.companies.pauseAgent, { companyId, agent: "recruiter" });
    await as.mutation(api.permissions.set, { companyId, action: "dispatch.send_reminder", level: "off" });
    const list = await as.query(api.permissions.list, { companyId });
    for (const row of list.actions) {
      const auth = await t.run((ctx) => authorityFor(ctx, companyId, row.key));
      if (auth.kind === "unavailable") expect(row.status.status, row.key).toBe("unavailable");
      else if (auth.kind === "paused") expect(row.status.status, row.key).toBe("paused");
      else if (auth.kind === "level" && auth.level === "off") expect(row.status.status, row.key).toBe("off");
      else if (auth.kind === "level" && auth.level === "propose") expect(["approval_required", "setup_required", "unavailable"], row.key).toContain(row.status.status);
      // Nothing that texts or emails is ready before texting or email is set up.
      if (row.status.status === "ready") expect(capabilityOf(row.key).needs.filter((need) => ["sms", "email", "outreach", "links"].includes(need)), `${row.key} claims ready with no messaging`).toEqual([]);
    }
    // Every status says what to do next when there is something to do.
    for (const row of list.actions.filter((r) => r.status.status === "setup_required")) expect(row.status.next, row.key).not.toBeNull();
  });

  it("moves an action out of setup once texting is ready, and only then calls it ready", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const status = async () => (await as.query(api.permissions.list, { companyId })).actions.find((row) => row.key === "dispatch.request_acceptance")!.status;
    // On a deployment with no text service, the reason names the deployment, not the company.
    expect((await status()).reason).toContain("isn't connected for Selestial");
    process.env.MESSAGING_PROVIDER = "mock";
    process.env.ACTION_LINK_SECRET = "test-only-secret-for-action-links-0123456789";
    try {
      // The service exists; the company's own texting setup is what is missing, with the way to fix it.
      expect(await status()).toMatchObject({ status: "setup_required", next: { href: "/app/texting" } });
      await readyMessaging(t, companyId);
      expect((await status()).status).toBe("approval_required");
      await as.mutation(api.permissions.set, { companyId, action: "dispatch.request_acceptance", level: "execute" });
      expect((await status()).status).toBe("ready");
      expect(await t.run((ctx) => authorityFor(ctx, companyId, "dispatch.request_acceptance"))).toEqual({ kind: "level", level: "execute" });
    } finally {
      delete process.env.MESSAGING_PROVIDER;
      delete process.env.ACTION_LINK_SECRET;
    }
  });
});

describe("Agent Controls: Test these rules", () => {
  it("runs every scenario, on samples and real records, without writing anything", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await as.mutation(api.permissions.set, { companyId, action: REMEDY, level: "execute", perActionCents: 100, perDayCents: 200 });
    const { jobId } = await seedVisit(as, companyId);
    const before = await counts(t);
    for (const scenario of ["cleaner_declines", "quote_unanswered", "applicant_missing_info", "correction_visit"] as const) {
      const result = await as.query(api.controls.simulate, { companyId, scenario });
      expect(result.hypothetical).toBe(true);
      expect(result.sample).toBe(true);
      expect(result.note).toContain("Nothing was sent");
      expect(result.steps.length).toBeGreaterThan(0);
    }
    const real = await as.query(api.controls.simulate, { companyId, scenario: "cleaner_declines", recordId: jobId });
    expect(real.sample).toBe(false);
    expect(real.record?.href).toContain(jobId);
    expect(await counts(t)).toEqual(before);
  });

  it("decides as live execution does: a sample correction with unknown cost asks first", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await readyMessaging(t, companyId);
    await as.mutation(api.permissions.set, { companyId, action: REMEDY, level: "execute", perActionCents: 5000, perDayCents: 20000 });
    const result = await as.query(api.controls.simulate, { companyId, scenario: "correction_visit" });
    const live = await t.run((ctx) => permitFor(ctx, companyId, REMEDY, { cents: null }));
    expect(live.mode).toBe("ask");
    expect(result.steps[0].decision).toBe("ask");
    expect(result.steps[0].decisionWords).toBe(live.mode === "ask" ? live.why : "");
    // Paused: the test says so, as the agent would refuse.
    await as.mutation(api.companies.pauseAgent, { companyId, agent: "retention" });
    expect((await as.query(api.controls.simulate, { companyId, scenario: "correction_visit" })).steps[0].decision).toBe("refuse");
  });

  it("refuses another company's record", async () => {
    const t = start();
    const a = await company(t, "owner-a", "Alpha Cleaning");
    const b = await company(t, "owner-b", "Beta Cleaning");
    const { jobId } = await seedVisit(a.as, a.companyId);
    expect(await refusal(b.as.query(api.controls.simulate, { companyId: b.companyId, scenario: "cleaner_declines", recordId: jobId }))).toBeTruthy();
  });
});

describe("Agent Controls: approval routing", () => {
  it("routes to the chosen person, falls back when they leave, and never widens what only an Owner decides", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const mia = await addMember(t, as, companyId, "mia", "manager");
    const noor = await addMember(t, as, companyId, "noor", "manager");
    const miaId = await memberId(as, companyId, "mia");
    await as.mutation(api.permissions.setRouting, { companyId, action: REMEDY, approver: { kind: "member", memberId: miaId as Id<"members"> } });
    expect(await refusal(as.mutation(api.permissions.setRouting, { companyId, action: "retention.refund_above_limit", approver: { kind: "member", memberId: miaId as Id<"members"> } }))).toContain("Only an Owner");

    const ask = () => t.mutation(internal.approvals.request, { companyId, action: REMEDY, summary: "Correction visit", reason: "Kitchen missed", decideBy: Date.now() + HOUR });
    const first = await ask();
    // Noor isn't the one chosen while Mia is here.
    expect(await refusal(noor.mutation(api.approvals.decide, { companyId, approvalId: first, decision: "skipped" }))).toContain("decided by");
    await mia.mutation(api.approvals.decide, { companyId, approvalId: first, decision: "skipped" });

    // Mia leaves: her approvals go to any Owner or Manager, and the screen says why.
    await as.mutation(api.members.remove, { companyId, memberId: miaId as Id<"members"> });
    const row = (await as.query(api.permissions.list, { companyId })).actions.find((a) => a.key === REMEDY)!;
    expect(row.approvers.warning).toContain("no longer an active");
    const second = await ask();
    await noor.mutation(api.approvals.decide, { companyId, approvalId: second, decision: "skipped" });

    // Owners only: a manager can't decide it.
    await as.mutation(api.permissions.setRouting, { companyId, action: REMEDY, approver: { kind: "owner" } });
    const third = await ask();
    expect(await refusal(noor.mutation(api.approvals.decide, { companyId, approvalId: third, decision: "approved" }))).toContain("Only an Owner");
  });
});

describe("Agent Controls: reports for Act and notify me", () => {
  it("tells Owners and Managers once per step, including for Recruiter, and never twice on a retry", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await addMember(t, as, companyId, "mia", "manager");
    const notices = () => t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.dedupeKey?.startsWith("notice:agent_acted:")).map((m) => m.dedupeKey!));
    const report = (stage: "queued" | "completed") =>
      t.run((ctx) => reportAction(ctx, { companyId, agent: "recruiter", action: "recruiter.send_invitation", level: "execute_and_report", subject: { table: "companies", id: companyId }, ref: "application-1", stage, kind: "invitation" }));
    await report("queued");
    expect(await notices()).toHaveLength(2);
    await report("queued");
    expect(await notices()).toHaveLength(2);
    await report("completed");
    expect(await notices()).toHaveLength(4);
    // "Act automatically" acts quietly: no report, no notice.
    await t.run((ctx) => reportAction(ctx, { companyId, agent: "recruiter", action: "recruiter.send_invitation", level: "execute", subject: { table: "companies", id: companyId }, ref: "application-2", stage: "queued" }));
    expect(await notices()).toHaveLength(4);

    const reports = (await as.query(api.controls.workspace, { companyId })).reports;
    expect(reports.on.sort()).toEqual(["mia", "owner-a"]);
    expect(reports.settings).toBe("/app/settings/notifications");
  });
});
