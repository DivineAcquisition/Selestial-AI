"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, FormError, TextInput, useRun } from "@/components/app/form";
import { ArrowRight, CircleAlertIcon, Info } from "@/components/icons";
import { Button, SubmitButton } from "@/components/ui/button";
import { CheckboxRow, RadioGroup } from "@/components/ui/selection";
import { clock, dayName, durationLabel, localDate, localTime, zonedInstant } from "@/lib/app/format";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { EventForm, type EventKind } from "./event-form";
import type { Item } from "./look";

type Scope = "this" | "following" | "series";
type Outcome = { saved: string; notice: string | null };

const when = (at: number, timezone: string) => `${dayName(at, timezone)}, ${clock(at, timezone)}`;

/**
 * Moving a visit, with everything the move touches shown first: the old and new time, what stops it,
 * what the client was promised, each cleaner and what happens to them, the client notice, and for a
 * recurring visit whether it is this one, this and the following, or every upcoming one. The times can
 * be typed here, so the move never needs a mouse.
 */
export function MoveVisitDialog({ item, proposed, onDone }: { item: Item; proposed: { startsAt: number; endsAt: number }; onDone: () => void }) {
  const { companyId, timezone } = useCompany();
  const jobId = item.source.id as Id<"jobs">;
  const [date, setDate] = useState(localDate(proposed.startsAt, timezone));
  const [from, setFrom] = useState(localTime(proposed.startsAt, timezone));
  const length = proposed.endsAt - proposed.startsAt;
  const [minutes, setMinutes] = useState(String(Math.round(length / 60_000)));
  const startsAt = zonedInstant(date, from, timezone);
  const endsAt = startsAt === null || !Number(minutes) ? null : startsAt + Number(minutes) * 60_000;
  const preview = useQuery(api.calendarMoves.previewVisit, startsAt !== null && endsAt !== null ? { companyId, jobId, startsAt, endsAt } : "skip");
  const [scope, setScope] = useState<Scope>("this");
  const [tellClient, setTellClient] = useState(true);
  const [quiet, setQuiet] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const moveVisit = useMutation(api.calendarMoves.moveVisit);
  const changeSeries = useMutation(api.servicePlans.changeSeries);
  const changeFuture = useMutation(api.plans.changeFuture);
  const series = preview?.series ?? null;
  const seriesFrom = series ? (scope === "series" ? series.today : series.date) : null;
  const affected = useQuery(api.servicePlans.affected, series?.system === "service" && scope !== "this" && seriesFrom ? { companyId, planId: series.planId as Id<"servicePlans">, from: seriesFrom } : "skip");
  const salesPreview = useQuery(api.plans.changePreview, series?.system === "sales" && scope !== "this" && seriesFrom ? { companyId, planId: series.planId as Id<"recurringPlans">, effectiveFrom: seriesFrom } : "skip");
  const { busy, error, run, setError } = useRun();
  const seriesAllowed = Boolean(series?.running && series.sameWeekday);
  /** A company-calendar date in words: "Tue, Mar 2". */
  const dateWords = (date: string) => {
    const at = zonedInstant(date, "12:00", timezone);
    return at === null ? date : dayName(at, timezone);
  };

  if (outcome) {
    return (
      <div className="grid gap-3">
        <p className="text-sm font-medium text-strong">{outcome.saved}</p>
        {outcome.notice ? <p className="text-sm text-muted-foreground">{outcome.notice}</p> : null}
        <div className="flex justify-end">
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  const blocking = preview?.blocking ?? [];
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!preview || startsAt === null || endsAt === null) return setError("Choose the new day, time and length.");
        if (scope === "this") {
          void run(async () => {
            const result = await moveVisit({ companyId, jobId, startsAt, endsAt, version: preview.plan.version, notifyCustomer: tellClient && preview.customerNotice.ready, quiet: [...quiet] as Id<"assignments">[], ...(reason.trim() ? { reason } : {}) });
            setOutcome({
              saved: `Moved to ${when(startsAt, timezone)}. ${result.askedAgain ? `${result.askedAgain} asked to confirm the new time. ` : ""}${result.placesReopened ? `${result.placesReopened} place${result.placesReopened === 1 ? "" : "s"} reopened for Dispatch to fill.` : ""}`,
              notice: result.customerNotice.status === "queued" ? `The client notice is on its way: ${result.customerNotice.words.toLowerCase()}. Delivery shows in the client's conversations.` : result.customerNotice.status === "not_sent" ? `The move is saved, but the client was not told: ${result.customerNotice.words}` : "The client was not told from here.",
            });
          });
          return;
        }
        if (!series || !seriesFrom) return;
        void run(async () => {
          if (series.system === "service") {
            if (!affected) throw new Error("not ready");
            await changeSeries({ companyId, planId: series.planId as Id<"servicePlans">, expectedRevision: affected.revision, from: seriesFrom, shown: affected.visits.map((row) => row.id), startTime: "startTime" in series ? series.startTime : localTime(startsAt, timezone) });
          } else {
            await changeFuture({ companyId, planId: series.planId as Id<"recurringPlans">, effectiveFrom: seriesFrom, arrivalMinute: "arrivalMinute" in series ? series.arrivalMinute : 0, reason: reason.trim() || "Moved in Calendar." });
          }
          setOutcome({ saved: `The series now starts at ${clock(startsAt, timezone)} from ${dateWords(seriesFrom)}. Visits are booked again by the plan; Dispatch staffs them as usual.`, notice: "Clients and crews are not messaged by a series change. Tell the client about the new time yourself, or from their conversations." });
        });
      }}
    >
      <div className="grid gap-1 rounded-xl border border-border bg-muted/40 p-3 text-sm">
        <p className="font-semibold text-strong">{item.title}</p>
        <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>{when(item.startsAt, timezone)}</span>
          <ArrowRight className="size-3.5" aria-label="to" />
          <span className="font-medium text-strong">{startsAt !== null ? when(startsAt, timezone) : "…"}</span>
          {endsAt !== null && startsAt !== null ? <span>· {durationLabel(endsAt - startsAt)}</span> : null}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Day">
          <TextInput type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </Field>
        <Field label="Starts">
          <TextInput type="time" value={from} onChange={(event) => setFrom(event.target.value)} />
        </Field>
        <Field label="Minutes">
          <TextInput type="number" min={15} max={1440} step={15} value={minutes} onChange={(event) => setMinutes(event.target.value)} />
        </Field>
      </div>

      {series ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium text-strong">This is one visit of a recurring plan</legend>
          <RadioGroup
            aria-label="What to move"
            value={scope}
            onValueChange={(value) => setScope(value)}
            options={[
              { value: "this", label: "This visit only", description: "The plan and its other visits stay as they are." },
              { value: "following", label: "This and following visits", description: seriesAllowed ? `From ${dateWords(series.date)}, every visit starts at ${series.time}. Earlier and completed visits, and their prices, stay as they are.` : "Not here: the series can change its time of day from Calendar, not its weekday. Change the plan itself for that.", disabled: !seriesAllowed },
              { value: "series", label: "Every upcoming visit", description: seriesAllowed ? `From today, every visit not yet done starts at ${series.time}. Completed visits and their prices stay as they are.` : "Not here, for the same reason.", disabled: !seriesAllowed },
            ]}
          />
          {scope !== "this" && series.system === "service" && affected ? <p className="text-xs text-muted-foreground">{affected.visits.length} booked {affected.visits.length === 1 ? "visit is" : "visits are"} replaced at the new time. Their crews are handled as when a plan visit is cancelled.</p> : null}
          {scope !== "this" && series.system === "sales" && salesPreview ? <p className="text-xs text-muted-foreground">{salesPreview.replaced.length} booked {salesPreview.replaced.length === 1 ? "visit is" : "visits are"} replaced. {salesPreview.keeps}</p> : null}
        </fieldset>
      ) : null}

      {preview === undefined && startsAt !== null ? <p className="text-sm text-muted-foreground">Checking what the move touches…</p> : null}
      {blocking.length > 0 ? (
        <div role="alert" className="grid gap-1 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-foreground">
          {blocking.map((words) => (
            <p key={words} className="flex items-start gap-1.5">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              {words}
            </p>
          ))}
        </div>
      ) : null}

      {preview && scope === "this" ? (
        <>
          <div className="grid gap-1.5">
            <h3 className="text-sm font-medium text-strong">What the client was promised</h3>
            <ul className="grid gap-1 text-sm text-muted-foreground">
              {preview.commitments.map((words) => (
                <li key={words}>{words}</li>
              ))}
            </ul>
          </div>
          {preview.crewNotices.length > 0 ? (
            <div className="grid gap-1.5">
              <h3 className="text-sm font-medium text-strong">Crew</h3>
              {preview.crewNotices.map((row) =>
                row.optional ? (
                  <CheckboxRow
                    key={row.assignmentId}
                    checked={!quiet.has(row.assignmentId)}
                    onCheckedChange={(checked) =>
                      setQuiet((before) => {
                        const next = new Set(before);
                        if (checked) next.delete(row.assignmentId);
                        else next.add(row.assignmentId);
                        return next;
                      })
                    }
                    title={`Text ${row.name}`}
                    description={row.words}
                  />
                ) : (
                  <p key={row.assignmentId} className="text-sm text-muted-foreground">
                    {row.words}
                  </p>
                ),
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Nobody is on this visit yet, so no cleaner is affected.</p>
          )}
          <div className="grid gap-1.5">
            <h3 className="text-sm font-medium text-strong">Client</h3>
            <CheckboxRow checked={tellClient && preview.customerNotice.ready} disabled={!preview.customerNotice.ready} onCheckedChange={(checked) => setTellClient(Boolean(checked))} title="Tell the client" description={preview.customerNotice.words} />
          </div>
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {preview.travel}
          </p>
          <Field label="Reason" hint="Optional. Kept in the visit's history.">
            <TextInput value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
          </Field>
        </>
      ) : null}

      <FormError message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton pending={busy} disabled={!preview || blocking.length > 0 || (scope !== "this" && !seriesAllowed)}>
          {scope === "this" ? "Move the visit" : scope === "following" ? "Move this and following" : "Move every upcoming visit"}
        </SubmitButton>
      </div>
    </form>
  );
}

/** Moving one of Calendar's own events: its edit form, opened at the new time, with the same conflict check before it saves. */
export function MoveEventDialog({ eventId, proposed, onDone }: { eventId: Id<"calendarEvents">; proposed: { startsAt: number; endsAt: number }; onDone: () => void }) {
  const { companyId } = useCompany();
  const event = useQuery(api.calendarEvents.get, { companyId, eventId });
  if (event === undefined) return <p className="text-sm text-muted-foreground">Loading the event…</p>;
  if (!event.visible) return <p className="text-sm text-muted-foreground">This is someone else&apos;s private event, so it can&apos;t be moved from here.</p>;
  if (event.status !== "scheduled") return <p className="text-sm text-muted-foreground">This event is {event.status}, so it can&apos;t be moved.</p>;
  return (
    <EventForm
      kind={event.kind as EventKind}
      moveTo={proposed}
      existing={{ ...event, kind: event.kind as EventKind, lead: event.lead ? (event.lead.kind === "member" ? { kind: "member", id: event.lead.id as Id<"members"> } : { kind: "cleaner", id: event.lead.id as Id<"cleaners"> }) : null, qualityCase: event.qualityCase ? { id: event.qualityCase.id } : null }}
      onDone={onDone}
    />
  );
}
