/**
 * Quo (formerly OpenPhone), read for quality evidence. Facts from Quo's API documentation, version
 * 2026-03-30 (https://www.quo.com/docs/2026-03-30/), checked November 22, 2026:
 *
 *  - Base https://api.quo.com, header `Authorization: <api key>` (no "Bearer") and `Quo-Api-Version`.
 *  - GET /calls (filters optional; `include=summary`; `createdAt[gte]`; `limit` 1-50; `after` cursor).
 *  - GET /calls/{id}/transcripts: one item per recording, status absent | in-progress | completed | failed,
 *    `dialogue` only when completed, each line with start/end seconds and a phone `identifier` or `actorId`.
 *  - Summaries are on the call with `include=summary`, status absent | in-progress | completed | failed.
 *  - Webhooks: POST /webhooks {events, url}; the response carries a `whsec_` key. Deliveries carry
 *    `webhook-id`, `webhook-timestamp` and `webhook-signature` ("v1,<base64>" entries) over
 *    `{id}.{timestamp}.{raw body}`, HMAC-SHA256 with the key's base64 part. Order is not guaranteed and
 *    retries run for about a day.
 *  - 10 requests per second per key; 429 when exceeded.
 *  - Transcripts and summaries depend on the Quo plan (the legacy reference names Business and Scale).
 *
 * NOT VERIFIED against a live Quo workspace: no key was available. The list response envelope (`data`,
 * `nextCursor`) and the phone-number path are read as documented and tolerated in other shapes. Selestial
 * never downloads recordings, never changes recording settings, and never sends through Quo.
 */
const BASE = "https://api.quo.com";
const VERSION = "2026-03-30";

export type QuoCall = {
  id: string;
  phoneNumberId?: string;
  direction: "incoming" | "outgoing";
  status?: string;
  participants: string[];
  createdAt: number;
  completedAt?: number;
  duration?: number;
  summary?: { status: "absent" | "in_progress" | "completed" | "failed"; lines: string[]; nextSteps: string[] };
  link?: string;
};
export type QuoDialogue = { content: string; start: number; end: number; identifier: string | null; actorId: string | null };
export type QuoTranscript = { recordingId?: string; status: "absent" | "in_progress" | "completed" | "failed"; dialogue: QuoDialogue[] };
export type QuoMessage = { id: string; phoneNumberId?: string; direction: "incoming" | "outgoing"; from: string; to: string[]; text: string; createdAt: number; conversationId?: string };
export type QuoNumber = { id: string; number: string; name?: string };

export class QuoError extends Error {
  constructor(public kind: "unauthorized" | "rate_limited" | "unavailable" | "not_found" | "bad_response", message: string) {
    super(message);
  }
}

export interface QuoApi {
  numbers(): Promise<QuoNumber[]>;
  calls(input: { since: number; after?: string; limit: number }): Promise<{ calls: QuoCall[]; next: string | null }>;
  transcripts(callId: string): Promise<QuoTranscript[]>;
  createWebhook(url: string, events: string[]): Promise<{ id: string; key: string }>;
  deleteWebhook(id: string): Promise<void>;
}

/** Tests put a fake here. Nothing else does. */
export const mockQuo: { api: QuoApi | null } = { api: null };

const time = (value: unknown): number | undefined => (typeof value === "string" ? Date.parse(value) || undefined : typeof value === "number" ? value : undefined);
const status = (value: unknown): "absent" | "in_progress" | "completed" | "failed" => (value === "completed" ? "completed" : value === "in-progress" || value === "in_progress" ? "in_progress" : value === "failed" ? "failed" : "absent");
const list = (body: unknown): { data: unknown[]; next: string | null } => {
  const b = body as { data?: unknown; nextCursor?: unknown; meta?: { nextCursor?: unknown } };
  const data = Array.isArray(b?.data) ? b.data : Array.isArray(body) ? (body as unknown[]) : [];
  const next = typeof b?.nextCursor === "string" ? b.nextCursor : typeof b?.meta?.nextCursor === "string" ? b.meta.nextCursor : null;
  return { data, next };
};

