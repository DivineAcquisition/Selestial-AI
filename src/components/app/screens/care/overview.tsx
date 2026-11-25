"use client";

/**
 * Client Care's overview: a short brief read from the record. What came in, what Care finished, what is blocked,
 * which promised updates are due, and what is waiting on you. Every number is a count of records; no time saved
 * or productivity is claimed.
 */
import { useMutation } from "convex/react";

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
import { Empty, OpenLink, Stat } from "../quality/shared";
import { RequestWorkspace } from "./request-workspace";
import { CARE_NAME, CARE_PATH, plural, RequestCard, useRequestParam, type CareOverview } from "./shared";

export const CARE_LEAD = "Understands each client request, coordinates the action needed with the agent or system that owns it, and keeps the client informed until it is actually resolved.";

function header(o: CareOverview): { state: string; tone: "warning" | "success" | "outline"; lines: string[]; next: string } {
  const c = o.counts;
  const state = o.agent.paused ? "Paused" : !o.agent.available ? "Recording only" : c.decisions > 0 || o.urgent.length > 0 ? "Waiting on you" : c.open > 0 ? "Working" : "Nothing open";
  const lines = [
    o.agent.reason,
    c.open ? `${plural(c.open, "open request")}: ${c.waitingClient} waiting on clients, ${c.waitingTeam} with the team, ${c.decisions} with you.` : "No client request is open. That is what the record shows, not a claim that every client is happy.",
    `${c.resolvedWeek} resolved and ${plural(c.stepsDoneWeek, "step")} carried out by Client Care in the last 7 days.`,
    o.agent.reader,
  ].filter((line): line is string => Boolean(line));
  const first = o.urgent[0] ?? o.decisions[0];
  const next = o.urgent[0] ? `Urgent: ${o.urgent[0].customer.name}, ${o.urgent[0].categoryWords.toLowerCase()}.` : first ? `${first.customer.name}: ${first.blocker ?? first.waiting ?? first.summary}` : o.dueUpdates[0] ? `A promised update to ${o.dueUpdates[0].customer.name} is due.` : "Nothing is waiting on you.";
  return { state, tone: state === "Waiting on you" || state === "Paused" || state === "Recording only" ? "warning" : state === "Nothing open" ? "outline" : "success", lines, next };
}

