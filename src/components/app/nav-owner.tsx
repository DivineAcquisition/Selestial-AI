"use client";

/**
 * A page that cannot be placed by its address says where it belongs, and the sidebar and breadcrumbs
 * follow. Today only the Sales workspace needs it: the same route is Internal Booking for a booking and
 * Quotes & Proposals for a proposal. The hint is cleared when the page closes, and navigation-helpers.ts
 * ignores it on any page it does not fit, so it can never highlight the wrong place.
 */
import { createContext, useContext, useEffect, useState } from "react";

import type { NavOwner } from "@/lib/app/navigation-helpers";

type Store = { owner: NavOwner | null; setOwner: (owner: NavOwner | null) => void };
const NavOwnerContext = createContext<Store | null>(null);

export function NavOwnerProvider({ children }: { children: React.ReactNode }) {
  const [owner, setOwner] = useState<NavOwner | null>(null);
  return <NavOwnerContext.Provider value={{ owner, setOwner }}>{children}</NavOwnerContext.Provider>;
}

/** The hint in force, or null. Outside the app shell there is none. */
export function useNavOwner(): NavOwner | null {
  return useContext(NavOwnerContext)?.owner ?? null;
}

/** Declares where the current page belongs while it is open. Pass null while that is not known yet. */
export function useDeclareNavOwner(owner: NavOwner | null): void {
  const setOwner = useContext(NavOwnerContext)?.setOwner;
  const agent = owner?.agent ?? null;
  const tab = owner?.tab ?? null;
  useEffect(() => {
    if (!setOwner) return;
    setOwner(agent && tab ? { agent, tab } : null);
    return () => setOwner(null);
  }, [setOwner, agent, tab]);
}
