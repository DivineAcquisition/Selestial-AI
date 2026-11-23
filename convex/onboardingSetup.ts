/**
 * Team › Cleaners › Onboarding setup: the company's guided onboarding, for the Owner to configure and for
 * the office to follow. The content (what each step shows) is versioned here; which steps a worker has and
 * what an unmet one holds up stay in the requirement template (convex/requirements.ts), so there is one
 * definition of each and the cleaner's page, the profile, reminders and Dispatch agree.
 *
 * Publishing a new version never resets anyone by itself. For each part that changed, the Owner decides
 * whether people who already completed it must do it again, and the decision is kept with the version.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { owned } from "./lib/access";
import { DOC_TYPES } from "./lib/agreements/catalog";
import { companyMutation, companyQuery, managerQuery, ownerMutation } from "./lib/builders";
import { agreementForWorker, completedModules, journeyOf, payoutOf, trainingOf } from "./lib/cleaners/guided";
import { syncHandoffRequirement } from "./lib/cleaners/handoff";
import { askedSupplies, DEFAULT_CONTENT, normalizeContent, onboardingContentValidator, PAY_METHOD_WORDS, PART_WORDS, partsOf, publishedOf } from "./lib/cleaners/onboarding";
import { agreementTypeFor, companyDefinitions, companyCleaners } from "./lib/cleaners/records";
import { TAX_STATE_WORDS } from "./lib/cleaners/tax";
import { STEP_STATE_WORDS, JOURNEY_WORDS } from "./lib/cleaners/steps";
import { linkToken, linkUrl } from "./lib/sales/links";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { isManager, isOwner } from "./lib/roles";
import { optionalText } from "./lib/text";

async function configRows(ctx: { db: Parameters<Parameters<typeof companyQuery>[0]["handler"]>[0]["db"]; companyId: Doc<"companies">["_id"] }) {
  return ctx.db
    .query("onboardingConfigs")
    .withIndex("by_company_version", (q) => q.eq("companyId", ctx.companyId))
    .order("desc")
    .take(50);
}

/** The setup screen: what is in force, the draft if there is one, what changed, and the steps' rules. */
export const get = companyQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await configRows(ctx);
    const published = publishedOf(rows);
    const draft = rows.find((row) => row.status === "draft") ?? null;
    const before = partsOf(published.content);
    const after = draft ? partsOf(draft.content) : before;
    const definitions = await companyDefinitions(ctx, ctx.company);
    const saved = (await ctx.db.query("requirementDefinitions").withIndex("by_company_key", (q) => q.eq("companyId", ctx.companyId)).take(1)).length > 0;
    const keys = new Set(definitions.map((def) => def.key));
    return {
      published: { version: published.version, content: published.content, publishedAt: published.publishedAt, reack: published.reack },
      draft: draft ? { content: draft.content, updatedAt: draft.updatedAt } : null,
      changed: Object.keys(after)
        .filter((key) => after[key] !== before[key] && keys.has(key))
        .map((key) => ({ key, label: PART_WORDS[key] ?? key })),
      history: rows.filter((row) => row.status !== "draft").map((row) => ({ version: row.version, publishedAt: row.publishedAt ?? null, changes: row.changes ?? [], note: row.note ?? null })),
      template: {
        startingTemplate: ctx.company.cleaners?.startingTemplate ?? "v1",
        saved,
        steps: definitions.map((def) => ({ key: def.key, label: def.label, kind: def.kind, effect: def.effect, appliesTo: def.appliesTo, officeReview: def.officeReview ?? false, reviewer: def.reviewer, description: def.description ?? null, validForDays: def.validForDays ?? null, providedBy: def.providedBy ?? null, forServices: def.forServices, cleanerCompletes: def.cleanerCompletes, agreementDocType: def.agreementDocType ?? null })),
      },
      agreementTypes: DOC_TYPES.filter((type) => type.category === "workforce").map((type) => ({ key: type.key, label: type.label })),
      payMethods: Object.entries(PAY_METHOD_WORDS).map(([id, words]) => ({ id, ...words })),
      defaults: DEFAULT_CONTENT,
      mayEdit: isOwner(ctx.role),
    };
  },
});

