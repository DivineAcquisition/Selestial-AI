import Link from "next/link";
import type { ReactNode } from "react";

import { CookiePreferencesLink } from "@/components/consent/banner";
import { Logo } from "@/components/brand/logo";
import { AgentMark } from "@/components/marketing/agent-mark";
import { hostMap, hrefFor } from "@/lib/hosts";
import {
  CONTROL,
  CTA_LABELS,
  FAQ,
  FINAL,
  FOOTER,
  GETTING_STARTED,
  HERO,
  INCLUDED,
  PRICING,
  PROBLEM,
  RECRUITER_CTA,
  RECRUITER_PRICE,
  SUPPORT_EMAIL,
  WORKFLOW,
} from "@/lib/recruiter-offer/content";
import { cn } from "@/lib/utils";

import { rateCardAt } from "../../../convex/lib/messagingBilling/rates";
import { RecruiterCta } from "./cta";
import { FaqList } from "./faq";
import { HeroWorkspace } from "./hero-workspace";
import { RecruiterNav } from "./nav";
import { RecruiterStickyCta } from "./sticky-cta";
import { WorkflowPreview } from "./workflow";

const gutter = "px-5 sm:px-6 lg:px-8";
const shell = "mx-auto max-w-6xl";
const eyebrow = "text-xs font-semibold tracking-[0.16em] text-[#5126c7] uppercase";
const h2 = "font-heading text-[30px] leading-[1.08] tracking-[-0.02em] text-strong text-balance sm:text-[40px]";
const lead = "max-w-2xl text-[15px] leading-relaxed text-muted-foreground sm:text-[17px]";

function Section({ id, label, title, intro, children, className }: { id?: string; label?: string; title: string; intro?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className={cn(gutter, "scroll-mt-24 py-20 sm:py-28", className)}>
      <div className={shell}>
        {label ? <p className={cn(eyebrow, "mb-4")}>{label}</p> : null}
        <h2 id={id ? `${id}-title` : undefined} className={h2}>
          {title}
        </h2>
        {intro ? <p className={cn(lead, "mt-4")}>{intro}</p> : null}
        <div className="mt-10 sm:mt-12">{children}</div>
      </div>
    </section>
  );
}

function Check() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="mt-1 size-4 shrink-0 text-[#6838ef]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/** "$0.0025" style from the rate card's units of $0.0001. */
const unitsToDollars = (units: number) => `$${(units / 10_000).toFixed(units % 100 === 0 ? 2 : units % 10 === 0 ? 3 : 4)}`;

/** While checkout is closed, the actions say they are a request; this line says why, near each one. */
function ModeNote({ className, inverse = false }: { className?: string; inverse?: boolean }) {
  const note = CTA_LABELS[RECRUITER_CTA.mode].note;
  if (!note) return null;
  return <p className={cn("text-sm", inverse ? "text-white/80" : "text-muted-foreground", className)}>{note}</p>;
}

function Hero({ ctaHref }: { ctaHref: string }) {
  const [before] = HERO.headline.split(HERO.highlight);
  return (
    <section id="recruiter-hero" className={cn(gutter, "relative isolate -mt-[72px] overflow-hidden bg-gradient-to-b from-white via-white to-[#f8f9fc] pt-32 pb-20 sm:-mt-[76px] sm:pt-36 sm:pb-28")}>
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(55%_50%_at_85%_10%,rgba(104,56,239,0.12),transparent_70%)]" />
      <div className={cn(shell, "grid items-center gap-12 lg:grid-cols-[1fr_1.05fr] lg:gap-14")}>
        <div className="max-w-xl">
          <p className="inline-flex items-center gap-2 rounded-full border border-[#e2d9ff] bg-white px-3 py-1 text-[11px] font-semibold tracking-[0.16em] text-[#5126c7] uppercase">
            <span aria-hidden className="size-1.5 rounded-full bg-[#6838ef]" />
            {HERO.eyebrow}
          </p>
          <h1 className="mt-6 font-heading text-[40px] leading-[1.03] tracking-[-0.03em] text-strong text-balance sm:text-[56px]">
            {before}
            <span className="text-[#6838ef]">{HERO.highlight}</span>
          </h1>
          <p className="mt-6 text-[16px] leading-relaxed text-muted-foreground sm:text-lg">{HERO.supporting}</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <RecruiterCta href={ctaHref} position="hero" />
            <a href="#how-it-works" className="inline-flex h-12 items-center justify-center gap-2 rounded-[10px] border border-border bg-white px-5 text-[15px] font-medium text-strong transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6838ef]">
              {HERO.secondary}
              <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3v10M4 9l4 4 4-4" />
              </svg>
            </a>
          </div>
          <p className="mt-5 text-sm text-strong">
            <span className="font-heading text-lg">{RECRUITER_PRICE}</span>
            <span className="text-muted-foreground">/month · {HERO.reassurance}</span>
          </p>
          <ModeNote className="mt-2" />
        </div>
        <HeroWorkspace />
      </div>
    </section>
  );
}

