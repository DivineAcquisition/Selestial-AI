"use client";

/**
 * How Quality works for this company: what it may do without asking, the company's own timing rules, where
 * its evidence comes from (each capability as checked, never assumed), the phone platform connection, and the
 * queue of conversations a person needs to link to the right visit.
 */
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, FormError, TextInput, useRun } from "@/components/app/form";
import { PermissionRow } from "@/components/app/screens/agent-permissions";
import { PageHeader, Panel } from "@/components/app/shell";
import { useNow } from "@/components/app/use-now";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/fields/number";
import { Checkbox } from "@/components/ui/selection/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { whenLabel } from "@/lib/app/format";
import { useStableQuery } from "@/lib/app/stable-query";

import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { Empty } from "./shared";

type Playbook = FunctionReturnType<typeof api.quality.playbook>;

const SECTIONS: { title: string; lead: string; keys: string[] }[] = [
  { title: "Reviewing visits", lead: "Checking a completed visit against your standard, and opening a case when something needs looking into.", keys: ["quality.review_completion", "quality.open_case", "quality.verify_correction"] },
  { title: "Asking for evidence", lead: "Asking the crew for missing photos or their account, and one reminder. Nothing about blame is ever written.", keys: ["quality.request_cleaner_evidence", "quality.remind_outstanding"] },
  { title: "The customer and corrections", lead: "Retention owns the customer conversation. Quality prepares the question or the correction and hands it over.", keys: ["quality.customer_clarification", "quality.prepare_correction"] },
  { title: "Improvements", lead: "A proposal always goes to the Owner. Quality never changes a standard or a policy by itself.", keys: ["quality.propose_improvement"] },
];

const SOURCE_TONE = { connected: "success", needs_attention: "warning", checking: "info", not_connected: "outline", not_available: "outline" } as const;
const SOURCE_WORDS = { connected: "Connected", needs_attention: "Needs attention", checking: "Checking", not_connected: "Not connected", not_available: "Not available" } as const;
const CAP_WORDS = { available: "Available", unavailable: "Not available", unknown: "Not checked yet", not_used: "Not used", limited: "Limited" } as const;

function Rules({ data }: { data: Playbook }) {
  const { companyId, role } = useCompany();
  const save = useMutation(api.quality.saveSettings);
  const { busy, error, run } = useRun();
  const s = data.settings;
  const edit = role === "owner";
  const [linkDays, setLinkDays] = useState(String(s.linkDays));
  const [answerHours, setAnswerHours] = useState(String(s.cleanerAnswerHours));
  const [combine, setCombine] = useState(String(s.combineMinutes));
  const [maxRequests, setMaxRequests] = useState(String(s.maxRequestsPerVisit));
  const [pattern, setPattern] = useState(String(s.patternMinimum));
  const [preserve, setPreserve] = useState(s.preserveDays === null ? "" : String(s.preserveDays));
  const [readPhone, setReadPhone] = useState(s.readPhonePlatform);
  const [reader, setReader] = useState(s.reader);
  const [saved, setSaved] = useState(false);
  const num = (text: string) => Number(text.replace(/[^\d]/g, ""));
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="A request link stays open for"><NumberField disabled={!edit} value={linkDays} onChange={setLinkDays} suffix="days" stepper /></Field>
        <Field label="Time the crew has to answer"><NumberField disabled={!edit} value={answerHours} onChange={setAnswerHours} suffix="hours" stepper /></Field>
        <Field label="Wait after completion before asking" hint="So related gaps go out in one message"><NumberField disabled={!edit} value={combine} onChange={setCombine} suffix="minutes" stepper /></Field>
        <Field label="Most requests to one person per visit" hint="Past this, a person decides"><NumberField disabled={!edit} value={maxRequests} onChange={setMaxRequests} stepper /></Field>
        <Field label="Cases before a pattern is proposed"><NumberField disabled={!edit} value={pattern} onChange={setPattern} stepper /></Field>
        <Field label="Keep preserved evidence after closing" hint="Empty: your company's ordinary deletion rules"><NumberField disabled={!edit} value={preserve} onChange={setPreserve} suffix="days" /></Field>
      </div>
      <label className="flex items-start gap-3 text-sm">
        <Checkbox className="mt-1" disabled={!edit} checked={readPhone} onCheckedChange={(c) => setReadPhone(c)} />
        <span><span className="font-medium text-strong">Read calls and texts from the connected phone platform</span><span className="block text-xs text-muted-foreground">Only what the platform already holds. Quality never starts a recording or changes recording settings.</span></span>
      </label>
      <label className="flex items-start gap-3 text-sm">
        <Checkbox className="mt-1" disabled={!edit} checked={reader} onCheckedChange={(c) => setReader(c)} />
        <span><span className="font-medium text-strong">Ask the AI reader to suggest findings</span><span className="block text-xs text-muted-foreground">Suggestions only: a person reviews each one, and anything not tied to a record is dropped. Credits are held before each read and charged once.</span></span>
      </label>
      {edit ? (
        <div className="flex items-center gap-3">
          <Button size="sm" loading={busy} onClick={() => run(async () => { await save({ companyId, settings: { linkDays: num(linkDays), cleanerAnswerHours: num(answerHours), combineMinutes: num(combine), maxRequestsPerVisit: num(maxRequests), patternMinimum: num(pattern), preserveDays: preserve.trim() ? num(preserve) : undefined, readPhonePlatform: readPhone, reader } }); setSaved(true); })}>Save rules</Button>
          {saved && !busy ? <span className="text-xs text-muted-foreground" role="status">Saved.</span> : null}
        </div>
      ) : <p className="text-xs text-muted-foreground">Only the Owner changes these.</p>}
      <FormError message={error} />
    </div>
  );
}

