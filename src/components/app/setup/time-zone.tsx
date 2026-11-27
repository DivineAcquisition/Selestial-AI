"use client";

/**
 * The company's clock, chosen by place: starts at the zone this browser reports, and is searched by city,
 * region or everyday name ("Central Time"). Used at company creation and in setup's essentials.
 */
import { useMemo } from "react";

import { SearchableSelect } from "@/components/ui/selection";
import { detectedTimeZone, timeZoneLabel, timeZoneSelectOptions } from "@/lib/app/timezones";

export function TimeZonePicker({ value, onChange, id, describedBy }: { value: string; onChange: (zone: string) => void; id?: string; describedBy?: string }) {
  const options = useMemo(() => timeZoneSelectOptions(value || undefined), [value]);
  return <SearchableSelect id={id} value={value} onValueChange={(zone) => onChange(zone ?? "")} options={options} placeholder="Search for your city or time zone" clearable={false} aria-describedby={describedBy} />;
}

/** "Detected from this device", when the chosen zone is the one the browser reports. */
export function zoneHint(value: string): string {
  const detected = detectedTimeZone();
  if (!value) return "Choose where your schedules, availability and deadlines run.";
  return detected === value ? `Detected from this device: ${timeZoneLabel(value)}. Change it if your business runs on another clock.` : `Schedules, availability and deadlines are shown on ${timeZoneLabel(value)}.`;
}
