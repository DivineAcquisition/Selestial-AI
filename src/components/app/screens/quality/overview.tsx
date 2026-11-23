"use client";

/**
 * Quality's overview: what the agent is working on now, what needs a person, what is waiting on evidence,
 * decisions to make, recent outcomes, and anything wrong with its connections or its own work. Every count
 * is a count of records; the work list is Quality's real runs, with what each checked and found.
 */
import { useMutation, useQuery } from "convex/react";

import { AgentAvatar, eyebrow } from "@/components/app/agent";
import { useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { PageHeader, Panel } from "@/components/app/shell";
import { useNow } from "@/components/app/use-now";
import { AlertTriangle, PauseCircleIcon, Play } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { whenLabel } from "@/lib/app/format";
import { useStableQuery } from "@/lib/app/stable-query";
import { cn } from "@/lib/utils";

import { api } from "../../../../../convex/_generated/api";
import { CaseWorkspace } from "./case-workspace";
import { CaseCardView, Empty, OpenLink, plural, QUALITY_PATH, RunTrace, Stat, useParam, type Overview } from "./shared";

const LEAD = "Makes your service promise measurable, finds where delivery fell short, and helps the business improve with every completed job.";

const RUN_WORDS: Record<string, string> = {
  completion_submitted: "Reviewed a visit the crew reported done",
  evidence_added: "Read evidence that arrived after a review",
  message_received: "Read a call or text",
  transcript_available: "Read a call transcript",
  feedback_submitted: "Investigated a reported concern",
  statement_submitted: "Took in an account or answer",
  correction_completed: "Checked a correction visit",
  case_outcome: "Read a customer outcome from Retention",
  financial_settled: "Read a credit or refund from Finance",
  pre_service: "Checked a visit before it happens",
  upkeep: "Upkeep: requests, corrections, patterns",
  interpret: "AI reading of a case's evidence",
  pattern_scan: "Looked for repeated patterns",
  comms_sync: "Read the phone platform",
  remedy_approved: "Followed an approved remedy",
};
const STATUS_WORDS: Record<string, string> = { queued: "Queued", running: "Running", done: "Done", skipped: "Skipped", blocked: "Waiting", failed: "Could not finish", cancelled: "Cancelled" };

function header(overview: Overview): { state: string; tone: "warning" | "success" | "outline"; lines: string[]; next: string } {
  const c = overview.counts;
  const state = !overview.agent.ok ? (overview.agent.paused ? "Paused" : "Not running") : c.decisions > 0 || c.serious > 0 ? "Waiting on you" : c.waiting > 0 ? "Waiting on evidence" : c.cases > 0 ? "Working" : "Nothing open";
  const lines = [
    !overview.agent.ok ? (overview.agent.reason ?? "Quality's agent work is not running.") : null,
    overview.readiness.baseline ? "No Quality standard is published yet: visits are reviewed against the checklist and Dispatch's photo rules already on record." : `${plural(overview.readiness.standards, "published standard")} in force.`,
    c.cases ? `${plural(c.cases, "open case")}${c.restrictedHidden ? ` (and ${c.restrictedHidden} restricted to the Owner)` : ""}.` : "No quality case is open. That is what the record shows, not a statement that every visit went well.",
  ].filter((line): line is string => Boolean(line));
  const first = overview.needsAttention[0];
  const next = c.serious ? "A serious concern needs the Owner. Open it from Needs attention." : first ? `${first.title}: ${first.needs ?? first.doing}` : overview.reviews[0] ? "A visit's review needs a decision." : c.waiting ? "Waiting for cleaners to send what was asked for." : "Nothing is waiting on you.";
  return { state, tone: state === "Waiting on you" || state === "Paused" || state === "Not running" ? "warning" : state === "Nothing open" ? "outline" : "success", lines, next };
}

export function QualityOverviewScreen() {
  const { companyId, timezone, role } = useCompany();
  const now = useNow();
  const { openId, open, close } = useParam("case");
  const overview = useStableQuery(api.quality.overview, now ? { companyId, asOf: now } : "skip");
  const permissions = useQuery(api.permissions.list, { companyId });
  const setPaused = useMutation(api.companies.setPausedAgents);
  const { busy, error, run } = useRun();

  if (!overview) {
    return (
      <>
        <PageHeader title="Quality" lead={LEAD} />
        <div className="grid gap-5" aria-busy="true" aria-label="Loading Quality">
          <Skeleton className="h-44 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      </>
    );
  }
  const c = overview.counts;
  const h = header(overview);
  const pausedAgents = permissions?.pausedAgents ?? [];
  return (
    <>
      <PageHeader
        title="Quality"
        lead={LEAD}
        actions={
          role === "owner" ? (
            <Button variant="outline" size="sm" loading={busy} onClick={() => run(() => setPaused({ companyId, agents: overview.agent.paused ? pausedAgents.filter((a: string) => a !== "quality") : [...pausedAgents, "quality"] }))}>
              {overview.agent.paused ? <Play className="size-4" aria-hidden /> : <PauseCircleIcon className="size-4" aria-hidden />}
              {overview.agent.paused ? "Resume Quality" : "Pause Quality"}
            </Button>
          ) : null
        }
      />
      <FormError message={error} />
      <div className="grid gap-5">
        <section className="relative overflow-hidden rounded-2xl border border-border bg-card">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(120%_140%_at_0%_0%,color-mix(in_oklab,var(--color-brand-500)_12%,transparent),transparent_70%)]" />
          <div className="relative flex items-start gap-3 p-4 sm:gap-4 sm:p-5">
            <AgentAvatar agent="quality" size="md" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={h.tone} size="sm">{h.state}</Badge>
                {overview.readiness.sources.map((s) => (
                  <Badge key={s.id} variant="outline" size="sm">
                    <span aria-hidden className={cn("size-1.5 rounded-full", s.state === "connected" ? "bg-success" : s.state === "needs_attention" ? "bg-warning" : "bg-muted-foreground/50")} />
                    {s.name}
                    <span className="sr-only">: {s.state.replace(/_/g, " ")}</span>
                  </Badge>
                ))}
              </div>
              <p className={cn(eyebrow, "mt-3")}>Make the service promise measurable</p>
              <div className="mt-1.5 grid gap-1">
                {h.lines.map((line) => (
                  <p key={line} className="text-sm leading-relaxed text-foreground">{line}</p>
                ))}
              </div>
            </div>
          </div>
          <div className="relative border-t border-border bg-background/60 px-4 py-3 text-sm text-strong sm:px-5">
            <span className="font-semibold">Next: </span>
            {h.next}
          </div>
        </section>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Decisions" value={String(c.decisions)} hint="Cases and reviews waiting on a person" href={`${QUALITY_PATH}/cases`} tone={c.decisions ? "warn" : undefined} />
          <Stat label="Waiting on evidence" value={String(c.waiting)} hint="Requests out or awaiting approval" href={`${QUALITY_PATH}/reviews`} />
          <Stat label="Open cases" value={String(c.cases)} href={`${QUALITY_PATH}/cases`} />
          <Stat label="Link reviews" value={String(c.associations)} hint="Conversations a person matches to a visit" href={`${QUALITY_PATH}/playbook#associations`} tone={c.associations ? "warn" : undefined} />
          <Stat label="Closed, 14 days" value={String(c.verifiedRecently)} hint="With what actually happened" />
        </div>

        {overview.problems.length ? (
          <Panel title="Connections and work that need attention">
            <ul className="grid gap-2 p-4">
              {overview.problems.map((p) => (
                <li key={p.words} className="flex flex-wrap items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 px-3.5 py-3 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 text-strong">{p.words}</span>
                  {p.action ? <OpenLink href={p.action.href}>{p.action.label}</OpenLink> : null}
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        <Panel title="Needs attention" action={<OpenLink href={`${QUALITY_PATH}/cases`}>All cases</OpenLink>}>
          <div className="grid gap-3 p-4">
            {overview.needsAttention.length ? overview.needsAttention.map((card) => <CaseCardView key={card.id} card={card} now={now} timezone={timezone} onOpen={open} />) : <Empty title="Nothing needs a decision" body="When a review, a report or a conversation needs a person, it appears here with what was found and what is missing." />}
          </div>
        </Panel>

        <div className="grid gap-5 lg:grid-cols-2">
          <Panel title="Reviews waiting on a decision" action={<OpenLink href={`${QUALITY_PATH}/reviews`}>Reviews</OpenLink>}>
            <ul className="divide-y divide-border">
              {overview.reviews.length ? overview.reviews.map((r) => (
                <li key={r.id} className="grid gap-1 px-4 py-3">
                  <a href={`${QUALITY_PATH}/reviews?review=${r.id}`} className="text-sm font-semibold text-strong hover:underline">{r.job ? `${r.job.customer?.name ?? "A client"} · ${r.job.service}, ${r.job.day}` : "A visit"}</a>
                  <p className="text-sm text-muted-foreground">{r.words}</p>
                  {r.reopened ? <p className="text-xs text-warning-foreground">Reopened: {r.reopened.reason}</p> : null}
                </li>
              )) : <li className="px-4 py-6 text-sm text-muted-foreground">No review is waiting on a decision.</li>}
            </ul>
          </Panel>
          <Panel title="Waiting on evidence">
            <ul className="divide-y divide-border">
              {overview.waiting.length ? overview.waiting.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="block font-medium text-strong">{w.purpose} · {w.who}</span>
                    <span className="block text-xs text-muted-foreground">{w.statusWords}{w.job ? ` · ${w.job.service}, ${w.job.day}` : ""}</span>
                  </span>
                  <span className={cn("text-xs", w.overdue ? "font-semibold text-destructive-foreground" : "text-muted-foreground")}>{w.overdue ? "Past due" : `Due ${whenLabel(w.dueAt, now, timezone)}`}</span>
                </li>
              )) : <li className="px-4 py-6 text-sm text-muted-foreground">Nothing is waiting on a cleaner or a customer.</li>}
            </ul>
          </Panel>
        </div>

        <Panel title="What Quality has been doing">
          <div className="grid gap-3 p-4">
            <p className="text-xs text-muted-foreground">
              {c.decisions || c.waiting ? null : "Quiet. "}
              {overview.work.counts.running} running · {overview.work.counts.queued} queued · {overview.work.counts.blocked} waiting · {overview.work.counts.failed} could not finish
            </p>
            {overview.work.recent.length ? (
              <ol className="grid gap-3">
                {overview.work.recent.map((r) => (
                  <li key={r.id} className="rounded-xl border border-border bg-background p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-strong">{RUN_WORDS[r.kind] ?? r.kind}</p>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant={r.status === "failed" ? "error" : r.status === "blocked" ? "warning" : "outline"} size="sm">{STATUS_WORDS[r.status] ?? r.status}</Badge>
                        {whenLabel(r.at, now, timezone)}
                      </span>
                    </div>
                    {r.result ? <p className="mt-1 text-sm text-foreground">{r.result}</p> : null}
                    {r.checked.length || r.found.length || r.next.length || r.blockedReason ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-medium text-brand-300">What I checked, found and will do next</summary>
                        <div className="mt-2">
                          <RunTrace checked={r.checked} found={r.found} next={r.next} now={now} timezone={timezone} blockedReason={r.blockedReason} />
                        </div>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <Empty title="No work yet" body="Quality starts when a crew reports a visit done, evidence arrives, or a concern is reported." />
            )}
          </div>
        </Panel>

        <Panel title="Recently closed">
          <div className="grid gap-3 p-4">
            {overview.outcomes.length ? overview.outcomes.map((card) => <CaseCardView key={card.id} card={card} now={now} timezone={timezone} onOpen={open} />) : <p className="text-sm text-muted-foreground">No case closed in the last 14 days.</p>}
          </div>
        </Panel>
      </div>
      <CaseWorkspace id={openId} onClose={close} />
    </>
  );
}
