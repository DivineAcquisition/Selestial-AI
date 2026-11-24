/**
 * Services & Pricing, as the screens know it: its routes, its tools, the editor's sections, and small helpers
 * for reading money people type. The record and every rule live in convex/lib/services.
 */

export const SERVICES_ROOT = "/app/services";

/**
 * The tools that used to be tabs. They open from the workspace's More menu, or from the service they
 * concern; their own addresses still work, so old links and bookmarks land where they did.
 */
export const SERVICES_TOOLS = [
  { id: "studio", label: "Compare example jobs", href: `${SERVICES_ROOT}/studio`, blurb: "Price sample jobs across services, side by side." },
  { id: "research", label: "Market research", href: `${SERVICES_ROOT}/research`, blurb: "Local prices with their sources and dates." },
  { id: "setup", label: "Costs and pricing setup", href: `${SERVICES_ROOT}/setup`, blurb: "Your pay, supplies and margin, for profit checks.", ownerOnly: true },
  { id: "changes", label: "Review history", href: `${SERVICES_ROOT}/changes`, blurb: "Every change submitted, approved and published." },
] as const;

export const servicePath = (serviceId: string) => `${SERVICES_ROOT}/${serviceId}`;
export const changePath = (changeId: string) => `${SERVICES_ROOT}/changes/${changeId}`;
export const briefPath = (briefId: string) => `${SERVICES_ROOT}/research/${briefId}`;
export const importPath = (importId: string) => `${SERVICES_ROOT}/imports/${importId}`;
export const REVIEW_ALL_PATH = `${SERVICES_ROOT}/review`;

/**
 * The service editor's three sections, on one page. Every amount sits beside its unit; less common
 * settings stay folded under More options until they are wanted.
 */
export const EDITOR_SECTIONS = [
  { id: "service", label: "Service & scope", blurb: "Name, kind of work, what customers read, and what is and isn't included." },
  { id: "price", label: "Price", blurb: "How it is priced, with the unit beside every amount, and any extras." },
  { id: "booking", label: "Booking & team", blurb: "Crew, time, skills, questions and when a walkthrough is needed." },
] as const;
export type EditorSection = (typeof EDITOR_SECTIONS)[number]["id"];

/** Where a check's field is edited. The old wizard's step names (saved on drafts) map the same way. */
export function sectionOf(field: string | null | undefined): EditorSection | "review" {
  const f = field ?? "";
  if (f === "name" || f === "summary" || f === "basics" || f === "scope" || f.startsWith("included") || f.startsWith("excluded") || f === "category" || f === "visitWord") return "service";
  if (f === "pricing" || f === "extras" || f.startsWith("pricing") || f.startsWith("addOns") || f.startsWith("modifiers")) return "price";
  if (f === "team" || f.startsWith("team") || f.startsWith("requirements") || f.startsWith("str") || f.startsWith("questions") || f.startsWith("walkthrough")) return "booking";
  return "review";
}

/** "12.50", "$1,200" or "120" to cents, or null when it is not an amount. */
export function centsFrom(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** A rate per square foot or meter, to millicents: "0.085" is 8500. */
export function millicentsFrom(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,5})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 100_000 + Number(fraction.padEnd(5, "0"));
}

export const dollarsText = (cents: number) => (cents / 100).toFixed(2);
export const rateText = (millicents: number) => (millicents / 100_000).toFixed(5).replace(/0{1,3}$/, "");

/** A short id for a new list item: unique within the list it joins. */
export function newId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "item";
  let id = stem;
  for (let i = 2; used.has(id); i += 1) id = `${stem}-${i}`;
  return id;
}

export const CHANGE_STATE_WORDS: Record<string, { label: string; tone: "info" | "warning" | "success" | "outline" | "error" }> = {
  in_review: { label: "In review", tone: "info" },
  approved: { label: "Approved", tone: "success" },
  scheduled: { label: "Scheduled", tone: "info" },
  published: { label: "Published", tone: "success" },
  returned: { label: "Returned to draft", tone: "warning" },
  withdrawn: { label: "Withdrawn", tone: "outline" },
  superseded: { label: "Replaced", tone: "outline" },
};
