"use client";

/**
 * Evidence & notes: what backs the owner's registration, and the conversation with Selestial about it.
 * Shown on Permission to text, Review & submit and corrections, and the same panel works inside an Admin
 * Support Session (the server decides what each viewer gets: the company never receives internal notes).
 *
 * The three kinds of progress are always told apart: a draft change is the owner's own; "Accepted for
 * Selestial review" is Selestial's internal check; only the carriers' review decides registration.
 */
import { useConvex, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRef, useState } from "react";

import { Field, FormError, TextArea, TextInput, useRun } from "@/components/app/form";
import { FileText, Link2 as LinkIcon, Lock, MessageSquareText, Paperclip } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Select } from "@/components/ui/selection";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Note, Section } from "./parts";

type Case = NonNullable<FunctionReturnType<typeof api.textingCase.workspace>>;
type Item = Case["evidence"][number];

const STATE_TONE: Record<Item["state"], "outline" | "info" | "success" | "warning"> = { missing: "warning", submitted: "outline", under_review: "info", accepted_internal: "success", needs_replacement: "warning" };
const PLACE_WORDS: Record<string, string> = { booking_form: "Booking form", quote_form: "Quote form", cleaner_application: "Job application", team_onboarding: "Team portal", website: "Website", other: "Somewhere else" };
const when = (at: number) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const size = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function EvidenceNotes({ companyId, context }: { companyId: Id<"companies">; context: "permission" | "review" | "correction" }) {
  const data = useQuery(api.textingCase.workspace, { companyId });
  if (data === undefined) return <Skeleton className="h-40 rounded-xl" />;
  if (data === null) return null;
  const asks = data.exceptions.filter((row) => row.state !== "resolved" && !row.assisted);
  return (
    <Section
      title="Evidence & notes"
      lead={
        context === "correction"
          ? "What Selestial asked for, and your answers. Everything else you filled in is kept."
          : "Screenshots, documents and links that show how people agree to your texts, and your conversation with Selestial. Selestial's review here is internal: it is not the carriers' decision."
      }
    >
      <div id="evidence-notes" className="grid gap-4">
        {data.viewer.kind === "support" ? (
          <p className="flex items-center gap-2 rounded-lg bg-info/10 px-3 py-2 text-xs text-info-foreground">
            <Lock className="size-3.5" aria-hidden />
            Support session · {data.viewer.manage ? "Manage" : "View only"}
            {data.viewer.staff ? "" : " · without the onboarding evidence capability, internal items are hidden"}
          </p>
        ) : null}
        {asks.length ? <Asks companyId={companyId} data={data} rows={asks} /> : null}
        <EvidenceList companyId={companyId} data={data} />
        <AddEvidence companyId={companyId} data={data} />
        <Notes companyId={companyId} data={data} />
      </div>
    </Section>
  );
}

// ── What Selestial asked for ──────────────────────────────────────────────────────────────────────

function Asks({ companyId, data, rows }: { companyId: Id<"companies">; data: Case; rows: Case["exceptions"] }) {
  return (
    <ul className="grid gap-2" aria-label="Asked by Selestial">
      {rows.map((row) => (
        <li key={row.id} className="grid gap-1.5 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={row.state === "waiting_owner" ? "warning" : "info"}>{row.state === "waiting_owner" ? "Needs you" : row.state === "waiting_provider" ? "Waiting on the provider" : "With Selestial"}</Badge>
            {row.field ? <span className="text-xs text-muted-foreground">About: {row.field}</span> : null}
            {row.reopened ? <span className="text-xs text-muted-foreground">Reopened {row.reopened}×</span> : null}
          </div>
          <p className="text-strong">{row.ownerWords}</p>
          <dl className="grid gap-0.5 text-xs text-muted-foreground">
            <div>
              <dt className="inline font-medium text-strong">Blocked: </dt>
              <dd className="inline">{row.blocker}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-strong">You can keep going: </dt>
              <dd className="inline">{row.canContinue}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-strong">Next: </dt>
              <dd className="inline">{row.nextAction}</dd>
            </div>
          </dl>
          {row.internalWords ? <p className="rounded bg-muted px-2 py-1 text-xs text-strong">Internal: {row.internalWords}</p> : null}
          {row.response ? <p className="text-xs text-muted-foreground">Your answer ({when(row.response.at)}): {row.response.words}</p> : null}
          {row.state === "waiting_owner" && data.viewer.kind === "owner" ? <Respond companyId={companyId} exceptionId={row.id} evidence={data.evidence} /> : null}
        </li>
      ))}
    </ul>
  );
}

