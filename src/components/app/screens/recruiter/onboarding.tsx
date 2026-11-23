"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { PageHeader, Panel } from "@/components/app/shell";
import { useNow } from "@/components/app/use-now";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/selection";
import { Skeleton } from "@/components/ui/skeleton";
import { until } from "@/lib/app/format";
import { cn } from "@/lib/utils";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { ProgressRing } from "./shared";

type Row = NonNullable<ReturnType<typeof useQuery<typeof api.onboarding.queue>>>[number];
type Item = NonNullable<Row["readiness"]>["items"][number];

/** Each state in the words the Owner sees. Received is never shown as approved. */
const STATE: Record<Item["state"], { label: string; variant: "success" | "info" | "warning" | "error" | "outline" }> = {
  missing: { label: "Missing", variant: "outline" },
  received: { label: "Received", variant: "info" },
  awaiting_review: { label: "Awaiting review", variant: "info" },
  needs_changes: { label: "Needs changes", variant: "warning" },
  approved: { label: "Approved", variant: "success" },
  waived: { label: "Waived", variant: "success" },
  expired: { label: "Expired", variant: "error" },
};

const LEAD = "From an accepted offer to a cleaner ready to be considered for work. Dispatch still checks every visit on its own.";

/** Recruiter › Onboarding & Readiness: each new worker's checklist, who confirmed what, and the readiness approval. */
/** `embedded`: shown inside another tab (Applicants, Hiring setup), without its own page heading. */
export function OnboardingScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const { companyId } = useCompany();
  const open = useQuery(api.onboarding.queue, { companyId, status: "open" });
  const complete = useQuery(api.onboarding.queue, { companyId, status: "complete" });
  if (!open || !complete) {
    return (
      <>
        {embedded ? null : <PageHeader title="Onboarding & Readiness" lead={LEAD} />}
        <Skeleton className="h-96 rounded-2xl" />
      </>
    );
  }
  return (
    <>
      {embedded ? null : <PageHeader title="Onboarding & Readiness" lead={LEAD} />}
      <div className="grid gap-5">
        <p className="rounded-xl bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground">
          <span className="font-medium text-strong">Recruiter</span> handles applications, hiring, onboarding and readiness. Once you approve readiness,{" "}
          <span className="font-medium text-strong">Dispatch</span> decides whether they can take each visit. Their profile, availability and documents stay in{" "}
          <Link href="/app/cleaners" className="font-medium text-strong underline-offset-2 hover:underline">
            Cleaners
          </Link>
          .
        </p>
        <Panel title={`Onboarding · ${open.length}`}>
          {open.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody is onboarding. When an applicant accepts an offer, their checklist appears here.</p>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {open.map((row) => (
                <Onboarding key={row.handoffId} row={row} />
              ))}
            </div>
          )}
        </Panel>
        {complete.length > 0 ? (
          <Panel title={`Approved · ${complete.length}`}>
            <ul className="grid gap-2">
              {complete.map((row) => (
                <li key={row.handoffId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <Link href={`/app/cleaners/${row.cleanerId}`} className="font-medium text-strong hover:underline">
                    {row.applicant ?? "New worker"}
                  </Link>
                  <span className="text-xs text-muted-foreground">{row.role}</span>
                  <Badge variant={row.dispatchReady ? "success" : "warning"} size="sm">
                    {row.dispatchReady ? "Dispatch can consider them" : row.workerStatus === "ready" ? "Active, but a requirement for work is not met" : "Not active"}
                  </Badge>
                  <Link href="/app/agents/dispatch" className="ml-auto text-xs font-medium text-muted-foreground hover:text-strong">
                    View assignments in Dispatch
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>
    </>
  );
}

function Onboarding({ row }: { row: Row }) {
  const { companyId, role } = useCompany();
  const now = useNow();
  const record = useMutation(api.onboarding.record);
  const approve = useMutation(api.onboarding.approve);
  const { busy, error, run } = useRun();
  const [acknowledged, setAcknowledged] = useState(false);
  const [approved, setApproved] = useState<string | null>(null);
  const readiness = row.readiness;
  const items = readiness?.items ?? [];
  const met = items.filter((item) => item.state === "approved" || item.state === "waived").length;
  const handoffId = row.handoffId as Id<"onboardingHandoffs">;
  const restricted = readiness?.decisions.some((line) => line.startsWith("This person has a rehire")) ?? false;
  return (
    <section className="rounded-2xl border border-border bg-background p-4">
      <div className="flex items-start gap-3">
        <ProgressRing done={met} total={items.length} />
        <div className="min-w-0 flex-1">
          <Link href={`/app/cleaners/${row.cleanerId}`} className="font-medium text-strong hover:underline">
            {row.applicant ?? "New worker"}
          </Link>
          <p className="text-xs text-muted-foreground">
            {row.role} · {"payWords" in row.approvedTerms ? row.approvedTerms.payWords : "pay shown to the Owner"} · {row.responsible ? `with ${row.responsible}` : "no one responsible yet"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Next: {row.nextAction} · {until(row.dueAt, now).text}
          </p>
        </div>
        <Badge variant={readiness?.canApprove ? "info" : "outline"} size="sm">
          {readiness?.canApprove ? "Ready for your approval" : "Not ready yet"}
        </Badge>
      </div>

      <ul className="mt-3 grid gap-1.5" aria-label="Onboarding checklist">
        {items.map((item) => {
          const fromHandoff = row.requirements.find((req) => req.key === item.key);
          return (
            <li key={item.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
              {fromHandoff && !item.fromRecord ? (
                <Checkbox
                  aria-label={`${item.label}: recorded as done`}
                  checked={fromHandoff.status === "done"}
                  disabled={busy || role === "office"}
                  onCheckedChange={(checked) => void run(() => record({ companyId, handoffId, requirement: item.key, done: checked }))}
                />
              ) : (
                <span className="size-4" aria-hidden />
              )}
              <span className={cn("min-w-0 flex-1", item.blocksWork ? "text-strong" : "text-muted-foreground")}>
                {item.label}
                {!item.blocksWork ? <span className="text-xs text-muted-foreground"> · not needed before work</span> : null}
              </span>
              <Badge variant={STATE[item.state].variant} size="sm">
                {item.fromRecord && item.state === "approved" ? "On their record" : STATE[item.state].label}
              </Badge>
              {item.confirmedBy ? <span className="w-full pl-6 text-xs text-muted-foreground">Confirmed by {item.confirmedBy}</span> : null}
              {item.fromRecord && item.state === "missing" ? (
                <Link href={`/app/cleaners/${row.cleanerId}`} className="w-full pl-6 text-xs font-medium text-muted-foreground hover:text-strong">
                  Add it on their record in Cleaners
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">A person records each item. Receiving a document is not the same as checking it.</p>

      {readiness && readiness.decisions.length > 0 ? (
        <ul className="mt-3 grid gap-1 rounded-xl bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          {readiness.decisions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 grid gap-2 border-t border-border pt-3">
        {approved ? (
          <p className="text-sm text-success-foreground">{approved}</p>
        ) : readiness?.canApprove ? (
          <>
            <p className="text-sm text-strong">Every item needed before work is approved. Approving makes their engagement active, so Dispatch can consider them for visits that match their availability, skills and service area.</p>
            {restricted ? (
              <label className="flex items-center gap-2 text-xs text-strong">
                <Checkbox checked={acknowledged} onCheckedChange={(checked) => setAcknowledged(checked)} />I have decided to go ahead despite the rehire restriction.
              </label>
            ) : null}
            {role === "owner" ? (
              <Button
                size="sm"
                variant="primary"
                className="justify-self-start"
                loading={busy}
                disabled={restricted && !acknowledged}
                onClick={() =>
                  void run(async () => {
                    const result = await approve({ companyId, handoffId, acknowledgeRestriction: restricted ? acknowledged : undefined });
                    setApproved(result.detail);
                  })
                }
              >
                Approve readiness
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">Only an Owner approves readiness.</p>
            )}
          </>
        ) : readiness && readiness.stillNeeded.length > 0 ? (
          <p className="text-xs text-muted-foreground">Still needed before work: {readiness.stillNeeded.join(", ")}.</p>
        ) : null}
        <FormError message={error} />
      </div>
    </section>
  );
}
