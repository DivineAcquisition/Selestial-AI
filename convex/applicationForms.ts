/**
 * Recruiter → Application forms: the forms applicants answer (docs/recruiter/09-application-builder.md).
 *
 * Who does what (the same split as roles and booking forms):
 *  - Everyone in the company reads forms and their versions.
 *  - Managers and the Owner draft, duplicate and restore an earlier version into the draft.
 *  - The Owner publishes, chooses the default form and archives, because those change what applicants see.
 *
 * Every save names the revision it started from; a different revision is refused with who saved and
 * when. Applicants only ever see a published version, and each keeps the one they started on.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { owned } from "./lib/access";
import { sha256 } from "./lib/agreements/hash";
import { bookingSettingsOf } from "./lib/booking/settings";
import { companyQuery, managerMutation, ownerMutation, type MemberAccess } from "./lib/builders";
import { siteOrigin } from "./lib/dispatch/links";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { BUILTINS, CUSTOM_KINDS, DISPLAY_LABELS, FIELD_KIND_LABELS, formDefinitionValidator, normalizeForm, WORK_AUTHORIZED_WORDING, type FormDefinition } from "./lib/recruiter/formDefinition";
import { companyForms, versionOf } from "./lib/recruiter/forms";
import { FORM_TEMPLATES, formTemplateKeys, type FormTemplateKey } from "./lib/recruiter/formTemplates";
import { literals } from "./lib/statuses";
import { canonical } from "./lib/services/store";

export const STALE_FORM = "Someone else saved this form after you opened it.";
const MAX_FORMS = 30;

const actorName = (ctx: MemberAccess) => ctx.member.name;

async function memberName(ctx: QueryCtx, id: Id<"members">): Promise<string> {
  return (await ctx.db.get(id))?.name ?? "A former member";
}

function normalizeOrRaw(def: FormDefinition): FormDefinition {
  try {
    return normalizeForm(def);
  } catch {
    return def;
  }
}

async function rolesOf(ctx: QueryCtx, companyId: Id<"companies">) {
  const out: Doc<"hiringNeeds">[] = [];
  for (const status of ["draft", "open", "paused"] as const) {
    out.push(
      ...(await ctx.db
        .query("hiringNeeds")
        .withIndex("by_company_status", (q) => q.eq("companyId", companyId).eq("status", status))
        .take(200)),
    );
  }
  return out;
}

/** Where the company's public application pages live, once it has a public address (Booking rules). */
async function publicBase(ctx: QueryCtx, company: Doc<"companies">): Promise<{ handle: string | null; base: string | null }> {
  const settings = await bookingSettingsOf(ctx, company);
  return { handle: settings.handle ?? null, base: settings.handle ? `${siteOrigin()}/apply/${settings.handle}` : null };
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────

/** The forms, the roles and which form each answers, and the public page's address. */
export const overview = companyQuery({
  args: {},
  handler: async (ctx) => {
    const forms = (await companyForms(ctx, ctx.companyId)).filter((form) => form.archivedAt === undefined);
    const roles = await rolesOf(ctx, ctx.companyId);
    const fallback = forms.find((form) => form.isDefault && form.publishedVersion !== undefined) ?? null;
    const usedBy = (form: Doc<"applicationForms">) => roles.filter((role) => role.formId === form._id || (!role.formId && fallback?._id === form._id)).map((role) => role.title);
    const { handle, base } = await publicBase(ctx, ctx.company);
    return {
      forms: forms.map((form) => ({
        id: form._id,
        name: form.name,
        template: form.template,
        isDefault: form.isDefault,
        publishedVersion: form.publishedVersion ?? null,
        draftDiffers: form.draftDiffers,
        display: form.draft.display,
        questions: form.draft.sections.reduce((sum, section) => sum + section.fields.filter((field) => field.kind !== "statement").length, 0),
        accentColor: form.draft.theme.accentColor,
        usedBy: usedBy(form),
        updatedAt: form.updatedAt,
        draftSavedBy: form.draftSavedBy,
      })),
      roles: roles.map((role) => ({
        id: role._id,
        title: role.title,
        status: role.status,
        formId: role.formId ?? null,
        formName: role.formId ? (forms.find((form) => form._id === role.formId)?.name ?? null) : (fallback?.name ?? "Short form"),
        publicApply: role.publicApply === true,
        slug: role.slug ?? null,
        url: base && role.slug ? `${base}/${role.slug}` : null,
      })),
      templates: FORM_TEMPLATES.map((template) => ({ key: template.key, name: template.name, blurb: template.blurb })),
      handle,
      careersUrl: base,
      canDraft: ctx.role === "owner" || ctx.role === "manager",
      canPublish: ctx.role === "owner",
    };
  },
});

/** One form, for the builder: the draft, its versions, the roles that use it, and what the builder may offer. */
export const get = companyQuery({
  args: { formId: v.id("applicationForms") },
  handler: async (ctx, args) => {
    const form = await owned(ctx, args.formId);
    const settings = await bookingSettingsOf(ctx, ctx.company);
    const versions = await ctx.db
      .query("applicationFormVersions")
      .withIndex("by_company_form_version", (q) => q.eq("companyId", ctx.companyId).eq("formId", form._id))
      .order("desc")
      .take(30);
    const roles = await rolesOf(ctx, ctx.companyId);
    const fallback = (await companyForms(ctx, ctx.companyId)).find((row) => row.isDefault && row.publishedVersion !== undefined && row.archivedAt === undefined);
    const usedBy = roles.filter((role) => role.formId === form._id || (!role.formId && fallback?._id === form._id));
    const sample = usedBy.find((role) => role.status === "open") ?? roles.find((role) => role.status === "open") ?? null;
    const { handle, base } = await publicBase(ctx, ctx.company);
    return {
      form: { id: form._id, name: form.name, template: form.template, isDefault: form.isDefault, publishedVersion: form.publishedVersion ?? null, publishedAt: form.publishedAt ?? null, archived: form.archivedAt !== undefined, draftRevision: form.draftRevision, draftSavedAt: form.draftSavedAt, draftSavedBy: form.draftSavedBy, draftDiffers: form.draftDiffers },
      draft: normalizeOrRaw(form.draft),
      versions: await Promise.all(versions.map(async (row) => ({ version: row.version, publishedAt: row.publishedAt, publishedBy: await memberName(ctx, row.publishedBy), note: row.note ?? null, restoredFrom: row.restoredFrom ?? null, current: row.version === form.publishedVersion }))),
      roles: usedBy.map((role) => ({ id: role._id, title: role.title, status: role.status, publicApply: role.publicApply === true, url: base && role.slug ? `${base}/${role.slug}` : null })),
      // The preview draws the form for a real role when there is one, so its areas and questions show.
      sample: sample ? { title: sample.title, coverageAreas: sample.coverageAreas, questions: sample.questions } : { title: "Cleaner", coverageAreas: [], questions: [] },
      brand: { companyName: settings.profile.displayName || ctx.company.name, brandColor: settings.profile.brandColor, logoUrl: settings.profile.logo ? await ctx.storage.getUrl(settings.profile.logo) : null },
      catalog: {
        builtins: Object.entries(BUILTINS).map(([id, builtin]) => ({ id, name: builtin.name, kind: builtin.kind, label: builtin.label, help: builtin.help ?? "", locked: [...(builtin.locked ?? [])] })),
        kinds: CUSTOM_KINDS.map((kind) => ({ kind, label: FIELD_KIND_LABELS[kind] })),
        displays: Object.entries(DISPLAY_LABELS).map(([id, words]) => ({ id, ...words })),
        workAuthorizedWording: WORK_AUTHORIZED_WORDING,
      },
      handle,
      careersUrl: base,
      canDraft: ctx.role === "owner" || ctx.role === "manager",
      canPublish: ctx.role === "owner",
    };
  },
});

// ── Changing ─────────────────────────────────────────────────────────────────────────────────────

async function insertForm(ctx: MutationCtx & MemberAccess, input: { name: string; template: string; draft: FormDefinition; isDefault?: boolean; from?: Id<"applicationForms"> }): Promise<Id<"applicationForms">> {
  const existing = await companyForms(ctx, ctx.companyId);
  if (existing.filter((form) => form.archivedAt === undefined).length >= MAX_FORMS) throw userError(`A company can keep up to ${MAX_FORMS} application forms. Archive one first.`);
  const name = input.name.trim().slice(0, 80);
  if (!name) throw userError("Name the form.");
  const now = Date.now();
  const id = await ctx.db.insert("applicationForms", { companyId: ctx.companyId, name, template: input.template, draft: normalizeForm(input.draft), draftRevision: 1, draftSavedAt: now, draftSavedBy: actorName(ctx), draftDiffers: true, isDefault: input.isDefault ?? false, createdBy: ctx.member._id, createdAt: now, updatedAt: now });
  await recordEvent(ctx, { companyId: ctx.companyId, type: input.from ? "application_form.duplicated" : "application_form.created", actor: byMember(ctx), subject: { table: "applicationForms", id }, data: { template: input.template, ...(input.from ? { from: input.from } : {}) } });
  return id;
}

/**
 * The company's first form, from the full cleaner application. When the Owner opens Application forms
 * for the first time it is published and made the default, so every role without its own form uses it
 * from then on; a Manager gets it as a draft for the Owner to publish. Running it again does nothing.
 */
export const ensureStarter = managerMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await companyForms(ctx, ctx.companyId);
    if (existing.length > 0) return { formId: existing[0]._id, created: false };
    const template = FORM_TEMPLATES[0];
    const owner = ctx.role === "owner";
    const formId = await insertForm(ctx, { name: template.name, template: template.key, draft: template.make(), isDefault: owner });
    if (owner) await publishDefinition(ctx, (await ctx.db.get(formId))!, (await ctx.db.get(formId))!.draft, "The starting form.");
    return { formId, created: true };
  },
});

