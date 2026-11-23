"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, FormError, TextArea, TextInput, useRun } from "@/components/app/form";
import { CircleAlertIcon, Info, TriangleAlert } from "@/components/icons";
import { Button, SubmitButton } from "@/components/ui/button";
import { CheckboxRow, MultiSelect, Select } from "@/components/ui/selection";
import { localDate, localTime, zonedInstant } from "@/lib/app/format";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

export type EventKind = "meeting" | "appointment" | "unavailable" | "training" | "inspection";

export const EVENT_KIND_LABEL: Record<EventKind, { title: string; description: string }> = {
  meeting: { title: "Business event", description: "An internal meeting. It takes the time of the people on it, and nobody else's." },
  appointment: { title: "Appointment", description: "A manual appointment, such as a call with a supplier. It takes only the time of the people on it." },
  unavailable: { title: "Unavailable time", description: "Time an Owner or Manager is away. It blocks only them. A cleaner's time off is recorded on their record in Cleaners." },
  training: { title: "Training session", description: "Onboarding or training, led by a member or trainer, for new hires and cleaners. Attendance counts toward onboarding only when a person records it." },
  inspection: { title: "Inspection", description: "A scheduled quality inspection at a property, by an Owner, a Manager or a lead cleaner." },
};

/** An existing event, as calendarEvents.get returns it to someone who may see it. */
export type Existing = {
  eventId: Id<"calendarEvents">;
  revision: number;
  kind: EventKind;
  title: string;
  notes: string | null;
  location: string | null;
  startsAt: number;
  endsAt: number;
  allDay: { from: string; through: string } | null;
  private: boolean;
  members: { id: Id<"members">; name: string }[];
  cleaners: { id: Id<"cleaners">; name: string }[];
  lead: { kind: "member"; id: Id<"members"> } | { kind: "cleaner"; id: Id<"cleaners"> } | null;
  jobId: Id<"jobs"> | null;
  qualityCase: { id: Id<"qualityCases"> | null } | null;
  handoffs: { handoffId: Id<"onboardingHandoffs">; cleanerId: Id<"cleaners"> }[];
};

type Form = {
  title: string;
  notes: string;
  location: string;
  date: string;
  from: string;
  to: string;
  allDay: boolean;
  through: string;
  private: boolean;
  members: string[];
  cleaners: string[];
  lead: string;
  handoffs: string[];
  target: string;
  override: string;
};

const MEMBER = "m:";
const CLEANER = "c:";

function initialForm(kind: EventKind, existing: Existing | undefined, me: string | undefined, timezone: string, day: string | null, moveTo?: { startsAt: number; endsAt: number }): Form {
  if (existing) {
    const startsAt = moveTo?.startsAt ?? existing.startsAt;
    const endsAt = moveTo?.endsAt ?? existing.endsAt;
    const handoffCleaners = new Set(existing.handoffs.map((row) => row.cleanerId as string));
    return {
      title: existing.title,
      notes: existing.notes ?? "",
      location: existing.location ?? "",
      date: moveTo ? localDate(startsAt, timezone) : (existing.allDay?.from ?? localDate(startsAt, timezone)),
      from: localTime(startsAt, timezone),
      to: localTime(endsAt, timezone),
      allDay: !moveTo && existing.allDay !== null,
      through: moveTo ? localDate(startsAt, timezone) : (existing.allDay?.through ?? localDate(startsAt, timezone)),
      private: existing.private,
      members: kind === "inspection" ? [] : existing.members.map((row) => row.id),
      cleaners: existing.cleaners.map((row) => row.id as string).filter((id) => !handoffCleaners.has(id)),
      lead: existing.lead ? `${existing.lead.kind === "member" ? MEMBER : CLEANER}${existing.lead.id}` : kind === "inspection" && existing.members[0] ? `${MEMBER}${existing.members[0].id}` : "",
      handoffs: existing.handoffs.map((row) => row.handoffId),
      target: existing.jobId ? `job:${existing.jobId}` : existing.qualityCase?.id ? `case:${existing.qualityCase.id}` : "",
      override: "",
    };
  }
  const date = day ?? "";
  return { title: "", notes: "", location: "", date, from: "09:00", to: "10:00", allDay: kind === "unavailable", through: date, private: kind === "unavailable", members: me && kind !== "training" && kind !== "inspection" ? [me] : [], cleaners: [], lead: "", handoffs: [], target: "", override: "" };
}

/**
 * Makes or changes one of Calendar's own events. What saving would run into is shown as the form is
 * filled in, checked against the people the event takes; the same check runs again on save.
 */