export function parseCall(raw: unknown): QuoCall | null {
  const c = raw as Record<string, unknown>;
  if (!c || typeof c.id !== "string") return null;
  const summary = c.summary as Record<string, unknown> | undefined;
  return {
    id: c.id,
    phoneNumberId: typeof c.phoneNumberId === "string" ? c.phoneNumberId : undefined,
    direction: c.direction === "outgoing" ? "outgoing" : "incoming",
    status: typeof c.status === "string" ? c.status : undefined,
    participants: Array.isArray(c.participants) ? c.participants.filter((p): p is string => typeof p === "string") : [],
    createdAt: time(c.createdAt) ?? Date.now(),
    completedAt: time(c.completedAt),
    duration: typeof c.duration === "number" ? c.duration : undefined,
    summary: summary ? { status: status(summary.status), lines: Array.isArray(summary.summary) ? summary.summary.filter((s): s is string => typeof s === "string") : [], nextSteps: Array.isArray(summary.nextSteps) ? summary.nextSteps.filter((s): s is string => typeof s === "string") : [] } : undefined,
  };
}

export function parseTranscript(raw: unknown): QuoTranscript | null {
  const t = raw as Record<string, unknown>;
  if (!t) return null;
  const dialogue = Array.isArray(t.dialogue) ? t.dialogue : [];
  return {
    recordingId: typeof t.recordingId === "string" ? t.recordingId : undefined,
    status: status(t.status ?? t.processingStatus),
    dialogue: dialogue
      .map((d) => d as Record<string, unknown>)
      .filter((d) => typeof d.content === "string")
      .map((d) => ({ content: String(d.content), start: Number(d.start ?? 0), end: Number(d.end ?? 0), identifier: typeof d.identifier === "string" ? d.identifier : null, actorId: typeof d.actorId === "string" ? d.actorId : typeof d.userId === "string" ? d.userId : null })),
  };
}

export function parseMessage(raw: unknown): QuoMessage | null {
  const m = raw as Record<string, unknown>;
  if (!m || typeof m.id !== "string") return null;
  const to = Array.isArray(m.to) ? m.to.filter((x): x is string => typeof x === "string") : typeof m.to === "string" ? [m.to] : [];
  return { id: m.id, phoneNumberId: typeof m.phoneNumberId === "string" ? m.phoneNumberId : undefined, direction: m.direction === "outgoing" ? "outgoing" : "incoming", from: typeof m.from === "string" ? m.from : "", to, text: typeof m.text === "string" ? m.text : typeof m.content === "string" ? m.content : typeof m.body === "string" ? m.body : "", createdAt: time(m.createdAt) ?? Date.now(), conversationId: typeof m.conversationId === "string" ? m.conversationId : undefined };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function quoClient(apiKey: string): QuoApi {
  if (mockQuo.api) return mockQuo.api;
  let last = 0;
  async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // 10 requests a second per key: never closer than 110ms apart.
      const wait = last + 110 - Date.now();
      if (wait > 0) await pause(wait);
      last = Date.now();
      let response: Response;
      try {
        response = await fetch(`${BASE}${path}`, { method, headers: { Authorization: apiKey, "Quo-Api-Version": VERSION, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      } catch {
        throw new QuoError("unavailable", "Quo could not be reached.");
      }
      if (response.status === 429) {
        await pause(Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new QuoError("unauthorized", "Quo refused the API key. Reconnect Quo with a key from Workspace Settings → API.");
      if (response.status === 404) throw new QuoError("not_found", "Quo has no such record.");
      if (response.status >= 500) throw new QuoError("unavailable", `Quo answered ${response.status}.`);
      if (!response.ok) throw new QuoError("bad_response", `Quo answered ${response.status}.`);
      if (response.status === 204) return null;
      try {
        return await response.json();
      } catch {
        throw new QuoError("bad_response", "Quo's answer was not readable.");
      }
    }
    throw new QuoError("rate_limited", "Quo's rate limit was reached; reading resumes on the next sync.");
  }
  return {
    async numbers() {
      const body = await call("GET", "/phone-numbers?limit=50");
      return list(body).data.map((n) => n as Record<string, unknown>).filter((n) => typeof n.id === "string").map((n) => ({ id: String(n.id), number: String(n.number ?? n.phoneNumber ?? ""), name: typeof n.name === "string" ? n.name : undefined }));
    },
    async calls({ since, after, limit }) {
      const params = new URLSearchParams({ limit: String(Math.min(50, limit)), include: "summary", "createdAt[gte]": new Date(since).toISOString() });
      if (after) params.set("after", after);
      const page = list(await call("GET", `/calls?${params}`));
      return { calls: page.data.map(parseCall).filter((c): c is QuoCall => c !== null), next: page.next };
    },
    async transcripts(callId) {
      const page = list(await call("GET", `/calls/${encodeURIComponent(callId)}/transcripts`));
      return page.data.map(parseTranscript).filter((t): t is QuoTranscript => t !== null);
    },
    async createWebhook(url, events) {
      const body = (await call("POST", "/webhooks", { url, events, resourceIds: ["*"], label: "Selestial Quality" })) as { data?: { id?: string; key?: string }; id?: string; key?: string };
      const data = body?.data ?? body;
      if (!data?.id || !data.key) throw new QuoError("bad_response", "Quo did not return the webhook's signing key.");
      return { id: data.id, key: data.key };
    },
    async deleteWebhook(id) {
      await call("DELETE", `/webhooks/${encodeURIComponent(id)}`);
    },
  };
}

// ── Webhook signatures ───────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Whether the headers could be a Quo delivery at all, before the connection's key is looked up. */
export function quoHeadersPlausible(headers: { id: string | null; timestamp: string | null; signature: string | null }, now: number): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  return Number.isFinite(ts) && Math.abs(now / 1000 - ts) <= 5 * 60;
}

export async function quoSign(key: string, id: string, timestamp: string, body: string): Promise<string> {
  const raw = fromBase64(key.startsWith("whsec_") ? key.slice(6) : key);
  const imported = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64(new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(`${id}.${timestamp}.${body}`))));
}

/** A delivery is genuine only with this connection's key, inside five minutes. With no key, nothing is accepted. */
export async function verifyQuo(input: { key: string | null; id: string | null; timestamp: string | null; signature: string | null; body: string; now: number }): Promise<boolean> {
  if (!input.key || !quoHeadersPlausible(input, input.now)) return false;
  let expected: string;
  try {
    expected = await quoSign(input.key, input.id!, input.timestamp!, input.body);
  } catch {
    return false;
  }
  return input.signature!.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    return version === "v1" && typeof sig === "string" && same(sig, expected);
  });
}