function Problem() {
  return (
    <Section id="problem" title={PROBLEM.headline}>
      <div className="grid gap-4 md:grid-cols-3">
        {PROBLEM.items.map((item, i) => (
          <div key={item.title} className="rounded-2xl border border-border bg-white p-6">
            <p className="font-heading text-sm text-[#5126c7] tabular-nums">0{i + 1}</p>
            <h3 className="mt-3 font-heading text-[19px] tracking-tight text-strong">{item.title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{item.body}</p>
          </div>
        ))}
      </div>
      <div className="mt-6 flex items-start gap-4 rounded-2xl border border-[#e2d9ff] bg-[#eee8ff]/50 p-6">
        <AgentMark id="recruiter" size="lg" />
        <p className="text-[16px] leading-relaxed text-strong sm:text-[17px]">{PROBLEM.answer}</p>
      </div>
    </Section>
  );
}

function Workflow() {
  return (
    <Section id="how-it-works" label="How it works" title={WORKFLOW.headline} intro={WORKFLOW.intro} className="border-t border-border bg-[#f8f9fc]">
      <WorkflowPreview />
    </Section>
  );
}

function Included() {
  return (
    <Section id="included" label="What’s included" title={INCLUDED.headline}>
      <ol className="grid gap-px overflow-hidden rounded-3xl border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
        {INCLUDED.items.map((item, i) => (
          <li key={item.title} className={cn("bg-white p-6 sm:p-7", i === INCLUDED.items.length - 1 && "md:col-span-2 lg:col-span-1")}>
            <span aria-hidden className="grid size-9 place-items-center rounded-xl bg-[#eee8ff] font-heading text-sm text-[#5126c7]">
              {i + 1}
            </span>
            <h3 className="mt-4 font-heading text-[19px] tracking-tight text-strong">{item.title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{item.body}</p>
          </li>
        ))}
        <li className="hidden bg-[#fbfaff] p-6 sm:p-7 lg:block">
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            Recruiter works with the applicants who come to you. It does not post jobs or search job boards for candidates.
          </p>
        </li>
      </ol>
    </Section>
  );
}

function GettingStarted() {
  return (
    <Section id="getting-started" label="Getting started" title={GETTING_STARTED.headline} className="border-t border-border bg-[#f8f9fc]">
      <ol className="grid gap-4 md:grid-cols-3">
        {GETTING_STARTED.steps.map((step, i) => (
          <li key={step.title} className="relative rounded-2xl border border-border bg-white p-6">
            <span className="font-heading text-[13px] text-muted-foreground tabular-nums">Step {i + 1}</span>
            <h3 className="mt-2 font-heading text-[19px] tracking-tight text-strong">{step.title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{step.body}</p>
          </li>
        ))}
      </ol>
      <p className="mt-6 max-w-2xl text-[15px] leading-relaxed text-strong">{GETTING_STARTED.note}</p>
    </Section>
  );
}

function Control({ privacyHref, securityHref }: { privacyHref: string; securityHref: string }) {
  return (
    <Section id="control" label="Control and trust" title={CONTROL.headline}>
      <div className="grid gap-x-10 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
        {CONTROL.items.map((item) => (
          <div key={item.title} className="flex gap-3">
            <Check />
            <div>
              <h3 className="font-heading text-[17px] tracking-tight text-strong">{item.title}</h3>
              <p className="mt-1.5 text-[15px] leading-relaxed text-muted-foreground">{item.body}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-10 rounded-2xl border border-border bg-[#f8f9fc] p-6">
        <p className="text-[15px] leading-relaxed text-strong">{CONTROL.inbox}</p>
        <p className="mt-3 text-sm">
          <Link href={privacyHref} className="font-medium text-[#5126c7] underline-offset-4 hover:underline">
            Privacy policy
          </Link>
          <span aria-hidden className="mx-2 text-muted-foreground">·</span>
          <Link href={securityHref} className="font-medium text-[#5126c7] underline-offset-4 hover:underline">
            Security
          </Link>
        </p>
      </div>
    </Section>
  );
}

/** The messaging rate card in force now (read per request; the page revalidates every few minutes). */
function currentRates() {
  return rateCardAt(Date.now());
}

function Pricing({ ctaHref }: { ctaHref: string }) {
  const card = currentRates();
  return (
    <Section id="pricing" label="Pricing" title="One price for your hiring workspace." className="border-t border-border bg-[#f8f9fc]">
      <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-3xl border border-[#d9ccff] bg-white p-7 shadow-[0_30px_80px_-55px_rgba(81,38,199,0.7)] sm:p-9">
          <div className="flex items-center gap-3">
            <AgentMark id="recruiter" size="lg" />
            <div>
              <h3 className="font-heading text-[22px] tracking-tight text-strong">{PRICING.name}</h3>
              <p className="text-[15px] text-muted-foreground">{PRICING.description}</p>
            </div>
          </div>
          <p className="mt-7 flex items-baseline gap-1.5">
            <span className="font-heading text-[52px] leading-none tracking-[-0.03em] text-strong">{RECRUITER_PRICE}</span>
            <span className="text-[15px] text-muted-foreground">/month</span>
          </p>
          <p className="mt-2 text-sm text-muted-foreground">{PRICING.billing}</p>
          <ul className="mt-7 grid gap-2.5">
            {PRICING.included.map((item) => (
              <li key={item} className="flex gap-2.5 text-[15px] text-strong">
                <Check />
                {item}
              </li>
            ))}
          </ul>
          <div className="mt-8">
            <RecruiterCta href={ctaHref} position="pricing" className="w-full sm:w-auto" />
            <ModeNote className="mt-3" />
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-border bg-white p-6">
            <h3 className="font-heading text-[17px] tracking-tight text-strong">AI usage and messaging</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted-foreground">{PRICING.aiUsage}</p>
            <dl className="mt-4 grid gap-2 text-[14px]">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Email from your connected Gmail</dt>
                <dd className="font-medium text-strong">No Selestial charge</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Email sent through Selestial</dt>
                <dd className="font-medium text-strong tabular-nums">{unitsToDollars(card.rates.email_out)} / recipient</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Text message (optional)</dt>
                <dd className="font-medium text-strong tabular-nums">{unitsToDollars(card.rates.sms_out)} / segment out</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Texting number (optional)</dt>
                <dd className="font-medium text-strong tabular-nums">{unitsToDollars(card.numberMonthly)} / month</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">Messaging is paid from a prepaid balance at the published US rates (rate card {card.version}).</p>
          </div>
          <div className="rounded-2xl border border-border bg-white p-6">
            <h3 className="font-heading text-[17px] tracking-tight text-strong">{PRICING.upsell.title}</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted-foreground">{PRICING.upsell.body}</p>
          </div>
        </div>
      </div>
    </Section>
  );
}

function Faq() {
  return (
    <Section id="faq" label="FAQs" title={FAQ.headline}>
      <FaqList items={FAQ.items} />
    </Section>
  );
}

function Footer({ ctaHref, signInHref, links }: { ctaHref: string; signInHref: string; links: { href: string; label: string }[] }) {
  return (
    <footer id="recruiter-footer" className={cn(gutter, "border-t border-border pt-20 pb-28 sm:pb-14")}>
      <div className={cn(shell, "rounded-3xl bg-[linear-gradient(135deg,#5126c7_0%,#6838ef_60%,#7d58f5_100%)] p-8 text-white sm:p-12")}>
        <h2 className="font-heading text-[30px] leading-tight tracking-[-0.02em] text-balance sm:text-[40px]">{FINAL.headline}</h2>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-white/85 sm:text-[17px]">{FINAL.body}</p>
        <div className="mt-8">
          <RecruiterCta href={ctaHref} position="final" variant="inverse" />
          <ModeNote className="mt-3 max-w-xl" inverse />
        </div>
      </div>
      <div className={cn(shell, "mt-12 flex flex-col gap-6 text-sm sm:flex-row sm:items-start sm:justify-between")}>
        <div>
          <Logo />
          <p className="mt-3 text-xs text-muted-foreground">{FOOTER.note}</p>
        </div>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-muted-foreground">
            {links.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="hover:text-strong">
                  {link.label}
                </Link>
              </li>
            ))}
            <li>
              <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:text-strong">
                Contact
              </a>
            </li>
            <li>
              <a href={signInHref} className="hover:text-strong">
                Sign in
              </a>
            </li>
            <li>
              <CookiePreferencesLink className="hover:text-strong" />
            </li>
          </ul>
        </nav>
      </div>
      <p className={cn(shell, "mt-8 text-xs text-muted-foreground")}>© {new Date().getUTCFullYear()} Selestial</p>
    </footer>
  );
}

/** Selestial Recruiter, the standalone offer: one focused page, one primary action. */
export function RecruiterOfferPage() {
  const hosts = hostMap(process.env);
  // Each link points at the host that serves it (the access host serves only its own pages).
  const ctaHref = hrefFor(RECRUITER_CTA.path, hosts);
  const signInHref = hrefFor(`/login?next=${encodeURIComponent("/app/agents/recruiter")}`, hosts);
  const links = FOOTER.links.map((link) => ({ ...link, href: hrefFor(link.href, hosts) }));
  return (
    <>
      <a href="#content" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-lg focus:bg-primary focus:px-3.5 focus:py-2 focus:text-sm focus:text-primary-foreground">
        Skip to content
      </a>
      <RecruiterNav ctaHref={ctaHref} signInHref={signInHref} />
      <main id="content">
        <Hero ctaHref={ctaHref} />
        <Problem />
        <Workflow />
        <Included />
        <GettingStarted />
        <Control privacyHref={hrefFor("/privacy", hosts)} securityHref={hrefFor("/security", hosts)} />
        <Pricing ctaHref={ctaHref} />
        <Faq />
      </main>
      <Footer ctaHref={ctaHref} signInHref={signInHref} links={links} />
      <RecruiterStickyCta ctaHref={ctaHref} />
    </>
  );
}
