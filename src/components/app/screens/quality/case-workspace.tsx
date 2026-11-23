"use client";

/**
 * One quality case, given room: a clear header; Summary (what Quality checked, found and will do next, from its
 * real runs, and the findings to review); Evidence (the assembled record, photos, calls and texts, with what is
 * missing kept beside what was found); Timeline; People; Actions (requests, corrections, takeover, escalation);
 * and Outcome (the correction and the customer's answer, kept apart, and how the case closed).
 *
 * Words someone outside wrote are shown as plain text and nothing else. Findings are suggestions until a
 * person reviews them, and the screen never shows a score, a confidence figure or a verdict on a person.
 */
import { useMutation } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { useOfferChatContext } from "@/components/app/chat/chat-context";
import { useCompany } from "@/components/app/company";
import { Field, FormError, TextArea, TextInput, useRun } from "@/components/app/form";
import { useNow } from "@/components/app/use-now";
import { AlertTriangle, CameraIcon, CheckCircle2, Hand, Phone, ShieldCheck } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { money, whenLabel } from "@/lib/app/format";
import { useStableQuery } from "@/lib/app/stable-query";
import { cn } from "@/lib/utils";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { BasisTag, EvidenceSections, Flag, OpenLink, RunTrace, StagePill, type CaseDetail, type RequestView } from "./shared";

const TABS = ["Summary", "Evidence", "Timeline", "People", "Actions", "Outcome"] as const;
type Tab = (typeof TABS)[number];

const CATEGORIES = [
  ["service_miss", "Service miss"],
  ["scope_misunderstanding", "Scope misunderstanding"],
  ["access_limitation", "Access limitation"],
  ["equipment_limitation", "Equipment or supply limitation"],
  ["scheduling_failure", "Scheduling failure"],
  ["insufficient_evidence", "Insufficient evidence"],
  ["no_issue_established", "No issue established"],
] as const;

const CLOSURES = [
  ["findings_recorded", "Findings recorded; no correction needed"],
  ["no_issue_established", "No issue established"],
  ["insufficient_evidence", "Insufficient evidence"],
  ["handled_by_person", "Handled by a person"],
  ["duplicate", "Joined to another case"],
  ["correction_not_verified", "Correction not verified"],
] as const;

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-strong">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Quote({ children }: { children: string }) {
  return <blockquote className="rounded-xl border-l-2 border-brand-500/60 bg-muted/40 px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-foreground">{children}</blockquote>;
}

