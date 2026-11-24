/**
 * Calendar's screen logic, with no React: which days a view shows, the address that reopens it, what a
 * person last chose, and where each item sits in a day column. Times are always worked out on the
 * company's clock, so a clock-change day has 23 or 25 hours and a visit across midnight is in both days.
 */
import { addLocalDays, localDate, localDayStart, localTime, zonedInstant } from "./format";

export const VIEWS = ["week", "day", "month", "agenda", "team"] as const;
export type View = (typeof VIEWS)[number];
export const VIEW_LABEL: Record<View, string> = { week: "Week", day: "Day", month: "Month", agenda: "Agenda", team: "Team" };

export const LAYER_IDS = ["jobs", "hiring", "sales", "quality", "availability", "business", "deadlines", "external"] as const;
export type LayerId = (typeof LAYER_IDS)[number];
export const LAYER_LABEL: Record<LayerId, string> = {
  jobs: "Cleaning visits",
  hiring: "Hiring",
  sales: "Walkthroughs",
  quality: "Quality",
  availability: "Time off",
  business: "Business events",
  deadlines: "Due dates",
  external: "Connected calendar",
};
/** The operational view. Due dates and connected-calendar busy time are one filter away. */
export const DEFAULT_LAYERS: readonly LayerId[] = ["jobs", "hiring", "sales", "quality", "availability", "business"];

/** Agenda reads two weeks from the chosen day. */
export const AGENDA_DAYS = 14;

// ── The address ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What the address holds: the view, the day, the layers and the filters. Only ids and words a person
 * chose, never a record's contents, so a copied link shows nothing to someone who cannot open it.
 */
export type CalendarState = {
  view: View;
  /** YYYY-MM-DD on the company's calendar. Null means today. */
  date: string | null;
  layers: LayerId[] | null;
  cleaner: string | null;
  member: string | null;
  customer: string | null;
  status: string | null;
  agent: string | null;
};

export const EMPTY_STATE: CalendarState = { view: "week", date: null, layers: null, cleaner: null, member: null, customer: null, status: null, agent: null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9_-]{1,64}$/i;

