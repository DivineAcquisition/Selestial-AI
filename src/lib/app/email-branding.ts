/**
 * The Email branding form (Settings › Email & texting › Email branding), as plain data: what the page
 * edits, how it becomes what the server saves, and how it becomes the branding the preview renders.
 * The preview runs the same resolver and renderer as real sends (convex/lib/email/branding.ts,
 * convex/lib/email/templates/company.ts), so what the Owner sees is what customers get.
 */
import { DEFAULT_SAVED, problemsOf, type Align, type HeaderStyle, type Layout, type LogoSource, type SavedBranding } from "../../../convex/lib/email/branding";
import type { Id } from "../../../convex/_generated/dataModel";

/** Every text field is a string; empty means "use the company's own detail". */
export type BrandingDraft = {
  senderName: string;
  logoSource: LogoSource;
  logo: Id<"_storage"> | null;
  logoUrl: string | null;
  accent: string;
  button: string;
  header: HeaderStyle;
  layout: Layout;
  logoAlign: Align;
  signature: { include: boolean; name: string; closing: string; phone: string; website: string; address: string; supportEmail: string; showAddress: boolean };
};

export type SavedChoices = {
  senderName?: string;
  logoSource: LogoSource;
  logo?: Id<"_storage">;
  logoUrl?: string | null;
  accent?: string;
  button?: string;
  header: HeaderStyle;
  layout: Layout;
  logoAlign: Align;
  signature: { include: boolean; name?: string; closing?: string; phone?: string; website?: string; address?: string; supportEmail?: string; showAddress: boolean };
};

export function draftFrom(saved: SavedChoices | null): BrandingDraft {
  const s = saved ?? { ...DEFAULT_SAVED, signature: { ...DEFAULT_SAVED.signature } };
  const sig = s.signature;
  return {
    senderName: s.senderName ?? "",
    logoSource: s.logoSource,
    logo: ("logo" in s ? s.logo : undefined) ?? null,
    logoUrl: ("logoUrl" in s ? s.logoUrl : null) ?? null,
    accent: s.accent ?? "",
    button: s.button ?? "",
    header: s.header,
    layout: s.layout,
    logoAlign: s.logoAlign,
    signature: { include: sig.include, name: sig.name ?? "", closing: sig.closing ?? "", phone: sig.phone ?? "", website: sig.website ?? "", address: sig.address ?? "", supportEmail: sig.supportEmail ?? "", showAddress: sig.showAddress },
  };
}

const opt = (value: string) => (value.trim() ? value.trim() : undefined);

/** What the server's `save` takes. The logo's address is the server's to work out. */
export function choicesFrom(draft: BrandingDraft) {
  const s = draft.signature;
  return {
    senderName: opt(draft.senderName),
    logoSource: draft.logoSource,
    ...(draft.logoSource === "custom" && draft.logo ? { logo: draft.logo } : {}),
    accent: opt(draft.accent),
    button: opt(draft.button),
    header: draft.header,
    layout: draft.layout,
    logoAlign: draft.logoAlign,
    signature: { include: s.include, showAddress: s.showAddress, name: opt(s.name), closing: opt(s.closing), phone: opt(s.phone), website: opt(s.website), address: opt(s.address), supportEmail: opt(s.supportEmail) },
  };
}

/** The draft as the resolver reads it, for the live preview. */
export function savedFrom(draft: BrandingDraft): SavedBranding {
  const c = choicesFrom(draft);
  return { ...c, logoUrl: draft.logoSource === "custom" ? draft.logoUrl : null };
}

/** The draft's problems, in the same words the server would refuse it with. */
export function draftProblems(draft: BrandingDraft): string[] {
  return problemsOf(savedFrom(draft));
}

/** Appearance back to the company's own details. Sender, replies and signature are left as they are. */
export function resetAppearance(draft: BrandingDraft): BrandingDraft {
  return { ...draft, logoSource: "company", logo: null, logoUrl: null, accent: "", button: "", header: DEFAULT_SAVED.header, layout: DEFAULT_SAVED.layout, logoAlign: DEFAULT_SAVED.logoAlign };
}

/** True when the appearance already matches the company's defaults. */
export function appearanceIsDefault(draft: BrandingDraft): boolean {
  return JSON.stringify(resetAppearance(draft)) === JSON.stringify(draft);
}
