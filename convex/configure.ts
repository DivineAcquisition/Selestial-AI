/**
 * Business configuration: from a few onboarding answers to real drafts in the workspace, prepared in the
 * background and reviewed by the Owner (docs/onboarding/02-business-configuration.md).
 *
 * What it reads, and only this: confirmed facts (who they clean for, the services they picked), the costs in
 * the pricing profile, the ZIP codes and hours in business settings, and the setup answers about pricing and
 * agreements. Nothing found on a website is used until the Owner confirms it.
 *
 * What it makes, each in its own home: service drafts (Services & Pricing), a booking form draft per kind of
 * page (Booking forms), agreement drafts (Agreements) and job standard drafts (Quality). Nothing is
 * published, approved, sent or switched on here.
 *
 * How it stays durable: one ledger row per company and kind (configOutputs). start queues each kind; run (an
 * action) claims the row with a lease, builds it in one mutation, and records a failure in a separate one
 * so a failed build leaves the others in place and retries with backoff. Booking waits for services. sweep
 * (cron) picks up anything whose worker never reported back.
 *
 * Changed answers: an untouched draft is rewritten in place; a draft a person changed, approved or
 * published is never overwritten. It is listed as kept, with why.
 *
 * Public:   inputs, workspace, saveOffering, saveCosts, saveAvailability, start, regenerate
 * Internal: run, claim, build, failed, sweep
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { createExperience } from "./bookingExperiences";
import { accessFor } from "./lib/activation/work";
import { createAgreement } from "./lib/agreements/store";
import { defaultDefinition, KIND_LABELS, normalizeDefinition, type Definition } from "./lib/booking/definition";
import { companyQuery, ownerMutation, type MemberAccess } from "./lib/builders";
import { agreementsFor, choiceFor, isCategory, modeFor, OFFER_CHOICES, PAGE_FOR, servicesToPrepare, STANDARD_FOR } from "./lib/configure/catalog";
import { suggestPricing, typicalJob } from "./lib/configure/pricing";
import { DEPENDS_ON, OUTPUT_KINDS, outputKindValidator, type Generated, type Missing, type OutputKind } from "./lib/configure/schema";
import { DOC_TYPE_BY_KEY } from "./lib/agreements/catalog";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { checkedRequirements, standardKey, TEMPLATES as STANDARD_TEMPLATES, versionsOf } from "./lib/quality/standards";
import { TEMPLATE_WORDS } from "./lib/quality/words";
import { isOwner } from "./lib/roles";
import { quote } from "./lib/services/engine";
import { emptyCosts, payValidator, type Costs } from "./lib/services/profit";
import { emptyContext } from "./lib/services/setup";
import type { Category, Spec } from "./lib/services/spec";
import { canonical, draftOf, specHash } from "./lib/services/store";
import { templateById } from "./lib/services/templates";
import { formatCents } from "./lib/services/words";
import { createDraft, writeDraft } from "./lib/services/workflow";
import { sha256 } from "./lib/agreements/hash";
import { businessSettingsOf, hoursWindowValidator, normalizeBusiness, revisionOf } from "./lib/settings/business";
import { factsOf, stateFact } from "./lib/setup/facts";
import type { WeeklyWindow } from "./lib/availability";

type Ctx = QueryCtx | MutationCtx;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
export const MAX_ATTEMPTS = 3;
/** How long one build may hold its row before the sweep counts it as abandoned. */
export const LEASE_MS = 2 * MINUTE;
const BACKOFF_MS = [20 * SECOND, 2 * MINUTE, 10 * MINUTE];

export const REVIEW_PATH = "/app/setup/business";

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────────

export type Inputs = {
  categories: Category[];
  /** What the owner picked; empty when they haven't. */
  offered: string[];
  /** What will be prepared: their picks, or each category's defaults. */
  templates: string[];
  costs: Costs | null;
  pricingState: string | null;
  agreementsHave: string | null;
  serviceAreas: string[];
  hours: WeeklyWindow[];
};

export async function inputsOf(ctx: Ctx, company: Doc<"companies">): Promise<Inputs> {
  const facts = await factsOf(ctx, company._id);
  const confirmed = (key: string) => {
    const row = facts.find((fact) => fact.key === key && fact.state === "confirmed");
    return row ? (Array.isArray(row.value) ? row.value : [row.value]) : [];
  };
  const categories = confirmed("services.categories").filter(isCategory);
  const offered = confirmed("services.offered").filter((id) => choiceFor(id) !== null);
  const profile = await ctx.db
    .query("pricingProfiles")
    .withIndex("by_company", (q) => q.eq("companyId", company._id))
    .first();
  const setup = await ctx.db
    .query("companySetups")
    .withIndex("by_company", (q) => q.eq("companyId", company._id))
    .first();
  const answer = (id: string) => {
    const value = setup?.answers[id];
    return typeof value === "string" ? value : null;
  };
  const business = businessSettingsOf(company);
  return {
    categories,
    offered,
    templates: servicesToPrepare(categories, offered),
    costs: profile?.costs ?? null,
    pricingState: answer("pricing.state"),
    agreementsHave: answer("agreements.have"),
    serviceAreas: business.serviceAreas,
    hours: business.hours,
  };
}

