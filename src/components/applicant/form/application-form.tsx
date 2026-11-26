"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { Action, Card, Notice, Problem, Row } from "@/components/cleaner/shell";
import { Checkbox } from "@/components/ui/selection";
import { cn } from "@/lib/utils";

import { knockedOut } from "../../../../convex/lib/recruiter/formDefinition";
import { missingRequired, visibleFields, type Field, type Section } from "../../../../convex/lib/recruiter/form";
import { answerText, FieldInput, type Answer, type Answers, type FileControls } from "./fields";

export type Look = {
  display: "one_at_a_time" | "sections";
  accentColor: string;
  logoUrl: string | null;
  companyName: string;
  copy: { title: string; intro: string; submitLabel: string; thankYouTitle: string; thankYouBody: string };
};

/** The page around a form: the company's logo and name, the form's title, in the form's accent color. */
export function ApplyFrame({ look, children, wide }: { look: Pick<Look, "accentColor" | "logoUrl" | "companyName"> & { title: string }; children: ReactNode; wide?: boolean }) {
  return (
    <main style={{ "--apply-accent": look.accentColor } as CSSProperties} className={cn("mx-auto flex min-h-dvh w-full flex-col gap-4 px-4 pt-5 pb-28", wide ? "max-w-2xl" : "max-w-md")}>
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {look.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={look.logoUrl} alt="" className="size-8 rounded-lg object-contain" />
          ) : (
            <span aria-hidden className="size-2.5 rounded-full bg-[var(--apply-accent)]" />
          )}
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase" data-testid="company">
            {look.companyName}
          </p>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{look.title}</h1>
      </header>
      {children}
    </main>
  );
}

type Step = { kind: "section"; section: Section; fields: Field[] } | { kind: "field"; field: Field; section: Section | undefined } | { kind: "review" };

function stepsOf(display: Look["display"], fields: Field[], sections: Section[]): Step[] {
  const out: Step[] = [];
  for (const section of sections) {
    const mine = fields.filter((field) => field.section === section.id);
    if (mine.length === 0) continue;
    if (display === "sections") out.push({ kind: "section", section, fields: mine });
    else for (const field of mine) out.push({ kind: "field", field, section });
  }
  return [...out, { kind: "review" }];
}

const stepFields = (step: Step): Field[] => (step.kind === "section" ? step.fields : step.kind === "field" ? [step.field] : []);
const stepKey = (step: Step) => (step.kind === "section" ? `s:${step.section.id}` : step.kind === "field" ? `f:${step.field.key}` : "review");

const GATE_FALLBACK = "With this answer, we can't move forward with an application for this role.";

/**
 * An application form, as an applicant fills it in. It reads and writes nothing itself: the page that
 * holds it saves, uploads and submits. The builder's preview holds it with nothing behind it.
 */
