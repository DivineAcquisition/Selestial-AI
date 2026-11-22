"use client";

/**
 * Staff side of a texting onboarding case (docs/texting/02-case.md): evidence with Selestial's internal
 * review, internal and owner-visible notes, exceptions, assisted number journeys, production readiness, and
 * the forms configuration. "Accepted for Selestial review" is labelled as internal everywhere: it is never
 * the carriers' decision, and nothing here can approve for the owner.
 */
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { Field, FormError, TextArea, TextInput, useRun } from "@/components/app/form";
import { PageHeader, Panel } from "@/components/app/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Disclosure, useConfirm } from "@/components/ui/fields";
import { Checkbox, Select } from "@/components/ui/selection";
import { Skeleton } from "@/components/ui/skeleton";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

const when = (at: number) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const READY: Record<string, { label: string; variant: "success" | "outline" | "error" | "warning" }> = {
  configured: { label: "Configured", variant: "success" },
  not_configured: { label: "Not configured", variant: "outline" },
  failed: { label: "Failed", variant: "error" },
  not_verified: { label: "Not verified", variant: "warning" },
};

/** What production has, from evidence on this deployment. Read only; the provider check below only reads. */
export function TextingReadiness() {
  const rows = useQuery(api.textingReview.readiness, {});
  const check = useMutation(api.textingReview.runReadOnlyCheck);
  const { busy, error, run } = useRun();
  return (
    <Panel className="mb-4">
      <div className="grid gap-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-semibold text-strong">Production readiness</p>
            <p className="text-xs text-muted-foreground">From this deployment&apos;s settings and recorded checks. The read-only check only reads the API key and messaging profile: it files nothing, not even a mock.</p>
          </div>
          <Button variant="outline" size="sm" loading={busy} onClick={() => void run(() => check({}))}>
            Run read-only check
          </Button>
        </div>
        <FormError message={error} />
        {rows === undefined ? (
          <Skeleton className="h-24" />
        ) : (
          <ul className="grid gap-1.5">
            {rows.map((row) => (
              <li key={row.key} className="flex flex-wrap items-start gap-2 text-xs">
                <Badge variant={READY[row.status].variant} size="sm">
                  {READY[row.status].label}
                </Badge>
                <span className="font-medium text-strong">{row.label}</span>
                <span className="min-w-0 basis-full text-muted-foreground sm:flex-1 sm:basis-auto">{row.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/** The case behind one request: evidence, notes, exceptions and recommendations, with internal items marked. */
export function TextingCasePanel({ setupId }: { setupId: Id<"textingSetups"> }) {
  const data = useQuery(api.textingReview.caseFor, { setupId });
  const openFile = useMutation(api.textingReview.fileLink);
  const review = useMutation(api.textingReview.reviewEvidence);
  const portable = useMutation(api.textingReview.checkPortable);
  const { busy, error, run } = useRun();
  const [noting, setNoting] = useState<Id<"textingEvidence"> | null>(null);
  const [stateNote, setStateNote] = useState("");
  if (data === undefined) return <Skeleton className="h-24" />;
  return (
    <div className="grid gap-3 text-xs">
      <FormError message={error} />
      <div className="grid gap-1.5">
        <p className="font-semibold text-strong">Evidence ({data.evidence.length})</p>
        <p className="text-muted-foreground">&ldquo;Accepted for Selestial review&rdquo; records Selestial&apos;s own check. It is not carrier approval.</p>
        {data.evidence.length === 0 ? <p className="text-muted-foreground">None added.</p> : null}
        <ul className="grid gap-1.5">
          {data.evidence.map((item) => (
            <li key={item.id} className="grid gap-1 rounded-lg border border-border p-2">
              <p className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-strong">{item.reviewCopy ? "Review copy" : item.purposeLabel}</span>
                <span className="text-muted-foreground">v{item.version}</span>
                <Badge size="sm" variant={item.state === "accepted_internal" ? "success" : item.state === "needs_replacement" || item.state === "missing" ? "warning" : "outline"}>
                  {item.stateLabel}
                </Badge>
                {item.visibility === "internal" ? <Badge size="sm" variant="info">Staff only</Badge> : null}
                {item.submitted.length ? <span className="text-muted-foreground">Filed with submission {item.submitted.join(", ")}</span> : null}
              </p>
              <p className="text-muted-foreground">{item.describes}</p>
              <p className="text-muted-foreground">
                {item.addedBy} · {when(item.addedAt)}
                {item.reviewedBy ? ` · reviewed by ${item.reviewedBy}` : ""}
                {item.reviewCopy?.path ? ` · public at ${item.reviewCopy.path}` : ""}
              </p>
              {item.url ? (
                <a href={item.url} target="_blank" rel="noreferrer noopener" className="break-all text-brand-300 underline-offset-2 hover:underline">
                  {item.url}
                </a>
              ) : null}
              <div className="flex flex-wrap gap-1.5">
                {item.file ? (
                  <Button size="sm" variant="outline" loading={busy} onClick={() => void run(async () => window.open((await openFile({ evidenceId: item.id })).url, "_blank", "noopener,noreferrer"))}>
                    Open file
                  </Button>
                ) : null}
                {item.kind !== "placeholder" ? (
                  <>
                    <Button size="sm" variant="ghost" loading={busy} onClick={() => void run(() => review({ evidenceId: item.id, state: "under_review" }))}>
                      Mark under review
                    </Button>
                    <Button size="sm" variant="ghost" loading={busy} onClick={() => void run(() => review({ evidenceId: item.id, state: "accepted_internal" }))}>
                      Accept for Selestial review
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setNoting(noting === item.id ? null : item.id)}>
                      Needs replacement…
                    </Button>
                  </>
                ) : null}
              </div>
              {noting === item.id ? (
                <form
                  className="flex flex-wrap gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => (await review({ evidenceId: item.id, state: "needs_replacement", note: stateNote }), setNoting(null), setStateNote("")));
                  }}
                >
                  <TextInput value={stateNote} onChange={(event) => setStateNote(event.target.value)} placeholder="What to change, in words the owner reads" aria-label="What needs replacing" required className="max-w-md" />
                  <Button type="submit" size="sm" variant="primary" loading={busy}>
                    Ask for a replacement
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {data.history.length ? <p className="text-muted-foreground">{data.history.length} earlier version(s) kept for the record.</p> : null}
      </div>

      {data.recommendations.length ? (
        <div className="grid gap-1">
          <p className="font-semibold text-strong">Open recommendations</p>
          {data.recommendations.map((row) => (
            <p key={row.id} className="text-muted-foreground">
              <Badge size="sm" variant="outline">
                {row.status}
              </Badge>{" "}
              {row.issue}
              {row.clarification ? <span className="text-warning-foreground"> · Owner asks: {row.clarification}</span> : null}
            </p>
          ))}
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <p className="font-semibold text-strong">Exceptions</p>
        {data.exceptions.length === 0 ? <p className="text-muted-foreground">None.</p> : null}
        {data.exceptions.map((row) => (
          <div key={row.id} className="grid gap-1 rounded-lg border border-border p-2">
            <p className="flex flex-wrap items-center gap-1.5">
              <Badge size="sm" variant={row.state === "resolved" ? "success" : row.state === "waiting_owner" ? "warning" : "info"}>
                {row.state.replace(/_/g, " ")}
              </Badge>
              <span className="font-medium text-strong">{row.category.replace(/_/g, " ")}</span>
              <span className="text-muted-foreground">{row.severity}</span>
              {row.assisted ? <Badge size="sm" variant="outline">Assisted</Badge> : null}
              {row.reopened ? <span className="text-muted-foreground">reopened {row.reopened}×</span> : null}
            </p>
            <p className="text-strong">Owner reads: {row.ownerWords}</p>
            {row.internalWords ? <p className="rounded bg-muted px-2 py-1 whitespace-pre-wrap text-strong">Internal: {row.internalWords}</p> : null}
            {row.assisted ? (
              <p className="text-muted-foreground">
                {row.assisted.phoneNumber ?? ""} {row.assisted.carrier ? `· ${row.assisted.carrier}` : ""} {row.assisted.words ? `· "${row.assisted.words}"` : ""}
              </p>
            ) : null}
            {row.response ? <p className="text-muted-foreground">Owner answered {when(row.response.at)}: {row.response.words}</p> : null}
            <p className="text-muted-foreground">
              Blocked: {row.blocker} · Next: {row.nextAction}
              {row.followUpAt ? ` · follow up ${when(row.followUpAt)}` : ""}
            </p>
            {row.assisted?.route === "release" || row.assisted?.route === "port_out" ? <Offboarding row={row} /> : null}
            <ExceptionControls setupId={setupId} row={row} />
            {row.assisted?.route === "port_existing" ? (
              <div>
                <Button size="sm" variant="outline" loading={busy} onClick={() => void run(() => portable({ exceptionId: row.id }))}>
                  Check eligibility with Telnyx (creates no order)
                </Button>
              </div>
            ) : null}
          </div>
        ))}
        <Disclosure title="Ask the owner for something, or open an exception">
          <ExceptionForm setupId={setupId} purposes={data.purposes} />
        </Disclosure>
      </div>

      <StaffNotes setupId={setupId} notes={data.notes} />
      {data.submissions.length ? (
        <p className="text-muted-foreground">
          Submissions: {data.submissions.map((row) => `v${row.version} (configuration ${row.configVersion || "built-in"}, ${row.evidence.length} evidence item(s))`).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

type OffboardingRow = {
  state: string;
  requestId?: Id<"textingRequests">;
  assisted?: { route: string; phoneNumber?: string; source?: "owner" | "plan_cancelled"; authorization?: { at: number; wording: string } };
  offboarding: { status: string; sameNumber: boolean; started: boolean; route: string | null; running: boolean; unassignedAt: number | null; numberRemovedAt: number | null; campaignRemovedAt: number | null; problem: string | null } | null;
};

/**
 * Giving a number up (docs/texting/03-offboarding.md). Shows whether the owner authorized it, for which
 * number, and how far it has got. Both actions are admin-only, need the destructive-actions capability, and
 * are refused by the server without the owner's recorded authorization for this number.
 */
function Offboarding({ row }: { row: OffboardingRow }) {
  const release = useMutation(api.texting.releaseNumber);
  const complete = useMutation(api.texting.completeTransfer);
  const { ask, element } = useConfirm();
  const [done, setDone] = useState<string | null>(null);
  const assisted = row.assisted!;
  const o = row.offboarding;
  const transfer = assisted.route === "port_out";
  const number = assisted.phoneNumber ?? "the number";
  const authorized = assisted.authorization !== undefined;
  const open = row.state !== "resolved" && o !== null && o.status !== "released";
  const steps = o ? ([["Off its campaign", o.unassignedAt], [transfer ? "Left Telnyx" : "Deleted at Telnyx", o.numberRemovedAt], ["Campaign deleted", o.campaignRemovedAt]] as const) : [];
  return (
    <div className="grid gap-1.5 rounded-lg bg-muted/50 p-2">
      {element}
      <p className="flex flex-wrap items-center gap-1.5">
        <Badge size="sm" variant={transfer ? "info" : "warning"}>
          {transfer ? "Moving to another provider" : "Release"}
        </Badge>
        <Badge size="sm" variant={authorized ? "success" : "outline"}>
          {authorized ? `Owner authorized ${when(assisted.authorization!.at)}` : "No owner authorization"}
        </Badge>
        {assisted.source === "plan_cancelled" ? <Badge size="sm" variant="outline">Opened when the plan was cancelled</Badge> : null}
        {o?.status === "released" ? <Badge size="sm" variant="success">Done</Badge> : null}
      </p>
      {!authorized ? <p className="text-warning-foreground">This is a work item only. Nothing may be released or moved until the Owner asks for it under &ldquo;Stop using this number&rdquo; on their texting screen.</p> : null}
      {o && !o.sameNumber ? <p className="text-destructive-foreground">This item is for a different number than the request has now. It authorizes nothing.</p> : null}
      {o?.started ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground" aria-label="Offboarding steps">
          {steps.map(([label, at]) => (
            <li key={label}>
              {label}: <span className="text-strong">{at ? when(at) : "not yet"}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {o?.running ? <p className="text-muted-foreground">Running now…</p> : null}
      {o?.problem ? <p className="text-destructive-foreground">Stopped: {o.problem}</p> : null}
      {done ? <p className="text-muted-foreground">{done}</p> : null}
      {open && authorized && o.sameNumber && row.requestId ? (
        <div className="flex flex-wrap items-center gap-2">
          {transfer ? (
            <Button
              size="sm"
              variant="outline"
              disabled={o.running}
              onClick={() =>
                void ask({
                  title: `Mark the transfer of ${number} complete?`,
                  body: "Selestial first checks with Telnyx that the number has left the account. If it is still there, nothing changes. If it has left, the campaign is deleted, texts from Selestial stop for this company, and its monthly fees stop.",
                  details: [{ label: "Number", value: number }],
                  confirmLabel: "Check and mark complete",
                  cancelLabel: "Not yet",
                  tone: "danger",
                  retryable: false,
                  failureNote: "Nothing was changed.",
                  action: async () => setDone((await complete({ requestId: row.requestId! })) === "released" ? "Already complete." : "Checking with Telnyx. The steps appear here."),
                })
              }
            >
              Mark transfer complete
            </Button>
          ) : (
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={o.running}
              onClick={() =>
                void ask({
                  title: `Release ${number}?`,
                  body: "This takes the number off its campaign, deletes it at Telnyx and deletes the campaign. It is permanent: the number can't be recovered. Texts for this company stop as soon as the first step succeeds. Steps already done are not repeated.",
                  details: [{ label: "Number", value: number }],
                  confirmLabel: o.started ? "Continue the release" : "Release the number",
                  cancelLabel: "Keep the number",
                  tone: "danger",
                  retryable: false,
                  failureNote: "Nothing was changed by this attempt. Check Mission Control before trying again.",
                  action: async () => setDone((await release({ requestId: row.requestId! })) === "released" ? "Already released." : "Release started. The steps appear here."),
                })
              }
            >
              {o.started ? "Continue the release" : "Release number"}
            </Button>
          )}
          <span className="text-muted-foreground">Admin only, with the destructive-actions capability.</span>
        </div>
      ) : null}
    </div>
  );
}

function ExceptionControls({ setupId, row }: { setupId: Id<"textingSetups">; row: { id: Id<"textingExceptions">; state: string } }) {
  const save = useMutation(api.textingReview.exception);
  const { busy, error, run } = useRun();
  const [resolution, setResolution] = useState("");
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {row.state !== "resolved" ? (
          <>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void run(() => save({ setupId, exceptionId: row.id, state: "waiting_provider", assignToMe: true }))}>
              Waiting on provider
            </Button>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void run(() => save({ setupId, exceptionId: row.id, followUpInDays: 3, assignToMe: true }))}>
              Follow up in 3 days
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" loading={busy} onClick={() => void run(() => save({ setupId, exceptionId: row.id, state: "waiting_selestial" }))}>
            Reopen
          </Button>
        )}
      </div>
      {row.state !== "resolved" ? (
        <form className="flex flex-wrap gap-2" onSubmit={(event) => (event.preventDefault(), void run(async () => (await save({ setupId, exceptionId: row.id, state: "resolved", resolution }), setResolution(""))))}>
          <TextInput value={resolution} onChange={(event) => setResolution(event.target.value)} placeholder="How it was resolved" aria-label="Resolution" className="max-w-md" />
          <Button type="submit" size="sm" variant="outline" loading={busy} disabled={!resolution.trim()}>
            Resolve
          </Button>
        </form>
      ) : null}
      <FormError message={error} />
    </div>
  );
}

const CATEGORIES = ["business_details", "consent_evidence", "policy_pages", "number", "carrier_correction", "other"] as const;

function ExceptionForm({ setupId, purposes }: { setupId: Id<"textingSetups">; purposes: { key: string; label: string }[] }) {
  const save = useMutation(api.textingReview.exception);
  const { busy, error, run } = useRun();
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("consent_evidence");
  const [ask, setAsk] = useState<"none" | "correction" | "evidence" | "information">("evidence");
  const [field, setField] = useState("");
  const [purpose, setPurpose] = useState<string | null>("opt_in_screenshot");
  const [ownerWords, setOwnerWords] = useState("");
  const [internalWords, setInternalWords] = useState("");
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await save({ setupId, category, ownerWords, internalWords: internalWords || undefined, ...(ask === "none" ? {} : { ask: { kind: ask, ...(field ? { field } : {}), ...(ask === "evidence" && purpose ? { purpose: purpose as "opt_in_screenshot" } : {}) } }), assignToMe: ask === "none" });
          setOwnerWords("");
          setInternalWords("");
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <Select value={category} onValueChange={(next) => next && setCategory(next)} options={CATEGORIES.map((value) => ({ value, label: value.replace(/_/g, " ") }))} aria-label="Category" />
        <Select value={ask} onValueChange={(next) => next && setAsk(next)} options={[{ value: "evidence", label: "Ask for evidence" }, { value: "correction", label: "Ask for a correction" }, { value: "information", label: "Ask a question" }, { value: "none", label: "Track only (no ask)" }]} aria-label="What to ask" />
        {ask === "evidence" ? <Select value={purpose} onValueChange={setPurpose} options={purposes.map((row) => ({ value: row.key, label: row.label }))} aria-label="Evidence wanted" /> : <TextInput value={field} onChange={(event) => setField(event.target.value)} placeholder="Field, e.g. legalName" aria-label="Field" />}
      </div>
      <Field label="What the owner reads">
        <TextArea rows={2} value={ownerWords} onChange={(event) => setOwnerWords(event.target.value)} required maxLength={1000} />
      </Field>
      <Field label="Internal (staff only, never sent to the company)">
        <TextArea rows={2} value={internalWords} onChange={(event) => setInternalWords(event.target.value)} maxLength={1000} />
      </Field>
      <p className="text-muted-foreground">A correction asked before anything is filed sends the request back to the owner, like &ldquo;Ask for a change&rdquo;.</p>
      <FormError message={error} />
      <div>
        <Button type="submit" size="sm" variant="primary" loading={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}

function StaffNotes({ setupId, notes }: { setupId: Id<"textingSetups">; notes: { id: Id<"textingNotes">; audience: string; body: string; by: string; revisions: number; createdAt: number }[] }) {
  const add = useMutation(api.textingReview.addNote);
  const { busy, error, run } = useRun();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(true);
  return (
    <div className="grid gap-1.5">
      <p className="font-semibold text-strong">Notes</p>
      {notes.map((note) => (
        <p key={note.id} className={note.audience === "internal" ? "rounded border border-dashed border-info/50 bg-info/5 px-2 py-1 whitespace-pre-wrap text-strong" : "rounded bg-muted px-2 py-1 whitespace-pre-wrap text-strong"}>
          <span className="text-muted-foreground">
            {note.audience === "internal" ? "Internal · " : "To/from owner · "}
            {note.by} · {when(note.createdAt)}
            {note.revisions ? ` · edited ${note.revisions}×` : ""}
          </span>
          <br />
          {note.body}
        </p>
      ))}
      <form className="grid gap-2" onSubmit={(event) => (event.preventDefault(), void run(async () => (await add({ setupId, body, internal }), setBody(""))))}>
        <TextArea rows={2} value={body} onChange={(event) => setBody(event.target.value)} aria-label="Note" maxLength={4000} />
        <label className="flex items-center gap-2 text-strong">
          <Checkbox checked={internal} onCheckedChange={setInternal} />
          Internal (staff only)
        </label>
        <FormError message={error} />
        <div>
          <Button type="submit" size="sm" variant="outline" loading={busy} disabled={!body.trim()}>
            Add note
          </Button>
        </div>
      </form>
    </div>
  );
}

// ── Forms configuration ───────────────────────────────────────────────────────────────────────────

/** Draft → Preview → Validate → Publish → Retire or roll back. JSON checked against the constrained schema. */
export function TextingConfigPage() {
  const data = useQuery(api.textingConfig.list, {});
  const create = useMutation(api.textingConfig.createDraft);
  const { busy, error, run } = useRun();
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<Id<"textingConfigVersions"> | null>(null);
  if (data === undefined) return <Skeleton className="h-60 rounded-2xl" />;
  const version = data.versions.find((row) => row.id === selected) ?? data.versions[0] ?? null;
  return (
    <>
      <PageHeader title="Texting forms configuration" lead={`Labels, help, approved rule parameters, agent ownership, wording templates, tutorial placement and prerequisites, versioned. In force: ${data.active ? `version ${data.active}` : "built-in"}. Configuration can only add requirements; a new provider capability still needs code. Prices are not configured here.`} />
      <FormError message={error} />
      {data.canEdit ? (
        <Panel className="mb-4">
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => (event.preventDefault(), void run(async () => (setSelected((await create({ reason })) as Id<"textingConfigVersions">), setReason(""))))}>
            <Field label="Why the configuration is changing" className="min-w-72 flex-1">
              <TextInput value={reason} onChange={(event) => setReason(event.target.value)} required minLength={10} />
            </Field>
            <Button type="submit" variant="primary" loading={busy}>
              New draft from what&apos;s in force
            </Button>
          </form>
        </Panel>
      ) : (
        <p className="mb-4 text-sm text-muted-foreground">Only staff admins change the configuration.</p>
      )}
      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <nav aria-label="Versions" className="grid content-start gap-1">
          {data.versions.length === 0 ? <p className="text-sm text-muted-foreground">No versions yet: the built-in configuration is in force.</p> : null}
          {data.versions.map((row) => (
            <button key={row.id} type="button" onClick={() => setSelected(row.id)} aria-current={version?.id === row.id ? "true" : undefined} className="rounded-lg border border-border px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-brand-500 aria-[current=true]:border-brand-500">
              <span className="font-medium text-strong">Version {row.version}</span> <Badge size="sm" variant={row.status === "published" ? "success" : row.status === "validated" ? "info" : "outline"}>{row.status}</Badge>
              <span className="block truncate text-xs text-muted-foreground">{row.reason}</span>
            </button>
          ))}
        </nav>
        {version ? <ConfigVersion key={version.id} version={version} canEdit={data.canEdit} me={data.me} builtIn={data.reference.builtIn} /> : null}
      </div>
    </>
  );
}

type Version = NonNullable<ReturnType<typeof useQuery<typeof api.textingConfig.list>>>["versions"][number];

function ConfigVersion({ version, canEdit, me, builtIn }: { version: Version; canEdit: boolean; me: Id<"staff">; builtIn: string }) {
  const edit = useMutation(api.textingConfig.editDraft);
  const validate = useMutation(api.textingConfig.validate);
  const publish = useMutation(api.textingConfig.publish);
  const retire = useMutation(api.textingConfig.retire);
  const rollback = useMutation(api.textingConfig.rollback);
  const preview = useQuery(api.textingConfig.preview, { versionId: version.id });
  const { busy, error, run } = useRun();
  const [body, setBody] = useState(version.body);
  const [why, setWhy] = useState("");
  const draft = version.status === "draft" || version.status === "validated";
  return (
    <Panel>
      <div className="grid gap-3 text-sm">
        <p className="text-xs text-muted-foreground">
          By {version.author}
          {version.reviewer ? `, published by ${version.reviewer}` : ""}
          {version.basedOn ? ` · based on version ${version.basedOn}` : ""}
          {version.effectiveAt ? ` · effective ${when(version.effectiveAt)}` : ""}
          {version.retiredAt ? ` · retired ${when(version.retiredAt)}` : ""}
          {version.affected !== null ? ` · reopened tasks on ${version.affected} setup(s)` : ""}
        </p>
        <p className="text-strong">{version.reason}</p>
        <Field label="Configuration (JSON)" hint="Supported: fields (label, help, example), rules (required_when_entity, max_length, pattern_preset, evidence_required), ownership, templates, tutorials, prerequisites, providerRequirements (with sourceUrl and verifiedOn).">
          <TextArea rows={14} value={body} onChange={(event) => setBody(event.target.value)} readOnly={!draft || !canEdit} className="font-mono text-xs" spellCheck={false} />
        </Field>
        <Disclosure title="Built-in shape">
          <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{builtIn}</pre>
        </Disclosure>
        {version.validation ? (
          <p className={version.validation.ok ? "text-success-foreground" : "text-destructive-foreground"}>
            {version.validation.ok ? `Valid${version.validation.needsReview ? " · changes requirements: another admin must publish" : ""}.` : version.validation.problems.join(" ")}
          </p>
        ) : null}
        {preview ? (
          <div className="grid gap-1 rounded-lg bg-muted/60 p-3 text-xs">
            <p className="font-semibold text-strong">Preview</p>
            {preview.ok ? (
              <>
                <p className="text-muted-foreground">Against what&apos;s in force (version {preview.against || "built-in"}): {preview.affectedCount} unfinished setup(s) would have steps reopened. Submitted setups keep their version.</p>
                <ul className="grid gap-0.5">
                  {preview.affected.map((row) => (
                    <li key={row.setupId}>
                      <span className="font-medium text-strong">{row.company}</span>: {row.steps.map((step) => `${step.step} (${step.words})`).join("; ")}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-destructive-foreground">{preview.problems.join(" ")}</p>
            )}
          </div>
        ) : null}
        <FormError message={error} />
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            {draft ? (
              <>
                <Button size="sm" variant="outline" loading={busy} disabled={body === version.body} onClick={() => void run(() => edit({ versionId: version.id, body }))}>
                  Save draft
                </Button>
                <Button size="sm" variant="outline" loading={busy} disabled={body !== version.body} onClick={() => void run(() => validate({ versionId: version.id }))}>
                  Validate
                </Button>
                <Button size="sm" variant="primary" loading={busy} disabled={version.status !== "validated" || (Boolean(version.validation?.needsReview) && version.authorId === me)} onClick={() => void run(() => publish({ versionId: version.id }))}>
                  Publish now
                </Button>
              </>
            ) : null}
            {version.status === "published" ? (
              <Button size="sm" variant="destructive-outline" loading={busy} onClick={() => void run(() => retire({ versionId: version.id }))}>
                Retire
              </Button>
            ) : null}
            {version.status === "published" || version.status === "retired" ? (
              <form className="flex flex-wrap gap-2" onSubmit={(event) => (event.preventDefault(), void run(async () => (await rollback({ toVersion: version.version, reason: why }), setWhy(""))))}>
                <TextInput value={why} onChange={(event) => setWhy(event.target.value)} placeholder="Why restore this version" aria-label="Why restore this version" className="max-w-xs" />
                <Button type="submit" size="sm" variant="outline" loading={busy} disabled={why.trim().length < 10}>
                  Restore as a new version
                </Button>
              </form>
            ) : null}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
