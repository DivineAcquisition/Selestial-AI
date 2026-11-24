"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, TextArea } from "@/components/app/form";
import { AlertTriangle, CheckCircle2, ChevronDown, XCircle } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { changePath, servicePath } from "@/lib/app/services";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { bookingWords, reviewable } from "./home";
import { ChangeBadge, Empty, Notice } from "./shared";

type Outcome = { state: "done"; words: string } | { state: "failed"; words: string };
const NONE = { required: false, note: "" };

/**
 * Several drafts reviewed together. Each service is still published (or submitted) on its own, for the
 * exact revision shown here, with every check a single service gets; one that fails says why and leaves
 * the others as they finished.
 */
export function ReviewAll() {
  const { companyId } = useCompany();
  const catalog = useQuery(api.services.catalog, { companyId });
  const publish = useMutation(api.services.publishDraft);
  const submit = useMutation(api.services.submit);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  if (!catalog) return <Skeleton className="h-72 rounded-2xl" />;
  if (!catalog.canDraft) return <Notice>Owners and Managers review services. Your role can read them.</Notice>;
  const ready = catalog.services.filter((row) => reviewable(row) && !outcomes[row.id]);
  const work = catalog.services.filter((row) => row.status !== "archived" && row.draft !== null && row.draft.blockers > 0 && row.openChange === null);
  const waiting = catalog.services.filter((row) => row.openChange !== null);
  const done = catalog.services.filter((row) => outcomes[row.id]);
  const picked = ready.filter((row) => !skipped.includes(row.id));
  const verb = catalog.canPublish ? "Publish" : "Submit";

  const go = async () => {
    setBusy(true);
    for (const row of picked) {
      try {
        if (catalog.canPublish) {
          const result = await publish({ companyId, serviceId: row.id, expectedRevision: row.draft!.revision, reason });
          setOutcomes((all) => ({ ...all, [row.id]: { state: "done", words: result.state === "nothing" ? "Nothing to publish: already done." : result.state === "scheduled" ? `Version ${result.version} scheduled.` : `Version ${result.version} is live.` } }));
        } else {
          await submit({ companyId, serviceId: row.id, expectedRevision: row.draft!.revision, reason, customerNotice: NONE, contractReview: NONE });
          setOutcomes((all) => ({ ...all, [row.id]: { state: "done", words: "Sent to the Owner for review." } }));
        }
      } catch (caught) {
        setOutcomes((all) => ({ ...all, [row.id]: { state: "failed", words: (caught as { data?: { message?: string } }).data?.message ?? "It couldn't be done. Nothing changed for this service." } }));
      }
    }
    setBusy(false);
  };

  return (
    <div className="grid grid-cols-1 gap-5">
      {done.length ? (
        <section aria-labelledby="results" className="grid gap-2 rounded-2xl border border-border bg-card p-4 sm:p-5">
          <h2 id="results" className="text-base font-semibold text-strong">
            What happened
          </h2>
          <ul className="grid gap-1.5" aria-live="polite">
            {done.map((row) => {
              const o = outcomes[row.id];
              return (
                <li key={row.id} className="flex items-start gap-2 text-sm">
                  {o.state === "done" ? <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" /> : <XCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive-foreground" />}
                  <span>
                    <Link href={servicePath(row.id)} className="font-medium text-strong hover:underline">
                      {row.draft?.name || row.name}
                    </Link>
                    : <span className="text-muted-foreground">{o.words}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="ready" className="grid gap-3">
        <h2 id="ready" className="text-base font-semibold text-strong">
          Ready to {verb.toLowerCase()} <span className="font-normal text-muted-foreground">· {ready.length}</span>
        </h2>
        {ready.length === 0 ? (
          <Empty title="Nothing ready">{work.length ? "The drafts below need something first." : "Every draft is live or waiting for review."}</Empty>
        ) : (
          <>
            <ul className="grid gap-2">
              {ready.map((row) => (
                <ReadyRow key={row.id} row={row} on={!skipped.includes(row.id)} onToggle={(on) => setSkipped((list) => (on ? list.filter((id) => id !== row.id) : [...list, row.id]))} />
              ))}
            </ul>
            <div className="grid gap-3 rounded-2xl border border-border bg-card p-4">
              <Field label="Why these changes" hint="Kept with each new version.">
                <TextArea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="First prices for our services." />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" loading={busy} disabled={!picked.length || !reason.trim()} onClick={() => void go()}>
                  {verb} {picked.length} service{picked.length === 1 ? "" : "s"}
                </Button>
                <p className="text-xs text-muted-foreground">{catalog.canPublish ? "Each one is published exactly as shown. Booked visits, sent proposals and recurring customers keep their prices; open a service to see everything publishing does." : "The Owner reviews each one exactly as shown."}</p>
              </div>
            </div>
          </>
        )}
      </section>

      {work.length ? (
        <section aria-labelledby="work" className="grid gap-2">
          <h2 id="work" className="text-base font-semibold text-strong">
            Needs something first <span className="font-normal text-muted-foreground">· {work.length}</span>
          </h2>
          <ul className="grid gap-2">
            {work.map((row) => (
              <li key={row.id}>
                <Link href={`${servicePath(row.id)}?finish=1`} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-3 hover:border-brand-500/40 focus-visible:outline-2 focus-visible:outline-brand-500/50">
                  <span className="min-w-0">
                    <span className="block font-medium text-strong">{row.draft?.name || row.name}</span>
                    <span className="flex items-start gap-1.5 text-sm text-muted-foreground">
                      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                      {row.draft?.firstBlocker}
                      {row.draft && row.draft.blockers > 1 ? ` · ${row.draft.blockers - 1} more` : ""}
                    </span>
                  </span>
                  <span className="text-sm font-medium text-brand-300">Finish</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {waiting.length ? (
        <section aria-labelledby="waiting" className="grid gap-2">
          <h2 id="waiting" className="text-base font-semibold text-strong">
            Already submitted <span className="font-normal text-muted-foreground">· {waiting.length}</span>
          </h2>
          <ul className="grid gap-2">
            {waiting.map((row) => (
              <li key={row.id}>
                <Link href={changePath(row.openChange!.id)} className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-3 hover:border-brand-500/40 focus-visible:outline-2 focus-visible:outline-brand-500/50">
                  <span className="font-medium text-strong">{row.name}</span>
                  <ChangeBadge state={row.openChange!.state} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

type Row = NonNullable<ReturnType<typeof useQuery<typeof api.services.catalog>>>["services"][number];

function ReadyRow({ row, on, onToggle }: { row: Row; on: boolean; onToggle: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const id = `pick-${row.id}`;
  return (
    <li className={cn("rounded-xl border bg-card", on ? "border-brand-500/40" : "border-border")}>
      <div className="flex items-start gap-3 px-4 py-3">
        <input id={id} type="checkbox" checked={on} onChange={(event) => onToggle(event.target.checked)} className="mt-1 size-4 accent-brand-500" />
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-strong">{row.draft?.name || row.name}</span>
            <Badge variant={row.live ? "success" : "warning"} size="sm">
              {row.live ? `Updates live v${row.live.version}` : "New"}
            </Badge>
          </span>
          <span className="block text-sm tabular-nums text-strong">{row.draft?.summary}</span>
          <span className="block text-xs text-muted-foreground">{bookingWords(row)}</span>
        </label>
        <Button size="xs" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          Details <ChevronDown aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
        </Button>
      </div>
      {open ? <RowDetails serviceId={row.id} /> : null}
    </li>
  );
}

/** The same review the service's own panel shows, read from the saved draft. */
function RowDetails({ serviceId }: { serviceId: Id<"services"> }) {
  const { companyId } = useCompany();
  const preview = useQuery(api.services.reviewPreview, { companyId, serviceId });
  if (!preview?.draft) return <Skeleton className="mx-4 mb-3 h-20 rounded-lg" />;
  return (
    <div className="grid gap-3 border-t border-border px-4 py-3 text-sm sm:grid-cols-2">
      <div>
        <p className="font-medium text-strong">What changes</p>
        <ul className="mt-1 grid gap-0.5 text-muted-foreground">
          {preview.draft.changes.slice(0, 8).map((c) => (
            <li key={c}>• {c}</li>
          ))}
        </ul>
      </div>
      <div>
        <p className="font-medium text-strong">What publishing does</p>
        <ul className="mt-1 grid gap-0.5 text-muted-foreground">
          {preview.draft.impact.map((line) => (
            <li key={line}>• {line}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
