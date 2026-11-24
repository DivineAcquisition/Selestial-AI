/**
 * What business configuration prepares for each kind of cleaning company. Pure: no Convex, so the setup
 * screens, the generators and the tests read the same lists.
 *
 * Only services relevant to what the owner said they clean are offered, and only the ones they pick are
 * prepared. When they haven't picked, a small default set for each category is prepared, never the whole
 * template library.
 */
import type { Category } from "../services/spec";
import type { StandardTemplate } from "../quality/schema";
import type { ExperienceKind } from "../booking/definition";

export type OfferChoice = { templateId: string; label: string; hint: string; assessment?: boolean };

/** The services an owner can pick, by what they clean. Template ids are in lib/services/templates.ts. */
export const OFFER_CHOICES: Record<Category, OfferChoice[]> = {
  residential: [
    { templateId: "res-standard", label: "Standard home cleaning", hint: "Regular upkeep, priced by bedrooms and bathrooms" },
    { templateId: "res-deep", label: "Deep cleaning", hint: "A top-to-bottom first or seasonal clean" },
    { templateId: "res-move", label: "Move-in / move-out cleaning", hint: "Empty homes before or after a move" },
    { templateId: "res-recurring", label: "Recurring cleaning plan", hint: "Weekly, every two weeks or monthly" },
  ],
  commercial: [
    { templateId: "com-office", label: "Office cleaning", hint: "Recurring, priced by area; large sites get a walkthrough" },
    { templateId: "com-retail", label: "Retail store cleaning", hint: "Priced by area" },
    { templateId: "com-common", label: "Common-area cleaning", hint: "Lobbies, halls and stairs, priced by floor" },
    { templateId: "com-warehouse", label: "Warehouse or industrial cleaning", hint: "Quoted after a site assessment", assessment: true },
  ],
  short_term_rental: [
    { templateId: "str-turnover", label: "Turnover cleaning", hint: "Between guests, with checkout and check-in times" },
    { templateId: "str-linen", label: "Linen and laundry", hint: "Priced per load" },
    { templateId: "str-restock", label: "Restocking", hint: "Guest supplies refilled" },
    { templateId: "str-deep", label: "Periodic deep clean", hint: "A deeper clean between turnovers" },
  ],
  property_management: [
    { templateId: "pm-vacant", label: "Vacant-unit turnover", hint: "Quoted per unit after seeing it", assessment: true },
    { templateId: "pm-multi", label: "Multi-property services", hint: "Priced per unit" },
    { templateId: "pm-common", label: "Community common areas", hint: "Priced by crew hour" },
  ],
  post_construction: [
    { templateId: "pc-rough", label: "Post-construction rough clean", hint: "Priced by area" },
    { templateId: "pc-final", label: "Post-construction final clean", hint: "Priced by area" },
    { templateId: "pc-touchup", label: "Touch-up visit", hint: "Priced by crew hour" },
  ],
  specialty: [
    { templateId: "sp-windows", label: "Window cleaning", hint: "Priced per window" },
    { templateId: "sp-carpet", label: "Carpet and upholstery", hint: "Priced per room" },
    { templateId: "sp-floor", label: "Floor care (strip and wax)", hint: "Priced by area" },
    { templateId: "sp-event", label: "Event cleanup", hint: "Priced by crew hour" },
  ],
};

/** Prepared when the owner said what they clean but didn't pick services: the common core of each category. */
export const DEFAULT_OFFER: Record<Category, string[]> = {
  residential: ["res-standard", "res-deep", "res-move"],
  commercial: ["com-office"],
  short_term_rental: ["str-turnover"],
  property_management: ["pm-vacant"],
  post_construction: ["pc-final"],
  specialty: ["sp-windows"],
};

export const isCategory = (value: string): value is Category => value in OFFER_CHOICES;

export function choiceFor(templateId: string): (OfferChoice & { category: Category }) | null {
  for (const [category, choices] of Object.entries(OFFER_CHOICES) as [Category, OfferChoice[]][]) {
    const found = choices.find((choice) => choice.templateId === templateId);
    if (found) return { ...found, category };
  }
  return null;
}

