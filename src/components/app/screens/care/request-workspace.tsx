"use client";

/**
 * One client request, given room: the conversation it came from beside what Client Care found, what it did,
 * what is pending and what a person can do. The change and the message about it are shown apart, and a
 * message's state is the provider's: queued, accepted, delivered, or not known.
 *
 * Words a client wrote are plain text and nothing else. Access codes are never shown here; they live on the
 * property, for Owners and Managers.
 */
import { useMutation } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, FormError, TextArea, useRun } from "@/components/app/form";
import { useNow } from "@/components/app/use-now";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Hand, Hourglass, LightningIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { whenLabel } from "@/lib/app/format";
import { useStableQuery } from "@/lib/app/stable-query";
import { cn } from "@/lib/utils";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { BasisTag, StatusPill, UrgencyFlag, type CareDetail } from "./shared";

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="grid content-start gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-strong">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

const PART_TONE: Record<string, string> = {
  done: "text-success-foreground",
  pending: "text-muted-foreground",
  failed: "text-destructive-foreground",
  uncertain: "text-warning-foreground",
  skipped: "text-muted-foreground",
};
const PART_WORDS: Record<string, string> = { done: "Done", pending: "Pending", failed: "Didn't happen", uncertain: "Not known", skipped: "Skipped" };

function Thread({ items, now, timezone }: { items: CareDetail["thread"]; now: number | null; timezone: string }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">No messages on this request yet.</p>;
  return (
    <ol className="grid content-start gap-2.5" aria-label="Conversation">
      {items.map((m) => (
        <li key={m.id} className={cn("grid max-w-[88%] gap-1", m.direction === "out" ? "justify-self-end" : "justify-self-start")}>
          <div className={cn("rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]", m.direction === "out" ? "rounded-br-md bg-brand-500/12 text-strong" : "rounded-bl-md border border-border bg-card text-foreground")}>{m.body}</div>
          <p className={cn("text-[11px] text-muted-foreground", m.direction === "out" ? "text-right" : "")}>
            {m.by} · {m.channel === "sms" ? "Text" : "Email"} · {now ? whenLabel(m.at, now, timezone) : ""}
            {m.withheld ? " · access details withheld" : ""}
            {m.statusWords ? <span className={cn(" font-medium", m.status === "failed" || m.status === "not_sent" ? "text-destructive-foreground" : m.status === "unknown" ? "text-warning-foreground" : "")}> · {m.statusWords}</span> : null}
          </p>
        </li>
      ))}
    </ol>
  );
}

