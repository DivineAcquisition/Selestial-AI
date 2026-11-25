/**
 * Email branding (Settings › Email & texting › Email branding): how a company's email looks when Selestial
 * sends it from the shared sending domain. Pure: no Convex, no Node, so the settings page's preview, the
 * test email and every real send resolve and render a company's branding with exactly the same code.
 *
 * What a company can choose is curated on purpose: a sender name, a logo, two colours, a header treatment,
 * one of three layouts, logo alignment, and a short signature. Nothing it chooses can add markup, styles,
 * scripts, images other than its own logo, or change what a message says. The footer's reason, "sent via
 * Selestial" and any unsubscribe link stay where the messaging rules put them.
 */
import { contrastRatio, oneLine, TOKENS, webAddress } from "./kit";

// ── Choices ─────────────────────────────────────────────────────────────────────────────────────

export const LAYOUTS = ["classic", "banner", "letter"] as const;
export type Layout = (typeof LAYOUTS)[number];
export const HEADERS = ["light", "dark"] as const;
export type HeaderStyle = (typeof HEADERS)[number];
export const ALIGNS = ["left", "center"] as const;
export type Align = (typeof ALIGNS)[number];
export const LOGO_SOURCES = ["company", "custom", "none"] as const;
export type LogoSource = (typeof LOGO_SOURCES)[number];

export const LAYOUT_WORDS: Record<Layout, { label: string; detail: string }> = {
  classic: { label: "Classic", detail: "Your logo above a clean white card." },
  banner: { label: "Banner", detail: "Your logo in a band across the top of the card." },
  letter: { label: "Letter", detail: "Simple and personal, like a note from your office." },
};

/** What the Owner saved. A missing value means "use the company's own detail". */
export type SavedBranding = {
  senderName?: string;
  logoSource: LogoSource;
  /** The custom logo's public address, when logoSource is "custom". */
  logoUrl?: string | null;
  accent?: string;
  button?: string;
  header: HeaderStyle;
  layout: Layout;
  logoAlign: Align;
  signature: {
    include: boolean;
    name?: string;
    closing?: string;
    phone?: string;
    website?: string;
    address?: string;
    supportEmail?: string;
    showAddress: boolean;
  };
};

/** The company's own details, which branding starts from. */
export type CompanyDefaults = {
  companyName: string;
  logoUrl: string | null;
  brandColor: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  supportEmail: string | null;
};

export const DEFAULT_SAVED: SavedBranding = {
  logoSource: "company",
  header: "light",
  layout: "classic",
  logoAlign: "left",
  signature: { include: true, showAddress: true },
};

/**
 * What a send actually uses, every value settled. Stored with each version so a retried message renders
 * exactly as its first attempt did, whatever the Owner changed since.
 */
export type ResolvedBranding = {
  companyName: string;
  senderName: string;
  logoUrl: string | null;
  /** Readable on white and under white text: checked, or Selestial's default. */
  accent: string;
  button: string;
  header: HeaderStyle;
  layout: Layout;
  logoAlign: Align;
  signature: {
    include: boolean;
    name: string | null;
    closing: string | null;
    phone: string | null;
    website: string | null;
    supportEmail: string | null;
  };
  /** The footer's address line, when the company has one and shows it. */
  address: string | null;
};

// ── Checks ──────────────────────────────────────────────────────────────────────────────────────

