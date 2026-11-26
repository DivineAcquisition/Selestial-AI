"use client";

import { useRef } from "react";

import { Check } from "@/components/icons";
import { Checkbox, RadioButtonGroup, Select } from "@/components/ui/selection";
import { cn } from "@/lib/utils";

import { ADDRESS_PARTS } from "../../../../convex/lib/recruiter/formDefinition";
import type { Field } from "../../../../convex/lib/recruiter/form";

export type Answer = string | number | boolean | string[];
export type Answers = Record<string, Answer>;
export type FileRow = { attachmentId: string; fileName: string; field: string | null };
export type FileControls = { files: FileRow[]; canAdd: boolean; busy: boolean; onUpload: (field: Field, file: File) => void; onRemove: (attachmentId: string) => void };

export const inputClass = "min-h-12 w-full rounded-xl border border-border bg-background px-3 text-base outline-none focus:border-[var(--apply-accent)] focus-visible:outline-2 focus-visible:outline-[var(--apply-accent)]/40";
// A visible tick on what is chosen, never colour alone.
const choiceClass = "inline-flex items-center justify-center gap-1.5 border font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--apply-accent)]/50 motion-reduce:transition-none";
const choiceOn = "border-[var(--apply-accent)] bg-[var(--apply-accent)] text-white";
const choiceOff = "border-border bg-background hover:border-[var(--apply-accent)]/50";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function Label({ field, large }: { field: Field; large?: boolean }) {
  return (
    <span className={cn("font-medium", large ? "text-lg leading-snug sm:text-xl" : "")}>
      {field.label}
      {field.required ? <span aria-hidden> *</span> : null}
      {field.required ? <span className="sr-only"> (required)</span> : null}
    </span>
  );
}

function Help({ field }: { field: Field }) {
  return field.help ? <span className="text-xs text-muted-foreground">{field.help}</span> : null;
}

