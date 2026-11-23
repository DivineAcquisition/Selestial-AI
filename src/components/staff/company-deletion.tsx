"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { Field, FormError, TextArea, TextInput, useRun } from "@/components/app/form";
import { Panel } from "@/components/app/shell";
import { AlertTriangle, CheckCircle2, Clock, MinusCircle, ShieldCheck, XCircle } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/fields";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

type View = NonNullable<FunctionReturnType<typeof api.companyDeletion.forRequest>>;
type Item = View["preconditions"][number];

const ITEM_STATE: Record<Item["state"], { label: string; variant: "success" | "error" | "warning" | "info" | "outline"; Icon: typeof CheckCircle2 }> = {
  ok: { label: "Done", variant: "success", Icon: CheckCircle2 },
  blocking: { label: "Blocking", variant: "error", Icon: XCircle },
  waived: { label: "Waived", variant: "warning", Icon: MinusCircle },
  by_run: { label: "Run does it", variant: "info", Icon: Clock },
  info: { label: "For the record", variant: "outline", Icon: ShieldCheck },
};

const TREATMENT: Record<"delete" | "anonymize" | "retain", { title: string; lead: string }> = {
  delete: { title: "Deleted", lead: "The rows go, with any files they hold." },
  anonymize: { title: "Anonymized", lead: "The row stays so kept financial records point at something; names, contact details, addresses and free text are replaced." },
  retain: { title: "Kept", lead: "Required by law, the carriers or a payment processor. Personal text is stripped where the record still makes sense without it; opt-out addresses are kept only as a hash." },
};

const when = (at: number) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * A company deletion request in the staff console: the preconditions, what will be deleted, anonymized and
 * kept and why, the typed confirmation, live progress and the final summary. Every action is checked again
 * on the server (convex/companyDeletion.ts); this only decides what to draw.
 */
export function CompanyDeletionPanel({ requestId }: { requestId: Id<"trustRequests"> }) {
  const view = useQuery(api.companyDeletion.forRequest, { requestId });
  if (view === undefined) return <Skeleton className="h-64 rounded-2xl" />;
  if (view === null) return null;
  return (
    <Panel title="Delete the company" action={<RunBadge view={view} />}>
      <div className="grid gap-6">
        {view.run && view.run.status !== "preparing" ? <Progress view={view} requestId={requestId} /> : null}
        {!view.deleted && !view.closing ? <Checklist view={view} requestId={requestId} /> : null}
        <Retention view={view} />
        {!view.deleted && !view.closing && view.requestOpen ? <Start view={view} requestId={requestId} /> : null}
      </div>
    </Panel>
  );
}

function RunBadge({ view }: { view: View }) {
  if (view.deleted) return <Badge variant="success">Deleted</Badge>;
  if (view.run?.status === "failed") return <Badge variant="error">Stopped</Badge>;
  if (view.closing) return <Badge variant="info">Deleting</Badge>;
  return <Badge variant={view.canStart ? "outline" : "warning"}>{view.canStart ? "Ready to start" : "Not ready"}</Badge>;
}

