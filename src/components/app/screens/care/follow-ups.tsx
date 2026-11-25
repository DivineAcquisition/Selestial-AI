"use client";

/**
 * What Care is waiting on, and what it will do about it: who or what each request waits for, the time
 * promised to the client, the next thing Care will do, and whether that will happen on its own, waits for an
 * approval, or needs a person. Follow-ups come from pending work only; nothing is sent to look busy.
 */
import { useCompany } from "@/components/app/company";
import { PageHeader } from "@/components/app/shell";
import { useNow } from "@/components/app/use-now";
import { Skeleton } from "@/components/ui/skeleton";
import { whenLabel } from "@/lib/app/format";
import { useStableQuery } from "@/lib/app/stable-query";
import { cn } from "@/lib/utils";

import { api } from "../../../../../convex/_generated/api";
import { Empty } from "../quality/shared";
import { RequestWorkspace } from "./request-workspace";
import { ModeTag, StatusPill, useRequestParam } from "./shared";

export function CareFollowUpsScreen() {
  const { companyId, timezone } = useCompany();
  const now = useNow();
  const { openId, open, close } = useRequestParam();
  const rows = useStableQuery(api.clientCare.followUps, now ? { companyId, asOf: now } : "skip");
  return (
    <>
      <PageHeader title="Follow-ups" lead="Who each open request is waiting on, what was promised to the client, and what Care does next. A reply, a resolution, a takeover or a pause stops the follow-up." />
      {rows === undefined ? (
        <div className="grid gap-3" aria-busy="true" aria-label="Loading follow-ups">
          <Skeleton className="h-20 rounded-2xl" />
          <Skeleton className="h-20 rounded-2xl" />
        </div>
      ) : rows.length ? (
        <ul className="grid gap-3" aria-label="Follow-ups">
          {rows.map((row) => (
            <li key={row.id}>
              <button type="button" onClick={() => open(row.id)} className={cn("grid w-full gap-3 rounded-2xl border bg-card p-4 text-left hover:border-brand-500/50 focus-visible:outline-2 focus-visible:outline-brand-500 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center", row.overdue ? "border-warning/40" : "border-border")}>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-strong">{row.customer.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {row.categoryWords}
                    {row.visit ? ` · visit ${row.visit}` : ""}
                  </span>
                </span>
                <span className="min-w-0 text-sm">
                  <span className="block text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Waiting for</span>
                  <span className="block font-medium text-strong">{row.waitingFor}</span>
                  {row.reason ? <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{row.reason}</span> : null}
                </span>
                <span className="min-w-0 text-sm">
                  <span className="block text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Next</span>
                  <span className="block text-strong">{row.planned}</span>
                  <span className={cn("block text-xs", row.overdue ? "font-semibold text-warning-foreground" : "text-muted-foreground")}>
                    {row.promisedBy && now ? `Promised ${whenLabel(row.promisedBy, now, timezone)}` : row.nextCheckAt && now ? `Checks ${whenLabel(row.nextCheckAt, now, timezone)}` : "When something changes"}
                    {row.overdue ? " · late" : ""}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-1.5 md:justify-end">
                  <StatusPill status={row.status} words={row.statusWords} />
                  <ModeTag mode={row.mode} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="Nothing is waiting" body="When Care asks a client something, hands work to the team, or promises an update, it appears here with what happens next." />
      )}
      <RequestWorkspace id={openId} onClose={close} />
    </>
  );
}
