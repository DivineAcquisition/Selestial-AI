import { describe, expect, it } from "vitest";

import { EMPTY_STATE, hoursFor, parsePreferences, parseState, placeInDay, rangeFor, stepDate, writeState } from "./calendar";

const TZ = "America/Chicago";
const HOUR = 3_600_000;
// Monday March 1, 2027, noon in Chicago.
const NOW = Date.UTC(2027, 2, 1, 18, 0);

describe("Calendar ranges", () => {
  it("shows a Sunday-to-Saturday week, a single day, two weeks of agenda and whole weeks around a month", () => {
    const week = rangeFor("week", null, NOW, TZ);
    expect(week.days).toHaveLength(7);
    expect(week.from).toBe(Date.UTC(2027, 1, 28, 6, 0));
    expect(week.label).toBe("Feb 28 – Mar 6, 2027");
    expect(rangeFor("day", "2027-03-02", NOW, TZ)).toMatchObject({ from: Date.UTC(2027, 2, 2, 6, 0), to: Date.UTC(2027, 2, 3, 6, 0) });
    expect(rangeFor("agenda", null, NOW, TZ).days).toHaveLength(14);
    const month = rangeFor("month", "2027-03-15", NOW, TZ);
    expect(month.month).toBe("2027-03");
    expect(month.days.length % 7).toBe(0);
    expect(month.days.length).toBeLessThanOrEqual(42);
    expect(month.label).toBe("March 2027");
  });

  it("keeps whole local days across a clock change: the week of March 14 has a 23-hour Sunday", () => {
    const week = rangeFor("week", "2027-03-14", NOW, TZ);
    expect(week.days[1] - week.days[0]).toBe(23 * HOUR);
    expect(week.days[2] - week.days[1]).toBe(24 * HOUR);
  });

  it("steps by the view's own length", () => {
    expect(stepDate("week", "2027-03-02", 1, NOW, TZ)).toBe("2027-03-09");
    expect(stepDate("day", "2027-03-14", 1, NOW, TZ)).toBe("2027-03-15");
    expect(stepDate("month", "2027-12-10", 1, NOW, TZ)).toBe("2028-01-01");
    expect(stepDate("month", "2027-01-10", -1, NOW, TZ)).toBe("2026-12-01");
    expect(stepDate("agenda", "2027-03-01", -1, NOW, TZ)).toBe("2027-02-15");
  });
});

describe("Calendar address", () => {
  it("round-trips the view, day, layers and filters, and drops anything that is not one", () => {
    const state = { ...EMPTY_STATE, view: "month" as const, date: "2027-03-02", layers: ["jobs" as const, "deadlines" as const], cleaner: "abc123" };
    const params = writeState(state, new URLSearchParams("open=job:xyz"));
    expect(params.get("open")).toBe("job:xyz");
    expect(parseState(params, "week")).toEqual(state);
    expect(parseState(new URLSearchParams("view=year&date=2027-13-45&layers=jobs,nope&cleaner=<script>"), "agenda")).toEqual({ ...EMPTY_STATE, view: "agenda", layers: ["jobs"] });
  });

  it("reads remembered choices safely", () => {
    expect(parsePreferences('{"view":"team","layers":["jobs","x"]}')).toEqual({ view: "team", layers: ["jobs"] });
    expect(parsePreferences("not json")).toEqual({ view: null, layers: null });
  });
});

describe("Placing items in a day", () => {
  const day = Date.UTC(2027, 2, 2, 6, 0);
  const next = day + 24 * HOUR;
  const at = (hour: number) => day + hour * HOUR;

  it("puts overlapping items side by side and lets the rest use the full width", () => {
    const placed = placeInDay(
      [
        { key: "a", startsAt: at(9), endsAt: at(11) },
        { key: "b", startsAt: at(10), endsAt: at(12) },
        { key: "c", startsAt: at(14), endsAt: at(15) },
      ],
      day,
      next,
      TZ,
    );
    const by = Object.fromEntries(placed.map((row) => [row.item.key, row]));
    expect(by.a).toMatchObject({ top: 540, bottom: 660, column: 0, columns: 2 });
    expect(by.b).toMatchObject({ column: 1, columns: 2 });
    expect(by.c).toMatchObject({ column: 0, columns: 1 });
  });

  it("places a visit across midnight in both days and says it continues", () => {
    const item = { key: "late", startsAt: at(23), endsAt: at(25) };
    expect(placeInDay([item], day, next, TZ)[0]).toMatchObject({ top: 23 * 60, bottom: 24 * 60, continuesAfter: true, continuesBefore: false });
    expect(placeInDay([item], next, next + 24 * HOUR, TZ)[0]).toMatchObject({ top: 0, bottom: 60, continuesBefore: true, continuesAfter: false });
    expect(hoursFor([{ top: 0, bottom: 60 }])).toEqual({ first: 0, last: 21 * 60 });
  });
});
