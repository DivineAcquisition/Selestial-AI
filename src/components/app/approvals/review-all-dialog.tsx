"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { messageOf } from "@/components/app/form";
import { HoldButton } from "@/components/app/hold-button";
import { ReasonPicker, type PickedReason } from "@/components/app/reason-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/selection";
import { whenLabel } from "@/lib/app/format";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { BatchResult, QueueGroup } from "../../../../convex/approvals";

export type QueueSummary = { total: number; overdue: number; groups: QueueGroup[]; truncated: boolean };
type Decide = (ids: Id<"approvals">[], decision: "approved" | "skipped", picked: PickedReason) => Promise<BatchResult[]>;

const BATCH = 10;

/** Sends the ids ten at a time, so each step stays small, and keeps going when one batch fails. */
export async function inBatches(ids: Id<"approvals">[], decision: "approved" | "skipped", picked: PickedReason, decide: Decide, onProgress: (done: number) => void): Promise<BatchResult[]> {
  const out: BatchResult[] = [];
  for (let at = 0; at < ids.length; at += BATCH) {
    const batch = ids.slice(at, at + BATCH);
    try {
      out.push(...(await decide(batch, decision, picked)));
    } catch (caught) {
      const message = messageOf(caught);
      out.push(...batch.map((id) => ({ id, ok: false, message })));
    }
    onProgress(Math.min(ids.length, at + BATCH));
  }
  return out;
}

