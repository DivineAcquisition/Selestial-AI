"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { canManage, useCompany } from "@/components/app/company";
import { FormError, TextArea, useRun } from "@/components/app/form";
import { useNow } from "@/components/app/use-now";
import { CheckCircle2, ChevronDown, Clock, Info, LoaderCircle, Mail, Plug, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

/**
 * Problems that affect this company, where they affect its work (docs/operations/01-recovery.md §Owners).
 * Each card says what is affected, what Selestial already did, and one next action that does the real
 * thing or opens the exact page where it is done. Provider codes and ids never appear here.
 *
 * Calm by design: warning colour only on the edge of what needs the owner, recovery shown from the
 * record's own updates, nothing animated to look busy.
 */

type Area = "all" | "agent_work" | "communications" | "connections" | "billing";
type Issue = NonNullable<ReturnType<typeof useQuery<typeof api.operations.forCompany>>>["issues"][number];

function ago(at: number, now: number) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

export function IssueCards({ area = "all", kinds, title = "Needs attention", quietWhenClear = true }: { area?: Area; kinds?: string[]; title?: string; quietWhenClear?: boolean }) {
  const { companyId } = useCompany();
  const data = useQuery(api.operations.forCompany, { companyId, area, ...(kinds ? { kinds } : {}) });
  const now = useNow();
  if (data === undefined) return null;
  const { issues, recovered } = data;
  if (!issues.length && !recovered.length && !data.outboundStopped && !(data.stale && !quietWhenClear)) return null;
  return (
    <section id="issues" aria-labelledby="issues-title" className="scroll-mt-20">
      {issues.length ? (
        <h2 id="issues-title" className="mb-2 font-heading text-lg tracking-tight text-strong">
          {title}
        </h2>
      ) : (
        <h2 id="issues-title" className="sr-only">
          {title}
        </h2>
      )}
      {data.outboundStopped ? (
        <p className="mb-2 flex items-start gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm text-strong">
          <Info className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
          Selestial paused outgoing texts and emails for your company while it looks into a problem. Incoming messages, opt-outs and your records keep working. Nothing waiting is sent automatically when it resumes.
        </p>
      ) : null}
      <div className="grid gap-2.5">
        {issues.map((issue) => (
          <IssueCard key={issue.id} issue={issue} now={now} />
        ))}
      </div>
      {recovered.length ? (
        <ul className={cn("grid gap-1", issues.length && "mt-2.5")}>
          {recovered.slice(0, 3).map((row) => (
            <li key={row.id} className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm text-muted-foreground">
              <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-strong">Working again:</span> {row.title}
              </span>
              <span className="text-xs">{now ? ago(row.resolvedAt, now) : ""}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {data.stale && issues.length ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3.5" aria-hidden />
          Selestial&apos;s status checks are running late, so this may be a few minutes behind{data.checkedAt && now ? ` (last checked ${ago(data.checkedAt, now)})` : ""}.
        </p>
      ) : null}
    </section>
  );
}

const ICON: Record<string, typeof Plug> = { connections: Plug, communications: Mail, billing: Info, agent_work: RefreshCw, platform: Info };

function IssueCard({ issue, now }: { issue: Issue; now: number }) {
  const { role } = useCompany();
  const [open, setOpen] = useState(false);
  const [helping, setHelping] = useState(false);
  const needsYou = issue.state === "waiting_owner";
  const recovering = issue.state === "recovering";
  const Icon = ICON[issue.category] ?? Info;
  const manager = canManage(role);
  return (
    <article className={cn("rounded-2xl border bg-card", needsYou ? "border-warning/50" : "border-border")} aria-labelledby={`issue-${issue.id}`}>
      <div className="flex gap-3 p-4 sm:p-5">
        <span className={cn("mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg", needsYou ? "bg-warning/15 text-warning-foreground" : "bg-brand-500/10 text-brand-700")} aria-hidden>
          {recovering ? <LoaderCircle className="size-4" /> : <Icon className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={`issue-${issue.id}`} className="font-semibold text-strong">
            {issue.title}
          </h3>
          <p className="mt-0.5 text-sm text-strong/90">{issue.impact}</p>
          <p className="mt-1.5 text-sm text-muted-foreground">{issue.done}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {manager ? <PrimaryAction issue={issue} onReview={() => setOpen(true)} onHelp={() => setHelping(true)} /> : <span className="text-xs text-muted-foreground">An Owner or Manager can act on this.</span>}
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-strong focus-visible:outline-2 focus-visible:outline-brand-500">
              Details
              <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
            </button>
            <span className="ml-auto text-xs text-muted-foreground">{issue.stateWords}</span>
          </div>
        </div>
      </div>
      {open ? (
        <div className="border-t border-border px-4 py-3 sm:px-5">
          {issue.kind === "comms.unconfirmed" && manager ? <UncertainMessages incidentId={issue.id} now={now} /> : null}
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Recent updates</h4>
          <ol className="mt-1.5 grid gap-1.5">
            {issue.updates.map((update, index) => (
              <li key={index} className="grid grid-cols-[6.5rem_1fr] gap-2 text-sm">
                <span className="text-xs text-muted-foreground">{now ? ago(update.at, now) : ""}</span>
                <span className="text-strong">{update.words}</span>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">
            Reference {issue.reference} · first noticed {now ? ago(issue.firstSeenAt, now) : ""}
            {issue.recoveryAttempts ? ` · ${issue.recoveryAttempts} automatic ${issue.recoveryAttempts === 1 ? "attempt" : "attempts"}` : ""}
          </p>
          {manager && !helping && issue.action?.kind !== "contact_support" ? (
            <button type="button" onClick={() => setHelping(true)} className="mt-2 text-sm font-medium text-brand-700 hover:underline">
              Contact support about this
            </button>
          ) : null}
        </div>
      ) : null}
      {helping ? <SupportRequest issue={issue} onDone={() => setHelping(false)} /> : null}
    </article>
  );
}

function PrimaryAction({ issue, onReview, onHelp }: { issue: Issue; onReview: () => void; onHelp: () => void }) {
  const action = issue.action;
  if (issue.supportRequestedAt && (!action || action.kind === "contact_support")) return <span className="text-sm text-muted-foreground">Selestial Support has the details and is on it.</span>;
  if (!action) return null;
  if (action.kind === "contact_support") {
    return (
      <Button size="sm" variant="outline" onClick={onHelp}>
        Contact support
      </Button>
    );
  }
  if (action.href) {
    return (
      <Button size="sm" variant={issue.state === "waiting_owner" ? "primary" : "outline"} render={<Link href={action.href} />}>
        {action.label}
      </Button>
    );
  }
  return (
    <Button size="sm" variant="outline" onClick={onReview}>
      {action.label}
    </Button>
  );
}

/** For "we're checking whether this message was sent": each message, and the two honest choices. */
function UncertainMessages({ incidentId, now }: { incidentId: Id<"incidents">; now: number }) {
  const { companyId } = useCompany();
  const rows = useQuery(api.operations.uncertainMessages, { companyId, incidentId });
  const check = useMutation(api.operations.checkMessage);
  const leave = useMutation(api.operations.leaveMessage);
  const { busy, error, run } = useRun();
  if (!rows?.length) return null;
  return (
    <div className="mb-3">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Messages</h4>
      <ul className="mt-1.5 grid gap-2">
        {rows
          .filter((row) => !row.reviewed && row.status === "unconfirmed")
          .map((row) => (
            <li key={row.id} className="rounded-xl border border-border px-3 py-2 text-sm">
              <p className="text-strong">
                {row.what} by {row.channel === "email" ? "email" : "text"} to {row.to}
                <span className="text-muted-foreground"> · tried {now ? ago(row.attemptedAt, now) : ""}</span>
              </p>
              {row.checking ? (
                <p className="mt-1 text-xs text-muted-foreground">Checking with the texting provider now.</p>
              ) : row.canCheck ? (
                <p className="mt-1 text-xs text-muted-foreground">Selestial can ask the texting provider whether it went. If it did, nothing is sent again. If it never arrived there, it is sent now, after consent and your settings are checked again.</p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">It&apos;s too late to check this one with the provider. If it matters, contact them another way.</p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {row.canCheck ? (
                  <Button size="xs" variant="outline" loading={busy} onClick={() => void run(() => check({ companyId, messageId: row.id }))}>
                    Check and send only if it never went
                  </Button>
                ) : null}
                <Button size="xs" variant="ghost" loading={busy} onClick={() => void run(() => leave({ companyId, messageId: row.id }))}>
                  Leave it
                </Button>
                {row.open ? (
                  <Button size="xs" variant="ghost" render={<Link href={`/app${row.open}`} />}>
                    View the visit
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
      </ul>
      <FormError message={error} />
    </div>
  );
}

/** The support handoff: Selestial already has the details, so the owner only adds anything they want to. */
function SupportRequest({ issue, onDone }: { issue: Issue; onDone: () => void }) {
  const { companyId } = useCompany();
  const request = useMutation(api.operations.requestSupport);
  const { busy, error, run } = useRun();
  const [note, setNote] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  if (sent) {
    return (
      <div className="border-t border-border px-4 py-3 text-sm sm:px-5">
        <p className="text-strong">Selestial Support has it. Reference {sent}.</p>
        <p className="text-muted-foreground">They can see what happened, when, and what was already tried. You don&apos;t need to explain it again.</p>
        <button type="button" onClick={onDone} className="mt-1 text-sm font-medium text-brand-700 hover:underline">
          Close
        </button>
      </div>
    );
  }
  return (
    <form
      className="grid gap-2 border-t border-border px-4 py-3 sm:px-5"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => setSent(await request({ companyId, incidentId: issue.id, ...(note.trim() ? { note } : {}) })));
      }}
    >
      <p className="text-sm text-strong">Selestial Support will get reference {issue.reference}, what&apos;s affected, when it started and what was already tried.</p>
      <TextArea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder="Anything to add (optional)" maxLength={500} aria-label="Anything to add" />
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" loading={busy}>
          Send to support
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
