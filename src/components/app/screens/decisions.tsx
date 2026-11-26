"use client";

import { useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";

import { BulkBar } from "@/components/app/approvals/bulk-bar";
import { StandingRules } from "@/components/app/approvals/standing-rules";
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
  const full = !department;

  // Selection and the keyboard are the full page's: the queue embedded in a department stays simple.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [skipRequest, setSkipRequest] = useState<{ id: string; n: number } | null>(null);
  const shownIds = (decisions ?? []).map((decision) => decision.ref.id as string);
  const selected = (decisions ?? []).filter((decision) => decision.ref.kind === "approval" && selectedIds.has(decision.ref.id));
  const focused = focusedId && shownIds.includes(focusedId) ? focusedId : null;
  const toggle = (id: string, on: boolean) =>
    setSelectedIds((before) => {
      const next = new Set(before);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  const onKey = (event: KeyboardEvent) => {
    if (!full || !decisions || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, form, [contenteditable=true], [role=dialog]")) return;
    const index = focused ? shownIds.indexOf(focused) : -1;
    const at = index >= 0 ? decisions[index] : null;
    const move = (to: number) => {
      const id = shownIds[Math.max(0, Math.min(shownIds.length - 1, to))];
      if (!id) return;
      setFocusedId(id);
      document.querySelector(`[data-decision="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    if (event.key === "j") move(index + 1);
    else if (event.key === "k") move(index < 0 ? 0 : index - 1);
    else if (event.key === "x" && at?.ref.kind === "approval") toggle(at.ref.id, !selectedIds.has(at.ref.id));
    else if (event.key === "s" && at?.ref.kind === "approval") setSkipRequest((before) => ({ id: at.ref.id, n: (before?.n ?? 0) + 1 }));
    else if (event.key === "o" && at) open(at.ref);
    else if (event.key === "Escape" && selectedIds.size > 0) setSelectedIds(new Set());
    else return;
    event.preventDefault();
  };
  useEffect(() => {
    keys.current = onKey;
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

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
            {...(full
              ? {
                  selected: selectedIds.has(decision.ref.id),
                  onSelect: (on: boolean) => toggle(decision.ref.id, on),
                  focused: focused === decision.ref.id,
                  skipRequest: skipRequest?.id === decision.ref.id ? skipRequest.n : 0,
                }
              : {})}
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
      <BulkBar selected={selected} onClear={() => setSelectedIds(new Set())} />
      {list}
      {decisions && decisions.length > 0 ? (
        <p className="mt-4 hidden text-xs text-muted-foreground sm:block">
          Keyboard: <Key>j</Key> <Key>k</Key> move between cards, <Key>x</Key> select, <Key>s</Key> skip, <Key>o</Key> open details, <Key>Esc</Key> clear the selection. Approving always takes a held press.
        </p>
      ) : null}
      <StandingRules />
    </>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-strong">{children}</kbd>;
}