function QuoPanel({ data }: { data: Playbook }) {
  const { companyId, role, timezone } = useCompany();
  const now = useNow();
  const connect = useMutation(api.qualityComms.connectQuo);
  const recheck = useMutation(api.qualityComms.recheck);
  const disconnect = useMutation(api.qualityComms.disconnect);
  const { busy, error, run } = useRun();
  const [key, setKey] = useState("");
  const [days, setDays] = useState<0 | 7 | 30>(0);
  const quo = data.quo;
  const owner = role === "owner";
  if (!quo) {
    return (
      <div className="grid gap-3 p-4">
        <p className="text-sm text-foreground">Connect Quo so Quality can read call details, transcripts Quo has finished, Quo&rsquo;s own summaries, and incoming texts on your Quo numbers. Selestial never copies recordings, changes recording settings, or sends through Quo.</p>
        {owner ? (
          <>
            <Field label="Quo API key" hint="Quo: Workspace Settings → API. It is stored sealed and never shown again.">
              <TextInput type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Read from">
              {([0, 7, 30] as const).map((d) => <Button key={d} size="sm" variant={days === d ? "secondary" : "ghost"} aria-pressed={days === d} onClick={() => setDays(d)}>{d === 0 ? "From now" : `Last ${d} days`}</Button>)}
            </div>
            <p className="text-xs text-muted-foreground">Conversations from before connecting are kept as history: they never start a request or a correction on their own.</p>
            <div><Button size="sm" loading={busy} disabled={key.trim().length < 16} onClick={() => run(async () => { await connect({ companyId, apiKey: key.trim(), readDays: days }); setKey(""); })}>Connect and check</Button></div>
          </>
        ) : <p className="text-xs text-muted-foreground">The Owner connects Quo.</p>}
        <FormError message={error} />
      </div>
    );
  }
  return (
    <div className="grid gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={quo.status === "connected" ? "success" : quo.status === "checking" ? "info" : "warning"} size="sm">{quo.status === "connected" ? "Connected" : quo.status === "checking" ? "Checking" : quo.status === "expired" ? "Key no longer accepted" : "Needs attention"}</Badge>
        {quo.lastSuccessAt ? <span className="text-xs text-muted-foreground">Last read {whenLabel(quo.lastSuccessAt, now, timezone)}</span> : null}
        {quo.failures ? <span className="text-xs text-warning-foreground">{quo.failures} failed {quo.failures === 1 ? "attempt" : "attempts"} in a row</span> : null}
      </div>
      {quo.problem ? <p className="text-sm text-warning-foreground">{quo.problem}</p> : null}
      <p className="text-xs text-muted-foreground">Numbers: {quo.numbers.length ? quo.numbers.map((n) => n.name ? `${n.name} (${n.number})` : n.number).join(", ") : "none listed yet"} · Signed notices: {quo.webhook ? "set up" : "not set up, so new texts arrive only when Quality next checks"} · Reading from {whenLabel(quo.readFrom, now, timezone)}</p>
      {!data.settings.readPhonePlatform ? <p className="text-xs font-medium text-warning-foreground">Connected, but reading for quality evidence is off. Turn it on under Your rules.</p> : null}
      {owner ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" loading={busy} onClick={() => run(() => recheck({ companyId, connectionId: quo.id }))}>Check again</Button>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => run(() => disconnect({ companyId, connectionId: quo.id }))}>Disconnect</Button>
        </div>
      ) : null}
      <FormError message={error} />
    </div>
  );
}

