"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { canManage, useCompany } from "@/components/app/company";
import { useDetail } from "@/components/app/detail-panel";
import { Field, FormError, TextArea, TextInput, useRun } from "@/components/app/form";
import { Modal } from "@/components/app/modal";
import { useNow } from "@/components/app/use-now";
import { Check, Lock, X } from "@/components/icons";
import { Button, SubmitButton } from "@/components/ui/button";
import { Select } from "@/components/ui/selection";
import { ago, localDate, localTime, whenLabel, zonedInstant } from "@/lib/app/format";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { EventForm, type EventKind } from "./event-form";
import type { Item } from "./look";

const section = "grid gap-2 border-t border-border pt-4";
const heading = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";

/**
 * What can be done with an item, through its own record's workflow: Calendar's events through
 * calendarEvents, an interview through Recruiter's scheduling step, a walkthrough through Sales'.
 */
export function RecordActions({ item, timezone }: { item: Item; timezone: string }) {
  const { role } = useCompany();
  if (!canManage(role)) return null;
  if (item.source.table === "calendarEvents") return <EventActions eventId={item.source.id as Id<"calendarEvents">} timezone={timezone} />;
  if (item.source.table === "interviews" && (item.status === "confirmed" || item.status === "reserving")) return <InterviewActions interviewId={item.source.id as Id<"interviews">} item={item} timezone={timezone} />;
  if (item.source.table === "assessments" && (item.status === "scheduled" || item.status === "requested")) return <WalkthroughActions assessmentId={item.source.id as Id<"assessments">} item={item} timezone={timezone} />;
  return null;
}

// ── Calendar's own events ───────────────────────────────────────────────────────────────────────────

const HISTORY_WORDS: Record<string, string> = {
  "calendar_event.created": "made it",
  "calendar_event.changed": "changed it",
  "calendar_event.rescheduled": "moved it",
  "calendar_event.cancelled": "cancelled it",
  "calendar_event.attendance_recorded": "recorded attendance",
  "calendar_event.inspection_recorded": "recorded the result",
};

