/**
 * What a Google Ads campaign draft must hold to become a whole search campaign: keywords, a responsive search ad
 * (headlines, descriptions, a landing page) and a service area. Pure, so the draft, the creating step and the
 * tests apply the same rules. Limits are Google's for responsive search ads.
 */
import type { Doc } from "../../_generated/dataModel";

/** A responsive search ad takes 3 to 15 headlines of up to 30 characters and 2 to 4 descriptions of up to 90. */
export const AD_LIMITS = { headlines: { min: 3, max: 15, chars: 30 }, descriptions: { min: 2, max: 4, chars: 90 }, keywords: { max: 50, chars: 80 } } as const;

/** Trimmed, non-empty, and each only once (ignoring case), in the order given. */
export const distinct = (values: (string | undefined)[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
};

type Copy = Pick<Doc<"googleAdDrafts">, "headline" | "description" | "headlines" | "descriptions">;

/** All of a draft's headlines and descriptions, the first ones included. */
export function draftCopy(draft: Copy) {
  return { headlines: distinct([draft.headline, ...(draft.headlines ?? [])]).slice(0, AD_LIMITS.headlines.max), descriptions: distinct([draft.description, ...(draft.descriptions ?? [])]).slice(0, AD_LIMITS.descriptions.max) };
}

/**
 * Why a draft cannot become a whole campaign, in words for the Owner, or null when it can. A campaign is never
 * created, or turned on, without all of these.
 */
export function campaignProblem(draft: Copy & Pick<Doc<"googleAdDrafts">, "keywords" | "postalCodes" | "cities" | "finalUrl">): string | null {
  const copy = draftCopy(draft);
  if (draft.keywords.length === 0) return "The draft has no keywords, so the ads would never show. Add at least one.";
  if (draft.keywords.some((k) => k.length > AD_LIMITS.keywords.chars)) return `Each keyword must be ${AD_LIMITS.keywords.chars} characters or fewer.`;
  if (copy.headlines.length < AD_LIMITS.headlines.min) return `The ad needs at least ${AD_LIMITS.headlines.min} different headlines (it has ${copy.headlines.length}).`;
  if (copy.headlines.some((h) => h.length > AD_LIMITS.headlines.chars)) return `Each headline must be ${AD_LIMITS.headlines.chars} characters or fewer.`;
  if (copy.descriptions.length < AD_LIMITS.descriptions.min) return `The ad needs at least ${AD_LIMITS.descriptions.min} different descriptions (it has ${copy.descriptions.length}).`;
  if (copy.descriptions.some((d) => d.length > AD_LIMITS.descriptions.chars)) return `Each description must be ${AD_LIMITS.descriptions.chars} characters or fewer.`;
  if (!/^https:\/\/\S+$/.test(draft.finalUrl)) return "The landing page must be an https address.";
  if (draft.postalCodes.length === 0 && (draft.cities ?? []).length === 0) return "The draft has no ZIP codes or cities, so it would show ads everywhere. Add your service area.";
  return null;
}
