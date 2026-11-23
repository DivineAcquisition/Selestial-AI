"use client";

/**
 * Quality where the work already is: on a visit, a client, a property, a cleaner and a Retention case. Each
 * panel shows only what Quality holds about that record, links to the case for everything else, and never
 * shows a score, a ranking or a fault count.
 */
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { canManage, useCompany } from "@/components/app/company";
import { FormError, TextArea, useRun } from "@/components/app/form";
import { useNow } from "@/components/app/use-now";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { whenLabel } from "@/lib/app/format";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { type CaseCard, QUALITY_PATH, StagePill } from "./shared";

const caseHref = (id: string) => `${QUALITY_PATH}/cases?case=${id}`;

function CaseRow({ card }: { card: CaseCard }) {
  return (
    <li>
      <Link href={caseHref(card.id)} className="grid gap-1 rounded-lg border border-border px-3 py-2 text-sm hover:border-brand-500/50 focus-visible:outline-2 focus-visible:outline-brand-500">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-strong">{card.title}</span>
          <StagePill stage={card.stage} words={card.stageWords} />
        </span>
        <span className="text-xs text-muted-foreground">{card.needs ?? card.doing}</span>
      </Link>
    </li>
  );
}

function Cases({ open, recent, empty }: { open: CaseCard[]; recent: CaseCard[]; empty: string }) {
  if (!open.length && !recent.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="grid gap-3">
      {open.length ? <ul className="grid gap-1.5">{open.map((c) => <CaseRow key={c.id} card={c} />)}</ul> : null}
      {recent.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground">Recently closed ({recent.length})</summary>
          <ul className="mt-2 grid gap-1.5">{recent.map((c) => <CaseRow key={c.id} card={c} />)}</ul>
        </details>
      ) : null}
    </div>
  );
}

