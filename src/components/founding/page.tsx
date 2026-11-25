import Link from "next/link";
import type { ReactNode } from "react";

import { AgentMark } from "@/components/marketing/agent-mark";
import { Logo } from "@/components/brand/logo";
import { CookiePreferencesLink } from "@/components/consent/banner";
import { AGENTS_SECTION, CLAIM, FAQ, FINAL, FOUNDING_MONTHS, FOUNDING_PRICE, HERO, OFFER, SETUP, SUPPORT_EMAIL, WALKTHROUGH } from "@/lib/founding/content";
import { cn } from "@/lib/utils";

import { AgentDesk } from "./agent-desk";
import { ClaimForm } from "./claim-form";
import { ClaimCta, EnrollmentStatus } from "./enrollment";
import { FoundingNav } from "./founding-nav";
import { SetupIllustration, WalkIllustration, WorkspaceIllustration } from "./illustrations";
import { StickyCta } from "./sticky-cta";

const gutter = "px-5 sm:px-6 lg:px-8";
const shell = "mx-auto max-w-6xl";
const eyebrow = "text-xs font-semibold tracking-[0.16em] text-[#5126c7] uppercase";
const h2 = "font-heading text-[30px] leading-[1.08] tracking-[-0.02em] text-strong text-balance sm:text-[40px]";
const lead = "max-w-2xl text-[15px] leading-relaxed text-muted-foreground sm:text-[17px]";