function Steps({ steps, onRetry, busy }: { steps: CareDetail["steps"]; onRetry: (id: string) => void; busy: boolean }) {
  if (!steps.length) return <p className="text-sm text-muted-foreground">Client Care hasn’t prepared anything on this request yet.</p>;
  return (
    <ol className="grid gap-2.5">
      {steps.map((s) => (
        <li key={s.id} className={cn("grid gap-2 rounded-xl border bg-background p-3.5", s.status === "partial" || s.status === "failed" || s.status === "uncertain" ? "border-warning/40" : "border-border")}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 text-sm font-medium text-strong [overflow-wrap:anywhere]">{s.summary}</p>
            <span className="text-xs font-medium whitespace-nowrap text-muted-foreground">{s.statusWords}</span>
          </div>
          <p className="text-xs text-muted-foreground">Permission: {s.permission}</p>
          {s.message ? <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">{s.message}</p> : null}
          {s.parts.length ? (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {s.parts.map((p) => (
                <li key={p.name} className={PART_TONE[p.state]}>
                  <span className="font-semibold">{p.name}:</span> {PART_WORDS[p.state] ?? p.state}
                  {p.detail ? <span className="text-muted-foreground"> ({p.detail})</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {s.result && s.status !== "done" && !s.parts.length ? <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{s.result}</p> : null}
          <div className="flex flex-wrap gap-2">
            {s.approvalId ? (
              <Link href="/app/approvals" className="inline-flex items-center gap-1 text-xs font-medium text-brand-300 hover:underline">
                Decide in Approvals <ArrowUpRight className="size-3" aria-hidden />
              </Link>
            ) : null}
            {s.retry ? (
              <Button size="sm" variant="outline" loading={busy} onClick={() => onRetry(s.id)}>
                Retry the message
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function RequestWorkspaceBody({ requestId }: { requestId: Id<"careRequests"> }) {
  const { companyId, timezone } = useCompany();
  const now = useNow();
  const detail = useStableQuery(api.clientCare.detail, { companyId, requestId });
  const takeOver = useMutation(api.clientCare.takeOver);
  const handBack = useMutation(api.clientCare.handBack);
  const resolve = useMutation(api.clientCare.resolve);
  const close = useMutation(api.clientCare.close);
  const reopen = useMutation(api.clientCare.reopen);
  const runAgain = useMutation(api.clientCare.runAgain);
  const retry = useMutation(api.clientCare.retry);
  const note = useMutation(api.clientCare.note);
  const { busy, error, run } = useRun();
  const [closing, setClosing] = useState<null | "resolve" | "close" | "reopen" | "note">(null);
  const [words, setWords] = useState("");

  if (detail === undefined) {
    return (
      <div className="grid gap-3 p-5" aria-busy="true" aria-label="Loading the request">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }
  const r = detail.request;
  const submit = () =>
    run(async () => {
      const text = words.trim();
      if (!text) throw new Error(closing === "note" ? "Write the note first." : "Say what happened first.");
      if (closing === "resolve") await resolve({ companyId, requestId, note: text });
      if (closing === "close") await close({ companyId, requestId, reason: text });
      if (closing === "reopen") await reopen({ companyId, requestId, reason: text });
      if (closing === "note") await note({ companyId, requestId, body: text });
      setClosing(null);
      setWords("");
    });
  const prompts = { resolve: "What happened? (kept on the request)", close: "Why is it closing without action?", reopen: "Why is it being reopened?", note: "Internal note (the client never sees it)" } as const;
  return (
    <div className="grid gap-5 p-4 sm:p-6">
      <header className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={r.status} words={r.statusWords} />
          <UrgencyFlag urgency={r.urgency} />
          {r.held ? (
            <span className="inline-flex h-5 items-center gap-1 rounded-md border border-border bg-muted px-1.5 text-[11px] font-medium text-strong">
              <Hand className="size-3" aria-hidden />
              {r.owner} has this
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {r.categoryWords} · by {r.channel === "sms" ? "text" : "email"}
          </span>
        </div>
        <div>
          <h2 className="font-heading text-xl tracking-tight text-strong">{detail.customer?.name ?? r.customer.name}</h2>
          <p className="text-sm text-muted-foreground">
            {r.authority.as === "contact" ? `${r.authority.name}, a ${r.authority.roles.join(", ") || "contact"} contact${r.authority.limited ? " for some properties only" : ""}` : "The client's own phone or email"}
            {detail.property ? ` · ${detail.property.name}, ${detail.property.city}` : ""}
          </p>
        </div>
        <dl className="grid gap-2 text-sm">
          <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr]">
            <dt className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Asked</dt>
            <dd className="[overflow-wrap:anywhere]">{r.summary}</dd>
          </div>
          <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr]">
            <dt className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Resolved means</dt>
            <dd>{r.requestedOutcome}</dd>
          </div>
          {r.blocker || r.waiting ? (
            <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr]">
              <dt className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{r.status === "waiting_owner" ? "Needs you" : "Waiting"}</dt>
              <dd className="font-medium text-strong [overflow-wrap:anywhere]">{r.blocker ?? r.waiting}</dd>
            </div>
          ) : null}
          {r.resolution ? (
            <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr]">
              <dt className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Outcome</dt>
              <dd>{r.resolution.words}</dd>
            </div>
          ) : null}
        </dl>
        <div className="flex flex-wrap gap-2">
          {detail.can.takeOver ? (
            <Button size="sm" variant="outline" loading={busy} onClick={() => run(() => takeOver({ companyId, requestId }))}>
              <Hand className="size-4" aria-hidden />
              Take over
            </Button>
          ) : null}
          {detail.can.handBack ? (
            <Button size="sm" variant="outline" loading={busy} onClick={() => run(() => handBack({ companyId, requestId }))}>
              Hand back to Client Care
            </Button>
          ) : null}
          {detail.can.runAgain ? (
            <Button size="sm" variant="outline" loading={busy} onClick={() => run(() => runAgain({ companyId, requestId }))}>
              <LightningIcon className="size-4" aria-hidden />
              Work it again
            </Button>
          ) : null}
          {detail.can.resolve ? (
            <Button size="sm" onClick={() => setClosing("resolve")}>
              <CheckCircle2 className="size-4" aria-hidden />
              Resolve
            </Button>
          ) : null}
          {detail.can.close ? (
            <Button size="sm" variant="ghost" onClick={() => setClosing("close")}>
              Close without action
            </Button>
          ) : null}
          {detail.can.reopen ? (
            <Button size="sm" variant="outline" onClick={() => setClosing("reopen")}>
              Reopen
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setClosing("note")}>
            Add a note
          </Button>
        </div>
        {closing ? (
          <div className="grid gap-2 rounded-xl border border-border bg-card p-3.5">
            <Field label={prompts[closing]}>
              <TextArea value={words} onChange={(event) => setWords(event.target.value)} rows={2} maxLength={400} />
            </Field>
            <div className="flex gap-2">
              <Button size="sm" loading={busy} onClick={submit}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setClosing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        <FormError message={error} />
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Section
          title="Conversation"
          aside={
            <span className="flex gap-3 text-xs">
              {detail.conversation.inboxHref ? (
                <Link href={detail.conversation.inboxHref} className="font-medium text-brand-300 hover:underline">
                  Open in Inbox
                </Link>
              ) : null}
              <Link href={detail.conversation.clientHref} className="font-medium text-brand-300 hover:underline">
                Client’s conversations
              </Link>
            </span>
          }
        >
          {detail.conversation.held ? (
            <p className="flex items-start gap-2 rounded-xl border border-border bg-muted/50 px-3 py-2 text-xs text-strong">
              <Hand className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {detail.conversation.held}
            </p>
          ) : null}
          <Thread items={detail.thread} now={now} timezone={timezone} />
        </Section>

        <div className="grid content-start gap-6">
          {r.pending ? (
            <Section title="Waiting for the client">
              <div className="grid gap-1.5 rounded-xl border border-border bg-card p-3.5 text-sm">
                <p className="font-medium text-strong">{r.pending.question}</p>
                {r.pending.options.length ? <p className="text-muted-foreground">Offered: {r.pending.options.join(" · ")}</p> : null}
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Hourglass className="size-3.5" aria-hidden />
                  {r.pending.reminded ? "Reminded once. A person takes it if there's still no answer" : "One reminder"} {now ? whenLabel(r.pending.expiresAt, now, timezone) : ""}
                </p>
              </div>
            </Section>
          ) : null}
          {r.promisedBy ? (
            <p className="text-sm text-strong">
              <span className="font-semibold">Promised update:</span> {now ? whenLabel(r.promisedBy, now, timezone) : ""}
            </p>
          ) : null}
          <Section title="What Client Care found">
            <ul className="grid gap-2">
              {detail.visit ? (
                <li className="flex flex-wrap items-center gap-2 text-sm">
                  <BasisTag basis="record" />
                  Visit {detail.visit.when}, {detail.visit.service} ({detail.visit.status.replace(/_/g, " ")}
                  {detail.visit.held ? ", held by a migration" : ""})
                </li>
              ) : null}
              {detail.facts.map((f) => (
                <li key={f.key} className="flex flex-wrap items-start gap-2 text-sm [overflow-wrap:anywhere]">
                  <BasisTag basis={f.basis} />
                  <span className="min-w-0 flex-1">{f.value}</span>
                </li>
              ))}
              <li className="flex flex-wrap items-center gap-2 text-sm">
                <BasisTag basis="policy" />
                {detail.policy.noticeHours !== null ? `Change notice: ${detail.policy.noticeHours} hours (${detail.policy.source})` : "No change notice is set. Late changes come to you."}
              </li>
              {!detail.visit && !detail.facts.length ? <li className="text-sm text-muted-foreground">Nothing read from a record yet.</li> : null}
            </ul>
          </Section>
          <Section title="What it has done">
            <Steps steps={detail.steps} busy={busy} onRetry={(id) => run(() => retry({ companyId, stepId: id as Id<"careSteps"> }))} />
          </Section>
          {detail.linked.length ? (
            <Section title="Linked work">
              <ul className="grid gap-2">
                {detail.linked.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm hover:border-brand-500/50">
                      <span className="min-w-0">
                        <span className="block text-xs text-muted-foreground">{l.kind}</span>
                        <span className="block font-medium text-strong [overflow-wrap:anywhere]">{l.label}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">{l.state}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      </div>

      <Section title="History">
        <ol className="grid gap-2 border-l border-border pl-4">
          {detail.entries.map((e) => (
            <li key={e.id} className="relative grid gap-0.5">
              <span aria-hidden className={cn("absolute top-1.5 -left-[1.3rem] size-2 rounded-full", e.kind === "problem" ? "bg-warning" : e.kind === "resolved" || e.kind === "did" ? "bg-success" : "bg-border")} />
              <p className="text-sm text-foreground [overflow-wrap:anywhere]">
                {e.kind === "problem" ? <AlertTriangle className="mr-1 inline size-3.5 text-warning-foreground" aria-hidden /> : null}
                {e.text}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {e.by} · {now ? whenLabel(e.at, now, timezone) : ""}
              </p>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

export function RequestWorkspace({ id, onClose }: { id: string | null; onClose: () => void }) {
  return (
    <Sheet open={id !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetPopup side="right" className="w-full max-w-5xl bg-background">
        <SheetTitle className="sr-only">Client request</SheetTitle>
        <ScrollArea className="min-h-0 flex-1">{id ? <RequestWorkspaceBody requestId={id as Id<"careRequests">} /> : null}</ScrollArea>
      </SheetPopup>
    </Sheet>
  );
}
