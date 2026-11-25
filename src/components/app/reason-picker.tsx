"use client";

import { useId, useState } from "react";

import { FormError, TextInput, useRun } from "@/components/app/form";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { DecisionReason } from "../../../convex/lib/approvalReasons";

const OTHER = "other";

export type PickedReason = { reasonCode?: string; note?: string };

/**
 * A button that opens a short list of reasons to tap, then acts. "Other" is the only one that needs typing;
 * a picked reason can take an optional detail.
 */
export function ReasonPicker({
  label,
  question,
  reasons,
  confirm,
  required = true,
  variant = "outline",
  otherPlaceholder = "Say why in a few words",
  onSubmit,
}: {
  label: string;
  question: string;
  reasons: DecisionReason[];
  confirm: string;
  /** When false, the person may act without choosing a reason. */
  required?: boolean;
  variant?: "outline" | "ghost" | "destructive-outline";
  otherPlaceholder?: string;
  onSubmit: (picked: PickedReason) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [words, setWords] = useState("");
  const { busy, error, run, setError } = useRun();
  const questionId = useId();
  const other = code === OTHER;
  const ready = other ? words.trim().length > 0 : code !== null || !required;

  function close() {
    setOpen(false);
    setCode(null);
    setWords("");
    setError(null);
  }

  if (!open) {
    return (
      <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  return (
    <form
      className="grid w-full gap-2.5 rounded-xl border border-border bg-muted p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return setError(other ? "Say why in a few words." : "Choose a reason.");
        const note = words.trim() || undefined;
        void run(async () => {
          await onSubmit(other ? { note } : { reasonCode: code ?? undefined, note });
          close();
        });
      }}
    >
      <p id={questionId} className="text-xs font-semibold text-muted-foreground">
        {question}
      </p>
      <div role="radiogroup" aria-labelledby={questionId} className="flex flex-wrap gap-1.5">
        {[...reasons, { code: OTHER, label: "Other…" }].map((reason) => {
          const on = code === reason.code;
          return (
            <button
              key={reason.code}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setCode(on ? null : reason.code)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-brand-500/50",
                on ? "border-brand-500 bg-brand-500/[0.08] text-strong" : "border-border bg-background text-muted-foreground hover:border-brand-500/40 hover:text-strong",
              )}
            >
              {reason.label}
            </button>
          );
        })}
      </div>
      {code !== null ? (
        <TextInput
          autoFocus={other}
          value={words}
          onChange={(event) => setWords(event.target.value)}
          placeholder={other ? otherPlaceholder : "Add a detail (optional)"}
          aria-label={other ? otherPlaceholder : "Add a detail (optional)"}
          maxLength={500}
        />
      ) : null}
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!ready}>
          {confirm}
        </Button>
        <Button variant="ghost" size="sm" onClick={close}>
          Never mind
        </Button>
      </div>
    </form>
  );
}