function EventActions({ eventId, timezone }: { eventId: Id<"calendarEvents">; timezone: string }) {
  const { companyId } = useCompany();
  const open = useDetail();
  const event = useQuery(api.calendarEvents.get, { companyId, eventId });
  const now = useNow();
  const [editing, setEditing] = useState(false);
  if (event === undefined) return null;
  if (!event.visible) {
    return (
      <p className="flex items-start gap-2 border-t border-border pt-4 text-sm text-muted-foreground">
        <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
        A private event. Only the people on it, and whoever made it, see what it is.
      </p>
    );
  }
  const live = event.status === "scheduled";
  const started = event.startsAt <= now;
  return (
    <>
      <div className={section}>
        {event.notes ? <p className="text-sm whitespace-pre-wrap text-strong">{event.notes}</p> : null}
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
          {event.lead ? (
            <>
              <dt className="text-muted-foreground">{event.kind === "inspection" ? "Inspector" : "Led by"}</dt>
              <dd className="text-strong">{event.lead.name}</dd>
            </>
          ) : null}
          {event.property ? (
            <>
              <dt className="text-muted-foreground">Property</dt>
              <dd className="text-strong">{event.property.label}</dd>
            </>
          ) : null}
          {event.jobId ? (
            <>
              <dt className="text-muted-foreground">Visit</dt>
              <dd>
                <button type="button" onClick={() => open({ kind: "job", id: event.jobId! })} className="font-medium text-brand-300 underline-offset-4 hover:underline">
                  Open the visit
                </button>
              </dd>
            </>
          ) : null}
          {event.qualityCase ? (
            <>
              <dt className="text-muted-foreground">Quality case</dt>
              <dd className="text-strong">
                {event.qualityCase.id ? (
                  <Link href="/app/agents/quality/cases" className="font-medium text-brand-300 underline-offset-4 hover:underline">
                    {event.qualityCase.title}
                  </Link>
                ) : (
                  event.qualityCase.title
                )}
              </dd>
            </>
          ) : null}
        </dl>
        {event.override ? <p className="text-xs text-warning-foreground">Saved over a conflict by {event.override.byName}: {event.override.reason}</p> : null}
        {event.cancelled ? <p className="text-sm text-muted-foreground">Cancelled {ago(event.cancelled.at, now, timezone)}: {event.cancelled.reason}</p> : null}
      </div>

      {event.kind === "training" ? <Attendance event={event} started={started} /> : null}
      {event.kind === "inspection" ? <InspectionResult event={event} started={started} timezone={timezone} /> : null}

      {live ? (
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Edit or move
          </Button>
          <CancelEvent eventId={event.eventId} revision={event.revision} />
        </div>
      ) : null}

      {event.history.length > 0 ? (
        <div className={section}>
          <h3 className={heading}>Changes</h3>
          <ol className="grid gap-1 text-xs text-muted-foreground">
            {event.history.map((entry) => (
              <li key={`${entry.at}-${entry.type}`}>
                <span className="text-strong">{entry.by}</span> {HISTORY_WORDS[entry.type] ?? "made a change"} · {whenLabel(entry.at, now, timezone)}
                {typeof entry.data?.from === "string" && typeof entry.data?.to === "string" && entry.data.from !== entry.data.to ? ` · from ${entry.data.from} to ${entry.data.to}` : ""}
                {typeof entry.data?.reason === "string" ? ` · “${entry.data.reason}”` : ""}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <Modal open={editing} onClose={() => setEditing(false)} title="Edit or move">
        <EventForm
          kind={event.kind as EventKind}
          existing={{ ...event, kind: event.kind as EventKind, lead: event.lead ? (event.lead.kind === "member" ? { kind: "member", id: event.lead.id as Id<"members"> } : { kind: "cleaner", id: event.lead.id as Id<"cleaners"> }) : null, qualityCase: event.qualityCase ? { id: event.qualityCase.id } : null }}
          onDone={() => setEditing(false)}
        />
      </Modal>
    </>
  );
}

function CancelEvent({ eventId, revision }: { eventId: Id<"calendarEvents">; revision: number }) {
  const { companyId } = useCompany();
  const cancel = useMutation(api.calendarEvents.cancel);
  const { busy, error, run } = useRun();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open)
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Cancel event
      </Button>
    );
  return (
    <form
      className="grid w-full gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => cancel({ companyId, eventId, expectedRevision: revision, reason }));
      }}
    >
      <Field label="Why it is cancelled" hint="Kept with the event. Nothing is deleted.">
        <TextInput value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} autoFocus />
      </Field>
      <FormError message={error} />
      <div className="flex gap-2">
        <SubmitButton pending={busy} variant="destructive-outline" size="sm">
          Cancel the event
        </SubmitButton>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
    </form>
  );
}

type Visible = Extract<NonNullable<ReturnType<typeof useQuery<typeof api.calendarEvents.get>>>, { visible: true }>;

