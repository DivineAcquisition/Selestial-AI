"use client";

/**
 * The application form builder's controls for whatever is selected: a question, a section, the look,
 * the page's words or the invitation email. Each change is applied to the draft on screen; the builder
 * saves it after a short pause, and the server checks it in full before it is kept.
 */
import { ArrowDown, ArrowUp, Trash } from "@phosphor-icons/react";

import { Field, TextArea, TextInput } from "@/components/app/form";
import { Notice } from "@/components/app/services/shared";
import { buttonVariants } from "@/components/ui/button-variants";
import { Select, Switch } from "@/components/ui/selection";
import { cn } from "@/lib/utils";

import { BUILTINS, FIELD_KIND_LABELS, FORM_LIMITS, WEEKDAYS, type FieldKind, type FormDefinition, type FormField, type FormSection } from "../../../../convex/lib/recruiter/formDefinition";

export type Catalog = {
  builtins: { id: string; name: string; kind: FieldKind; label: string; help: string; locked: ("required" | "wording")[] }[];
  kinds: { kind: FieldKind; label: string }[];
  displays: { id: string; label: string; blurb: string }[];
};

type Change = (mutate: (draft: FormDefinition) => void) => void;

export const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

export function blankField(kind: FieldKind): FormField {
  return { id: uid("q"), builtin: false, kind, label: kind === "statement" ? "Something applicants should know" : kind === "consent" ? "I agree to…" : "New question", help: "", placeholder: "", required: kind !== "statement", options: kind === "choice" || kind === "multi" ? ["Option 1", "Option 2"] : kind === "file" ? ["supporting"] : [] };
}

export function builtinField(id: string): FormField {
  const base = BUILTINS[id];
  return { id, builtin: true, kind: base.kind, label: base.label, help: base.help ?? "", placeholder: "", required: base.locked?.includes("required") ?? false, options: base.kind === "file" ? ["resume"] : [] };
}

function move<T>(list: T[], from: number, to: number) {
  const [row] = list.splice(from, 1);
  list.splice(to, 0, row);
}

export function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <header>
        <h3 className="font-heading text-base tracking-tight text-strong">{title}</h3>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-strong">{label}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}

function Text({ label, value, max, onChange, area, hint, disabled }: { label: string; value: string; max: number; onChange: (value: string) => void; area?: boolean; hint?: string; disabled?: boolean }) {
  return (
    <Field label={label} hint={hint} error={value.length > max ? `Keep it under ${max} characters.` : null}>
      {area ? <TextArea value={value} disabled={disabled} rows={4} onChange={(event) => onChange(event.target.value)} /> : <TextInput value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />}
    </Field>
  );
}

/** The answers an earlier question can have, for "show only when" and knockouts. */
export function answersOf(field: FormField): string[] {
  if (field.kind === "yes_no" || field.kind === "consent") return ["Yes", "No"];
  if (field.id === "availableDays") return [...WEEKDAYS];
  if (field.kind === "choice" || field.kind === "multi") return field.options;
  return [];
}

// ── A question ───────────────────────────────────────────────────────────────────────────────────