function LinkQueue() {
  const { companyId, timezone, role } = useCompany();
  const now = useNow();
  const rows = useQuery(api.qualityComms.associations, role === "office" ? "skip" : { companyId });
  const link = useMutation(api.qualityComms.link);
  const dismiss = useMutation(api.qualityComms.dismiss);
  const unlink = useMutation(api.qualityComms.unlink);
  const { busy, error, run } = useRun();
  if (role === "office") return <p className="p-4 text-sm text-muted-foreground">A manager or the Owner links conversations to visits.</p>;
  if (rows === undefined) return <Skeleton className="m-4 h-24 rounded-xl" />;
  if (!rows.length) return <div className="p-4"><Empty title="Nothing to link" body="When a call or text could be about more than one visit, or no visit at all, it waits here for a person. Quality never guesses." /></div>;
  return (
    <ul className="divide-y divide-border">
      {rows.map((a) => (
        <li key={a.id} className="grid gap-2 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" size="sm">{a.kind === "call" ? "Call" : "Text"} · {a.direction === "incoming" ? "incoming" : "outgoing"}</Badge>
            <span>{whenLabel(a.occurredAt, now, timezone)}</span>
          </div>
          {a.excerpt ? <blockquote className="border-l-2 border-border pl-3 text-sm text-foreground">{a.excerpt}</blockquote> : null}
          <p className="text-xs text-muted-foreground">Why it needs a person: {a.why}</p>
          <ul className="grid gap-1.5">
            {a.candidates.map((c) => (
              <li key={c.jobId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                <span>
                  <span className="font-medium text-strong">{c.customer}</span> · {c.service} · {c.property} · {whenLabel(c.startsAt, now, timezone)}
                  {c.for.length ? <span className="block text-xs text-muted-foreground">Points to it: {c.for.join("; ")}</span> : null}
                  {c.against.length ? <span className="block text-xs text-muted-foreground">Against: {c.against.join("; ")}</span> : null}
                </span>
                <Button size="sm" variant="outline" loading={busy} onClick={() => run(() => link({ companyId, associationId: a.id, jobId: c.jobId as Id<"jobs"> }))}>Link to this visit</Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" loading={busy} onClick={() => run(() => unlink({ companyId, associationId: a.id }))}>None of these</Button>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => run(() => dismiss({ companyId, associationId: a.id }))}>Not about a visit</Button>
          </div>
        </li>
      ))}
      <FormError message={error} />
    </ul>
  );
}

export function QualityPlaybookScreen() {
  const { companyId, role, timezone } = useCompany();
  const now = useNow();
  const permissions = useQuery(api.permissions.list, { companyId });
  const data = useStableQuery(api.quality.playbook, { companyId });
  return (
    <>
      <PageHeader title="Playbook" lead="How Quality works for you: what it may do without asking, your timing rules, and where its evidence comes from. It uses your standards as written and invents none." />
      <div className="grid gap-5">
        {data && !data.agent.ok ? <p className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-strong" role="status">{data.agent.reason}</p> : null}
        {SECTIONS.map((section) => (
          <Panel key={section.title} title={section.title}>
            <p className="mb-3 text-sm text-muted-foreground">{section.lead}</p>
            {permissions ? (
              <div className="grid gap-3">
                {permissions.actions.filter((a) => section.keys.includes(a.key)).map((action) => <PermissionRow key={action.key} action={action} canEdit={role === "owner"} />)}
              </div>
            ) : <Skeleton className="h-20 rounded-xl" />}
          </Panel>
        ))}
        <Panel title="Always a person">
          <ul className="grid list-disc gap-1 pl-5 text-sm text-foreground">
            <li>Confirming or rejecting a finding. Quality suggests; a person decides what happened.</li>
            <li>Anything about a cleaner&rsquo;s pay, standing, discipline or schedule. Quality keeps no score.</li>
            <li>Serious incidents: injury, damage, theft, safety and conduct. Restricted to the Owner, evidence preserved, and nothing admitted, promised or reported on the company&rsquo;s behalf.</li>
            <li>Publishing a standard and adopting an improvement.</li>
          </ul>
        </Panel>
        <Panel title="Your rules">{data ? <Rules data={data} /> : <Skeleton className="h-64 rounded-xl" />}</Panel>
        <Panel title="Where evidence comes from">
          {data ? (
            <ul className="grid gap-3 p-4">
              {data.sources.map((src) => (
                <li key={src.id} className="grid gap-2 rounded-xl border border-border bg-background p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-strong">{src.name}</span>
                    <Badge variant={SOURCE_TONE[src.state]} size="sm">{SOURCE_WORDS[src.state]}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{src.detail}{src.lastSuccessAt ? ` Last read ${whenLabel(src.lastSuccessAt, now, timezone)}.` : ""}</p>
                  <dl className="grid gap-1 text-xs sm:grid-cols-2">
                    {src.capabilities.map((c) => (
                      <div key={c.label} className="flex gap-2">
                        <dt className="w-28 shrink-0 text-muted-foreground">{c.label}</dt>
                        <dd><span className="font-medium text-strong">{CAP_WORDS[c.state]}</span>{c.note ? <span className="text-muted-foreground"> · {c.note}</span> : null}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          ) : <Skeleton className="m-4 h-40 rounded-xl" />}
        </Panel>
        <Panel title="Quo (formerly OpenPhone)">{data ? <QuoPanel data={data} /> : <Skeleton className="m-4 h-24 rounded-xl" />}</Panel>
        <section id="associations">
          <Panel title="Conversations to link">
            <LinkQueue />
          </Panel>
        </section>
      </div>
    </>
  );
}
