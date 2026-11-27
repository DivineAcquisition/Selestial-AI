import { describe, expect, it } from "vitest";

import { copyHours } from "./business-inputs";
import { isEmpty, mergePatch, remaining } from "./autosave";

describe("Setup autosave", () => {
  it("merges newer edits over older ones field by field", () => {
    expect(mergePatch({ facts: { "company.location": "Austin" }, priority: "sales" }, { facts: { "contact.phone": "512" }, company: { name: "A" } })).toEqual({ priority: "sales", facts: { "company.location": "Austin", "contact.phone": "512" }, company: { name: "A" } });
  });

  it("clears only what a save carried, so an edit made while it was in flight is sent next, not lost", () => {
    const sent = { facts: { "company.location": "Austin" }, priority: "sales" };
    const now = { facts: { "company.location": "Austin, TX", "contact.phone": "512" }, priority: "sales" };
    expect(remaining(now, sent)).toEqual({ facts: { "company.location": "Austin, TX", "contact.phone": "512" } });
    expect(isEmpty(remaining(sent, sent))).toBe(true);
    expect(isEmpty({})).toBe(true);
  });

  it("copies one day's hours to the days chosen and leaves the others alone", () => {
    const hours = [
      { weekday: 1, startMinute: 480, endMinute: 1020 },
      { weekday: 6, startMinute: 600, endMinute: 840 },
    ];
    expect(copyHours(hours, 1, [2, 3, 1])).toEqual([
      { weekday: 1, startMinute: 480, endMinute: 1020 },
      { weekday: 2, startMinute: 480, endMinute: 1020 },
      { weekday: 3, startMinute: 480, endMinute: 1020 },
      { weekday: 6, startMinute: 600, endMinute: 840 },
    ]);
    expect(copyHours(hours, 4, [5])).toBe(hours);
  });
});
