"use client";

/**
 * The pieces every Quality screen is built from. A status is words with a mark, never a colour alone. What a
 * line rests on (a fact, someone's words, a provider's summary, an analysis, something missing) is always shown,
 * and drawn differently so an analysis is never read as a fact. Nothing here is a score or a confidence figure,
 * and nothing animates unless work is really under way.
 */
import type { FunctionReturnType } from "convex/server";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { AlertTriangle, ArrowUpRight, CheckCircle2, CircleDashed, Eye, Hand, Hourglass, LightningIcon, SearchIcon, ShieldCheck } from "@/components/icons";
import { until, whenLabel } from "@/lib/app/format";
import { cn } from "@/lib/utils";

import type { api } from "../../../../../convex/_generated/api";

export type Overview = FunctionReturnType<typeof api.quality.overview>;
export type CaseCard = Overview["needsAttention"][number];
export type CaseDetail = FunctionReturnType<typeof api.quality.caseDetail>;
export type ReviewDetail = FunctionReturnType<typeof api.quality.review>;
export type Section = ReviewDetail["evidence"][number];
export type RequestView = ReviewDetail["requests"][number];

export const QUALITY_PATH = "/app/agents/quality";
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

type Stage = CaseCard["stage"];
const STAGE_LOOK: Record<Stage, { icon: typeof Hand; tone: string }> = {
  needs_context: { icon: CircleDashed, tone: "border-border bg-muted text-strong" },
  investigating: { icon: SearchIcon, tone: "border-brand-500/30 bg-brand-500/10 text-brand-300" },
  needs_decision: { icon: Hand, tone: "border-warning/40 bg-warning/10 text-warning-foreground" },
  action_underway: { icon: LightningIcon, tone: "border-brand-500/30 bg-brand-500/10 text-brand-300" },
  verifying: { icon: Eye, tone: "border-border bg-background text-muted-foreground" },
  closed: { icon: CheckCircle2, tone: "border-border bg-background text-muted-foreground" },
};

export function StagePill({ stage, words, className }: { stage: Stage; words: string; className?: string }) {
  const look = STAGE_LOOK[stage];
  const Icon = look.icon;
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap", look.tone, className)}>
      <Icon className="size-3.5" aria-hidden />
      {words}
    </span>
  );
}

type Basis = "fact" | "customer_stated" | "cleaner_stated" | "provider_summary" | "analysis" | "missing";
const BASIS: Record<Basis, { label: string; tone: string }> = {
  fact: { label: "Record", tone: "border-success/30 bg-success/10 text-success-foreground" },
  customer_stated: { label: "Customer said", tone: "border-brand-500/30 bg-brand-500/10 text-brand-300" },
  cleaner_stated: { label: "Cleaner said", tone: "border-brand-500/30 bg-brand-500/10 text-brand-300" },
  provider_summary: { label: "Provider summary", tone: "border-dashed border-border bg-background text-muted-foreground" },
  analysis: { label: "Analysis", tone: "border-dashed border-border bg-background text-muted-foreground" },
  missing: { label: "Not on record", tone: "border-dashed border-warning/40 bg-background text-warning-foreground" },
};

/** What a line rests on. An analysis and a provider's summary are drawn dashed on purpose: neither is a fact. */
export function BasisTag({ basis }: { basis: string | null }) {
  const look = BASIS[(basis ?? "fact") as Basis] ?? BASIS.fact;
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-[11px] font-medium", look.tone)}>{look.label}</span>;
}

export function Flag({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "warn" | "danger" }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium", tone === "danger" ? "border-destructive/30 bg-destructive/10 text-destructive-foreground" : tone === "warn" ? "border-warning/40 bg-warning/10 text-warning-foreground" : "border-border bg-muted text-muted-foreground")}>
      {children}
    </span>
  );
}

