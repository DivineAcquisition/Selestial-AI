"use client";

import type { SyntheticEvent } from "react";

import { trackRecruiter } from "@/lib/recruiter-offer/analytics";
import { CAMPAIGN_PARAMS, CTA_LABELS, RECRUITER_CTA } from "@/lib/recruiter-offer/content";
import { cn } from "@/lib/utils";

/** The visitor's supported campaign parameters, carried to the next step. Nothing else from the address. */
function withCampaign(href: string): string {
  if (typeof window === "undefined") return href;
  const here = new URLSearchParams(window.location.search);
  const [base, hash] = href.split("#");
  const url = new URL(base, window.location.origin);
  for (const key of CAMPAIGN_PARAMS) {
    const value = here.get(key);
    if (value && !url.searchParams.has(key)) url.searchParams.set(key, value.slice(0, 120));
  }
  const out = url.origin === window.location.origin && base.startsWith("/") ? `${url.pathname}${url.search}` : url.toString();
  return hash ? `${out}#${hash}` : out;
}

const focus = "outline-none focus-visible:ring-2 focus-visible:ring-[#6838ef]/60 focus-visible:ring-offset-2";

const STYLES = {
  primary:
    "inline-flex h-12 items-center justify-center rounded-[10px] bg-[#6838ef] px-6 text-[15px] font-semibold text-white shadow-[0_12px_30px_-14px_rgba(104,56,239,0.9)] transition-colors hover:bg-[#5126c7]",
  compact: "inline-flex h-10 items-center justify-center rounded-xl bg-[#6838ef] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#5126c7]",
  inverse:
    "inline-flex h-12 items-center justify-center rounded-[10px] bg-white px-6 text-[15px] font-semibold text-[#5126c7] shadow-[0_10px_30px_-12px_rgba(0,0,0,0.45)] transition-colors hover:bg-[#f3efff]",
} as const;

/**
 * Every primary action on the page. The destination and wording come from RECRUITER_CTA (one place): in
 * "inquiry" mode it opens the booking page and says "Request", never "Get"; there is no purchase label
 * while checkout is closed. `href` is resolved on the server to the host that serves it.
 */
/** Adds the campaign parameters just before the link is followed, opened in a new tab or copied. */
const carryCampaign = (href: string) => (event: SyntheticEvent<HTMLAnchorElement>) => {
  event.currentTarget.href = withCampaign(href);
};

export function RecruiterCta({ href, position, variant = "primary", className, onNavigate }: { href: string; position: string; variant?: keyof typeof STYLES; className?: string; onNavigate?: () => void }) {
  const labels = CTA_LABELS[RECRUITER_CTA.mode];
  const carry = carryCampaign(href);
  return (
    <a
      href={href}
      onPointerDown={carry}
      onFocus={carry}
      onContextMenu={carry}
      data-cta-position={position}
      data-cta-mode={RECRUITER_CTA.mode}
      onClick={(event) => {
        carry(event);
        trackRecruiter("recruiter_cta_selected", { position, mode: RECRUITER_CTA.mode });
        onNavigate?.();
      }}
      className={cn(STYLES[variant], focus, className)}
    >
      {variant === "compact" ? labels.compact : labels.primary}
    </a>
  );
}