/** Prices can be worked out from the owner's costs, and they don't quote every job by hand. */
export function pricedFrom(inputs: Inputs): boolean {
  if (inputs.pricingState === "quote_each") return false;
  const sample = inputs.templates.map((id) => templateById(id)).find((t) => t && t.spec.pricing.method !== "custom_quote");
  return Boolean(sample && suggestPricing(sample.spec, inputs.costs).basis === "costs");
}

/** Only what each kind actually reads, so a change to hours doesn't touch agreements. */
export function inputsHash(kind: OutputKind, inputs: Inputs): string {
  const parts =
    kind === "services"
      ? { templates: inputs.templates, costs: inputs.costs, pricingState: inputs.pricingState }
      : kind === "booking"
        ? { templates: inputs.templates, priced: pricedFrom(inputs), pricingState: inputs.pricingState }
        : kind === "agreements"
          ? { templates: inputs.templates, have: inputs.agreementsHave }
          : { templates: inputs.templates };
  return sha256(canonical({ kind, ...parts }));
}

// ── Ledger ──────────────────────────────────────────────────────────────────────────────────────────

async function rowOf(ctx: Ctx, companyId: Id<"companies">, kind: OutputKind): Promise<Doc<"configOutputs"> | null> {
  return ctx.db
    .query("configOutputs")
    .withIndex("by_company_kind", (q) => q.eq("companyId", companyId).eq("kind", kind))
    .first();
}

/**
 * Queues the kinds whose inputs changed since they were last built (or all, when `force`). A row already
 * queued or working is left alone: it reads the inputs fresh when it runs. Returns what was queued.
 */
async function queue(ctx: MutationCtx, company: Doc<"companies">, memberId: Id<"members">, kinds: readonly OutputKind[], force: boolean): Promise<OutputKind[]> {
  const inputs = await inputsOf(ctx, company);
  const now = Date.now();
  const queued: OutputKind[] = [];
  for (const kind of kinds) {
    const hash = inputsHash(kind, inputs);
    const row = await rowOf(ctx, company._id, kind);
    if (row && (row.state === "queued" || row.state === "working")) continue;
    if (row && !force && row.state === "done" && row.builtFromHash === hash) continue;
    if (row) await ctx.db.patch(row._id, { state: "queued", inputsHash: hash, attempts: 0, nextRunAt: now, lastError: undefined, startedBy: memberId, updatedAt: now });
    else await ctx.db.insert("configOutputs", { companyId: company._id, kind, state: "queued", inputsHash: hash, records: [], notes: [], missing: [], kept: [], attempts: 0, nextRunAt: now, startedBy: memberId, startedAt: now, updatedAt: now });
    queued.push(kind);
  }
  // Kinds that depend on another wait for it: services finishing schedules booking.
  for (const kind of queued) if (DEPENDS_ON[kind].every((dep) => !queued.includes(dep))) await ctx.scheduler.runAfter(0, internal.configure.run, { companyId: company._id, kind });
  return queued;
}

/** After an answer changes: rebuild what was already prepared and now reads differently. Never the first time. */
async function requeueChanged(ctx: MutationCtx & MemberAccess): Promise<void> {
  const any = await ctx.db
    .query("configOutputs")
    .withIndex("by_company_kind", (q) => q.eq("companyId", ctx.companyId))
    .first();
  if (!any) return;
  await queue(ctx, ctx.company, ctx.member._id, OUTPUT_KINDS, false);
}

// ── Saving answers ──────────────────────────────────────────────────────────────────────────────────

/** What the onboarding form shows: the answers as stored, and the services that fit what they clean. */
export const inputs = companyQuery({
  args: {},
  handler: async (ctx) => {
    const inputs = await inputsOf(ctx, ctx.company);
    const costs = inputs.costs ?? emptyCosts();
    return {
      categories: inputs.categories,
      choices: inputs.categories.map((category) => ({ category, choices: OFFER_CHOICES[category] })),
      offered: inputs.offered,
      preparing: inputs.templates,
      costs: { pay: costs.pay, targetMarginPercent: costs.targetMarginPercent, minimumJobCents: costs.minimumJobCents, suppliesPerVisitCents: costs.suppliesPerVisitCents },
      pricingState: inputs.pricingState,
      serviceAreas: inputs.serviceAreas,
      hours: inputs.hours,
      timezone: ctx.company.timezone,
      canEdit: isOwner(ctx.role),
    };
  },
});

export const saveOffering = ownerMutation({
  args: { offered: v.array(v.string()) },
  handler: async (ctx, args) => {
    const ids = [...new Set(args.offered)].slice(0, 30);
    for (const id of ids) if (!choiceFor(id)) throw userError("That isn't one of the services you can choose.");
    await stateFact(ctx, ctx.companyId, ctx.member._id, "services.offered", ids);
    await requeueChanged(ctx);
    return { offered: ids };
  },
});

const pct = (value: number | null, label: string, max: number) => {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > max) throw userError(`${label} must be from 0% to ${max}%.`);
  return Math.round(value * 100) / 100;
};
const money = (value: number | null, label: string) => {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_00) throw userError(`${label} must be whole cents, zero or more.`);
  return value;
};

