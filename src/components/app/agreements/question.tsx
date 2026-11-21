"use client";

import { Field, TextArea, TextInput } from "@/components/app/form";
import { Select } from "@/components/ui/selection";
import { cn } from "@/lib/utils";

export type Q = { key: string; label: string; ask: string; type: string; choices?: readonly string[] | null; help?: string | null; value?: unknown; source?: string | null; skipped?: boolean };

export const cents = (value: unknown) => (typeof value === "number" ? (value / 100).toFixed(2) : "");

/** What an input shows for a stored answer. Money is shown as dollars, lists as comma-separated text. */
export function shown(q: Q): string {
  const value = q.value;
  if (value === null || value === undefined) return "";
  if (q.type === "money") return cents(value);
  if (q.type === "bool") return value === true ? "yes" : value === false ? "no" : "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/** One question as an input, in the person's own units. The server coerces and checks what is sent. */
export function QuestionField({ q, draft, onChange, disabled }: { q: Q; draft: string; onChange: (value: string) => void; disabled?: boolean }) {
  const hint = [q.help, q.source ? `From: ${q.source}` : null].filter(Boolean).join(" · ") || undefined;
  return (
    <Field label={q.ask} hint={hint}>
      {q.type === "choice" && q.choices ? (
        <Select value={draft} onValueChange={(next) => onChange(next ?? "")} options={q.choices.map((choice) => ({ value: choice, label: choice }))} emptyLabel="Choose…" placeholder="Choose…" disabled={disabled} searchable="auto" />
      ) : q.type === "bool" ? (
        <Select value={draft} onValueChange={(next) => onChange(next ?? "")} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} emptyLabel="Choose…" placeholder="Choose…" disabled={disabled} />
      ) : q.type === "longtext" || q.type === "list" ? (
        <TextArea value={draft} disabled={disabled} rows={q.type === "list" ? 2 : 3} onChange={(event) => onChange(event.target.value)} placeholder={q.type === "list" ? "Separate with commas" : undefined} />
      ) : (
        <TextInput
          value={draft}
          disabled={disabled}
          type={q.type === "date" ? "date" : "text"}
          inputMode={q.type === "money" ? "decimal" : q.type === "int" ? "numeric" : undefined}
          placeholder={q.type === "money" ? "0.00" : q.key === "governingState" ? "TX" : undefined}
          className={cn(q.skipped && "border-dashed")}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}
