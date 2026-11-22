import Image from "next/image";

import { ChatIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * How a logo sits on its tile.
 * mark: a symbol, with room around it (most logos).
 * wide: a wordmark, given more of the tile so it can be read.
 * tile: an app icon that is already a tile (its own background), filling the whole tile.
 */
type Fit = "mark" | "wide" | "tile";

type Mark = { kind: "file"; file: string; fit: Fit } | { kind: "glyph" };

const mark = (file: string, fit: Fit = "mark"): Mark => ({ kind: "file", file, fit });

/**
 * Which logo each integration (by id, see src/lib/app/integrations.ts) shows. The files are in
 * public/integrations, one per brand, in the brand's own colours. To use a different version of a logo,
 * replace its file. docs/integrations/00-plan.md says where each one came from.
 */
const MARKS: Record<string, Mark> = {
  stripe: mark("stripe.svg"),
  square: mark("square.svg"),
  "quickbooks-payments": mark("quickbooks.svg"),
  paypal: mark("paypal.svg"),
  "google-local-services-ads": mark("google.svg"),
  "google-ads": mark("google-ads.svg"),
  "meta-lead-ads": mark("meta.svg"),
  "google-address": mark("google-maps.svg"),
  "google-maps-travel": mark("google-maps.svg"),
  "google-drive": mark("google-drive.svg"),
  "google-calendar": mark("google-calendar.svg"),
  gmail: mark("gmail.svg"),
  "google-business-profile": mark("google.svg"),
  outlook: mark("outlook.svg"),
  onedrive: mark("onedrive.svg"),
  yelp: mark("yelp.svg"),
  "facebook-reviews": mark("facebook.svg"),
  "texting-number": { kind: "glyph" },
  quo: { kind: "glyph" },
  "quickbooks-online": mark("quickbooks.svg"),
  xero: mark("xero.svg"),
  indeed: mark("indeed.svg"),
  ziprecruiter: mark("ziprecruiter.png", "tile"),
  checkr: mark("checkr.png", "tile"),
  jobber: mark("jobber.png", "tile"),
  "housecall-pro": mark("housecall-pro.png"),
  zenmaid: mark("zenmaid.png"),
  launch27: mark("launch27.png", "wide"),
  // The same marks under the names other lists use: the public site's Google Maps line, and the import
  // source ids of setup and tutorials (convex/lib/tutorials/catalog.ts).
  "google-maps": mark("google-maps.svg"),
  housecall_pro: mark("housecall-pro.png"),
};

/** The logo file in public/integrations for this id, or null. The texting number is Selestial's own and has a glyph instead. */
export function logoFile(id: string): string | null {
  const found = MARKS[id];
  return found?.kind === "file" ? found.file : null;
}

const BOX = { xs: "size-5 rounded-[5px]", sm: "size-6 rounded-md", md: "size-9 rounded-lg", lg: "size-11 rounded-xl", xl: "size-14 rounded-2xl" } as const;
const GLYPH = { xs: "size-3", sm: "size-3.5", md: "size-5", lg: "size-6", xl: "size-7" } as const;
const FIT: Record<Fit, string> = { mark: "size-[58%] object-contain", wide: "size-[88%] object-contain", tile: "size-full object-cover" };

/**
 * An integration's logo on a white tile, so a brand's colours read the same in light and dark. Decorative:
 * the integration's name is always written beside it.
 */
export function IntegrationMark({ id, size = "md", className }: { id: string; size?: keyof typeof BOX; className?: string }) {
  const found = MARKS[id];
  return (
    <span className={cn("flex shrink-0 items-center justify-center overflow-hidden border border-black/10 bg-white shadow-sm", BOX[size], className)} aria-hidden data-integration-mark={id}>
      {found?.kind === "file" ? (
        // The files are small and fixed, so there is nothing for the image optimizer to do, and loading them
        // at once means a logo is never blank when its card scrolls into view.
        <Image src={`/integrations/${found.file}`} alt="" width={64} height={64} unoptimized loading="eager" className={FIT[found.fit]} />
      ) : (
        <ChatIcon className={cn("text-brand-500", GLYPH[size])} />
      )}
    </span>
  );
}
