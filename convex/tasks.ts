/**
 * Tasks carry the work (brief, section 10). Every task has a responsible agent, a completion condition
 * and a deadline. While open it has a next action. Waiting on someone is an explicit state with a
 * follow-up time. Handing it to a person records the open question. Nothing sits in "sent" and is forgotten.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { owned } from "./lib/access";
import { companyMutation, companyQuery, type MemberAccess } from "./lib/builders";
import { departmentOf } from "./lib/departments";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { agentValidator, taskStatusValidator, waitingOnValidator, type TaskStatus } from "./lib/statuses";
import { openTask, setTaskState, type TaskStateFields } from "./lib/taskState";
import { instant, text } from "./lib/text";
import { aboutValidator } from "./schema";

export { checkAbout, openTask } from "./lib/taskState";

async function move(ctx: MutationCtx & MemberAccess, task: Doc<"tasks">, to: TaskStatus, fields: TaskStateFields) {
  await setTaskState(ctx, task, to, fields, byMember(ctx));
}

export const list = companyQuery({
  args: { status: taskStatusValidator, agent: v.optional(agentValidator) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("tasks")
      .withIndex("by_company_status_due", (q) => q.eq("companyId", ctx.companyId).eq("status", args.status))
      .take(200);
    return args.agent ? rows.filter((row) => row.agent === args.agent) : rows;
  },
});

/** What is late as of a moment the caller names: open work past its deadline, and waits past their follow-up. */
export const overdue = companyQuery({
  args: { asOf: v.number() },
  handler: async (ctx, args) => {
    const late: Doc<"tasks">[] = [];
    for (const status of ["open", "needs_decision"] as const) {
      late.push(
        ...(await ctx.db
          .query("tasks")
          .withIndex("by_company_status_due", (q) => q.eq("companyId", ctx.companyId).eq("status", status).lt("dueAt", args.asOf))
          .take(100)),
      );
    }
    const waiting = await ctx.db
      .query("tasks")
      .withIndex("by_company_status_due", (q) => q.eq("companyId", ctx.companyId).eq("status", "waiting"))
      .take(200);
    late.push(...waiting.filter((row) => (row.followUpAt ?? 0) < args.asOf));
    return late;
  },
});

export const get = companyQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => owned(ctx, args.taskId),
});

export const create = companyMutation({
  args: {
    agent: agentValidator,
    title: v.string(),
    nextAction: v.string(),
    dueAt: v.number(),
    completionCondition: v.string(),
    about: v.optional(aboutValidator),
  },
  handler: async (ctx, args) => openTask(ctx, { ...args, companyId: ctx.companyId, actor: byMember(ctx) }),
});

/** Back to work, or a new next step: the next action and its deadline are both required. */
export const setNextAction = companyMutation({
  support: { capability: "records.edit", summary: "updated a task's next step" },
  args: { taskId: v.id("tasks"), nextAction: v.string(), dueAt: v.number() },
  handler: async (ctx, args) => {
    const task = await owned(ctx, args.taskId);
    const fields = { nextAction: text(args.nextAction, "The next action", 500), dueAt: instant(args.dueAt, "The deadline") };
    if (task.status === "open") {
      await ctx.db.patch(task._id, fields);
      await recordEvent(ctx, { companyId: ctx.companyId, type: "task.next_action_set", actor: byMember(ctx), subject: { table: "tasks", id: task._id } });
    } else {
      await move(ctx, task, "open", fields);
    }
    return null;
  },
});

export const wait = companyMutation({
  support: { capability: "records.edit", summary: "marked a task as waiting" },
  args: { taskId: v.id("tasks"), waitingOn: waitingOnValidator, followUpAt: v.number() },
  handler: async (ctx, args) => {
    const task = await owned(ctx, args.taskId);
    const followUpAt = instant(args.followUpAt, "The follow-up time");
    if (followUpAt <= Date.now()) throw userError("The follow-up time must be in the future.");
    await move(ctx, task, "waiting", { waitingOn: args.waitingOn, followUpAt });
    return null;
  },
});

/** Hands the task to a person with the open question and the time a decision is needed by. */
export const escalate = companyMutation({
  support: { capability: "records.edit", summary: "escalated a task" },
  args: { taskId: v.id("tasks"), openQuestion: v.string(), decideBy: v.number() },
  handler: async (ctx, args) => {
    const task = await owned(ctx, args.taskId);
    await move(ctx, task, "needs_decision", { openQuestion: text(args.openQuestion, "The open question", 1000), dueAt: instant(args.decideBy, "The decision deadline") });
    return null;
  },
});

