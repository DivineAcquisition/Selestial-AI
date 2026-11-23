"use client";

import { useQuery } from "convex/react";

import { UserMenu } from "@/components/auth/user-menu";
import { Logo } from "@/components/brand/logo";
import { CheckCircle2, Clock, ShieldCheck } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

const day = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const dueDay = (dueOn: string) => new Date(`${dueOn}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

type Step = { label: string; detail: string; state: "done" | "current" | "upcoming" };

/**
 * Where the company's deletion request stands, for its Owner, in plain words: received (and the date it
 * will be done by), in progress, completed, and exactly what is kept and why.
 */
export function DeletionStatus({ companyId }: { companyId: Id<"companies"> }) {
  const status = useQuery(api.companyDeletion.status, { companyId });
  if (status === undefined) return <Skeleton className="h-40 rounded-xl" />;
  if (status === null) return null;
  const steps: Step[] = [
    { label: "Request received", detail: `${day(status.receivedAt)} · reference ${status.reference}`, state: "done" },
    {
      label: status.state === "received" ? "Being checked by Selestial" : "Deleting",
      detail:
        status.state === "received"
          ? `Selestial checks open payments, your plan and your texting number, then deletes the records${status.dueOn ? ` by ${dueDay(status.dueOn)}` : " within 90 days"}.`
          : status.state === "in_progress"
            ? `Started ${status.startedAt ? day(status.startedAt) : "now"}. Nobody can use the workspace or its links while this runs.${status.progress ? ` ${Math.round((status.progress.done / status.progress.total) * 100)}% done.` : ""}`
            : `Started ${status.startedAt ? day(status.startedAt) : ""}.`,
      state: status.state === "received" ? "current" : status.state === "in_progress" ? "current" : "done",
    },
    {
      label: status.state === "completed" ? `Completed ${status.completedAt ? day(status.completedAt) : ""}` : `To be completed by ${status.dueOn ? dueDay(status.dueOn) : "90 days after the request"}`,
      detail: status.state === "completed" ? "The company's records are deleted, except what is listed below." : "You'll be able to see this page until the deletion starts.",
      state: status.state === "completed" ? "done" : "upcoming",
    },
  ];
  return (
    <div className="grid gap-4" role="status" aria-live="polite">
      <ol className="grid gap-3" aria-label="Deletion status">
        {steps.map((step) => {
          const Icon = step.state === "done" ? CheckCircle2 : Clock;
          return (
            <li key={step.label} className="flex gap-3">
              <span
                aria-hidden
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border",
                  step.state === "done" && "border-success/40 bg-success/10 text-success-foreground",
                  step.state === "current" && "border-brand-500/40 bg-brand-500/15 text-brand-600",
                  step.state === "upcoming" && "border-dashed border-border text-muted-foreground",
                )}
              >
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0">
                <span className={cn("block text-sm font-medium", step.state === "upcoming" ? "text-muted-foreground" : "text-strong")}>{step.label}</span>
                <span className="block text-xs leading-relaxed text-muted-foreground">{step.detail}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="rounded-xl border border-border p-3">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-strong">
          <ShieldCheck className="size-4" aria-hidden />
          What is kept, and why
        </p>
        <ul className="mt-2 grid gap-2 text-sm">
          {status.kept.map((row) => (
            <li key={row.what}>
              <span className="font-medium text-strong">{row.what}.</span> <span className="text-muted-foreground">{row.why}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">Everything else is deleted: customers&rsquo; and cleaners&rsquo; details, messages&rsquo; words, photos and files, notes, schedules and settings. Sign-in accounts are not deleted, because a person may belong to other businesses.</p>
      </div>
    </div>
  );
}

/** Instead of the workspace, while Selestial deletes the company at its Owner's request. */
export function ClosingGate({ companyId, name, owner }: { companyId: Id<"companies">; name: string; owner: boolean }) {
  return (
    <div className="min-h-dvh bg-muted/50">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3 sm:px-6">
        <Logo />
        <UserMenu />
      </header>
      <main className="mx-auto grid max-w-xl gap-5 px-4 py-10 sm:px-6">
        <div>
          <h1 className="font-heading text-2xl tracking-tight text-strong">{name} is being deleted</h1>
          <p className="mt-1 text-sm text-muted-foreground">At the Owner&rsquo;s request. The workspace, its links and its agents are closed while Selestial deletes the records.</p>
        </div>
        <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">{owner ? <DeletionStatus companyId={companyId} /> : <p className="text-sm text-muted-foreground">Ask the Owner if you have questions about it.</p>}</section>
      </main>
    </div>
  );
}
