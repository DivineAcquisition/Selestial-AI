import Image from "next/image";
import Link from "next/link";

import { IntegrationMark } from "@/components/app/integration-mark";
import { ArrowRight, Check, Clock, Hand, ListChecks, ScrollTextIcon, ShieldCheck, Sparkles, type LucideIcon } from "@/components/icons";
import { AgentMark, AgentName } from "@/components/marketing/agent-mark";
import { AgentVisual } from "@/components/marketing/agent-visuals";
import { SpotlightCard } from "@/components/marketing/saas-frame";
import { AGENT_PAGE_IDS, AGENT_PAGES, agentPagePath } from "@/lib/marketing/agent-pages";
import { BorderBeam } from "@/components/ui/border-beam";
import { buttonVariants } from "@/components/ui/button-variants";
import { ASSESSMENT_PATH, SIGNUP_PATH, AGENT_STATUS, AGENTS, CONTROL, INTEGRATIONS, PRICING, PROBLEM } from "@/lib/marketing/content";
import { cn } from "@/lib/utils";
import { INTEGRATIONS_PATH } from "@/lib/marketing/integrations-page";

/** The four loose ends from the problem section, each beside the agent that will carry it. */
export function LooseEnds() {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {PROBLEM.looseEnds.map((item) => (
        <li key={item.agent} className="flex items-start gap-3 rounded-xl border border-border bg-card p-5">
          <AgentMark id={item.agent} size="sm" />
          <p className="text-[15px] leading-relaxed text-strong">{item.text}</p>
        </li>
      ))}
    </ul>
  );
}