/** Opens one record (a case, a review) in the panel over the page, and keeps it in the address. */
export function useParam(name: "case" | "review") {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const openId = params.get(name);
  const set = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set(name, id);
      else next.delete(name);
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [name, params, pathname, router],
  );
  return { openId, open: (id: string) => set(id), close: () => set(null) };
}

function Line({ label, children, strong }: { label: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <span className="grid grid-cols-1 gap-0.5 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-3">
      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase sm:pt-0.5">{label}</span>
      <span className={cn("min-w-0 text-sm leading-snug [overflow-wrap:anywhere]", strong ? "font-medium text-strong" : "text-foreground")}>{children}</span>
    </span>
  );
}

/** One case at a glance: what was reported, what Quality is doing, what needs a person, and where its remedy and customer stand. */
export function CaseCardView({ card, now, timezone, onOpen }: { card: CaseCard; now: number; timezone: string; onOpen: (id: string) => void }) {
  const due = until(card.dueAt, now);
  const urgent = card.serious || card.stage === "needs_decision";
  return (
    <button type="button" onClick={() => onOpen(card.id)} className={cn("group relative grid w-full grid-cols-1 gap-3 overflow-hidden rounded-2xl border bg-card p-4 text-left transition-colors hover:border-brand-500/50 focus-visible:outline-2 focus-visible:outline-brand-500 sm:p-5", urgent ? "border-warning/40" : "border-border")}>
      {urgent ? <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", card.serious ? "bg-destructive" : "bg-warning")} /> : null}
      <span className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <span className="min-w-0">
          <span className="block text-base font-semibold text-strong [overflow-wrap:anywhere]">{card.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {card.origin}
            {card.job?.property ? ` · ${card.job.property.name}` : ""}
            {card.job ? ` · ${card.job.service}, ${card.job.day}` : ""}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          {card.serious ? (
            <Flag tone="danger">
              <ShieldCheck className="size-3" aria-hidden />
              Serious: Owner only
            </Flag>
          ) : null}
          {card.held ? (
            <Flag>
              <Hand className="size-3" aria-hidden />A person has this
            </Flag>
          ) : null}
          {card.escalated && !card.serious ? <Flag tone="warn">Escalated</Flag> : null}
          <StagePill stage={card.stage} words={card.stageWords} />
        </span>
      </span>
      <span className="grid gap-2">
        <Line label="Reported">{card.happened}</Line>
        <Line label="Quality is">{card.doing}</Line>
        {card.needs ? (
          <Line label="Needs you" strong>
            {card.needs}
          </Line>
        ) : card.closed ? (
          <Line label="Closed" strong>
            {card.closed.words}
          </Line>
        ) : null}
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
        <span>
          Findings: {card.findings.reviewed} reviewed{card.findings.suggested ? `, ${card.findings.suggested} suggested` : ""}
        </span>
        {card.correction ? <span>Correction: {card.correction.words}</span> : null}
        {card.correction ? <span>{card.correction.customer}</span> : card.customerOutcome ? <span>Customer: {card.customerOutcome}</span> : null}
        {card.stage !== "closed" ? (
          <span className={cn("ml-auto inline-flex items-center gap-1", card.overdue ? "font-semibold text-destructive-foreground" : "")}>
            {card.overdue ? <AlertTriangle className="size-3.5" aria-hidden /> : null}
            {card.overdue ? `Overdue: ${due.text}` : `Due ${due.text}`}
          </span>
        ) : card.closed ? (
          <span className="ml-auto">Closed {whenLabel(card.closed.at, now, timezone)}</span>
        ) : null}
      </span>
    </button>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-10 text-center">
      <p className="text-base font-semibold text-strong">{title}</p>
      <p className="mx-auto mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">{body}</p>
      {action ? <div className="mt-4 flex justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export function OpenLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium text-brand-300 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-brand-500">
      {children}
      <ArrowUpRight className="size-3.5" aria-hidden />
    </Link>
  );
}

export function Stat({ label, value, hint, href, tone }: { label: string; value: string; hint?: string; href?: string; tone?: "warn" }) {
  const body = (
    <>
      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className={cn("font-heading text-2xl leading-none tracking-tight tabular-nums", tone === "warn" ? "text-warning-foreground" : "text-strong")}>{value}</span>
      {hint ? <span className="text-[11px] leading-snug text-muted-foreground">{hint}</span> : null}
    </>
  );
  const shell = "grid content-start gap-1.5 rounded-xl border border-border bg-background px-3.5 py-3";
  return href ? (
    <Link href={href} className={cn(shell, "hover:border-brand-500/50 focus-visible:outline-2 focus-visible:outline-brand-500")}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}

/** "What I checked", "What I found", "What happens next", from a real run. Empty columns say so. */
export function RunTrace({ checked, found, next, at, now, timezone, blockedReason }: { checked: string[]; found: string[]; next: string[]; at?: number | null; now: number; timezone: string; blockedReason?: string | null }) {
  const columns = [
    { title: "What I checked", rows: checked, empty: "Nothing checked yet." },
    { title: "What I found", rows: found, empty: "Nothing to report." },
    { title: "What happens next", rows: next, empty: blockedReason ?? "Nothing is waiting on Quality." },
  ];
  return (
    <div className="grid gap-3">
      {at ? <p className="text-xs text-muted-foreground">From Quality&rsquo;s run {whenLabel(at, now, timezone)}.</p> : null}
      <div className="grid gap-3 md:grid-cols-3">
        {columns.map((col) => (
          <div key={col.title} className="rounded-xl border border-border bg-background p-3.5">
            <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{col.title}</p>
            {col.rows.length ? (
              <ul className="mt-2 grid gap-1.5 text-sm leading-snug text-foreground">
                {col.rows.map((row, i) => (
                  <li key={`${i}:${row}`} className="flex gap-2">
                    <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand-400" />
                    <span>{row}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">{col.empty}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const GAP_WORDS: Record<string, string> = { not_found: "Not found", no_access: "No access", not_connected: "Not connected", processing: "Still processing", stale: "May be stale", needs_association: "Needs review", restricted: "Restricted" };

/** The assembled evidence: what was found, and, kept beside it, what was not found, not accessible, processing or stale. */
export function EvidenceSections({ sections, now, timezone }: { sections: Section[]; now: number; timezone: string }) {
  return (
    <div className="grid gap-4">
      {sections.map((section) => (
        <section key={section.id} className="rounded-2xl border border-border bg-background">
          <h4 className="border-b border-border px-4 py-2.5 text-sm font-semibold text-strong">{section.title}</h4>
          <ul className="divide-y divide-border">
            {section.items.map((item, i) => (
              <li key={`${section.id}:${i}`} className="grid gap-1 px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <BasisTag basis={item.basis} />
                  <span className="text-xs font-semibold text-strong">{item.label}</span>
                  {item.at ? <span className="text-[11px] text-muted-foreground">{item.atKind === "received" ? "Received " : item.atKind === "recorded" ? "Recorded " : item.atKind === "scheduled" ? "Scheduled " : ""}{whenLabel(item.at, now, timezone)}</span> : null}
                </div>
                <p className="text-sm leading-snug text-foreground">{item.detail}</p>
              </li>
            ))}
            {section.gaps.map((gap, i) => (
              <li key={`${section.id}:gap:${i}`} className="flex flex-wrap items-start gap-2 bg-muted/30 px-4 py-2.5">
                <span className="inline-flex h-5 items-center rounded-md border border-dashed border-border px-1.5 text-[11px] font-medium text-muted-foreground">{GAP_WORDS[gap.state] ?? gap.state}</span>
                <p className="min-w-0 flex-1 text-sm leading-snug text-muted-foreground">{gap.what}</p>
              </li>
            ))}
            {!section.items.length && !section.gaps.length ? <li className="px-4 py-2.5 text-sm text-muted-foreground">Nothing here.</li> : null}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><Hourglass className="mt-0.5 size-3.5 shrink-0" aria-hidden />{children}</p>;
}
