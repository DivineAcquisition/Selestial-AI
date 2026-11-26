import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The agents a company can ask for before they are released. Team Coordinator was retired (its work is Recruiter's
 * and Dispatch's). Quality was released on November 22, 2026 and Care on November 25, 2026; earlier requests for them stay readable
 * (`agent` is a string).
 */
export const PLANNED_AGENT_IDS = ["marketing"] as const;
export type PlannedAgentId = (typeof PLANNED_AGENT_IDS)[number];

export const agentAccessTables = {
  /**
   * A company's request for early access to an agent that is not released yet. One row per company and agent;
   * each member who asks is added, with what they would use it for. Selestial staff read these to choose
   * which companies try an agent first. Asking changes nothing in the product and buys nothing.
   */
  agentAccessRequests: defineTable({
    companyId: v.id("companies"),
    agent: v.string(),
    requesters: v.array(v.object({ memberId: v.id("members"), at: v.number(), note: v.optional(v.string()), uses: v.array(v.string()) })),
    firstAt: v.number(),
    lastAt: v.number(),
    /** Staff's answer, when there is one. */
    status: v.union(v.literal("requested"), v.literal("invited"), v.literal("declined")),
    staffNote: v.optional(v.string()),
  })
    .index("by_company_agent", ["companyId", "agent"])
    .index("by_agent_last", ["agent", "lastAt"])
    .index("by_company_last", ["companyId", "lastAt"]),
};
