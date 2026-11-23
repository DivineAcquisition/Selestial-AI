"use client";

/**
 * What the reviewed records show over a period: confirmed issue patterns with their denominators,
 * documentation coverage (which is not service quality), correction costs and outcomes, how quickly cases got
 * a first action and corrections were verified, repeat issues, and the improvements Quality proposes. Counts
 * only; a small sample is said to be too small to read, and nothing is a score or a prediction.
 */
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { PageHeader, Panel } from "@/components/app/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { money } from "@/lib/app/format";
import { useStableQuery } from "@/lib/app/stable-query";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { Empty, Stat } from "./shared";

const duration = (ms: number | null) => (ms === null ? "No figure yet" : ms < 60_000 ? "Under a minute" : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 86_400_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${(ms / 86_400_000).toFixed(1)} days`);

export function QualityInsightsScreen() {
  const { companyId, role } = useCompany();
  const [days, setDays] = useState<30 | 90>(90);
  const data = useStableQuery(api.quality.insights, { companyId, days });
  const submit = useMutation(api.quality.submitImprovementAction);
  const withdraw = useMutation(api.quality.withdrawImprovement);
  const { busy, error, run } = useRun();
  const rates = useQuery(api.quality.cleanerRates, role === "office" ? "skip" : { companyId });
  return (
    <>
      <PageHeader title="Insights" lead="Patterns in reviewed findings, how well visits are documented, each cleaner's visit pass rate, what corrections cost, and the changes Quality proposes. Counts with their denominators." actions={<div className="flex gap-1" role="group" aria-label="Period">{([30, 90] as const).map((d) => <Button key={d} size="sm" variant={days === d ? "secondary" : "ghost"} aria-pressed={days === d} onClick={() => setDays(d)}>{d} days</Button>)}</div>} />
      {data === undefined ? (
        <Skeleton className="h-64 rounded-2xl" aria-busy="true" />
      ) : (
        <div className="grid gap-5">
          <p className="text-sm text-muted-foreground">{data.note}</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Visits reviewed" value={`${data.coverage.reviewed} of ${data.coverage.completedVisits}`} hint="Visits reported done in the period that Quality reviewed" />
            <Stat label="Fully documented" value={`${data.coverage.fullyDocumented} of ${data.coverage.reviewsCounted}`} hint="Documentation, not how the service looked" />
            <Stat label="Time to first action" value={duration(data.timing.firstActionMs)} hint={`Median across ${data.timing.firstActionCount} cases`} />
            <Stat label="Time to verification" value={duration(data.timing.verificationMs)} hint={`Median across ${data.timing.verificationCount} corrections`} />
          </div>
          <Panel title="Confirmed issue patterns">
            {data.patterns.length ? (
              <ul className="divide-y divide-border">
                {data.patterns.map((p) => <li key={`${p.category}:${p.area}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"><span><span className="font-medium text-strong">{p.categoryWords}</span>{p.area ? ` · ${p.area}` : ""}</span><span className="text-muted-foreground tabular-nums">{p.cases} {p.cases === 1 ? "case" : "cases"} at {p.properties} {p.properties === 1 ? "property" : "properties"}, of {p.denominator} visits reported done</span></li>)}
              </ul>
            ) : <p className="p-4 text-sm text-muted-foreground">No reviewed findings in this period.</p>}
          </Panel>
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="Corrections">
              <ul className="grid gap-1.5 p-4 text-sm">
                <li>{data.corrections.count} prepared · {data.corrections.verified} verified by Quality · {data.corrections.notVerified} not verified</li>
                <li>Customer: {data.corrections.customerConfirmed} confirmed · {data.corrections.customerDissatisfied} not resolved · {data.corrections.noResponse} no response</li>
                {role === "owner" ? <li>Crew cost: estimated {money(data.corrections.estimatedCents ?? 0)}, recorded {money(data.corrections.actualCents ?? 0)}{data.corrections.unknownCost ? ` · ${data.corrections.unknownCost} with no reliable estimate` : ""}</li> : <li className="text-muted-foreground">Costs are shown to the Owner.</li>}
              </ul>
            </Panel>
            <Panel title="Repeat issues">
              {data.repeats.length ? <ul className="grid gap-1.5 p-4 text-sm">{data.repeats.map((r) => <li key={`${r.category}:${r.area}`}>{r.category}{r.area ? ` · ${r.area}` : ""}: {r.cases} cases at {r.properties} {r.properties === 1 ? "property" : "properties"}</li>)}</ul> : <p className="p-4 text-sm text-muted-foreground">No reviewed issue repeated at the same property in this period.</p>}
            </Panel>
          </div>
          <Panel title="Cleaners: visit pass rate">
            {role === "office" ? (
              <p className="p-4 text-sm text-muted-foreground">Shown to managers and the Owner.</p>
            ) : rates === undefined ? (
              <Skeleton className="m-4 h-24 rounded-xl" />
            ) : (
              <div className="grid gap-3 p-4">
                <p className="text-xs text-muted-foreground">{rates.note}</p>
                {rates.rows.length ? (
                  <ul className="divide-y divide-border rounded-xl border border-border">
                    {rates.rows.map((r) => (
                      <li key={r.cleanerId} className="grid gap-1 px-3.5 py-2.5 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
                        <span className="text-sm font-medium text-strong">{r.name}</span>
                        <span className="text-xs text-muted-foreground">{r.words}</span>
                        <span className="text-sm font-semibold text-strong tabular-nums" data-pass-rate>{r.rate === null ? "Too few visits" : `${Math.round(r.rate * 100)}%`}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted-foreground">No reviewed visits with a crew in the last {rates.windowDays} days.</p>}
              </div>
            )}
          </Panel>
          <Panel title="Proposed improvements">
            <div className="grid gap-3 p-4">
              {data.improvements.length ? data.improvements.map((i) => (
                <div key={i.id} className="grid gap-2 rounded-xl border border-border bg-background p-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-strong">{i.title}</span>
                    <Badge variant={i.state === "adopted" || i.state === "evaluated" ? "success" : i.state === "declined" || i.state === "withdrawn" ? "outline" : "info"} size="sm">{i.state.replace(/_/g, " ")}</Badge>
                    <span className="text-xs text-muted-foreground">{i.kindWords} · carried out by {i.owner === "owner" ? "the Owner" : i.owner}</span>
                  </div>
                  <p className="text-sm text-foreground">{i.change}</p>
                  <p className="text-xs text-muted-foreground">Evidence: {i.evidence.count} reviewed {i.evidence.count === 1 ? "case" : "cases"} of {i.evidence.denominator} {i.evidence.denominatorLabel}, over {i.evidence.windowDays} days. Expected: {i.expected}</p>
                  <p className="text-xs text-muted-foreground">How it will be read: {i.evaluation.measure}, over {i.evaluation.windowDays} days after adoption.</p>
                  {i.result ? <p className="text-xs text-strong">Result: {i.result.words}</p> : null}
                  {i.state === "proposed" && role !== "office" ? (
                    <div className="flex gap-2">
                      <Button size="sm" loading={busy} onClick={() => run(() => submit({ companyId, improvementId: i.id as Id<"qualityImprovements"> }))}>Send to the Owner to decide</Button>
                      <Button size="sm" variant="ghost" loading={busy} onClick={() => run(() => withdraw({ companyId, improvementId: i.id as Id<"qualityImprovements"> }))}>Withdraw</Button>
                    </div>
                  ) : null}
                </div>
              )) : <Empty title="No proposals yet" body="Quality proposes a change only from findings a person reviewed, when the same issue repeats often enough to be worth acting on." />}
              <FormError message={error} />
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}