function Attendance({ event, started }: { event: Visible; started: boolean }) {
  const { companyId } = useCompany();
  const record = useMutation(api.calendarEvents.recordAttendance);
  const { busy, error, run } = useRun();
  const [counts, setCounts] = useState<Record<string, string>>({});
  return (
    <div className={section}>
      <h3 className={heading}>Attendance</h3>
      {!started ? <p className="text-sm text-muted-foreground">Recorded once the session has started. Nobody is marked as attending in advance.</p> : null}
      <ul className="grid gap-2">
        {event.cleaners.map((person) => {
          const entry = event.attendance.find((row) => row.cleanerId === person.id);
          const handoff = event.handoffs.find((row) => row.cleanerId === person.id && row.status === "open");
          return (
            <li key={person.id} className="grid gap-1.5 rounded-lg border border-border p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-strong">{person.name}</span>
                <span className="text-xs text-muted-foreground">{entry ? `${entry.attended ? "Attended" : "Did not attend"} · recorded by ${entry.byName}${entry.requirementKey ? " · counted toward onboarding" : ""}` : "Not recorded"}</span>
              </div>
              {started && event.status !== "cancelled" ? (
                <div className="flex flex-wrap items-end gap-2">
                  {handoff && handoff.outstanding.length > 0 ? (
                    <div className="min-w-[12rem] flex-1">
                      <Select aria-label={`Onboarding item for ${person.name}`} value={counts[person.id] ?? ""} onValueChange={(value) => setCounts((before) => ({ ...before, [person.id]: value ?? "" }))} options={handoff.outstanding.map((row) => ({ value: row.key, label: `Also record: ${row.label}` }))} emptyLabel="Don't count toward onboarding" placeholder="Don't count toward onboarding" density="compact" />
                    </div>
                  ) : null}
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => record({ companyId, eventId: event.eventId, cleanerId: person.id as Id<"cleaners">, attended: true, ...(handoff && counts[person.id] ? { requirement: { handoffId: handoff.handoffId, key: counts[person.id] } } : {}) }))}>
                    <Check aria-hidden />
                    Attended
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => record({ companyId, eventId: event.eventId, cleanerId: person.id as Id<"cleaners">, attended: false }))}>
                    <X aria-hidden />
                    Didn&apos;t attend
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <FormError message={error} />
    </div>
  );
}

function InspectionResult({ event, started, timezone }: { event: Visible; started: boolean; timezone: string }) {
  const { companyId } = useCompany();
  const now = useNow();
  const record = useMutation(api.calendarEvents.recordInspection);
  const { busy, error, run } = useRun();
  const [result, setResult] = useState<"no_issues" | "issues_found" | "not_done" | "">("");
  const [note, setNote] = useState("");
  if (event.inspection) {
    return (
      <div className={section}>
        <h3 className={heading}>Result</h3>
        <p className="text-sm text-strong">{event.inspection.result === "no_issues" ? "No issues found" : event.inspection.result === "issues_found" ? "Issues found" : "Not done"}</p>
        {event.inspection.note ? <p className="text-sm whitespace-pre-wrap text-muted-foreground">{event.inspection.note}</p> : null}
        <p className="text-xs text-muted-foreground">
          Recorded by {event.inspection.byName}, {whenLabel(event.inspection.at, now, timezone)}. It is the inspector&apos;s words, not a quality decision.
        </p>
      </div>
    );
  }
  if (!started || event.status === "cancelled") return null;
  return (
    <form
      className={section}
      onSubmit={(submitted) => {
        submitted.preventDefault();
        if (!result) return;
        void run(() => record({ companyId, eventId: event.eventId, result, note }));
      }}
    >
      <h3 className={heading}>Record the result</h3>
      <Select
        aria-label="Result"
        value={result}
        onValueChange={(value) => setResult((value ?? "") as typeof result)}
        options={[
          { value: "no_issues", label: "No issues found" },
          { value: "issues_found", label: "Issues found" },
          { value: "not_done", label: "Not done" },
        ]}
      />
      <TextArea aria-label="What was found" value={note} onChange={(changed) => setNote(changed.target.value)} rows={3} placeholder={result === "no_issues" ? "Anything worth noting (optional)" : "What was found, or why it was not done"} />
      <FormError message={error} />
      <div>
        <SubmitButton pending={busy} size="sm" disabled={!result}>
          Save result
        </SubmitButton>
      </div>
    </form>
  );
}

// ── Interviews and walkthroughs, through their own workflows ────────────────────────────────────────

/** Reads a date and time on the company's clock from the form. */
function useSpan(item: Item, timezone: string) {
  const [date, setDate] = useState(localDate(item.startsAt, timezone));
  const [from, setFrom] = useState(localTime(item.startsAt, timezone));
  const [to, setTo] = useState(localTime(item.endsAt, timezone));
  const startsAt = zonedInstant(date, from, timezone);
  const endsAt = zonedInstant(date, to, timezone);
  const fields = (
    <div className="grid gap-2 sm:grid-cols-3">
      <Field label="Day">
        <TextInput type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </Field>
      <Field label="Starts">
        <TextInput type="time" value={from} onChange={(event) => setFrom(event.target.value)} />
      </Field>
      <Field label="Ends">
        <TextInput type="time" value={to} onChange={(event) => setTo(event.target.value)} />
      </Field>
    </div>
  );
  return { startsAt, endsAt, fields };
}

function InterviewActions({ interviewId, item, timezone }: { interviewId: Id<"interviews">; item: Item; timezone: string }) {
  const { companyId } = useCompany();
  const options = useQuery(api.calendarEvents.options, { companyId });
  const schedule = useMutation(api.interviews.schedule);
  const cancelTime = useMutation(api.interviews.cancelTime);
  const { busy, error, run, setError } = useRun();
  const [mode, setMode] = useState<"none" | "move" | "cancel">("none");
  const [interviewer, setInterviewer] = useState(item.resources.find((row) => row.kind === "member")?.id ?? "");
  const [how, setHow] = useState(item.detail ?? "");
  const [reason, setReason] = useState("");
  const span = useSpan(item, timezone);
  return (
    <div className={section}>
      {mode === "none" ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setMode("move")}>
            Change interview time
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMode("cancel")}>
            Cancel this time
          </Button>
        </div>
      ) : mode === "move" ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (span.startsAt === null || span.endsAt === null) return setError("Choose the day and times.");
            void run(async () => {
              await schedule({ companyId, interviewId, interviewerId: interviewer as Id<"members">, startsAt: span.startsAt!, endsAt: span.endsAt!, ...(how.trim() ? { how } : {}) });
              setMode("none");
            });
          }}
        >
          <p className="text-sm text-muted-foreground">Recruiter books the new time against the interviewer&apos;s other interviews and sends the applicant the new time, as it does from Interviews.</p>
          <Field label="Interviewer">
            <Select value={interviewer} onValueChange={(value) => setInterviewer(value ?? "")} options={(options?.members ?? []).filter((row) => row.role !== "office").map((row) => ({ value: row.id as string, label: row.name }))} />
          </Field>
          {span.fields}
          <Field label="How to join">
            <TextInput value={how} onChange={(event) => setHow(event.target.value)} maxLength={500} />
          </Field>
          <FormError message={error} />
          <div className="flex gap-2">
            <SubmitButton pending={busy} size="sm">
              Move the interview
            </SubmitButton>
            <Button variant="ghost" size="sm" onClick={() => setMode("none")}>
              Back
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await cancelTime({ companyId, interviewId, reason });
              setMode("none");
            });
          }}
        >
          <Field label="Why this time is cancelled" hint="The interview goes back to waiting for a time; the applicant is not dropped.">
            <TextArea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
          </Field>
          <FormError message={error} />
          <div className="flex gap-2">
            <SubmitButton pending={busy} size="sm" variant="destructive-outline">
              Cancel this time
            </SubmitButton>
            <Button variant="ghost" size="sm" onClick={() => setMode("none")}>
              Back
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function WalkthroughActions({ assessmentId, item, timezone }: { assessmentId: Id<"assessments">; item: Item; timezone: string }) {
  const { companyId } = useCompany();
  const options = useQuery(api.calendarEvents.options, { companyId });
  const schedule = useMutation(api.assessments.schedule);
  const { busy, error, run, setError } = useRun();
  const [moving, setMoving] = useState(false);
  const [assessor, setAssessor] = useState(item.resources.find((row) => row.kind === "member")?.id ?? "");
  const span = useSpan(item, timezone);
  if (!moving)
    return (
      <div className={section}>
        <div>
          <Button variant="outline" size="sm" onClick={() => setMoving(true)}>
            Change walkthrough time
          </Button>
        </div>
      </div>
    );
  return (
    <form
      className={section}
      onSubmit={(event) => {
        event.preventDefault();
        if (span.startsAt === null) return setError("Choose the day and time.");
        void run(async () => {
          await schedule({ companyId, assessmentId, scheduledAt: span.startsAt!, ...(assessor ? { assessorMemberId: assessor as Id<"members"> } : {}) });
          setMoving(false);
        });
      }}
    >
      <Field label="Who goes">
        <Select value={assessor} onValueChange={(value) => setAssessor(value ?? "")} options={(options?.members ?? []).map((row) => ({ value: row.id as string, label: row.name }))} />
      </Field>
      {span.fields}
      <p className="text-xs text-muted-foreground">The walkthrough keeps its length. The client is not messaged from here; agree the time with them as you would from Sales.</p>
      <FormError message={error} />
      <div className="flex gap-2">
        <SubmitButton pending={busy} size="sm">
          Save the time
        </SubmitButton>
        <Button variant="ghost" size="sm" onClick={() => setMoving(false)}>
          Back
        </Button>
      </div>
    </form>
  );
}