/**
 * The few costs that decide a price, written to the pricing profile (their one home, shared with Pricing
 * Studio). Only these fields change; the rest of the profile is kept. Null means "I don't know".
 */
export const saveCosts = ownerMutation({
  args: { pay: v.union(payValidator, v.null()), targetMarginPercent: v.union(v.number(), v.null()), minimumJobCents: v.union(v.number(), v.null()), suppliesPerVisitCents: v.union(v.number(), v.null()) },
  handler: async (ctx, args) => {
    let pay = args.pay;
    if (pay?.model === "hourly") pay = { model: "hourly", hourlyCents: money(pay.hourlyCents, "The hourly wage")!, burdenPercent: pct(pay.burdenPercent, "Payroll costs", 200)! };
    else if (pay?.model === "per_visit") pay = { model: "per_visit", amountCents: money(pay.amountCents, "Pay per visit")! };
    else if (pay?.model === "revenue_share") pay = { model: "revenue_share", sharePercent: pct(pay.sharePercent, "The cleaner's share", 100)! };
    const target = pct(args.targetMarginPercent, "The target margin", 95);
    const row = await ctx.db
      .query("pricingProfiles")
      .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
      .first();
    const current = row?.costs ?? emptyCosts();
    const floor = current.floorMarginPercent !== null && target !== null && current.floorMarginPercent > target ? target : current.floorMarginPercent;
    const costs: Costs = { ...current, pay, targetMarginPercent: target, floorMarginPercent: floor, minimumJobCents: money(args.minimumJobCents, "The minimum job"), suppliesPerVisitCents: money(args.suppliesPerVisitCents, "Supplies") };
    const now = Date.now();
    if (row) {
      if (canonical(row.costs) === canonical(costs)) return { changed: false };
      await ctx.db.patch(row._id, { costs, revision: row.revision + 1, updatedBy: byMember(ctx), updatedAt: now });
    } else {
      await ctx.db.insert("pricingProfiles", { companyId: ctx.companyId, revision: 1, context: emptyContext(), costs, strategy: null, positioning: null, researchDuringSetup: true, updatedBy: byMember(ctx), updatedAt: now });
    }
    await recordEvent(ctx, { companyId: ctx.companyId, type: "service.profile_saved", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { via: "business_setup" } });
    await requeueChanged(ctx);
    return { changed: true };
  },
});

/** ZIP codes and booking hours, written to business settings (their one home; Booking reads them there). */
export const saveAvailability = ownerMutation({
  args: { serviceAreas: v.array(v.string()), hours: v.array(hoursWindowValidator) },
  handler: async (ctx, args) => {
    const current = businessSettingsOf(ctx.company);
    const next = normalizeBusiness({ serviceAreas: args.serviceAreas, hours: args.hours, services: current.services }, current);
    if (canonical(next) === canonical(current)) return { changed: false, serviceAreas: next.serviceAreas };
    const revision = revisionOf(ctx.company);
    await ctx.db.patch(ctx.companyId, { businessSettings: next, settingsRevision: revision + 1 });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "company.business_settings_changed", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { sections: "areas, hours", revision: revision + 1, via: "business_setup" } });
    await requeueChanged(ctx);
    return { changed: true, serviceAreas: next.serviceAreas };
  },
});

// ── Starting ────────────────────────────────────────────────────────────────────────────────────────

/** The Owner asks Selestial to prepare their setup. Pressing it again changes nothing that is up to date. */
export const start = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const inputs = await inputsOf(ctx, ctx.company);
    if (!inputs.categories.length) throw userError("Tell us who you clean for first, in your company details.");
    const queued = await queue(ctx, ctx.company, ctx.member._id, OUTPUT_KINDS, false);
    if (queued.length) await recordEvent(ctx, { companyId: ctx.companyId, type: "configuration.started", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { kinds: queued.join(", ") } });
    return { queued };
  },
});

/** Prepare one kind again: a failed one, or after deleting a draft. Edited drafts are still kept. */
export const regenerate = ownerMutation({
  args: { kind: outputKindValidator },
  handler: async (ctx, args) => {
    const inputs = await inputsOf(ctx, ctx.company);
    if (!inputs.categories.length) throw userError("Tell us who you clean for first, in your company details.");
    const queued = await queue(ctx, ctx.company, ctx.member._id, [args.kind], true);
    return { queued };
  },
});

// ── Running ─────────────────────────────────────────────────────────────────────────────────────────

/** One build, outside a transaction, so a failure can be recorded after the build's writes roll back. */
export const run = internalAction({
  args: { companyId: v.id("companies"), kind: outputKindValidator },
  handler: async (ctx, args) => {
    const claimed = await ctx.runMutation(internal.configure.claim, args);
    if (!claimed) return;
    try {
      await ctx.runMutation(internal.configure.build, args);
    } catch (error) {
      const data = (error as { data?: { message?: unknown } }).data;
      const message = typeof data?.message === "string" ? data.message : "Something went wrong while preparing this.";
      await ctx.runMutation(internal.configure.failed, { ...args, message });
    }
  },
});