export function parseState(params: URLSearchParams, fallbackView: View): CalendarState {
  const view = params.get("view");
  const date = params.get("date");
  const layers = params.get("layers");
  const id = (key: string) => {
    const value = params.get(key);
    return value && ID.test(value) ? value : null;
  };
  return {
    view: (VIEWS as readonly string[]).includes(view ?? "") ? (view as View) : fallbackView,
    date: date && DATE.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00Z`)) ? date : null,
    layers: layers === null ? null : layers === "" ? [] : layers.split(",").filter((layer): layer is LayerId => (LAYER_IDS as readonly string[]).includes(layer)),
    cleaner: id("cleaner"),
    member: id("member"),
    customer: id("customer"),
    status: id("status"),
    agent: id("agent"),
  };
}

/** The address for a state, keeping any other parameters (such as the open record) as they are. */
export function writeState(state: CalendarState, current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  const set = (key: string, value: string | null) => (value === null ? next.delete(key) : next.set(key, value));
  set("view", state.view);
  set("date", state.date);
  set("layers", state.layers === null ? null : state.layers.join(","));
  for (const key of ["cleaner", "member", "customer", "status", "agent"] as const) set(key, state[key]);
  return next;
}

// ── Remembered choices ──────────────────────────────────────────────────────────────────────────────

export type Preferences = { view: View | null; layers: LayerId[] | null };

/** One entry for each person in each company, in the browser only. */
export function preferencesKey(userId: string, companyId: string): string {
  return `selestial.calendar:${userId}:${companyId}`;
}

export function parsePreferences(raw: string | null | undefined): Preferences {
  try {
    const value = raw ? (JSON.parse(raw) as { view?: unknown; layers?: unknown }) : {};
    return {
      view: (VIEWS as readonly unknown[]).includes(value.view) ? (value.view as View) : null,
      layers: Array.isArray(value.layers) ? LAYER_IDS.filter((layer) => (value.layers as unknown[]).includes(layer)) : null,
    };
  } catch {
    return { view: null, layers: null };
  }
}

// ── Ranges ──────────────────────────────────────────────────────────────────────────────────────────

export type Range = {
  from: number;
  to: number;
  /** The start of each day shown, in order. */
  days: number[];
  /** Month view only: the month being shown, YYYY-MM. */
  month: string | null;
  label: string;
};

const monthName = (at: number, timezone: string, withYear = true) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "long", ...(withYear ? { year: "numeric" } : {}) }).format(new Date(at));
const short = (at: number, timezone: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric" }).format(new Date(at));
const weekdayOf = (at: number, timezone: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(new Date(at)));

/** The day a view is anchored on: the chosen date, or today. */
export function anchorDay(date: string | null, now: number, timezone: string): number {
  return (date ? zonedInstant(date, "00:00", timezone) : null) ?? localDayStart(now, timezone);
}

/** The days a view shows. Weeks start on Sunday, as Dispatch's weekdays do. */
export function rangeFor(view: View, date: string | null, now: number, timezone: string): Range {
  const anchor = anchorDay(date, now, timezone);
  const span = (from: number, count: number) => Array.from({ length: count }, (_, index) => addLocalDays(from, index, timezone));
  if (view === "day" || view === "team") {
    const to = addLocalDays(anchor, 1, timezone);
    return { from: anchor, to, days: [anchor], month: null, label: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(anchor)) };
  }
  if (view === "week") {
    const from = addLocalDays(anchor, -weekdayOf(anchor, timezone), timezone);
    const days = span(from, 7);
    const last = days[6];
    const sameMonth = localDate(from, timezone).slice(0, 7) === localDate(last, timezone).slice(0, 7);
    // "Mar 7 – 13, 2027" is built from parts: a day and a year without a month have no pattern of their
    // own, and browsers print "2027 (day: 13)" for them.
    return { from, to: addLocalDays(from, 7, timezone), days, month: null, label: sameMonth ? `${short(from, timezone)} – ${Number(localDate(last, timezone).slice(8, 10))}, ${localDate(last, timezone).slice(0, 4)}` : `${short(from, timezone)} – ${short(last, timezone)}, ${localDate(last, timezone).slice(0, 4)}` };
  }
  if (view === "agenda") {
    const days = span(anchor, AGENDA_DAYS);
    return { from: anchor, to: addLocalDays(anchor, AGENDA_DAYS, timezone), days, month: null, label: `${short(anchor, timezone)} – ${short(days[AGENDA_DAYS - 1], timezone)}` };
  }
  // Month: whole weeks around the month, at most six of them (42 days).
  const first = zonedInstant(`${localDate(anchor, timezone).slice(0, 7)}-01`, "00:00", timezone) ?? anchor;
  const from = addLocalDays(first, -weekdayOf(first, timezone), timezone);
  const nextMonth = zonedInstant(nextMonthStart(localDate(first, timezone)), "00:00", timezone) ?? addLocalDays(first, 31, timezone);
  let count = 35;
  while (addLocalDays(from, count, timezone) < nextMonth) count += 7;
  return { from, to: addLocalDays(from, count, timezone), days: span(from, count), month: localDate(first, timezone).slice(0, 7), label: monthName(first, timezone) };
}

function nextMonthStart(date: string): string {
  const [year, month] = date.split("-").map(Number);
  return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

/** The date one step earlier or later: a day, a week, a month or two weeks, by view. */
export function stepDate(view: View, date: string | null, direction: -1 | 1, now: number, timezone: string): string {
  const anchor = anchorDay(date, now, timezone);
  if (view === "month") {
    const [year, month] = localDate(anchor, timezone).split("-").map(Number);
    const index = year * 12 + (month - 1) + direction;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
  }
  const days = view === "week" ? 7 : view === "agenda" ? AGENDA_DAYS : 1;
  return localDate(addLocalDays(anchor, direction * days, timezone), timezone);
}

// ── Placing items in a day ──────────────────────────────────────────────────────────────────────────

/** Minutes since the day's start on the company's clock, read from the clock so a clock-change day is right. */
export function minuteOf(at: number, dayStart: number, timezone: string): number {
  if (at <= dayStart) return 0;
  if (localDate(at, timezone) !== localDate(dayStart, timezone)) return 24 * 60;
  const [hours, minutes] = localTime(at, timezone).split(":").map(Number);
  return hours * 60 + minutes;
}

export type Placed<T> = { item: T; top: number; bottom: number; column: number; columns: number; continuesBefore: boolean; continuesAfter: boolean };

/**
 * Where each item sits in one day's column, in minutes from the day's start, with overlapping items side
 * by side rather than on top of each other. Items that touch the day at all are placed; a part before or
 * after the day is marked so the screen can say it continues.
 */
export function placeInDay<T extends { key: string; startsAt: number; endsAt: number }>(items: T[], dayStart: number, dayEnd: number, timezone: string, minimumMinutes = 20): Placed<T>[] {
  const inDay = items
    .filter((item) => item.startsAt < dayEnd && Math.max(item.endsAt, item.startsAt + 1) > dayStart)
    .map((item) => {
      const top = minuteOf(item.startsAt, dayStart, timezone);
      const end = item.endsAt >= dayEnd ? 24 * 60 : minuteOf(item.endsAt, dayStart, timezone);
      return { item, top, bottom: Math.max(end, top + minimumMinutes), continuesBefore: item.startsAt < dayStart, continuesAfter: item.endsAt > dayEnd };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.item.key.localeCompare(b.item.key));

  const out: Placed<T>[] = [];
  // Items are grouped into clusters that overlap one another; each cluster shares its width out evenly.
  let cluster: (typeof inDay[number] & { column: number })[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const columns = Math.max(1, ...cluster.map((row) => row.column + 1));
    for (const row of cluster) out.push({ ...row, columns });
    cluster = [];
  };
  for (const row of inDay) {
    if (row.top >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((other) => other.bottom > row.top).map((other) => other.column));
    let column = 0;
    while (used.has(column)) column += 1;
    cluster.push({ ...row, column });
    clusterEnd = Math.max(clusterEnd, row.bottom);
  }
  if (cluster.length) flush();
  return out;
}

/** The hours a time grid shows: 6 AM to 9 PM, widened to whatever is on it. */
export function hoursFor(placed: { top: number; bottom: number }[]): { first: number; last: number } {
  const first = Math.min(6 * 60, ...placed.map((row) => row.top));
  const last = Math.max(21 * 60, ...placed.map((row) => row.bottom));
  return { first: Math.floor(first / 60) * 60, last: Math.min(24 * 60, Math.ceil(last / 60) * 60) };
}

/** The month label for a month cell, for "Mar 1" on the first of a month. */
export function cellLabel(dayStart: number, timezone: string): string {
  const date = localDate(dayStart, timezone);
  return date.endsWith("-01") ? short(dayStart, timezone) : String(Number(date.slice(8)));
}

export const isToday = (dayStart: number, now: number, timezone: string) => localDate(dayStart, timezone) === localDate(now, timezone);
export const monthOf = (dayStart: number, timezone: string) => localDate(dayStart, timezone).slice(0, 7);
export { monthName };