export function CareOverviewScreen() {
  const { companyId, timezone, role } = useCompany();
  const now = useNow();
  const { openId, open, close } = useRequestParam();
  const overview = useStableQuery(api.clientCare.overview, now ? { companyId, asOf: now } : "skip");
  const pause = useMutation(api.companies.pauseAgent);
  const resume = useMutation(api.companies.resumeAgent);
  const { busy, error, run } = useRun();

  if (!overview) {
    return (
      <>
        <PageHeader title={CARE_NAME} lead={CARE_LEAD} />
        <div className="grid gap-5" aria-busy="true" aria-label="Loading Client Care">
          <Skeleton className="h-44 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      </>
    );
  }
  const c = overview.counts;
  const h = header(overview);
  return (
    <>
      <PageHeader
        title={CARE_NAME}
        lead={CARE_LEAD}
        actions={
          role === "owner" ? (
            <Button variant="outline" size="sm" loading={busy} onClick={() => run(() => (overview.agent.paused ? resume({ companyId, agent: "customer-care" }) : pause({ companyId, agent: "customer-care" })))}>
              {overview.agent.paused ? <Play className="size-4" aria-hidden /> : <PauseCircleIcon className="size-4" aria-hidden />}
              {overview.agent.paused ? "Resume Client Care" : "Pause Client Care"}
            </Button>
          ) : null
        }
      />
      <FormError message={error} />
      <div className="grid gap-5">
        <section className="relative overflow-hidden rounded-2xl border border-border bg-card">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(120%_140%_at_0%_0%,color-mix(in_oklab,var(--color-brand-500)_12%,transparent),transparent_70%)]" />
          <div className="relative flex items-start gap-3 p-4 sm:gap-4 sm:p-5">
            <AgentAvatar agent="customer-care" size="md" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={h.tone} size="sm">
                  {h.state}
                </Badge>
              </div>
              <p className={cn(eyebrow, "mt-3")}>Resolved, not just replied to</p>
              <div className="mt-1.5 grid gap-1">
                {h.lines.map((line) => (
                  <p key={line} className="text-sm leading-relaxed text-foreground">
                    {line}
                  </p>
                ))}
              </div>
            </div>
          </div>
          <div className="relative border-t border-border bg-background/60 px-4 py-3 text-sm text-strong sm:px-5">
            <span className="font-semibold">Next: </span>
            {h.next}
          </div>
        </section>

        {overview.unread ? (
          <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 px-3.5 py-3 text-sm text-strong">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden />
            {plural(overview.unread.count, "client message")} {overview.unread.count === 1 ? "is" : "are"} kept and not yet read{overview.agent.paused ? " because Client Care is paused" : ""}. The oldest arrived {now ? whenLabel(overview.unread.oldest, now, timezone) : ""}; each is in the client's conversation.
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="New today" value={String(c.newToday)} href={`${CARE_PATH}/requests`} />
          <Stat label="With you" value={String(c.decisions)} hint="Requests waiting on a person" href={`${CARE_PATH}/requests?status=waiting_owner`} tone={c.decisions ? "warn" : undefined} />
          <Stat label="Blocked" value={String(c.blocked)} hint="A step that didn't go through" href={`${CARE_PATH}/follow-ups`} tone={c.blocked ? "warn" : undefined} />
          <Stat label="Updates due" value={String(c.dueUpdates)} hint="Promised to clients in the next 4 hours or late" href={`${CARE_PATH}/follow-ups`} tone={c.dueUpdates ? "warn" : undefined} />
          <Stat label="Resolved, 7 days" value={String(c.resolvedWeek)} hint="With the outcome on the record" />
        </div>

        {overview.urgent.length ? (
          <Panel title="Urgent">
            <div className="grid gap-3 p-4">
              {overview.urgent.map((card) => (
                <RequestCard key={card.id} card={card} now={now} timezone={timezone} onOpen={open} />
              ))}
            </div>
          </Panel>
        ) : null}

        <Panel title="Waiting on you" action={<OpenLink href={`${CARE_PATH}/requests`}>All requests</OpenLink>}>
          <div className="grid gap-3 p-4">
            {overview.decisions.length ? overview.decisions.map((card) => <RequestCard key={card.id} card={card} now={now} timezone={timezone} onOpen={open} />) : <Empty title="Nothing needs you" body="When a request needs a decision, an approval or a person to step in, it appears here with what Client Care found and what is missing." />}
          </div>
        </Panel>

        <div className="grid gap-5 lg:grid-cols-2">
          <Panel title="Promised updates due" action={<OpenLink href={`${CARE_PATH}/follow-ups`}>Follow-ups</OpenLink>}>
            <ul className="divide-y divide-border">
              {overview.dueUpdates.length ? (
                overview.dueUpdates.map((card) => (
                  <li key={card.id}>
                    <button type="button" onClick={() => open(card.id)} className="grid w-full gap-0.5 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-brand-500">
                      <span className="text-sm font-semibold text-strong">{card.customer.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {card.categoryWords} · update promised {now && card.promisedBy ? whenLabel(card.promisedBy, now, timezone) : ""}
                      </span>
                    </button>
                  </li>
                ))
              ) : (
                <li className="px-4 py-6 text-sm text-muted-foreground">No promised update is due.</li>
              )}
            </ul>
          </Panel>
          <Panel title="Steps that didn't go through">
            <ul className="divide-y divide-border">
              {overview.troubled.length ? (
                overview.troubled.map((s) => (
                  <li key={s.stepId}>
                    <button type="button" onClick={() => open(s.requestId)} className="grid w-full gap-0.5 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-brand-500">
                      <span className="text-sm font-medium text-strong [overflow-wrap:anywhere]">{s.summary}</span>
                      <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {s.words}
                        {s.result ? `: ${s.result}` : ""}
                      </span>
                    </button>
                  </li>
                ))
              ) : (
                <li className="px-4 py-6 text-sm text-muted-foreground">Nothing failed or is uncertain on an open request.</li>
              )}
            </ul>
          </Panel>
        </div>

        <Panel title="What Client Care has been doing">
          <div className="grid gap-3 p-4">
            {overview.activity.length ? (
              <ol className="grid gap-2.5">
                {overview.activity.map((a) => (
                  <li key={`${a.requestId}:${a.at}`}>
                    <button type="button" onClick={() => open(a.requestId)} className="grid w-full gap-0.5 rounded-xl border border-border bg-background px-3.5 py-3 text-left hover:border-brand-500/50 focus-visible:outline-2 focus-visible:outline-brand-500">
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-strong">{a.customer}</span>
                        <span className="text-xs text-muted-foreground">{now ? whenLabel(a.at, now, timezone) : ""}</span>
                      </span>
                      <span className="text-sm text-foreground [overflow-wrap:anywhere]">{a.text}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <Empty title="No work yet" body="Client Care starts when a client texts the company's number, or emails the Care & Retention inbox once reading is on in Care Setup." />
            )}
          </div>
        </Panel>
      </div>
      <RequestWorkspace id={openId} onClose={close} />
    </>
  );
}