function Checklist({ view, requestId }: { view: View; requestId: Id<"trustRequests"> }) {
  return (
    <div className="grid gap-2">
      <h3 className="text-sm font-semibold text-strong">Before it can start</h3>
      <ul className="grid gap-2" aria-label="Preconditions">
        {view.preconditions.map((item) => {
          const state = ITEM_STATE[item.state];
          return (
            <li key={item.key} className="rounded-xl border border-border px-3 py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="flex min-w-0 items-start gap-2">
                  <state.Icon className={cn("mt-0.5 size-4 shrink-0", item.state === "blocking" ? "text-destructive-foreground" : item.state === "ok" ? "text-success-foreground" : "text-muted-foreground")} aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-strong">{item.label}</span>
                    <span className="block text-xs leading-relaxed text-muted-foreground">{item.detail}</span>
                    {item.waiver ? <span className="mt-1 block text-xs text-strong">Waived {when(item.waiver.at)}: {item.waiver.reason}</span> : null}
                  </span>
                </span>
                <Badge variant={state.variant}>{state.label}</Badge>
              </div>
              {item.state === "blocking" && item.waivable && view.viewer.admin && view.viewer.canDestroy ? <Waive requestId={requestId} item={item} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Waive({ requestId, item }: { requestId: Id<"trustRequests">; item: Item }) {
  const waive = useMutation(api.companyDeletion.waive);
  const { busy, error, run } = useRun();
  const [reason, setReason] = useState("");
  return (
    <Disclosure title="Waive this, with a reason" variant="plain" className="mt-2">
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => waive({ requestId, key: item.key as "payments" | "messaging", reason }));
        }}
      >
        <Field label="Why it is safe to go ahead" hint="Recorded on the request and on the deletion.">
          <TextArea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
        </Field>
        <FormError message={error} />
        <div>
          <Button type="submit" size="sm" variant="outline" loading={busy} disabled={reason.trim().length < 10}>
            Waive
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

function Retention({ view }: { view: View }) {
  return (
    <div className="grid gap-2">
      <h3 className="text-sm font-semibold text-strong">What happens to each kind of record</h3>
      {(["delete", "anonymize", "retain"] as const).map((treatment) => {
        const rows = view.retention.filter((row) => row.treatment === treatment);
        const counts = view.run?.tables;
        return (
          <Disclosure key={treatment} title={`${TREATMENT[treatment].title} (${rows.length} tables)`} summary={TREATMENT[treatment].lead}>
            <ul className="grid gap-1.5 text-sm">
              {rows.map((row) => {
                const count = counts?.find((entry) => entry.table === row.table);
                return (
                  <li key={row.table} className="grid gap-0.5 rounded-lg bg-overlay/[0.03] px-3 py-2 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-3">
                    <span className="font-mono text-xs break-all text-strong">
                      {row.table}
                      {row.counsel ? <span className="ml-1 font-sans text-[0.6875rem] text-warning-foreground">· for counsel</span> : null}
                    </span>
                    <span className="text-xs leading-relaxed text-muted-foreground">
                      {row.reason}
                      {count && (count.deleted || count.anonymized || count.retained) ? (
                        <span className="mt-0.5 block text-strong">
                          {[count.deleted ? `${count.deleted} deleted` : "", count.anonymized ? `${count.anonymized} anonymized` : "", count.retained ? `${count.retained} kept` : "", count.files ? `${count.files} files` : ""].filter(Boolean).join(" · ")}
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Disclosure>
        );
      })}
    </div>
  );
}

function Start({ view, requestId }: { view: View; requestId: Id<"trustRequests"> }) {
  const start = useMutation(api.companyDeletion.start);
  const { busy, error, run } = useRun();
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === view.companyName.trim();
  if (!view.viewer.canDestroy) {
    return <p className="rounded-xl border border-border px-3 py-2.5 text-sm text-muted-foreground">Starting a deletion needs the Destructive actions capability. An admin grants it per person in Staff.</p>;
  }
  return (
    <form
      className="grid gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => start({ requestId, confirmName: typed }));
      }}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive-foreground" aria-hidden />
        <p className="text-sm text-strong">
          This cannot be undone. The company closes at once to its team, its links and its agents; then its records are deleted, anonymized or kept as listed above. Sign-in accounts are not deleted.
        </p>
      </div>
      <Field label={`Type the company's name to confirm: ${view.companyName}`}>
        <TextInput value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} aria-invalid={typed.length > 0 && !matches} />
      </Field>
      <FormError message={error} />
      <div>
        <Button type="submit" variant="destructive" size="sm" loading={busy} disabled={!matches || !view.canStart}>
          Delete {view.companyName}
        </Button>
        {!view.canStart ? <p className="mt-2 text-xs text-muted-foreground">Clear or waive every blocking item first.</p> : null}
      </div>
    </form>
  );
}

function Progress({ view, requestId }: { view: View; requestId: Id<"trustRequests"> }) {
  const resume = useMutation(api.companyDeletion.resume);
  const { busy, error, run } = useRun();
  const r = view.run!;
  const percent = r.tablesTotal ? Math.round((r.tablesDone / r.tablesTotal) * 100) : 0;
  return (
    <div className="grid gap-3">
      <h3 className="text-sm font-semibold text-strong">{r.status === "completed" ? "Done" : r.status === "failed" ? "Stopped" : "In progress"}</h3>
      <div>
        <div className="h-2 overflow-hidden rounded-full bg-overlay/[0.06]" role="progressbar" aria-label="Tables done" aria-valuemin={0} aria-valuemax={r.tablesTotal} aria-valuenow={r.tablesDone}>
          <div className={cn("h-full rounded-full transition-[width]", r.status === "failed" ? "bg-destructive" : "bg-brand-500")} style={{ width: `${r.status === "completed" ? 100 : percent}%` }} />
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground" aria-live="polite">
          {r.tablesDone} of {r.tablesTotal} tables{r.status === "running" && r.current ? ` · now ${r.current}` : ""} · {r.totals.deleted} deleted · {r.totals.anonymized} anonymized · {r.totals.retained} kept · {r.totals.files} files
        </p>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        {r.startedAt ? <Row label="Started" value={when(r.startedAt)} /> : null}
        {r.finishedAt ? <Row label="Finished" value={when(r.finishedAt)} /> : null}
        {r.disconnected ? <Row label="Disconnected first" value={`${r.disconnected.google} Google · ${r.disconnected.inboxes} inboxes · ${r.disconnected.connectors} Jobber/Housecall`} /> : null}
        <Row label="Export" value={r.exportDownloadedAt ? `Downloaded ${when(r.exportDownloadedAt)}` : "None downloaded"} />
      </dl>
      {r.errors.length ? (
        <ul className="grid gap-1 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs" aria-label="Errors">
          {r.errors.map((row, index) => (
            <li key={index} className="text-strong">
              {when(row.at)} · {row.table ?? "run"}: {row.message}
            </li>
          ))}
        </ul>
      ) : null}
      {r.status === "failed" && view.viewer.canDestroy ? (
        <div>
          <FormError message={error} />
          <Button size="sm" variant="outline" loading={busy} onClick={() => void run(() => resume({ requestId }))}>
            Resume from where it stopped
          </Button>
        </div>
      ) : null}
      {r.summary ? <p className="rounded-xl bg-overlay/[0.03] px-3 py-2.5 text-sm leading-relaxed text-strong">{r.summary}</p> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-strong">{value}</dd>
    </div>
  );
}
