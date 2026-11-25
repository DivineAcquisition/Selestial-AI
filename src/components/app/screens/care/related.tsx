"use client";

/**
 * A record's Care requests, where people already look: the client profile, an Inbox conversation and a
 * visit's panel. Each opens the request in Care. Read from the same requests as the workspace.
 */
import { useQuery } from "convex/react";
import Link from "next/link";

import { AgentAvatar } from "@/components/app/agent";
import { useCompany } from "@/components/app/company";
import { useNow } from "@/components/app/use-now";
import { whenLabel } from "@/lib/app/format";
import { cn } from "@/lib/utils";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { CARE_PATH, StatusPill, UrgencyFlag } from "./shared";

type Target = { customerId: Id<"customers"> } | { jobId: Id<"jobs"> } | { conversationId: Id<"smsConversations"> };

export function CareOnRecord({ target, quietWhenEmpty = false, className }: { target: Target; quietWhenEmpty?: boolean; className?: string }) {
  const { companyId, timezone } = useCompany();
  const now = useNow();
  const data = useQuery(api.clientCare.forRecord, { companyId, ...target });
  if (data === undefined) return null;
  if (data.rows.length === 0 && quietWhenEmpty) return null;
  return (
    <section aria-label="Care" className={cn("grid content-start gap-2.5 rounded-2xl border border-border bg-card p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-strong">
          <AgentAvatar agent="customer-care" size="xs" />
          Care
        </h3>
        <span className="text-xs text-muted-foreground">{data.open ? `${data.open} open` : "Nothing open"}{data.paused ? " · paused" : ""}</span>
      </div>
      {data.rows.length ? (
        <ul className="grid gap-2">
          {data.rows.map((row) => (
            <li key={row.id}>
              <Link href={`${CARE_PATH}/requests?request=${row.id}`} className={cn("grid gap-1 rounded-xl border px-3 py-2.5 text-sm hover:border-brand-500/50 focus-visible:outline-2 focus-visible:outline-brand-500", row.open ? "border-border bg-background" : "border-border/60 bg-background/60")}>
                <span className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="font-medium text-strong">{row.categoryWords}</span>
                  <span className="flex items-center gap-1.5">
                    <UrgencyFlag urgency={row.urgency} />
                    <StatusPill status={row.status} words={row.held ? "With a person" : row.statusWords} />
                  </span>
                </span>
                {row.visit ? <span className="text-xs text-muted-foreground">Visit {row.visit}</span> : null}
                <span className="text-xs text-foreground [overflow-wrap:anywhere]">{row.line}</span>
                <span className="text-[11px] text-muted-foreground">Updated {now ? whenLabel(row.updatedAt, now, timezone) : ""}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No client requests yet. When this client texts or emails the company, Care&rsquo;s requests appear here.</p>
      )}
    </section>
  );
}