function Section({ id, label, title, intro, children, className }: { id?: string; label?: string; title: string; intro?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className={cn(gutter, "scroll-mt-20 py-20 sm:py-28", className)}>
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
    <svg aria-hidden viewBox="0 0 16 16" className="mt-1 size-4 shrink-0 text-[#5c2fdb]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/** The end of the headline, drawn in the light gradient. */
const HIGHLIGHT = "a team of AI agents.";

function Hero() {
  return (
    <section id="founding-hero" className={cn(gutter, "relative isolate -mt-[72px] overflow-hidden bg-gradient-to-b from-white via-white to-background pt-32 pb-24 sm:-mt-[76px] sm:pt-36 sm:pb-32")}>
      {/* The field: white, with soft lavender light and a faint grid. Still, decorative. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_55%_at_82%_8%,rgba(142,109,246,0.18),transparent_70%),radial-gradient(45%_45%_at_5%_80%,rgba(104,56,239,0.10),transparent_70%)] [mask-image:linear-gradient(to_bottom,black_65%,transparent)]" />
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 opacity-60 [background-image:linear-gradient(rgba(104,56,239,0.07)_1px,transparent_1px),linear-gradient(90deg,rgba(104,56,239,0.07)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(70%_65%_at_60%_35%,black,transparent)]" />
      <div className={cn(shell, "grid items-center gap-12 lg:grid-cols-[1fr_1.02fr] lg:gap-14")}>
        <div className="max-w-xl">
          <p className="inline-flex items-center gap-2 rounded-full border border-[#e7e1fb] bg-white/80 px-3 py-1 text-[11px] font-semibold tracking-[0.16em] text-[#5126c7] uppercase shadow-[0_6px_20px_-12px_rgba(104,56,239,0.5)]">
            <span aria-hidden className="size-1.5 rounded-full bg-[#6838ef]" />
            {HERO.eyebrow}
          </p>
          <h1 className="mt-6 font-heading text-[40px] leading-[1.02] tracking-[-0.03em] text-strong text-balance sm:text-[58px]">
            {HERO.headline.replace(HIGHLIGHT, "")}
            <span className="bg-gradient-to-r from-[#8e6df6] via-[#6838ef] to-[#3f1d9e] bg-clip-text text-transparent">{HIGHLIGHT}</span>
          </h1>
          <p className="mt-6 text-[16px] leading-relaxed text-muted-foreground sm:text-lg">{HERO.supporting}</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <ClaimCta position="hero" />
            <a href={`#${WALKTHROUGH.id}`} className="inline-flex h-12 items-center justify-center gap-2 rounded-[10px] border border-border bg-white px-5 text-[15px] font-medium text-strong transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6838ef]">
              {HERO.secondary}
              <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3v10M4 9l4 4 4-4" />
              </svg>
            </a>
          </div>
          <p className="mt-5 text-sm text-strong">
            <span className="font-heading text-lg">{HERO.priceLine}</span> <span className="text-muted-foreground">{HERO.priceThen}</span>
          </p>
        </div>
        <AgentDesk />
      </div>
    </section>
  );
}

/** The enrollment card beside an illustrated day in Selestial, just under the hero. */
function FoundingStatusBand() {
  return (
    <section aria-label="Founding enrollment" className={cn(gutter, "relative pb-16 sm:pb-24")}>
      <div className={cn(shell, "grid items-start gap-8 lg:grid-cols-[0.9fr_1.1fr]")}>
        <EnrollmentStatus />
        <WorkspaceIllustration label="Illustration: each agent's lane of work today, with one decision waiting for the owner." caption={HERO.visualCaption} />
      </div>
    </section>
  );
}

function Agents() {
  return (
    <Section id="agents" label={AGENTS_SECTION.eyebrow} title={AGENTS_SECTION.headline} intro={AGENTS_SECTION.lead} className="border-t border-border bg-[#fbfaff]">
      <ul className="grid gap-4 sm:grid-cols-2">
        {AGENTS_SECTION.cards.map((card) => (
          <li key={card.id} className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-center gap-3">
              <AgentMark id={card.id} size="lg" />
              <h3 className="font-heading text-xl tracking-tight text-strong">{card.name}</h3>
            </div>
            <p className="mt-3 text-[15px] leading-relaxed text-strong">{card.line}</p>
            <ul className="mt-4 grid gap-2 border-t border-border pt-4">
              {card.examples.map((example) => (
                <li key={example} className="flex gap-2.5 text-sm leading-relaxed text-muted-foreground">
                  <Check />
                  {example}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <div className="mt-6 grid gap-3 text-sm leading-relaxed sm:grid-cols-[1.4fr_1fr]">
        <p className="rounded-xl bg-[#f3efff] px-4 py-3 text-strong ring-1 ring-[#6838ef]/15">{AGENTS_SECTION.bonus.line}</p>
        <p className="px-1 py-3 text-muted-foreground">{AGENTS_SECTION.notIncluded}</p>
      </div>
    </Section>
  );
}

function WalkStep({ step, wide = false }: { step: (typeof WALKTHROUGH.steps)[number]; wide?: boolean }) {
  return (
    <li className={cn("grid content-start gap-4", wide && "lg:col-span-3")}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-[#6838ef] font-heading text-sm font-semibold text-white">
          {step.n}
        </span>
        <div>
          <h3 className="font-heading text-lg tracking-tight text-strong">
            <span className="sr-only">Step {step.n}: </span>
            {step.title}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
        </div>
      </div>
      <div className="rounded-2xl bg-[radial-gradient(90%_90%_at_50%_0%,#f4f0ff,#faf8ff)] p-4 ring-1 ring-[#efeafd] sm:p-5">
        <p className="mb-3 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">{WALKTHROUGH.label}</p>
        <WalkIllustration visual={step.visual} label={step.alt} />
      </div>
    </li>
  );
}

function Walkthrough() {
  const steps = WALKTHROUGH.steps;
  return (
    <Section id={WALKTHROUGH.id} label={WALKTHROUGH.eyebrow} title={WALKTHROUGH.headline} intro={WALKTHROUGH.lead} className="border-t border-border">
      <ol className="grid gap-10 lg:grid-cols-3 lg:gap-8">
        {steps.slice(0, 3).map((step) => (
          <WalkStep key={step.n} step={step} />
        ))}
        <WalkStep step={steps[3]} wide />
      </ol>
    </Section>
  );
}

function Setup() {
  return (
    <Section id="setup" label={SETUP.eyebrow} title={SETUP.headline} intro={SETUP.supporting} className="border-t border-border bg-[#fbfaff]">
      <ol className="grid gap-4 md:grid-cols-3">
        {SETUP.steps.map((step) => (
          <li key={step.n} className="rounded-2xl border border-border bg-card p-6">
            <p className="font-heading text-sm text-[#5126c7]">Step {step.n}</p>
            <h3 className="mt-2 font-heading text-lg leading-snug tracking-tight text-strong">{step.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
          </li>
        ))}
      </ol>
      <div className="mt-12 grid items-start gap-10 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <h3 className="font-heading text-xl tracking-tight text-strong">{SETUP.help.title}</h3>
          <ul className="mt-4 grid gap-3">
            {SETUP.help.items.map((item) => (
              <li key={item} className="flex gap-2.5 text-[15px] leading-relaxed text-strong">
                <Check />
                {item}
              </li>
            ))}
          </ul>
          <p className="mt-5 text-sm leading-relaxed text-muted-foreground">{SETUP.limits}</p>
        </div>
        <SetupIllustration label="Illustration: three exported files read by Selestial into records ready to create, possible duplicates and corrections, with upcoming visits held until the owner releases them." caption={SETUP.imageCaption} />
      </div>
    </Section>
  );
}

function Offer() {
  return (
    <Section id={OFFER.id} label={OFFER.eyebrow} title={OFFER.headline} className="border-t border-border">
      <div className="mx-auto max-w-4xl overflow-hidden rounded-3xl border border-[#6838ef]/25 bg-card shadow-[0_40px_90px_-50px_rgba(81,38,199,0.55)]">
        <div className="grid gap-8 bg-[linear-gradient(135deg,#f4f0ff_0%,#ffffff_60%)] p-6 sm:p-10 md:grid-cols-[1fr_auto] md:items-end">
          <div>
            <p className="text-sm font-medium text-[#5126c7]">{OFFER.name}</p>
            <p className="mt-3 flex items-baseline gap-1.5">
              <span className="font-heading text-6xl tracking-[-0.03em] text-strong sm:text-7xl">{OFFER.price}</span>
              <span className="text-lg text-muted-foreground">{OFFER.period}</span>
            </p>
            <p className="mt-1 text-[15px] font-medium text-strong">{OFFER.duration}</p>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">{OFFER.renewal}</p>
          </div>
          <div className="md:w-60">
            <ClaimCta position="offer" fullWidth />
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{OFFER.places}</p>
          </div>
        </div>
        <div className="grid gap-x-10 gap-y-8 border-t border-border p-6 sm:grid-cols-2 sm:p-10">
          {OFFER.groups.map((group) => (
            <div key={group.title}>
              <h3 className="text-xs font-semibold tracking-[0.14em] text-strong uppercase">{group.title}</h3>
              <ul className="mt-3 grid gap-2">
                {group.items.map((item) => (
                  <li key={item} className="flex gap-2.5 text-sm leading-relaxed text-strong">
                    <Check />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <dl className="grid gap-6 border-t border-border bg-[#fbfaff] p-6 text-sm leading-relaxed sm:grid-cols-3 sm:p-10">
          <div>
            <dt className="font-medium text-strong">When the founding months end</dt>
            <dd className="mt-1 text-muted-foreground">{OFFER.ends}</dd>
          </div>
          <div>
            <dt className="font-medium text-strong">Cancelling</dt>
            <dd className="mt-1 text-muted-foreground">{OFFER.cancel}</dd>
          </div>
          <div>
            <dt className="font-medium text-strong">Paying</dt>
            <dd className="mt-1 text-muted-foreground">{OFFER.payment}</dd>
          </div>
        </dl>
      </div>
    </Section>
  );
}

function Claim() {
  return (
    <section id={CLAIM.id} aria-labelledby="claim-title" className={cn(gutter, "scroll-mt-20 border-t border-border bg-[#fbfaff] py-20 sm:py-28")}>
      <div className={cn(shell, "grid items-start gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-14")}>
        <div>
          <p className={cn(eyebrow, "mb-4")}>{CLAIM.eyebrow}</p>
          <h2 id="claim-title" className={h2}>
            {CLAIM.headline}
          </h2>
          <p className={cn(lead, "mt-4")}>{CLAIM.lead}</p>
          <p className="mt-6 text-sm text-strong">
            <span className="font-heading text-lg">
              {FOUNDING_PRICE}/month for your first {FOUNDING_MONTHS} months
            </span>
          </p>
        </div>
        <ClaimForm />
      </div>
    </section>
  );
}

function Faq() {
  return (
    <Section id={FAQ.id} title={FAQ.headline} className="border-t border-border">
      <div className="grid gap-10 lg:grid-cols-[0.7fr_1.3fr]">
        <p className="text-[15px] leading-relaxed text-muted-foreground">{FAQ.developing}</p>
        <div className="divide-y divide-border border-y border-border">
          {FAQ.items.map((item) => (
            <details key={item.q} className="group py-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-md py-4 text-left font-heading text-[17px] tracking-tight text-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6838ef] [&::-webkit-details-marker]:hidden">
                {item.q}
                <svg aria-hidden viewBox="0 0 16 16" className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-45 motion-reduce:transition-none" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M8 3v10M3 8h10" />
                </svg>
              </summary>
              <p className="max-w-2xl pb-5 text-[15px] leading-relaxed text-muted-foreground">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}

function Final() {
  return (
    <footer id="founding-footer" className={cn(gutter, "border-t border-border pt-20 pb-28 sm:pb-14")}>
      <div className={cn(shell, "rounded-3xl bg-[linear-gradient(135deg,#5126c7_0%,#6838ef_55%,#8a6bff_100%)] p-8 text-white sm:p-12")}>
        <h2 className="font-heading text-[30px] leading-tight tracking-[-0.02em] text-balance sm:text-[40px]">{FINAL.headline}</h2>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-white/85 sm:text-[17px]">{FINAL.body}</p>
        <div className="mt-8">
          <ClaimCta position="final" inverse />
        </div>
      </div>
      <div className={cn(shell, "mt-12 flex flex-col gap-6 text-sm sm:flex-row sm:items-start sm:justify-between")}>
        <div>
          <Logo />
          <p className="mt-3 text-muted-foreground">
            <a href={`mailto:${SUPPORT_EMAIL}`} className="hover:text-strong">
              {FINAL.support}
            </a>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{FINAL.note}</p>
        </div>
        <nav aria-label="Legal">
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-muted-foreground">
            {FINAL.links.map((link) => (
              <li key={link.href}>
                {link.href.startsWith("#") ? (
                  <a href={link.href} className="hover:text-strong">
                    {link.label}
                  </a>
                ) : (
                  <Link href={link.href} className="hover:text-strong">
                    {link.label}
                  </Link>
                )}
              </li>
            ))}
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

/** Selestial Founding Access: one focused page, one primary action. */
export function FoundingPage() {
  return (
    <>
      <a href="#content" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-lg focus:bg-primary focus:px-3.5 focus:py-2 focus:text-sm focus:text-primary-foreground">
        Skip to content
      </a>
      <FoundingNav />
      <main id="content">
        <Hero />
        <FoundingStatusBand />
        <Agents />
        <Walkthrough />
        <Setup />
        <Offer />
        <Claim />
        <Faq />
      </main>
      <Final />
      <StickyCta />
    </>
  );
}
