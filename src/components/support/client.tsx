"use client";

import { ConvexProvider, useConvex, type ConvexReactClient } from "convex/react";
import { createContext, useContext, useMemo } from "react";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

/**
 * A support session lives in one browser tab (docs/operations/03-support-sessions.md). The tab that
 * opened it keeps the session id in sessionStorage, which no other tab can see, and every company
 * request this tab makes carries it. Other tabs, and the staff console, keep their own context.
 *
 * The server never trusts this: it checks the session, the staff member and the company on every call
 * (convex/lib/support/access.ts). This only makes sure the tab names the session it belongs to.
 */
export const SUPPORT_KEY = "selestial.support";

export function storedSession(): Id<"supportSessions"> | null {
  try {
    const value = window.sessionStorage.getItem(SUPPORT_KEY);
    return value && /^[a-z0-9]{8,64}$/i.test(value) ? (value as Id<"supportSessions">) : null;
  } catch {
    return null;
  }
}

export function storeSession(id: Id<"supportSessions"> | null) {
  try {
    if (id) window.sessionStorage.setItem(SUPPORT_KEY, id);
    else window.sessionStorage.removeItem(SUPPORT_KEY);
  } catch {
    // Without session storage the tab cannot hold a session; the workspace then reads "Not found." and nothing leaks.
  }
}

const SessionContext = createContext<Id<"supportSessions"> | null>(null);

/** The support session this tab is working in, or null in an ordinary workspace. */
export function useSupportSessionId() {
  return useContext(SessionContext);
}

type Args = Record<string, unknown> | undefined;

function withSession(args: Args, sessionId: Id<"supportSessions">): Args {
  if (!args || typeof args !== "object" || !("companyId" in args) || "supportSessionId" in args) return args;
  return { ...args, supportSessionId: sessionId };
}

function refusalCode(error: unknown): string | null {
  const data = (error as { data?: { code?: unknown } } | null)?.data;
  return data && typeof data.code === "string" ? data.code : null;
}

/** The same connection and sign-in, with the session added to every company request from this tab. */
function sessionClient(client: ConvexReactClient, sessionId: Id<"supportSessions">): ConvexReactClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "watchQuery") return (query: never, args: Args, options?: never) => target.watchQuery(query, withSession(args, sessionId) as never, options);
      if (prop === "watchPaginatedQuery") return (query: never, args: Args, options: never) => (target as unknown as { watchPaginatedQuery: (q: never, a: never, o: never) => unknown }).watchPaginatedQuery(query, withSession(args, sessionId) as never, options);
      if (prop === "query") return (query: never, args: Args) => target.query(query, withSession(args, sessionId) as never);
      if (prop === "action") return (action: never, args: Args) => target.action(action, withSession(args, sessionId) as never);
      if (prop === "mutation") {
        return async (mutation: never, args: Args, options?: never) => {
          try {
            return await target.mutation(mutation, withSession(args, sessionId) as never, options);
          } catch (error) {
            // A refused change rolls back its own transaction, so the tab records it for the session's audit trail.
            const code = refusalCode(error);
            if ((code === "not_allowed" || code === "verify") && args && "companyId" in args) {
              const words = (error as { data?: { message?: string } }).data?.message ?? "A change was refused.";
              void target.mutation(api.support.noteRefusal, { sessionId, words: words.slice(0, 180) }).catch(() => undefined);
            }
            throw error;
          }
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function SupportSessionProvider({ sessionId, children }: { sessionId: Id<"supportSessions">; children: React.ReactNode }) {
  const client = useConvex();
  const wrapped = useMemo(() => sessionClient(client, sessionId), [client, sessionId]);
  return (
    <SessionContext.Provider value={sessionId}>
      <ConvexProvider client={wrapped}>{children}</ConvexProvider>
    </SessionContext.Provider>
  );
}
