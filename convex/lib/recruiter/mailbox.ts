/**
 * The hiring mailbox, behind one interface. A connector lists message headers after a cursor and fetches
 * one message's body. It can read; it cannot send, delete or mark anything.
 *
 * Gmail is built (gmail.ts) and is created per run with that run's access token. Microsoft 365 is not.
 * The mock stands in for a mailbox in tests, so every path above this interface is exercised without one.
 */
import type { DiscoveryMode } from "./boundary";
import type { MessageBody, MessageHeader } from "./mail";

/**
 * Where reading stays: received after `after`, and by `mode` (lib/recruiter/boundary.ts). In "label" mode
 * only messages that carry `folder` now; in "search" mode the provider narrows by recruiting words first.
 */
export type MailboxScope = { address: string; folder?: string; after: number; mode?: DiscoveryMode };

export type ListResult = { headers: MessageHeader[]; /** Where to continue from. Unchanged when nothing new came. */ cursor: string | null; more: boolean };

/** The connection's authorization ended. Only the Owner can fix it. */
export class MailboxAuthError extends Error {}
/** The provider failed for now. Trying again later may work. */
export class MailboxProviderError extends Error {}

export interface MailboxConnector {
  provider: string;
  /** Headers only, oldest first, after `cursor`. Never a body. */
  list(scope: MailboxScope, cursor: string | null, limit: number): Promise<ListResult>;
  /** One message's body. Attachment text is read only when `attachments` is true; otherwise they are listed by name. */
  fetch(scope: MailboxScope, id: string, options?: { attachments?: boolean }): Promise<MessageBody | null>;
}

// ── The mock ────────────────────────────────────────────────────────────────────────────────────

type MockInbox = { messages: MessageBody[]; fail: "auth" | "provider" | null; fetched: string[]; attachmentsRead: string[]; listed: number };
const inboxes = new Map<string, MockInbox>();

/** The test inbox for an address. Tests put messages in and set failures here. */
export function mockInbox(address: string): MockInbox {
  const key = address.toLowerCase();
  if (!inboxes.has(key)) inboxes.set(key, { messages: [], fail: null, fetched: [], attachmentsRead: [], listed: 0 });
  return inboxes.get(key)!;
}

export function resetMockInboxes() {
  inboxes.clear();
}

export const mockConnector: MailboxConnector = {
  provider: "mock",
  async list(scope, cursor, limit) {
    const inbox = mockInbox(scope.address);
    inbox.listed += 1;
    if (inbox.fail === "auth") throw new MailboxAuthError("mock: authorization expired");
    if (inbox.fail === "provider") throw new MailboxProviderError("mock: provider unavailable");
    const start = cursor ? Number(cursor) : 0;
    const eligible = inbox.messages.slice(start, start + limit);
    const headers = eligible
      .filter((message) => message.receivedAt >= scope.after)
      .map(({ id, threadId, from, replyTo, subject, receivedAt }) => ({ id, threadId, from, replyTo, subject, receivedAt }));
    const next = start + eligible.length;
    return { headers, cursor: String(next), more: next < inbox.messages.length };
  },
  async fetch(scope, id, options) {
    const inbox = mockInbox(scope.address);
    if (inbox.fail === "auth") throw new MailboxAuthError("mock: authorization expired");
    if (inbox.fail === "provider") throw new MailboxProviderError("mock: provider unavailable");
    inbox.fetched.push(id);
    const message = inbox.messages.find((row) => row.id === id) ?? null;
    if (!message) return null;
    if (options?.attachments) inbox.attachmentsRead.push(id);
    return options?.attachments ? message : { ...message, attachments: message.attachments.map((file) => ({ name: file.name, contentType: file.contentType, size: file.size })) };
  },
};

export function connectorFor(provider: string): MailboxConnector | null {
  return provider === "mock" ? mockConnector : null;
}
