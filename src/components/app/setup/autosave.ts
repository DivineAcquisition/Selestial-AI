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

type SaveFn = (input: Patch & { expectedRevision: number; step: string; skip?: string; confirmContext?: boolean }) => Promise<{ revision: number }>;

export function useAutosave({ storageKey, serverRevision, step, save }: { storageKey: string; serverRevision: number; step: string; save: SaveFn }) {
  const [pending, setPending] = useState<Patch>(() => restore(storageKey, serverRevision));
  const [status, setStatus] = useState<SaveStatus>(() => (isEmpty(restore(storageKey, serverRevision)) ? "saved" : "unsaved"));
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(serverRevision);
  const pendingRef = useRef(pending);
  const stepRef = useRef(step);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  const keep = useCallback(
    (next: Patch) => {
      pendingRef.current = next;
      setPending(next);
      try {
        if (isEmpty(next)) window.localStorage.removeItem(storageKey);
        else window.localStorage.setItem(storageKey, JSON.stringify({ base: revision.current, patch: next }));
      } catch {
        // Not kept across reloads in this browser; saving still works.
      }
    },
    [storageKey],
  );

  /** Sends everything pending (and `extra`), after any save already going. Resolves true when it saved. */
  const flush = useCallback(
    (extra: { step?: string; skip?: string; confirmContext?: boolean; patch?: Patch } = {}): Promise<boolean> => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (extra.patch) keep(mergePatch(pendingRef.current, extra.patch));
      const run = async (): Promise<boolean> => {
        const sent = pendingRef.current;
        const moving = extra.step !== undefined && extra.step !== stepRef.current;
        if (isEmpty(sent) && !moving && !extra.skip && !extra.confirmContext) {
          setStatus((now) => (now === "conflict" || now === "failed" ? now : "saved"));
          return true;
        }
        inFlight.current = true;
        setStatus("saving");
        setError(null);
        try {
          const result = await save({ ...(sent as Patch), expectedRevision: revision.current, step: extra.step ?? stepRef.current, ...(extra.skip ? { skip: extra.skip } : {}), ...(extra.confirmContext ? { confirmContext: true } : {}) });
          revision.current = result.revision;
          const left = remaining(pendingRef.current, sent);
          keep(left);
          setStatus(isEmpty(left) ? "saved" : "unsaved");
          return true;
        } catch (caught) {
          const message = messageOf(caught);
          setError(message);
          setStatus(STALE.test(message) ? "conflict" : "failed");
          return false;
        } finally {
          inFlight.current = false;
        }
      };
      chain.current = chain.current.then(run, run);
      return chain.current;
    },
    [keep, save],
  );

  /** Records an edit and saves it after a pause. */
  const edit = useCallback(
    (patch: Patch) => {
      keep(mergePatch(pendingRef.current, patch));
      setStatus((now) => (now === "conflict" ? now : "unsaved"));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void flush();
      }, DELAY_MS);
    },
    [flush, keep],
  );

  // A newer revision this tab didn't make: another tab or device saved. With nothing pending here, the
  // newer one is simply adopted; with edits pending, the owner chooses.
  const [external, setExternal] = useState(false);
  useEffect(() => {
    if (serverRevision <= revision.current || inFlight.current) return;
    if (isEmpty(pendingRef.current)) {
      revision.current = serverRevision;
      setExternal(true);
    } else {
      setStatus("conflict");
    }
  }, [serverRevision]);

  /** Keep this tab's edits: save them over the newer revision. */
  const keepMine = useCallback(() => {
    revision.current = serverRevision;
    setStatus("unsaved");
    return flush();
  }, [flush, serverRevision]);

  /** Drop this tab's unsaved edits and take what was saved elsewhere. */
  const discard = useCallback(() => {
    revision.current = serverRevision;
    keep({});
    setStatus("saved");
    setError(null);
  }, [keep, serverRevision]);

  // Warn before leaving with edits not yet saved.
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

  /** A revision this tab made through another mutation (Build): known, so it isn't taken for another tab's save. */
  const adopt = useCallback((next: number) => {
    if (next > revision.current) revision.current = next;
  }, []);

  return { pending, status, error, edit, flush, keepMine, discard, adopt, external, clearExternal: () => setExternal(false), revision: () => revision.current };
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