/** Saves the Owner's draft. Nothing reaches a cleaner until it is published. */
export const saveDraft = ownerMutation({
  args: { content: onboardingContentValidator },
  handler: async (ctx, args) => {
    const { content, problems } = normalizeContent(args.content);
    const rows = await configRows(ctx);
    const draft = rows.find((row) => row.status === "draft");
    const now = Date.now();
    if (draft) await ctx.db.patch(draft._id, { content, updatedAt: now, updatedBy: ctx.member._id });
    else await ctx.db.insert("onboardingConfigs", { companyId: ctx.companyId, version: -1, status: "draft", content, reack: {}, updatedAt: now, updatedBy: ctx.member._id });
    return { problems };
  },
});

export const discardDraft = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const draft = (await configRows(ctx)).find((row) => row.status === "draft");
    if (draft) await ctx.db.delete(draft._id);
    return null;
  },
});

/**
 * Publishes the draft as the next version. `again` names the changed parts that people who already completed
 * them must do again; every other completion stands. Earlier versions are kept as they were.
 */
export const publish = ownerMutation({
  args: { again: v.array(v.string()), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows = await configRows(ctx);
    const draft = rows.find((row) => row.status === "draft");
    if (!draft) throw userError("There is no draft to publish.");
    const { content, problems } = normalizeContent(draft.content);
    if (problems.length) throw userError(problems.join(" "));
    const published = publishedOf(rows);
    const before = partsOf(published.content);
    const after = partsOf(content);
    const changedKeys = Object.keys(after).filter((key) => after[key] !== before[key]);
    const version = Math.max(0, ...rows.filter((row) => row.status !== "draft").map((row) => row.version)) + 1;
    const reack = { ...published.reack };
    for (const key of args.again) if (changedKeys.includes(key)) reack[key] = version;
    for (const row of rows.filter((item) => item.status === "published")) await ctx.db.patch(row._id, { status: "superseded" });
    const changes = changedKeys.map((key) => ({ key, label: PART_WORDS[key] ?? key, again: args.again.includes(key) }));
    await ctx.db.patch(draft._id, { version, status: "published", content, reack, changes, note: optionalText(args.note, "Note", 300), publishedBy: ctx.member._id, publishedAt: Date.now(), updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "onboarding.published", actor: byMember(ctx), subject: { table: "onboardingConfigs", id: draft._id }, data: { version, askedAgain: changes.filter((c) => c.again).length } });
    return { version, changes };
  },
});

/**
 * Moves a company that never saved its own template onto the guided starting template. People already
 * onboarding keep every record; new steps apply to new people, and to others only when applied on purpose.
 */
export const useGuided = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const saved = (await ctx.db.query("requirementDefinitions").withIndex("by_company_key", (q) => q.eq("companyId", ctx.companyId)).take(1)).length > 0;
    if (saved) throw userError("Your company has its own checklist. Use \"Restore Selestial's template\" on the checklist to add the guided steps.");
    await ctx.db.patch(ctx.companyId, { cleaners: { ...(ctx.company.cleaners ?? {}), startingTemplate: "guided" } });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "onboarding.guided_template", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId } });
    return null;
  },
});

// ── One cleaner, for the office ──────────────────────────────────────────────────────────────────

