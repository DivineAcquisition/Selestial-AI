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

import { SaveQueue, type SaveInput, type Snapshot } from "./autosave";

/** A server with one setup row: it refuses a save that started from an older revision, like setup.save. */
function server(start = 0) {
  const state = { revision: start, saved: [] as SaveInput[], fail: null as string | null, gate: null as null | (() => void) };
  const save = async (input: SaveInput) => {
    if (state.gate) await new Promise<void>((resolve) => (state.gate = resolve));
    if (state.fail) throw new Error(state.fail);
    // The real mutation refuses with a ConvexError whose data carries the words.
    if (input.expectedRevision !== state.revision) throw Object.assign(new Error("stale"), { data: { code: "invalid", message: "Your setup was changed somewhere else, on another tab or device." } });
    state.saved.push(input);
    state.revision += 1;
    return { revision: state.revision };
  };
  return { state, save };
}

function queueFor(s: ReturnType<typeof server>, revision = s.state.revision, pending = {}) {
  const seen: Snapshot[] = [];
  const persisted: { base: number; pending: object }[] = [];
  const queue = new SaveQueue({ revision, step: "essentials", pending, save: s.save, onChange: (snap) => seen.push(snap), persist: (base, p) => persisted.push({ base, pending: p }) });
  return { queue, seen, persisted };
}

describe("SaveQueue", () => {
  it("says Saved only after the server confirms, and keeps an edit made while a save was in flight", async () => {
    const s = server();
    const { queue } = queueFor(s);
    queue.edit({ facts: { "company.location": "Austin" } });
    expect(queue.state.status).toBe("unsaved");
    s.state.gate = () => undefined;
    const first = queue.flush();
    await Promise.resolve();
    const release = s.state.gate!;
    expect(queue.state.status).toBe("saving");
    // Typed while the first save is on its way: newer than what was sent.
    queue.edit({ facts: { "company.location": "Austin, TX" } });
    s.state.gate = null;
    release();
    expect(await first).toBe(true);
    expect(queue.state).toMatchObject({ status: "unsaved", pending: { facts: { "company.location": "Austin, TX" } } });
    expect(await queue.flush()).toBe(true);
    expect(queue.state.status).toBe("saved");
    // The older value never overwrote the newer one: they were saved in order.
    expect(s.state.saved.map((row) => row.facts?.["company.location"])).toEqual(["Austin", "Austin, TX"]);
  });

  it("keeps every edit through a failed save, and retries it", async () => {
    const s = server();
    const { queue, persisted } = queueFor(s);
    queue.edit({ answers: { "jobs.where": "calendar" } });
    s.state.fail = "Failed to fetch";
    expect(await queue.flush()).toBe(false);
    expect(queue.state).toMatchObject({ status: "failed", error: expect.stringContaining("couldn't be reached"), pending: { answers: { "jobs.where": "calendar" } } });
    // Kept on the device for a reload.
    expect(persisted.at(-1)).toEqual({ base: 0, pending: { answers: { "jobs.where": "calendar" } } });
    // Moving on is refused while it is unsaved; the retry saves it.
    s.state.fail = null;
    expect(await queue.flush()).toBe(true);
    expect(queue.state).toMatchObject({ status: "saved", pending: {} });
    expect(persisted.at(-1)).toEqual({ base: 1, pending: {} });
  });

  it("never overwrites another tab's newer save: a conflict waits for the owner, who keeps theirs or loads the latest", async () => {
    const s = server();
    const tabA = queueFor(s).queue;
    const tabB = queueFor(s).queue;
    tabB.edit({ priority: "dispatch" });
    expect(await tabB.flush()).toBe(true);
    // Tab A saves on top of an older revision: refused, and its edit is kept.
    tabA.edit({ priority: "sales" });
    expect(await tabA.flush()).toBe(false);
    expect(tabA.state).toMatchObject({ status: "conflict", pending: { priority: "sales" } });
    // While in conflict nothing is sent on its own.
    tabA.edit({ secondary: ["retention"] });
    expect(tabA.shouldAutoSave).toBe(false);
    expect(await tabA.flush()).toBe(false);
    expect(s.state.saved).toHaveLength(1);
    // "Keep my changes" saves them over the newer revision.
    expect(await tabA.keepMine(s.state.revision)).toBe(true);
    expect(s.state.saved.at(-1)).toMatchObject({ priority: "sales", secondary: ["retention"], expectedRevision: 1 });
    // "Load the latest" drops this tab's edits instead.
    tabB.edit({ priority: "pricing" });
    expect(await tabB.flush()).toBe(false);
    tabB.discard(s.state.revision);
    expect(tabB.state).toMatchObject({ status: "saved", pending: {} });
  });

  it("adopts another tab's save when nothing is pending, and its own revisions are never mistaken for one", async () => {
    const s = server(4);
    const { queue } = queueFor(s);
    expect(queue.serverRevision(4)).toBe("none");
    expect(queue.serverRevision(5)).toBe("adopted");
    queue.edit({ facts: { "contact.phone": "512" } });
    expect(queue.serverRevision(6)).toBe("conflict");
    // A revision this tab made through Build is known.
    const other = queueFor(server(2)).queue;
    other.adopt(3);
    expect(other.serverRevision(3)).toBe("none");
  });

  it("restores unsaved edits after a reload as unsaved, and moving to another step saves even with no edits", async () => {
    const s = server();
    const { queue } = queueFor(s, 0, { company: { name: "Juniper" } });
    expect(queue.state.status).toBe("unsaved");
    expect(await queue.flush({ step: "context" })).toBe(true);
    expect(s.state.saved[0]).toMatchObject({ company: { name: "Juniper" }, step: "context" });
    expect(await queue.flush({ step: "build" })).toBe(true);
    expect(s.state.saved[1]).toMatchObject({ step: "build", expectedRevision: 1 });
    expect(await queue.flush()).toBe(true);
    expect(s.state.saved).toHaveLength(2);
  });
});