/** Takes the row for one build, with a lease. False when it isn't due, is held by another worker, or waits on another kind. */
export const claim = internalMutation({
  args: { companyId: v.id("companies"), kind: outputKindValidator },
  handler: async (ctx, args) => {
    const row = await rowOf(ctx, args.companyId, args.kind);
    if (!row || row.state !== "queued") return false;
    for (const dep of DEPENDS_ON[args.kind]) {
      const other = await rowOf(ctx, args.companyId, dep);
      if (other && (other.state === "queued" || other.state === "working")) return false;
    }
    const now = Date.now();
    await ctx.db.patch(row._id, { state: "working", nextRunAt: now + LEASE_MS, attempts: row.attempts + 1, updatedAt: now });
    return true;
  },
});

export const failed = internalMutation({
  args: { companyId: v.id("companies"), kind: outputKindValidator, message: v.string() },
  handler: async (ctx, args) => {
    const row = await rowOf(ctx, args.companyId, args.kind);
    if (!row || row.state !== "working") return;
    const now = Date.now();
    const message = args.message.slice(0, 300);
    if (row.attempts < MAX_ATTEMPTS) {
      const delay = BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)];
      await ctx.db.patch(row._id, { state: "queued", nextRunAt: now + delay, lastError: message, updatedAt: now });
      await ctx.scheduler.runAfter(delay, internal.configure.run, { companyId: args.companyId, kind: args.kind });
      return;
    }
    await ctx.db.patch(row._id, { state: "failed", nextRunAt: undefined, lastError: message, finishedAt: now, updatedAt: now });
    await recordEvent(ctx, { companyId: args.companyId, type: "configuration.failed", actor: { kind: "system" }, subject: { table: "companies", id: args.companyId }, data: { kind: args.kind, attempts: row.attempts } });
    // What waited on it can't go ahead; say so on its card.
    for (const kind of OUTPUT_KINDS) {
      if (!DEPENDS_ON[kind].includes(args.kind)) continue;
      const waiting = await rowOf(ctx, args.companyId, kind);
      if (waiting && waiting.state === "queued") await ctx.db.patch(waiting._id, { state: "waiting", nextRunAt: undefined, missing: [{ words: `This needs your ${args.kind === "services" ? "service drafts" : args.kind}, which couldn't be prepared. Try those again first.`, href: REVIEW_PATH }], updatedAt: now });
    }
  },
});

/** Finds builds whose worker never reported back, and queued ones whose schedule was lost. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const state of ["working", "queued"] as const) {
      const rows = await ctx.db
        .query("configOutputs")
        .withIndex("by_state_next", (q) => q.eq("state", state).lt("nextRunAt", now - (state === "queued" ? 5 * MINUTE : 0)))
        .take(50);
      for (const row of rows) {
        if (state === "working") await ctx.db.patch(row._id, { state: "queued", nextRunAt: now, updatedAt: now });
        await ctx.scheduler.runAfter(0, internal.configure.run, { companyId: row.companyId, kind: row.kind });
      }
    }
  },
});

type Built = { records: Generated[]; notes: string[]; missing: Missing[]; kept: { label: string; why: string; href: string }[] };

/** Builds one kind, in one transaction, from the inputs as they are now. */
export const build = internalMutation({
  args: { companyId: v.id("companies"), kind: outputKindValidator },
  handler: async (ctx, args) => {
    const row = await rowOf(ctx, args.companyId, args.kind);
    if (!row || row.state !== "working") return;
    const company = await ctx.db.get(args.companyId);
    if (!company) throw userError("This company no longer exists.");
    const member = await ctx.db.get(row.startedBy);
    if (!member || member.companyId !== company._id || member.status !== "active" || !isOwner(member.role)) throw userError("The person who started this is no longer the Owner. The Owner can start it again.");
    const access = accessFor(ctx, company, member);
    const inputs = await inputsOf(ctx, company);
    const hash = inputsHash(args.kind, inputs);
    const built: Built =
      args.kind === "services" ? await buildServices(access, row, inputs) : args.kind === "booking" ? await buildBooking(access, row, inputs) : args.kind === "agreements" ? await buildAgreements(access, row, inputs) : await buildStandards(access, row, inputs);
    const now = Date.now();
    await ctx.db.patch(row._id, { state: built.missing.length && !built.records.length ? "waiting" : "done", inputsHash: hash, builtFromHash: hash, ...built, nextRunAt: undefined, lastError: undefined, finishedAt: now, updatedAt: now });
    await recordEvent(ctx, { companyId: company._id, type: "configuration.prepared", actor: { kind: "system" }, subject: { table: "companies", id: args.companyId }, data: { kind: args.kind, records: built.records.length, created: built.records.filter((r) => r.created).length, kept: built.kept.length } });
    // What waited on this goes next.
    for (const kind of OUTPUT_KINDS) {
      if (!DEPENDS_ON[kind].includes(args.kind)) continue;
      const next = await rowOf(ctx, company._id, kind);
      if (next && next.state === "queued") await ctx.scheduler.runAfter(0, internal.configure.run, { companyId: company._id, kind });
    }
  },
});

// ── Services ────────────────────────────────────────────────────────────────────────────────────────

