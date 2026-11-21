/**
 * What each Selestial staff member may do, by named role plus per-person grants and removals
 * (docs/operations/03-support-sessions.md). Checked on the server for every staff call that needs one.
 *
 * Being staff still grants nothing inside a company by itself: entering a workspace needs a support
 * session (convex/support.ts), and a session only carries what these capabilities allow.
 */
import { v } from "convex/values";

import type { Doc } from "../../_generated/dataModel";

export const STAFF_CAPABILITIES = [
  /** See the Operations workspace and incidents. */
  "operations.view",
  /** Assign, note, verify and dismiss incidents; run a workflow's own recovery job. */
  "operations.act",
  /** Open a customer workspace in View mode. */
  "workspace.view",
  /** Switch a support session to Manage and make the record edits support is allowed to make. */
  "workspace.manage",
  /** Pause agents, retry eligible failed work. */
  "agents.recover",
  /** Anything that reaches a person outside Selestial: reconcile a text, stop or resume outbound sending. */
  "communications.act",
  /** Credits, refunds and fees on a company's balance. */
  "billing.adjust",
  /** Removing or ending things that cannot be undone. */
  "destructive",
] as const;
export type StaffCapability = (typeof STAFF_CAPABILITIES)[number];
export const staffCapabilityValidator = v.union(...STAFF_CAPABILITIES.map((c) => v.literal(c)));

export const CAPABILITY_LABEL: Record<StaffCapability, { label: string; about: string; sensitive: boolean }> = {
  "operations.view": { label: "See Operations", about: "Incidents, monitor health and recovery history across companies.", sensitive: false },
  "operations.act": { label: "Work incidents", about: "Assign, add notes, verify, dismiss with a reason, and run a workflow's own recovery job.", sensitive: false },
  "workspace.view": { label: "View workspaces", about: "Open a company's workspace read-only, with a recorded reason.", sensitive: false },
  "workspace.manage": { label: "Manage workspaces", about: "Switch a support session to Manage and make the support edits that are allowed.", sensitive: true },
  "agents.recover": { label: "Agent recovery", about: "Pause or resume agents and retry eligible failed work.", sensitive: false },
  "communications.act": { label: "Communications", about: "Reconcile an unconfirmed text with the provider, and stop or resume a company's outbound sending.", sensitive: true },
  "billing.adjust": { label: "Billing adjustments", about: "Credits, refunds and registration fees on a company's balance.", sensitive: true },
  destructive: { label: "Destructive actions", about: "Actions that remove or end something for good.", sensitive: true },
};

/** The named staff roles. `admin` and `reviewer` existed before; the others are new. */
export const STAFF_ROLES = ["admin", "support_lead", "support", "billing", "reviewer"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const staffRoleValidator = v.union(...STAFF_ROLES.map((r) => v.literal(r)));

export const ROLE_INFO: Record<StaffRole, { label: string; capabilities: readonly StaffCapability[] }> = {
  admin: { label: "Admin", capabilities: STAFF_CAPABILITIES },
  support_lead: { label: "Support lead", capabilities: ["operations.view", "operations.act", "workspace.view", "workspace.manage", "agents.recover", "communications.act"] },
  support: { label: "Support", capabilities: ["operations.view", "operations.act", "workspace.view", "workspace.manage", "agents.recover"] },
  billing: { label: "Billing", capabilities: ["operations.view", "workspace.view", "billing.adjust"] },
  // Reviewers work the public request queues; they can see Operations and nothing inside a company.
  reviewer: { label: "Reviewer", capabilities: ["operations.view"] },
};

/** A staff member's capabilities now: the role's, plus grants, minus removals. */
export function capabilitiesOf(staff: Pick<Doc<"staff">, "role" | "grants" | "removed" | "status">): Set<StaffCapability> {
  if (staff.status !== "active") return new Set();
  const out = new Set<StaffCapability>(ROLE_INFO[staff.role].capabilities);
  for (const grant of staff.grants ?? []) out.add(grant);
  for (const removal of staff.removed ?? []) out.delete(removal);
  return out;
}

export function hasCapability(staff: Pick<Doc<"staff">, "role" | "grants" | "removed" | "status">, capability: StaffCapability): boolean {
  return capabilitiesOf(staff).has(capability);
}
