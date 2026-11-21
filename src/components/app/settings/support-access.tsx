"use client";

import { useQuery } from "convex/react";

import { useCompany } from "@/components/app/company";
import { ShieldCheck } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

import { api } from "../../../../convex/_generated/api";

function when(at: number, timezone: string) {
  return new Date(at).toLocaleString("en-US", { timeZone: timezone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Settings › Support access (docs/operations/03-support-sessions.md). Selestial Support may open this
 * workspace when there is a reason, time-bound and recorded. Every session is listed here with that
 * reason, whether it could change anything, and each change it made. Switching to Manage emails you,
 * and so does the end of a session that changed something.
 */
export function SupportAccess() {
  const { companyId, timezone } = useCompany();
  const rows = useQuery(api.support.history, { companyId });
  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand-600" aria-hidden />
        <div className="text-sm">
          <p className="font-semibold text-strong">How Selestial Support gets in</p>
          <p className="mt-1 text-muted-foreground">
            When something goes wrong, an authorized Selestial admin can open your workspace to look into it, for a short time and with a recorded reason. They sign in as themselves, never as you. Sessions start read-only. To change anything they must switch to Manage, which emails you, and even then they can&apos;t approve on your behalf, message your customers, publish prices, buy numbers or move money. Everything they change is listed here and shows in your activity as “Selestial Support”.
          </p>
        </div>
      </div>
      {rows === undefined ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : rows.length === 0 ? (
        <p className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">Selestial Support has not opened your workspace.</p>
      ) : (
        <ol className="grid gap-3">
          {rows.map((row) => (
            <li key={row.id} className="rounded-2xl border border-border bg-card p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-strong">{when(row.startedAt, timezone)}</p>
                <Badge variant={row.everManaged ? "warning" : "outline"}>{row.everManaged ? "Could make changes (Manage)" : "View only"}</Badge>
                {row.live ? <Badge variant="info">In progress</Badge> : row.endedAt ? <span className="text-xs text-muted-foreground">ended {when(row.endedAt, timezone)}</span> : null}
              </div>
              <p className="mt-1.5 text-sm text-strong">
                <span className="text-muted-foreground">Why: </span>
                {row.reason}
              </p>
              {row.manageReason ? (
                <p className="mt-0.5 text-sm text-strong">
                  <span className="text-muted-foreground">Why changes were needed: </span>
                  {row.manageReason}
                </p>
              ) : null}
              {row.changes.length ? (
                <ul className="mt-2 grid gap-1 border-t border-border pt-2 text-sm">
                  {row.changes.map((change, index) => (
                    <li key={index} className="flex flex-wrap gap-x-2">
                      <span className="text-xs text-muted-foreground">{when(change.at, timezone)}</span>
                      <span className="text-strong">{change.summary}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">No changes made.{row.viewed ? ` Pages opened: ${row.viewed}.` : ""}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