type Access = MutationCtx & MemberAccess;
const SYSTEM_ACTOR = { kind: "system" as const };

async function servicesOf(ctx: Access): Promise<Doc<"services">[]> {
  const out: Doc<"services">[] = [];
  for (const status of ["draft", "active"] as const) {
    out.push(
      ...(await ctx.db
        .query("services")
        .withIndex("by_company_status", (q) => q.eq("companyId", ctx.companyId).eq("status", status))
        .take(300)),
    );
  }
  return out;
}

const previous = (row: Doc<"configOutputs">, key: string) => row.records.find((r) => r.key === key) ?? null;

async function buildServices(ctx: Access, row: Doc<"configOutputs">, inputs: Inputs): Promise<Built> {
  const out: Built = { records: [], notes: [], missing: [], kept: [] };
  if (!inputs.categories.length) return { ...out, missing: [{ words: "Tell us who you clean for, so the right services are prepared.", href: "/app/setup" }] };
  const existing = await servicesOf(ctx);
  let fromCosts = 0;
  for (const id of inputs.templates) {
    const template = templateById(id);
    if (!template) continue;
    const suggestion = suggestPricing(template.spec, inputs.costs);
    if (inputs.pricingState === "quote_each" && suggestion.basis === "costs") suggestion.assumptions.unshift("You said you quote every job yourself: these are a starting point for your quotes, not prices customers see.");
    const spec: Spec = suggestion.spec;
    const generatedHash = specHash(spec);
    const label = spec.name;
    const href = (serviceId: string) => `/app/services/${serviceId}`;
    if (suggestion.basis === "costs") fromCosts += 1;
    const notes = suggestion.assumptions.map((line) => `${label}: ${line}`);

    // Made by an earlier run: rewrite it only if nobody has touched it since.
    const before = previous(row, id);
    const mine = before ? await ctx.db.get(ctx.db.normalizeId("services", before.id)!) : null;
    // Or made by setup or activation from the same template, and never edited.
    const adoptable = !mine ? existing.find((s) => s.templateId === id) : null;
    const service = mine && mine.companyId === ctx.companyId && mine.status !== "archived" ? mine : (adoptable ?? null);
    if (!service) {
      const { serviceId } = await createDraft(ctx, { category: template.category, spec, origin: "template", templateId: id, via: "workspace", actor: SYSTEM_ACTOR });
      out.records.push({ key: id, table: "services", id: serviceId, label, generatedHash, created: true });
      out.notes.push(...notes);
      continue;
    }
    if (service.status !== "draft") {
      out.records.push({ key: id, table: "services", id: service._id, label: service.name, generatedHash: before?.generatedHash ?? "", created: false });
      out.kept.push({ label: service.name, why: "Already live in Services & Pricing, so it was left exactly as it is.", href: href(service._id) });
      continue;
    }
    const draft = await draftOf(ctx, ctx.companyId, service._id);
    if (!draft) continue;
    const untouched = before && service._id === mine?._id ? specHash(draft.spec) === before.generatedHash : draft.revision === 1;
    if (!untouched) {
      out.records.push({ key: id, table: "services", id: service._id, label: service.name, generatedHash: before?.generatedHash ?? "", created: false });
      out.kept.push({ label: service.name, why: "You changed this draft, so it was left as you made it.", href: href(service._id) });
      continue;
    }
    if (specHash(draft.spec) !== generatedHash) await writeDraft(ctx, service, draft, spec, draft.step, SYSTEM_ACTOR, "workspace");
    out.records.push({ key: id, table: "services", id: service._id, label, generatedHash, created: false });
    out.notes.push(...notes);
  }
  // Services they no longer pick are left where they are, never deleted.
  for (const old of row.records) {
    if (inputs.templates.includes(old.key)) continue;
    out.kept.push({ label: old.label, why: "No longer in the services you picked. It stays in Services & Pricing; archive it there if you don't need it.", href: `/app/services/${old.id}` });
  }
  if (!fromCosts && inputs.templates.some((id) => templateById(id)?.spec.pricing.method !== "custom_quote")) {
    out.missing.push({ words: "Prices are template examples. Tell us what you pay cleaners and the margin you aim for, and they are worked out from your costs.", href: `${REVIEW_PATH}#costs` });
  }
  return out;
}

// ── Booking ─────────────────────────────────────────────────────────────────────────────────────────

