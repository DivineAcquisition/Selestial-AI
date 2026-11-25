"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Logo } from "@/components/brand/logo";
import { HEADER } from "@/lib/founding/content";
import { cn } from "@/lib/utils";

import { ClaimCta } from "./enrollment";

const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-[#6838ef]/60";

/** A few in-page stops, never a menu: the page has one job. */
const LINKS = [
  { href: "#agents", label: "Agents" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#setup", label: "Setup" },
  { href: "#offer", label: "Offer" },
  { href: "#faq", label: "FAQ" },
];

/**
 * The Founding Access header, built like the main site's (src/components/marketing/site-nav.tsx): a floating
 * bar that turns to frosted glass once the page scrolls, the logo, a short row of in-page links, Sign in and
 * the one primary action. No menus: the page has a single job.
 */
export function FoundingNav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header className="sticky top-0 z-50 px-3 pt-3 sm:px-5 sm:pt-4">
      <div
        className={cn(
          "mx-auto flex h-14 max-w-[1200px] items-center justify-between gap-3 rounded-2xl pr-2 pl-4 transition-[background-color,border-color,box-shadow] duration-300 sm:pl-5",
          scrolled ? "border border-border bg-background/80 shadow-[0_18px_50px_-30px_rgba(33,26,53,0.45)] backdrop-blur-xl" : "border border-transparent",
        )}
      >
        <a href="#content" aria-label="Selestial Founding Access, top of page" className={cn("flex shrink-0 items-center rounded-md", focusRing)}>
          <Logo />
        </a>
        <nav aria-label="On this page" className="hidden items-center gap-0.5 lg:flex">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} className={cn("flex h-9 items-center rounded-full px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:text-strong", focusRing)}>
              {link.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-1.5">
          <Link href={`/login?next=${encodeURIComponent("/app/founding")}`} className={cn("inline-flex h-10 items-center rounded-xl px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:text-strong", focusRing)}>
            {HEADER.signIn}
          </Link>
          <ClaimCta position="nav" compact className="hidden sm:inline-flex" />
        </div>
      </div>
    </header>
  );
}
