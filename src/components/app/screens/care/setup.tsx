"use client";

/**
 * Care Setup: how Client Care works for this company. Settings that live elsewhere are shown and linked, never
 * copied: authority (Agent Controls' one policy), operating hours (Business & hours), the sender and quiet hours
 * (texting), each person's notifications (their own settings) and the pause (the company's agent list). Only the
 * Owner changes anything here; everyone else reads it.
 */
import { useMutation } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, FormError, TextArea, TextInput, useRun } from "@/components/app/form";
import { PageHeader, Panel } from "@/components/app/shell";
import { AlertTriangle, ArrowUpRight, CheckCircle2, PauseCircleIcon, Play } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckboxRow, Select, SwitchRow } from "@/components/ui/selection";
import { useStableQuery } from "@/lib/app/stable-query";
import { cn } from "@/lib/utils";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import type { CareSetupView } from "./shared";

const LEVELS = [
  { value: "off", label: "Off" },
  { value: "propose", label: "Ask me first" },
  { value: "execute_and_report", label: "Act and notify me" },
  { value: "execute", label: "Act automatically" },
] as const;
type Level = (typeof LEVELS)[number]["value"];
const RANK: Record<Level, number> = { off: 0, propose: 1, execute_and_report: 2, execute: 3 };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const clock = (minute: number) => `${Math.floor(minute / 60) % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${minute >= 720 ? "PM" : "AM"}`;

type Draft = { requestTypes: string[]; notice: string; fee: string; source: string; tone: "warm" | "direct" | "formal"; signature: string; escalation: string[]; respond: string; update: string; readInbox: boolean };

function draftOf(view: CareSetupView): Draft {
  const s = view.settings;
  return {
    requestTypes: [...s.requestTypes],
    notice: s.policy.changeNoticeHours === null ? "" : String(s.policy.changeNoticeHours),
    fee: s.policy.lateChangeFeeCents === null ? "" : (s.policy.lateChangeFeeCents / 100).toFixed(2),
    source: s.policy.source ?? "",
    tone: s.tone,
    signature: s.signature ?? "",
    escalation: s.escalationMemberIds.map(String),
    respond: String(s.respondWithinMinutes),
    update: String(s.updateEveryHours),
    readInbox: s.readInbox,
  };
}