function Respond({ companyId, exceptionId, evidence }: { companyId: Id<"companies">; exceptionId: Id<"textingExceptions">; evidence: Item[] }) {
  const respond = useMutation(api.textingCase.respond);
  const { busy, error, run } = useRun();
  const [words, setWords] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const files = evidence.filter((row) => row.kind !== "placeholder" && row.visibility === "company");
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await respond({ companyId, exceptionId, words, evidenceKey: key ?? undefined });
          setWords("");
        });
      }}
    >
      <Field label="Your answer">
        <TextArea rows={2} value={words} onChange={(event) => setWords(event.target.value)} maxLength={2000} required />
      </Field>
      {files.length ? <Select value={key} onValueChange={setKey} emptyLabel="No evidence attached" options={files.map((row) => ({ value: row.key, label: `${row.purposeLabel} · v${row.version}` }))} aria-label="Attach an evidence item" /> : null}
      <FormError message={error} />
      <div>
        <Button type="submit" size="sm" variant="primary" loading={busy}>
          Send answer
        </Button>
      </div>
    </form>
  );
}

// ── Evidence items ────────────────────────────────────────────────────────────────────────────────

function EvidenceList({ companyId, data }: { companyId: Id<"companies">; data: Case }) {
  if (!data.evidence.length) return <Note>No evidence yet. Carriers mostly read your public pages; add a screenshot when people agree somewhere Selestial can&apos;t see, or when Selestial asks.</Note>;
  return (
    <ul className="grid gap-2" aria-label="Evidence">
      {data.evidence.map((item) => (
        <EvidenceRow key={item.id} companyId={companyId} data={data} item={item} />
      ))}
    </ul>
  );
}

