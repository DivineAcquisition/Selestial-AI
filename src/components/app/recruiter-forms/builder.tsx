"use client";

/**
 * The application form builder. Left: the form's sections and questions, and its settings. Center: the
 * form as an applicant sees it, drawn by the same component as the live page, with nothing saved or sent.
 * Right: the controls for what is selected.
 *
 * Edits are kept on screen and saved after a short pause. A save names the revision it started from; if
 * someone else saved meanwhile, the person chooses: load theirs, or save theirs over. Undo and redo work
 * within this visit. Applicants see only what the Owner publishes.
 */
import { ArrowArcLeft, ArrowArcRight, ArrowLeft, ClockCounterClockwise, DesktopTower, DeviceMobile, Envelope, Eye, Lightning, ListBullets, Palette, Plus, Rocket, ShareNetwork, TextAa } from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApplicationForm, ApplyFrame, type Look } from "@/components/applicant/form/application-form";
import type { Answer, Answers } from "@/components/applicant/form/fields";
import { useCompany } from "@/components/app/company";
import { Field, FormError, messageOf, TextInput, useRun } from "@/components/app/form";
import { Modal } from "@/components/app/modal";
import { Notice } from "@/components/app/services/shared";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button-variants";
import { RadioButtonGroup } from "@/components/ui/selection";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ATTEST_WORDING, fieldsFor, sectionsFor } from "../../../../convex/lib/recruiter/form";
import { answerKey, fill, FIELD_KIND_LABELS, type FormDefinition } from "../../../../convex/lib/recruiter/formDefinition";
import { CopyPanel, EmailPanel, FieldPanel, LookPanel, SectionPanel, uid, type Catalog } from "./inspector";
import { SendApplicationDialog } from "./send-dialog";
import { CopyButton, Snippets } from "./share";

export const FORMS_ROOT = "/app/agents/recruiter/forms";

type SaveState = { kind: "saved" } | { kind: "unsaved" } | { kind: "saving" } | { kind: "error"; message: string } | { kind: "conflict"; savedBy: string; savedAt: number; revision: number };

