/**
 * Selestial staff membership. Only staff admins add or remove staff. Nothing here touches a cleaning
 * company's records.
 */
import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { signedInQuery, staffFor, staffMutation, staffQuery } from "./lib/builders";
import { notFound, userError } from "./lib/errors";
import { email, text } from "./lib/text";
import { staffRoleValidator } from "./lib/trust/staffSchema";
import { log } from "./lib/operations/engine";
import { capabilitiesOf, CAPABILITY_LABEL, ROLE_INFO, STAFF_CAPABILITIES, staffCapabilityValidator } from "./lib/support/capabilities";
import { endSessionsOf } from "./support";

/** Whether the signed-in person is staff, and which kind. Everyone may ask about themselves. */
export const me = signedInQuery({
  args: {},
  handler: async (ctx) => {
    const found = await staffFor(ctx, ctx);
    if (!found) return null;
    if (found === "bootstrap") return { role: "admin" as const, name: ctx.name, email: ctx.email, capabilities: [...STAFF_CAPABILITIES] };
    return { role: found.role, name: found.name, email: found.email, capabilities: [...capabilitiesOf(found)] };
  },
});

export const list = staffQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("staff").take(200);
    return rows.filter((row) => row.status === "active").map((row) => ({ id: row._id, name: row.name, email: row.email, role: row.role, joined: Boolean(row.userId), addedAt: row.addedAt, grants: row.grants ?? [], removed: row.removed ?? [], capabilities: [...capabilitiesOf(row)] }));
  },
});

export const add = staffMutation({
  adminOnly: true,
  args: { email: v.string(), name: v.string(), role: staffRoleValidator },
  handler: async (ctx, args) => {
    const address = email(args.email);
    const rows = await ctx.db
      .query("staff")
      .withIndex("by_email", (q) => q.eq("email", address))
      .take(5);
    if (rows.some((row) => row.status === "active")) throw userError("That person is already staff.");
    return ctx.db.insert("staff", { email: address, name: text(args.name, "Name", 120), role: args.role, status: "active", addedAt: Date.now(), addedBy: ctx.staff._id });
  },
});

export const remove = staffMutation({
  adminOnly: true,
  args: { staffId: v.id("staff") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.staffId);
    if (!row || row.status !== "active") notFound();
    if (row._id === ctx.staff._id) throw userError("You cannot remove yourself. Ask another admin.");
    await ctx.db.patch(row._id, { status: "removed" });
    // Any support session they hold stops working now (it would be refused anyway; this records why).
    await endSessionsOf(ctx, row._id, "staff_removed");
    await log(ctx, { kind: "staff_action", words: `Staff access removed for ${row.name}.`, actor: { kind: "staff", staffId: ctx.staff._id } });
    return null;
  },
});

/** The staff capability catalog, for the Staff page. */
export const catalog = staffQuery({
  args: {},
  handler: async () => ({
    capabilities: STAFF_CAPABILITIES.map((id) => ({ id, ...CAPABILITY_LABEL[id] })),
    roles: Object.entries(ROLE_INFO).map(([id, info]) => ({ id, label: info.label, capabilities: [...info.capabilities] })),
  }),
});

/** An admin changes a staff member's role, or adds or removes single capabilities. Audited; sessions end if access narrows. */
export const setAccess = staffMutation({
  adminOnly: true,
  args: { staffId: v.id("staff"), role: v.optional(staffRoleValidator), grants: v.optional(v.array(staffCapabilityValidator)), removed: v.optional(v.array(staffCapabilityValidator)), reason: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.staffId);
    if (!row || row.status !== "active") notFound();
    const reason = text(args.reason, "The reason", 300);
    if (row._id === ctx.staff._id && args.role && args.role !== "admin") throw userError("You cannot remove your own admin role. Ask another admin.");
    const before = capabilitiesOf(row);
    const next = { role: args.role ?? row.role, grants: [...new Set(args.grants ?? row.grants ?? [])], removed: [...new Set(args.removed ?? row.removed ?? [])] };
    await ctx.db.patch(row._id, next);
    const after = capabilitiesOf({ ...row, ...next });
    const lost = [...before].filter((c) => !after.has(c));
    const gained = [...after].filter((c) => !before.has(c));
    if (lost.includes("workspace.view")) await endSessionsOf(ctx, row._id, "revoked");
    await log(ctx, { kind: "staff_action", words: `Staff access changed for ${row.name}.`, detail: `role ${row.role} → ${next.role}; gained ${gained.join(", ") || "nothing"}; lost ${lost.join(", ") || "nothing"} · ${reason}`, actor: { kind: "staff", staffId: ctx.staff._id } });
    return { gained, lost };
  },
});

/**
 * For whoever runs the deployment, from the command line only (`npx convex run staff:grant`). Adds a
 * staff member without anyone signed in, for example the first admins. Running it twice adds nothing.
 */
export const grant = internalMutation({
  args: { email: v.string(), name: v.string(), role: staffRoleValidator },
  handler: async (ctx, args) => {
    const address = email(args.email);
    const rows = await ctx.db
      .query("staff")
      .withIndex("by_email", (q) => q.eq("email", address))
      .take(5);
    const active = rows.find((row) => row.status === "active");
    if (active) return { staffId: active._id, added: false };
    const staffId = await ctx.db.insert("staff", { email: address, name: text(args.name, "Name", 120), role: args.role, status: "active", addedAt: Date.now(), addedBy: "console" });
    return { staffId, added: true };
  },
});
