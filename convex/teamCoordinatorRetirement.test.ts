/**
 * @vitest-environment edge-runtime
 */
import { describe, expect, it } from "vitest";

import { company, start } from "../tests/harness";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

describe("Retiring Team Coordinator", () => {
  it("moves open tasks off the retired queue to the agent that owns the work, keeps history, and reports what it cannot place", async () => {
    const t = start();
    const { companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const now = Date.now();
    const task = (fields: { agent: "recruiter" | "dispatch"; key: string; status: "needs_decision" | "done"; title: string }) =>
      t.run((ctx) => ctx.db.insert("tasks", { companyId, ...fields, completionCondition: "x", dueAt: now, handoffTo: "team_coordinator", createdAt: now }));
    const onboarding = await task({ agent: "recruiter", key: "recruiter.onboarding:app1", status: "needs_decision", title: "Onboard Maria" });
    const contact = await task({ agent: "dispatch", key: "team_coordinator.contact:c1", status: "needs_decision", title: "Check how to reach Lena" });
    const followUp = await task({ agent: "dispatch", key: "followup:availability:c2:person", status: "needs_decision", title: "Check in with Rosa yourself" });
    const odd = await task({ agent: "dispatch", key: "something.else", status: "needs_decision", title: "Unknown" });
    const closed = await task({ agent: "recruiter", key: "recruiter.onboarding:app0", status: "done", title: "Onboard Ana" });

    const messagesBefore = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).length);
    const dry = await t.mutation(internal.teamCoordinatorRetirement.run, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, checked: 4, unclassified: [{ taskId: odd, key: "something.else" }] });
    expect((await t.run((ctx) => ctx.db.get(onboarding)))!.handoffTo).toBe("team_coordinator");

    const result = await t.mutation(internal.teamCoordinatorRetirement.run, {});
    expect(result.moved).toEqual([
      { taskId: onboarding, to: "recruiter" },
      { taskId: contact, to: "dispatch" },
      { taskId: followUp, to: "dispatch" },
    ]);
    const get = (id: Id<"tasks">) => t.run((ctx) => ctx.db.get(id));
    expect(await get(onboarding)).toMatchObject({ agent: "recruiter", status: "needs_decision", key: "recruiter.onboarding:app1" });
    expect((await get(onboarding))!.handoffTo).toBeUndefined();
    expect((await get(contact))!.handoffTo).toBeUndefined();
    // History stays as it was, and what it cannot place is left for a person.
    expect((await get(closed))!.handoffTo).toBe("team_coordinator");
    expect((await get(odd))!.handoffTo).toBe("team_coordinator");
    // Nothing is sent by a migration, and running it again changes nothing.
    expect(await t.run(async (ctx) => (await ctx.db.query("messages").collect()).length)).toBe(messagesBefore);
    expect(await t.mutation(internal.teamCoordinatorRetirement.run, {})).toMatchObject({ checked: 1, moved: [] });
  });
});
