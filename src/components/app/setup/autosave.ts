"use client";

/**
 * Setup's saving, the same everywhere in the flow:
 *
 *  - Edits collect in `pending` and are saved after a short pause (debounced), or at once when the owner
 *    moves on (`flush`), so nothing waits on a blur.
 *  - One save is in flight at a time, each naming the revision it started from. A response only clears
 *    the edits it actually carried: anything typed while it was in flight stays pending and is sent next.
 *  - "Saved" is shown only when the server confirmed every edit. Otherwise: "Unsaved changes", "Saving…",
 *    or a failure that keeps the edits so they can be retried.
 *  - Another tab or device saving first makes this one "conflict": nothing is overwritten until the owner
 *    chooses to load the latest or keep their own.
 *  - Pending edits are kept in this browser's local storage until they are saved, so a reload or a dropped
 *    connection loses nothing. Setup never holds credentials, so none are ever stored.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { messageOf } from "@/components/app/form";

export type Patch = {
  priority?: string;
  secondary?: string[];
  methods?: string[];
  answers?: Record<string, string | string[]>;
  facts?: Record<string, string | string[]>;
  company?: { name?: string; timezone?: string };
};

export type SaveStatus = "saved" | "unsaved" | "saving" | "failed" | "conflict";

/** Merges a newer edit over an older one, field by field. Pure. */
export function mergePatch(a: Patch, b: Patch): Patch {
  const out: Patch = { ...a, ...b };
  if (a.answers || b.answers) out.answers = { ...a.answers, ...b.answers };
  if (a.facts || b.facts) out.facts = { ...a.facts, ...b.facts };
  if (a.company || b.company) out.company = { ...a.company, ...b.company };
  return out;
}

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

/** What is still unsaved after `sent` was saved, given everything pending now. Pure. */
export function remaining(pending: Patch, sent: Patch): Patch {
  const out: Patch = {};
  for (const key of ["priority", "secondary", "methods"] as const) if (pending[key] !== undefined && !same(pending[key], sent[key])) (out as Record<string, unknown>)[key] = pending[key];
  for (const key of ["answers", "facts", "company"] as const) {
    const now = pending[key] as Record<string, unknown> | undefined;
    if (!now) continue;
    const was = (sent[key] ?? {}) as Record<string, unknown>;
    const left = Object.fromEntries(Object.entries(now).filter(([field, value]) => !same(value, was[field])));
    if (Object.keys(left).length) (out as Record<string, unknown>)[key] = left;
  }
  return out;
}

export const isEmpty = (patch: Patch) => Object.keys(remaining(patch, {})).length === 0;

export const STATUS_WORDS: Record<SaveStatus, string> = {
  saved: "All changes saved",
  unsaved: "Unsaved changes",
  saving: "Saving…",
  failed: "Not saved yet",
  conflict: "Changed in another tab",
};

const STALE = /changed somewhere else/i;
const DELAY_MS = 800;

export type SaveInput = Patch & { expectedRevision: number; step: string; skip?: string; confirmContext?: boolean };
type SaveFn = (input: SaveInput) => Promise<{ revision: number }>;
export type Snapshot = { pending: Patch; status: SaveStatus; error: string | null };

/**
 * The saving rules, without React or timers, so each case can be tested on its own: one save in flight at
 * a time, each naming the revision it started from; a response clears only what it carried; a refusal
 * because another tab saved first is a conflict that keeps every edit until the owner chooses; any other
 * failure keeps every edit for a retry. `persist` keeps pending edits across a reload.
 */
export class SaveQueue {
  private snapshot: Snapshot;
  private revision: number;
  private step: string;
  private chain: Promise<boolean> = Promise.resolve(true);
  private inFlight = false;
  private saveFn: SaveFn;

  constructor(
    private readonly options: { revision: number; step: string; pending?: Patch; save: SaveFn; onChange: (snapshot: Snapshot) => void; persist?: (revision: number, pending: Patch) => void },
  ) {
    this.saveFn = options.save;
    this.revision = options.revision;
    this.step = options.step;
    const pending = options.pending ?? {};
    this.snapshot = { pending, status: isEmpty(pending) ? "saved" : "unsaved", error: null };
  }

  get state(): Snapshot {
    return this.snapshot;
  }
  get currentRevision(): number {
    return this.revision;
  }
  get saving(): boolean {
    return this.inFlight;
  }

  private set(next: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    if (next.pending) this.options.persist?.(this.revision, next.pending);
    this.options.onChange(this.snapshot);
  }

  setStep(step: string) {
    this.step = step;
  }

  /** The newest save function (it closes over the company and the mutation). */
  setSave(save: SaveFn) {
    this.saveFn = save;
  }

  /** Records an edit. While in conflict it stays a conflict: nothing is sent until the owner chooses. */
  edit(patch: Patch) {
    this.set({ pending: mergePatch(this.snapshot.pending, patch), status: this.snapshot.status === "conflict" ? "conflict" : "unsaved" });
  }

  /** Whether a debounced save should go now. A conflict waits for the owner. */
  get shouldAutoSave(): boolean {
    return this.snapshot.status !== "conflict" && !isEmpty(this.snapshot.pending);
  }

