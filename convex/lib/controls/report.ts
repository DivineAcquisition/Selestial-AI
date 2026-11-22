/**
 * "Act and notify me": what an agent records when it acts on its own at that level, so the Owner and
 * Managers are told (convex/lib/notify/fromEvents.ts → agent_acted). One shape for all four agents.
 *
 * `stage` says how far the work got, so a report never claims more than happened:
 *  - prepared   made and kept for a person (nothing sent)
 *  - queued     handed to the outbox; it is checked again and sent from there
 *  - submitted  accepted by a provider
 *  - delivered  confirmed by the provider
 *  - completed  done in the record (a decision recorded, a reply applied)
 *
 * `ref` names the one piece of work. The notice is keyed by agent, action, ref and stage, so a retry that
 * records the report again does not send a second email.
 */
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { recordEvent } from "../events";
import type { Level } from "../permissionCatalog";
import type { Agent } from "../statuses";

export type Stage = "prepared" | "queued" | "submitted" | "delivered" | "completed";

type Subject = Parameters<typeof recordEvent>[1]["subject"];

export async function reportAction(
  ctx: MutationCtx,
  input: { companyId: Id<"companies">; agent: Agent; action: string; level: Level; subject: Subject; ref: string; stage: Stage; kind?: string; ok?: boolean; data?: Record<string, string | number | boolean | null> },
) {
  // Only "Act and notify me" reports. "Act automatically" acts quietly; "Ask me first" goes through approvals.
  if (input.level !== "execute_and_report") return;
  await recordEvent(ctx, {
    companyId: input.companyId,
    type: `${input.agent}.reported`,
    actor: { kind: "agent", agent: input.agent },
    subject: input.subject,
    data: { action: input.action, ref: input.ref, stage: input.stage, ...(input.kind ? { kind: input.kind } : {}), ...(input.ok !== undefined ? { ok: input.ok } : {}), ...(input.data ?? {}) },
  });
}
