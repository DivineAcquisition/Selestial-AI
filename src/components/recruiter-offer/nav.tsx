"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Logo } from "@/components/brand/logo";
import { trackRecruiter } from "@/lib/recruiter-offer/analytics";
import { NAV } from "@/lib/recruiter-offer/content";
import { cn } from "@/lib/utils";

import { RecruiterCta } from "./cta";

const focus = "outline-none focus-visible:ring-2 focus-visible:ring-[#6838ef]/60";

/**
 * The focused header: logo with a "Recruiter" label, four in-page links, a discreet sign-in and the one
 * primary action. On small screens the links sit behind a disclosure button that closes on Escape, on
 * choosing a link, and returns focus to the button. Records the page view once.
 */
export function RecruiterNav({ ctaHref, signInHref }: { ctaHref: string; signInHref: string }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    trackRecruiter("recruiter_page_viewed");
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-50 px-3 pt-3 sm:px-5 sm:pt-4">
      <div
        className={cn(
          "mx-auto max-w-[1200px] rounded-2xl border transition-[background-color,border-color,box-shadow] duration-300 motion-reduce:transition-none",
          scrolled || open ? "border-border bg-white/90 shadow-[0_18px_50px_-30px_rgba(33,26,53,0.45)] backdrop-blur-xl" : "border-transparent",
        )}
      >
        <div className="flex h-14 items-center justify-between gap-3 pr-2 pl-4 sm:pl-5">
          <a href="#content" aria-label="Selestial Recruiter, top of page" className={cn("flex shrink-0 items-center gap-2.5 rounded-md", focus)}>
            <Logo />
            <span className="rounded-full border border-[#e2d9ff] bg-[#eee8ff] px-2 py-0.5 text-[11px] font-semibold tracking-wide text-[#5126c7]">Recruiter</span>
          </a>
          <nav aria-label="On this page" className="hidden items-center gap-0.5 lg:flex">
            {NAV.map((link) => (
              <a key={link.href} href={link.href} className={cn("flex h-9 items-center rounded-full px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:text-strong", focus)}>
                {link.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-1.5">
            <a href={signInHref} className={cn("hidden h-10 items-center rounded-xl px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-strong sm:inline-flex", focus)}>
              Sign in
            </a>
            <RecruiterCta href={ctaHref} position="nav" variant="compact" className="hidden sm:inline-flex" />
            <button
              ref={button}
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((v) => !v)}
              className={cn("inline-flex size-10 items-center justify-center rounded-xl text-strong hover:bg-muted lg:hidden", focus)}
            >
              <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
              <svg aria-hidden viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                {open ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />}
              </svg>
            </button>
          </div>
        </div>
        <div id={panelId} hidden={!open} className="border-t border-border px-3 pt-2 pb-3 lg:hidden">
          <nav aria-label="On this page, menu">
            <ul className="grid gap-0.5">
              {NAV.map((link) => (
                <li key={link.href}>
                  <a href={link.href} onClick={() => setOpen(false)} className={cn("flex h-11 items-center rounded-lg px-3 text-[15px] font-medium text-strong hover:bg-muted", focus)}>
                    {link.label}
                  </a>
                </li>
              ))}
              <li>
                <a href={signInHref} className={cn("flex h-11 items-center rounded-lg px-3 text-[15px] font-medium text-muted-foreground hover:bg-muted", focus)}>
                  Sign in
                </a>
              </li>
            </ul>
          </nav>
          <RecruiterCta href={ctaHref} position="menu" className="mt-2 w-full sm:hidden" onNavigate={() => setOpen(false)} />
        </div>
      </div>
    </header>
  );
}
