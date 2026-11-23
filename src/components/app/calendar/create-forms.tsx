"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, FormError, TextInput, useRun } from "@/components/app/form";
import { Plus, Trash2 } from "@/components/icons";
import { Button, SubmitButton } from "@/components/ui/button";
import { Select } from "@/components/ui/selection";
import { zonedInstant } from "@/lib/app/format";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * An interview for an applicant who is waiting for one, through Recruiter's own scheduling step: the
 * interviewer's other interviews are checked and the applicant is sent the time, as from Interviews.
 */
export function InterviewForm({ day, onDone }: { day: string | null; onDone: () => void }) {
  const { companyId, timezone } = useCompany();
  const board = useQuery(api.interviews.board, { companyId });
  const options = useQuery(api.calendarEvents.options, { companyId });
  const schedule = useMutation(api.interviews.schedule);
  const { busy, error, run, setError } = useRun();
  const [form, setForm] = useState({ interviewId: "", interviewerId: "", date: day ?? "", from: "10:00", to: "10:30", how: "" });
  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const waiting = (board?.interviews ?? []).filter((row) => row.status === "awaiting_slots" || row.status === "proposed");
  if (board && waiting.length === 0) return <p className="text-sm text-muted-foreground">No applicant is waiting for an interview time. An interview starts in Recruiter, when a person decides to interview an applicant.</p>;
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const [startsAt, endsAt] = [zonedInstant(form.date, form.from, timezone), zonedInstant(form.date, form.to, timezone)];
        if (!form.interviewId || !form.interviewerId) return setError("Choose the applicant and the interviewer.");
        if (startsAt === null || endsAt === null) return setError("Choose the day, the start and the end.");
        void run(async () => {
          await schedule({ companyId, interviewId: form.interviewId as Id<"interviews">, interviewerId: form.interviewerId as Id<"members">, startsAt, endsAt, ...(form.how.trim() ? { how: form.how } : {}) });
          onDone();
        });
      }}
    >
      <Field label="Applicant" required hint="Applicants Recruiter is waiting to interview.">
        <Select value={form.interviewId} onValueChange={(value) => set("interviewId", value ?? "")} options={waiting.map((row) => ({ value: row.interviewId as string, label: row.applicant ?? "Applicant", meta: row.status === "proposed" ? "Times offered" : "Waiting for times" }))} searchable="auto" />
      </Field>
      <Field label="Interviewer" required>
        <Select value={form.interviewerId} onValueChange={(value) => set("interviewerId", value ?? "")} options={(options?.members ?? []).filter((row) => row.role !== "office").map((row) => ({ value: row.id as string, label: row.name }))} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Day" required>
          <TextInput type="date" value={form.date} onChange={(event) => set("date", event.target.value)} />
        </Field>
        <Field label="Starts" required>
          <TextInput type="time" value={form.from} onChange={(event) => set("from", event.target.value)} />
        </Field>
        <Field label="Ends" required>
          <TextInput type="time" value={form.to} onChange={(event) => set("to", event.target.value)} />
        </Field>
      </div>
      <Field label="How to join" hint="A phone number, an address or a call link. It goes in the applicant's confirmation.">
        <TextInput value={form.how} onChange={(event) => set("how", event.target.value)} maxLength={500} />
      </Field>
      <FormError message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton pending={busy}>Book the interview</SubmitButton>
      </div>
    </form>
  );
}

/** A dated task in an agent's queue. A due date reserves no time; it is shown as due, not booked. */
export function TaskForm({ day, onDone }: { day: string | null; onDone: () => void }) {
  const { companyId, timezone, role } = useCompany();
  const create = useMutation(api.tasks.create);
  const { busy, error, run, setError } = useRun();
  const manager = role === "owner" || role === "manager";
  const agents = [
    { value: "dispatch", label: "Dispatch" },
    ...(manager
      ? [
          { value: "sales", label: "Sales" },
          { value: "recruiter", label: "Recruiter" },
          { value: "retention", label: "Retention" },
          { value: "quality", label: "Quality" },
        ]
      : []),
  ];
  const [form, setForm] = useState({ agent: "dispatch", title: "", nextAction: "", done: "", date: day ?? "", time: "17:00" });
  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const dueAt = zonedInstant(form.date, form.time, timezone);
        if (dueAt === null) return setError("Choose when it is due.");
        void run(async () => {
          await create({ companyId, agent: form.agent as "dispatch", title: form.title, nextAction: form.nextAction, dueAt, completionCondition: form.done || form.title });
          onDone();
        });
      }}
    >
      <Field label="Whose queue" hint="The agent whose work it is. A person works it until that agent can.">
        <Select value={form.agent} onValueChange={(value) => set("agent", value ?? "dispatch")} options={agents} />
      </Field>
      <Field label="What it is" required>
        <TextInput value={form.title} onChange={(event) => set("title", event.target.value)} maxLength={200} />
      </Field>
      <Field label="Next step" required>
        <TextInput value={form.nextAction} onChange={(event) => set("nextAction", event.target.value)} maxLength={500} />
      </Field>
      <Field label="Done when" hint="Leave empty to use the title.">
        <TextInput value={form.done} onChange={(event) => set("done", event.target.value)} maxLength={500} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Due day" required>
          <TextInput type="date" value={form.date} onChange={(event) => set("date", event.target.value)} />
        </Field>
        <Field label="Due by" required>
          <TextInput type="time" value={form.time} onChange={(event) => set("time", event.target.value)} />
        </Field>
      </div>
      <FormError message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton pending={busy}>Add the task</SubmitButton>
      </div>
    </form>
  );
}

