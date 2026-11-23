"use client";

/** Quality cases, filtered by urgency, owner, stage, service and property, each with its clear next step. */
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { PageHeader } from "@/components/app/shell";
import { useNow } from "@/components/app/use-now";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useStableQuery } from "@/lib/app/stable-query";

import { api } from "../../../../../convex/_generated/api";
import { CaseWorkspace } from "./case-workspace";
import { CaseCardView, Empty, useParam } from "./shared";

const STAGES = [
  ["open", "Open"],
  ["needs_decision", "Needs decision"],
  ["investigating", "Investigating"],
  ["action_underway", "Action underway"],
  ["verifying", "Verifying"],
  ["closed", "Closed"],
] as const;

export function QualityCasesScreen() {
  const { companyId, timezone, role } = useCompany();
  const now = useNow();
  const [stage, setStage] = useState<(typeof STAGES)[number][0]>("open");
  const [urgency, setUrgency] = useState<"" | "urgent" | "normal" | "low">("");
  const [service, setService] = useState("");
  const data = useStableQuery(api.quality.cases, { companyId, stage, urgency: urgency || undefined, service: service.trim() || undefined });
  const { openId, open, close } = useParam("case");
  return (
    <>
      <PageHeader title="Cases" lead="Quality investigations. A report is not a finding; findings count only once a person reviews them, and a case closes with what actually happened." />
      <div className="mb-4 grid gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Stage">
          {STAGES.map(([id, label]) => <Button key={id} size="sm" variant={stage === id ? "secondary" : "ghost"} aria-pressed={stage === id} onClick={() => setStage(id)}>{label}</Button>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-muted-foreground" htmlFor="q-urgency">Urgency</label>
          <select id="q-urgency" className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm" value={urgency} onChange={(e) => setUrgency(e.target.value as typeof urgency)}>
            <option value="">Any</option>
            <option value="urgent">Urgent</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
          <label className="text-xs text-muted-foreground" htmlFor="q-service">Service</label>
          <input id="q-service" className="h-9 w-40 rounded-lg border border-input bg-background px-2.5 text-sm" placeholder="Any service" value={service} onChange={(e) => setService(e.target.value)} />
        </div>
      </div>
      {data === undefined ? (
        <div className="grid gap-3" aria-busy="true"><Skeleton className="h-40 rounded-2xl" /><Skeleton className="h-40 rounded-2xl" /></div>
      ) : (
        <div className="grid gap-3">
          {data.cases.length ? data.cases.map((card) => <CaseCardView key={card.id} card={card} now={now} timezone={timezone} onOpen={open} />) : <Empty title="No cases here" body="Cases open from completion reviews, customer concerns, calls and texts, cleaners' reports, or a confirmed pattern." />}
          {data.hidden ? <p className="text-xs text-muted-foreground">{data.hidden} restricted {data.hidden === 1 ? "case is" : "cases are"} not shown: {role === "owner" ? "" : "they are the Owner's."}</p> : null}
        </div>
      )}
      <CaseWorkspace id={openId} onClose={close} />
    </>
  );
}