export function FormBuilder({ formId }: { formId: Id<"applicationForms"> }) {
  const { companyId, role } = useCompany();
  const data = useQuery(api.applicationForms.get, { companyId, formId });
  const saveDraft = useMutation(api.applicationForms.saveDraft);
  const [edits, setEdits] = useState<{ draft: FormDefinition; revision: number } | null>(null);
  const [past, setPast] = useState<FormDefinition[]>([]);
  const [future, setFuture] = useState<FormDefinition[]>([]);
  const [save, setSave] = useState<SaveState>({ kind: "saved" });
  const [selected, setSelected] = useState<string>("look");
  const [jump, setJump] = useState<{ key: string; n: number } | null>(null);
  const [device, setDevice] = useState<"desktop" | "mobile">("mobile");
  const [pane, setPane] = useState<"edit" | "preview">("edit");
  const [modal, setModal] = useState<null | "publish" | "history" | "send">(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [previewKey, setPreviewKey] = useState(0);
  const canEdit = role === "owner" || role === "manager";
  const timer = useRef<number | null>(null);
  const latest = useRef<{ draft: FormDefinition | null; revision: number }>({ draft: null, revision: 0 });
  const serverRevision = data?.form.draftRevision ?? 0;
  const useLocal = edits !== null && (save.kind !== "saved" || edits.revision >= serverRevision);
  const draft: FormDefinition | null = useLocal ? edits.draft : ((data?.draft as FormDefinition | undefined) ?? null);
  const revision = useLocal ? edits.revision : serverRevision;

  const flush = useCallback(
    async (force = false) => {
      const current = latest.current;
      if (!current.draft) return;
      setSave({ kind: "saving" });
      try {
        const result = await saveDraft({ companyId, formId, expectedRevision: current.revision, definition: current.draft, force });
        if (!result.ok) {
          setSave({ kind: "conflict", savedBy: result.conflict.savedBy, savedAt: result.conflict.savedAt, revision: result.conflict.revision });
          return;
        }
        latest.current = { draft: current.draft, revision: result.revision };
        setEdits((e) => (e ? { draft: e.draft, revision: result.revision } : e));
        setSave((s) => (s.kind === "saving" ? { kind: "saved" } : s));
      } catch (error) {
        setSave({ kind: "error", message: messageOf(error) });
      }
    },
    [companyId, formId, saveDraft],
  );

  const commit = useCallback(
    (next: FormDefinition, record = true) => {
      if (record && draft) {
        setPast((p) => [...p.slice(-49), draft]);
        setFuture([]);
      }
      const base = edits && (save.kind !== "saved" || edits.revision >= serverRevision) ? edits.revision : serverRevision;
      setEdits({ draft: next, revision: base });
      latest.current = { draft: next, revision: base };
      setSave({ kind: "unsaved" });
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), 800);
    },
    [draft, edits, save.kind, serverRevision, flush],
  );

  const change = useCallback(
    (mutate: (d: FormDefinition) => void) => {
      if (!draft || !canEdit) return;
      const next = structuredClone(draft);
      mutate(next);
      commit(next);
    },
    [draft, canEdit, commit],
  );

  const undo = useCallback(() => {
    if (!past.length || !draft) return;
    const previous = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [draft, ...f]);
    commit(previous, false);
  }, [past, draft, commit]);
  const redo = useCallback(() => {
    if (!future.length || !draft) return;
    const [nextDraft, ...rest] = future;
    setFuture(rest);
    setPast((p) => [...p, draft]);
    commit(nextDraft, false);
  }, [future, draft, commit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (save.kind === "unsaved" || save.kind === "saving" || save.kind === "conflict" || save.kind === "error") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [save.kind]);

  const sample = data?.sample;
  const companyName = data?.brand.companyName ?? "";
  const fields = useMemo(() => (draft && sample ? fieldsFor(draft, sample, companyName) : []), [draft, sample, companyName]);
  const sections = useMemo(() => (draft && sample ? sectionsFor(draft, sample) : []), [draft, sample]);

  const select = (id: string, key?: string) => {
    setSelected(id);
    if (key) setJump((j) => ({ key, n: (j?.n ?? 0) + 1 }));
    setPane("edit");
  };

  if (data === undefined || draft === null || !sample) return <BuilderSkeleton />;
  const catalog = data.catalog as Catalog;
  const values = { role: sample.title, company: companyName };
  const look: Look = {
    display: draft.display,
    accentColor: draft.theme.useCompanyBrand ? data.brand.brandColor : draft.theme.accentColor,
    logoUrl: draft.theme.showLogo ? data.brand.logoUrl : null,
    companyName,
    copy: { title: fill(draft.copy.title, values), intro: fill(draft.copy.intro, values), submitLabel: draft.copy.submitLabel || "Submit application", thankYouTitle: fill(draft.copy.thankYouTitle, values), thankYouBody: fill(draft.copy.thankYouBody, values) },
  };
  const selection = selected.split(":");
  const sectionIndex = selection[0] === "section" || selection[0] === "field" ? draft.sections.findIndex((row) => row.id === selection[1]) : -1;
  const fieldIndex = selection[0] === "field" && sectionIndex >= 0 ? draft.sections[sectionIndex].fields.findIndex((row) => row.id === selection[2]) : -1;
  const status = data.form.publishedVersion ? (data.form.draftDiffers ? { label: "Published · draft has changes", variant: "warning" as const } : { label: "Published", variant: "success" as const }) : { label: "Draft", variant: "outline" as const };

  return (
    <div className="grid gap-3">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Link href={FORMS_ROOT} aria-label="All application forms" className={buttonVariants({ variant: "ghost", size: "icon-sm" })}>
            <ArrowLeft aria-hidden />
          </Link>
          <NameField key={data.form.name} formId={formId} name={data.form.name} disabled={!canEdit} />
          <Badge variant={status.variant}>{status.label}</Badge>
          {data.form.isDefault ? <Badge variant="info">Default</Badge> : null}
          {data.form.publishedVersion ? <span className="hidden text-xs text-muted-foreground md:inline">v{data.form.publishedVersion} live</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <SaveStatus save={save} savedBy={data.form.draftSavedBy} savedAt={data.form.draftSavedAt} />
          <button type="button" onClick={undo} disabled={!past.length} aria-label="Undo" title="Undo (Ctrl+Z)" className={buttonVariants({ variant: "ghost", size: "icon-sm" })}>
            <ArrowArcLeft aria-hidden />
          </button>
          <button type="button" onClick={redo} disabled={!future.length} aria-label="Redo" title="Redo (Ctrl+Shift+Z)" className={buttonVariants({ variant: "ghost", size: "icon-sm" })}>
            <ArrowArcRight aria-hidden />
          </button>
          <RadioButtonGroup aria-label="Preview size" className="hidden rounded-lg border border-border p-0.5 sm:flex">
            {(["desktop", "mobile"] as const).map((d) => (
              <button key={d} type="button" role="radio" aria-checked={device === d} aria-label={d === "desktop" ? "Desktop preview" : "Mobile preview"} onClick={() => setDevice(d)} className={cn("grid h-7 w-8 place-items-center rounded-md", device === d ? "bg-brand-500/10 text-strong" : "text-muted-foreground")}>
                {d === "desktop" ? <DesktopTower aria-hidden className="size-4" /> : <DeviceMobile aria-hidden className="size-4" />}
              </button>
            ))}
          </RadioButtonGroup>
          {canEdit ? (
            <button type="button" onClick={() => setModal("send")} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <Envelope aria-hidden /> Send application
            </button>
          ) : null}
          <button type="button" onClick={() => setModal("history")} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <ClockCounterClockwise aria-hidden /> History
          </button>
          {role === "owner" ? (
            <button type="button" onClick={() => setModal("publish")} disabled={save.kind === "saving"} className={buttonVariants({ variant: "primary", size: "sm" })}>
              <Rocket aria-hidden /> Publish
            </button>
          ) : null}
        </div>
      </header>

      {save.kind === "conflict" ? (
        <Notice tone="warning" title={`${save.savedBy} saved this form ${new Date(save.savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`}>
          Your edits are still on screen.
          <span className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={buttonVariants({ variant: "outline", size: "sm" })} onClick={() => { setSave({ kind: "saved" }); setEdits(null); }}>
              Load their version
            </button>
            <button type="button" className={buttonVariants({ variant: "secondary", size: "sm" })} onClick={() => void flush(true)}>
              Save mine over theirs
            </button>
          </span>
        </Notice>
      ) : null}
      {save.kind === "error" ? <FormError message={`Not saved: ${save.message}`} /> : null}
      {!canEdit ? <Notice tone="info" title="View only">Managers and the Owner change application forms. You can look around.</Notice> : null}
      {canEdit && role !== "owner" && data.form.draftDiffers ? <Notice tone="info" title="Your changes are saved as a draft">Applicants see them once the Owner publishes.</Notice> : null}

      <div role="tablist" aria-label="Builder" className="flex gap-1 rounded-lg border border-border p-0.5 @5xl/main:hidden">
        {(["edit", "preview"] as const).map((p) => (
          <button key={p} type="button" role="tab" aria-selected={pane === p} onClick={() => setPane(p)} className={cn("h-9 flex-1 rounded-md text-sm font-medium", pane === p ? "bg-brand-500/10 text-strong" : "text-muted-foreground")}>
            {p === "edit" ? "Edit" : "Preview"}
          </button>
        ))}
      </div>

      <div className="grid gap-3 @5xl/main:grid-cols-[260px_minmax(0,1fr)_360px]">
        <nav aria-label="Form sections and settings" className={cn("space-y-4 rounded-2xl border border-border bg-card p-3 @5xl/main:max-h-[calc(100dvh-170px)] @5xl/main:overflow-y-auto", pane === "preview" && "@max-5xl/main:hidden")}>
          <RailGroup title="Form">
            <RailItem active={selected === "look"} onClick={() => select("look")} icon={<Palette aria-hidden className="size-4" />} label="Layout and look" />
            <RailItem active={selected === "copy"} onClick={() => select("copy")} icon={<TextAa aria-hidden className="size-4" />} label="Page words" />
            <RailItem active={selected === "email"} onClick={() => select("email")} icon={<Envelope aria-hidden className="size-4" />} label="Invitation email" hint={draft.invitation.body ? "Custom" : "Standard"} />
            <RailItem active={selected === "share"} onClick={() => select("share")} icon={<ShareNetwork aria-hidden className="size-4" />} label="Share and send" />
          </RailGroup>
          <div>
            <p className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Questions</p>
            <ol className="space-y-2">
              {draft.sections.map((section) => (
                <li key={section.id} className="rounded-xl border border-border">
                  <button type="button" onClick={() => select(`section:${section.id}`, section.id)} aria-current={selected === `section:${section.id}` ? "true" : undefined} className={cn("flex w-full items-center gap-2 rounded-t-xl px-2.5 py-2 text-left text-sm font-medium", selected === `section:${section.id}` ? "bg-brand-500/10 text-strong" : "text-strong hover:bg-muted")}>
                    <ListBullets aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{section.title || "Untitled section"}</span>
                    <span className="text-[11px] font-normal text-muted-foreground">{section.fields.length}</span>
                  </button>
                  <ul className="space-y-0.5 px-1 pb-1">
                    {section.fields.map((field) => (
                      <li key={field.id}>
                        <button type="button" onClick={() => select(`field:${section.id}:${field.id}`, answerKey(field))} aria-current={selected === `field:${section.id}:${field.id}` ? "true" : undefined} className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]", selected === `field:${section.id}:${field.id}` ? "bg-brand-500/10 font-medium text-strong" : "text-muted-foreground hover:bg-muted hover:text-strong")}>
                          <span className="min-w-0 flex-1 truncate">
                            {field.label}
                            {field.required ? " *" : ""}
                          </span>
                          {field.knockout ? <Lightning aria-label="Ends the application on an answer" className="size-3.5 shrink-0 text-warning-foreground" /> : null}
                          {field.showIf ? <span className="shrink-0 text-[10px] text-muted-foreground">if</span> : null}
                          <span className="sr-only">{FIELD_KIND_LABELS[field.kind]}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
            {canEdit ? (
              <button
                type="button"
                onClick={() => {
                  const id = uid("section");
                  change((d) => void d.sections.push({ id, title: "New section", description: "", fields: [] }));
                  select(`section:${id}`);
                }}
                className={cn(buttonVariants({ variant: "outline", size: "xs" }), "mt-2")}
              >
                <Plus aria-hidden /> Add a section
              </button>
            ) : null}
            {sample.questions.length ? <p className="mt-2 px-1 text-xs text-muted-foreground">The role&apos;s own questions ({sample.questions.length}) come last. Change them in Hiring setup.</p> : null}
          </div>
        </nav>

        <section aria-label="Applicant preview" className={cn("min-w-0 rounded-2xl border border-border bg-muted/40 p-2", pane === "edit" && "@max-5xl/main:hidden")}>
          <div className="mb-2 flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Eye aria-hidden className="size-3.5" /> Preview for {sample.title} · nothing is saved or sent
            </span>
            <button type="button" onClick={() => { setAnswers({}); setPreviewKey((k) => k + 1); }} className="font-medium text-brand-300 hover:underline">
              Start over
            </button>
          </div>
          <div className={cn("mx-auto h-[calc(100vh-215px)] min-h-[560px] overflow-y-auto overflow-x-hidden rounded-xl border border-border bg-background shadow-sm", device === "mobile" ? "max-w-[400px]" : "w-full")}>
            <ApplyFrame look={{ ...look, title: look.copy.title }} wide={device === "desktop"}>
              <ApplicationForm
                key={previewKey}
                look={look}
                about={null}
                fields={fields}
                sections={sections}
                answers={answers}
                onAnswer={(key: string, value: Answer | undefined) =>
                  setAnswers((before) => {
                    const next = { ...before };
                    if (value === undefined) delete next[key];
                    else next[key] = value;
                    return next;
                  })
                }
                attestation={ATTEST_WORDING}
                onContinue={async () => true}
                onSubmit={() => setModal(null)}
                busy={null}
                problem={null}
                saved={false}
                jumpTo={jump}
              />
            </ApplyFrame>
          </div>
        </section>

        <aside aria-label="Controls" className={cn("rounded-2xl border border-border bg-card p-4 @5xl/main:max-h-[calc(100dvh-170px)] @5xl/main:overflow-y-auto", pane === "preview" && "@max-5xl/main:hidden")}>
          <fieldset disabled={!canEdit} className="min-w-0">
            {selected === "look" ? (
              <LookPanel def={draft} change={change} catalog={catalog} brandColor={data.brand.brandColor} />
            ) : selected === "copy" ? (
              <CopyPanel def={draft} change={change} />
            ) : selected === "email" ? (
              <EmailPanel def={draft} change={change} />
            ) : selected === "share" ? (
              <SharePanel roles={data.roles} careersUrl={data.careersUrl} published={data.form.publishedVersion !== null} onSend={() => setModal("send")} canSend={canEdit} />
            ) : selection[0] === "section" ? (
              <SectionPanel def={draft} change={change} sectionIndex={sectionIndex} catalog={catalog} onSelectField={(sectionId, fieldId) => select(`field:${sectionId}:${fieldId}`)} onRemoved={() => select("look")} />
            ) : (
              <FieldPanel def={draft} change={change} sectionIndex={sectionIndex} fieldIndex={fieldIndex} catalog={catalog} onRemoved={() => select(sectionIndex >= 0 ? `section:${draft.sections[sectionIndex].id}` : "look")} />
            )}
          </fieldset>
        </aside>
      </div>

      <PublishModal open={modal === "publish"} onClose={() => setModal(null)} formId={formId} revision={revision} dirty={save.kind !== "saved"} isDefault={data.form.isDefault} published={data.form.publishedVersion !== null} archived={data.form.archived} />
      <HistoryModal open={modal === "history"} onClose={() => setModal(null)} formId={formId} versions={data.versions} revision={revision} canPublish={role === "owner"} canDraft={canEdit} onRestored={() => { setSave({ kind: "saved" }); setEdits(null); }} />
      <SendApplicationDialog open={modal === "send"} onClose={() => setModal(null)} roles={data.roles.filter((row) => row.status === "open").map((row) => ({ id: row.id, title: row.title }))} />
    </div>
  );
}

function SharePanel({ roles, careersUrl, published, onSend, canSend }: { roles: { id: Id<"hiringNeeds">; title: string; status: string; publicApply: boolean; url: string | null }[]; careersUrl: string | null; published: boolean; onSend: () => void; canSend: boolean }) {
  return (
    <section className="space-y-4">
      <header>
        <h3 className="font-heading text-base tracking-tight text-strong">Share and send</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">Two ways in: a private link you email to each applicant, or a public page anyone can open from your website.</p>
      </header>
      {!published ? <Notice tone="warning" title="Not published yet">Applicants see this form once the Owner publishes it.</Notice> : null}
      <div className="space-y-2 rounded-xl border border-border p-3">
        <p className="text-sm font-medium text-strong">Email it to applicants</p>
        <p className="text-sm text-muted-foreground">Each person gets their own private link. Their answers save as they go, and reminders follow your Playbook.</p>
        {canSend ? (
          <button type="button" onClick={onSend} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Envelope aria-hidden /> Send application
          </button>
        ) : null}
      </div>
      <div className="space-y-3 rounded-xl border border-border p-3">
        <p className="text-sm font-medium text-strong">Public application page</p>
        {!careersUrl ? (
          <Notice tone="warning" title="Choose your public address first">Your company&apos;s public address is set in Booking rules, and is shared by booking and application pages.</Notice>
        ) : (
          <>
            <Field label="Careers page (every role open to the public)">
              <TextInput readOnly value={careersUrl} onFocus={(e) => e.target.select()} />
            </Field>
            <CopyButton value={careersUrl} label="Copy link" />
          </>
        )}
        {roles.length === 0 ? <p className="text-sm text-muted-foreground">No role uses this form yet. Choose it for a role in Application forms.</p> : null}
        {roles.map((role) => (
          <div key={role.id} className="space-y-2 border-t border-border pt-3">
            <p className="flex items-center justify-between gap-2 text-sm">
              <span className="font-medium text-strong">{role.title}</span>
              <Badge variant={role.publicApply && role.status === "open" ? "success" : "outline"} size="sm">
                {role.publicApply ? (role.status === "open" ? "Public" : `Public when open`) : "Link only"}
              </Badge>
            </p>
            {role.publicApply && role.url ? <Snippets url={role.url} /> : <p className="text-xs text-muted-foreground">Turn on the public page for this role in Application forms.</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

function BuilderSkeleton() {
  return (
    <div className="grid gap-3" aria-busy="true">
      <div className="h-14 animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" />
      <div className="grid gap-3 @5xl/main:grid-cols-[260px_1fr_360px]">
        <div className="h-[560px] animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" />
        <div className="h-[560px] animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" />
        <div className="h-[560px] animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" />
      </div>
    </div>
  );
}

function RailGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function RailItem({ active, onClick, icon, label, hint }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; hint?: string }) {
  return (
    <li>
      <button type="button" onClick={onClick} aria-current={active ? "true" : undefined} className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors", active ? "bg-brand-500/10 font-medium text-strong" : "text-muted-foreground hover:bg-muted hover:text-strong")}>
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {hint ? <span className="shrink-0 text-[11px] text-muted-foreground">{hint}</span> : null}
      </button>
    </li>
  );
}

function SaveStatus({ save, savedBy, savedAt }: { save: SaveState; savedBy: string; savedAt: number }) {
  const words = save.kind === "saving" ? "Saving…" : save.kind === "unsaved" ? "Unsaved changes" : save.kind === "conflict" || save.kind === "error" ? "Not saved" : `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${savedBy ? ` · ${savedBy}` : ""}`;
  return (
    <span role="status" aria-live="polite" className={cn("hidden max-w-[220px] truncate px-1 text-xs md:inline", save.kind === "conflict" || save.kind === "error" ? "text-destructive-foreground" : "text-muted-foreground")}>
      {words}
    </span>
  );
}

function NameField({ formId, name, disabled }: { formId: Id<"applicationForms">; name: string; disabled: boolean }) {
  const { companyId } = useCompany();
  const rename = useMutation(api.applicationForms.rename);
  const [value, setValue] = useState(name);
  return (
    <input
      aria-label="Form name"
      value={value}
      disabled={disabled}
      maxLength={80}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value.trim() && value !== name && void rename({ companyId, formId, name: value }).catch(() => setValue(name))}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="min-w-0 max-w-[260px] rounded-md bg-transparent px-1.5 py-1 font-heading text-base font-medium tracking-tight text-strong outline-none hover:bg-muted focus:bg-muted focus-visible:outline-2 focus-visible:outline-brand-500/40"
    />
  );
}

function PublishModal({ open, onClose, formId, revision, dirty, isDefault, published, archived }: { open: boolean; onClose: () => void; formId: Id<"applicationForms">; revision: number; dirty: boolean; isDefault: boolean; published: boolean; archived: boolean }) {
  const { companyId } = useCompany();
  const publish = useMutation(api.applicationForms.publish);
  const setDefault = useMutation(api.applicationForms.setDefault);
  const archive = useMutation(api.applicationForms.archive);
  const { busy, error, run } = useRun();
  const [note, setNote] = useState("");
  const [done, setDone] = useState<number | null>(null);
  const router = useRouter();
  return (
    <Modal open={open} onClose={onClose} title="Publish this form" description="Applicants see the published version. Anyone already filling in the form keeps the version they started on.">
      <div className="space-y-4">
        {done ? <Notice tone="success" title={`Version ${done} is live.`}>New applicants see it now.</Notice> : null}
        {dirty ? <Notice tone="warning" title="Wait for your changes to save">The draft is still saving.</Notice> : null}
        <Field label="What changed (optional)">
          <TextInput value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <FormError message={error} />
        <div className="flex flex-wrap justify-between gap-2">
          <span className="flex gap-2">
            {!isDefault && (published || done) ? (
              <button type="button" disabled={busy} onClick={() => void run(async () => { await setDefault({ companyId, formId }); onClose(); })} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Make it the default
              </button>
            ) : null}
            {!isDefault ? (
              <button type="button" disabled={busy} onClick={() => void run(async () => { await archive({ companyId, formId, archived: !archived }); if (!archived) router.push(FORMS_ROOT); onClose(); })} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                {archived ? "Restore" : "Archive"}
              </button>
            ) : null}
          </span>
          <button type="button" disabled={busy || dirty} onClick={() => void run(async () => { const r = await publish({ companyId, formId, expectedRevision: revision, note: note || undefined }); setDone(r.version); })} className={buttonVariants({ variant: "primary", size: "sm" })}>
            <Rocket aria-hidden /> {busy ? "Publishing…" : "Publish now"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function HistoryModal({ open, onClose, formId, versions, revision, canPublish, canDraft, onRestored }: { open: boolean; onClose: () => void; formId: Id<"applicationForms">; versions: { version: number; publishedAt: number; publishedBy: string; note: string | null; restoredFrom: number | null; current: boolean }[]; revision: number; canPublish: boolean; canDraft: boolean; onRestored: () => void }) {
  const { companyId } = useCompany();
  const rollback = useMutation(api.applicationForms.rollback);
  const restore = useMutation(api.applicationForms.restoreToDraft);
  const { busy, error, run } = useRun();
  return (
    <Modal open={open} onClose={onClose} title="Version history" description="Every published version is kept, and every applicant's answers stay with the version they answered.">
      <div className="space-y-3">
        {versions.length === 0 ? <p className="text-sm text-muted-foreground">Nothing has been published yet.</p> : null}
        <ol className="space-y-2">
          {versions.map((v) => (
            <li key={v.version} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-strong">
                  Version {v.version} {v.current ? <Badge variant="success" size="sm">Live</Badge> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(v.publishedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {v.publishedBy}
                </p>
              </div>
              {v.note ? <p className="mt-1 text-sm text-muted-foreground">{v.note}</p> : null}
              {!v.current ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {canDraft ? (
                    <button type="button" disabled={busy} onClick={() => void run(async () => { await restore({ companyId, formId, version: v.version, expectedRevision: revision }); onRestored(); onClose(); })} className={buttonVariants({ variant: "outline", size: "xs" })}>
                      Copy into the draft
                    </button>
                  ) : null}
                  {canPublish ? (
                    <button type="button" disabled={busy} onClick={() => void run(async () => { await rollback({ companyId, formId, version: v.version }); onClose(); })} className={buttonVariants({ variant: "secondary", size: "xs" })}>
                      Publish this again
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
        <FormError message={error} />
      </div>
    </Modal>
  );
}
