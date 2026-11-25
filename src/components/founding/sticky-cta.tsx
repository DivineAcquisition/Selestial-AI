"use client";

import { useEffect, useState } from "react";

import { FOUNDING_PRICE, FOUNDING_MONTHS } from "@/lib/founding/content";

import { ClaimCta } from "./enrollment";

/**
 * On phones only: the primary action stays reachable after the hero scrolls away. It hides while the hero,
 * the claim form or the footer is on screen, so it never covers a form field, the consent controls or the
 * legal links, and the page leaves room for it at the bottom.
 */
export function StickyCta() {
  const [clear, setClear] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const show = clear && !consentOpen;
  useEffect(() => {
    // The cookie notice sits at the bottom too: while it is open this bar stays out of its way.
    const check = () => setConsentOpen(document.querySelector('[aria-label="Cookie notice"], [aria-label="Cookie choices"]') !== null);
    check();
    const mutations = new MutationObserver(check);
    mutations.observe(document.body, { childList: true, subtree: true });
    return () => mutations.disconnect();
  }, []);
  useEffect(() => {
    const watched = ["founding-hero", "claim", "founding-footer"].map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        setClear(visible.size === 0);
      },
      { threshold: 0 },
    );
    watched.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);
  return (
    <div aria-hidden={!show} inert={!show} className={`fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur transition-transform duration-200 motion-reduce:transition-none sm:hidden ${show ? "translate-y-0" : "translate-y-full"}`}>
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-xs leading-snug text-muted-foreground">
          <span className="block font-heading text-base text-strong">{FOUNDING_PRICE}/mo</span>first {FOUNDING_MONTHS} months
        </p>
        <ClaimCta position="sticky" className="h-11! flex-[1.6]" />
      </div>
    </div>
  );
}