async function buildBooking(ctx: Access, row: Doc<"configOutputs">, inputs: Inputs): Promise<Built> {
  const out: Built = { records: [], notes: [], missing: [], kept: [] };
  const services = await rowOf(ctx, ctx.companyId, "services");
  const serviceRecords = services?.records ?? [];
  const priced = pricedFrom(inputs);
  const pages = [...new Set(inputs.templates.map((id) => choiceFor(id)?.category).filter((c): c is Category => Boolean(c)).map((category) => PAGE_FOR[category]))];
  const experiences = await ctx.db
    .query("bookingExperiences")
    .withIndex("by_company_updated", (q) => q.eq("companyId", ctx.companyId))
    .take(100);
  for (const kind of pages) {
    const templates = inputs.templates.filter((id) => PAGE_FOR[choiceFor(id)!.category] === kind);
    const offered: { key: string; spec: Spec }[] = [];
    for (const id of templates) {
      const record = serviceRecords.find((r) => r.key === id);
      const service = record ? await ctx.db.get(ctx.db.normalizeId("services", record.id)!) : null;
      if (!service || service.status === "archived") continue;
      const draft = await draftOf(ctx, ctx.companyId, service._id);
      offered.push({ key: service.key, spec: draft?.spec ?? templateById(id)!.spec });
    }
    const { mode, why } = modeFor(kind, templates, priced);
    const def: Definition = defaultDefinition(kind);
    def.services.offered = offered.map((s, at) => ({ serviceKey: s.key, displayName: "", blurb: "", benefits: [], badge: at === 0 && offered.length > 1 ? "Most popular" : "", hidden: false }));
    def.services.featuredKey = offered[0]?.key ?? null;
    if (offered.length >= 2) {
      const labels = new Map<string, { group: string; included: Set<string> }>();
      for (const s of offered) {
        for (const item of s.spec.included) {
          const entry = labels.get(item.label) ?? { group: item.section ?? "Everywhere", included: new Set<string>() };
          entry.included.add(s.key);
          labels.set(item.label, entry);
        }
      }
      def.services.comparison.rows = [...labels.entries()].slice(0, 30).map(([label, entry]) => ({ label: label.slice(0, 120), group: entry.group.slice(0, 80), included: [...entry.included] }));
    }
    def.behavior.mode = mode;
    def.behavior.paymentPolicyId = null;
    const draft = normalizeDefinition(def);
    const generatedHash = sha256(canonical(draft));
    const name = KIND_LABELS[kind].label;
    const href = (id: string) => `/app/agents/sales/booking-forms/${id}`;

    const before = previous(row, kind);
    const mine = before ? await ctx.db.get(ctx.db.normalizeId("bookingExperiences", before.id)!) : null;
    const live = experiences.find((e) => e.kind === kind && e.status === "published");
    const adoptable = !mine ? experiences.find((e) => e.kind === kind && e.status === "draft" && e.publishedVersion === undefined && e.draftRevision === 1) : null;
    const experience = mine && mine.companyId === ctx.companyId && mine.status !== "archived" ? mine : (adoptable ?? null);
    if (!experience && live) {
      out.records.push({ key: kind, table: "bookingExperiences", id: live._id, label: live.name, generatedHash: "", created: false });
      out.kept.push({ label: live.name, why: "You already have this booking form live, so no new one was made.", href: href(live._id) });
      continue;
    }
    out.notes.push(`${name}: ${why}`);
    if (!experience) {
      const id = await createExperience(ctx, kind, name);
      await ctx.db.patch(id, { draft, draftDiffers: true, updatedAt: Date.now() });
      out.records.push({ key: kind, table: "bookingExperiences", id, label: name, generatedHash, created: true });
      continue;
    }
    if (experience.status !== "draft" || experience.publishedVersion !== undefined) {
      out.records.push({ key: kind, table: "bookingExperiences", id: experience._id, label: experience.name, generatedHash: before?.generatedHash ?? "", created: false });
      out.kept.push({ label: experience.name, why: "Already published, so it was left exactly as it is.", href: href(experience._id) });
      continue;
    }
    const current = sha256(canonical(experience.draft));
    const untouched = before && experience._id === mine?._id ? current === before.generatedHash : experience.draftRevision === 1;
    if (!untouched) {
      out.records.push({ key: kind, table: "bookingExperiences", id: experience._id, label: experience.name, generatedHash: before?.generatedHash ?? "", created: false });
      out.kept.push({ label: experience.name, why: "You changed this booking form, so it was left as you made it.", href: href(experience._id) });
      continue;
    }
    if (current !== generatedHash) await ctx.db.patch(experience._id, { draft, draftRevision: experience.draftRevision + 1, draftSavedAt: Date.now(), draftSavedBy: "Selestial", draftDiffers: true, updatedAt: Date.now() });
    out.records.push({ key: kind, table: "bookingExperiences", id: experience._id, label: experience.name, generatedHash, created: false });
  }
  if (!pages.length) out.missing.push({ words: "Pick at least one service so a booking form can be prepared.", href: `${REVIEW_PATH}#services` });
  if (!inputs.serviceAreas.length) out.missing.push({ words: "Add the ZIP codes you serve, so the form can check a customer's address.", href: `${REVIEW_PATH}#availability` });
  if (!inputs.hours.length) out.missing.push({ words: "Add the days and hours you take bookings, so customers see real times.", href: `${REVIEW_PATH}#availability` });
  return out;
}

// ── Agreements ──────────────────────────────────────────────────────────────────────────────────────

