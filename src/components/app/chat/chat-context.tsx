"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { useNavOwner } from "@/components/app/nav-owner";
import { breadcrumbsFor } from "@/lib/app/navigation-helpers";
import { chatStorageKey, parseStoredChat } from "@/lib/app/chat/session";

/** A record a page offers to the chat as context. The server checks it again, and labels it from the record. */
export type OfferedRecord = { table: "customers" | "properties" | "cleaners" | "jobs" | "tasks" | "applications" | "hiringNeeds" | "chatArtifacts" | "invoices" | "salesOpportunities"; id: string };

type ChatStore = {
  /** The chat open in the side panel and remembered for this person in this company. */
  conversationId: string | null;
  setConversationId: (id: string | null) => void;
  panelOpen: boolean;
  openPanel: (conversationId?: string | null) => void;
  closePanel: () => void;
  /** The draft open in the document workspace, if any. */
  artifactId: string | null;
  openArtifact: (artifactId: string | null) => void;
  /** Where the person is, in words and as a path. */
  page: { path: string; label: string } | null;
  offered: OfferedRecord[];
  offer: (records: OfferedRecord[]) => () => void;
  /** A page that knows more about what is on screen (Calendar's view and dates) says so here. */
  describe: (detail: { path: string; label: string } | null) => void;
  /** The button that opened the panel, so focus can go back to it. */
  launcher: React.RefObject<HTMLButtonElement | null>;
};

const ChatContext = createContext<ChatStore | null>(null);

function read(key: string) {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * One chat state for the whole workspace: the sidebar, the full page and the side panel all read the
 * same open conversation, so one chat is never two. It is remembered per person and per company; the
 * workspace remounts on a company switch, which clears whatever was on screen.
 */
export function ChatProvider({ userId, companyId, children }: { userId: string; companyId: string; children: React.ReactNode }) {
  const key = chatStorageKey(userId, companyId);
  const [stored, setStored] = useState(() => parseStoredChat(read(key)));
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [offers, setOffers] = useState<{ id: number; records: OfferedRecord[] }[]>([]);
  const [detail, describe] = useState<{ path: string; label: string } | null>(null);
  const counter = useRef(0);
  const launcher = useRef<HTMLButtonElement | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(stored));
    } catch {
      // Not remembered across visits; everything still works.
    }
  }, [key, stored]);

  const setConversationId = useCallback((conversationId: string | null) => setStored((before) => (before.conversationId === conversationId ? before : { ...before, conversationId })), []);
  const openPanel = useCallback((conversationId?: string | null) => setStored((before) => ({ conversationId: conversationId === undefined ? before.conversationId : conversationId, panelOpen: true })), []);
  const closePanel = useCallback(() => {
    setStored((before) => ({ ...before, panelOpen: false }));
    requestAnimationFrame(() => launcher.current?.focus());
  }, []);
  const offer = useCallback((records: OfferedRecord[]) => {
    const id = (counter.current += 1);
    setOffers((before) => [...before, { id, records }]);
    return () => setOffers((before) => before.filter((entry) => entry.id !== id));
  }, []);

  const owner = useNavOwner();
  const crumbs = breadcrumbsFor(pathname, owner);
  const own = pathname.startsWith("/app") && !pathname.startsWith("/app/chat") ? { path: pathname, label: crumbs.length ? crumbs.map((crumb) => crumb.label).join(" › ") : "Home" } : null;
  // A page's own description counts only while that page is open: what it shows, never record contents.
  const page = own && detail && detail.path.split("?")[0] === pathname ? detail : own;
  const offered = useMemo(() => {
    const seen = new Set<string>();
    return offers.flatMap((entry) => entry.records).filter((record) => (seen.has(`${record.table}:${record.id}`) ? false : (seen.add(`${record.table}:${record.id}`), true)));
  }, [offers]);

  const value = useMemo<ChatStore>(
    () => ({ conversationId: stored.conversationId, setConversationId, panelOpen: stored.panelOpen, openPanel, closePanel, artifactId, openArtifact: setArtifactId, page, offered, offer, describe, launcher }),
    // `page` is derived from the path and the page's own description.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stored, setConversationId, openPanel, closePanel, artifactId, pathname, owner, detail, offered, offer],
  );
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatStore {
  const store = useContext(ChatContext);
  if (!store) throw new Error("Chat needs a ChatProvider");
  return store;
}

/** A page offers the records it is showing to the chat, as removable context. Safe to call outside the workspace. */
export function useOfferChatContext(records: OfferedRecord[] | null) {
  const store = useContext(ChatContext);
  const offer = store?.offer;
  const signature = records ? records.map((record) => `${record.table}:${record.id}`).join(",") : "";
  useEffect(() => {
    if (!offer || !records || records.length === 0) return;
    return offer(records);
    // The signature is the identity of the records.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer, signature]);
}

/**
 * A page describes what it is showing to the chat, in a path and words (for Calendar: the view, the dates
 * and the time zone). Only ids and words a person chose; never a record's contents. Cleared on leaving.
 */
export function useDescribeChatPage(detail: { path: string; label: string } | null) {
  const describe = useContext(ChatContext)?.describe;
  const signature = detail ? `${detail.path}|${detail.label}` : "";
  useEffect(() => {
    if (!describe) return;
    describe(detail);
    return () => describe(null);
    // The signature is the identity of the description.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [describe, signature]);
}
