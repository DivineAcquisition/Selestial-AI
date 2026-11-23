/**
 * Reads what the guided onboarding needs about one worker, from the records that own each fact: the signing
 * request and the worker's own signing link (Agreements), the tax document, the pay preference, training
 * progress and the requirement rows. Nothing here changes anything, and nothing here decides readiness:
 * readiness.ts does, and steps.ts turns it into steps. The portal, the owner's profile and Recruiter's
 * reminders all come through `journeyOf`, so they say the same thing.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { HOSTED } from "../agreements/signing";
import { signerState } from "../agreements/hostedSign";
import { liveTaskByKey, openTask } from "../taskState";
import type { Actor } from "../events";
import { requiredModules, type PublishedOnboarding } from "./onboarding";
import { agreementTypeFor, cleanerReadiness, WORKING_AGREEMENT_TYPES } from "./records";
import { HOUR } from "./settings";
import { onboardingJourney, type Journey, type StepFacts } from "./steps";
import { taxKeyConfigured, taxPlan, type TaxPlan } from "./tax";

type Ctx = QueryCtx | MutationCtx;

export type WorkerAgreement = {
  agreement: Doc<"agreements">;
  request: Doc<"agreementSignatureRequests"> | null;
  /** The worker's own signer link on that request, when the request is Selestial-hosted. */
  signer: Doc<"agreementSigningLinks"> | null;
  version: Doc<"agreementVersions"> | null;
};

/**
 * The working agreement sent to this worker: one they are a named party to, of the type the company's
 * onboarding names for their relationship (or any working agreement), sent or signed. A draft is the
 * company's own work and is never shown.
 */
export async function agreementForWorker(ctx: Ctx, company: Doc<"companies">, cleaner: Doc<"cleaners">, onboarding: PublishedOnboarding, docType?: string): Promise<WorkerAgreement | null> {
  const links = await ctx.db
    .query("agreementLinks")
    .withIndex("by_company_record", (q) => q.eq("companyId", company._id).eq("table", "cleaners").eq("recordId", cleaner._id))
    .take(20);
  const wanted = docType ?? agreementTypeFor({ kind: "agreement" }, cleaner.engagement, onboarding);
  const candidates: Doc<"agreements">[] = [];
  for (const link of links) {
    const agreement = await ctx.db.get(link.agreementId);
    if (!agreement || agreement.companyId !== company._id || agreement.category !== "workforce" || agreement.archivedAt) continue;
    if (!agreement.parties.some((party) => party.record?.table === "cleaners" && party.record.id === cleaner._id)) continue;
    if (!["sent", "partially_signed", "signed"].includes(agreement.workflow)) continue;
    if (agreement.lifecycle.terminatedOn || agreement.lifecycle.supersededBy) continue;
    const typeOk = !wanted || wanted === "*" ? WORKING_AGREEMENT_TYPES.includes(agreement.docType) || agreement.docType === wanted : agreement.docType === wanted;
    if (typeOk) candidates.push(agreement);
  }
  const agreement = candidates.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!agreement) return null;
  const requests = await ctx.db
    .query("agreementSignatureRequests")
    .withIndex("by_company_agreement", (q) => q.eq("companyId", company._id).eq("agreementId", agreement._id))
    .order("desc")
    .take(5);
  const request = requests.find((row) => row.status === "sent" || row.status === "partially_signed" || row.status === "completed") ?? null;
  let signer: Doc<"agreementSigningLinks"> | null = null;
  let version: Doc<"agreementVersions"> | null = null;
  if (request) {
    const party = agreement.parties.find((p) => p.signer && p.record?.table === "cleaners" && p.record.id === cleaner._id);
    const email = party?.email?.trim().toLowerCase();
    if (email && request.provider === HOSTED) {
      signer =
        (
          await ctx.db
            .query("agreementSigningLinks")
            .withIndex("by_company_request", (q) => q.eq("companyId", company._id).eq("requestId", request._id))
            .take(20)
        ).find((row) => row.signerEmail === email) ?? null;
    }
    const row = await ctx.db
      .query("agreementVersions")
      .withIndex("by_company_agreement_version", (q) => q.eq("companyId", company._id).eq("agreementId", agreement._id).eq("version", request.version))
      .unique();
    // Only the exact version the request names, and only while its text is unchanged.
    version = row && row.hash === request.hash ? row : null;
  }
  return { agreement, request, signer, version };
}