/** "Review all": the whole queue in groups, decided a group at a time. */
export function ReviewAllDialog({ open, onOpenChange, onReviewGroup }: { open: boolean; onOpenChange: (open: boolean) => void; onReviewGroup: (group: QueueGroup) => void }) {
  const { companyId, timezone } = useCompany();
  const [now] = useState(() => Date.now());
  const summary = useQuery(api.approvals.queueSummary, open ? { companyId, asOf: now } : "skip");
  const decideMany = useMutation(api.approvals.decideMany);
  const decide: Decide = (approvalIds, decision, picked) => decideMany({ companyId, approvalIds, decision, ...(decision === "skipped" ? { reasonCode: picked.reasonCode, note: picked.note } : {}) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-3xl">
        <ReviewAllView summary={summary ?? null} now={now} timezone={timezone} decide={decide} onReviewGroup={onReviewGroup} onClose={() => onOpenChange(false)} />
      </DialogPopup>
    </Dialog>
  );
}

type Run = { verb: "Approving" | "Skipping"; total: number; done: number; results: BatchResult[] | null };

export function ReviewAllView({ summary, now, timezone, decide, onReviewGroup, onClose }: { summary: QueueSummary | null; now: number; timezone: string; decide: Decide; onReviewGroup: (group: QueueGroup) => void; onClose: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [run, setRun] = useState<Run | null>(null);
  // Approvals already sent are left out until the summary catches up, so nothing is sent twice.
  const [sent, setSent] = useState<Set<string>>(new Set());

  const groups = (summary?.groups ?? [])
    .map((group) => {
      const ids = group.ids.filter((id) => !sent.has(id));
      return ids.length === group.ids.length ? group : { ...group, ids, count: ids.length };
    })
    .filter((group) => group.count > 0);
  const routine = groups.filter((group) => group.risk === "routine" && group.canDecide);
  const oneByOne = groups.filter((group) => group.risk === "review" || !group.canDecide);
  const chosen = routine.filter((group) => picked.has(group.key));
  const chosenCount = chosen.reduce((sum, group) => sum + group.count, 0);
  const departments = [...new Set(routine.map((group) => group.department))];

  async function start(targets: QueueGroup[], decision: "approved" | "skipped", reason: PickedReason = {}) {
    const ids = targets.flatMap((group) => group.ids);
    if (ids.length === 0) return;
    setRun({ verb: decision === "approved" ? "Approving" : "Skipping", total: ids.length, done: 0, results: null });
    const results = await inBatches(ids, decision, reason, decide, (done) => setRun((before) => (before ? { ...before, done } : before)));
    setSent((before) => new Set([...before, ...ids]));
    setPicked(new Set());
    setRun((before) => (before ? { ...before, done: ids.length, results } : before));
  }

  if (!summary) {
    return (
      <DialogHeader>
        <DialogTitle>Loading the queue…</DialogTitle>
      </DialogHeader>
    );
  }
  if (run) return <RunView run={run} onBack={() => setRun(null)} onClose={onClose} />;

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {summary.total.toLocaleString("en-US")} {summary.total === 1 ? "approval" : "approvals"} waiting
        </DialogTitle>
        <DialogDescription>
          {summary.overdue > 0 ? `${summary.overdue} past their deadline. ` : ""}Approve or skip a whole group at once. Each one is still checked before it is carried out. Prices, refunds above the limit and hiring outcomes stay for one-by-one review.
          {summary.truncated ? " Only the first 2,000 are shown here." : ""}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-5">
        {groups.length === 0 ? <p className="text-sm text-muted-foreground">Nothing is waiting.</p> : null}
        {departments.map((department) => (
          <section key={department} aria-label={department} className="grid gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{department}</h3>
            {routine
              .filter((group) => group.department === department)
              .map((group) => (
                <GroupRow key={group.key} group={group} now={now} timezone={timezone} selected={picked.has(group.key)} onSelect={(on) => setPicked((before) => toggled(before, group.key, on))}>
                  <HoldButton label={`Hold to approve ${group.count}`} holdingLabel="Keep holding" onConfirm={() => void start([group], "approved")} />
                  <SkipGroup groups={[group]} onSkip={(reason) => start([group], "skipped", reason)} />
                </GroupRow>
              ))}
          </section>
        ))}
        {oneByOne.length > 0 ? (
          <section aria-label="Review one by one" className="grid gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Review one by one</h3>
            {oneByOne.map((group) => (
              <GroupRow key={group.key} group={group} now={now} timezone={timezone} note={group.notYours ?? "Prices, money above the limit and hiring outcomes are read one at a time."}>
                <Button variant="outline" size="sm" onClick={() => onReviewGroup(group)}>
                  Review {group.count === 1 ? "it" : `these ${group.count}`}
                </Button>
                {group.canDecide ? <SkipGroup groups={[group]} onSkip={(reason) => start([group], "skipped", reason)} /> : null}
              </GroupRow>
            ))}
          </section>
        ) : null}
      </DialogPanel>
      {routine.length > 0 ? (
        <DialogFooter className="items-center sm:justify-between">
          <label className="flex items-center gap-2 text-sm text-strong">
            <Checkbox
              checked={chosen.length === routine.length}
              indeterminate={chosen.length > 0 && chosen.length < routine.length}
              onCheckedChange={(on) => setPicked(on ? new Set(routine.map((group) => group.key)) : new Set())}
              aria-label="Select every group that can be approved together"
            />
            Every group above
          </label>
          <HoldButton label={chosenCount > 0 ? `Hold to approve all selected (${chosenCount})` : "Select groups to approve"} holdingLabel="Keep holding" disabled={chosenCount === 0} onConfirm={() => void start(chosen, "approved")} />
        </DialogFooter>
      ) : null}
    </>
  );
}

function toggled(before: Set<string>, key: string, on: boolean) {
  const next = new Set(before);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

function SkipGroup({ groups, onSkip }: { groups: QueueGroup[]; onSkip: (reason: PickedReason) => Promise<unknown> }) {
  const count = groups.reduce((sum, group) => sum + group.count, 0);
  return <ReasonPicker label={`Skip ${count}`} question={`Why skip these ${count}? The same reason is recorded on each.`} reasons={groups[0]?.skipReasons ?? []} confirm={`Skip ${count}`} required={false} variant="ghost" onSubmit={onSkip} />;
}

function GroupRow({ group, now, timezone, selected, onSelect, note, children }: { group: QueueGroup; now: number; timezone: string; selected?: boolean; onSelect?: (on: boolean) => void; note?: string; children: React.ReactNode }) {
  const [more, setMore] = useState(false);
  const late = group.earliestDeadline <= now;
  return (
    <div className={cn("grid gap-2 rounded-xl border bg-background px-3.5 py-3", selected ? "border-brand-500/60 bg-brand-500/[0.04]" : "border-border")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 items-start gap-2.5">
          {onSelect ? <Checkbox checked={Boolean(selected)} onCheckedChange={onSelect} aria-label={`Select ${group.actionLabel}`} className="mt-0.5" /> : null}
          <span className="min-w-0">
            <span className="block text-sm font-medium text-strong">{group.actionLabel}</span>
            <span className="block text-xs text-muted-foreground">
              {group.department} · {late ? "Deadline passed" : `First deadline ${whenLabel(group.earliestDeadline, now, timezone)}`}
            </span>
            {note ? <span className="mt-0.5 block text-xs text-warning-foreground">{note}</span> : null}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          {group.overdue > 0 ? (
            <Badge variant="error" size="sm">
              {group.overdue} overdue
            </Badge>
          ) : null}
          <Badge variant="outline" size="sm">
            {group.count}
          </Badge>
        </span>
      </div>
      <button type="button" className="justify-self-start text-xs font-medium text-brand-300 underline-offset-4 hover:underline" aria-expanded={more} onClick={() => setMore(!more)}>
        {more ? "Hide examples" : "Show examples"}
      </button>
      {more ? (
        <ul className="grid gap-0.5 border-l border-border pl-3 text-xs text-muted-foreground">
          {group.samples.map((title, index) => (
            <li key={`${index}-${title}`}>{title}</li>
          ))}
          {group.count > group.samples.length ? <li>and {group.count - group.samples.length} more like these</li> : null}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-start gap-2">{children}</div>
    </div>
  );
}

function RunView({ run, onBack, onClose }: { run: Run; onBack: () => void; onClose: () => void }) {
  const percent = run.total === 0 ? 100 : Math.round((run.done / run.total) * 100);
  const results = run.results;
  const ok = results?.filter((row) => row.ok) ?? [];
  const notCarried = ok.filter((row) => row.carriedOut && !row.carriedOut.ok);
  const failures = new Map<string, number>();
  for (const row of results ?? []) if (!row.ok) failures.set(row.message ?? "Not decided.", (failures.get(row.message ?? "Not decided.") ?? 0) + 1);
  for (const row of notCarried) failures.set(row.carriedOut!.detail, (failures.get(row.carriedOut!.detail) ?? 0) + 1);
  const pastTense = run.verb === "Approving" ? "Approved" : "Skipped";
  return (
    <>
      <DialogHeader>
        <DialogTitle>{results ? `${pastTense} ${ok.length - notCarried.length} of ${run.total}` : `${run.verb} ${run.done} of ${run.total}…`}</DialogTitle>
        <DialogDescription>{results ? "Here is what happened." : "Keep this open until it finishes. Each one is checked again before it is carried out."}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-3">
        <div role="progressbar" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.done} aria-label={`${run.verb} approvals`} className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-brand-500 transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
        {results && failures.size > 0 ? (
          <div className="grid gap-1">
            <p className="text-sm font-medium text-strong">{[...failures.values()].reduce((a, b) => a + b, 0)} did not go through:</p>
            <ul className="grid gap-0.5 text-xs text-muted-foreground">
              {[...failures.entries()].map(([message, count]) => (
                <li key={message}>
                  <span className="tabular-nums text-strong">{count}</span> · {message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </DialogPanel>
      {results ? (
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back to the groups
          </Button>
          <Button variant="primary" size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      ) : null}
    </>
  );
}