/** The four agents: what each keeps moving, how it helps, and where its work ends. */
export function AgentsGrid() {
  return (
    <>
    <div className="grid gap-4 lg:grid-cols-2">
      {AGENTS.map((agent) => (
        <SpotlightCard key={agent.id} className="p-6 sm:p-7">
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-3">
              <AgentMark id={agent.id} size="lg" live={AGENT_STATUS[agent.id].live} />
              <p className="text-[11px] font-semibold tracking-[0.14em] text-brand-300 uppercase">{agent.name}</p>
              <span
                className={
                  AGENT_STATUS[agent.id].live
                    ? "ml-auto inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success-foreground"
                    : "ml-auto rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                }
              >
                {AGENT_STATUS[agent.id].live ? <span className="size-1.5 rounded-full bg-success motion-safe:animate-pulse" aria-hidden /> : null}
                {AGENT_STATUS[agent.id].label}
              </span>
            </div>
            <h3 className="mt-5 font-heading text-xl tracking-tight text-strong sm:text-2xl">{agent.headline}</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-[15px]">{agent.body}</p>
            <div className="mt-5">
              <AgentVisual id={agent.id} />
            </div>
            <div className="mt-auto pt-6">
              <p className="flex items-start gap-2 border-t border-border pt-4 text-sm font-medium text-strong">
                <ArrowRight className="mt-0.5 size-4 shrink-0 text-brand-300" aria-hidden />
                {agent.outcome}
              </p>
              <Link href={agentPagePath(agent.id)} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 underline-offset-4 hover:underline">
                See how {agent.name} works
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </div>
          </div>
        </SpotlightCard>
      ))}
    </div>
    <ComingNext />
    </>
  );
}

/** The agents that are not released yet, each linking to its page. */
function ComingNext() {
  const soon = AGENT_PAGE_IDS.filter((id) => AGENT_PAGES[id].status === "coming_soon");
  return (
    <div className="mt-6 rounded-2xl border border-dashed border-border bg-card/60 p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-strong">Coming later</p>
        <Link href="/agents" className="text-sm font-medium text-brand-600 underline-offset-4 hover:underline">
          Meet the whole team
        </Link>
      </div>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {soon.map((id) => (
          <li key={id}>
            <Link href={agentPagePath(id)} className="group flex items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 hover:border-brand-500/40">
              <Image src={`/agents/${id}.webp`} alt="" width={72} height={72} className="size-9 shrink-0 rounded-full object-cover ring-1 ring-border" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-strong">{AGENT_PAGES[id].name}</span>
                <span className="block truncate text-xs text-muted-foreground">{AGENT_PAGES[id].headline}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const CONTROL_ICON: Record<(typeof CONTROL.cards)[number]["id"], LucideIcon> = {
  boundaries: ShieldCheck,
  delegate: ListChecks,
  follow: ScrollTextIcon,
  "step-in": Hand,
};

export function ControlCards() {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {CONTROL.cards.map((card) => {
        const Icon = CONTROL_ICON[card.id];
        return (
          <li key={card.id} className="rounded-xl border border-border bg-card p-5">
            <span className="flex size-9 items-center justify-center rounded-lg border border-brand-500/30 bg-brand-500/10 text-brand-300" aria-hidden>
              <Icon className="size-4" />
            </span>
            <p className="mt-4 font-heading text-base tracking-tight text-strong">{card.title}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{card.body}</p>
          </li>
        );
      })}
    </ul>
  );
}

/** The planned connections, grouped by what they are for, each with its own mark. */
export function IntegrationsGrid() {
  return (
    <div>
      <div className="grid gap-4 md:grid-cols-2">
        {INTEGRATIONS.groups.map((group) => (
          <div key={group.title} className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-[11px] font-semibold tracking-[0.14em] text-brand-300 uppercase">{group.title}</h3>
            <ul className="mt-4 grid gap-3">
              {group.items.map((item) => (
                <li key={item.name} className="flex items-start gap-3">
                  <IntegrationMark id={item.mark} size="md" />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium text-strong">{item.name}</span>
                      {item.live ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-1.5 py-px text-[10px] font-medium text-success-foreground">
                          <span className="size-1.5 rounded-full bg-success" aria-hidden />
                          {INTEGRATIONS.liveLabel}
                        </span>
                      ) : (
                        <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-medium text-muted-foreground">{INTEGRATIONS.plannedLabel}</span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">{item.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{INTEGRATIONS.note}</p>
        <Link href={INTEGRATIONS_PATH} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 underline-offset-4 hover:underline">
          See all integrations
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

/** The plan on sale: what it does today, what is not released yet, and the questions people ask. */
export function PricingPlans() {
  return (
    <div className="grid gap-8">
      <div className="mx-auto grid w-full max-w-5xl gap-4">
        {PRICING.plans.map((plan) => (
          <article key={plan.id} aria-labelledby={`plan-${plan.id}`} className="relative overflow-hidden rounded-[28px] border border-brand-500/25 bg-card shadow-[0_30px_80px_-40px_rgba(104,56,239,0.55)]">
            <BorderBeam size={140} duration={10} colorFrom="#6838ef" colorTo="#b39eff" borderWidth={1.5} />
            <div className="grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
              {/* The price side: the team, the price, and how to start. */}
              <div className="relative flex flex-col gap-5 overflow-hidden border-b border-brand-500/15 bg-gradient-to-br from-brand-500/[0.16] via-brand-500/[0.06] to-transparent p-6 sm:p-8 lg:border-r lg:border-b-0">
                <div aria-hidden className="pointer-events-none absolute -top-24 -left-20 size-64 rounded-full bg-brand-500/25 blur-3xl" />
                <div className="relative flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-500/12 px-2.5 py-1 text-xs font-semibold tracking-[0.12em] text-brand-600 uppercase ring-1 ring-brand-500/25 dark:text-brand-300">
                    <Sparkles aria-hidden className="size-3.5" />
                    {plan.tagline}
                  </span>
                  <span className="inline-flex items-center rounded-full bg-background/70 px-2.5 py-1 text-xs font-medium text-strong ring-1 ring-border">{plan.offer.note.split(".")[0]}</span>
                </div>

                {/* The team that comes with the plan: four agents and the early-user bonus. */}
                <div className="relative">
                  <div className="flex items-center">
                    {plan.agents.map((agent, index) => (
                      <span key={agent.id} className={cn("relative rounded-full bg-gradient-to-br from-brand-400 to-brand-600 p-[2.5px] shadow-[0_10px_24px_-10px_rgba(104,56,239,0.9)]", index > 0 && "-ml-3")} style={{ zIndex: 10 - index }}>
                        <span className="block rounded-full bg-background p-[2px]">
                          <AgentMark id={agent.id} size="lg" />
                        </span>
                      </span>
                    ))}
                    <span className="relative -ml-3 rounded-full bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 p-[2.5px] shadow-[0_10px_24px_-10px_rgba(245,158,11,0.9)]" style={{ zIndex: 1 }}>
                      <span className="block rounded-full bg-background p-[2px]">
                        <Image src={`/agents/${plan.bonus.id}.webp`} alt="" width={96} height={96} className="size-12 rounded-full ring-1 ring-border" />
                      </span>
                      <span className="absolute -right-1 -bottom-1 rounded-full bg-gradient-to-r from-amber-400 to-orange-500 px-1.5 py-px text-[10px] font-bold tracking-wide text-white uppercase shadow-sm">Bonus</span>
                    </span>
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">
                    <span className="font-medium text-strong">{plan.agents.length + 1} AI agents</span>, including {plan.bonus.name} free for early users.
                  </p>
                </div>

                <div className="relative">
                  <h3 id={`plan-${plan.id}`} className="font-heading text-3xl tracking-tight text-strong">
                    {plan.name}
                  </h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{plan.summary}</p>
                </div>

                {/* The price: the regular price struck through, the early-user price large. */}
                <div className="relative">
                  <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-strong">
                    <span className="text-2xl text-muted-foreground line-through decoration-2 decoration-brand-500/70">
                      <span className="sr-only">Regular price </span>
                      {plan.price}
                    </span>
                    <span className="font-heading text-6xl tracking-tight">{plan.offer.price}</span>
                    <span className="text-base text-muted-foreground">{plan.offer.period}</span>
                  </p>
                  <p className="mt-1 text-[15px] font-medium text-strong">{plan.offer.price}{plan.offer.period} {plan.offer.terms}.</p>
                  <p className="mt-1 text-sm text-muted-foreground">For the first 25 companies. Billed monthly; cancel any time and it runs to the end of the month you paid for.</p>
                </div>

                <div className="relative mt-auto grid gap-2 pt-1">
                  <Link href={SIGNUP_PATH} className={cn(buttonVariants({ variant: "gradient", size: "lg" }), "w-full justify-center")}>
                    Sign up for {plan.offer.price}{plan.offer.period}
                    <ArrowRight aria-hidden className="size-4" />
                  </Link>
                  <Link href={ASSESSMENT_PATH} className="text-center text-sm font-medium text-brand-600 underline-offset-4 hover:underline dark:text-brand-300">
                    Not sure yet? Get an assessment first
                  </Link>
                  <p className="text-center text-xs text-muted-foreground">No trial, no setup fee.</p>
                </div>
              </div>

              {/* The value side: who works for you, and everything else that comes with it. */}
              <div className="flex flex-col gap-6 p-6 sm:p-8">
                <div>
                  <p className="text-xs font-semibold tracking-[0.14em] text-brand-600 uppercase dark:text-brand-300">Four agents, working today</p>
                  <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
                    {plan.agents.map((agent) => (
                      <li key={agent.id} className="flex gap-3 rounded-2xl border border-border bg-background/60 p-3 transition-colors hover:border-brand-500/35">
                        <AgentMark id={agent.id} size="md" live />
                        <div className="min-w-0">
                          <AgentName id={agent.id} className="text-[15px]" />
                          <p className="mt-0.5 text-sm leading-snug text-muted-foreground">{agent.does}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2.5 flex gap-3 rounded-2xl border border-amber-400/50 bg-gradient-to-r from-amber-400/[0.12] to-transparent p-3">
                    <Image src={`/agents/${plan.bonus.id}.webp`} alt="" width={72} height={72} className="size-9 shrink-0 rounded-full ring-1 ring-amber-400/60" />
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="text-[15px] font-medium text-strong">{plan.bonus.name}</span>
                        <span className="rounded-full bg-gradient-to-r from-amber-400 to-orange-500 px-2 py-px text-[10px] font-bold tracking-wide text-white uppercase">Early-user bonus</span>
                      </p>
                      <p className="mt-0.5 text-sm leading-snug text-muted-foreground">
                        {plan.bonus.title}. {plan.bonus.does}
                      </p>
                    </div>
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">Also included</p>
                  <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                    {plan.platform.map((line) => (
                      <li key={line} className="flex gap-2.5 text-sm text-strong">
                        <span aria-hidden className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success-foreground">
                          <Check className="size-3.5" />
                        </span>
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
            {plan.later.length > 0 ? (
              <div className="flex flex-col gap-2 border-t border-border bg-muted/30 px-6 py-4 sm:flex-row sm:items-start sm:gap-4 sm:px-8">
                <p className="flex shrink-0 items-center gap-1.5 text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                  <Clock aria-hidden className="size-3.5" />
                  Not released yet
                </p>
                <ul className="grid gap-1 text-sm text-muted-foreground">
                  {plan.later.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </article>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {PRICING.allowanceNote} {PRICING.services}
      </p>
      <div className="grid gap-3">
        {PRICING.faqs.map((faq) => (
          <details key={faq.q} className="rounded-xl border border-border bg-card p-5">
            <summary className="cursor-pointer text-[15px] font-medium text-strong">{faq.q}</summary>
            <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">{faq.a}</p>
          </details>
        ))}
      </div>
    </div>
  );
}