function PolicyLink({ field }: { field: Field }) {
  return field.link ? (
    <a href={field.link.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-[var(--apply-accent)] underline">
      {field.link.label}
    </a>
  ) : null;
}

/**
 * One question. `large` is the one-question-at-a-time screen: bigger type and lettered choices, which
 * the applicant can also pick by pressing the letter.
 */
export function FieldInput({ field, value, onChange, large, files }: { field: Field; value: Answer | undefined; onChange: (value: Answer | undefined) => void; large?: boolean; files?: FileControls }) {
  const id = `field-${field.key}`;
  const fileInput = useRef<HTMLInputElement>(null);

  if (field.kind === "statement") {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className={cn("whitespace-pre-line", large ? "text-lg leading-snug" : "")}>{field.label}</p>
        {field.help ? <p className="text-muted-foreground">{field.help}</p> : null}
        <PolicyLink field={field} />
      </div>
    );
  }

  if (field.kind === "consent") {
    return (
      <div className="flex flex-col gap-2">
        <label className={cn("flex items-start gap-3 text-sm", large ? "rounded-2xl border border-border bg-card p-4 text-base" : "")}>
          <Checkbox data-testid={id} className="mt-1 shrink-0" checked={value === true} onCheckedChange={(checked) => onChange(checked ? true : field.required ? false : undefined)} />
          <span>
            {field.label}
            {field.required ? <span aria-hidden> *</span> : null}
          </span>
        </label>
        <Help field={field} />
        <PolicyLink field={field} />
      </div>
    );
  }

  if (field.kind === "yes_no") {
    return (
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1">
          <Label field={field} large={large} />
        </legend>
        <Help field={field} />
        {/* Yes and No are exclusive, so they are radios. Nothing is chosen until the applicant answers. */}
        <RadioButtonGroup className={cn("flex gap-2", large ? "flex-col sm:flex-row" : "")} aria-label={field.label}>
          {[true, false].map((option, index) => (
            <button key={String(option)} type="button" role="radio" data-testid={`${id}-${option ? "yes" : "no"}`} data-letter={large ? LETTERS[index] : undefined} aria-checked={value === option} onClick={() => onChange(option)} className={cn(choiceClass, "min-h-12 flex-1 rounded-xl px-4 text-base", value === option ? choiceOn : choiceOff, large ? "justify-start" : "")}>
              {large ? <kbd className="rounded border border-current/30 px-1.5 text-xs">{LETTERS[index]}</kbd> : null}
              {value === option ? <Check className="size-4" aria-hidden /> : null}
              {option ? "Yes" : "No"}
            </button>
          ))}
        </RadioButtonGroup>
      </fieldset>
    );
  }

  if (field.kind === "multi" || (field.kind === "choice" && large)) {
    const multi = field.kind === "multi";
    const chosen = multi ? (Array.isArray(value) ? value : []) : typeof value === "string" ? [value] : [];
    return (
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1">
          <Label field={field} large={large} />
        </legend>
        <Help field={field} />
        <div className={cn("flex gap-2", large ? "flex-col" : "flex-wrap")} role={multi ? "group" : "radiogroup"} aria-label={field.label}>
          {(field.options ?? []).map((option, index) => {
            const on = chosen.includes(option);
            return (
              <button
                key={option}
                type="button"
                role={multi ? "checkbox" : "radio"}
                data-testid={`${id}-${option}`}
                data-letter={large ? LETTERS[index] : undefined}
                aria-checked={on}
                onClick={() => onChange(multi ? (on ? chosen.filter((entry) => entry !== option) : [...chosen, option]) : option)}
                className={cn(choiceClass, large ? "min-h-12 justify-start rounded-xl px-4 text-base" : "min-h-11 rounded-full px-4 text-sm", on ? choiceOn : choiceOff)}
              >
                {large ? <kbd className="rounded border border-current/30 px-1.5 text-xs">{LETTERS[index]}</kbd> : null}
                {on ? <Check className="size-3.5" aria-hidden /> : null}
                {option}
              </button>
            );
          })}
        </div>
        {multi && large ? <span className="text-xs text-muted-foreground">Choose all that apply.</span> : null}
      </fieldset>
    );
  }

  if (field.kind === "choice") {
    return (
      <label className="flex flex-col gap-1 text-sm">
        <Label field={field} />
        <Select value={typeof value === "string" ? value : ""} onValueChange={(next) => onChange(next || undefined)} options={(field.options ?? []).map((option) => ({ value: option, label: option }))} emptyLabel="Choose…" placeholder="Choose…" className={inputClass} data-testid={id} searchable="auto" />
        <Help field={field} />
      </label>
    );
  }

  if (field.kind === "address") {
    const parts = Array.isArray(value) ? value : ["", "", "", ""];
    const setPart = (index: number, next: string) => {
      const out = [0, 1, 2, 3].map((i) => (i === index ? next : (parts[i] ?? "")));
      onChange(out.some(Boolean) ? out : undefined);
    };
    return (
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1">
          <Label field={field} large={large} />
        </legend>
        <Help field={field} />
        <input data-testid={`${id}-0`} aria-label={ADDRESS_PARTS[0]} placeholder={ADDRESS_PARTS[0]} autoComplete="address-line1" maxLength={200} className={inputClass} value={parts[0] ?? ""} onChange={(event) => setPart(0, event.target.value)} />
        <div className="grid grid-cols-[1fr_5rem_7rem] gap-2">
          <input data-testid={`${id}-1`} aria-label={ADDRESS_PARTS[1]} placeholder={ADDRESS_PARTS[1]} autoComplete="address-level2" maxLength={80} className={inputClass} value={parts[1] ?? ""} onChange={(event) => setPart(1, event.target.value)} />
          <input data-testid={`${id}-2`} aria-label={ADDRESS_PARTS[2]} placeholder="State" autoComplete="address-level1" maxLength={30} className={inputClass} value={parts[2] ?? ""} onChange={(event) => setPart(2, event.target.value)} />
          <input data-testid={`${id}-3`} aria-label={ADDRESS_PARTS[3]} placeholder="ZIP" autoComplete="postal-code" inputMode="numeric" maxLength={10} className={inputClass} value={parts[3] ?? ""} onChange={(event) => setPart(3, event.target.value)} />
        </div>
      </fieldset>
    );
  }

  if (field.kind === "file") {
    const mine = files?.files.filter((file) => file.field === field.key) ?? [];
    return (
      <div className="flex flex-col gap-2 text-sm">
        <Label field={field} large={large} />
        <Help field={field} />
        {mine.map((file) => (
          <div key={file.attachmentId} className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2">
            <span className="truncate">{file.fileName}</span>
            <button type="button" className="shrink-0 text-red-600 underline" disabled={files?.busy} onClick={() => files?.onRemove(file.attachmentId)}>
              Remove
            </button>
          </div>
        ))}
        {files?.canAdd ? (
          <>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              data-testid={`${id}-input`}
              accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) files.onUpload(field, file);
              }}
            />
            <button type="button" disabled={files.busy} onClick={() => fileInput.current?.click()} className={cn(choiceClass, choiceOff, "min-h-12 rounded-xl px-4 text-base")}>
              {files.busy ? "Working…" : mine.length ? "Add another file" : "Choose a file"}
            </button>
          </>
        ) : null}
        {!files ? <p className="text-xs text-muted-foreground">Files are added on the live form.</p> : null}
      </div>
    );
  }

  if (field.kind === "long_text") {
    return (
      <label className="flex flex-col gap-1 text-sm">
        <Label field={field} large={large} />
        <Help field={field} />
        <textarea data-testid={id} rows={large ? 5 : 4} maxLength={2000} placeholder={field.placeholder} className="w-full rounded-xl border border-border bg-background px-3 py-2 text-base outline-none focus:border-[var(--apply-accent)]" value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)} />
      </label>
    );
  }

  if (field.kind === "number") {
    return (
      <label className="flex flex-col gap-1 text-sm">
        <Label field={field} large={large} />
        <Help field={field} />
        <input data-testid={id} type="number" inputMode="decimal" min={0} placeholder={field.placeholder} className={inputClass} value={typeof value === "number" ? value : ""} onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} />
      </label>
    );
  }

  if (field.kind === "date") {
    return (
      <label className="flex flex-col gap-1 text-sm">
        <Label field={field} large={large} />
        <Help field={field} />
        <input data-testid={id} type="date" className={inputClass} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)} />
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1 text-sm">
      <Label field={field} large={large} />
      <input data-testid={id} type={field.kind === "email" ? "email" : field.kind === "phone" ? "tel" : "text"} autoComplete={field.kind === "email" ? "email" : field.kind === "phone" ? "tel" : field.key === "fullName" ? "name" : "off"} maxLength={300} placeholder={field.placeholder} className={inputClass} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)} />
      <Help field={field} />
    </label>
  );
}

export function answerText(field: Field, value: Answer | undefined): string {
  if (value === undefined || value === "") return "Not answered";
  if (typeof value === "boolean") return field.kind === "consent" ? (value ? "Agreed" : "Did not agree") : value ? "Yes" : "No";
  if (Array.isArray(value)) return (field.kind === "address" ? value.filter(Boolean).join(", ") : value.join(", ")) || "Not answered";
  return String(value);
}
