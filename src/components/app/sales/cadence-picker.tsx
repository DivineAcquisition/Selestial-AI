"use client";


import { cadenceLabel, cadenceProblem, weekdayOf, type Cadence } from "../../../../convex/lib/sales/cadence";
import { WEEKDAYS } from "./kit";

import { ChoiceChips, SegmentedControl, Select } from "@/components/ui/selection";

const CADENCES: { kind: Cadence["kind"]; label: string }[] = [
  { kind: "weekly", label: "Weekly" },
  { kind: "every_2_weeks", label: "Every 2 weeks" },
  { kind: "every_4_weeks", label: "Every 4 weeks" },
  { kind: "monthly", label: "Monthly" },
  { kind: "twice_monthly", label: "Twice a month" },
];

export function defaultCadence(kind: Cadence["kind"], date: string | undefined): Cadence {
  const weekday = date ? weekdayOf(date) : 2;
  const day = date ? Number(date.slice(8, 10)) : 1;
  switch (kind) {
    case "weekly":
      return { kind, weekdays: [weekday] };
    case "every_2_weeks":
    case "every_4_weeks":
      return { kind, weekday };
    case "monthly":
      return { kind, dayOfMonth: day };
    case "twice_monthly":
      return { kind, days: day <= 14 ? [day, day + 14] : [day - 14, day] };
  }
}

const DAY_OF_MONTH = [...Array.from({ length: 28 }, (_, i) => i + 1), 29, 30, 31, 0];
const dayWord = (d: number) => (d === 0 ? "Last day" : String(d));

/** How often: each cadence is its own choice, so every 4 weeks is never monthly and every 2 weeks never twice a month. */
export function CadencePicker({ cadence, onChange, anchorDate }: { cadence: Cadence | undefined; onChange: (cadence: Cadence) => void; anchorDate?: string }) {
  return (
    <div className="grid gap-3">
      <SegmentedControl label="How often" value={cadence?.kind ?? null} onChange={(kind) => onChange(defaultCadence(kind, anchorDate))} options={CADENCES.map((option) => ({ id: option.kind, label: option.label }))} />
      {cadence?.kind === "weekly" ? (
        <div className="flex flex-wrap gap-1.5">
          <ChoiceChips aria-label="Days of the week" density="compact" options={WEEKDAYS.map((label, day) => ({ value: String(day), label }))} value={cadence.weekdays.map(String)} onValueChange={(next) => onChange({ kind: "weekly", weekdays: next.map(Number).sort((a, b) => a - b) })} />
          <span className="self-center text-xs text-muted-foreground">Several days make several visits a week.</span>
        </div>
      ) : null}
      {cadence?.kind === "every_2_weeks" || cadence?.kind === "every_4_weeks" ? (
        <label className="grid max-w-56 gap-1.5 text-sm">
          <span className="font-medium text-strong">Day of the week</span>
          <Select value={String(cadence.weekday)} onValueChange={(next) => onChange({ ...cadence, weekday: Number(next ?? "") })} options={WEEKDAYS.map((label, day) => ({ value: String(day), label: label }))} />
        </label>
      ) : null}
      {cadence?.kind === "monthly" ? (
        <label className="grid max-w-56 gap-1.5 text-sm">
          <span className="font-medium text-strong">Day of the month</span>
          <Select value={String(cadence.dayOfMonth)} onValueChange={(next) => onChange({ kind: "monthly", dayOfMonth: Number(next ?? "") })} options={DAY_OF_MONTH.map((d) => ({ value: String(d), label: dayWord(d) }))} />
        </label>
      ) : null}
      {cadence?.kind === "twice_monthly" ? (
        <div className="flex flex-wrap gap-3">
          {[0, 1].map((i) => (
            <label key={i} className="grid w-40 gap-1.5 text-sm">
              <span className="font-medium text-strong">{i === 0 ? "First day" : "Second day"}</span>
              <Select value={String(cadence.days[i] ?? 1)} onValueChange={(next) => onChange({ kind: "twice_monthly", days: cadence.days.map((d, j) => (j === i ? Number(next ?? "") : d)) })} options={DAY_OF_MONTH.map((d) => ({ value: String(d), label: dayWord(d) }))} />
            </label>
          ))}
        </div>
      ) : null}
      {cadence && cadenceProblem(cadence) ? <p className="text-sm text-destructive-foreground">{cadenceProblem(cadence)}</p> : cadence ? <p className="text-xs text-muted-foreground">{cadenceLabel(cadence)}</p> : null}
    </div>
  );
}
