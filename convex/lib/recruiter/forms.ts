/**
 * Which form an applicant answers. A role's own form, else the company's default form, else the original
 * short form. A form is used only once it is published, and an applicant keeps the version they started
 * on: changing the form never changes what someone already answered.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { bookingSettingsOf } from "../booking/settings";
import { fill, upgradeForm, type FormDefinition } from "./formDefinition";
import { fieldsFor, sectionsFor, type Field, type Section } from "./form";
import { classicForm } from "./formTemplates";
import type { Source } from "./schema";
import { customInvitationEmail, invitationEmail } from "./words";

type Ctx = QueryCtx | MutationCtx;
export type FormPin = { formId: Id<"applicationForms">; version: number };
export type ResolvedForm = { definition: FormDefinition; pin: FormPin | null };

export async function versionOf(ctx: Ctx, companyId: Id<"companies">, formId: Id<"applicationForms">, version: number): Promise<Doc<"applicationFormVersions"> | null> {
  return ctx.db
    .query("applicationFormVersions")
    .withIndex("by_company_form_version", (q) => q.eq("companyId", companyId).eq("formId", formId).eq("version", version))
    .unique();
}

export async function companyForms(ctx: Ctx, companyId: Id<"companies">): Promise<Doc<"applicationForms">[]> {
  return ctx.db
    .query("applicationForms")
    .withIndex("by_company_updated", (q) => q.eq("companyId", companyId))
    .order("desc")
    .take(100);
}

const usable = (form: Doc<"applicationForms"> | null): form is Doc<"applicationForms"> & { publishedVersion: number } => Boolean(form && form.publishedVersion !== undefined && form.archivedAt === undefined);

/** The published form a new applicant for this role answers, and the version to keep them on. */
export async function formForNeed(ctx: Ctx, need: Pick<Doc<"hiringNeeds">, "companyId" | "formId">): Promise<ResolvedForm> {
  let form = need.formId ? await ctx.db.get(need.formId) : null;
  if (form && form.companyId !== need.companyId) form = null;
  if (!usable(form)) form = (await companyForms(ctx, need.companyId)).find((row) => row.isDefault && usable(row)) ?? null;
  if (usable(form)) {
    const row = await versionOf(ctx, need.companyId, form._id, form.publishedVersion);
    if (row) return { definition: upgradeForm(row.definition), pin: { formId: form._id, version: row.version } };
  }
  return { definition: classicForm(), pin: null };
}

/** The form an application is answered on: the version its session started on, or what a new one would get. */
export async function formForApplication(ctx: Ctx, need: Pick<Doc<"hiringNeeds">, "companyId" | "formId">, session: Pick<Doc<"formSessions">, "form"> | null): Promise<ResolvedForm> {
  if (!session) return formForNeed(ctx, need);
  if (!session.form) return { definition: classicForm(), pin: null };
  const row = await versionOf(ctx, need.companyId, session.form.formId, session.form.version);
  return row ? { definition: upgradeForm(row.definition), pin: session.form } : { definition: classicForm(), pin: null };
}

export async function sessionOf(ctx: Ctx, application: Pick<Doc<"applications">, "_id" | "companyId">): Promise<Doc<"formSessions"> | null> {
  return ctx.db
    .query("formSessions")
    .withIndex("by_company_application", (q) => q.eq("companyId", application.companyId).eq("applicationId", application._id))
    .first();
}

/** An application's fields, from the version its session is on. */
export async function applicationFields(ctx: Ctx, application: Pick<Doc<"applications">, "_id" | "companyId">, need: Doc<"hiringNeeds">, company?: string): Promise<{ fields: Field[]; sections: Section[]; definition: FormDefinition; pin: FormPin | null }> {
  const resolved = await formForApplication(ctx, need, await sessionOf(ctx, application));
  return { ...resolved, fields: fieldsFor(resolved.definition, need, company), sections: sectionsFor(resolved.definition, need) };
}

/** The email that carries the application link: the role's form's own words when it has them, else Recruiter's. */
export async function invitationWords(ctx: Ctx, need: Pick<Doc<"hiringNeeds">, "companyId" | "formId">, parts: Parameters<typeof customInvitationEmail>[0], source: Source): Promise<{ subject: string; body: string }> {
  const own = (await formForNeed(ctx, need)).definition.invitation;
  return own.subject && own.body ? customInvitationEmail(parts, own) : invitationEmail({ ...parts, source });
}

/** How the page looks: the form's words with the role and company filled in, and the company's brand when the form uses it. */
export async function presentation(ctx: Ctx, company: Doc<"companies">, definition: FormDefinition, role: string) {
  const settings = await bookingSettingsOf(ctx, company);
  const values = { role, company: settings.profile.displayName || company.name };
  const logoUrl = definition.theme.showLogo && settings.profile.logo ? await ctx.storage.getUrl(settings.profile.logo) : null;
  return {
    display: definition.display,
    accentColor: definition.theme.useCompanyBrand ? settings.profile.brandColor : definition.theme.accentColor,
    logoUrl,
    companyName: values.company,
    copy: {
      title: fill(definition.copy.title, values),
      intro: fill(definition.copy.intro, values),
      submitLabel: definition.copy.submitLabel,
      thankYouTitle: fill(definition.copy.thankYouTitle, values),
      thankYouBody: fill(definition.copy.thankYouBody, values),
    },
  };
}
export type Presentation = Awaited<ReturnType<typeof presentation>>;