async function buildAgreements(ctx: Access, row: Doc<"configOutputs">, inputs: Inputs): Promise<Built> {
  const out: Built = { records: [], notes: [], missing: [], kept: [] };
  if (inputs.agreementsHave === "own") {
    out.notes.push("You said you have your own agreement, so no starting text was prepared.");
    out.missing.push({ words: "Upload your own agreement in Agreements, so Selestial uses your terms.", href: "/app/agreements" });
    return out;
  }
  const existing = (
    await ctx.db
      .query("agreements")
      .withIndex("by_company_updated", (q) => q.eq("companyId", ctx.companyId))
      .order("desc")
      .take(200)
  ).filter((a) => a.archivedAt === undefined && a.workflow !== "withdrawn");
  for (const docType of agreementsFor(inputs.templates)) {
    const type = DOC_TYPE_BY_KEY.get(docType);
    if (!type) continue;
    const before = previous(row, docType);
    const mine = before ? await ctx.db.get(ctx.db.normalizeId("agreements", before.id)!) : null;
    const found = mine && mine.companyId === ctx.companyId && mine.archivedAt === undefined ? mine : (existing.find((a) => a.docType === docType) ?? null);
    if (found) {
      out.records.push({ key: docType, table: "agreements", id: found._id, label: found.title, generatedHash: before?.generatedHash ?? "", created: before?.created ?? false });
      continue;
    }
    const agreementId = await createAgreement(ctx, { docType, origin: "manual", note: "Prepared by business setup from the services you offer" });
    const made = await ctx.db.get(agreementId);
    out.records.push({ key: docType, table: "agreements", id: agreementId, label: made?.title ?? type.label, generatedHash: String(made?.currentVersion ?? 1), created: true });
  }
  if (out.records.length) out.notes.push("Agreements start from Selestial's starting text. Anything only you can decide is marked to confirm. Nobody has reviewed these terms, and nothing is sent.");
  return out;
}

// ── Job standards ───────────────────────────────────────────────────────────────────────────────────

async function buildStandards(ctx: Access, row: Doc<"configOutputs">, inputs: Inputs): Promise<Built> {
  const out: Built = { records: [], notes: [], missing: [], kept: [] };
  for (const id of inputs.templates) {
    const standard = STANDARD_FOR[id];
    const template = templateById(id);
    if (!standard || !template) continue;
    const ref = template.spec.name;
    const key = standardKey("service", ref);
    const versions = await versionsOf(ctx, ctx.companyId, key);
    if (versions.length) {
      const latest = versions[0];
      out.records.push({ key: id, table: "qualityStandards", id: latest._id, label: latest.name, generatedHash: previous(row, id)?.generatedHash ?? "", created: previous(row, id)?.created ?? false });
      continue;
    }
    const requirements = checkedRequirements(STANDARD_TEMPLATES[standard].requirements, "service");
    const now = Date.now();
    const name = `${ref}: ${TEMPLATE_WORDS[standard]}`.slice(0, 80);
    const standardId = await ctx.db.insert("qualityStandards", { companyId: ctx.companyId, level: "service", key, version: 1, status: "draft", name, template: standard, requirements, createdBy: byMember(ctx), createdAt: now, updatedAt: now, serviceKey: ref.toLowerCase().replace(/\s+/g, " ") });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "quality_standard.drafted", actor: byMember(ctx), subject: { table: "qualityStandards", id: standardId }, data: { level: "service", via: "business_setup" } });
    out.records.push({ key: id, table: "qualityStandards", id: standardId, label: name, generatedHash: sha256(canonical(requirements)), created: true });
  }
  if (out.records.length) out.notes.push("Each standard lists what a finished visit must show, from Selestial's template for that kind of cleaning. Change it to match how your team works, then publish it.");
  return out;
}

// ── Review workspace ────────────────────────────────────────────────────────────────────────────────

export type ReviewStatus = "preparing" | "ready" | "needs_info" | "approved" | "published" | "failed";

type Item = { label: string; href: string; status: ReviewStatus; detail: string; flags: string[] };

async function serviceItem(ctx: QueryCtx, companyId: Id<"companies">, record: Generated): Promise<Item | null> {
  const id = ctx.db.normalizeId("services", record.id);
  const service = id ? await ctx.db.get(id) : null;
  if (!service || service.companyId !== companyId) return null;
  const href = `/app/services/${service._id}`;
  if (service.status === "archived") return { label: service.name, href, status: "needs_info", detail: "Archived in Services & Pricing.", flags: [] };
  const draft = await draftOf(ctx, companyId, service._id);
  const spec = draft?.spec ?? null;
  let detail = service.status === "active" ? "Live in Services & Pricing." : "Draft in Services & Pricing.";
  const flags: string[] = [];
  if (spec) {
    const job = typicalJob(spec);
    const priced = job ? quote(spec, job.input) : null;
    if (spec.pricing.method === "custom_quote") detail = "Quoted after an assessment, so it has no set price.";
    else if (job && priced && priced.totalCents !== null) detail = `${job.label}: ${formatCents(priced.totalCents)}.`;
    if (spec.illustrative) flags.push("Example prices from a template");
    if (draft && record.generatedHash && specHash(draft.spec) !== record.generatedHash) flags.push("You edited this");
  }
  const status: ReviewStatus = service.status === "active" ? "published" : spec?.illustrative ? "needs_info" : "ready";
  return { label: service.name, href, status, detail, flags };
}

