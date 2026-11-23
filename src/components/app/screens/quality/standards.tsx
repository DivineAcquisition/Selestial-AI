"use client";

/**
 * Quality Standards: what successful service means for this company. Templates are editable starting points,
 * not claims about the industry. Company defaults, service, account and property standards and visit
 * exceptions apply in a fixed order shown on the page. Every change is a new version: a draft is published by
 * the Owner and applies to visits scheduled after that, never to a visit already held to an earlier version.
 */
import { useMutation } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, FormError, TextInput, useRun } from "@/components/app/form";
import { PageHeader, Panel } from "@/components/app/shell";
import { useNow } from "@/components/app/use-now";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { whenLabel } from "@/lib/app/format";
import { useStableQuery } from "@/lib/app/stable-query";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import type { Requirement } from "../../../../../convex/lib/quality/schema";
import { Empty, Flag } from "./shared";

const KIND_WORDS: Record<Requirement["kind"], string> = { checklist_completion: "Checklist completion", required_evidence: "Required evidence", guide_acknowledgment: "Guide acknowledged", inspection: "Inspection", site_confirmation: "Customer or site confirmation", document: "Document or certificate", timing: "Timing" };

function Editor({ standardId, onDone }: { standardId: Id<"qualityStandards">; onDone: () => void }) {
  const { companyId, role } = useCompany();
  const standard = useStableQuery(api.quality.standard, { companyId, standardId });
  const save = useMutation(api.quality.saveDraft);
  const publish = useMutation(api.quality.publish);
  const discard = useMutation(api.quality.discardDraft);
  const { busy, error, run } = useRun();
  const [draft, setDraft] = useState<Requirement[] | null>(null);
  const [name, setName] = useState<string | null>(null);
  if (!standard) return <Skeleton className="h-40 rounded-xl" />;
  const reqs = draft ?? standard.requirements;
  const set = (i: number, patch: Partial<Requirement>) => setDraft(reqs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const editable = standard.status === "draft";
  return (
    <div className="grid gap-3 rounded-2xl border border-border bg-background p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={editable ? "info" : "outline"} size="sm">{editable ? `Draft v${standard.version}` : `v${standard.version} · ${standard.status}`}</Badge>
        <span className="text-xs text-muted-foreground">{standard.levelWords}</span>
      </div>
      {editable ? <Field label="Name"><TextInput value={name ?? standard.name} onChange={(e) => setName(e.target.value)} /></Field> : <p className="text-sm font-semibold text-strong">{standard.name}</p>}
      <ul className="grid gap-2">
        {reqs.map((r, i) => (
          <li key={r.id} className="grid gap-2 rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-strong">{KIND_WORDS[r.kind]}</span>
              <Flag>{r.level === "required" ? "Required" : "Advisory"}</Flag>
              {r.waived ? <Flag tone="warn">Waived here: {r.waived.reason}</Flag> : null}
              <code className="text-[11px] text-muted-foreground">{r.id}</code>
            </div>
            {editable ? (
              <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                <TextInput aria-label="Requirement" value={r.label} onChange={(e) => set(i, { label: e.target.value })} />
                <select aria-label="Required or advisory" className="h-10 rounded-lg border border-input bg-background px-2.5 text-sm" value={r.level} onChange={(e) => set(i, { level: e.target.value as Requirement["level"] })}>
                  <option value="required">Required</option>
                  <option value="advisory">Advisory</option>
                </select>
                <Button size="sm" variant="ghost" onClick={() => setDraft(reqs.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ) : (
              <p className="text-sm text-foreground">{r.label}</p>
            )}
            {r.evidence?.minPhotos ? <p className="text-xs text-muted-foreground">Photos: at least {r.evidence.minPhotos}{r.evidence.photoKind ? ` (${r.evidence.photoKind})` : ""}{r.evidence.checklistLabels?.length ? ` for ${r.evidence.checklistLabels.join(", ")}` : ""}</p> : null}
            {editable && r.kind === "required_evidence" ? (
              <Field label="Minimum photos"><TextInput inputMode="numeric" value={String(r.evidence?.minPhotos ?? 1)} onChange={(e) => set(i, { evidence: { ...(r.evidence ?? {}), minPhotos: Math.max(1, Number(e.target.value.replace(/\D/g, "") || "1")) } })} /></Field>
            ) : null}
          </li>
        ))}
      </ul>
      {editable ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setDraft([...reqs, { id: `after-photos-${reqs.length + 1}`, kind: "required_evidence", label: "At least 2 after photos", level: "required", responsible: "crew", phase: "completion", evidence: { photoKind: "after", minPhotos: 2 } }])}>Add a photo requirement</Button>
          <Button size="sm" variant="outline" onClick={() => setDraft([...reqs, { id: `inspection-${reqs.length + 1}`, kind: "inspection", label: "A manager looks over the record", level: "advisory", responsible: "office", phase: "after" }])}>Add an inspection</Button>
          <Button size="sm" loading={busy} onClick={() => run(async () => { await save({ companyId, standardId, name: name ?? standard.name, requirements: reqs }); setDraft(null); })}>Save draft</Button>
          {role === "owner" ? <Button size="sm" variant="secondary" loading={busy} onClick={() => run(async () => { await save({ companyId, standardId, name: name ?? standard.name, requirements: reqs }); await publish({ companyId, standardId }); onDone(); })}>Publish</Button> : <span className="self-center text-xs text-muted-foreground">The Owner publishes.</span>}
          <Button size="sm" variant="ghost" loading={busy} onClick={() => run(async () => { await discard({ companyId, standardId }); onDone(); })}>Discard draft</Button>
        </div>
      ) : null}
      <FormError message={error} />
    </div>
  );
}

export function QualityStandardsScreen() {
  const { companyId, timezone, role } = useCompany();
  const now = useNow();
  const data = useStableQuery(api.quality.standards, { companyId });
  const create = useMutation(api.quality.createDraft);
  const { busy, error, run } = useRun();
  const [editing, setEditing] = useState<Id<"qualityStandards"> | null>(null);
  const [service, setService] = useState("");
  const manage = role !== "office";
  return (
    <>
      <PageHeader title="Standards" lead="What successful service means for your company. Templates are starting points you edit; nothing here is presented as an industry rule." />
      {data === undefined ? (
        <Skeleton className="h-48 rounded-2xl" aria-busy="true" />
      ) : (
        <div className="grid gap-5">
          <Panel title="How standards combine">
            <p className="p-4 text-sm text-foreground">From least to most specific: {data.precedence.join(" → ")}. A more specific standard adds a requirement, replaces one with the same id, or waives it with a reason. Each review shows which standard and version every requirement came from, held as of the visit&rsquo;s start.</p>
          </Panel>
          <Panel title="Your standards">
            <div className="grid gap-3 p-4">
              {data.groups.length ? data.groups.map((g) => (
                <div key={g.key} className="grid gap-2 rounded-xl border border-border bg-background p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="block text-sm font-semibold text-strong">{g.name}</span>
                      <span className="block text-xs text-muted-foreground">{g.levelWords}{g.target ? `: ${g.target}` : ""}{g.current ? ` · v${g.current.version}, ${g.current.requirements} requirements, published ${g.current.publishedAt ? whenLabel(g.current.publishedAt, now, timezone) : ""}` : " · not published"}</span>
                    </span>
                    <span className="flex gap-2">
                      {g.draft ? <Button size="sm" variant="outline" onClick={() => setEditing(g.draft!.id)}>Edit draft v{g.draft.version}</Button> : null}
                      {g.current && !g.draft && manage ? <Button size="sm" variant="ghost" loading={busy} onClick={() => run(async () => { const r = await create({ companyId, level: g.level, ref: g.level === "company" ? undefined : g.key.slice(g.key.indexOf(":") + 1), name: g.name }); setEditing(r.standardId); })}>New version</Button> : null}
                      {g.current ? <Button size="sm" variant="ghost" onClick={() => setEditing(g.current!.id)}>View</Button> : null}
                    </span>
                  </div>
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Version history ({g.history.length})</summary>
                    <ul className="mt-1 grid gap-0.5">{g.history.map((h) => <li key={h.id}>v{h.version} · {h.status}{h.publishedAt ? ` · from ${whenLabel(h.publishedAt, now, timezone)}` : ""}{h.endedAt ? ` until ${whenLabel(h.endedAt, now, timezone)}` : ""}{h.changeNote ? ` · ${h.changeNote}` : ""}</li>)}</ul>
                  </details>
                  {editing && g.history.some((h) => h.id === editing) ? <Editor standardId={editing} onDone={() => setEditing(null)} /> : null}
                </div>
              )) : <Empty title="No standard yet" body="Until a company standard is published, visits are reviewed against what is already on record: the checklist, and Dispatch's photo counts. Start from a template below." />}
            </div>
          </Panel>
          {manage ? (
            <Panel title="Start from a template">
              <div className="grid gap-3 p-4 md:grid-cols-2">
                {data.templates.map((t) => (
                  <div key={t.id} className="grid content-start gap-2 rounded-xl border border-border bg-background p-3.5">
                    <p className="text-sm font-semibold text-strong">{t.name}</p>
                    <p className="text-xs text-muted-foreground">{t.lead}</p>
                    <ul className="list-disc pl-4 text-xs text-foreground">{t.requirements.map((r) => <li key={r.id}>{r.label} <span className="text-muted-foreground">({r.level})</span></li>)}</ul>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" loading={busy} disabled={data.groups.some((g) => g.key === "company" && g.draft)} onClick={() => run(async () => { const r = await create({ companyId, level: "company", template: t.id, name: t.name }); setEditing(r.standardId); })}>Use as the company default</Button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-2 border-t border-border p-4">
                <Field label="A service-specific standard" hint="The service's name as it appears on visits">
                  <TextInput value={service} onChange={(e) => setService(e.target.value)} placeholder="Deep clean" />
                </Field>
                <Button size="sm" variant="outline" loading={busy} disabled={!service.trim()} onClick={() => run(async () => { const r = await create({ companyId, level: "service", ref: service.trim(), name: `${service.trim()} standard` }); setEditing(r.standardId); setService(""); })}>Create</Button>
              </div>
              <p className="px-4 pb-4 text-xs text-muted-foreground">Property and client standards are created from the property&rsquo;s or client&rsquo;s page; a visit exception from the visit.</p>
            </Panel>
          ) : null}
          <FormError message={error} />
        </div>
      )}
    </>
  );
}