export const create = managerMutation({
  args: { template: literals(formTemplateKeys), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const template = FORM_TEMPLATES.find((row) => row.key === (args.template as FormTemplateKey))!;
    return insertForm(ctx, { name: args.name?.trim() || template.name, template: template.key, draft: template.make() });
  },
});

export const duplicate = managerMutation({
  args: { formId: v.id("applicationForms") },
  handler: async (ctx, args) => {
    const source = await owned(ctx, args.formId);
    return insertForm(ctx, { name: `${source.name} (copy)`, template: source.template, draft: source.draft, from: source._id });
  },
});

export const rename = managerMutation({
  args: { formId: v.id("applicationForms"), name: v.string() },
  handler: async (ctx, args) => {
    const form = await owned(ctx, args.formId);
    const name = args.name.trim().slice(0, 80);
    if (!name) throw userError("Name the form.");
    await ctx.db.patch(form._id, { name, updatedAt: Date.now() });
    return null;
  },
});

async function writeDraft(ctx: MutationCtx & MemberAccess, form: Doc<"applicationForms">, definition: FormDefinition, expectedRevision: number, force?: boolean) {
  if (form.archivedAt !== undefined) throw userError("Restore this form before changing it.");
  if (form.draftRevision !== expectedRevision && !force) return { ok: false as const, conflict: { savedBy: form.draftSavedBy, savedAt: form.draftSavedAt, revision: form.draftRevision } };
  const draft = normalizeForm(definition);
  if (canonical(draft) === canonical(form.draft)) return { ok: true as const, revision: form.draftRevision, unchanged: true };
  const published = form.publishedVersion !== undefined ? await versionOf(ctx, ctx.companyId, form._id, form.publishedVersion) : null;
  const now = Date.now();
  await ctx.db.patch(form._id, { draft, draftRevision: form.draftRevision + 1, draftSavedAt: now, draftSavedBy: actorName(ctx), draftDiffers: !published || canonical(published.definition) !== canonical(draft), updatedAt: now });
  return { ok: true as const, revision: form.draftRevision + 1, unchanged: false };
}