/** The same steps the cleaner sees, with what the office needs to act on each. Sensitive parts follow role. */
export const forCleaner = managerQuery({
  args: { cleanerId: v.id("cleaners"), asOf: v.number() },
  handler: async (ctx, args) => {
    const cleaner = await owned(ctx, args.cleanerId);
    const g = await journeyOf(ctx, ctx.company, cleaner, args.asOf);
    const owner = isOwner(ctx.role);
    const payout = await payoutOf(ctx, ctx.companyId, cleaner._id);
    const equipment = g.readiness.requirements.find((view) => view.kind === "equipment");
    const suppliesRow = equipment ? g.rows.find((row) => row.key === equipment.key) : undefined;
    const answers = suppliesRow?.evidence?.supplies;
    const asked = askedSupplies(g.onboarding.content);
    const trainingKey = g.readiness.requirements.find((view) => view.kind === "training")?.key;
    const done = completedModules(await trainingOf(ctx, ctx.companyId, cleaner._id), (trainingKey && g.onboarding.reack[trainingKey]) || 0);
    const signer = g.agreement?.request?.signers.find((s) => s.email === ctx.member.email.trim().toLowerCase() && s.status !== "signed");
    return {
      journey: { ...g.journey, words: JOURNEY_WORDS[g.journey.state] },
      stepWords: STEP_STATE_WORDS,
      phoneVerifiedAt: cleaner.phoneVerified?.at ?? null,
      agreement: g.agreement ? { id: g.agreement.agreement._id, title: g.agreement.agreement.title, workflow: g.agreement.agreement.workflow, workerSignedAt: g.agreement.signer?.signature?.at ?? null, youCanCountersign: Boolean(signer) } : null,
      supplies: answers ? { have: asked.filter((item) => answers[item.id] === "have").map((item) => item.label), missing: asked.filter((item) => answers[item.id] === "missing").map((item) => item.label) } : null,
      training: g.onboarding.content.training.modules.map((module) => ({ key: module.key, title: module.title, required: module.required, completed: done.has(module.key) })),
      payout: payout ? { method: PAY_METHOD_WORDS[payout.method].label, status: payout.status, handle: owner ? (payout.handle ?? null) : null, mailingAddress: owner ? (payout.mailingAddress ?? null) : null, recordedAt: payout.recordedAt } : null,
      tax: g.readiness.requirements.some((view) => view.kind === "tax")
        ? {
            status: g.tax?.status ?? (g.taxPlan.form === "w9" ? "awaiting_information" : "not_applicable"),
            words: TAX_STATE_WORDS[g.tax?.status ?? (g.taxPlan.form === "w9" ? "awaiting_information" : "not_applicable")],
            reason: g.taxPlan.form === "none" ? g.taxPlan.reason : g.taxKeyReady ? null : "Secure tax collection is not set up on this deployment (TAX_ID_KEY), so nothing is asked of the worker yet.",
            problem: owner ? (g.tax?.problem ?? null) : null,
            legalName: owner ? (g.tax?.legalName ?? null) : null,
            tinLast4: owner ? (g.tax?.tinLast4 ?? null) : null,
            hasDocument: Boolean(g.tax?.documentId),
          }
        : null,
      mayConfirmPay: owner,
    };
  },
});

/** Finance's decision: the worker's pay preference is right and may be used. Payments are still made in Team Pay. */
export const confirmPayout = ownerMutation({
  args: { cleanerId: v.id("cleaners") },
  handler: async (ctx, args) => {
    const cleaner = await owned(ctx, args.cleanerId);
    const payout = await payoutOf(ctx, ctx.companyId, cleaner._id);
    if (!payout) throw userError("They have not chosen how to be paid yet.");
    const now = Date.now();
    if (payout.status !== "confirmed") await ctx.db.patch(payout._id, { status: "confirmed", confirmedBy: ctx.member._id, confirmedAt: now });
    const defs = (await companyDefinitions(ctx, ctx.company)).filter((def) => def.kind === "payment");
    for (const def of defs) {
      const row = (await ctx.db.query("workerRequirements").withIndex("by_company_cleaner", (q) => q.eq("companyId", ctx.companyId).eq("cleanerId", cleaner._id).eq("key", def.key)).take(1))[0];
      if (!row || row.status === "accepted" || row.status === "waived") continue;
      await ctx.db.patch(row._id, { status: "accepted", reviewedAt: now, reviewedBy: ctx.member._id, acceptedAt: now, reviewNote: `${PAY_METHOD_WORDS[payout.method].label} confirmed by Finance.`, updatedAt: now });
      await recordEvent(ctx, { companyId: ctx.companyId, type: "cleaner.requirement_accepted", actor: byMember(ctx), subject: { table: "cleaners", id: cleaner._id }, data: { key: def.key } });
      await syncHandoffRequirement(ctx, cleaner, def.key, true, byMember(ctx), "Pay preference confirmed.");
    }
    await recordEvent(ctx, { companyId: ctx.companyId, type: "cleaner.payout_preference_confirmed", actor: byMember(ctx), subject: { table: "cleaners", id: cleaner._id }, data: { method: payout.method } });
    return null;
  },
});

