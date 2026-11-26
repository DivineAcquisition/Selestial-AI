/**
 * @vitest-environment edge-runtime
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { company, HOUR, NOW, refusal, start } from "../tests/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

describe("closing handed-over tasks in bulk", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("groups the tasks handed to a person and closes a group with one reason", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const ids: Id<"tasks">[] = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i += 1) {
        ids.push(
          await ctx.db.insert("tasks", { companyId, agent: "recruiter", title: "Which role did An applicant apply for?", openQuestion: "Choose the role, or close the application.", completionCondition: "The application is matched to a role or closed", status: "needs_decision", createdAt: NOW, dueAt: i < 4 ? NOW - HOUR : NOW + HOUR }),
        );
      }
      await ctx.db.insert("tasks", { companyId, agent: "dispatch", title: "Cover Tuesday", completionCondition: "A cleaner accepted the visit", status: "needs_decision", createdAt: NOW, dueAt: NOW + HOUR });
      await ctx.db.insert("tasks", { companyId, agent: "dispatch", title: "Still open", completionCondition: "x", status: "open", createdAt: NOW, nextAction: "Offer it", dueAt: NOW + HOUR });
    });

    const summary = await as.query(api.tasks.handoffSummary, { companyId, asOf: NOW });
    expect(summary.total).toBe(31);
    expect(summary.overdue).toBe(4);
    const recruiter = summary.groups.find((group) => group.agent === "recruiter")!;
    expect(recruiter).toMatchObject({ count: 30, overdue: 4, label: "The application is matched to a role or closed" });
    expect(recruiter.samples).toHaveLength(5);

    expect(await refusal(as.mutation(api.tasks.closeMany, { companyId, taskIds: ids, reason: "Duplicates" }))).toContain("at most 25");
    const results = await as.mutation(api.tasks.closeMany, { companyId, taskIds: ids.slice(0, 25), reason: "Not real or a duplicate" });
    expect(results.every((row) => row.ok)).toBe(true);
    expect(await as.query(api.tasks.get, { companyId, taskId: ids[0] })).toMatchObject({ status: "cancelled", outcome: "Not real or a duplicate" });

    const again = await as.mutation(api.tasks.closeMany, { companyId, taskIds: [ids[0], ids[29]], reason: "Duplicates" });
    expect(again).toMatchObject([{ ok: false, message: "Already handled." }, { ok: true }]);
    expect((await as.query(api.tasks.handoffSummary, { companyId, asOf: NOW })).total).toBe(5);
  });
});