function Finding({ finding, canManage }: { finding: CaseDetail["findings"][number]; canManage: boolean }) {
  const { companyId } = useCompany();
  const review = useMutation(api.quality.reviewFindingAction);
  const { busy, error, run } = useRun();
  const [revising, setRevising] = useState(false);
  const [statement, setStatement] = useState(finding.statement);
  const [category, setCategory] = useState(finding.category);
  return (
    <li className={cn("grid gap-2 rounded-xl border bg-background p-3.5", finding.state === "suggested" ? "border-dashed border-border" : finding.state === "rejected" ? "border-border opacity-70" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={finding.state === "reviewed" ? "success" : finding.state === "rejected" ? "outline" : "info"} size="sm">{finding.state === "suggested" ? "Suggested" : finding.state === "reviewed" ? "Reviewed" : finding.state === "rejected" ? "Rejected" : "Superseded"}</Badge>
        <span className="text-xs font-semibold text-strong">{finding.categoryWords}</span>
        <span className="text-[11px] text-muted-foreground">{finding.suggestedBy === "rules" ? "From the company's rules" : finding.suggestedBy === "person" ? "Recorded by a person" : `Suggested by an AI reader (${finding.suggestedBy})`}</span>
      </div>
      <p className="text-sm leading-snug text-foreground">{finding.statement}</p>
      {finding.supporting.length ? <p className="text-xs text-muted-foreground">Rests on: {finding.supporting.map((s) => s.label).join(", ")}</p> : null}
      {finding.conflicting.length ? (
        <div className="text-xs text-muted-foreground">
          <span className="font-semibold text-warning-foreground">Conflicting: </span>
          {finding.conflicting.map((c) => c.text).join(" ")}
        </div>
      ) : null}
      {finding.missing.length ? <p className="text-xs text-muted-foreground"><span className="font-semibold">Missing: </span>{finding.missing.join("; ")}</p> : null}
      {finding.history.length > 1 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">History ({finding.history.length})</summary>
          <ul className="mt-1 grid gap-1">
            {finding.history.map((h, i) => (
              <li key={i}>{h.change}{h.statement ? `: was "${h.statement}"` : ""}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {canManage && finding.state === "suggested" && !revising ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={busy} onClick={() => run(() => review({ companyId, findingId: finding.id as Id<"qualityFindings">, action: "confirm" }))}>Confirm</Button>
          <Button size="sm" variant="outline" onClick={() => setRevising(true)}>Revise</Button>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => run(() => review({ companyId, findingId: finding.id as Id<"qualityFindings">, action: "reject", note: "Not supported by the evidence." }))}>Reject</Button>
        </div>
      ) : null}
      {revising ? (
        <div className="grid gap-2">
          <Field label="Finding">
            <TextArea value={statement} onChange={(e) => setStatement(e.target.value)} />
          </Field>
          <Field label="Kind">
            <select className="h-10 rounded-lg border border-input bg-background px-3 text-sm" value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
              {CATEGORIES.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </Field>
          <div className="flex gap-2">
            <Button size="sm" loading={busy} onClick={() => run(async () => { await review({ companyId, findingId: finding.id as Id<"qualityFindings">, action: "revise", statement, category }); setRevising(false); })}>Save revision</Button>
            <Button size="sm" variant="ghost" onClick={() => setRevising(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      <FormError message={error} />
    </li>
  );
}

function Requests({ requests, now, timezone }: { requests: RequestView[]; now: number; timezone: string }) {
  if (!requests.length) return <p className="text-sm text-muted-foreground">Nobody has been asked anything about this case.</p>;
  return (
    <ul className="grid gap-3">
      {requests.map((r) => (
        <li key={r.id} className="grid gap-2 rounded-xl border border-border bg-background p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-strong">{r.purposeWords} · {r.who}</span>
            <Badge variant={r.status === "answered" ? "success" : r.status === "unanswered" || r.status === "blocked" ? "warning" : "outline"} size="sm">{r.statusWords}</Badge>
            {r.owner === "retention" ? <Flag>Sent by Retention</Flag> : null}
          </div>
          {r.questions.length ? <ul className="list-disc pl-5 text-sm text-foreground">{r.questions.map((q) => <li key={q.id}>{q.text}</li>)}</ul> : null}
          {r.evidence.length ? <p className="text-xs text-muted-foreground">Asked for: {r.evidence.map((e) => e.label).join("; ")}</p> : null}
          {r.messages.map((m) => (
            <p key={m.id} className="text-xs text-muted-foreground">Message: {m.status.replace(/_/g, " ")}{m.problem ? ` (${m.problem})` : ""} · {whenLabel(m.at, now, timezone)}</p>
          ))}
          {r.result ? <p className="text-xs text-muted-foreground">{r.result}</p> : null}
          {r.submissions.map((s) => (
            <div key={s.id} className="grid gap-1.5 rounded-lg border border-border p-3">
              <p className="text-xs font-semibold text-strong">{s.kind === "original" ? "Their account" : `Supplement ${s.version - 1}`} · {whenLabel(s.at, now, timezone)}</p>
              {s.hidden ? <p className="text-xs text-muted-foreground">An answer was sent. Its contents are shown to managers and the Owner.</p> : null}
              {s.account ? <Quote>{s.account}</Quote> : null}
              {s.answers.map((a) => (
                <div key={a.questionId} className="grid gap-1">
                  <p className="text-xs text-muted-foreground">{a.question}</p>
                  <Quote>{a.text}</Quote>
                </div>
              ))}
              {s.files.map((f) => (
                <p key={f.id} className="text-xs">
                  {f.url ? <a href={f.url} target="_blank" rel="noreferrer noopener" className="font-medium text-brand-300 underline">{f.name}</a> : <span>{f.name} (opens only where files can be served safely)</span>}
                  <span className="text-muted-foreground"> · uploaded {whenLabel(f.uploadedAt, now, timezone)}{f.statedCapturedAt ? ` · their device says taken ${whenLabel(f.statedCapturedAt, now, timezone)}` : ""}</span>
                </p>
              ))}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

function CorrectionForm({ detail }: { detail: CaseDetail }) {
  const { companyId } = useCompany();
  const propose = useMutation(api.quality.proposeCorrectionAction);
  const { busy, error, run } = useRun();
  const reviewed = detail.findings.filter((f) => f.state === "reviewed" && f.category === "service_miss");
  const [chosen, setChosen] = useState<string[]>(reviewed.map((f) => f.id));
  const [areas, setAreas] = useState(detail.areas.join(", "));
  const [scope, setScope] = useState<"targeted" | "full">("targeted");
  const [photos, setPhotos] = useState("1");
  const [labels, setLabels] = useState(detail.areas.join(", "));
  const [inspection, setInspection] = useState(false);
  if (!reviewed.length) return <p className="text-sm text-muted-foreground">A correction answers a reviewed service miss. Review the findings first.</p>;
  return (
    <div className="grid gap-3 rounded-xl border border-border bg-background p-3.5">
      <p className="text-sm text-muted-foreground">Quality prepares the scope and what must be on record afterwards. Retention arranges it with the customer, the Owner sets the crew&rsquo;s pay (which books it), and Dispatch staffs it.</p>
      <fieldset className="grid gap-1.5">
        <legend className="text-xs font-semibold text-strong">Findings it answers</legend>
        {reviewed.map((f) => (
          <label key={f.id} className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={chosen.includes(f.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, f.id] : chosen.filter((x) => x !== f.id))} className="mt-1" />
            <span>{f.statement}</span>
          </label>
        ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Areas" hint="Comma separated">
          <TextInput value={areas} onChange={(e) => setAreas(e.target.value)} />
        </Field>
        <Field label="Scope">
          <select className="h-10 rounded-lg border border-input bg-background px-3 text-sm" value={scope} onChange={(e) => setScope(e.target.value as "targeted" | "full")}>
            <option value="targeted">Targeted: just the areas</option>
            <option value="full">Full service again</option>
          </select>
        </Field>
        <Field label="After photos required">
          <TextInput inputMode="numeric" value={photos} onChange={(e) => setPhotos(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <Field label="Checklist items that must be done" hint="Comma separated">
          <TextInput value={labels} onChange={(e) => setLabels(e.target.value)} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={inspection} onChange={(e) => setInspection(e.target.checked)} />
        A person inspects the work before it counts as verified
      </label>
      <FormError message={error} />
      <Button size="sm" loading={busy} disabled={!chosen.length} onClick={() => run(() => propose({ companyId, caseId: detail.card.id as Id<"qualityCases">, findingIds: chosen as Id<"qualityFindings">[], areas: areas.split(",").map((a) => a.trim()).filter(Boolean), scope, afterPhotos: Number(photos || "0"), checklistLabels: labels.split(",").map((a) => a.trim()).filter(Boolean), inspection }))}>Hand the correction to Retention</Button>
    </div>
  );
}

function Actions({ detail }: { detail: CaseDetail }) {
  const { companyId, role } = useCompany();
  const caseId = detail.card.id as Id<"qualityCases">;
  const takeOver = useMutation(api.quality.takeOver);
  const handBack = useMutation(api.quality.handBack);
  const escalate = useMutation(api.quality.escalate);
  const note = useMutation(api.quality.addNote);
  const ask = useMutation(api.quality.requestFromCleaner);
  const askCustomer = useMutation(api.quality.askCustomer);
  const preserve = useMutation(api.quality.preserve);
  const markSerious = useMutation(api.quality.markSeriousByPerson);
  const { busy, error, run } = useRun();
  const [text, setText] = useState("");
  const [question, setQuestion] = useState("");
  const [cleaner, setCleaner] = useState<string>(detail.people.crew[0]?.id ?? "");
  const closed = detail.card.stage === "closed";
  const manage = detail.can.manage;
  if (closed) return <p className="text-sm text-muted-foreground">The case is closed. Notes can still be added from the Timeline.</p>;
  return (
    <div className="grid gap-6">
      <FormError message={error} />
      <Section title="Who has it">
        <div className="flex flex-wrap gap-2">
          {detail.heldBy ? (
            <Button size="sm" variant="outline" loading={busy} onClick={() => run(() => handBack({ companyId, caseId }))}>Hand back to Quality</Button>
          ) : (
            <Button size="sm" variant="outline" loading={busy} onClick={() => run(() => takeOver({ companyId, caseId }))}><Hand className="size-4" aria-hidden />Take over</Button>
          )}
          {manage ? <Button size="sm" variant="outline" loading={busy} onClick={() => run(() => preserve({ companyId, caseId }))}>Preserve the visit&rsquo;s evidence</Button> : null}
        </div>
        <p className="text-xs text-muted-foreground">While a person has the case, Quality prepares nothing for anyone outside.</p>
      </Section>
      {manage && detail.people.crew.length && !detail.serious ? (
        <Section title="Ask a cleaner on the visit">
          <div className="grid gap-2">
            <select className="h-10 rounded-lg border border-input bg-background px-3 text-sm" value={cleaner} onChange={(e) => setCleaner(e.target.value)}>
              {detail.people.crew.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <TextArea placeholder="One focused question. Say what is needed, not what anyone said." value={question} onChange={(e) => setQuestion(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" loading={busy} disabled={!question.trim() || !detail.job} onClick={() => run(async () => { await ask({ companyId, jobId: detail.job!.id as Id<"jobs">, cleanerId: cleaner as Id<"cleaners">, purpose: "question", questions: [question], caseId }); setQuestion(""); })}>Send question</Button>
              <Button size="sm" variant="outline" loading={busy} disabled={!detail.job} onClick={() => run(() => ask({ companyId, jobId: detail.job!.id as Id<"jobs">, cleanerId: cleaner as Id<"cleaners">, purpose: "statement", questions: ["In your own words, how did the visit go?"], caseId }))}>Ask for their account</Button>
            </div>
          </div>
        </Section>
      ) : null}
      {manage && detail.people.customer && !detail.serious ? (
        <Section title="Ask the customer (through Retention)">
          <TextArea placeholder="A focused question. Retention owns the conversation and sends it." value={text} onChange={(e) => setText(e.target.value)} />
          <Button size="sm" variant="outline" loading={busy} disabled={!text.trim()} onClick={() => run(async () => { await askCustomer({ companyId, caseId, question: text }); setText(""); })}>Hand the question to Retention</Button>
        </Section>
      ) : null}
      {manage ? (
        <Section title="Correction">
          {detail.serious && !detail.serious.decision ? <p className="text-sm text-muted-foreground">A serious concern waits for the Owner&rsquo;s decision before any correction.</p> : <CorrectionForm detail={detail} />}
        </Section>
      ) : null}
      <Section title="Escalate or flag">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" loading={busy} onClick={() => run(() => escalate({ companyId, caseId, reason: "Needs a manager's attention." }))}>Escalate</Button>
          {manage && !detail.serious ? <Button size="sm" variant="destructive-outline" loading={busy} onClick={() => run(() => markSerious({ companyId, caseId, reason: "A person marked this as a safety, damage or conduct concern." }))}><ShieldCheck className="size-4" aria-hidden />Mark as serious</Button> : null}
        </div>
        <p className="text-xs text-muted-foreground">Marking a case serious restricts it to the Owner for good and preserves the evidence. Nothing about anyone&rsquo;s work or pay changes.</p>
      </Section>
      <Section title="Note">
        <TextArea value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note to the timeline" />
        <Button size="sm" variant="ghost" loading={busy} disabled={!text.trim()} onClick={() => run(async () => { await note({ companyId, caseId, text }); setText(""); })}>Add note</Button>
      </Section>
      {role === "office" ? <p className="text-xs text-muted-foreground">Findings, corrections and closing are for managers and the Owner.</p> : null}
    </div>
  );
}

function Outcome({ detail }: { detail: CaseDetail }) {
  const { companyId, timezone } = useCompany();
  const now = useNow();
  const caseId = detail.card.id as Id<"qualityCases">;
  const close = useMutation(api.quality.close);
  const decide = useMutation(api.quality.recordSeriousDecision);
  const inspect = useMutation(api.quality.recordCorrectionInspection);
  const { busy, error, run } = useRun();
  const [code, setCode] = useState<(typeof CLOSURES)[number][0]>("findings_recorded");
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState("");
  const [continueOps, setContinueOps] = useState(false);
  return (
    <div className="grid gap-6">
      <FormError message={error} />
      <Section title="Corrections">
        {detail.corrections.length ? (
          <ul className="grid gap-3">
            {detail.corrections.map((c) => (
              <li key={c.id} className="grid gap-2 rounded-xl border border-border bg-background p-3.5">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg border border-border p-2.5">
                    <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">The work</p>
                    <p className="text-sm font-medium text-strong">{c.stateWords}</p>
                    {c.verification ? <p className="text-xs text-muted-foreground">{c.verification.detail}</p> : null}
                  </div>
                  <div className="rounded-lg border border-border p-2.5">
                    <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">The customer</p>
                    <p className="text-sm font-medium text-strong">{c.customerWords}</p>
                    <p className="text-xs text-muted-foreground">Recorded by Retention, which owns the conversation.</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{c.scope === "targeted" ? "Targeted" : "Full"} · {c.areas.join(", ") || "the reported work"} · {c.minutes} minutes{c.visit ? ` · visit ${c.visit.day}` : ""}</p>
                <p className="text-xs text-muted-foreground">Acceptance: {c.acceptance.criteria}</p>
                <p className="text-xs text-muted-foreground">{c.estimatedCostCents !== null ? `Estimated crew cost ${money(c.estimatedCostCents)}${c.actualCostCents !== null ? `; actual ${money(c.actualCostCents)}` : ""}. ` : ""}{c.costBasis}</p>
                {c.result ? <p className="text-xs text-muted-foreground">{c.result}</p> : null}
                {c.state === "completed" && c.acceptance.inspection ? (
                  <Button size="sm" variant="outline" loading={busy} onClick={() => run(() => inspect({ companyId, correctionId: c.id as Id<"qualityCorrections">, note: "Inspected on site; the areas meet the acceptance criteria." }))}>Record the inspection</Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No correction has been prepared.</p>
        )}
      </Section>
      {detail.serious ? (
        <Section title="Serious concern">
          <div className="grid gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3.5">
            <p className="text-sm text-strong">{detail.serious.reason}</p>
            <p className="text-xs text-muted-foreground">Restricted to the Owner{detail.serious.preservedAt ? `; evidence preserved ${whenLabel(detail.serious.preservedAt, now, timezone)}` : ""}. Nothing has been admitted, nobody has been accused, and no insurer or authority has been contacted by Selestial.</p>
            {detail.serious.decision ? (
              <p className="text-sm">Decision by {detail.serious.decision.by}: {detail.serious.decision.text}</p>
            ) : detail.can.owner ? (
              <div className="grid gap-2">
                <TextArea placeholder="Record what was decided" value={decision} onChange={(e) => setDecision(e.target.value)} />
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={continueOps} onChange={(e) => setContinueOps(e.target.checked)} />Ordinary operational work (a correction, a reschedule) may continue</label>
                <Button size="sm" loading={busy} disabled={decision.trim().length < 10} onClick={() => run(() => decide({ companyId, caseId, text: decision, continueOperations: continueOps }))}>Record the decision</Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">The Owner records the decision.</p>
            )}
          </div>
        </Section>
      ) : null}
      <Section title="Close the case">
        {detail.card.closed ? (
          <p className="text-sm text-strong"><CheckCircle2 className="mr-1 inline size-4" aria-hidden />{detail.card.closed.words}</p>
        ) : detail.can.manage ? (
          <div className="grid gap-2">
            <select className="h-10 rounded-lg border border-input bg-background px-3 text-sm" value={code} onChange={(e) => setCode(e.target.value as typeof code)}>
              {(detail.serious ? [["serious_decided", "The Owner's decision is recorded"] as const] : CLOSURES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <TextArea placeholder="What actually happened (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <Button size="sm" variant="outline" loading={busy} onClick={() => run(() => close({ companyId, caseId, code: detail.serious ? "serious_decided" : code, note: note || undefined }))}>Close with this outcome</Button>
            <p className="text-xs text-muted-foreground">Closing says what was found. Whether the customer is satisfied is Retention&rsquo;s to record.</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">A manager or the Owner closes a case.</p>
        )}
      </Section>
    </div>
  );
}

export function CaseBody({ caseId }: { caseId: Id<"qualityCases"> }) {
  const { companyId, timezone } = useCompany();
  const now = useNow();
  const detail = useStableQuery(api.quality.caseDetail, now ? { companyId, caseId, asOf: now } : "skip");
  const [tab, setTab] = useState<Tab>("Summary");
  useOfferChatContext(detail?.job ? [{ table: "jobs", id: detail.job.id }] : []);
  if (detail === undefined) return <div className="grid gap-3 p-5" aria-busy="true" aria-label="Loading the case"><Skeleton className="h-28 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>;
  const card = detail.card;
  return (
    <div className="grid gap-5 p-4 sm:p-6">
      <header className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <StagePill stage={card.stage} words={card.stageWords} />
          {card.serious ? <Flag tone="danger"><ShieldCheck className="size-3" aria-hidden />Serious: restricted to the Owner</Flag> : null}
          {detail.heldBy ? <Flag><Hand className="size-3" aria-hidden />{detail.heldBy.name} has this</Flag> : null}
          {detail.escalated ? <Flag tone="warn"><AlertTriangle className="size-3" aria-hidden />Escalated{detail.escalated.to ? ` to ${detail.escalated.to}` : ""}</Flag> : null}
          <span className="text-xs text-muted-foreground">{card.origin}</span>
        </div>
        <h2 className="font-heading text-xl tracking-tight text-strong">{card.title}</h2>
        <dl className="grid gap-2 text-sm">
          <div className="grid gap-0.5 sm:grid-cols-[8rem_1fr]"><dt className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Reported</dt><dd>{card.happened}</dd></div>
          <div className="grid gap-0.5 sm:grid-cols-[8rem_1fr]"><dt className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Quality is</dt><dd>{card.doing}</dd></div>
          {card.needs ? <div className="grid gap-0.5 sm:grid-cols-[8rem_1fr]"><dt className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Needs you</dt><dd className="font-medium text-strong">{card.needs}</dd></div> : null}
        </dl>
      </header>
      <div role="tablist" aria-label="Case sections" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("shrink-0 border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand-500", tab === t ? "border-brand-500 text-strong" : "border-transparent text-muted-foreground hover:text-strong")}>
            {t}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tab} className="grid gap-6">
        {tab === "Summary" ? (
          <>
            {detail.run ? <RunTrace checked={detail.run.checked} found={detail.run.found} next={detail.run.next} at={detail.run.at} now={now} timezone={timezone} blockedReason={detail.run.blockedReason} /> : null}
            {detail.reportWords ? <Section title="What was reported (a report, not a finding)"><Quote>{detail.reportWords}</Quote></Section> : null}
            <Section title="Findings">
              {detail.findings.length ? <ul className="grid gap-3">{detail.findings.map((f) => <Finding key={f.id} finding={f} canManage={detail.can.manage} />)}</ul> : <p className="text-sm text-muted-foreground">No findings yet.</p>}
            </Section>
          </>
        ) : null}
        {tab === "Evidence" ? (
          <>
            {detail.photos.length ? (
              <Section title={`Photos (${detail.photos.length})`} aside={<span className="text-xs text-muted-foreground">Times are when each reached Selestial</span>}>
                <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {detail.photos.map((p) => (
                    <li key={p.id} className="grid gap-1">
                      {p.url ? <a href={p.url} target="_blank" rel="noreferrer noopener" className="block aspect-square overflow-hidden rounded-lg border border-border bg-muted">{/* eslint-disable-next-line @next/next/no-img-element -- a private, signed storage URL; nothing to optimize */}
                      <img src={p.url} alt={`${p.kind} photo`} className="size-full object-cover" loading="lazy" /></a> : <span className="flex aspect-square items-center justify-center rounded-lg border border-dashed border-border"><CameraIcon className="size-5 text-muted-foreground" aria-hidden /></span>}
                      <span className="text-[11px] text-muted-foreground">{p.kind} · {whenLabel(p.uploadedAt, now, timezone)}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
            {detail.comms.length ? (
              <Section title="Calls and texts">
                <ul className="grid gap-3">
                  {detail.comms.map((c) => (
                    <li key={c.id} className="grid gap-2 rounded-xl border border-border bg-background p-3.5">
                      <p className="flex items-center gap-2 text-sm font-semibold text-strong"><Phone className="size-4" aria-hidden />{c.kind === "call" ? (c.direction === "incoming" ? "Call in" : "Call out") : c.direction === "incoming" ? "Text in" : "Text out"} · {whenLabel(c.occurredAt, now, timezone)}</p>
                      {c.body ? <Quote>{c.body}</Quote> : null}
                      {c.providerSummary?.lines.length ? <div className="grid gap-1"><BasisTag basis="provider_summary" /><p className="text-sm text-muted-foreground">{c.providerSummary.lines.join(" ")}</p></div> : null}
                      {c.transcript ? (
                        c.transcript.status === "completed" ? (
                          <details>
                            <summary className="cursor-pointer text-xs font-medium text-brand-300">Transcript, version {c.transcript.version}{c.transcript.revisedAt ? " (revised by the provider)" : ""}</summary>
                            <ol className="mt-2 grid gap-1 text-sm">
                              {c.transcript.segments.map((s, i) => (
                                <li key={i} className="grid grid-cols-[4.5rem_1fr] gap-2">
                                  <span className="text-[11px] text-muted-foreground tabular-nums">{Math.floor(s.start / 60)}:{String(Math.floor(s.start % 60)).padStart(2, "0")} {s.speakerKind === "company" ? "Company" : s.speakerKind === "external" ? "Caller" : "Unknown"}</span>
                                  <span className="whitespace-pre-wrap">{s.text}</span>
                                </li>
                              ))}
                            </ol>
                          </details>
                        ) : <p className="text-xs text-muted-foreground">Transcript: {c.transcript.status.replace(/_/g, " ")}</p>
                      ) : c.kind === "call" ? <p className="text-xs text-muted-foreground">No transcript yet.</p> : null}
                      {c.extracts.length ? (
                        <ul className="grid gap-1">
                          {c.extracts.map((e) => (
                            <li key={e.id} className={cn("text-xs", e.state === "stale" ? "text-muted-foreground line-through" : "text-foreground")}>
                              <BasisTag basis={e.fromSummary ? "provider_summary" : "analysis"} /> {e.text}{e.quote ? ` "${e.quote}"` : ""}{e.speakerUncertain ? " (speaker not identified)" : ""}{e.state === "stale" ? " (from an earlier transcript version)" : ""}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {c.unavailable ? <p className="text-xs text-warning-foreground">No longer available at the provider; what was read is kept.</p> : null}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
            <EvidenceSections sections={detail.evidence} now={now} timezone={timezone} />
            {detail.pinned.length ? <Section title="Pinned to this case"><ul className="grid gap-1 text-sm">{detail.pinned.map((p) => <li key={p.id}>{p.source.label}{p.preserved ? " · preserved" : ""}</li>)}</ul></Section> : null}
          </>
        ) : null}
        {tab === "Timeline" ? (
          <ol className="grid gap-3">
            {detail.timeline.map((e) => (
              <li key={e.id} className="grid gap-1 rounded-xl border border-border bg-background p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {e.basis ? <BasisTag basis={e.basis} /> : null}
                  <span>{whenLabel(e.at, now, timezone)}</span>
                  <span>· {e.actor === "agent" ? "Quality" : e.actor === "member" ? "A person" : e.actor === "quality_link" ? "Through a private link" : "Selestial"}</span>
                </div>
                <p className="text-sm text-foreground">{e.text}</p>
                {e.quote ? <Quote>{e.quote}</Quote> : null}
              </li>
            ))}
          </ol>
        ) : null}
        {tab === "People" ? (
          <>
            <Section title="Who is involved">
              <ul className="grid gap-2 text-sm">
                {detail.people.customer ? <li>Customer: <Link className="font-medium text-brand-300 underline" href={`/app/clients/${detail.people.customer.id}`}>{detail.people.customer.name}</Link></li> : null}
                {detail.people.crew.map((c) => <li key={c.id}>On the visit: <Link className="font-medium text-brand-300 underline" href={`/app/cleaners/${c.id}`}>{c.name}</Link> <span className="text-muted-foreground">(being on a visit is not being at fault)</span></li>)}
                <li>Case owner: {detail.people.owner?.name ?? "Nobody named yet"}</li>
                {detail.people.retention ? <li>Retention: <OpenLink href={`/app/agents/retention/recovery?case=${detail.people.retention.id}`}>{detail.people.retention.title}</OpenLink> <span className="text-muted-foreground">{detail.people.retention.outcome ? `· ${detail.people.retention.outcome.replace(/_/g, " ")}` : "· open"}</span></li> : <li className="text-muted-foreground">No Retention case: nothing customer-facing has been needed.</li>}
              </ul>
            </Section>
            <Section title="Requests and answers">
              <Requests requests={detail.requests} now={now} timezone={timezone} />
            </Section>
          </>
        ) : null}
        {tab === "Actions" ? <Actions detail={detail} /> : null}
        {tab === "Outcome" ? <Outcome detail={detail} /> : null}
      </div>
    </div>
  );
}

export function CaseWorkspace({ id, onClose }: { id: string | null; onClose: () => void }) {
  return (
    <Sheet open={id !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetPopup side="right" className="w-full max-w-4xl bg-background">
        <SheetTitle className="sr-only">Quality case</SheetTitle>
        <ScrollArea className="min-h-0 flex-1">{id ? <CaseBody caseId={id as Id<"qualityCases">} /> : null}</ScrollArea>
      </SheetPopup>
    </Sheet>
  );
}
