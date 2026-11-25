/**
 * Reading and keeping a company's email branding (docs/email/06-branding.md): its defaults from the
 * company's own details, its sending address on the shared domain, and the versions sends point at.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { readProfile } from "../compliance/profile";
import { fingerprint } from "../messaging/fingerprint";
import { aliasBase, aliasCandidate, DEFAULT_SAVED, isAliasShape, resolveBranding, type CompanyDefaults, type ResolvedBranding, type SavedBranding } from "./branding";

type Ctx = QueryCtx | MutationCtx;

export async function brandingRow(ctx: Ctx, companyId: Id<"companies">): Promise<Doc<"emailBranding"> | null> {
  return ctx.db
    .query("emailBranding")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .first();
}

function postal(address: { line1: string; line2?: string; city: string; region: string; postalCode: string } | undefined): string | null {
  if (!address?.line1) return null;
  return [address.line1, address.line2, `${address.city}, ${address.region} ${address.postalCode}`].filter(Boolean).join(", ");
}

/**
 * Where branding starts: the company's own details. Its name; Booking's public profile (logo, colour,
 * phone, website, mailing address); and the support contact and address in Company profile.
 */
export async function companyDefaults(ctx: Ctx, company: Doc<"companies">): Promise<CompanyDefaults> {
  const booking = await ctx.db
    .query("bookingSettings")
    .withIndex("by_company", (q) => q.eq("companyId", company._id))
    .first();
  const profile = booking?.profile;
  const identity = (await readProfile(ctx, company._id)).identity;
  return {
    companyName: company.name,
    // Convex file addresses don't expire, so a logo in an email already sent keeps showing.
    logoUrl: profile?.logo ? await ctx.storage.getUrl(profile.logo) : null,
    brandColor: profile?.brandColor ?? null,
    phone: identity.supportPhone ?? profile?.phone ?? null,
    website: profile?.website ?? null,
    address: profile?.mailingAddress ?? postal(identity.address),
    supportEmail: identity.supportEmail ?? profile?.email ?? null,
  };
}

/** The saved choices as the resolver reads them, the custom logo turned into its address. */
export async function savedOf(ctx: Ctx, row: Doc<"emailBranding"> | null): Promise<SavedBranding | null> {
  if (!row) return null;
  const c = row.choices;
  return {
    ...DEFAULT_SAVED,
    senderName: c.senderName,
    logoSource: c.logoSource,
    logoUrl: c.logoSource === "custom" && c.logo ? await ctx.storage.getUrl(c.logo) : null,
    accent: c.accent,
    button: c.button,
    header: c.header,
    layout: c.layout,
    logoAlign: c.logoAlign,
    signature: c.signature,
  };
}

/** The branding a send would use right now. */
export async function currentBranding(ctx: Ctx, company: Doc<"companies">): Promise<{ row: Doc<"emailBranding"> | null; defaults: CompanyDefaults; resolved: ResolvedBranding }> {
  const row = await brandingRow(ctx, company._id);
  const defaults = await companyDefaults(ctx, company);
  return { row, defaults, resolved: resolveBranding(await savedOf(ctx, row), defaults) };
}

// ── The sending address ─────────────────────────────────────────────────────────────────────────

export async function senderLocal(ctx: Ctx, companyId: Id<"companies">): Promise<string | null> {
  const row = await ctx.db
    .query("emailSenderAddresses")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .first();
  return row?.local ?? null;
}

async function taken(ctx: Ctx, local: string): Promise<boolean> {
  const row = await ctx.db
    .query("emailSenderAddresses")
    .withIndex("by_local", (q) => q.eq("local", local))
    .first();
  return row !== null;
}

/** The first free local part for a name: base, base-2, base-3… Read only; nothing is reserved by asking. */
export async function freeLocal(ctx: Ctx, companyName: string): Promise<string> {
  const base = aliasBase(companyName);
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = aliasCandidate(base, attempt);
    if (isAliasShape(candidate) && !(await taken(ctx, candidate))) return candidate;
  }
  // Fifty companies with one name: a random tail, still checked.
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return aliasCandidate(base, 1000 + ((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) % 900000);
}

/**
 * The company's own address on the shared domain, assigned the first time it's needed and never changed
 * after, even when the company is renamed: customers' contacts and filters keep working. Inside one
 * mutation the free check and the insert are one transaction, so two companies can't get the same one.
 */
export async function ensureSenderLocal(ctx: MutationCtx, company: Doc<"companies">): Promise<string> {
  const existing = await senderLocal(ctx, company._id);
  if (existing) return existing;
  const local = await freeLocal(ctx, company.name);
  await ctx.db.insert("emailSenderAddresses", { companyId: company._id, local, createdAt: Date.now() });
  return local;
}

// ── Versions ────────────────────────────────────────────────────────────────────────────────────

function same(a: Doc<"emailBrandingVersions">, branding: ResolvedBranding, local: string, replyTo: string | null): boolean {
  return a.local === local && a.replyTo === replyTo && JSON.stringify(a.branding) === JSON.stringify(branding);
}

/**
 * The version a message's send uses. The first attempt settles it from the branding in force then and
 * writes it on the message; every retry, and any check with the provider, uses the same one. Saving new
 * branding later changes only messages that haven't been attempted yet. A version is never edited.
 */
export async function versionForSend(ctx: MutationCtx, message: Doc<"messages">, company: Doc<"companies">): Promise<Doc<"emailBrandingVersions">> {
  if (message.brandingVersionId) {
    const kept = await ctx.db.get(message.brandingVersionId);
    if (kept && kept.companyId === message.companyId) return kept;
  }
  const { row, resolved } = await currentBranding(ctx, company);
  const local = await ensureSenderLocal(ctx, company);
  const replyTo = row?.reply?.address ?? null;
  const hash = fingerprint(JSON.stringify({ resolved, local, replyTo }));
  const matches = await ctx.db
    .query("emailBrandingVersions")
    .withIndex("by_company_hash", (q) => q.eq("companyId", company._id).eq("hash", hash))
    .take(5);
  const found = matches.find((m) => same(m, resolved, local, replyTo));
  const versionId = found?._id ?? (await ctx.db.insert("emailBrandingVersions", { companyId: company._id, hash, branding: resolved, local, replyTo, revision: row?.revision ?? 0, createdAt: Date.now() }));
  await ctx.db.patch(message._id, { brandingVersionId: versionId });
  return found ?? (await ctx.db.get(versionId))!;
}

/**
 * Where replies go. A conversation's own routing address (a Sales reply address on the receiving domain)
 * and an address a workflow chose on purpose (Finance's reply address for invoices, the hiring inbox) are
 * kept. Otherwise the company's verified reply address replaces the generic fallbacks a workflow used
 * before branding existed (its support email, its booking page email), or fills an empty one.
 */
export function replyFor(stored: string | undefined, verified: string | null, generic: ReadonlySet<string>): string | undefined {
  const current = stored?.trim().toLowerCase() || undefined;
  if (!verified) return current;
  if (!current || generic.has(current)) return verified;
  return current;
}

/** The fallbacks workflows wrote as Reply-To before branding: replaced by a verified reply address. */
export async function genericReplies(ctx: Ctx, companyId: Id<"companies">): Promise<Set<string>> {
  const identity = (await readProfile(ctx, companyId)).identity;
  const booking = await ctx.db
    .query("bookingSettings")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .first();
  return new Set([identity.supportEmail, booking?.profile.email].filter((a): a is string => Boolean(a)).map((a) => a.trim().toLowerCase()));
}