export const complete = companyMutation({
  support: { capability: "records.edit", summary: "completed a task" },
  args: { taskId: v.id("tasks"), outcome: v.string() },
  handler: async (ctx, args) => {
    const task = await owned(ctx, args.taskId);
    await move(ctx, task, "done", { outcome: text(args.outcome, "The outcome", 1000), closedAt: Date.now() });
    return null;
  },
});

export type HandoffGroup = {
  key: string;
  department: string;
  agent: Doc<"tasks">["agent"];
  /** What deciding any one of these settles. */
  label: string;
  count: number;
  earliestDeadline: number;
  overdue: number;
  samples: string[];
  ids: Id<"tasks">[];
};

const HANDOFF_LIMIT = 2000;

/** Every task handed to a person, in groups by agent and what deciding it settles. A task covered by a pending approval is left to the approval. */
export const handoffSummary = companyQuery({
  args: { asOf: v.number() },
  handler: async (ctx, args): Promise<{ total: number; overdue: number; groups: HandoffGroup[]; truncated: boolean }> => {
    const held = await ctx.db
      .query("tasks")
      .withIndex("by_company_status_due", (q) => q.eq("companyId", ctx.companyId).eq("status", "needs_decision"))
      .take(HANDOFF_LIMIT + 1);
    const pending = await ctx.db
      .query("approvals")
      .withIndex("by_company_status_decideBy", (q) => q.eq("companyId", ctx.companyId).eq("status", "pending"))
      .take(HANDOFF_LIMIT);
    const covered = new Set(pending.map((row) => row.taskId).filter(Boolean));
    const truncated = held.length > HANDOFF_LIMIT;
    const rows = held.slice(0, HANDOFF_LIMIT).filter((task) => !covered.has(task._id));
    const groups = new Map<string, HandoffGroup>();
    for (const task of rows) {
      const key = `${task.agent}:${task.completionCondition}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, department: departmentOf(task.agent).name, agent: task.agent, label: task.completionCondition, count: 0, earliestDeadline: task.dueAt, overdue: 0, samples: [], ids: [] };
        groups.set(key, group);
      }
      group.count += 1;
      group.ids.push(task._id);
      group.earliestDeadline = Math.min(group.earliestDeadline, task.dueAt);
      if (task.dueAt <= args.asOf) group.overdue += 1;
      if (group.samples.length < 5) group.samples.push(task.openQuestion ? `${task.title} ${task.openQuestion}` : task.title);
    }
    const list = [...groups.values()].sort((a, b) => a.department.localeCompare(b.department) || b.count - a.count || a.label.localeCompare(b.label));
    return { total: rows.length, overdue: list.reduce((sum, group) => sum + group.overdue, 0), groups: list, truncated };
  },
});

export type CloseResult = { id: Id<"tasks">; ok: boolean; message?: string };

/** Closes up to 25 handed-over tasks with one reason. One that is no longer waiting on a person is reported, not closed. */
export const closeMany = companyMutation({
  support: { capability: "records.edit", summary: "closed handed-over tasks in bulk" },
  args: { taskIds: v.array(v.id("tasks")), reason: v.string() },
  handler: async (ctx, args): Promise<CloseResult[]> => {
    if (args.taskIds.length > 25) throw userError("Close at most 25 at a time.");
    const reason = text(args.reason, "The reason", 1000);
    const out: CloseResult[] = [];
    for (const id of args.taskIds) {
      const task = await ctx.db.get(id);
      if (!task || task.companyId !== ctx.companyId) {
        out.push({ id, ok: false, message: "Not found." });
        continue;
      }
      if (task.status !== "needs_decision") {
        out.push({ id, ok: false, message: "Already handled." });
        continue;
      }
      await move(ctx, task, "cancelled", { outcome: reason, closedAt: Date.now() });
      out.push({ id, ok: true });
    }
    return out;
  },
});

export const cancel = companyMutation({
  support: { capability: "records.edit", summary: "cancelled a task" },
  args: { taskId: v.id("tasks"), reason: v.string() },
  handler: async (ctx, args) => {
    const task = await owned(ctx, args.taskId);
    await move(ctx, task, "cancelled", { outcome: text(args.reason, "The reason", 1000), closedAt: Date.now() });
    return null;
  },
});