const HEX = /^#[0-9a-f]{6}$/i;
const EMAIL = /^[^\s@<>"(),;:]+@([a-z0-9-]+\.)+[a-z]{2,}$/i;
const PROMO = /\b(\d+\s?%\s?off|discount|promo(tion)?|coupon|sale|deal|free gift|limited time|special offer|refer a friend)\b/i;

/** White on the colour, and the colour on white, are both readable (WCAG AA for body text). */
export function readableColor(hex: string): boolean {
  return HEX.test(hex) && contrastRatio(hex, "#FFFFFF") >= 4.5;
}

/** A hex colour, or the reason it can't be used. */
export function checkColor(value: string, what: string): string | null {
  const hex = value.trim();
  if (!HEX.test(hex)) return `${what} must be a colour like #1F6FEB.`;
  if (!readableColor(hex)) return `${what} is too light: white text on it, and links in it, would be hard to read. Choose a darker shade.`;
  return null;
}

/**
 * The sender's display name: one line, no characters that could break or forge the From header, and
 * nothing that would read as Selestial or as an address.
 */
export function checkSenderName(value: string): string | null {
  if (/[\r\n\t]/.test(value)) return "The sender name must be on one line.";
  const name = value.trim();
  if (name.length < 2) return "Enter the name customers should see, at least 2 characters.";
  if (name.length > 60) return "Keep the sender name to 60 characters or fewer.";
  if (/["<>\\@;]/.test(name)) return 'The sender name can\'t contain quotes, angle brackets, backslashes, semicolons or "@".';
  if (/selestial/i.test(name)) return "The sender name should be your business's name, not Selestial's.";
  if (/https?:|www\./i.test(name)) return "The sender name can't be a web address.";
  return null;
}

/** A short line that appears above the signature: plain words only, no links, no offers. */
export function checkClosing(value: string): string | null {
  const line = value.trim();
  if (!line) return null;
  if (/[\r\n]/.test(value)) return "Keep the closing line on one line.";
  if (line.length > 80) return "Keep the closing line to 80 characters or fewer.";
  if (/https?:|www\.|@/.test(line)) return "The closing line can't hold links or addresses. Use the website and support fields.";
  if (PROMO.test(line)) return "The closing line appears on every email, including invoices and reminders, so it can't carry offers or promotions.";
  return null;
}

export function checkWebsite(value: string): string | null {
  const url = value.trim();
  if (!url) return null;
  const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  if (!webAddress(full) || !/^https?:\/\/([a-z0-9-]+\.)+[a-z]{2,}(\/[^\s]*)?$/i.test(full)) return "Enter a website like https://yourcompany.com.";
  if (full.length > 120) return "Keep the website address under 120 characters.";
  return null;
}

/** "yourcompany.com" becomes "https://yourcompany.com". Assumes checkWebsite passed. */
export function normalWebsite(value: string): string {
  const url = value.trim();
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export function checkEmail(value: string, what: string): string | null {
  const email = value.trim();
  if (!email) return null;
  return EMAIL.test(email) && email.length <= 254 ? null : `${what} must be an email address like office@yourcompany.com.`;
}

export function checkPhone(value: string): string | null {
  const phone = value.trim();
  if (!phone) return null;
  if (!/^[+()\d][\d\s().+-]{6,24}$/.test(phone) || (phone.match(/\d/g) ?? []).length < 7) return "Enter a phone number like (415) 555-0134.";
  return null;
}

function checkLine(value: string | undefined, what: string, max: number): string | null {
  if (value === undefined) return null;
  if (/[\r\n]/.test(value)) return `${what} must be on one line.`;
  if (value.trim().length > max) return `Keep ${what.toLowerCase()} to ${max} characters or fewer.`;
  if (/[<>]/.test(value)) return `${what} can't contain angle brackets.`;
  return null;
}

/** Every problem with a draft, in the words the page shows. Empty means it can be saved. */
export function problemsOf(saved: SavedBranding): string[] {
  const s = saved.signature;
  return [
    saved.senderName !== undefined ? checkSenderName(saved.senderName) : null,
    saved.accent !== undefined ? checkColor(saved.accent, "The accent colour") : null,
    saved.button !== undefined ? checkColor(saved.button, "The button colour") : null,
    saved.logoSource === "custom" && !webAddress(saved.logoUrl) ? "Upload a logo, or choose to use your company logo." : null,
    checkLine(s.name, "The signature name", 60),
    s.closing !== undefined ? checkClosing(s.closing) : null,
    s.phone !== undefined ? checkPhone(s.phone) : null,
    s.website !== undefined ? checkWebsite(s.website) : null,
    checkLine(s.address, "The business address", 140),
    s.supportEmail !== undefined ? checkEmail(s.supportEmail, "The support email") : null,
  ].filter((p): p is string => p !== null);
}

// ── Resolving ───────────────────────────────────────────────────────────────────────────────────

const blank = (value: string | null | undefined) => {
  const line = oneLine(value ?? "");
  return line ? line : null;
};

/** A colour to use: the chosen one if readable, then the company's own if readable, then Selestial's. */
function colorOf(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) if (c && readableColor(c.trim())) return c.trim().toUpperCase();
  return TOKENS.violet;
}

/** The branding a send uses: what the Owner saved over the company's own details, every value settled. */
export function resolveBranding(saved: SavedBranding | null, defaults: CompanyDefaults): ResolvedBranding {
  const b = saved ?? DEFAULT_SAVED;
  const s = b.signature;
  const accent = colorOf(b.accent, defaults.brandColor);
  const website = blank(s.website) ?? blank(defaults.website);
  return {
    companyName: oneLine(defaults.companyName),
    senderName: blank(b.senderName) ?? oneLine(defaults.companyName),
    logoUrl: b.logoSource === "none" ? null : b.logoSource === "custom" ? (webAddress(b.logoUrl) ?? webAddress(defaults.logoUrl)) : webAddress(defaults.logoUrl),
    accent,
    button: colorOf(b.button, accent),
    header: b.header,
    layout: b.layout,
    logoAlign: b.logoAlign,
    signature: {
      include: s.include,
      name: blank(s.name),
      closing: blank(s.closing),
      phone: blank(s.phone) ?? blank(defaults.phone),
      website: website && webAddress(normalWebsite(website)) ? normalWebsite(website) : null,
      supportEmail: blank(s.supportEmail) ?? blank(defaults.supportEmail),
    },
    address: s.showAddress ? (blank(s.address) ?? blank(defaults.address)) : null,
  };
}

// ── The sending address ─────────────────────────────────────────────────────────────────────────

/**
 * Local parts no company may hold: the mailbox names mail systems and people expect to belong to the
 * domain's owner, Selestial's own, and generic names that would read as nobody in particular.
 */
export const RESERVED_LOCALS: ReadonlySet<string> = new Set([
  "abuse", "admin", "administrator", "billing", "bounce", "bounces", "careers", "compliance", "contact", "dmarc", "help",
  "hello", "hostmaster", "info", "legal", "mail", "mailer-daemon", "marketing", "messages", "news", "newsletter",
  "no-reply", "noreply", "notifications", "notify", "office", "payments", "postmaster", "privacy", "receipts", "reply",
  "root", "sales", "security", "selestial", "send", "service", "support", "system", "team", "test", "updates", "webmaster",
]);

/** The address's local part a company name suggests: lower case letters, digits and single hyphens, 3–40 long. */
export function aliasBase(companyName: string): string {
  const slug = companyName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const base = slug.length >= 3 ? slug : `${slug || "company"}-mail`.replace(/^-/, "");
  return RESERVED_LOCALS.has(base) || /selestial/.test(base) ? `${base.replace(/selestial/g, "co")}-team` : base;
}

/** The candidates in order: the base, then base-2, base-3… Each is checked against what's taken. */
export function aliasCandidate(base: string, attempt: number): string {
  if (attempt <= 1) return base;
  const suffix = `-${attempt}`;
  return `${base.slice(0, 40 - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

/** True for a local part this code could have made. Anything else is never used as a From. */
export function isAliasShape(local: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(local) && !local.includes("--") && !RESERVED_LOCALS.has(local);
}