/** A short-lived address for the finished tax document, for the Owner. Each download is recorded. */
export const taxDocument = ownerMutation({
  args: { cleanerId: v.id("cleaners") },
  handler: async (ctx, args) => {
    const cleaner = await owned(ctx, args.cleanerId);
    const doc = (await ctx.db.query("taxDocuments").withIndex("by_company_cleaner", (q) => q.eq("companyId", ctx.companyId).eq("cleanerId", cleaner._id)).take(1))[0];
    if (!doc?.documentId || doc.status !== "completed") throw userError("The document is not ready.");
    const url = await ctx.storage.getUrl(doc.documentId);
    if (!url) throw userError("The document is no longer available.");
    await recordEvent(ctx, { companyId: ctx.companyId, type: "cleaner.tax_document_downloaded", actor: byMember(ctx), subject: { table: "cleaners", id: cleaner._id } });
    return { url };
  },
});

/** Tries again to make a document that failed. The worker's answers and certification are reused, never remade. */
export const retryTaxDocument = ownerMutation({
  args: { cleanerId: v.id("cleaners") },
  handler: async (ctx, args) => {
    const cleaner = await owned(ctx, args.cleanerId);
    const doc = (await ctx.db.query("taxDocuments").withIndex("by_company_cleaner", (q) => q.eq("companyId", ctx.companyId).eq("cleanerId", cleaner._id)).take(1))[0];
    if (!doc || doc.status !== "failed" || !doc.certification) throw userError("There is nothing to try again.");
    await ctx.db.patch(doc._id, { status: "preparing", problem: undefined, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.cleanerOnboarding.prepareTaxDocument, { docId: doc._id });
    return null;
  },
});

/** Your own signing link for the worker's agreement, when you are a signer who has not signed. You sign as yourself. */
export const countersignLink = companyMutation({
  args: { cleanerId: v.id("cleaners") },
  handler: async (ctx, args) => {
    if (!isManager(ctx.role)) throw userError("Your role cannot sign for the company.", "not_allowed");
    const cleaner = await owned(ctx, args.cleanerId);
    const defs = await companyDefinitions(ctx, ctx.company);
    const def = defs.find((item) => item.kind === "agreement");
    const onboarding = (await journeyOf(ctx, ctx.company, cleaner, Date.now())).onboarding;
    const a = await agreementForWorker(ctx, ctx.company, cleaner, onboarding, def ? agreementTypeFor(def, cleaner.engagement, onboarding) : undefined);
    if (!a?.request) throw userError("There is no signing request open for their agreement.");
    const email = ctx.member.email.trim().toLowerCase();
    const link = (await ctx.db.query("agreementSigningLinks").withIndex("by_company_request", (q) => q.eq("companyId", ctx.companyId).eq("requestId", a.request!._id)).take(20)).find((row) => row.signerEmail === email);
    if (!link) throw userError("You are not a signer on this agreement. The person named as the company's signer signs it.");
    if (link.signature) throw userError("You have already signed it.");
    const token = await linkToken("sign", link.publicId);
    if (!token) throw userError("Signing links are not set up on this deployment.");
    return { url: linkUrl("sign", token) };
  },
});

/** How many people in the company have completed each versioned part, so a republish decision is informed. */
export const completions = managerQuery({
  args: {},
  handler: async (ctx) => {
    const cleaners = await companyCleaners(ctx, ctx.companyId);
    const rows = await ctx.db.query("workerRequirements").withIndex("by_company_cleaner", (q) => q.eq("companyId", ctx.companyId)).take(15000);
    const live = new Set(cleaners.map((c) => c._id as string));
    const out: Record<string, number> = {};
    for (const row of rows) if (live.has(row.cleanerId) && row.status === "accepted" && PART_WORDS[row.key]) out[row.key] = (out[row.key] ?? 0) + 1;
    return out;
  },
});
