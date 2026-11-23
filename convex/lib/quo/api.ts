/**
 * Quo's public API (https://www.quo.com/docs, version 2026-03-30), limited to what Selestial uses and what
 * the documentation confirms. Every call takes the company's own API key; the key is never logged, returned
 * or put in an error's words.
 *
 *   Authorization: <key>            (no "Bearer")
 *   Quo-Api-Version: 2026-03-30     (required; there is no default)
 *
 * There is no idempotency key for sending, so an answer that never arrives is checked against Quo's message
 * list before anything is sent again (lib/quo/send.ts).
 */
import { sendBlocked } from "../environment";

export const QUO_BASE = "https://api.quo.com";
export const QUO_VERSION = "2026-03-30";
export const QUO_EVENTS = ["message.received", "message.delivered", "message.failed", "message.undelivered", "a2p.registration.updated"] as const;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type QuoNumber = { id: string; phoneNumber: string; name?: string; usMessaging?: "restricted" | "unrestricted" };
export type QuoMessage = { id: string; to: string[]; from: string; text: string; phoneNumberId: string; conversationId?: string; direction: "incoming" | "outgoing"; userId?: string | null; status: string; createdAt: string };

/** What went wrong, as a kind the connection and the outbox can act on. Words never contain the key. */
export type QuoFailure = {
  kind: "key_rejected" | "no_credits" | "subscription_expired" | "registration" | "opted_out" | "bad_number" | "not_number_user" | "daily_cap" | "rate_limited" | "outage" | "uncertain" | "not_found" | "invalid";
  status: number | null;
  words: string;
  /** Quo's request id, for its support team. */
  trace?: string;
};
export type Answer<T> = { ok: true; data: T } | ({ ok: false } & QuoFailure);

const TIMEOUT_MS = 15_000;

