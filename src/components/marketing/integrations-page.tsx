import Image from "next/image";

import { IntegrationMark, logoFile } from "@/components/app/integration-mark";
import { LogoMark } from "@/components/brand/logo";
import { ArrowRight, Hand, Mail, ShieldCheck, Sparkles, Wallet } from "@/components/icons";
import { EarlyAccessLink } from "@/components/marketing/chrome";
import { ShinyLabel, SpotlightCard } from "@/components/marketing/saas-frame";
import { AGENT_PAGES } from "@/lib/marketing/agent-pages";
import { INTEGRATIONS_PAGE as P, integrationsByCategory, type PublicCategory, type PublicIntegration } from "@/lib/marketing/integrations-page";
import { marketingLead, marketingPageGutter, marketingSectionTitle, marketingShell } from "@/lib/marketing/ui";
import { sectionLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success-foreground">
      <span className="size-1.5 rounded-full bg-success motion-safe:animate-pulse" aria-hidden />
      {P.liveLabel}
    </span>
  );
}

function SoonBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-brand-500/40 bg-brand-500/10 px-2 py-0.5 text-[11px] font-medium text-brand-600">
      <Sparkles className="size-3" aria-hidden />
      {P.plannedLabel}
    </span>
  );
}

/** The agents that use a tool: their faces, then their names in words. */
function UsedBy({ agents }: { agents: PublicIntegration["agents"] }) {
  if (agents.length === 0) return null;
  // An agent that isn't released yet says so, so a live connection never implies it works today.
  const names = agents.map((id) => (AGENT_PAGES[id].status === "live" ? AGENT_PAGES[id].name : `${AGENT_PAGES[id].name} (soon)`));
  return (
    <div className="flex items-center gap-2.5 border-t border-border pt-3">
      <span className="flex -space-x-1.5" aria-hidden>
        {agents.slice(0, 4).map((id) => (
          <Image key={id} src={`/agents/${id}.webp`} alt="" width={48} height={48} className="size-6 rounded-full object-cover ring-2 ring-card" />
        ))}
      </span>
      <p className="min-w-0 text-xs text-muted-foreground">
        <span className="font-medium text-strong">{P.usedBy}</span> {names.join(", ")}
      </p>
    </div>
  );
}

function IntegrationCard({ item }: { item: PublicIntegration }) {
  const body = (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-start gap-3">
        <IntegrationMark id={item.id} size="lg" />
        <div className="min-w-0 flex-1">
          <h4 className="font-heading text-base leading-snug tracking-tight text-strong">{item.name}</h4>
          <div className="mt-1">{item.live ? <LiveBadge /> : <SoonBadge />}</div>
        </div>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">{item.does}</p>
      <ul className="flex flex-wrap gap-1.5" aria-label={`What ${item.name} lets agents do`}>
        {item.can.map((verb) => (
          <li key={verb} className="rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-strong">
            {verb}
          </li>
        ))}
      </ul>
      <div className="mt-auto">
        <UsedBy agents={item.agents} />
      </div>
    </div>
  );
  return (
    <li className="min-w-0">
      {item.live ? <SpotlightCard className="h-full">{body}</SpotlightCard> : <div className="h-full rounded-xl border border-dashed border-border bg-card/60 p-5">{body}</div>}
    </li>
  );
}