/**
 * The services to prepare: the owner's own picks when they made any (kept only if they fit what they
 * clean), otherwise each category's defaults. In the catalog's order, never repeated.
 */
export function servicesToPrepare(categories: string[], offered: string[]): string[] {
  const kinds = categories.filter(isCategory);
  const order = kinds.flatMap((category) => OFFER_CHOICES[category].map((choice) => choice.templateId));
  const picked = offered.filter((id) => order.includes(id));
  const chosen = picked.length ? picked : kinds.flatMap((category) => DEFAULT_OFFER[category]);
  return order.filter((id) => chosen.includes(id));
}

// ── Booking ─────────────────────────────────────────────────────────────────────────────────────

export type BookingMode = "instant" | "estimate_request" | "walkthrough_request";

/** The booking page each category belongs on. Property management, construction and specialty work is commercial. */
export const PAGE_FOR: Record<Category, Exclude<ExperienceKind, "recurring" | "campaign">> = {
  residential: "residential",
  commercial: "commercial",
  short_term_rental: "short_term_rental",
  property_management: "commercial",
  post_construction: "commercial",
  specialty: "residential",
};

/**
 * What customers can do on a page, chosen honestly:
 * - a page whose services are all quoted after an assessment schedules a walkthrough;
 * - commercial work asks for a walkthrough;
 * - without a price the owner has set or confirmed (they quote every job, or are still working it out and
 *   gave no costs), customers request an estimate;
 * - otherwise customers can book instantly, once the owner has published the services and the page.
 */
export function modeFor(page: Exclude<ExperienceKind, "recurring" | "campaign">, templates: string[], priced: boolean): { mode: BookingMode; why: string } {
  const choices = templates.map((id) => choiceFor(id)).filter((choice) => choice !== null);
  if (choices.length > 0 && choices.every((choice) => choice.assessment)) return { mode: "walkthrough_request", why: "These services are quoted after you see the site, so customers ask for a walkthrough." };
  if (page === "commercial") return { mode: "walkthrough_request", why: "Commercial work is usually priced after a walkthrough, so customers ask for one." };
  if (!priced) return { mode: "estimate_request", why: "You haven't set prices yet, so customers request an estimate instead of booking a price." };
  return { mode: "instant", why: "Customers can book and pay a firm price, once you approve the prices and publish the services and this page." };
}

// ── Agreements and standards ────────────────────────────────────────────────────────────────────

/** The agreement template that fits each service. Several services can share one. */
export const AGREEMENT_FOR: Record<string, string> = {
  "res-standard": "one_time_residential",
  "res-recurring": "recurring_residential",
  "res-deep": "deep_cleaning",
  "res-move": "move_in_out",
  "com-office": "office_janitorial",
  "com-retail": "commercial_msa",
  "com-common": "commercial_msa",
  "com-warehouse": "commercial_msa",
  "str-turnover": "str_turnover",
  "str-linen": "str_turnover",
  "str-restock": "str_turnover",
  "str-deep": "str_turnover",
  "pm-vacant": "property_management",
  "pm-multi": "property_management",
  "pm-common": "property_management",
  "pc-rough": "post_construction",
  "pc-final": "post_construction",
  "pc-touchup": "post_construction",
  "sp-windows": "specialty_cleaning",
  "sp-carpet": "specialty_cleaning",
  "sp-floor": "specialty_cleaning",
  "sp-event": "specialty_cleaning",
};

export function agreementsFor(templates: string[]): string[] {
  return [...new Set(templates.map((id) => AGREEMENT_FOR[id]).filter(Boolean))];
}

/** The quality standard that fits each service, when one exists. */
export const STANDARD_FOR: Record<string, StandardTemplate> = {
  "res-standard": "residential_one_time",
  "res-recurring": "residential_recurring",
  "res-deep": "deep_move_out",
  "res-move": "deep_move_out",
  "com-office": "office",
  "com-retail": "commercial",
  "com-common": "commercial",
  "com-warehouse": "commercial",
  "str-turnover": "str_turnover",
  "str-deep": "str_turnover",
};

export function standardsFor(templates: string[]): StandardTemplate[] {
  return [...new Set(templates.map((id) => STANDARD_FOR[id]).filter(Boolean))];
}