async function bookingItem(ctx: QueryCtx, companyId: Id<"companies">, record: Generated): Promise<Item | null> {
  const id = ctx.db.normalizeId("bookingExperiences", record.id);
  const experience = id ? await ctx.db.get(id) : null;
  if (!experience || experience.companyId !== companyId) return null;
  const href = `/app/agents/sales/booking-forms/${experience._id}`;
  const mode = experience.draft.behavior.mode;
  const modeWords = mode === "instant" ? "Customers book and pay a firm price" : mode === "estimate_request" ? "Customers request an estimate" : "Customers ask for a walkthrough";
  const keys = experience.draft.services.offered.map((s) => s.serviceKey);
  let unpublished = 0;
  for (const key of keys) {
    const service = await ctx.db
      .query("services")
      .withIndex("by_company_key", (q) => q.eq("companyId", companyId).eq("key", key))
      .first();
    if (!service || service.status !== "active") unpublished += 1;
  }
  const flags = [...(unpublished ? [`${unpublished} of its ${keys.length} service${keys.length === 1 ? " isn't" : "s aren't"} published yet`] : []), ...(record.generatedHash && sha256(canonical(experience.draft)) !== record.generatedHash ? ["You edited this"] : [])];
  const status: ReviewStatus = experience.status === "published" ? "published" : "ready";
  return { label: experience.name, href, status, detail: `${modeWords}. ${keys.length} service${keys.length === 1 ? "" : "s"} offered.`, flags };
}

async function agreementItem(ctx: QueryCtx, companyId: Id<"companies">, record: Generated): Promise<Item | null> {
  const id = ctx.db.normalizeId("agreements", record.id);
  const agreement = id ? await ctx.db.get(id) : null;
  if (!agreement || agreement.companyId !== companyId) return null;
  const version = await ctx.db
    .query("agreementVersions")
    .withIndex("by_company_agreement_version", (q) => q.eq("companyId", companyId).eq("agreementId", agreement._id).eq("version", agreement.currentVersion))
    .first();
  const open = version?.unresolved.length ?? 0;
  const approved = ["approved", "sent", "partially_signed", "signed"].includes(agreement.workflow);
  const status: ReviewStatus = approved ? "approved" : open ? "needs_info" : "ready";
  return { label: agreement.title, href: `/app/agreements/${agreement._id}`, status, detail: open ? `${open} decision${open === 1 ? "" : "s"} only you can make, marked to confirm.` : "No open decisions in the text.", flags: approved ? [] : ["Starting text: nobody has reviewed these terms"] };
}

async function standardItem(ctx: QueryCtx, companyId: Id<"companies">, record: Generated): Promise<Item | null> {
  const id = ctx.db.normalizeId("qualityStandards", record.id);
  const standard = id ? await ctx.db.get(id) : null;
  if (!standard || standard.companyId !== companyId) return null;
  return { label: standard.name, href: "/app/agents/quality/standards", status: standard.status === "published" ? "published" : "ready", detail: `${standard.requirements.length} requirement${standard.requirements.length === 1 ? "" : "s"} for a finished visit.`, flags: [] };
}

/** Every card on "Your business setup": what was made, from what, where it stands and the one next thing to do. */
export const workspace = companyQuery({
  args: {},
  handler: async (ctx) => {
    const inputs = await inputsOf(ctx, ctx.company);
    const cards = [];
    for (const kind of OUTPUT_KINDS) {
      const row = await rowOf(ctx, ctx.companyId, kind);
      const items: Item[] = [];
      for (const record of row?.records ?? []) {
        const item = kind === "services" ? await serviceItem(ctx, ctx.companyId, record) : kind === "booking" ? await bookingItem(ctx, ctx.companyId, record) : kind === "agreements" ? await agreementItem(ctx, ctx.companyId, record) : await standardItem(ctx, ctx.companyId, record);
        if (item) items.push(item);
      }
      const running = row?.state === "queued" || row?.state === "working";
      const status: ReviewStatus | "not_started" = !row
        ? "not_started"
        : running
          ? "preparing"
          : row.state === "failed"
            ? "failed"
            : row.state === "waiting" || items.some((i) => i.status === "needs_info") || (row.missing.length > 0 && items.length === 0)
              ? "needs_info"
              : items.length && items.every((i) => i.status === "published")
                ? "published"
                : items.length && items.every((i) => i.status === "approved" || i.status === "published")
                  ? "approved"
                  : "ready";
      cards.push({
        kind,
        status,
        items,
        notes: row?.notes ?? [],
        missing: row?.missing ?? [],
        kept: row?.kept ?? [],
        error: row?.state === "failed" || (running && row?.lastError) ? (row?.lastError ?? null) : null,
        retrying: running && Boolean(row?.lastError),
        changed: Boolean(row && !running && row.builtFromHash !== undefined && row.builtFromHash !== inputsHash(kind, inputs)),
        dependsOn: DEPENDS_ON[kind],
        finishedAt: row?.finishedAt ?? null,
      });
    }
    return {
      started: cards.some((card) => card.status !== "not_started"),
      ready: inputs.categories.length > 0,
      categories: inputs.categories,
      preparing: inputs.templates.map((id) => choiceFor(id)?.label ?? id),
      priced: pricedFrom(inputs),
      cards,
      canEdit: isOwner(ctx.role),
    };
  },
});