function Readiness({ ready, words }: { ready: boolean; words: string }) {
  return (
    <p className={cn("flex items-start gap-2 text-sm", ready ? "text-foreground" : "text-strong")}>
      {ready ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-foreground" aria-hidden /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden />}
      <span className="[overflow-wrap:anywhere]">{words}</span>
    </p>
  );
}

function Authority({ view }: { view: CareSetupView }) {
  const { companyId } = useCompany();
  const set = useMutation(api.permissions.set);
  const { busy, error, run } = useRun();
  return (
    <Panel title="What Client Care may do" action={<Link href="/app/settings/agents" className="inline-flex items-center gap-1 text-sm font-medium text-brand-300 hover:underline">Agent Controls <ArrowUpRight className="size-3.5" aria-hidden /></Link>}>
      <div className="grid gap-3 p-4">
        <p className="text-sm text-muted-foreground">One setting per kind of action, the same policy Agent Controls shows. Refunds, credits, contract changes and anything a policy doesn’t allow are never Client Care’s: they stay on their existing decision path.</p>
        <FormError message={error} />
        <ul className="divide-y divide-border rounded-xl border border-border">
          {view.permissions.map((p) => (
            <li key={p.key} className="grid gap-2 px-3.5 py-3 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center">
              <div className="min-w-0">
                <p className="text-sm font-medium text-strong">{p.label}</p>
                {p.note ? <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{p.note}</p> : null}
                {!p.implemented ? <p className="text-xs font-medium text-warning-foreground">Not available yet: a person does this.</p> : null}
              </div>
              {p.implemented && p.level ? (
                <Select
                  aria-label={`Level for ${p.label}`}
                  value={p.level}
                  disabled={!view.canEdit || busy}
                  onValueChange={(value) => value && run(() => set({ companyId, action: p.key, level: value as Level }))}
                  options={LEVELS.filter((l) => RANK[l.value] <= RANK[p.ceiling as Level]).map((l) => ({ value: l.value, label: l.label }))}
                />
              ) : (
                <span className="text-sm text-muted-foreground">{p.state === "paused" ? "Paused" : "A person, always"}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

export function CareSetupScreen() {
  const { companyId } = useCompany();
  const view = useStableQuery(api.clientCare.setup, { companyId });
  const save = useMutation(api.clientCare.saveSetup);
  const pause = useMutation(api.companies.pauseAgent);
  const resume = useMutation(api.companies.resumeAgent);
  const { busy, error, run } = useRun();
  // Edits are kept apart from what is saved: until someone changes a field, the form shows the saved settings.
  const [edited, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  const draft = edited ?? (view ? draftOf(view) : null);

  if (!view || !draft) {
    return (
      <>
        <PageHeader title="Care Setup" />
        <div className="grid gap-5" aria-busy="true" aria-label="Loading Care Setup">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      </>
    );
  }
  const edit = view.canEdit;
  const patch = (next: Partial<Draft>) => {
    setSaved(false);
    setDraft({ ...draft, ...next });
  };
  const number = (value: string) => (value.trim() === "" ? undefined : Number(value));
  const submit = () =>
    run(async () => {
      await save({
        companyId,
        expectedRevision: view.settings.revision,
        settings: {
          requestTypes: draft.requestTypes as never,
          policy: { changeNoticeHours: number(draft.notice), lateChangeFeeCents: draft.fee.trim() === "" ? undefined : Math.round(Number(draft.fee) * 100), source: draft.source.trim() || undefined },
          tone: draft.tone,
          signature: draft.signature.trim() || undefined,
          escalationMemberIds: draft.escalation as Id<"members">[],
          respondWithinMinutes: number(draft.respond),
          updateEveryHours: number(draft.update),
          readInbox: draft.readInbox,
        },
      });
      setDraft(null);
      setSaved(true);
    });
  return (
    <>
      <PageHeader
        title="Care Setup"
        lead="How Client Care works for your clients. Your client's own agreement comes first for change notice and fees; what you set here applies when it doesn't say."
        actions={
          edit ? (
            <Button variant="outline" size="sm" loading={busy} onClick={() => run(() => (view.agent.paused ? resume({ companyId, agent: "customer-care" }) : pause({ companyId, agent: "customer-care" })))}>
              {view.agent.paused ? <Play className="size-4" aria-hidden /> : <PauseCircleIcon className="size-4" aria-hidden />}
              {view.agent.paused ? "Resume Client Care" : "Pause Client Care"}
            </Button>
          ) : null
        }
      />
      <div className="grid gap-5">
        {view.agent.reason ? <Readiness ready={false} words={view.agent.reason} /> : null}

        <Panel title="Channels">
          <div className="grid gap-2.5 p-4">
            <Readiness ready={view.channels.sms.ready} words={view.channels.sms.words} />
            <Readiness ready={view.channels.email.ready} words={view.channels.email.words} />
            <p className="text-xs text-muted-foreground">
              Messages go as {view.channels.sender}, and Client Care says it is the company’s assistant. Sending hours, opt-outs and texting registration are checked for every message.{" "}
              <Link href="/app/texting" className="font-medium text-brand-300 hover:underline">
                Business texting
              </Link>{" "}
              ·{" "}
              <Link href="/app/settings/integrations?tool=gmail" className="font-medium text-brand-300 hover:underline">
                Connected inbox
              </Link>
            </p>
            <SwitchRow title="Read clients' email in the Care & Retention inbox" description="Only mail from an address on exactly one client's record is opened, only their own new lines are read, and nothing received before you turn this on is read. Nothing is deleted or moved." checked={draft.readInbox} onChange={(checked) => patch({ readInbox: checked })} disabled={!edit} />
          </div>
        </Panel>

        <Panel title="Request types">
          <div className="grid gap-2 p-4 sm:grid-cols-2">
            {view.categories.map((c) => (
              <CheckboxRow key={c.id} checked={draft.requestTypes.includes(c.id)} onCheckedChange={(checked) => patch({ requestTypes: checked ? [...draft.requestTypes, c.id] : draft.requestTypes.filter((id) => id !== c.id) })} title={c.words} description={draft.requestTypes.includes(c.id) ? "Client Care works these." : "Recorded and handed to a person."} disabled={!edit} bordered />
            ))}
          </div>
        </Panel>

        <Panel title="Change policy">
          <div className="grid gap-4 p-4 md:grid-cols-3">
            <Field label="Change notice (hours)" hint="Moves, skips and cancellations inside this window come to you. Empty: every change comes to you.">
              <TextInput inputMode="numeric" value={draft.notice} onChange={(event) => patch({ notice: event.target.value })} disabled={!edit} />
            </Field>
            <Field label="Late-change fee ($)" hint="Shown to you on a late change. Client Care never applies or quotes it.">
              <TextInput inputMode="decimal" value={draft.fee} onChange={(event) => patch({ fee: event.target.value })} disabled={!edit} />
            </Field>
            <Field label="Where this rule comes from" hint="For example, Service terms section 4.">
              <TextInput value={draft.source} onChange={(event) => patch({ source: event.target.value })} disabled={!edit} maxLength={200} />
            </Field>
          </div>
        </Panel>

        <Authority view={view} />

        <Panel title="Tone, signature and response times">
          <div className="grid gap-4 p-4 md:grid-cols-2">
            <div className="grid gap-1.5">
              <span id="care-tone" className="text-sm font-medium text-strong">Tone</span>
              <Select aria-labelledby="care-tone" value={draft.tone} disabled={!edit} onValueChange={(value) => value && patch({ tone: value as Draft["tone"] })} options={[{ value: "warm", label: "Warm" }, { value: "direct", label: "Direct" }, { value: "formal", label: "Formal" }]} />
            </div>
            <Field label="Email signature" hint="Added to emails. Never a person's name presented as the writer.">
              <TextArea rows={2} value={draft.signature} onChange={(event) => patch({ signature: event.target.value })} disabled={!edit} maxLength={300} />
            </Field>
            <Field label="First answer within (minutes)">
              <TextInput inputMode="numeric" value={draft.respond} onChange={(event) => patch({ respond: event.target.value })} disabled={!edit} />
            </Field>
            <Field label="Update a waiting client every (hours)" hint="Only while a request is really with the team, and at most four times before it comes to you.">
              <TextInput inputMode="numeric" value={draft.update} onChange={(event) => patch({ update: event.target.value })} disabled={!edit} />
            </Field>
          </div>
        </Panel>

        <Panel title="Escalation contacts" action={<Link href="/app/settings/notifications" className="inline-flex items-center gap-1 text-sm font-medium text-brand-300 hover:underline">Notification settings <ArrowUpRight className="size-3.5" aria-hidden /></Link>}>
          <div className="grid gap-2 p-4 sm:grid-cols-2">
            <p className="text-sm text-muted-foreground sm:col-span-2">Told first about urgent requests and requests that need a person. With nobody chosen, every Owner and Manager is told, under their own notification settings. Routine outcomes stay in the activity here instead of an email each time.</p>
            {view.escalation.map((m) => (
              <CheckboxRow key={m.id} checked={draft.escalation.includes(m.id)} onCheckedChange={(checked) => patch({ escalation: checked ? [...draft.escalation, m.id] : draft.escalation.filter((id) => id !== m.id) })} title={m.name} description={m.role === "owner" ? "Owner" : "Manager"} disabled={!edit} bordered />
            ))}
          </div>
        </Panel>

        <Panel title="Operating hours" action={<Link href="/app/settings/business" className="inline-flex items-center gap-1 text-sm font-medium text-brand-300 hover:underline">Business & hours <ArrowUpRight className="size-3.5" aria-hidden /></Link>}>
          <div className="p-4 text-sm">
            {view.hours.length ? (
              <ul className="grid gap-1 sm:grid-cols-2">
                {view.hours.map((h, i) => (
                  <li key={i}>
                    <span className="font-medium text-strong">{DAYS[h.weekday]}</span> {clock(h.from)} to {clock(h.to)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No operating hours are set, so Client Care offers times from the team’s availability alone.</p>
            )}
          </div>
        </Panel>

        <p className="text-xs text-muted-foreground">{view.readerNote}</p>
        {edit ? (
          <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border bg-card/95 p-3 shadow-sm backdrop-blur">
            <FormError message={error} />
            {saved ? <span className="text-sm text-success-foreground">Saved.</span> : null}
            <Button variant="ghost" onClick={() => setDraft(draftOf(view))}>
              Undo changes
            </Button>
            <Button loading={busy} onClick={submit}>
              Save Care Setup
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Only the Owner changes Care Setup.</p>
        )}
      </div>
    </>
  );
}
