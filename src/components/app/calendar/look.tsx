"use client";

/**
 * How Calendar draws an item. One restrained hue per layer, so a glance separates visits from hiring
 * from sales; the kind of time (booked, proposed, projected, due, availability) is told by the shape of
 * the block and by words, never by color alone. Status is always written out.
 */
import type { FunctionReturnType } from "convex/server";

import { CircleDashed, Clock, Flag, Hourglass, TriangleAlert, UserCheckIcon, Users } from "@/components/icons";
import { clock } from "@/lib/app/format";
import type { LayerId } from "@/lib/app/calendar";
import { cn } from "@/lib/utils";

import type { api } from "../../../../convex/_generated/api";

export type CalendarData = FunctionReturnType<typeof api.calendar.range>;
export type Item = CalendarData["items"][number];

/** The layer's hue, as a small swatch and as the tint of a block. */
export const LAYER_LOOK: Record<LayerId, { swatch: string; block: string; edge: string }> = {
  jobs: { swatch: "bg-brand-500", block: "bg-brand-500/12 text-strong hover:bg-brand-500/18", edge: "border-l-brand-500" },
  hiring: { swatch: "bg-sky-500", block: "bg-sky-500/12 text-strong hover:bg-sky-500/18", edge: "border-l-sky-500" },
  sales: { swatch: "bg-teal-500", block: "bg-teal-500/12 text-strong hover:bg-teal-500/18", edge: "border-l-teal-500" },
  quality: { swatch: "bg-amber-500", block: "bg-amber-500/12 text-strong hover:bg-amber-500/18", edge: "border-l-amber-500" },
  business: { swatch: "bg-pink-500", block: "bg-pink-500/12 text-strong hover:bg-pink-500/18", edge: "border-l-pink-500" },
  availability: { swatch: "bg-muted-foreground/50", block: "text-strong/70 hover:text-strong", edge: "border-l-muted-foreground/40" },
  deadlines: { swatch: "bg-foreground/60", block: "bg-card text-strong hover:bg-muted", edge: "border-l-foreground/40" },
  external: { swatch: "bg-muted-foreground/40", block: "text-strong/70", edge: "border-l-muted-foreground/30" },
};

/** Hatching for time that is not working time: someone's time off, a busy block. */
export const HATCH = "bg-[repeating-linear-gradient(135deg,transparent_0_6px,color-mix(in_oklab,var(--color-muted-foreground)_16%,transparent)_6px_7px)]";

/**
 * Secondary words inside a block or on a muted ground. The plain muted color falls under 4.5:1 on the
 * layers' tints (WCAG 1.4.3), so these read as the strong color, softened.
 */
export const QUIET = "text-strong/70";

/** The block's outline by the kind of time it is. Never faded with opacity: that takes the words under 4.5:1 too. */
export function timingClass(item: Pick<Item, "timing" | "status">): string {
  if (item.timing === "projected") return "border border-dashed border-current/25 border-l-2 bg-transparent";
  if (item.timing === "proposed") return "border border-dashed border-l-2";
  if (item.timing === "availability") return cn("border border-border/70 border-l-2", HATCH);
  if (item.timing === "due") return "border border-border border-l-2";
  return item.status === "cancelled" ? "border border-border border-l-2 bg-transparent text-strong/70 line-through" : "border border-transparent border-l-2";
}

export function blockClass(item: Item): string {
  const look = LAYER_LOOK[item.layer as LayerId];
  return cn(look.block, look.edge, timingClass(item));
}

/** A small icon that says what kind of time it is, read aloud with the status. */
export function TimingMark({ item, className }: { item: Pick<Item, "timing" | "problems">; className?: string }) {
  const Icon = item.problems.length > 0 ? TriangleAlert : item.timing === "due" ? Flag : item.timing === "projected" ? CircleDashed : item.timing === "proposed" ? Hourglass : item.timing === "availability" ? Clock : null;
  if (!Icon) return null;
  return <Icon className={cn("size-3 shrink-0", item.problems.length > 0 ? "text-destructive-foreground" : QUIET, className)} aria-hidden />;
}

export const TIMING_WORDS: Record<Item["timing"], string> = {
  appointment: "Booked",
  proposed: "Proposed, not confirmed",
  due: "Due date, no time reserved",
  availability: "Availability",
  projected: "Projected, not booked",
};

/** The time as a person reads it: an arrival window as a window, a due time as "due". */
export function timeLabel(item: Pick<Item, "startsAt" | "endsAt" | "arrivalEndsAt" | "allDay" | "timing">, timezone: string): string {
  if (item.allDay) return "All day";
  if (item.timing === "due") return `Due ${clock(item.startsAt, timezone)}`;
  if (item.arrivalEndsAt) return `Arrive ${clock(item.startsAt, timezone)}–${clock(item.arrivalEndsAt, timezone)}`;
  return `${clock(item.startsAt, timezone)}–${clock(item.endsAt, timezone)}`;
}

/** Everything a screen reader needs about an item in one sentence. */
export function itemLabel(item: Item, timezone: string): string {
  const who = item.resources.filter((row) => row.kind === "cleaner").map((row) => `${row.name}${row.state === "offered" ? " (offered)" : ""}`);
  return [item.title, item.detail, timeLabel(item, timezone), item.statusLabel, item.timing === "appointment" ? null : TIMING_WORDS[item.timing], who.length ? `Crew: ${who.join(", ")}` : null, item.problems.length ? `Needs attention: ${item.problems.join("; ")}` : null].filter(Boolean).join(". ");
}

/** The crew line for a visit: who accepted, who has an offer, how many places. */
export function CrewLine({ item, className }: { item: Item; className?: string }) {
  const crew = item.resources.filter((row) => row.kind === "cleaner");
  const people = item.resources.filter((row) => row.kind === "member");
  // Nobody on a visit is already in its status and its problems; it is not said a third time.
  if (crew.length === 0 && people.length === 0) return null;
  const Icon = crew.length > 0 ? Users : UserCheckIcon;
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      <Icon className="size-3 shrink-0 opacity-70" aria-hidden />
      <span className="truncate">{[...crew.map((row) => (row.state === "offered" ? `${row.name}?` : row.name)), ...people.map((row) => row.name)].join(", ")}</span>
    </span>
  );
}