const toTime = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const toMinute = (time: string) => {
  const [hours, minutes] = time.split(":").map(Number);
  return Number.isNaN(hours) || Number.isNaN(minutes) ? null : hours * 60 + minutes;
};

/** A member's weekly working hours, used to warn when an event falls outside them. None set means no limit. */
export function MemberHoursForm({ onDone }: { onDone: () => void }) {
  const { companyId } = useCompany();
  const options = useQuery(api.calendarEvents.options, { companyId });
  const [memberId, setMemberId] = useState<string>("");
  const chosen = memberId || options?.me || "";
  const current = useQuery(api.calendarEvents.memberHours, chosen ? { companyId, memberId: chosen as Id<"members"> } : "skip");
  return (
    <div className="grid gap-3">
      <Field label="Whose hours">
        <Select value={chosen} onValueChange={(value) => setMemberId(value ?? "")} options={(options?.members ?? []).map((row) => ({ value: row.id as string, label: row.name }))} />
      </Field>
      {current ? <HoursEditor key={chosen} memberId={chosen as Id<"members">} initial={current} onDone={onDone} /> : null}
    </div>
  );
}

function HoursEditor({ memberId, initial, onDone }: { memberId: Id<"members">; initial: { weekday: number; startMinute: number; endMinute: number }[]; onDone: () => void }) {
  const { companyId } = useCompany();
  const save = useMutation(api.calendarEvents.setMemberHours);
  const { busy, error, run, setError } = useRun();
  const [rows, setRows] = useState(initial.map((row) => ({ weekday: String(row.weekday), from: toTime(row.startMinute), to: toTime(row.endMinute) })));
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const hours: { weekday: number; startMinute: number; endMinute: number }[] = [];
        for (const row of rows) {
          const [startMinute, endMinute] = [toMinute(row.from), toMinute(row.to)];
          if (startMinute === null || endMinute === null || endMinute <= startMinute) return setError("Each stretch needs an end after its start.");
          hours.push({ weekday: Number(row.weekday), startMinute, endMinute });
        }
        void run(async () => {
          await save({ companyId, memberId, hours });
          onDone();
        });
      }}
    >
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">No hours set. Calendar then warns about nobody&apos;s hours for this person; add stretches to have it check.</p> : null}
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-[1fr_6.5rem_6.5rem_auto] items-end gap-2">
          <Select aria-label="Day" value={row.weekday} onValueChange={(value) => setRows((before) => before.map((entry, at) => (at === index ? { ...entry, weekday: value ?? "1" } : entry)))} options={WEEKDAYS.map((name, weekday) => ({ value: String(weekday), label: name }))} density="compact" />
          <TextInput aria-label="From" type="time" value={row.from} onChange={(changed) => setRows((before) => before.map((entry, at) => (at === index ? { ...entry, from: changed.target.value } : entry)))} />
          <TextInput aria-label="To" type="time" value={row.to} onChange={(changed) => setRows((before) => before.map((entry, at) => (at === index ? { ...entry, to: changed.target.value } : entry)))} />
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove this stretch" onClick={() => setRows((before) => before.filter((_, at) => at !== index))}>
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => setRows((before) => [...before, { weekday: "1", from: "09:00", to: "17:00" }])}>
          <Plus aria-hidden />
          Add a stretch
        </Button>
      </div>
      <FormError message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton pending={busy}>Save hours</SubmitButton>
      </div>
    </form>
  );
}
