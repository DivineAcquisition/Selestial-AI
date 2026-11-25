"use client";

import { useQuery } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { useDetail } from "@/components/app/detail-panel";
import { DecisionCard, NoDecisions } from "@/components/app/overview/decision-card";
import { useApprove } from "@/components/app/screens/overview";
import { PageHeader } from "@/components/app/shell";
import { useNow } from "@/components/app/use-now";
import { Skeleton } from "@/components/ui/skeleton";
import { until } from "@/lib/app/format";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Decision } from "../../../../convex/overview";

type Urgency = "all" | "late" | "soon";

const URGENCY: { id: Urgency; label: string }[] = [
  { id: "all", label: "Any deadline" },
  { id: "late", label: "Overdue" },
  { id: "soon", label: "Due within 4 hours" },
];

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-brand-500/50",
        on ? "border-brand-500 bg-brand-500/[0.08] text-strong" : "border-border text-muted-foreground hover:border-brand-500/40 hover:text-strong",
      )}
    >
      {children}
    </button>
  );
}

/** Approvals: the one queue of decisions from every department, soonest deadline first. Notices do not appear here. */
export function DecisionsScreen({ department }: { department?: string }) {
  const { companyId, timezone } = useCompany();
  const now = useNow();
  const open = useDetail();
  const all = useQuery(api.overview.decisions, now ? { companyId, asOf: now } : "skip");
  const { approve, skip, approving, error } = useApprove();
  const [pickedDepartment, setPickedDepartment] = useState<string | null>(null);
  const [urgency, setUrgency] = useState<Urgency>("all");
  const shownDepartment = department ?? pickedDepartment;
  const matches = (decision: Decision) => {
    if (shownDepartment && decision.department !== shownDepartment) return false;
    if (urgency === "all" || !now) return true;
    const due = until(decision.deadline, now);
    return urgency === "late" ? due.late : due.soon;
  };
  const decisions = all?.filter(matches);
  const departments = all ? [...new Set(all.map((decision) => decision.department))].sort() : [];
  const filtering = pickedDepartment !== null || urgency !== "all";

  const list =
    decisions === undefined ? (
      <Skeleton className="h-48 rounded-2xl" />
    ) : decisions.length === 0 ? (
      filtering ? (
        <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-8 text-center">
          <p className="text-sm font-medium text-strong">Nothing matches these filters.</p>
          <button type="button" className="mt-1 text-xs font-medium text-brand-300 underline-offset-4 hover:underline" onClick={() => {
              setPickedDepartment(null);
              setUrgency("all");
            }}
          >
            Show every decision
          </button>
        </div>
      ) : (
        <NoDecisions />
      )
    ) : (
      <div className="grid gap-3 xl:grid-cols-2">
        {decisions.map((decision) => (
          <DecisionCard
            key={decision.ref.id}
            decision={decision}
            now={now}
            timezone={timezone}
            busy={approving === decision.ref.id}
            error={error?.id === decision.ref.id ? error.message : null}
            onApprove={(item) => void approve(item)}
            onSkip={skip}
            onOpen={open}
          />
        ))}
      </div>
    );
  if (department) return list;
  return (
    <>
      <PageHeader title="Approvals" lead="Decisions from every department, soonest first. Each says what the problem is, what the agent proposes, exactly what approving authorizes, and what happens if you wait." />
      {all && all.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2" aria-label="Filter approvals">
          {departments.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              <Chip on={pickedDepartment === null} onClick={() => setPickedDepartment(null)}>
                Every department
              </Chip>
              {departments.map((name) => (
                <Chip key={name} on={pickedDepartment === name} onClick={() => setPickedDepartment(pickedDepartment === name ? null : name)}>
                  {name} <span className="tabular-nums text-muted-foreground">{all.filter((decision) => decision.department === name).length}</span>
                </Chip>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {URGENCY.map((option) => (
              <Chip key={option.id} on={urgency === option.id} onClick={() => setUrgency(option.id)}>
                {option.label}
              </Chip>
            ))}
          </div>
        </div>
      ) : null}
      {list}
    </>
  );
}
