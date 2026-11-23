"use client";

import { Fragment, useId, useRef, useState } from "react";

import { Block, Lane } from "@/components/app/screens/dispatch/schedule";
import { Flag, TriangleAlert } from "@/components/icons";
import { cellLabel, hoursFor, isToday, minuteOf, monthOf, placeInDay, type Range } from "@/lib/app/calendar";
import { clock, localDate, longDay } from "@/lib/app/format";
import { cn } from "@/lib/utils";

import { blockClass, CrewLine, HATCH, itemLabel, LAYER_LOOK, QUIET, timeLabel, TimingMark, type CalendarData, type Item } from "./look";

type Open = (item: Item) => void;

const HOUR_LABEL = (minute: number) => {
  const hour = Math.floor(minute / 60) % 24;
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? "AM" : "PM"}`;
};

/** Things with a date but no reserved time, and whole days away, sit above the hours, not in them. */
export function isStrip(item: Item): boolean {
  return item.allDay !== null || item.timing === "due" || (item.timing === "availability" && item.endsAt - item.startsAt >= 20 * 3_600_000);
}

const inDay = (item: Item, from: number, to: number) => item.startsAt < to && Math.max(item.endsAt, item.startsAt + 1) > from;

function StripChip({ item, timezone, onOpen }: { item: Item; timezone: string; onOpen: Open }) {
  return (
    <button type="button" onClick={() => onOpen(item)} aria-label={itemLabel(item, timezone)} className={cn("flex w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[11px] leading-tight focus-visible:outline-2 focus-visible:outline-brand-500", blockClass(item))}>
      {item.timing === "due" ? <Flag className="size-3 shrink-0 opacity-70" aria-hidden /> : <TimingMark item={item} />}
      <span className="min-w-0 truncate font-medium">{item.timing === "due" && !item.allDay ? `${clock(item.startsAt, timezone)} ` : ""}{item.title}</span>
    </button>
  );
}

// ── Week and Day ────────────────────────────────────────────────────────────────────────────────────

/**
 * Days as columns and the hours down the side. Booked and proposed time is placed by its start and end;
 * overlapping items share the width. Availability (time off, busy) is drawn behind as hatching, so it
 * never squeezes a visit.
 */
export type Move = (item: Item, to: { startsAt: number; endsAt: number }) => void;

const SNAP = 15;
const MINUTE_MS = 60_000;

/**
 * Days as columns and the hours down the side. Booked and proposed time is placed by its start and end;
 * overlapping items share the width. Availability (time off, busy) is drawn behind as hatching, so it
 * never squeezes a visit.
 *
 * An item the person may move can be dragged to another time or day, or its bottom edge dragged to change
 * its length, in 15-minute steps. With the keyboard: Alt+Up/Down moves it 15 minutes, Alt+Left/Right a day,
 * Alt+Shift+Up/Down changes its length. Nothing is saved by dragging: it opens the move, which shows
 * what the change does first.
 */
export function TimeGrid({ range, items, timezone, now, onOpen, dense, canMove, onMove }: { range: Range; items: Item[]; timezone: string; now: number; onOpen: Open; dense: boolean; canMove?: (item: Item) => boolean; onMove?: Move }) {
  const [drag, setDrag] = useState<{ key: string; mode: "move" | "resize"; startX: number; startY: number; columnWidth: number; minutes: number; days: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const moveHint = useId();
  const days = range.days.map((from, index) => ({ from, to: range.days[index + 1] ?? range.to }));
  const strip = items.filter(isStrip);
  const timed = items.filter((item) => !isStrip(item));
  const placedByDay = days.map((day) => ({
    front: placeInDay(timed.filter((item) => item.timing !== "availability"), day.from, day.to, timezone, dense ? 25 : 20),
    back: placeInDay(timed.filter((item) => item.timing === "availability"), day.from, day.to, timezone, 15).map((row) => ({ ...row, column: 0, columns: 1 })),
  }));
  // A visit continuing from the night before is drawn from the top; it does not pull the grid back to midnight.
  const { first, last } = hoursFor(placedByDay.flatMap((day) => [...day.front, ...day.back]).filter((row) => !row.continuesBefore));
  const perHour = days.length === 1 ? 64 : 52;
  const height = ((last - first) / 60) * perHour;
  const y = (minute: number) => ((Math.min(Math.max(minute, first), last) - first) / 60) * perHour;
  const hours = Array.from({ length: (last - first) / 60 }, (_, index) => first + index * 60);
  const cols = days.length === 1 ? "grid-cols-[3.5rem_1fr]" : "grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]";

  return (
    <div className="overflow-x-auto">
      <p id={moveHint} className="sr-only">
        Drag, or press Alt with the arrow keys, to move it. Alt with Shift and the up or down arrow changes its length. Nothing is saved until you confirm.
      </p>
      <div className={cn(days.length > 1 && "min-w-[52rem]")}>
        <div className={cn("sticky top-0 z-10 grid border-b border-border bg-card", cols)}>
          <div className="border-r border-border px-1 py-2 text-[10px] leading-tight text-muted-foreground" title="Times are shown on the company's clock">
            {new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" }).formatToParts(new Date(range.from)).find((part) => part.type === "timeZoneName")?.value}
          </div>
          {days.map((day) => {
            const today = isToday(day.from, now, timezone);
            return (
              <div key={day.from} className="border-r border-border/60 px-2 py-1.5 last:border-r-0">
                <p className={cn("text-[11px] font-semibold tracking-wide uppercase", today ? "text-brand-300" : "text-muted-foreground")}>{new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(new Date(day.from))}</p>
                <p className={cn("text-lg leading-tight font-semibold tabular-nums", today ? "text-brand-300" : "text-strong")}>
                  {today ? <span className="sr-only">Today, </span> : null}
                  {Number(localDate(day.from, timezone).slice(8))}
                </p>
              </div>
            );
          })}
        </div>

        {strip.length > 0 ? (
          <div className={cn("grid border-b border-border bg-muted/30", cols)}>
            <div className="border-r border-border px-1 py-1.5 text-[10px] text-muted-foreground">All day · due</div>
            {days.map((day) => (
              <div key={day.from} className="grid content-start gap-0.5 border-r border-border/60 p-1 last:border-r-0">
                {strip.filter((item) => inDay(item, day.from, day.to)).map((item) => (
                  <StripChip key={item.key} item={item} timezone={timezone} onOpen={onOpen} />
                ))}
              </div>
            ))}
          </div>
        ) : null}

        <div className={cn("relative grid", cols)} style={{ height }}>
          <div className="relative border-r border-border">
            {hours.map((minute) => (
              <span key={minute} className="absolute right-1.5 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums first:translate-y-0" style={{ top: y(minute) }}>
                {minute === first ? "" : HOUR_LABEL(minute)}
              </span>
            ))}
          </div>
          {days.map((day, index) => {
            const today = isToday(day.from, now, timezone);
            const nowMinute = today ? minuteOf(now, day.from, timezone) : null;
            return (
              <div key={day.from} className={cn("relative border-r border-border/60 last:border-r-0", today && "bg-brand-500/[0.03]")} role="group" aria-label={longDay(day.from, timezone)}>
                {hours.slice(1).map((minute) => (
                  <span key={minute} aria-hidden className="absolute inset-x-0 border-t border-border/50" style={{ top: y(minute) }} />
                ))}
                {placedByDay[index].back.map((row) => (
                  <button
                    key={row.item.key}
                    type="button"
                    onClick={() => onOpen(row.item)}
                    aria-label={itemLabel(row.item, timezone)}
                    className={cn("absolute inset-x-0 flex flex-col justify-start overflow-hidden border-y border-border/40 px-1 text-left text-[10px] text-strong/70 focus-visible:outline-2 focus-visible:outline-brand-500", HATCH)}
                    style={{ top: y(row.top), height: Math.max(y(row.bottom) - y(row.top), 12) }}
                  >
                    <span className="block truncate">{row.item.title}</span>
                  </button>
                ))}
                {placedByDay[index].front.map((row) => {
                  const item = row.item;
                  const movable = Boolean(onMove && canMove?.(item)) && !row.continuesBefore;
                  const dragging = drag?.key === item.key ? drag : null;
                  const top = y(row.top);
                  const tall = y(row.bottom) - top + (dragging?.mode === "resize" ? (dragging.minutes / 60) * perHour : 0);
                  const width = 100 / row.columns;
                  const finish = (mode: "move" | "resize", minutes: number, dayShift: number) => {
                    const target = Math.min(Math.max(index + dayShift, 0), days.length - 1);
                    const shift = days[target].from - days[index].from;
                    if (mode === "resize") onMove?.(item, { startsAt: item.startsAt, endsAt: Math.max(item.startsAt + SNAP * MINUTE_MS, item.endsAt + minutes * MINUTE_MS) });
                    else onMove?.(item, { startsAt: item.startsAt + shift + minutes * MINUTE_MS, endsAt: item.endsAt + shift + minutes * MINUTE_MS });
                  };
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => {
                        if (suppressClick.current) {
                          suppressClick.current = false;
                          return;
                        }
                        onOpen(item);
                      }}
                      onPointerDown={(event) => {
                        if (!movable || event.button !== 0) return;
                        const column = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width;
                        const rect = event.currentTarget.getBoundingClientRect();
                        const mode = event.clientY > rect.bottom - 8 ? "resize" : "move";
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setDrag({ key: item.key, mode, startX: event.clientX, startY: event.clientY, columnWidth: column, minutes: 0, days: 0, moved: false });
                      }}
                      onPointerMove={(event) => {
                        if (!dragging) return;
                        const minutes = Math.round(((event.clientY - dragging.startY) / perHour) * 60 / SNAP) * SNAP;
                        const dayShift = dragging.mode === "move" ? Math.round((event.clientX - dragging.startX) / dragging.columnWidth) : 0;
                        const moved = dragging.moved || Math.abs(event.clientY - dragging.startY) > 4 || Math.abs(event.clientX - dragging.startX) > 4;
                        if (minutes !== dragging.minutes || dayShift !== dragging.days || moved !== dragging.moved) setDrag({ ...dragging, minutes, days: dayShift, moved });
                      }}
                      onPointerUp={() => {
                        if (!dragging) return;
                        setDrag(null);
                        if (!dragging.moved) return;
                        suppressClick.current = true;
                        if (dragging.minutes !== 0 || dragging.days !== 0) finish(dragging.mode, dragging.minutes, dragging.days);
                      }}
                      onPointerCancel={() => setDrag(null)}
                      onKeyDown={(event) => {
                        if (!movable || !event.altKey) return;
                        const step = { ArrowUp: -SNAP, ArrowDown: SNAP } as Record<string, number>;
                        if (event.key in step) {
                          event.preventDefault();
                          finish(event.shiftKey ? "resize" : "move", step[event.key], 0);
                        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                          event.preventDefault();
                          finish("move", 0, event.key === "ArrowLeft" ? -1 : 1);
                        }
                      }}
                      aria-label={itemLabel(item, timezone)}
                      aria-keyshortcuts={movable ? "Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined}
                      aria-describedby={movable ? moveHint : undefined}
                      className={cn(
                        "absolute flex flex-col items-stretch justify-start overflow-hidden rounded-md px-1.5 py-1 text-left text-[11px] leading-tight shadow-[0_1px_0_rgba(0,0,0,0.04)] focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-brand-500",
                        blockClass(item),
                        item.problems.length > 0 && "ring-1 ring-destructive/50",
                        row.continuesBefore && "rounded-t-none",
                        row.continuesAfter && "rounded-b-none",
                        movable && "cursor-grab touch-none after:absolute after:inset-x-2 after:bottom-0.5 after:h-1 after:cursor-ns-resize after:rounded-full hover:after:bg-foreground/15",
                        dragging?.moved && "z-30 cursor-grabbing opacity-90 shadow-lg ring-2 ring-brand-500",
                      )}
                      style={{
                        top: top + 1,
                        height: Math.max(tall - 2, 18),
                        left: `calc(${row.column * width}% + 2px)`,
                        width: `calc(${width}% - 4px)`,
                        ...(dragging?.mode === "move" && dragging.moved ? { transform: `translate(${dragging.days * dragging.columnWidth}px, ${(dragging.minutes / 60) * perHour}px)` } : {}),
                      }}
                    >
                      <span className="flex min-w-0 items-center gap-1 font-semibold">
                        <TimingMark item={item} />
                        <span className="truncate">{item.title}</span>
                      </span>
                      {tall >= 34 ? <span className={cn("block truncate", QUIET)}>{timeLabel(item, timezone)}</span> : null}
                      {tall >= 50 && item.detail ? <span className={cn("block truncate", QUIET)}>{item.detail}</span> : null}
                      {tall >= 64 ? <CrewLine item={item} className={QUIET} /> : null}
                      {tall >= 78 ? <span className="block truncate font-medium">{item.statusLabel}</span> : null}
                    </button>
                  );
                })}
                {nowMinute !== null && nowMinute >= first && nowMinute <= last ? (
                  <span aria-hidden className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-brand-500" style={{ top: y(nowMinute) }}>
                    <span className="absolute -top-[5px] -left-[5px] size-2 rounded-full bg-brand-500" />
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Month ───────────────────────────────────────────────────────────────────────────────────────────

const MONTH_LIMIT = 3;

export function MonthGrid({ range, items, timezone, now, onOpen, onDay }: { range: Range; items: Item[]; timezone: string; now: number; onOpen: Open; onDay: (date: string) => void }) {
  const weeks = Array.from({ length: range.days.length / 7 }, (_, index) => range.days.slice(index * 7, index * 7 + 7));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] table-fixed border-collapse">
        <thead>
          <tr>
            {weeks[0].map((day) => (
              <th key={day} scope="col" className="border-b border-border px-2 py-1.5 text-left text-[11px] font-semibold tracking-wide text-strong/70 uppercase">
                {new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(new Date(day))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((day) => {
                const next = range.days[range.days.indexOf(day) + 1] ?? range.to;
                const mine = items.filter((item) => inDay(item, day, next) && item.timing !== "availability");
                const away = items.filter((item) => inDay(item, day, next) && item.timing === "availability").length;
                const today = isToday(day, now, timezone);
                const outside = monthOf(day, timezone) !== range.month;
                const date = localDate(day, timezone);
                return (
                  <td key={day} className={cn("h-28 border border-border/60 p-1 align-top", outside && "bg-muted/40")}>
                    <button type="button" onClick={() => onDay(date)} aria-label={`Open ${longDay(day, timezone)}${mine.length ? `, ${mine.length} scheduled` : ""}`} className={cn("mb-0.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums hover:bg-muted focus-visible:outline-2 focus-visible:outline-brand-500", today ? "bg-brand-500 text-white hover:bg-brand-600" : outside ? QUIET : "text-strong")}>
                      {cellLabel(day, timezone)}
                    </button>
                    <div className="grid gap-0.5">
                      {mine.slice(0, MONTH_LIMIT).map((item) => (
                        <button key={item.key} type="button" onClick={() => onOpen(item)} aria-label={itemLabel(item, timezone)} className={cn("flex min-h-6 min-w-0 items-center gap-1 rounded px-1 py-px text-left text-[11px] leading-tight focus-visible:outline-2 focus-visible:outline-brand-500", blockClass(item))}>
                          <TimingMark item={item} />
                          <span className={cn("shrink-0 tabular-nums", QUIET)}>{item.allDay ? "" : clock(item.startsAt, timezone).replace(":00", "").replace(" ", "").toLowerCase()}</span>
                          <span className="min-w-0 truncate font-medium">{item.title}</span>
                        </button>
                      ))}
                      {mine.length > MONTH_LIMIT ? (
                        <button type="button" onClick={() => onDay(date)} className="min-h-6 rounded px-1 text-left text-[11px] font-medium text-brand-300 hover:underline focus-visible:outline-2 focus-visible:outline-brand-500">
                          {mine.length - MONTH_LIMIT} more
                        </button>
                      ) : null}
                      {away > 0 ? <span className={cn("px-1 text-[10px]", QUIET)}>{away} away</span> : null}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Agenda ──────────────────────────────────────────────────────────────────────────────────────────

export function Agenda({ range, items, timezone, now, onOpen }: { range: Range; items: Item[]; timezone: string; now: number; onOpen: Open }) {
  const days = range.days.map((from, index) => ({ from, to: range.days[index + 1] ?? range.to })).map((day) => ({ ...day, items: items.filter((item) => inDay(item, day.from, day.to)).sort((a, b) => Math.max(a.startsAt, day.from) - Math.max(b.startsAt, day.from) || a.key.localeCompare(b.key)) }));
  const any = days.some((day) => day.items.length > 0);
  if (!any) return <p className="px-5 py-12 text-center text-sm text-muted-foreground">Nothing is scheduled {range.label ? `from ${range.label}` : "in this range"} with the layers and filters chosen.</p>;
  return (
    <ol className="divide-y divide-border">
      {days
        .filter((day) => day.items.length > 0)
        .map((day) => (
          <li key={day.from} className="grid gap-1 px-3 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4 sm:px-5">
            <h2 className={cn("text-sm font-semibold", isToday(day.from, now, timezone) ? "text-brand-300" : "text-strong")}>
              {isToday(day.from, now, timezone) ? "Today · " : ""}
              {new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" }).format(new Date(day.from))}
            </h2>
            <ul className="grid gap-1.5">
              {day.items.map((item) => (
                <li key={item.key}>
                  <button type="button" onClick={() => onOpen(item)} aria-label={itemLabel(item, timezone)} className={cn("grid w-full grid-cols-[5.5rem_1fr] items-start gap-3 rounded-lg px-2.5 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-brand-500 sm:grid-cols-[7.5rem_1fr]", blockClass(item))}>
                    <span className={cn("text-xs leading-5 tabular-nums", QUIET)}>{timeLabel(item, timezone)}</span>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="flex min-w-0 items-center gap-1.5 font-semibold text-strong">
                        <span className={cn("size-2 shrink-0 rounded-full", LAYER_LOOK[item.layer].swatch)} aria-hidden />
                        <span className="truncate">{item.title}</span>
                      </span>
                      {item.detail ? <span className={cn("truncate text-xs", QUIET)}>{item.detail}</span> : null}
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                        <span className="font-medium">{item.statusLabel}</span>
                        <CrewLine item={item} className={QUIET} />
                      </span>
                      {item.problems.length > 0 ? (
                        <span className="flex items-start gap-1 text-xs text-destructive-foreground">
                          <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                          {item.problems.join(" · ")}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
    </ol>
  );
}

// ── Team ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One lane per cleaner, as on Dispatch › Schedule (its lanes and blocks are reused), then one for visits
 * still short a cleaner, then members with appointments. The same jobs and assignments as Dispatch.
 */
export function TeamLanes({ data, range, items, timezone, onOpen, cleanerIds }: { data: CalendarData; range: Range; items: Item[]; timezone: string; onOpen: Open; cleanerIds: Set<string> | null }) {
  const from = range.from;
  const to = range.to;
  const timed = items.filter((item) => inDay(item, from, to) && (!isStrip(item) || item.timing === "availability"));
  const placed = placeInDay(timed, from, to, timezone);
  const { first, last } = hoursFor(placed.filter((row) => !row.continuesBefore));
  const span = last - first;
  const pos = (minute: number) => ((Math.min(Math.max(minute, first), last) - first) / span) * 100;
  const place = (item: Item) => {
    const start = item.startsAt <= from ? first : minuteOf(item.startsAt, from, timezone);
    const end = item.endsAt >= to ? last : minuteOf(item.endsAt, from, timezone);
    return { left: pos(start), width: pos(Math.max(end, start + 20)) - pos(start) };
  };
  const hours = Array.from({ length: span / 60 + 1 }, (_, index) => first + index * 60);
  const lines = hours.slice(1, -1).map(pos);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(new Date(from)));
  const short = timed.filter((item) => item.layer === "jobs" && item.timing === "appointment" && ["booked", "offer_sent", "partly_staffed"].includes(item.status));
  const cleaners = data.resources.cleaners.filter((row) => cleanerIds === null || cleanerIds.has(row.id));
  const members = data.resources.members.filter((member) => timed.some((item) => item.resources.some((row) => row.kind === "member" && row.id === member.id)));
  const rowsFor = (list: Item[]) => {
    const ends: number[] = [];
    const rowOf = new Map<string, number>();
    for (const item of [...list].sort((a, b) => a.startsAt - b.startsAt)) {
      let index = ends.findIndex((end) => end <= item.startsAt);
      if (index === -1) index = ends.length;
      ends[index] = item.endsAt;
      rowOf.set(item.key, index);
    }
    return { rows: Math.max(1, ends.length), rowOf };
  };
  const block = (item: Item, row?: number) => (
    <Block key={item.key} {...place(item)} row={row} onClick={() => onOpen(item)} title={itemLabel(item, timezone)} className={cn(blockClass(item), item.problems.length > 0 && "ring-2 ring-destructive/50")}>
      <span className="flex items-center gap-1 truncate font-semibold">
        <TimingMark item={item} />
        <span className="truncate">{item.title}</span>
      </span>
      <span className="block truncate">{item.statusLabel}</span>
    </Block>
  );

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[46rem]">
        <div className="grid grid-cols-[9rem_1fr] border-b border-border bg-muted sm:grid-cols-[11rem_1fr]">
          <div className={cn("border-r border-border px-3 py-1.5 text-[11px] font-semibold", QUIET)}>{timezone}</div>
          <div className="relative h-7">
            {hours.slice(0, -1).map((hour) => (
              <span key={hour} className={cn("absolute top-1.5 pl-1 text-[11px] tabular-nums", QUIET)} style={{ left: `${pos(hour)}%` }}>
                {HOUR_LABEL(hour)}
              </span>
            ))}
          </div>
        </div>
        {(() => {
          const { rows, rowOf } = rowsFor(short);
          return (
            <Lane lines={lines} rows={rows} name="Not fully staffed" note={short.length === 0 ? "Nothing short" : `${short.length} short a cleaner`}>
              {short.map((item) => block(item, rowOf.get(item.key)))}
            </Lane>
          );
        })()}
        {cleaners.map((cleaner) => {
          const mine = timed.filter((item) => item.resources.some((row) => row.kind === "cleaner" && row.id === cleaner.id));
          const work = mine.filter((item) => item.timing !== "availability");
          const away = mine.filter((item) => item.timing === "availability");
          const windows = cleaner.windows.filter((row) => row.weekday === weekday);
          const { rows, rowOf } = rowsFor(work);
          const problems = work.filter((item) => item.problems.some((words) => words.startsWith(`${cleaner.name}:`))).length;
          return (
            <Lane
              key={cleaner.id}
              lines={lines}
              rows={rows}
              name={cleaner.name}
              note={
                <>
                  {windows.length === 0 ? "No hours on record" : windows.map((row) => `${HOUR_LABEL(row.startMinute)}–${HOUR_LABEL(row.endMinute)}`).join(", ")}
                  {away.length > 0 ? " · away" : ""}
                  {problems > 0 ? <span className="block font-medium text-destructive-foreground">{problems} to look at</span> : null}
                </>
              }
            >
              {windows.map((row) => (
                <Block key={`w-${row.startMinute}`} left={pos(row.startMinute)} width={pos(row.endMinute) - pos(row.startMinute)} title="Hours they said they can work" className="bg-success/8" />
              ))}
              {away.map((item) => (
                <Block key={item.key} {...place(item)} title={item.title} className={HATCH} />
              ))}
              {work.map((item) => block(item, rowOf.get(item.key)))}
            </Lane>
          );
        })}
        {members.map((member) => {
          const mine = timed.filter((item) => item.resources.some((row) => row.kind === "member" && row.id === member.id));
          const work = mine.filter((item) => item.timing !== "availability");
          const away = mine.filter((item) => item.timing === "availability");
          const windows = member.windows.filter((row) => row.weekday === weekday);
          const { rows, rowOf } = rowsFor(work);
          const role = member.role === "owner" ? "Owner" : member.role === "manager" ? "Manager" : "Office";
          return (
            <Fragment key={member.id}>
              <Lane lines={lines} rows={rows} name={member.name} note={`${role}${windows.length ? ` · ${windows.map((row) => `${HOUR_LABEL(row.startMinute)}–${HOUR_LABEL(row.endMinute)}`).join(", ")}` : ""}${away.length ? " · away" : ""}`}>
                {windows.map((row) => (
                  <Block key={`w-${row.startMinute}`} left={pos(row.startMinute)} width={pos(row.endMinute) - pos(row.startMinute)} title="Their working hours" className="bg-success/8" />
                ))}
                {away.map((item) => (
                  <Block key={item.key} {...place(item)} onClick={() => onOpen(item)} title={itemLabel(item, timezone)} className={cn(HATCH, "border-border/60", QUIET)}>
                    <span className="block truncate">{item.title}</span>
                  </Block>
                ))}
                {work.map((item) => block(item, rowOf.get(item.key)))}
              </Lane>
            </Fragment>
          );
        })}
        {cleaners.length === 0 && members.length === 0 ? <p className="px-5 py-8 text-center text-sm text-muted-foreground">No cleaner is marked ready{cleanerIds ? " in this filter" : ""}.</p> : null}
      </div>
    </div>
  );
}
