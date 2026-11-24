/**
 * Selestial's edits to a service draft, kept so the person can see exactly what changed and undo it safely
 * (docs/services/00-architecture.md, "Selestial in the workspace").
 *
 *  - A request from the service workspace carries the draft revision that was on the person's screen. An edit
 *    for it is refused if the draft moved since (someone saved after asking), so a late answer can never
 *    overwrite newer work. Edits the same answer already made are its own, and don't count as moved.
 *  - Each edit records the parts of the service it changed, before and after. Undo puts back only the parts
 *    that still hold what Selestial wrote; anything edited since is kept and named, never erased.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Actor } from "../events";
import type { Spec } from "./spec";
import { canonical, describeChanges } from "./store";

/** What each top-level part of a service is called, for the person. */
export const PART_LABELS: Record<keyof Spec, string> = {
  name: "Name",
  category: "Kind of service",
  summary: "Description",
  visitWord: "What one price buys",
  included: "Included tasks",
  excluded: "Not included",
  teamNotes: "Notes for the team",
  pricing: "Price",
  modifiers: "Discounts and adjustments",
  team: "Crew and time",
  addOns: "Extras",
  questions: "Customer questions",
  walkthroughNotes: "When a walkthrough is needed",
  str: "Turnover details",
  requirements: "Requirements",
  illustrative: "Example amounts",
};

/**
 * Whether an edit may be made for the request being answered. Null: go ahead. Otherwise the words to give
 * the person. Only conversations started beside a service carry the revision; elsewhere nothing changes.
 */
export async function staleRequest(ctx: QueryCtx, input: { conversationId: Id<"conversations">; runId: Id<"chatRuns">; service: Doc<"services">; draft: Doc<"serviceDrafts"> | null }): Promise<string | null> {
  const conversation = await ctx.db.get(input.conversationId);
  if (conversation?.origin?.kind !== "service_draft") return null;
  if (conversation.origin.serviceId !== input.service._id) return "This assistant works on the service it was opened beside. Open the other service to change it.";
  const run = await ctx.db.get(input.runId);
  const message = run ? await ctx.db.get(run.userMessageId) : null;
  const asked = message?.draftRevision;
  if (asked === undefined) return null;
  const now = input.draft?.revision ?? 0;
  if (now === asked) return null;
  // This answer's own earlier edits moved the draft: that is still the person's request.
  const mine = await ctx.db
    .query("serviceDraftEdits")
    .withIndex("by_run", (q) => q.eq("runId", input.runId))
    .order("desc")
    .first();
  if (mine && mine.serviceId === input.service._id && mine.toRevision === now) return null;
  return "The draft was changed after you asked, so nothing was changed, to keep your newer edits. Ask again and Selestial will work from what's on your screen now.";
}

/** Records one edit, part by part. Returns its id, or null when nothing changed. */
export async function recordEdit(
  ctx: MutationCtx,
  input: { companyId: Id<"companies">; serviceId: Id<"services">; before: Spec; after: Spec; fromRevision: number; toRevision: number; actor: Actor; conversationId?: Id<"conversations">; runId?: Id<"chatRuns"> },
): Promise<Id<"serviceDraftEdits"> | null> {
  const fields = [];
  for (const key of Object.keys(PART_LABELS) as (keyof Spec)[]) {
    const before = canonical(input.before[key]);
    const after = canonical(input.after[key]);
    if (before !== after) fields.push({ key, before, after });
  }
  if (!fields.length) return null;
  return ctx.db.insert("serviceDraftEdits", {
    companyId: input.companyId,
    serviceId: input.serviceId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    actor: input.actor,
    fromRevision: input.fromRevision,
    toRevision: input.toRevision,
    fields,
    summary: describeChanges(input.before, input.after).slice(0, 20),
    at: Date.now(),
  });
}

/**
 * The draft with an edit undone: each part that still holds what the edit wrote goes back to what it was.
 * Parts changed since are left alone and listed in `kept`.
 */
export function undone(draft: Spec, edit: Pick<Doc<"serviceDraftEdits">, "fields">): { spec: Spec; reverted: string[]; kept: string[] } {
  const spec = { ...draft } as Record<string, unknown>;
  const reverted: string[] = [];
  const kept: string[] = [];
  for (const field of edit.fields) {
    const label = PART_LABELS[field.key as keyof Spec] ?? field.key;
    if (canonical(spec[field.key]) === field.after) {
      spec[field.key] = JSON.parse(field.before);
      reverted.push(label);
    } else kept.push(label);
  }
  return { spec: spec as Spec, reverted, kept };
}