  /** Sends everything pending (and `extra`), after any save already going. Resolves true when it saved. */
  flush(extra: { step?: string; skip?: string; confirmContext?: boolean; patch?: Patch } = {}): Promise<boolean> {
    if (extra.patch) this.edit(extra.patch);
    const run = async (): Promise<boolean> => {
      if (this.snapshot.status === "conflict") return false;
      const sent = this.snapshot.pending;
      const moving = extra.step !== undefined && extra.step !== this.step;
      if (isEmpty(sent) && !moving && !extra.skip && !extra.confirmContext) {
        if (this.snapshot.status !== "failed") this.set({ status: "saved" });
        return this.snapshot.status !== "failed";
      }
      this.inFlight = true;
      this.set({ status: "saving", error: null });
      try {
        const result = await this.saveFn({ ...sent, expectedRevision: this.revision, step: extra.step ?? this.step, ...(extra.skip ? { skip: extra.skip } : {}), ...(extra.confirmContext ? { confirmContext: true } : {}) });
        this.revision = Math.max(this.revision, result.revision);
        if (extra.step !== undefined) this.step = extra.step;
        const left = remaining(this.snapshot.pending, sent);
        this.set({ pending: left, status: isEmpty(left) ? "saved" : "unsaved" });
        return true;
      } catch (caught) {
        const message = messageOf(caught);
        this.set({ error: message, status: STALE.test(message) ? "conflict" : "failed" });
        return false;
      } finally {
        this.inFlight = false;
      }
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  /**
   * The server's revision moved. A revision this tab made is already known. A newer one is another tab's:
   * adopted when nothing is pending here ("adopted": show what it saved), a conflict otherwise.
   */
  serverRevision(next: number): "none" | "adopted" | "conflict" {
    if (next <= this.revision || this.inFlight) return "none";
    if (isEmpty(this.snapshot.pending) && this.snapshot.status !== "failed") {
      this.revision = next;
      return "adopted";
    }
    this.set({ status: "conflict" });
    return "conflict";
  }

  /** Keep this tab's edits: save them over the newer revision. */
  keepMine(serverRevision: number): Promise<boolean> {
    this.revision = Math.max(this.revision, serverRevision);
    this.set({ status: "unsaved", error: null });
    return this.flush();
  }

  /** Drop this tab's unsaved edits and take what was saved elsewhere. */
  discard(serverRevision: number) {
    this.revision = Math.max(this.revision, serverRevision);
    this.set({ pending: {}, status: "saved", error: null });
  }

  /** A revision this tab made through another mutation (Build): known, so it isn't taken for another tab's save. */
  adopt(next: number) {
    if (next > this.revision) this.revision = next;
  }
}

export function useAutosave({ storageKey, serverRevision, step, save, onExternal }: { storageKey: string; serverRevision: number; step: string; save: SaveFn; onExternal: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => {
    const pending = restore(storageKey, serverRevision);
    return { pending, status: isEmpty(pending) ? "saved" : "unsaved", error: null };
  });
  const [queue] = useState(
    () =>
      new SaveQueue({
        revision: serverRevision,
        step,
        pending: snapshot.pending,
        save,
        onChange: setSnapshot,
        persist: (base, pending) => {
          try {
            if (isEmpty(pending)) window.localStorage.removeItem(storageKey);
            else window.localStorage.setItem(storageKey, JSON.stringify({ base, patch: pending }));
          } catch {
            // Not kept across reloads in this browser; saving still works.
          }
        },
      }),
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    queue.setStep(step);
  }, [queue, step]);
  useEffect(() => {
    queue.setSave(save);
  }, [queue, save]);

  const flush = useCallback(
    (extra: { step?: string; skip?: string; confirmContext?: boolean; patch?: Patch } = {}) => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      return queue.flush(extra);
    },
    [queue],
  );

  /** Records an edit and saves it after a pause. */
  const edit = useCallback(
    (patch: Patch) => {
      queue.edit(patch);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        if (queue.shouldAutoSave) void queue.flush();
      }, DELAY_MS);
    },
    [queue],
  );

  // A newer revision this tab didn't make: another tab or device saved. With nothing pending here, the
  // screen shows what it saved; with edits pending, the owner chooses (status "conflict").
  useEffect(() => {
    if (queue.serverRevision(serverRevision) === "adopted") onExternal();
  }, [queue, serverRevision, onExternal]);

  // Warn before leaving with edits not yet saved.
  const { status } = snapshot;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (status === "saved") return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return {
    pending: snapshot.pending,
    status: snapshot.status,
    error: snapshot.error,
    edit,
    flush,
    keepMine: () => queue.keepMine(serverRevision),
    discard: () => queue.discard(serverRevision),
    adopt: (next: number) => queue.adopt(next),
    revision: () => queue.currentRevision,
  };
}

/** Edits left unsaved in this browser for the same revision; anything older was overtaken and is dropped. */
function restore(storageKey: string, serverRevision: number): Patch {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { base?: number; patch?: Patch };
    if (parsed.base !== serverRevision || !parsed.patch) {
      window.localStorage.removeItem(storageKey);
      return {};
    }
    return parsed.patch;
  } catch {
    return {};
  }
}