async function call<T>(fetcher: Fetch, key: string, method: string, path: string, body?: unknown, raw = false): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await fetcher(`${QUO_BASE}${path}`, {
      method,
      headers: { Authorization: key, "Quo-Api-Version": QUO_VERSION, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // No answer: the request may or may not have reached Quo.
    return { ok: false, kind: "uncertain", status: null, words: "Quo did not answer in time." };
  }
  if (response.status === 204) return { ok: true, data: null as T };
  let json: { data?: T; title?: string; message?: string; trace?: string } = {};
  try {
    json = (await response.json()) as typeof json;
  } catch {
    json = {};
  }
  if (response.ok) return { ok: true, data: (raw ? json : (json.data ?? json)) as T };
  return { ok: false, ...failure(response.status, json.title ?? "", json.message ?? ""), trace: json.trace };
}

/** Quo identifies send errors by status and title (https://www.quo.com/docs/2026-03-30/errors). */
export function failure(status: number, title: string, message: string): QuoFailure {
  const t = `${title} ${message}`.toLowerCase();
  if (status === 401) return { kind: "key_rejected", status, words: "Quo rejected the API key. It may have been deleted or replaced in Quo." };
  if (status === 402 && t.includes("subscription")) return { kind: "subscription_expired", status, words: "The Quo subscription has expired, so Quo won't send texts." };
  if (status === 402) return { kind: "no_credits", status, words: "The Quo account doesn't have enough prepaid credits to send texts." };
  if (status === 429) return { kind: "rate_limited", status, words: t.includes("new conversations") ? "Quo's limit on starting new conversations was reached." : "Quo asked Selestial to slow down." };
  if (status >= 500) return { kind: "outage", status, words: "Quo had a problem on its side." };
  if (t.includes("opted out")) return { kind: "opted_out", status, words: "This number has opted out of texts from the company's Quo number." };
  if (t.includes("a2p") && t.includes("cap")) return { kind: "daily_cap", status, words: "The Quo number reached its daily carrier message limit." };
  if (t.includes("a2p") || t.includes("tfn") || t.includes("registration")) return { kind: "registration", status, words: "Quo says the number's carrier registration isn't approved, so it won't send business texts." };
  if (t.includes("not phone number user")) return { kind: "not_number_user", status, words: "The API key's workspace user isn't a member of that Quo number." };
  if (t.includes("invalid") && t.includes("phone") || t.includes("unreachable")) return { kind: "bad_number", status, words: "Quo can't text that phone number." };
  if (status === 404) return { kind: "not_found", status, words: "Quo couldn't find it." };
  return { kind: "invalid", status, words: `Quo refused the request (${status}).` };
}

type Paged<T> = { data: T[]; nextCursor?: string | null };

async function all<T>(fetcher: Fetch, key: string, path: string, max = 5): Promise<Answer<T[]>> {
  const out: T[] = [];
  let after: string | null | undefined;
  for (let page = 0; page < max; page += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const answer = await call<Paged<T>>(fetcher, key, "GET", `${path}${sep}limit=50${after ? `&after=${encodeURIComponent(after)}` : ""}`, undefined, true);
    if (!answer.ok) return answer;
    out.push(...(answer.data.data ?? []));
    after = answer.data.nextCursor;
    if (!after) break;
  }
  return { ok: true, data: out };
}

/** GET /phone-numbers with messaging restrictions: the numbers the key can see. */
export async function listNumbers(fetcher: Fetch, key: string): Promise<Answer<QuoNumber[]>> {
  const answer = await all<{ id: string; phoneNumber: string; name?: string; restrictions?: { messaging?: { US?: "restricted" | "unrestricted" } } }>(fetcher, key, "/phone-numbers?include=restrictions");
  if (!answer.ok) return answer;
  return { ok: true, data: answer.data.filter((row) => /^PN/.test(row.id) && /^\+[1-9]\d{6,14}$/.test(row.phoneNumber)).map((row) => ({ id: row.id, phoneNumber: row.phoneNumber, name: row.name || undefined, usMessaging: row.restrictions?.messaging?.US })) };
}

/** GET /a2p-registration: the workspace's carrier registration. 404 means there is none to show. */
export async function registration(fetcher: Fetch, key: string): Promise<Answer<{ status: "approved" | "pending" | "rejected" | "failed" | "none" }>> {
  const answer = await call<{ status?: string; draft?: boolean }>(fetcher, key, "GET", "/a2p-registration");
  if (!answer.ok) return answer.kind === "not_found" ? { ok: true, data: { status: "none" } } : answer;
  const status = answer.data.draft ? "pending" : answer.data.status;
  return { ok: true, data: { status: status === "approved" || status === "rejected" || status === "failed" ? status : "pending" } };
}

/** POST /webhooks: Quo signs every event with the returned `whsec_` key. */
export async function createWebhook(fetcher: Fetch, key: string, input: { url: string; numberIds: string[]; events?: readonly string[] }): Promise<Answer<{ id: string; key: string; events: string[] }>> {
  const answer = await call<{ id: string; key: string; events: string[] }>(fetcher, key, "POST", "/webhooks", { url: input.url, events: [...(input.events ?? QUO_EVENTS)], resourceIds: input.numberIds, status: "enabled", label: "Selestial" });
  if (!answer.ok) return answer;
  if (!answer.data.id || !answer.data.key?.startsWith("whsec_")) return { ok: false, kind: "invalid", status: 201, words: "Quo created the webhook but did not return its signing key." };
  return answer;
}

/** PATCH /webhooks/{id}: the numbers whose events come to Selestial, and (when given) which events. */
export async function updateWebhook(fetcher: Fetch, key: string, id: string, numberIds: string[], events?: readonly string[]): Promise<Answer<unknown>> {
  return call(fetcher, key, "PATCH", `/webhooks/${encodeURIComponent(id)}`, { resourceIds: numberIds, status: "enabled", ...(events ? { events: [...events] } : {}) });
}

/** DELETE /webhooks/{id}. Already gone counts as done. */
export async function deleteWebhook(fetcher: Fetch, key: string, id: string): Promise<Answer<null>> {
  const answer = await call<null>(fetcher, key, "DELETE", `/webhooks/${encodeURIComponent(id)}`);
  return !answer.ok && answer.kind === "not_found" ? { ok: true, data: null } : answer;
}

/**
 * POST /messages from one of the company's Quo numbers. 202 means Quo accepted it, never that it was delivered.
 * On a non-production backend only test recipients are texted (lib/environment.ts), as with every provider.
 */
export async function sendMessage(fetcher: Fetch, key: string, input: { fromNumberId: string; to: string; text: string }): Promise<Answer<QuoMessage>> {
  const blocked = sendBlocked(input.to);
  if (blocked) return { ok: false, kind: "invalid", status: null, words: blocked };
  return call<QuoMessage>(fetcher, key, "POST", "/messages", { from: input.fromNumberId, to: [input.to], content: input.text });
}

/** GET /messages/{id}. */
export async function getMessage(fetcher: Fetch, key: string, id: string): Promise<Answer<QuoMessage>> {
  return call<QuoMessage>(fetcher, key, "GET", `/messages/${encodeURIComponent(id)}`);
}

/** GET /messages for one number and one person, newest first, since a moment. */
export async function recentMessages(fetcher: Fetch, key: string, input: { numberId: string; participant: string; since: number; direction?: "incoming" | "outgoing" }): Promise<Answer<QuoMessage[]>> {
  const params = new URLSearchParams({ phoneNumberId: input.numberId, "createdAt[gt]": new Date(input.since).toISOString(), limit: "50" });
  if (input.direction) params.set("direction", input.direction);
  // The person is the recipient of outgoing texts and the sender of incoming ones.
  if (input.direction === "incoming") params.set("from", input.participant);
  else params.set("to", input.participant);
  const answer = await call<Paged<QuoMessage>>(fetcher, key, "GET", `/messages?${params.toString()}`, undefined, true);
  if (!answer.ok) return answer;
  return { ok: true, data: answer.data.data ?? [] };
}

// ── Webhook signatures ──────────────────────────────────────────────────────────────────────────────

/** Five minutes either way, as Quo's own example uses. */
export const SIGNATURE_TOLERANCE_S = 300;

function fromBase64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: ArrayBuffer): string {
  let bin = "";
  for (const byte of new Uint8Array(bytes)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

/**
 * Quo's webhook signature (https://www.quo.com/docs/2026-03-30/webhooks-signature-validation): HMAC-SHA256 of
 * `{webhook-id}.{webhook-timestamp}.{raw body}` with the base64 key after `whsec_`, compared with each `v1,<sig>`
 * in `webhook-signature`. The timestamp must be within five minutes.
 */
export async function verifySignature(input: { secret: string; id: string | null; timestamp: string | null; signature: string | null; body: string; nowMs: number }): Promise<boolean> {
  if (!input.id || !input.timestamp || !input.signature || !input.secret.startsWith("whsec_")) return false;
  const seconds = Number(input.timestamp);
  if (!Number.isFinite(seconds) || Math.abs(input.nowMs / 1000 - seconds) > SIGNATURE_TOLERANCE_S) return false;
  let keyBytes: Uint8Array;
  try {
    keyBytes = fromBase64(input.secret.slice("whsec_".length));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = toBase64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${input.id}.${input.timestamp}.${input.body}`)));
  return input.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig || sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i += 1) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

/** Signs a payload the way Quo does. For tests and the test-event path only. */
export async function signForTest(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", fromBase64(secret.slice("whsec_".length)) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `v1,${toBase64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)))}`;
}

/** The parts of a webhook event Selestial reads. Anything else is ignored. */
export type QuoEvent = {
  type: string;
  createdAt?: string;
  data?: {
    resource?: { id?: string; direction?: "incoming" | "outgoing"; text?: string; status?: string; createdAt?: string; errorCode?: string | null };
    context?: { orgId?: string; phoneNumberId?: string; conversationId?: string; userId?: string | null; senderIdentifier?: string; recipientIdentifiers?: string[] };
    links?: { quo?: string | null };
  };
};
