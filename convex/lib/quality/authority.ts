/**
 * What Quality may do with one action right now: the Owner's authority level from the shared permission
 * catalog, on top of whether Quality's agent work may run at all (paused, plan, suspended). None of Quality's
 * actions move money; a correction's cost is decided under Retention's and Finance's own permissions.
 */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { authorityFor } from "../authority";
import { actionDef, type Level } from "../permissionCatalog";
import { agentState } from "./runs";

export type QualityPermit = { mode: "act"; level: Level; label: string } | { mode: "ask"; label: string; why: string } | { mode: "refuse"; label: string; why: string };

export async function permitQuality(ctx: QueryCtx | MutationCtx, company: Doc<"companies">, permission: string): Promise<QualityPermit> {
  const def = actionDef(permission);
  const state = agentState(company);
  if (!state.ok) return { mode: "refuse", label: `${permission}: ${state.code}`, why: state.reason };
  const authority = await authorityFor(ctx, company._id, permission);
  if (authority.kind === "paused") return { mode: "refuse", label: `${permission}: Quality is paused`, why: "Quality is paused, so it does nothing. A person can still act." };
  if (authority.kind !== "level") return { mode: "refuse", label: `${permission}: not allowed`, why: "This is something only a person does." };
  if (authority.level === "off") return { mode: "refuse", label: `${permission}: off`, why: `"${def?.label ?? permission}" is switched off for Quality.` };
  if (authority.level === "propose") return { mode: "ask", label: `${permission} at propose`, why: "This is set to Ask me first." };
  return { mode: "act", level: authority.level, label: `${permission} at ${authority.level}, without asking` };
}