/** On a visit: its completion review, open cases, who Quality is waiting on, and a way to report a concern. */
export function QualityOnJob({ jobId, completed }: { jobId: Id<"jobs">; completed: boolean }) {
  const { companyId, role, timezone } = useCompany();
  const now = useNow();
  const data = useQuery(api.quality.forJob, { companyId, jobId });
  const report = useMutation(api.quality.reportConcern);
  const reviewNow = useMutation(api.quality.reviewNow);
  const { busy, error, run } = useRun();
  const [writing, setWriting] = useState(false);
  const [words, setWords] = useState("");
  if (data === undefined) return null;
  const manager = canManage(role);
  return (
    <div className="grid gap-3 text-sm">
      {data.review ? (
        <div className="grid gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={data.review.status === "approved" ? "success" : data.review.status === "needs_decision" ? "warning" : "outline"} size="sm">{data.review.statusWords}</Badge>
            {data.review.words ? <span className="text-xs text-muted-foreground">Recommends: {data.review.words}</span> : null}
          </span>
          <p className="text-strong">{data.review.summary}</p>
          <p className="text-xs text-muted-foreground">Record: {data.review.completeness.met} met · {data.review.completeness.missing} missing{data.review.completeness.contradictory ? ` · ${data.review.completeness.contradictory} contradictory` : ""}. A complete record is not proof of how the service looked.</p>
          <Link href={`${QUALITY_PATH}/reviews?review=${data.review.id}`} className="text-xs font-medium text-brand-300 underline-offset-4 hover:underline">Open the review</Link>
        </div>
      ) : completed ? (
        <p className="text-muted-foreground">No Quality review of this visit yet.</p>
      ) : (
        <p className="text-muted-foreground">Quality reviews the visit once the crew reports it done. It never holds the visit, the invoice or anyone&rsquo;s pay.</p>
      )}
      {data.correction ? <p className="text-xs text-muted-foreground">This is a correction visit · {data.correction.state} · must show: {data.correction.acceptance}{data.correction.verification ? ` · ${data.correction.verification}` : ""}</p> : null}
      {data.cases.length ? <ul className="grid gap-1.5">{data.cases.map((c) => <CaseRow key={c.id} card={c} />)}</ul> : null}
      {data.waitingOn.length ? (
        <ul className="grid gap-1 text-xs text-muted-foreground">
          {data.waitingOn.map((w) => <li key={w.id}>Waiting on {w.who}: {w.purpose.toLowerCase()} · {w.status}{w.dueAt ? ` · due ${whenLabel(w.dueAt, now, timezone)}` : ""}</li>)}
        </ul>
      ) : null}
      {manager ? (
        writing ? (
          <div className="grid gap-2 rounded-xl border border-border bg-muted p-3">
            <TextArea placeholder="What was reported, in the words it was reported. Quality opens a case; it is not a finding." value={words} onChange={(e) => setWords(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" loading={busy} disabled={words.trim().length < 5} onClick={() => run(async () => { await report({ companyId, jobId, words }); setWords(""); setWriting(false); })}>Open a case</Button>
              <Button size="sm" variant="ghost" onClick={() => setWriting(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setWriting(true)}>Report a concern to Quality</Button>
            {completed && !data.review ? <Button size="sm" variant="ghost" loading={busy} onClick={() => run(() => reviewNow({ companyId, jobId }))}>Review this visit now</Button> : null}
          </div>
        )
      ) : null}
      <FormError message={error} />
    </div>
  );
}

export function QualityOnCustomer({ customerId }: { customerId: Id<"customers"> }) {
  const { companyId } = useCompany();
  const data = useQuery(api.quality.forCustomer, { companyId, customerId });
  if (data === undefined) return null;
  return <Cases open={data.open} recent={data.recent} empty="No Quality cases for this client." />;
}

export function QualityOnProperty({ propertyId }: { propertyId: Id<"properties"> }) {
  const { companyId, role } = useCompany();
  const data = useQuery(api.quality.forProperty, { companyId, propertyId });
  const create = useMutation(api.quality.createDraft);
  const router = useRouter();
  const { busy, error, run } = useRun();
  if (data === undefined) return null;
  return (
    <div className="grid gap-3 text-sm">
      {data.standard ? (
        <p className="text-muted-foreground">Property standard: <Link href={`${QUALITY_PATH}/standards`} className="font-medium text-brand-300 underline-offset-4 hover:underline">{data.standard.name} v{data.standard.version}</Link> · {data.standard.requirements} requirements on top of the company default.</p>
      ) : canManage(role) ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">No property-specific standard: the company default applies.</span>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => run(async () => { await create({ companyId, level: "property", ref: propertyId, name: "Property standard" }); router.push(`${QUALITY_PATH}/standards`); })}>Add one</Button>
        </div>
      ) : null}
      <Cases open={data.open} recent={data.recent} empty="No Quality cases at this property." />
      <FormError message={error} />
    </div>
  );
}

/** Requests waiting on a cleaner. Managers only, and never a score: being asked is not a finding. */
export function QualityOnCleaner({ cleanerId }: { cleanerId: Id<"cleaners"> }) {
  const { companyId, role, timezone } = useCompany();
  const now = useNow();
  const data = useQuery(api.quality.forCleaner, canManage(role) ? { companyId, cleanerId } : "skip");
  if (!canManage(role) || data === undefined) return null;
  return (
    <div className="grid gap-2 text-sm">
      {data.waiting.length ? (
        <ul className="grid gap-1.5">
          {data.waiting.map((w) => <li key={w.id} className="rounded-lg border border-border px-3 py-2"><span className="font-medium text-strong">{w.purpose}</span> · {w.status}{w.job ? ` · ${w.job.service}, ${w.job.day}` : ""}{w.dueAt ? <span className="block text-xs text-muted-foreground">Due {whenLabel(w.dueAt, now, timezone)}</span> : null}</li>)}
        </ul>
      ) : <p className="text-muted-foreground">Quality is not waiting on anything from this cleaner.</p>}
      <p className="text-xs text-muted-foreground">{data.note}</p>
    </div>
  );
}

/** On a Retention case: what Quality found and how the correction stands. The conversation stays Retention&rsquo;s. */
export function QualityOnRetentionCase({ caseId }: { caseId: Id<"retentionCases"> }) {
  const { companyId } = useCompany();
  const data = useQuery(api.quality.forRetentionCase, { companyId, caseId });
  if (data === undefined || !data.cases.length) return null;
  return (
    <div className="grid gap-3 text-sm">
      <ul className="grid gap-1.5">{data.cases.map((c) => <CaseRow key={c.id} card={c} />)}</ul>
      {data.detail.map((d) => (
        <div key={d.caseId} className="grid gap-1 text-xs">
          {d.findings.length ? d.findings.map((f, i) => <p key={i}><span className="font-medium text-strong">{f.category}:</span> {f.statement}</p>) : <p className="text-muted-foreground">No finding reviewed yet. A report is not a finding.</p>}
          {d.corrections.map((x, i) => <p key={i} className="text-muted-foreground">Correction · {x.state} · must show: {x.acceptance}{x.verification ? ` · ${x.verification}` : ""}</p>)}
        </div>
      ))}
    </div>
  );
}
