/**
 * Selestial staff: the people who run Selestial itself, not the people inside a cleaning company. Staff
 * manage the public trust information (policies, providers, claims), work the privacy and security
 * request queues, and work Operations. Being staff gives no access to any company's records: entering a
 * workspace needs a time-bound, recorded support session (convex/support.ts).
 *
 * Roles and capabilities are in convex/lib/support/capabilities.ts.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

import { STAFF_ROLES, staffCapabilityValidator, staffRoleValidator } from "../support/capabilities";

export { STAFF_ROLES, staffRoleValidator };

export const staffTables = {
  staff: defineTable({
    /** The sign-in subject. Set when the person first signs in as staff. */
    userId: v.optional(v.string()),
    /** The sign-in service `userId` came from; see members.userIssuer. */
    userIssuer: v.optional(v.string()),
    /** Confirmed email, lower case. Staff are matched by it until they have signed in once. */
    email: v.string(),
    name: v.string(),
    /** admin manages staff and published trust information; the other roles are capability bundles. */
    role: staffRoleValidator,
    /** Capabilities added for this person beyond the role's. */
    grants: v.optional(v.array(staffCapabilityValidator)),
    /** Capabilities taken away from this person although the role has them. */
    removed: v.optional(v.array(staffCapabilityValidator)),
    status: v.union(v.literal("active"), v.literal("removed")),
    addedAt: v.number(),
    /** Who added them: a staff id, or "bootstrap" for the first admin named by STAFF_BOOTSTRAP_EMAIL. */
    addedBy: v.string(),
  })
    .index("by_email", ["email"])
    .index("by_user", ["userId"]),
};