export function EventForm({ kind, existing, day, moveTo, onDone }: { kind: EventKind; existing?: Existing; day?: string | null; /** A new time chosen by dragging, to review before saving. */ moveTo?: { startsAt: number; endsAt: number }; onDone: () => void }) {
  const { companyId, timezone } = useCompany();
  const options = useQuery(api.calendarEvents.options, { companyId });
  const create = useMutation(api.calendarEvents.create);
  const update = useMutation(api.calendarEvents.update);
  const { busy, error, run, setError } = useRun();
  const [form, setForm] = useState<Form>(() => initialForm(kind, existing, undefined, timezone, day ?? null, moveTo));
  const [touchedPeople, setTouchedPeople] = useState(Boolean(existing));
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));

  // The person making it is on it by default, once we know who they are.
  const members = !touchedPeople && options && kind !== "training" && kind !== "inspection" && form.members.length === 0 ? [options.me] : form.members;

  const span = (() => {
    if (form.allDay) {
      const startsAt = zonedInstant(form.date, "00:00", timezone);
      const last = zonedInstant(form.through || form.date, "00:00", timezone);
      return startsAt !== null && last !== null && last >= startsAt ? { startsAt, endsAt: last + 24 * 3_600_000, allDay: { from: form.date, through: form.through || form.date } } : null;
    }
    const startsAt = zonedInstant(form.date, form.from, timezone);
    const endsAt = zonedInstant(form.date, form.to, timezone);
    return startsAt !== null && endsAt !== null ? { startsAt, endsAt: endsAt <= startsAt ? endsAt + 24 * 3_600_000 : endsAt } : null;
  })();

  const lead = form.lead ? (form.lead.startsWith(MEMBER) ? { kind: "member" as const, id: form.lead.slice(2) as Id<"members"> } : { kind: "cleaner" as const, id: form.lead.slice(2) as Id<"cleaners"> }) : null;
  const target = form.target ? (form.target.startsWith("job:") ? { jobId: form.target.slice(4) as Id<"jobs"> } : { qualityCaseId: form.target.slice(5) as Id<"qualityCases"> }) : {};
  const input = span
    ? {
        kind,
        ...(form.title.trim() ? { title: form.title } : {}),
        ...(form.notes.trim() ? { notes: form.notes } : {}),
        ...(form.location.trim() ? { location: form.location } : {}),
        startsAt: span.startsAt,
        endsAt: span.endsAt,
        ...("allDay" in span ? { allDay: span.allDay } : {}),
        private: form.private,
        memberIds: (kind === "inspection" ? (lead?.kind === "member" ? [lead.id] : []) : members) as Id<"members">[],
        cleanerIds: (kind === "training" ? form.cleaners : []) as Id<"cleaners">[],
        ...(kind === "training" && lead?.kind === "member" ? { leadMemberId: lead.id } : {}),
        ...((kind === "training" || kind === "inspection") && lead?.kind === "cleaner" ? { leadCleanerId: lead.id } : {}),
        ...(kind === "inspection" ? target : {}),
        ...(kind === "training" && form.handoffs.length ? { handoffIds: form.handoffs as Id<"onboardingHandoffs">[] } : {}),
      }
    : null;
  const check = useQuery(api.calendarEvents.preview, input ? { companyId, ...input, ...(existing ? { eventId: existing.eventId } : {}) } : "skip");
  const hard = check?.ready ? check.hard : [];

  const memberOptions = (options?.members ?? []).map((row) => ({ value: row.id as string, label: row.name, meta: row.role === "owner" ? "Owner" : row.role === "manager" ? "Manager" : "Office" }));
  const cleanerOptions = (options?.cleaners ?? []).map((row) => ({ value: row.id as string, label: row.name, meta: row.status === "onboarding" ? "Onboarding" : undefined }));
  const leadOptions =
    kind === "inspection"
      ? [...(options?.members ?? []).filter((row) => row.role !== "office").map((row) => ({ value: `${MEMBER}${row.id}`, label: row.name, group: "Owners and Managers" })), ...(options?.cleaners ?? []).filter((row) => row.lead).map((row) => ({ value: `${CLEANER}${row.id}`, label: row.name, group: "Lead cleaners" }))]
      : [...(options?.members ?? []).map((row) => ({ value: `${MEMBER}${row.id}`, label: row.name, group: "Members" })), ...(options?.cleaners ?? []).filter((row) => row.status === "ready").map((row) => ({ value: `${CLEANER}${row.id}`, label: row.name, group: "Cleaners" }))];
  const targetOptions = [...(options?.visits ?? []).map((row) => ({ value: `job:${row.jobId}`, label: row.label, group: "Visits" })), ...(options?.cases ?? []).map((row) => ({ value: `case:${row.caseId}`, label: row.title, group: "Open quality cases" }))];

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!input) return setError(form.allDay ? "Choose the days it covers." : "Choose the day, the start time and the end time.");
        if (hard.length > 0 && !form.override.trim()) return setError("Give a reason to save over the conflicts, or change the time or people.");
        void run(async () => {
          const extra = hard.length > 0 ? { overrideReason: form.override } : {};
          if (existing) await update({ companyId, ...input, ...extra, eventId: existing.eventId, expectedRevision: existing.revision });
          else await create({ companyId, ...input, ...extra });
          onDone();
        });
      }}
    >
      <p className="text-sm text-muted-foreground">{EVENT_KIND_LABEL[kind].description}</p>

      {kind !== "unavailable" ? (
        <Field label="Title" hint={`Leave empty for "${kind === "training" ? "Training session" : EVENT_KIND_LABEL[kind].title}".`}>
          <TextInput value={form.title} onChange={(event) => set("title", event.target.value)} maxLength={120} />
        </Field>
      ) : null}

      {kind === "unavailable" ? (
        <Field label="Who is away" required>
          <Select value={members[0] ?? ""} onValueChange={(value) => { setTouchedPeople(true); set("members", value ? [value] : []); }} options={memberOptions.filter((row) => row.meta !== "Office")} />
        </Field>
      ) : kind === "meeting" || kind === "appointment" ? (
        <Field label="People on it" required hint="Their time is checked. Nobody else's is.">
          <MultiSelect value={members} onValueChange={(value) => { setTouchedPeople(true); set("members", value); }} options={memberOptions} noun="people" />
        </Field>
      ) : kind === "training" ? (
        <>
          <Field label="Led by" required>
            <Select value={form.lead} onValueChange={(value) => set("lead", value ?? "")} options={leadOptions} searchable="auto" />
          </Field>
          <Field label="New hires" hint="Their onboarding is linked, so attendance can be recorded against it.">
            <MultiSelect value={form.handoffs} onValueChange={(value) => set("handoffs", value)} options={(options?.handoffs ?? []).map((row) => ({ value: row.handoffId as string, label: row.name, meta: row.role }))} noun="new hires" emptyText="Nobody is in onboarding now." />
          </Field>
          <Field label="Other cleaners attending">
            <MultiSelect value={form.cleaners} onValueChange={(value) => set("cleaners", value)} options={cleanerOptions} noun="cleaners" />
          </Field>
        </>
      ) : (
        <>
          <Field label="Inspector" required hint="An Owner, a Manager, or a cleaner who leads a crew.">
            <Select value={form.lead} onValueChange={(value) => set("lead", value ?? "")} options={leadOptions} searchable="auto" />
          </Field>
          <Field label="What to inspect" required hint="A recent visit or an open quality case. The property comes from it.">
            <Select value={form.target} onValueChange={(value) => set("target", value ?? "")} options={targetOptions} searchable="auto" emptyText="No recent visits or open cases." />
          </Field>
        </>
      )}

      <CheckboxRow checked={form.allDay} onCheckedChange={(checked) => set("allDay", Boolean(checked))} title="All day" description={kind === "unavailable" ? "Whole days away. Turn off to give times." : undefined} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={form.allDay ? "From" : "Day"} required>
          <TextInput type="date" value={form.date} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value, through: current.through < event.target.value ? event.target.value : current.through }))} />
        </Field>
        {form.allDay ? (
          <Field label="Through" required>
            <TextInput type="date" value={form.through} min={form.date} onChange={(event) => set("through", event.target.value)} />
          </Field>
        ) : (
          <>
            <Field label="Starts" required>
              <TextInput type="time" value={form.from} onChange={(event) => set("from", event.target.value)} />
            </Field>
            <Field label="Ends" required hint={form.to && form.from && form.to <= form.from ? "Ends the next day." : undefined}>
              <TextInput type="time" value={form.to} onChange={(event) => set("to", event.target.value)} />
            </Field>
          </>
        )}
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">Times are on the company&apos;s clock ({timezone.replace(/_/g, " ")}).</p>

      {kind !== "unavailable" ? (
        <Field label="Where" hint="A room, an address or a call link.">
          <TextInput value={form.location} onChange={(event) => set("location", event.target.value)} maxLength={300} />
        </Field>
      ) : null}
      <Field label="Notes" hint="Seen by whoever may see this event. Keep gate codes and access details on the property.">
        <TextArea value={form.notes} onChange={(event) => set("notes", event.target.value)} rows={2} maxLength={2000} />
      </Field>
      {kind === "meeting" || kind === "appointment" || kind === "unavailable" ? (
        <CheckboxRow checked={form.private} onCheckedChange={(checked) => set("private", Boolean(checked))} title="Private" description="Others see only that the people on it are busy." />
      ) : null}

      {check && !check.ready && input ? <p className="text-sm text-muted-foreground">{check.problem}</p> : null}
      {hard.length > 0 ? (
        <div role="alert" className="grid gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="flex items-center gap-1.5 font-semibold text-destructive-foreground">
            <CircleAlertIcon className="size-4" aria-hidden />
            Conflicts
          </p>
          <ul className="grid gap-1 text-destructive-foreground">
            {hard.map((words) => (
              <li key={words}>{words}</li>
            ))}
          </ul>
          <Field label="Reason to save anyway" hint="Kept on the event with your name.">
            <TextInput value={form.override} onChange={(event) => set("override", event.target.value)} maxLength={500} />
          </Field>
        </div>
      ) : null}
      {check?.ready && check.warnings.length > 0 ? (
        <div className="grid gap-1 rounded-xl border border-warning/50 bg-warning/10 p-3 text-sm text-warning-foreground">
          {check.warnings.map((words) => (
            <p key={words} className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {words}
            </p>
          ))}
        </div>
      ) : null}
      {check?.ready && check.notes.length > 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {check.notes.join(" ")}
        </p>
      ) : null}

      <FormError message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton pending={busy}>{existing ? "Save changes" : hard.length > 0 ? "Save over conflicts" : "Save"}</SubmitButton>
      </div>
    </form>
  );
}