function EvidenceRow({ companyId, data, item }: { companyId: Id<"companies">; data: Case; item: Item }) {
  const convex = useConvex();
  const remove = useMutation(api.textingCase.removeEvidence);
  const expose = useMutation(api.textingCase.setReviewExposure);
  const { busy, error, run } = useRun();
  const [mode, setMode] = useState<"replace" | "copy" | "approve" | null>(null);
  const older = data.history.filter((row) => row.key === item.key).length;
  const owner = data.viewer.kind === "owner";
  const isCopy = item.reviewCopy !== null;
  const hasCopy = data.evidence.some((row) => row.reviewCopy?.of === item.id);
  const canOpen = item.kind === "file" && (owner || (data.viewer.staff && data.viewer.revealed));
  return (
    <li className={cn("grid gap-2 rounded-xl border p-3 text-sm", item.visibility === "internal" ? "border-dashed border-info/50 bg-info/5" : "border-border")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-0.5">
          <p className="flex flex-wrap items-center gap-1.5 font-medium text-strong">
            {item.kind === "url" ? <LinkIcon className="size-4 shrink-0" aria-hidden /> : <Paperclip className="size-4 shrink-0" aria-hidden />}
            {isCopy ? "Review copy" : item.purposeLabel}
            <span className="text-xs font-normal text-muted-foreground">v{item.version}</span>
            {item.visibility === "internal" ? <Badge variant="info">Selestial only</Badge> : null}
          </p>
          <p className="text-xs text-muted-foreground">{item.describes}</p>
        </div>
        <Badge variant={STATE_TONE[item.state]}>{item.stateLabel}</Badge>
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {item.file ? (
          <span className="min-w-0 break-all">
            {item.file.name} · {size(item.file.size)}
          </span>
        ) : null}
        {item.url ? (
          <a href={item.url} target="_blank" rel="noreferrer noopener" className="break-all text-brand-300 underline-offset-2 hover:underline">
            {item.url}
          </a>
        ) : null}
        {item.links.place ? <span>Where: {PLACE_WORDS[item.links.place] ?? item.links.place}</span> : null}
        {item.links.field ? <span>About: {item.links.field}</span> : null}
        <span>Added {when(item.addedAt)}{item.addedBySupport ? " by Selestial Support" : ""}</span>
        {item.submitted.length ? <span>Filed with submission {item.submitted.join(", ")}</span> : null}
        {older ? <span>{older} earlier version{older === 1 ? "" : "s"} kept</span> : null}
      </p>
      {item.stateNote ? <p className="text-xs text-warning-foreground">Selestial: {item.stateNote}</p> : null}
      {isCopy ? (
        <p className="text-xs text-muted-foreground">
          {item.reviewCopy!.exposure === "approved" ? "Shown to carrier reviewers at a public address, as you approved. Withdraw it at any time." : item.reviewCopy!.exposure === "withdrawn" ? "Withdrawn: not shown outside Selestial." : "Private. It can be shown outside Selestial only after Selestial accepts it and you approve."}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canOpen ? (
          <Button
            size="sm"
            variant="outline"
            loading={busy}
            onClick={() =>
              void run(async () => {
                const link = await convex.query(api.textingCase.fileLink, { companyId, evidenceId: item.id });
                window.open(link.url, "_blank", "noopener,noreferrer");
              })
            }
          >
            <FileText aria-hidden />
            Open
          </Button>
        ) : item.kind === "file" && data.viewer.kind === "support" ? (
          <span className="text-xs text-muted-foreground">Reveal content to open files.</span>
        ) : null}
        {data.viewer.manage ? (
          <Button size="sm" variant="outline" onClick={() => setMode(mode === "replace" ? null : "replace")} aria-expanded={mode === "replace"}>
            {item.kind === "placeholder" ? "Add it" : "Replace"}
          </Button>
        ) : null}
        {owner && !isCopy && item.kind === "file" && (item.purpose === "opt_in_screenshot" || item.purpose === "opt_in_form") && !hasCopy ? (
          <Button size="sm" variant="outline" onClick={() => setMode(mode === "copy" ? null : "copy")} aria-expanded={mode === "copy"}>
            Add a redacted review copy
          </Button>
        ) : null}
        {owner && isCopy && item.reviewCopy!.exposure !== "approved" ? (
          <Button size="sm" variant="outline" disabled={item.state !== "accepted_internal"} onClick={() => setMode(mode === "approve" ? null : "approve")} aria-expanded={mode === "approve"}>
            Approve showing it
          </Button>
        ) : null}
        {owner && isCopy && item.reviewCopy!.exposure === "approved" ? (
          <Button size="sm" variant="outline" loading={busy} onClick={() => void run(() => expose({ companyId, evidenceId: item.id, approve: false }))}>
            Withdraw
          </Button>
        ) : null}
        {owner && !item.submitted.length && !item.reviewedAt && !older ? (
          <Button size="sm" variant="ghost" loading={busy} onClick={() => void run(() => remove({ companyId, evidenceId: item.id }))}>
            Remove
          </Button>
        ) : null}
      </div>
      {mode === "approve" ? <ApproveCopy companyId={companyId} evidenceId={item.id} wording={data.catalog.reviewCopyWording} onDone={() => setMode(null)} /> : null}
      {mode === "replace" || mode === "copy" ? <EvidenceForm companyId={companyId} data={data} replaces={mode === "replace" ? item : undefined} copyOf={mode === "copy" ? item : undefined} onDone={() => setMode(null)} /> : null}
      <FormError message={error} />
    </li>
  );
}

function ApproveCopy({ companyId, evidenceId, wording, onDone }: { companyId: Id<"companies">; evidenceId: Id<"textingEvidence">; wording: string; onDone: () => void }) {
  const expose = useMutation(api.textingCase.setReviewExposure);
  const { busy, error, run } = useRun();
  const [agreed, setAgreed] = useState(false);
  return (
    <div className="grid gap-2 rounded-lg bg-muted/60 p-3 text-xs">
      <label className="flex items-start gap-2">
        <Checkbox checked={agreed} onCheckedChange={setAgreed} className="mt-0.5" />
        <span className="text-strong">{wording}</span>
      </label>
      <FormError message={error} />
      <div>
        <Button size="sm" variant="primary" disabled={!agreed} loading={busy} onClick={() => void run(async () => (await expose({ companyId, evidenceId, approve: true, wording }), onDone()))}>
          Approve showing this copy
        </Button>
      </div>
    </div>
  );
}

function AddEvidence({ companyId, data }: { companyId: Id<"companies">; data: Case }) {
  const [open, setOpen] = useState(false);
  if (!data.viewer.manage) return null;
  return open ? (
    <EvidenceForm companyId={companyId} data={data} onDone={() => setOpen(false)} />
  ) : (
    <div>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Paperclip aria-hidden />
        Add evidence
      </Button>
    </div>
  );
}

/** Adds an item, a new version of one, or a redacted copy of one. The file goes straight to private storage. */
function EvidenceForm({ companyId, data, replaces, copyOf, onDone }: { companyId: Id<"companies">; data: Case; replaces?: Item; copyOf?: Item; onDone: () => void }) {
  const uploadUrl = useMutation(api.textingCase.uploadUrl);
  const add = useMutation(api.textingCase.addEvidence);
  const { busy, error, run, setError } = useRun();
  const [purpose, setPurpose] = useState<Item["purpose"]>(replaces?.purpose ?? copyOf?.purpose ?? "opt_in_screenshot");
  const [describes, setDescribes] = useState(copyOf ? "A blank or redacted copy: no names, numbers, emails, addresses or signatures." : (replaces?.describes ?? ""));
  const [kind, setKind] = useState<"file" | "url">(copyOf ? "file" : "file");
  const [url, setUrl] = useState("");
  const [place, setPlace] = useState<string | null>(replaces?.links.place ?? copyOf?.links.place ?? null);
  const [internal, setInternal] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      let storageId: Id<"_storage"> | undefined;
      let name: string | undefined;
      if (kind === "file") {
        const chosen = file.current?.files?.[0];
        if (!chosen) throw new Error("Choose a file first.");
        if (chosen.size > data.catalog.maxBytes) throw new Error(`The file is larger than ${data.catalog.maxBytes / 1024 / 1024} MB.`);
        const response = await fetch(await uploadUrl({ companyId }), { method: "POST", headers: { "Content-Type": chosen.type || "application/octet-stream" }, body: chosen });
        if (!response.ok) throw new Error("The upload didn't finish. Try again.");
        storageId = ((await response.json()) as { storageId: Id<"_storage"> }).storageId;
        name = chosen.name;
      }
      await add({ companyId, purpose, describes, ...(storageId ? { storageId, name } : { url }), ...(place ? { place } : {}), ...(replaces ? { replaces: replaces.key } : {}), ...(copyOf ? { reviewCopyOf: copyOf.id } : {}), ...(internal ? { internal: true } : {}) });
      onDone();
    });
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-3 rounded-xl border border-border bg-muted/30 p-3" aria-label={copyOf ? "Add a review copy" : replaces ? "Add a new version" : "Add evidence"}>
      {copyOf ? <Note tone="warning">Make a copy with every customer&apos;s name, number, email, address and signature removed, or a blank form. The original stays private either way.</Note> : null}
      {replaces ? <p className="text-xs text-muted-foreground">The current version is kept exactly as it is{replaces.submitted.length ? `, because it was filed with submission ${replaces.submitted.join(", ")}` : ""}. This becomes version {replaces.version + 1}.</p> : null}
      {!replaces && !copyOf ? (
        <Field label="What is it?">
          <Select value={purpose} onValueChange={(next) => next && setPurpose(next)} options={data.catalog.purposes.map((row) => ({ value: row.key, label: row.label, description: row.proves }))} aria-label="What is it?" />
        </Field>
      ) : null}
      <Field label="What it shows" hint="In your words: what a reviewer should see in it.">
        <TextArea rows={2} value={describes} onChange={(event) => setDescribes(event.target.value)} maxLength={600} />
      </Field>
      {!copyOf ? (
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="File or link">
          {(["file", "url"] as const).map((value) => (
            <Button key={value} type="button" size="sm" variant={kind === value ? "primary" : "outline"} role="radio" aria-checked={kind === value} onClick={() => setKind(value)}>
              {value === "file" ? "Upload a file" : "Add a link"}
            </Button>
          ))}
        </div>
      ) : null}
      {kind === "file" ? (
        <Field label="File" hint={data.catalog.accepted}>
          <input ref={file} type="file" accept="image/png,image/jpeg,application/pdf,text/plain" className="block w-full text-sm text-strong file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm" onChange={() => setError(null)} />
        </Field>
      ) : (
        <Field label="Link" hint="Must start with https://.">
          <TextInput value={url} onChange={(event) => setUrl(event.target.value)} inputMode="url" placeholder="https://" />
        </Field>
      )}
      {!copyOf ? <Select value={place} onValueChange={setPlace} emptyLabel="Not about one place" options={data.catalog.places.map((value) => ({ value, label: PLACE_WORDS[value] ?? value }))} aria-label="Where people agree" /> : null}
      {data.viewer.staff && data.viewer.kind === "support" ? (
        <label className="flex items-center gap-2 text-xs text-strong">
          <Checkbox checked={internal} onCheckedChange={setInternal} />
          Keep to Selestial (the company never sees it)
        </label>
      ) : null}
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" loading={busy}>
          {copyOf ? "Add review copy" : replaces ? "Add new version" : "Add"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ── Notes ─────────────────────────────────────────────────────────────────────────────────────────

function Notes({ companyId, data }: { companyId: Id<"companies">; data: Case }) {
  const addNote = useMutation(api.textingCase.addNote);
  const editNote = useMutation(api.textingCase.editNote);
  const { busy, error, run } = useRun();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [editing, setEditing] = useState<{ id: Id<"textingNotes">; body: string } | null>(null);
  return (
    <div className="grid gap-2">
      <h4 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <MessageSquareText className="size-3.5" aria-hidden />
        Notes
      </h4>
      {data.notes.length ? (
        <ul className="grid gap-2" aria-label="Notes">
          {data.notes.map((note) => (
            <li key={note.id} className={cn("grid gap-1 rounded-lg px-3 py-2 text-sm", note.audience === "internal" ? "border border-dashed border-info/50 bg-info/5" : "bg-muted/50")}>
              <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-medium text-strong">{note.by === "Owner" ? "You" : "Selestial"}</span>
                {note.audience === "internal" ? <Badge variant="info">Internal · Selestial only</Badge> : null}
                {note.status === "draft" ? <Badge variant="outline">Draft</Badge> : null}
                <span>{when(note.updatedAt)}</span>
                {note.edited ? <span>· edited, earlier wording kept</span> : null}
                {note.locked ? <span>· part of a submission</span> : null}
              </p>
              {editing?.id === note.id ? (
                <form
                  className="grid gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => (await editNote({ companyId, noteId: note.id, body: editing.body, post: true }), setEditing(null)));
                  }}
                >
                  <TextArea rows={3} value={editing.body} onChange={(event) => setEditing({ ...editing, body: event.target.value })} aria-label="Edit note" maxLength={4000} />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" variant="primary" loading={busy}>
                      Save
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <p className="whitespace-pre-wrap text-strong">{note.body}</p>
              )}
              {note.mine && !note.locked && editing?.id !== note.id && data.viewer.manage ? (
                <div>
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ id: note.id, body: note.body })}>
                    Edit
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No notes yet.</p>
      )}
      {data.viewer.manage ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => (await addNote({ companyId, body, ...(internal ? { internal: true } : {}) }), setBody("")));
          }}
        >
          <Field label={internal ? "Internal note (Selestial only)" : data.viewer.kind === "support" ? "Note to the company" : "Note to Selestial"}>
            <TextArea rows={2} value={body} onChange={(event) => setBody(event.target.value)} maxLength={4000} />
          </Field>
          {data.viewer.kind === "support" && data.viewer.staff ? (
            <label className="flex items-center gap-2 text-xs text-strong">
              <Checkbox checked={internal} onCheckedChange={setInternal} />
              Internal: the company never sees it
            </label>
          ) : null}
          <FormError message={error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!body.trim()}>
              Post note
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={!body.trim() || busy} onClick={() => void run(async () => (await addNote({ companyId, body, draft: true, ...(internal ? { internal: true } : {}) }), setBody("")))}>
              Save as draft
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