export function FieldPanel({ def, change, sectionIndex, fieldIndex, catalog, onRemoved }: { def: FormDefinition; change: Change; sectionIndex: number; fieldIndex: number; catalog: Catalog; onRemoved: () => void }) {
  const section = def.sections[sectionIndex];
  const field = section?.fields[fieldIndex];
  if (!section || !field) return <Notice title="Choose a question">Pick a question on the left to change it.</Notice>;
  const builtin = field.builtin ? catalog.builtins.find((row) => row.id === field.id) : undefined;
  const lockedWording = builtin?.locked.includes("wording") ?? false;
  const lockedRequired = builtin?.locked.includes("required") ?? false;
  const set = (mutate: (row: FormField) => void) => change((draft) => mutate(draft.sections[sectionIndex].fields[fieldIndex]));
  const earlier = def.sections.flatMap((row, s) => row.fields.filter((_, f) => s < sectionIndex || (s === sectionIndex && f < fieldIndex)));
  const conditionOptions = earlier.flatMap((row) => answersOf(row).map((answer) => ({ value: `${row.id}::${answer}`, label: `${row.label.slice(0, 50)} is "${answer}"` })));
  const knockoutAnswers = answersOf(field);
  const canKnockout = !["statement", "file", "address", "email", "phone", "text", "long_text", "date"].includes(field.kind);
  const textual = field.kind === "text" || field.kind === "long_text" || field.kind === "number" || field.kind === "email" || field.kind === "phone";

  return (
    <Panel title={builtin ? builtin.name : FIELD_KIND_LABELS[field.kind]} description={builtin ? "A standard field. Recruiter knows what it means, so screening, the applicant's record and onboarding can use the answer." : "A question of your own. Its answer is shown to your team and in screening."}>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" aria-label="Move up" disabled={fieldIndex === 0} onClick={() => change((draft) => move(draft.sections[sectionIndex].fields, fieldIndex, fieldIndex - 1))} className={buttonVariants({ variant: "outline", size: "icon-xs" })}>
          <ArrowUp aria-hidden />
        </button>
        <button type="button" aria-label="Move down" disabled={fieldIndex === section.fields.length - 1} onClick={() => change((draft) => move(draft.sections[sectionIndex].fields, fieldIndex, fieldIndex + 1))} className={buttonVariants({ variant: "outline", size: "icon-xs" })}>
          <ArrowDown aria-hidden />
        </button>
        <div className="min-w-[10rem] flex-1">
          <Select
            aria-label="Section"
            value={section.id}
            density="compact"
            options={def.sections.map((row) => ({ value: row.id, label: `In: ${row.title}` }))}
            onValueChange={(next) => {
              if (!next || next === section.id) return;
              change((draft) => {
                const [row] = draft.sections[sectionIndex].fields.splice(fieldIndex, 1);
                draft.sections.find((s) => s.id === next)!.fields.push(row);
              });
            }}
          />
        </div>
        <button
          type="button"
          disabled={lockedRequired}
          title={lockedRequired ? "Every application asks for this." : undefined}
          onClick={() => {
            change((draft) => {
              draft.sections[sectionIndex].fields.splice(fieldIndex, 1);
              for (const row of draft.sections.flatMap((s) => s.fields)) if (row.showIf?.fieldId === field.id) delete row.showIf;
            });
            onRemoved();
          }}
          className={buttonVariants({ variant: "ghost", size: "xs" })}
        >
          <Trash aria-hidden /> Remove
        </button>
      </div>

      {lockedWording ? (
        <div className="rounded-xl border border-border bg-muted/40 px-3.5 py-3 text-sm">
          <p className="font-medium text-strong">{field.id === "smsConsent" ? "Wording set by phone carriers" : field.id === "availableDays" || field.id === "serviceAreas" ? "Choices set by Recruiter" : "Fixed wording"}</p>
          <p className="mt-0.5 text-muted-foreground">{builtin?.help || field.label}</p>
        </div>
      ) : (
        <Text label={field.kind === "statement" ? "Text" : field.kind === "consent" ? "What they agree to" : "Question"} value={field.label} max={FORM_LIMITS.label} area={field.kind === "consent" || field.kind === "statement"} onChange={(value) => set((row) => void (row.label = value))} />
      )}
      {field.id !== "smsConsent" ? <Text label="Help text" hint="A short line under the question." value={field.help} max={FORM_LIMITS.help} onChange={(value) => set((row) => void (row.help = value))} /> : null}
      {textual ? <Text label="Placeholder" value={field.placeholder} max={FORM_LIMITS.placeholder} onChange={(value) => set((row) => void (row.placeholder = value))} /> : null}

      {!field.builtin ? (
        <Field label="Answer type">
          <Select
            value={field.kind}
            options={catalog.kinds.map((row) => ({ value: row.kind, label: row.label }))}
            onValueChange={(next) =>
              set((row) => {
                if (!next) return;
                row.kind = next as FieldKind;
                if ((row.kind === "choice" || row.kind === "multi") && row.options.length < 2) row.options = ["Option 1", "Option 2"];
                if (row.kind === "file") row.options = ["supporting"];
                if (row.kind !== "choice" && row.kind !== "multi" && row.kind !== "file") row.options = [];
                if (row.kind === "statement") row.required = false;
                if (row.knockout && (row.kind === "statement" || row.kind === "file" || row.kind === "text" || row.kind === "long_text" || row.kind === "date" || (row.knockout.test.kind === "below" && row.kind !== "number"))) delete row.knockout;
              })
            }
          />
        </Field>
      ) : null}
      {!field.builtin && (field.kind === "choice" || field.kind === "multi") ? (
        <Field label="Choices (one per line)">
          <TextArea rows={5} value={field.options.join("\n")} onChange={(event) => set((row) => void (row.options = event.target.value.split("\n").slice(0, FORM_LIMITS.options)))} />
        </Field>
      ) : null}
      {!field.builtin && field.kind === "file" ? (
        <Field label="Kept as">
          <Select value={field.options[0] ?? "supporting"} options={[{ value: "resume", label: "Resume" }, { value: "supporting", label: "Supporting file" }]} onValueChange={(next) => set((row) => void (row.options = [next ?? "supporting"]))} />
        </Field>
      ) : null}
      {field.kind !== "statement" && field.id !== "smsConsent" ? <Toggle label="Required" hint={lockedRequired ? "Every application asks for this." : field.kind === "consent" ? "The applicant must tick it to send the application." : undefined} checked={field.required} disabled={lockedRequired} onChange={(value) => set((row) => void (row.required = value))} /> : null}

      {field.kind === "consent" || field.kind === "statement" ? (
        <div className="grid gap-2 rounded-xl border border-border p-3">
          <p className="text-sm font-medium text-strong">Policy link (optional)</p>
          <Text label="Link words" value={field.link?.label ?? ""} max={FORM_LIMITS.linkLabel} onChange={(value) => set((row) => void (value || row.link?.url ? (row.link = { label: value, url: row.link?.url ?? "" }) : delete row.link))} />
          <Text label="Address (https://…)" value={field.link?.url ?? ""} max={FORM_LIMITS.url} onChange={(value) => set((row) => void (value || row.link?.label ? (row.link = { label: row.link?.label ?? "Read the policy", url: value }) : delete row.link))} />
        </div>
      ) : null}

      <Field label="Show only when" hint="Ask this only after a particular answer to an earlier question.">
        <Select
          value={field.showIf ? `${field.showIf.fieldId}::${field.showIf.equals}` : ""}
          emptyLabel="Always"
          placeholder="Always"
          searchable="auto"
          options={conditionOptions}
          onValueChange={(next) =>
            set((row) => {
              if (!next) delete row.showIf;
              else {
                const [fieldId, equals] = next.split("::");
                row.showIf = { fieldId, equals };
              }
            })
          }
        />
      </Field>

      {canKnockout ? (
        <div className="grid gap-3 rounded-xl border border-border p-3">
          <Toggle
            label="An answer that ends the application"
            hint="For a published requirement of the role. A person still decides, unless you allowed Recruiter to decline on fixed requirements."
            checked={Boolean(field.knockout)}
            onChange={(on) =>
              set((row) => {
                if (!on) delete row.knockout;
                else row.knockout = { test: field.kind === "number" ? { kind: "below", value: 1 } : { kind: "equals", value: knockoutAnswers.includes("No") ? "No" : (knockoutAnswers[0] ?? "") }, message: "", outcome: "gate" };
              })
            }
          />
          {field.knockout ? (
            <>
              {field.knockout.test.kind === "below" ? (
                <Field label="When the answer is less than">
                  <TextInput inputMode="numeric" value={String(field.knockout.test.value)} onChange={(event) => set((row) => void (row.knockout!.test = { kind: "below", value: Number(event.target.value.replace(/[^\d.]/g, "")) || 0 }))} />
                </Field>
              ) : (
                <Field label="When the answer is">
                  <Select value={field.knockout.test.value} options={knockoutAnswers.map((answer) => ({ value: answer, label: answer }))} onValueChange={(next) => set((row) => void (row.knockout!.test = { kind: "equals", value: next ?? "" }))} />
                </Field>
              )}
              <Field label="What happens">
                <Select
                  value={field.knockout.outcome}
                  options={[
                    { value: "gate", label: "Tell the applicant now" },
                    { value: "flag", label: "Say nothing; flag it in screening" },
                  ]}
                  onValueChange={(next) => set((row) => void (row.knockout!.outcome = next === "flag" ? "flag" : "gate"))}
                />
              </Field>
              {field.knockout.outcome === "gate" ? <Text label="What the applicant is told" hint="They can change their answer, or send the application as it is." area value={field.knockout.message} max={FORM_LIMITS.knockoutMessage} onChange={(value) => set((row) => void (row.knockout!.message = value))} /> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

// ── A section ────────────────────────────────────────────────────────────────────────────────────

export function SectionPanel({ def, change, sectionIndex, catalog, onSelectField, onRemoved }: { def: FormDefinition; change: Change; sectionIndex: number; catalog: Catalog; onSelectField: (sectionId: string, fieldId: string) => void; onRemoved: () => void }) {
  const section = def.sections[sectionIndex];
  if (!section) return null;
  const set = (mutate: (row: FormSection) => void) => change((draft) => mutate(draft.sections[sectionIndex]));
  const used = new Set(def.sections.flatMap((row) => row.fields.map((field) => field.id)));
  const unused = catalog.builtins.filter((row) => !used.has(row.id));
  const holdsRequired = section.fields.some((field) => field.id === "fullName" || field.id === "email");
  const add = (field: FormField) => {
    change((draft) => void draft.sections[sectionIndex].fields.push(field));
    onSelectField(section.id, field.id);
  };
  return (
    <Panel title="Section" description={def.display === "sections" ? "Each section is one page of the form." : "Shown above each of its questions, so applicants know where they are."}>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" aria-label="Move section up" disabled={sectionIndex === 0} onClick={() => change((draft) => move(draft.sections, sectionIndex, sectionIndex - 1))} className={buttonVariants({ variant: "outline", size: "icon-xs" })}>
          <ArrowUp aria-hidden />
        </button>
        <button type="button" aria-label="Move section down" disabled={sectionIndex === def.sections.length - 1} onClick={() => change((draft) => move(draft.sections, sectionIndex, sectionIndex + 1))} className={buttonVariants({ variant: "outline", size: "icon-xs" })}>
          <ArrowDown aria-hidden />
        </button>
        <button
          type="button"
          disabled={holdsRequired || def.sections.length === 1}
          title={holdsRequired ? "This section has the name and email every application asks for. Move them first." : undefined}
          onClick={() => {
            change((draft) => {
              const gone = new Set(draft.sections[sectionIndex].fields.map((field) => field.id));
              draft.sections.splice(sectionIndex, 1);
              for (const row of draft.sections.flatMap((s) => s.fields)) if (row.showIf && gone.has(row.showIf.fieldId)) delete row.showIf;
            });
            onRemoved();
          }}
          className={buttonVariants({ variant: "ghost", size: "xs" })}
        >
          <Trash aria-hidden /> Remove section
        </button>
      </div>
      <Text label="Title" value={section.title} max={FORM_LIMITS.title} onChange={(value) => set((row) => void (row.title = value))} />
      <Text label="Description" value={section.description} max={FORM_LIMITS.help} area onChange={(value) => set((row) => void (row.description = value))} />
      <div className="grid gap-2 border-t border-border pt-3">
        <p className="text-sm font-medium text-strong">Add to this section</p>
        <Select aria-label="Add a question" value="" placeholder="Add a question of your own…" options={catalog.kinds.map((row) => ({ value: row.kind, label: row.label }))} onValueChange={(next) => next && add(blankField(next as FieldKind))} />
        {unused.length ? <Select aria-label="Add a standard field" value="" placeholder="Add a standard field…" options={unused.map((row) => ({ value: row.id, label: row.name }))} onValueChange={(next) => next && add(builtinField(next))} /> : null}
      </div>
    </Panel>
  );
}

// ── The look, the words, the email ───────────────────────────────────────────────────────────────

export function LookPanel({ def, change, catalog, brandColor }: { def: FormDefinition; change: Change; catalog: Catalog; brandColor: string }) {
  return (
    <Panel title="Layout and look" description="How the form is laid out for applicants and its colors.">
      <div className="grid gap-2" role="radiogroup" aria-label="Layout">
        {catalog.displays.map((row) => (
          <button key={row.id} type="button" role="radio" aria-checked={def.display === row.id} onClick={() => change((draft) => void (draft.display = row.id as FormDefinition["display"]))} className={cn("rounded-xl border px-3.5 py-3 text-left transition-colors", def.display === row.id ? "border-brand-500 bg-brand-500/[0.06]" : "border-border hover:border-brand-500/40")}>
            <p className="text-sm font-medium text-strong">{row.label}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{row.blurb}</p>
          </button>
        ))}
      </div>
      <Toggle label="Use the company's brand" hint="The brand color and logo from your public profile in Booking rules." checked={def.theme.useCompanyBrand} onChange={(value) => change((draft) => void (draft.theme.useCompanyBrand = value))} />
      {def.theme.useCompanyBrand ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <span aria-hidden className="size-4 rounded-full border border-border" style={{ background: brandColor }} /> {brandColor}
        </p>
      ) : (
        <Field label="Accent color">
          <span className="flex items-center gap-2">
            <input type="color" aria-label="Accent color" value={def.theme.accentColor} onChange={(event) => change((draft) => void (draft.theme.accentColor = event.target.value))} className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent" />
            <TextInput value={def.theme.accentColor} onChange={(event) => change((draft) => void (draft.theme.accentColor = event.target.value))} />
          </span>
        </Field>
      )}
      <Toggle label="Show the logo" checked={def.theme.showLogo} onChange={(value) => change((draft) => void (draft.theme.showLogo = value))} />
    </Panel>
  );
}

export function CopyPanel({ def, change }: { def: FormDefinition; change: Change }) {
  const set = (key: keyof FormDefinition["copy"]) => (value: string) => change((draft) => void (draft.copy[key] = value));
  return (
    <Panel title="Page words" description='"{role}" and "{company}" are filled in for each role.'>
      <Text label="Title" value={def.copy.title} max={FORM_LIMITS.title} onChange={set("title")} />
      <Text label="Introduction" area value={def.copy.intro} max={FORM_LIMITS.intro} onChange={set("intro")} />
      <Text label="Submit button" value={def.copy.submitLabel} max={FORM_LIMITS.button} onChange={set("submitLabel")} />
      <Text label="After submitting: title" value={def.copy.thankYouTitle} max={FORM_LIMITS.title} onChange={set("thankYouTitle")} />
      <Text label="After submitting: text" area value={def.copy.thankYouBody} max={FORM_LIMITS.intro} onChange={set("thankYouBody")} />
    </Panel>
  );
}

export function EmailPanel({ def, change }: { def: FormDefinition; change: Change }) {
  const standard = !def.invitation.subject && !def.invitation.body;
  return (
    <Panel title="Invitation email" description="The email that sends an applicant their private link to this form. Recruiter adds who it's from and how to stop emails at the end.">
      <Toggle
        label="Use Recruiter's standard wording"
        hint="It thanks them for applying, names the role and the job board they came from, and gives the link."
        checked={standard}
        onChange={(value) =>
          change((draft) => {
            draft.invitation = value ? { subject: "", body: "" } : { subject: "Next step for your {role} application at {company}", body: "Hi {first_name},\n\nThank you for your interest in the {role} position at {company}.\n\nPlease complete our application here:\n{link}\n\nIt takes about five minutes, and your answers are saved as you go." };
          })
        }
      />
      {!standard ? (
        <>
          <Text label="Subject" value={def.invitation.subject} max={FORM_LIMITS.subject} onChange={(value) => change((draft) => void (draft.invitation.subject = value))} />
          <Text label="Email" area hint='Use {first_name}, {role} and {company}. "{link}" is where the link goes and must be in the email.' value={def.invitation.body} max={FORM_LIMITS.body} onChange={(value) => change((draft) => void (draft.invitation.body = value))} />
          {!def.invitation.body.includes("{link}") ? <Notice tone="warning" title="Add {link}">The email needs {"{link}"} where the application link goes.</Notice> : null}
        </>
      ) : null}
    </Panel>
  );
}
