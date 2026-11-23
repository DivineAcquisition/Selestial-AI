/**
 * What is wrong with one cleaner's time, read from the record: two commitments at once, two closer than
 * the company's time between visits, one outside the hours they gave, or one during their time off or an
 * unavailable day. The same rules Dispatch › Schedule shows, worked out once on the server so Calendar,
 * Needs attention and Ask Selestial agree.
 *
 * Only a cleaner's own commitments count against them. A member's meeting never blocks a cleaner, and
 * the time between visits is the company's setting, not a measured drive: travel is not looked up.
 */
import { localParts } from "../availability";

export type Commitment = { key: string; startsAt: number; endsAt: number; held: boolean };
export type Window = { weekday: number; startMinute: number; endMinute: number };
export type Away = { startsAt: number; endsAt: number; label: string };

const MINUTE = 60_000;

/** Problems for each commitment key, in words. A key with no problems is absent. */
export function cleanerConflicts(input: { commitments: Commitment[]; windows: Window[]; away: Away[]; bufferMinutes: number; timezone: string }): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (key: string, words: string) => {
    const list = out.get(key) ?? [];
    if (!list.includes(words)) list.push(words);
    out.set(key, list);
  };
  const sorted = [...input.commitments].sort((a, b) => a.startsAt - b.startsAt || a.key.localeCompare(b.key));
  for (const [index, row] of sorted.entries()) {
    // Every later commitment that starts before this one ends overlaps it, not only the next one.
    for (const other of sorted.slice(index + 1)) {
      if (other.startsAt >= row.endsAt) {
        const gap = other.startsAt - row.endsAt;
        if (gap < input.bufferMinutes * MINUTE) add(other.key, `Starts ${Math.round(gap / MINUTE)} min after another visit; ${input.bufferMinutes} min is kept between visits`);
        break;
      }
      add(row.key, other.held || row.held ? "Overlaps a visit held for them by an offer" : "Overlaps another visit");
      add(other.key, other.held || row.held ? "Overlaps a visit held for them by an offer" : "Overlaps another visit");
    }
    const start = localParts(row.startsAt, input.timezone);
    const end = localParts(row.endsAt, input.timezone);
    const sameDay = start.day === end.day || end.minute === 0;
    const endMinute = end.minute === 0 && end.day !== start.day ? 1440 : end.minute;
    const windows = input.windows.filter((window) => window.weekday === start.weekday);
    if (windows.length === 0) add(row.key, "No working hours on record for this day");
    else if (!sameDay || !windows.some((window) => window.startMinute <= start.minute && endMinute <= window.endMinute)) add(row.key, "Outside the hours they said they can work");
    for (const off of input.away) if (off.startsAt < row.endsAt && off.endsAt > row.startsAt) add(row.key, `During ${off.label}`);
  }
  return out;
}
