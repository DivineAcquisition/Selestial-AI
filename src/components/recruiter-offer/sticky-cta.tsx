"use client";

import { useEffect, useState } from "react";

import { RECRUITER_PRICE } from "@/lib/recruiter-offer/content";

import { RecruiterCta } from "./cta";

/**
 * Phones only: keeps the primary action reachable after the hero scrolls away. Hidden while the hero,
 * the pricing card, the footer or the cookie notice is on screen, so it never covers them.
 */
export function RecruiterStickyCta({ ctaHref }: { ctaHref: string }) {
  const [clear, setClear] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const show = clear && !consentOpen;
  useEffect(() => {
    const check = () => setConsentOpen(document.querySelector('[aria-label="Cookie notice"], [aria-label="Cookie choices"]') !== null);
    check();
    const mutations = new MutationObserver(check);
    mutations.observe(document.body, { childList: true, subtree: true });
    return () => mutations.disconnect();
  }, []);
  useEffect(() => {
    const watched = ["recruiter-hero", "pricing", "recruiter-footer"].map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      setClear(visible.size === 0);
    });
    watched.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);
  return (
    <div aria-hidden={!show} inert={!show} className={`fixed inset-x-0 bottom-0 z-40 border-t border-border bg-white/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur transition-transform duration-200 motion-reduce:transition-none sm:hidden ${show ? "translate-y-0" : "translate-y-full"}`}>
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-xs leading-snug text-muted-foreground">
          <span className="block font-heading text-base text-strong">{RECRUITER_PRICE}/mo</span>Selestial Recruiter
        </p>
        <RecruiterCta href={ctaHref} position="sticky" className="h-11 flex-[1.6] px-3 text-sm" />
      </div>
    </div>
  );
}
