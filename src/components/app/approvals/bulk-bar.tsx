"use client";

import { useMutation } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { messageOf } from "@/components/app/form";
import { HoldButton } from "@/components/app/hold-button";
import { ReasonPicker, type PickedReason } from "@/components/app/reason-picker";
import { Button } from "@/components/ui/button";

import { api } from "../../../../convex/_generated/api";
import type { DecisionReason } from "../../../../convex/lib/approvalReasons";
import type { Decision } from "../../../../convex/overview";

type Outcome = { done: number; failed: { title: string; message: string }[] };

/** The skip reasons every selected proposal offers, so one tap means the same thing for each. Never a standing rule. */
function sharedSkipReasons(decisions: Decision[]): DecisionReason[] {
  const lists = decisions.map((decision) => (decision.reasons?.skip ?? []).filter((reason) => !reason.suggested));
  if (lists.length === 0) return [];
  return lists[0].filter((reason) => lists.every((list) => list.some((row) => row.code === reason.code))).map(({ code, label }) => ({ code, label }));
}

/**
 * Deciding several proposals at once. Each is decided on its own, with every check run again, so one that
 * can no longer be carried out does not hold the others back; the result says which did not go through.
 */
export function BulkBar({ selected, onClear }: { selected: Decision[]; onClear: () => void }) {
  const { companyId } = useCompany();
  const decide = useMutation(api.approvals.decide);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [verb, setVerb] = useState<"Approved" | "Skipped">("Approved");

  async function each(decision: "approved" | "skipped", picked: PickedReason = {}) {
    setBusy(true);
    setOutcome(null);
    setVerb(decision === "approved" ? "Approved" : "Skipped");
    const result: Outcome = { done: 0, failed: [] };
    for (const item of selected) {
      if (item.ref.kind !== "approval") continue;
      try {
        await decide({ companyId, approvalId: item.ref.id, decision, ...(decision === "skipped" ? { reasonCode: picked.reasonCode, note: picked.note } : {}) });
        result.done += 1;
      } catch (caught) {
        result.failed.push({ title: item.title, message: messageOf(caught) });
      }
    }
    setBusy(false);
    setOutcome(result);
    onClear();
  }

  if (selected.length === 0) {
    if (!outcome) return null;
    return (
      <div role="status" className="mb-4 rounded-xl border border-border bg-card px-4 py-3 text-sm">
        <p className="text-strong">
          {verb} {outcome.done} {outcome.done === 1 ? "proposal" : "proposals"}.{outcome.failed.length ? ` ${outcome.failed.length} did not go through:` : ""}
        </p>
        {outcome.failed.length ? (
          <ul className="mt-1 grid gap-0.5 text-xs text-destructive-foreground">
            {outcome.failed.map((row) => (
              <li key={row.title}>
                {row.title}: {row.message}
              </li>
            ))}
          </ul>
        ) : null}
        <button type="button" className="mt-1 text-xs font-medium text-brand-300 underline-offset-4 hover:underline" onClick={() => setOutcome(null)}>
          Dismiss
        </button>
      </div>
    );
  }
  const count = selected.length;
  return (
    <div role="region" aria-label="Decide the selected proposals" className="sticky top-2 z-10 mb-4 flex flex-wrap items-start gap-2 rounded-xl border border-brand-500/40 bg-card/95 px-4 py-3 shadow-lg backdrop-blur">
      <p className="mr-2 self-center text-sm font-medium text-strong">{count} selected</p>
      <HoldButton label={`Hold to approve ${count}`} holdingLabel="Keep holding" busy={busy} onConfirm={() => void each("approved")} />
      <ReasonPicker
        label={`Skip ${count}`}
        question={`Why skip these ${count}? The same reason is recorded on each.`}
        reasons={sharedSkipReasons(selected)}
        confirm={`Skip ${count}`}
        required={false}
        onSubmit={(picked) => each("skipped", picked)}
      />
      <Button variant="ghost" size="sm" disabled={busy} onClick={onClear}>
        Clear selection
      </Button>
    </div>
  );
}