export async function taxDocOf(ctx: Ctx, companyId: Id<"companies">, cleanerId: Id<"cleaners">): Promise<Doc<"taxDocuments"> | null> {
  return (
    await ctx.db
      .query("taxDocuments")
      .withIndex("by_company_cleaner", (q) => q.eq("companyId", companyId).eq("cleanerId", cleanerId))
      .take(1)
  )[0] ?? null;
}

export async function payoutOf(ctx: Ctx, companyId: Id<"companies">, cleanerId: Id<"cleaners">): Promise<Doc<"payoutPreferences"> | null> {
  const rows = await ctx.db
    .query("payoutPreferences")
    .withIndex("by_company_cleaner", (q) => q.eq("companyId", companyId).eq("cleanerId", cleanerId))
    .order("desc")
    .take(5);
  return rows.find((row) => row.status !== "replaced") ?? null;
}

export async function trainingOf(ctx: Ctx, companyId: Id<"companies">, cleanerId: Id<"cleaners">): Promise<Doc<"trainingProgress">[]> {
  return ctx.db
    .query("trainingProgress")
    .withIndex("by_company_cleaner", (q) => q.eq("companyId", companyId).eq("cleanerId", cleanerId))
    .take(100);
}

/** Whether the tax document needs something only the worker can give, and can take it securely now. */
export function taxNeedsWorker(plan: TaxPlan, doc: Doc<"taxDocuments"> | null, keyReady: boolean): boolean {
  if (plan.form !== "w9" || !keyReady) return false;
  return !doc || doc.status === "awaiting_information" || doc.status === "awaiting_confirmation";
}

/** The training modules a worker completed under a version that still counts. */
export function completedModules(progress: Doc<"trainingProgress">[], floor: number): Set<string> {
  return new Set(progress.filter((row) => row.completedAt !== undefined && row.version >= floor).map((row) => row.moduleKey));
}

export async function journeyOf(ctx: Ctx, company: Doc<"companies">, cleaner: Doc<"cleaners">, now: number) {
  const base = await cleanerReadiness(ctx, company, cleaner, now);
  const { readiness, onboarding, definitions } = base;
  const agreementDef = definitions.find((def) => def.kind === "agreement" && readiness.requirements.some((view) => view.key === def.key));
  const agreement = agreementDef ? await agreementForWorker(ctx, company, cleaner, onboarding, agreementTypeFor(agreementDef, cleaner.engagement, onboarding)) : null;
  const signerOpen = agreement?.signer ? signerState({ link: agreement.signer, request: agreement.request!, agreement: agreement.agreement }, now) === "open" : false;
  const plan = taxPlan(company, cleaner);
  const tax = await taxDocOf(ctx, company._id, cleaner._id);
  const keyReady = await taxKeyConfigured();
  const facts: StepFacts = {
    agreementToSign: Boolean(agreement?.signer && signerOpen && agreement.version),
    agreementSignedByWorker: Boolean(agreement?.signer?.signature) && agreement?.agreement.workflow !== "signed",
    taxNeedsWorker: taxNeedsWorker(plan, tax, keyReady),
    trainingModules: requiredModules(onboarding.content).length,
    readiness: readiness.state,
  };
  const journey: Journey = onboardingJourney(readiness.requirements, facts);
  return { ...base, journey, facts, agreement, tax, taxPlan: plan, taxKeyReady: keyReady };
}

/**
 * Tells the office something a cleaner finished needs a person: one Recruiter task per cleaner and step,
 * never two. The task names what to check and where; nothing is decided by it.
 */
export async function askOfficeToReview(ctx: MutationCtx, company: Doc<"companies">, cleaner: Doc<"cleaners">, what: { key: string; label: string; where: string }, actor: Actor): Promise<void> {
  const key = `cleaners.review:${cleaner._id}:${what.key}`;
  if (await liveTaskByKey(ctx, company._id, key)) return;
  await openTask(ctx, {
    companyId: company._id,
    agent: "recruiter",
    title: `Review ${what.label.toLowerCase()} for ${cleaner.name}`,
    nextAction: `${cleaner.name} finished this onboarding step from their link. ${what.where}`,
    dueAt: Date.now() + 24 * HOUR,
    completionCondition: "A person accepted it or asked for a change",
    about: { table: "cleaners", id: cleaner._id },
    key,
    actor,
  });
}
