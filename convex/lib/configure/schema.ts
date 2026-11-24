/**
 * Business configuration's ledger (docs/onboarding/02-business-configuration.md). What was prepared lives
 * in its own records: service drafts in Services & Pricing, a booking form in Booking forms, agreements in
 * Agreements, standards in Quality. This table only says, per company and kind of output, what was made,
 * from which inputs, with which hash, and where the job that makes it stands.
 *
 * One row per company and kind, so starting twice, from two tabs or after a change finds the same row.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

import { literals } from "../statuses";

export const OUTPUT_KINDS = ["services", "booking", "agreements", "standards"] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];
export const outputKindValidator = literals(OUTPUT_KINDS);

/** Booking needs the service drafts it offers, so it runs after them. */
export const DEPENDS_ON: Record<OutputKind, OutputKind[]> = { services: [], booking: ["services"], agreements: [], standards: [] };

/**
 * The job's own state. What the owner sees on each card (Ready to review, Approved, Published) is read from
 * the records themselves; this only says whether the job that prepares them is still going.
 * queued: waiting its turn or a retry. working: running now. done: finished. waiting: needs something only
 * the owner can give (named in `missing`). failed: stopped after its retries; the rest are unaffected.
 */
export const JOB_STATES = ["queued", "working", "done", "waiting", "failed"] as const;
export type JobState = (typeof JOB_STATES)[number];

export const generatedValidator = v.object({
  /** What it was made for: a template id, a booking page kind, an agreement type or a standard template. */
  key: v.string(),
  table: v.string(),
  id: v.string(),
  label: v.string(),
  /** A hash of exactly what was written. If the record no longer matches it, a person edited it. */
  generatedHash: v.string(),
  /** False when it already existed and was adopted or left as it was. */
  created: v.boolean(),
});
export type Generated = typeof generatedValidator.type;

export const missingValidator = v.object({ words: v.string(), href: v.string() });
export type Missing = typeof missingValidator.type;

export const configureTables = {
  configOutputs: defineTable({
    companyId: v.id("companies"),
    kind: outputKindValidator,
    state: literals(JOB_STATES),
    /** A hash of the inputs this kind reads; when it differs from the current inputs, they changed. */
    inputsHash: v.string(),
    /** The hash of the inputs it last finished with. */
    builtFromHash: v.optional(v.string()),
    records: v.array(generatedValidator),
    /** Plain sentences: what was decided and why, with each assumption. */
    notes: v.array(v.string()),
    missing: v.array(missingValidator),
    /** Records it left alone because a person changed them, with why. */
    kept: v.array(v.object({ label: v.string(), why: v.string(), href: v.string() })),
    attempts: v.number(),
    nextRunAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    startedBy: v.id("members"),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_company_kind", ["companyId", "kind"])
    .index("by_state_next", ["state", "nextRunAt"]),
};