/** Saves the draft. A stale revision is refused unless the person chose to save over the newer one. */
export const saveDraft = managerMutation({
  args: { formId: v.id("applicationForms"), expectedRevision: v.number(), definition: formDefinitionValidator, force: v.optional(v.boolean()) },
  handler: async (ctx, args) => writeDraft(ctx, await owned(ctx, args.formId), args.definition, args.expectedRevision, args.force),
});

async function publishDefinition(ctx: MutationCtx & MemberAccess, form: Doc<"applicationForms">, definition: FormDefinition, note: string | undefined, restoredFrom?: number) {
  const def = normalizeForm(definition);
  const latest = await ctx.db
    .query("applicationFormVersions")
    .withIndex("by_company_form_version", (q) => q.eq("companyId", ctx.companyId).eq("formId", form._id))
    .order("desc")
    .first();
  const version = (latest?.version ?? 0) + 1;
  const now = Date.now();
  await ctx.db.insert("applicationFormVersions", { companyId: ctx.companyId, formId: form._id, version, definition: def, hash: sha256(canonical(def)), ...(note?.trim() ? { note: note.trim().slice(0, 300) } : {}), ...(restoredFrom !== undefined ? { restoredFrom } : {}), publishedBy: ctx.member._id, publishedAt: now });
  await ctx.db.patch(form._id, { publishedVersion: version, publishedAt: now, draftDiffers: canonical(form.draft) !== canonical(def), updatedAt: now });
  await recordEvent(ctx, { companyId: ctx.companyId, type: restoredFrom !== undefined ? "application_form.rolled_back" : "application_form.published", actor: byMember(ctx), subject: { table: "applicationForms", id: form._id }, data: { version, ...(restoredFrom !== undefined ? { from: restoredFrom } : {}) } });
  return { version };
}