function CategoryBlock({ category }: { category: PublicCategory }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:gap-8">
      <div className="min-w-0">
        <h3 className="font-heading text-lg tracking-tight text-strong">{category.label}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{category.lead}</p>
      </div>
      <ul className="grid min-w-0 gap-4 sm:grid-cols-2">
        {category.items.map((item) => (
          <IntegrationCard key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

/** Live logos on two slow rings around Selestial's mark. Still for anyone who asks for reduced motion. */
function Orbit({ ids }: { ids: string[] }) {
  const half = Math.ceil(Math.min(ids.length, 12) / 2);
  const inner = ids.slice(0, half);
  const outer = ids.slice(half, 12);
  const ring = (items: string[], radius: number, reverse: boolean) => (
    <div aria-hidden className={cn("absolute inset-0 motion-safe:animate-[spin_70s_linear_infinite]", reverse && "motion-safe:[animation-direction:reverse]")}>
      {items.map((id, index) => {
        const angle = (index / items.length) * Math.PI * 2 - Math.PI / 2;
        return (
          <span key={id} className="absolute" style={{ left: `calc(50% + ${Math.cos(angle) * radius}%)`, top: `calc(50% + ${Math.sin(angle) * radius}%)`, transform: "translate(-50%, -50%)" }}>
            <span className={cn("block motion-safe:animate-[spin_70s_linear_infinite]", !reverse && "motion-safe:[animation-direction:reverse]")}>
              <IntegrationMark id={id} size="lg" className="shadow-[0_12px_30px_-14px_rgba(81,38,199,0.55)]" />
            </span>
          </span>
        );
      })}
    </div>
  );
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[19rem] sm:max-w-[26rem]">
      <div aria-hidden className="absolute inset-[12%] rounded-full bg-brand-500/15 blur-3xl" />
      <div aria-hidden className="absolute inset-[25%] rounded-full border border-brand-500/25" />
      <div aria-hidden className="absolute inset-[4%] rounded-full border border-dashed border-brand-500/20" />
      {ring(inner, 25, false)}
      {ring(outer, 46, true)}
      <div className="absolute inset-0 grid place-items-center">
        <span className="rounded-[22px] bg-card p-2 shadow-[0_30px_60px_-30px_rgba(104,56,239,0.7)] ring-1 ring-border">
          <LogoMark className="size-16" />
        </span>
      </div>
    </div>
  );
}

const PRINCIPLE_ICON = { owner: Hand, scope: ShieldCheck, yours: Wallet } as const;

/** /integrations: every connection, live ones first, each with its own logo and the agents that use it. */
export function IntegrationsPageView() {
  const live = integrationsByCategory(true);
  const planned = integrationsByCategory(false);
  const liveIds = live.flatMap((category) => category.items.map((item) => item.id));
  const liveCount = liveIds.length;
  const plannedCount = planned.reduce((sum, category) => sum + category.items.length, 0);
  // The orbit shows brands: each logo once (Local Services Ads and Business Profile share Google's G), and
  // not Selestial's own texting number, which has a glyph rather than a logo.
  const orbitIds = liveIds.filter((id, index) => {
    const file = logoFile(id);
    return file !== null && liveIds.findIndex((other) => logoFile(other) === file) === index;
  });

  return (
    <>
      <section className={cn(marketingPageGutter, "relative overflow-hidden pt-10 pb-14 sm:pt-16 sm:pb-20")}>
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[560px] bg-[radial-gradient(60%_60%_at_70%_0%,color-mix(in_oklab,var(--color-brand-500)_16%,transparent),transparent)]" />
        <div className={cn(marketingShell, "grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]")}>
          <div className="min-w-0">
            <ShinyLabel>{P.eyebrow}</ShinyLabel>
            <h1 className="font-heading text-[2.4rem] leading-[1.06] tracking-tight text-strong sm:text-5xl md:text-[3.5rem] md:leading-[1.04]">{P.headline}</h1>
            <p className={cn(marketingLead, "mt-5")}>{P.lead}</p>
            <dl className="mt-7 flex flex-wrap gap-3">
              <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-4 py-2.5">
                <span className="size-2 rounded-full bg-success motion-safe:animate-pulse" aria-hidden />
                <dt className="sr-only">{P.liveTitle}</dt>
                <dd className="text-sm text-strong">
                  <span className="font-heading text-lg tabular-nums">{liveCount}</span> live today
                </dd>
              </div>
              <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-4 py-2.5">
                <Sparkles className="size-3.5 text-brand-600" aria-hidden />
                <dt className="sr-only">{P.plannedTitle}</dt>
                <dd className="text-sm text-strong">
                  <span className="font-heading text-lg tabular-nums">{plannedCount}</span> coming soon
                </dd>
              </div>
            </dl>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <EarlyAccessLink position="integrations-hero">Get early access</EarlyAccessLink>
              <a href="#live" className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-border bg-card px-5 text-[15px] font-medium text-strong hover:bg-muted">
                See what&apos;s live
                <ArrowRight className="size-4" aria-hidden />
              </a>
            </div>
          </div>
          <Orbit ids={orbitIds} />
        </div>
      </section>

      <section id="live" className={cn(marketingPageGutter, "scroll-mt-24 border-t border-border py-16 sm:py-24")}>
        <div className={marketingShell}>
          <p className={cn(sectionLabel, "mb-3")}>{P.liveTitle}</p>
          <h2 className={marketingSectionTitle}>{P.liveLead}</h2>
          <div className="mt-12 grid gap-14">
            {live.map((category) => (
              <CategoryBlock key={category.id} category={category} />
            ))}
          </div>
        </div>
      </section>

      <section className={cn(marketingPageGutter, "border-t border-border py-16 sm:py-24")}>
        <div className={cn(marketingShell, "grid gap-4 md:grid-cols-3")}>
          {P.principles.map((principle) => {
            const Icon = PRINCIPLE_ICON[principle.id];
            return (
              <div key={principle.id} className="rounded-2xl border border-border bg-card p-6">
                <span className="flex size-9 items-center justify-center rounded-lg border border-brand-500/30 bg-brand-500/10 text-brand-600" aria-hidden>
                  <Icon className="size-4" />
                </span>
                <p className="mt-4 font-heading text-base tracking-tight text-strong">{principle.title}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{principle.body}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section id="coming-soon" className={cn(marketingPageGutter, "scroll-mt-24 border-t border-border py-16 sm:py-24")}>
        <div className={marketingShell}>
          <p className={cn(sectionLabel, "mb-3")}>{P.plannedTitle}</p>
          <h2 className={marketingSectionTitle}>{P.plannedLead}</h2>
          <div className="mt-12 grid gap-14">
            {planned.map((category) => (
              <CategoryBlock key={category.id} category={category} />
            ))}
          </div>
        </div>
      </section>

      <section className={cn(marketingPageGutter, "pb-16 sm:pb-24")}>
        <div className={cn(marketingShell, "relative overflow-hidden rounded-3xl border border-border bg-card p-8 sm:p-12")}>
          <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-brand-500/15 blur-3xl" />
          <div className="relative grid items-center gap-6 lg:grid-cols-[1fr_auto]">
            <div className="min-w-0">
              <h2 className="font-heading text-2xl tracking-tight text-strong sm:text-3xl">{P.askTitle}</h2>
              <p className={cn(marketingLead, "mt-3")}>{P.askBody}</p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <a href="mailto:support@selestial.io?subject=An%20integration%20we%20use" className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-border bg-background px-5 text-[15px] font-medium text-strong hover:bg-muted">
                <Mail className="size-4" aria-hidden />
                {P.askCta}
              </a>
              <EarlyAccessLink position="integrations-footer">Get early access</EarlyAccessLink>
            </div>
          </div>
        </div>
        <p className={cn(marketingShell, "mt-6 text-xs text-muted-foreground")}>{P.note}</p>
      </section>
    </>
  );
}