export type QuoEvent =
  | { kind: "call"; eventId: string; type: string; call: QuoCall; link?: string }
  | { kind: "transcript"; eventId: string; callId: string; transcript: QuoTranscript }
  | { kind: "summary"; eventId: string; callId: string; summary: NonNullable<QuoCall["summary"]> }
  | { kind: "message"; eventId: string; type: string; message: QuoMessage }
  | { kind: "ignored"; eventId: string; type: string };

export function parseQuoEvent(body: string): QuoEvent | null {
  let parsed: { id?: unknown; type?: unknown; data?: { resource?: unknown; object?: unknown; links?: { quo?: unknown } } };
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const eventId = typeof parsed.id === "string" ? parsed.id : null;
  const type = typeof parsed.type === "string" ? parsed.type : null;
  if (!eventId || !type) return null;
  const resource = (parsed.data?.resource ?? parsed.data?.object) as Record<string, unknown> | undefined;
  if (!resource) return { kind: "ignored", eventId, type };
  if (type === "call.transcript.completed") {
    const t = parseTranscript(resource);
    return typeof resource.callId === "string" && t ? { kind: "transcript", eventId, callId: resource.callId, transcript: t } : { kind: "ignored", eventId, type };
  }
  if (type === "call.summary.completed") {
    return typeof resource.callId === "string" ? { kind: "summary", eventId, callId: resource.callId, summary: { status: status(resource.processingStatus ?? resource.status), lines: Array.isArray(resource.summary) ? resource.summary.filter((s): s is string => typeof s === "string") : [], nextSteps: Array.isArray(resource.nextSteps) ? resource.nextSteps.filter((s): s is string => typeof s === "string") : [] } } : { kind: "ignored", eventId, type };
  }
  if (type === "call.completed" || type === "call.missed" || type === "call.voicemail.completed") {
    const call = parseCall(resource);
    const link = typeof parsed.data?.links?.quo === "string" && /^https:\/\/[^\s]+$/.test(parsed.data.links.quo) ? parsed.data.links.quo : undefined;
    return call ? { kind: "call", eventId, type, call, link } : { kind: "ignored", eventId, type };
  }
  if (type === "message.received" || type === "message.delivered") {
    const message = parseMessage(resource);
    return message ? { kind: "message", eventId, type, message } : { kind: "ignored", eventId, type };
  }
  return { kind: "ignored", eventId, type };
}

export const QUO_EVENTS = ["call.completed", "call.missed", "call.voicemail.completed", "call.transcript.completed", "call.summary.completed", "message.received"];