/** Publishes the draft as a new version. Applicants already filling in the form keep the version they started on. */
export const publish = ownerMutation({
  args: { formId: v.id("applicationForms"), expectedRevision: v.number(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const form = await owned(ctx, args.formId);
    if (form.draftRevision !== args.expectedRevision) throw userError(`${STALE_FORM} Review the latest before publishing.`);
    if (form.archivedAt !== undefined) throw userError("Restore this form before publishing it.");
    return publishDefinition(ctx, form, form.draft, args.note);
  },
});

/** Publishes an earlier version again, as a new version. */
export const rollback = ownerMutation({
  args: { formId: v.id("applicationForms"), version: v.number() },
  handler: async (ctx, args) => {
    const form = await owned(ctx, args.formId);
    if (form.archivedAt !== undefined) throw userError("Restore this form before publishing it.");
    const row = await versionOf(ctx, ctx.companyId, form._id, args.version);
    if (!row) throw userError("That version doesn't exist.");
    return publishDefinition(ctx, form, row.definition, `Restored version ${args.version}.`, args.version);
  },
});

/** Copies an earlier version into the draft, to edit before publishing. */
export const restoreToDraft = managerMutation({
  args: { formId: v.id("applicationForms"), version: v.number(), expectedRevision: v.number() },
  handler: async (ctx, args) => {
    const form = await owned(ctx, args.formId);
    const row = await versionOf(ctx, ctx.companyId, form._id, args.version);
    if (!row) throw userError("That version doesn't exist.");
    return writeDraft(ctx, form, row.definition, args.expectedRevision);
  },
});

/** The form every role without its own form uses. */
export const setDefault = ownerMutation({
  args: { formId: v.id("applicationForms") },
  handler: async (ctx, args) => {
    const form = await owned(ctx, args.formId);
    if (form.archivedAt !== undefined) throw userError("Restore this form first.");
    if (form.publishedVersion === undefined) throw userError("Publish this form before making it the default.");
    for (const other of await companyForms(ctx, ctx.companyId)) if (other.isDefault && other._id !== form._id) await ctx.db.patch(other._id, { isDefault: false, updatedAt: Date.now() });
    await ctx.db.patch(form._id, { isDefault: true, updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "application_form.made_default", actor: byMember(ctx), subject: { table: "applicationForms", id: form._id } });
    return null;
  },
});

/** Archives a form, or brings it back. Roles that used it fall back to the default form; applicants already filling it in are not affected. */
export const archive = ownerMutation({
  args: { formId: v.id("applicationForms"), archived: v.boolean() },
  handler: async (ctx, args) => {
    const form = await owned(ctx, args.formId);
    const now = Date.now();
    if (args.archived && form.isDefault) throw userError("This is the default form. Make another form the default first.");
    if (args.archived) {
      for (const role of await rolesOf(ctx, ctx.companyId)) if (role.formId === form._id) await ctx.db.patch(role._id, { formId: undefined });
    }
    await ctx.db.patch(form._id, args.archived ? { archivedAt: now, updatedAt: now } : { archivedAt: undefined, updatedAt: now });
    await recordEvent(ctx, { companyId: ctx.companyId, type: args.archived ? "application_form.archived" : "application_form.restored", actor: byMember(ctx), subject: { table: "applicationForms", id: form._id } });
    return null;
  },
});