export function ApplicationForm(props: {
  look: Look;
  greeting?: string | null;
  about?: { location: string; availability: string } | null;
  fields: Field[];
  sections: Section[];
  answers: Answers;
  onAnswer: (key: string, value: Answer | undefined) => void;
  files?: FileControls;
  /** No file question on the form: offer the general "resume or supporting files" box on the review step, as before. */
  generalFiles?: boolean;
  attestation: string;
  /** Saves before moving on. Resolves false when it didn't go through. */
  onContinue: () => Promise<boolean>;
  onSaveLater?: () => void;
  onSubmit: (attested: boolean) => void;
  busy: string | null;
  problem: string | null;
  saved: boolean;
  footer?: ReactNode;
  /** The builder's preview: show the step holding this field or section. `n` changes to jump again. */
  jumpTo?: { key: string; n: number } | null;
}) {
  const { look, fields, answers } = props;
  const shown = visibleFields(fields, answers);
  const steps = stepsOf(look.display, shown, props.sections);
  const [index, setIndex] = useState(0);
  const [jumped, setJumped] = useState<number | null>(null);
  if (props.jumpTo && props.jumpTo.n !== jumped) {
    setJumped(props.jumpTo.n);
    const key = props.jumpTo.key;
    const target = steps.findIndex((step) => (step.kind === "section" && (step.section.id === key || step.fields.some((field) => field.key === key))) || (step.kind === "field" && (step.field.key === key || step.section?.id === key)));
    if (target >= 0) setIndex(target);
  }
  const [gate, setGate] = useState<{ key: string; message: string } | null>(null);
  const [passed, setPassed] = useState<Set<string>>(new Set());
  const [attested, setAttested] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const at = Math.min(index, steps.length - 1);
  const step = steps[at];
  const current = stepFields(step);
  const missingHere = missingRequired(current, answers).filter((field) => current.includes(field));
  const missingAll = missingRequired(fields, answers);
  const oneAtATime = look.display === "one_at_a_time";
  const working = props.busy !== null;

  const next = async () => {
    if (missingHere.length > 0 || working) return;
    const blocked = current.find((field) => field.knockout?.outcome === "gate" && knockedOut(field.knockout, answers[field.key]) && !passed.has(`${field.key}:${String(answers[field.key])}`));
    if (blocked) {
      setGate({ key: `${blocked.key}:${String(answers[blocked.key])}`, message: blocked.knockout!.message || GATE_FALLBACK });
      return;
    }
    if (await props.onContinue()) setIndex(at + 1);
  };

  // One question at a time: Enter continues and a choice's letter picks it, as long as the applicant isn't typing.
  useEffect(() => {
    if (!oneAtATime) return;
    const onKey = (event: KeyboardEvent) => {
      const node = container.current;
      const target = event.target as HTMLElement | null;
      if (!node || (target && target !== document.body && !node.contains(target))) return;
      const typing = target && (target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "checkbox"));
      if (event.key === "Enter" && !event.shiftKey && target?.tagName !== "TEXTAREA" && target?.tagName !== "BUTTON") {
        event.preventDefault();
        node.querySelector<HTMLButtonElement>("[data-testid='next']")?.click();
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
      node.querySelector<HTMLButtonElement>(`[data-letter='${event.key.toUpperCase()}']`)?.click();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [oneAtATime]);

  if (gate) {
    return (
      <div className="flex flex-col gap-4" data-testid="gate">
        <Notice tone="warn" title="Before you go on">
          <span className="whitespace-pre-line">{gate.message}</span>
        </Notice>
        <Action onPress={() => setGate(null)} testId="gate-change">
          Change my answer
        </Action>
        <Action
          kind="secondary"
          onPress={async () => {
            setPassed(new Set([...passed, gate.key]));
            setGate(null);
            if (await props.onContinue()) setIndex(at + 1);
          }}
          testId="gate-continue"
        >
          Continue with this answer
        </Action>
        <p className="text-xs text-muted-foreground">If you continue, your application is still sent and a person at {look.companyName} reads it.</p>
      </div>
    );
  }

  const total = steps.length;
  return (
    <div ref={container} className="flex flex-col gap-4" key={stepKey(step)}>
      {at === 0 && (look.copy.intro || props.greeting || props.about) ? (
        <Card>
          {look.copy.intro || props.greeting ? (
            <p className="text-sm">
              {props.greeting ? `Hi ${props.greeting}. ` : ""}
              {look.copy.intro}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">Nothing is sent to the hiring team until you submit on the last step.</p>
          {props.about ? (
            <>
              <Row label="Where">{props.about.location}</Row>
              <Row label="Availability needed">{props.about.availability}</Row>
            </>
          ) : null}
        </Card>
      ) : null}

      {oneAtATime ? (
        <div className="flex flex-col gap-1.5" aria-hidden>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-[var(--apply-accent)] transition-[width] motion-reduce:transition-none" style={{ width: `${Math.round(((at + (step.kind === "review" ? 1 : 0)) / total) * 100)}%` }} />
          </div>
        </div>
      ) : null}
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase" data-testid="step">
        {step.kind === "review" ? "Review and submit" : step.kind === "section" ? `Step ${at + 1} of ${total}: ${step.section.title}` : `${at + 1} of ${total - 1}${step.section ? ` · ${step.section.title}` : ""}`}
      </p>

      {step.kind === "review" ? (
        <>
          <Card title="Check your answers">
            {shown
              .filter((field) => field.kind !== "statement" && field.key !== "smsConsent")
              .map((field) =>
                field.label.length > 48 ? (
                  <div key={field.key} className="flex flex-col gap-0.5 text-sm">
                    <span className="text-muted-foreground">{field.label}</span>
                    <span className="font-medium" data-testid={`review-${field.key}`}>
                      {answerText(field, answers[field.key])}
                    </span>
                  </div>
                ) : (
                  <Row key={field.key} label={field.label}>
                    <span data-testid={`review-${field.key}`}>{answerText(field, answers[field.key])}</span>
                  </Row>
                ),
              )}
            {shown.some((field) => field.key === "smsConsent") ? <Row label="May we text you about this application?">{answers.smsConsent === true ? "Yes" : "No"}</Row> : null}
          </Card>
          {props.generalFiles && props.files ? <GeneralFiles files={props.files} /> : null}
          {missingAll.length > 0 ? (
            <Notice tone="warn" title="Some required questions are not answered" testId="missing">
              {missingAll.map((field) => field.label).join("; ")}
            </Notice>
          ) : null}
          <label className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4 text-sm">
            <Checkbox data-testid="attest" className="mt-1 shrink-0" checked={attested} onCheckedChange={(checked) => setAttested(checked)} />
            <span>{props.attestation}</span>
          </label>
        </>
      ) : step.kind === "section" ? (
        <Card title={step.section.title}>
          {step.section.description ? <p className="text-sm text-muted-foreground">{step.section.description}</p> : null}
          {step.fields.map((field) => (
            <FieldInput key={field.key} field={field} value={answers[field.key]} onChange={(value) => props.onAnswer(field.key, value)} files={props.files} />
          ))}
        </Card>
      ) : (
        <div className="flex min-h-56 flex-col justify-center gap-3 py-4">
          <FieldInput field={step.field} value={answers[step.field.key]} onChange={(value) => props.onAnswer(step.field.key, value)} large files={props.files} />
        </div>
      )}

      <Problem message={props.problem} />
      {props.saved ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="saved">
          Saved. You can close this page and come back with the same link.
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        {step.kind === "review" ? (
          <Action busy={props.busy === "submit"} disabled={working || !attested || missingAll.length > 0} onPress={() => props.onSubmit(attested)} testId="submit">
            {look.copy.submitLabel}
          </Action>
        ) : (
          <Action busy={props.busy === "save"} disabled={working || missingHere.length > 0} onPress={() => void next()} testId="next">
            {oneAtATime ? "Continue" : "Save and continue"}
          </Action>
        )}
        {step.kind !== "review" && missingHere.length > 0 ? <p className="text-xs text-muted-foreground">Answer the questions marked * to continue.</p> : null}
        {oneAtATime && step.kind === "field" && missingHere.length === 0 ? <p className="hidden text-xs text-muted-foreground sm:block">Press Enter to continue.</p> : null}
        <div className="flex gap-2">
          {at > 0 ? (
            <Action kind="secondary" disabled={working} onPress={() => setIndex(at - 1)} testId="back">
              Back
            </Action>
          ) : null}
          {props.onSaveLater ? (
            <Action kind="secondary" busy={props.busy === "save" && step.kind === "review"} disabled={working} onPress={props.onSaveLater} testId="save-later">
              Save for later
            </Action>
          ) : null}
        </div>
        {props.footer}
      </div>
    </div>
  );
}

function GeneralFiles({ files }: { files: FileControls }) {
  const input = useRef<HTMLInputElement>(null);
  const general: Field = { key: "resume", label: "Resume or supporting files", kind: "file", required: false, section: "review", options: ["resume"] };
  return (
    <Card title="Resume or supporting files (optional)">
      {files.files.map((file) => (
        <div key={file.attachmentId} className="flex items-center justify-between gap-3 text-sm">
          <span className="truncate">{file.fileName}</span>
          <button type="button" className="shrink-0 text-red-600 underline" disabled={files.busy} onClick={() => files.onRemove(file.attachmentId)}>
            Remove
          </button>
        </div>
      ))}
      {files.canAdd ? (
        <>
          <input
            ref={input}
            type="file"
            className="hidden"
            data-testid="file-input"
            accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) files.onUpload(general, file);
            }}
          />
          <Action kind="secondary" busy={files.busy} disabled={files.busy} onPress={() => input.current?.click()}>
            Add a file
          </Action>
          <p className="text-xs text-muted-foreground">PDF, Word, text, JPG or PNG, up to 10 MB. Please do not upload ID documents, bank details or tax forms.</p>
        </>
      ) : null}
    </Card>
  );
}
