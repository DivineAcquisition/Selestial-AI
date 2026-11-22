/**
 * The onboarding case's server helpers, shared by the owner's setup (convex/textingSetup.ts), the case
 * itself (convex/textingCase.ts), staff review (convex/textingReview.ts) and configuration
 * (convex/textingConfig.ts).
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { readProfile } from "../compliance/profile";
import { BUILT_IN, configProblems, parseConfig, type Config, type ConfigProblem } from "./config";
import type { DraftInput } from "./drafts";
import { handleOf, linksFor, type Links } from "./pages";
import { findings } from "./recommend";

type Ctx = QueryCtx | MutationCtx;

/** What the drafts are written from: the business's own details as they are now. */
export async function draftInput(ctx: Ctx, setup: Pick<Doc<"textingSetups">, "business" | "activities" | "places" | "otherPlace" | "hosting" | "ownSite">, company: Doc<"companies">, handle: string | null): Promise<DraftInput> {
  const profile = await readProfile(ctx, company._id);
  const b = setup.business;
  const links: Links = linksFor(setup, handle) ?? { privacy: "(your privacy policy link)", terms: "(your texting terms link)", signup: "(your sign-up link)" };
  return {
    name: b.displayName || company.name,
    legalName: b.entityType === "SOLE_PROPRIETOR" ? [b.contactFirstName, b.contactLastName].filter(Boolean).join(" ") || undefined : b.legalName,
    website: b.website,
    supportEmail: b.supportEmail,
    supportPhone: b.supportPhone,
    street: b.street,
    city: b.city,
    state: b.state,
    postalCode: b.postalCode,
    activities: setup.activities,
    marketingPerWeek: profile.messaging.frequency.marketingPerWeek,
    links,
    places: setup.places,
    otherPlace: setup.otherPlace,
  };
}

/** The configuration in force now: the newest published, effective, not retired version, or the built-in one. */
export async function activeConfig(ctx: Ctx, now = Date.now()): Promise<{ version: number; config: Config }> {
  const rows = await ctx.db
    .query("textingConfigVersions")
    .withIndex("by_status", (q) => q.eq("status", "published"))
    .order("desc")
    .take(50);
  for (const row of rows) {
    if ((row.effectiveAt ?? Infinity) > now) continue;
    const parsed = parseConfig(row.body);
    if (parsed.config) return { version: row.version, config: parsed.config };
  }
  return { version: 0, config: BUILT_IN };
}

/** Every version of every evidence item on a setup, newest first. Callers filter by who may see what. */
export async function evidenceRows(ctx: Ctx, setupId: Id<"textingSetups">): Promise<Doc<"textingEvidence">[]> {
  return ctx.db
    .query("textingEvidence")
    .withIndex("by_setup_added", (q) => q.eq("setupId", setupId))
    .order("desc")
    .take(500);
}

/** The current version of each item: not replaced. */
export function currentEvidence(rows: Doc<"textingEvidence">[]): Doc<"textingEvidence">[] {
  return rows.filter((row) => row.replacedAt === undefined);
}

export async function caseConfigProblems(ctx: Ctx, setup: Doc<"textingSetups">, config: Config): Promise<ConfigProblem[]> {
  const evidence = currentEvidence(await evidenceRows(ctx, setup._id));
  return configProblems(config, { business: setup.business, places: setup.places, evidence: evidence.map((row) => ({ purpose: row.purpose, place: row.links.place, state: row.state })) });
}

/**
 * Brings the setup's recommendations up to date with what it says now. A finding seen again with the same
 * facts is left alone. One whose facts changed is revalidated: an approval on it is withdrawn and it is
 * marked stale, so nothing approved on old facts is carried out. A finding that no longer applies is resolved.
 */
export async function syncRecommendations(ctx: MutationCtx, setupId: Id<"textingSetups">): Promise<void> {
  const setup = await ctx.db.get(setupId);
  if (!setup) return;
  const company = await ctx.db.get(setup.companyId);
  if (!company) return;
  const now = Date.now();
  const { config } = await activeConfig(ctx, now);
  const request = setup.requestId ? await ctx.db.get(setup.requestId) : null;
  const rows = await evidenceRows(ctx, setup._id);
  const found = findings({
    companyName: company.name,
    setup,
    draftInput: await draftInput(ctx, setup, company, await handleOf(ctx, setup.companyId)),
    request: request ? { status: request.status, activities: request.activities, needs: request.needs ?? null } : null,
    evidence: rows.map((row) => ({ id: row._id, key: row.key, purpose: row.purpose, place: row.links.place, kind: row.kind, visibility: row.visibility, state: row.state, replaced: row.replacedAt !== undefined, reviewCopyOf: row.reviewCopy?.of })),
    config,
  });
  const existing = await ctx.db
    .query("textingRecommendations")
    .withIndex("by_setup_key", (q) => q.eq("setupId", setup._id))
    .take(300);
  const byKey = new Map(existing.map((row) => [row.key, row]));
  for (const finding of found) {
    const row = byKey.get(finding.key);
    byKey.delete(finding.key);
    const fields = { rule: finding.rule, responsible: finding.responsible, stage: finding.stage, field: finding.field, issue: finding.issue, basisWords: finding.basisWords, proposal: finding.proposal as Doc<"textingRecommendations">["proposal"], proposalWords: finding.proposalWords, effect: finding.effect, approval: finding.approval, nextAction: finding.nextAction };
    if (!row) {
      await ctx.db.insert("textingRecommendations", { companyId: setup.companyId, setupId: setup._id, key: finding.key, ...fields, status: "open", revision: setup.revision, fingerprint: finding.fingerprint, createdAt: now, updatedAt: now });
      continue;
    }
    if (row.fingerprint === finding.fingerprint) {
      // Dismissed stays dismissed while the facts are the same.
      continue;
    }
    const wasApproved = row.status === "approved";
    const terminal = row.status === "applied" || row.status === "dismissed" || row.status === "resolved";
    await ctx.db.patch(row._id, {
      ...fields,
      revision: setup.revision,
      fingerprint: finding.fingerprint,
      status: wasApproved ? "stale" : terminal ? "open" : row.status === "clarification" ? "clarification" : "open",
      approvedAt: undefined,
      approvedBy: undefined,
      ...(wasApproved ? { nextAction: "The details changed after you approved this. Review it again." } : {}),
      updatedAt: now,
    });
  }
  for (const row of byKey.values()) {
    if (row.status === "open" || row.status === "clarification" || row.status === "approved" || row.status === "stale") {
      await ctx.db.patch(row._id, { status: "resolved", approvedAt: undefined, approvedBy: undefined, nextAction: "Nothing to do: this no longer applies.", updatedAt: now });
    }
  }
}
