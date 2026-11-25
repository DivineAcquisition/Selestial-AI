"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { remaining } from "../../../convex/lib/founding/offer";
import type { FoundingView } from "@/lib/founding/view";

type Live = { view: FoundingView; now: number };

const Ctx = createContext<Live | null>(null);

/** How often the timer moves. It shows minutes, so once every 15 seconds keeps it exact without busy work. */
const TICK_MS = 15_000;
/** How often the live status (counts, an early close) is re-read while the page is open. */
const REFRESH_MS = 5 * 60_000;

/**
 * The page's one source of founding status. The first render uses exactly what the server rendered (its
 * view and its time), so hydration matches. After that the browser keeps time by its own clock corrected
 * by the measured difference to the server's clock: a visitor whose clock is wrong still sees the true
 * deadline, and every visitor counts down to the same stored timestamp. Nothing is kept in the browser.
 */
export function FoundingStatusProvider({ initial, children }: { initial: FoundingView; children: ReactNode }) {
  const [view, setView] = useState(initial);
  const [now, setNow] = useState(initial.serverNow);
  const offset = useRef<number | null>(null);

  useEffect(() => {
    let stopped = false;
    async function refresh() {
      const sent = Date.now();
      try {
        const response = await fetch("/api/founding/status", { cache: "no-store" });
        if (!response.ok) return;
        const next = (await response.json()) as FoundingView;
        const received = Date.now();
        if (stopped) return;
        // The server's time is taken as the middle of the request.
        offset.current = next.serverNow - (sent + received) / 2;
        setView(next);
        setNow(Date.now() + offset.current);
      } catch {
        // Keep what the page already shows; the server render is never replaced by a guess.
      }
    }
    void refresh();
    const tick = setInterval(() => setNow(Date.now() + (offset.current ?? 0)), TICK_MS);
    const poll = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(tick);
      clearInterval(poll);
    };
  }, []);

  // The deadline passing while the page is open closes it here too; the backend refuses claims on its own.
  const live = useMemo<Live>(() => {
    if (view.state === "open" && view.endsAt !== null && now >= view.endsAt) return { view: { ...view, state: "closed_deadline", canClaim: false, placesLeft: null }, now };
    return { view, now };
  }, [view, now]);

  return <Ctx.Provider value={live}>{children}</Ctx.Provider>;
}

export function useFounding(): Live & { left: ReturnType<typeof remaining> | null } {
  const live = useContext(Ctx);
  if (!live) throw new Error("useFounding must be used inside FoundingStatusProvider");
  return { ...live, left: live.view.endsAt !== null ? remaining(live.view.endsAt, live.now) : null };
}
