"use client";

import { useId, useState } from "react";

import { FormError, TextInput, useRun } from "@/components/app/form";
import { Sparkles } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { CheckboxRow } from "@/components/ui/selection";
import { cn } from "@/lib/utils";

import type { DecisionReason } from "../../../convex/lib/approvalReasons";

const OTHER = "other";

export type PickedReason = { reasonCode?: string; note?: string; remember?: boolean };

/**
 * A button that opens a short list of reasons to tap, then acts. "Other" is the only one that needs typing;
 * a picked reason can take an optional detail. Reasons the agent wrote for this proposal come first, marked.
 * A reason that can hold next time offers to be kept as a standing rule.
 */
export function ReasonPicker({
  label,
  question,
  reasons,
  confirm,
  required = true,
  variant = "outline",
  otherPlaceholder = "Say why in a few words",
  startOpen = false,
  onCancel,
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
  /** Opened by its caller (a keyboard shortcut, a bulk action) instead of by its own button. */
  startOpen?: boolean;
  onCancel?: () => void;
  onSubmit: (picked: PickedReason) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(startOpen);
  const [code, setCode] = useState<string | null>(null);
  const [words, setWords] = useState("");
  const [remember, setRemember] = useState(false);
  const { busy, error, run, setError } = useRun();
  const questionId = useId();
  const other = code === OTHER;
  const picked = reasons.find((reason) => reason.code === code) ?? null;
  const ready = other ? words.trim().length > 0 : code !== null || !required;

  function close() {
    setOpen(false);
    setCode(null);
    setWords("");
    setRemember(false);
    setError(null);
    onCancel?.();
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
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return setError(other ? "Say why in a few words." : "Choose a reason.");
        const note = words.trim() || undefined;
        void run(async () => {
          await onSubmit(other ? { note } : { reasonCode: code ?? undefined, note, ...(remember && picked?.remember ? { remember: true } : {}) });
          close();
        });
      }}
    >
      <p id={questionId} className="text-xs font-semibold text-muted-foreground">
        {question}
      </p>
      <div role="radiogroup" aria-labelledby={questionId} className="flex flex-wrap gap-1.5">
        {[...reasons, { code: OTHER, label: "Other…" } as DecisionReason].map((reason, index) => {
          const on = code === reason.code;
          return (
            <button
              key={reason.code}
              type="button"
              role="radio"
              aria-checked={on}
              autoFocus={startOpen && index === 0}
              title={reason.suggested ? "Suggested by the agent for this proposal" : undefined}
              onClick={() => {
                setCode(on ? null : reason.code);
                setRemember(false);
              }}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-brand-500/50",
                on ? "border-brand-500 bg-brand-500/[0.08] text-strong" : "border-border bg-background text-muted-foreground hover:border-brand-500/40 hover:text-strong",
                reason.suggested && !on ? "border-dashed border-brand-500/40" : null,
              )}
            >
              {reason.suggested ? <Sparkles className="size-3 text-brand-300" aria-label="Suggested" /> : null}
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
      {picked?.remember ? <CheckboxRow density="compact" checked={remember} onCheckedChange={setRemember} title={picked.remember} description="You can remove it later under Standing rules on Approvals." /> : null}
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
