/**
 * HighLevel (GoHighLevel / LeadConnector), read through Selestial's Marketplace app: the Owner installs the
 * app on their HighLevel sub-account (OAuth), and Quality reads that location's texts, emails and call
 * transcriptions as evidence. Read-only scopes; Selestial never sends through HighLevel, and never fetches a
 * call recording (the recording endpoint is not called anywhere).
 *
 * Shapes are from HighLevel's developer docs (marketplace.gohighlevel.com/docs, read November 23, 2026):
 * - OAuth token: POST https://services.leadconnectorhq.com/oauth/token (authorization_code / refresh_token).
 *   Access tokens last about a day; refresh tokens rotate on every use and the old one stops working.
 * - GET /conversations/search?locationId=…, GET /conversations/{id}/messages (lastMessageId cursor),
 *   GET /conversations/locations/{locationId}/messages/{messageId}/transcription.
 * - Webhooks (one URL for the app): InboundMessage, OutboundMessage, INSTALL, UNINSTALL, signed with Ed25519
 *   in `X-GHL-Signature` over the raw body, with HighLevel's published public key.
 * - 100 requests per 10 seconds per location; a 429 has no Retry-After.
 * NOT verified against the live API from this work: the install link's exact form (taken from the app's own
 * settings, `HIGHLEVEL_INSTALL_URL`), the `Version` header value (`HIGHLEVEL_API_VERSION`), the token
 * request's content type, and the transcription response's top-level shape.
 */
export const HL_BASE = "https://services.leadconnectorhq.com";
export const HL_SCOPES = ["conversations.readonly", "conversations/message.readonly", "contacts.readonly", "locations.readonly"] as const;

/** HighLevel's published Ed25519 key for `X-GHL-Signature` (webhook integration guide). */
export const HL_WEBHOOK_PUBLIC_KEY = "MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=";

export type HighLevelApp = { clientId: string; clientSecret: string; installUrl: string; version: string };

/** The Marketplace app's settings on this deployment, or null when it has not been registered and configured. */
export function highLevelApp(): HighLevelApp | null {
  const clientId = process.env.HIGHLEVEL_CLIENT_ID?.trim();
  const clientSecret = process.env.HIGHLEVEL_CLIENT_SECRET?.trim();
  const installUrl = process.env.HIGHLEVEL_INSTALL_URL?.trim();
  if (!clientId || !clientSecret || !installUrl || !/^https:\/\/[^\s]+$/.test(installUrl)) return null;
  return { clientId, clientSecret, installUrl, version: process.env.HIGHLEVEL_API_VERSION?.trim() || "2021-07-28" };
}

export function highLevelRedirect(): string | null {
  const site = process.env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
  return site && /^https?:\/\//.test(site) ? `${site}/oauth/highlevel/callback` : null;
}

/** The app's own install link (from its settings) with this attempt's one-time state and our callback. */
export function installUrlFor(app: HighLevelApp, redirect: string, state: string): string {
  const url = new URL(app.installUrl);
  url.searchParams.set("state", state);
  if (!url.searchParams.has("redirect_uri")) url.searchParams.set("redirect_uri", redirect);
  if (!url.searchParams.has("client_id")) url.searchParams.set("client_id", app.clientId);
  if (!url.searchParams.has("response_type")) url.searchParams.set("response_type", "code");
  if (!url.searchParams.has("scope")) url.searchParams.set("scope", HL_SCOPES.join(" "));
  return url.toString();
}

export class HighLevelError extends Error {
  constructor(
    public kind: "unauthorized" | "not_found" | "rate_limited" | "unavailable" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

export type HighLevelTokens = { accessToken: string; refreshToken: string; expiresAt: number; locationId: string | null; companyId: string | null; userType: string; scope: string[] };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function tokensFrom(raw: Record<string, unknown>, now: number): HighLevelTokens {
  const access = typeof raw.access_token === "string" ? raw.access_token : null;
  const refresh = typeof raw.refresh_token === "string" ? raw.refresh_token : null;
  if (!access || !refresh) throw new HighLevelError("invalid", "HighLevel did not return the tokens Selestial needs.");
  const expires = typeof raw.expires_in === "number" ? raw.expires_in : Number(raw.expires_in) || 86_000;
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: now + Math.max(60, expires - 120) * 1000,
    locationId: typeof raw.locationId === "string" ? raw.locationId : null,
    companyId: typeof raw.companyId === "string" ? raw.companyId : null,
    userType: typeof raw.userType === "string" ? raw.userType : "Location",
    scope: typeof raw.scope === "string" ? raw.scope.split(/\s+/).filter(Boolean) : [],
  };
}

async function tokenRequest(fetcher: Fetch, fields: Record<string, string>): Promise<HighLevelTokens> {
  const response = await fetcher(`${HL_BASE}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(fields).toString() });
  if (response.status === 400 || response.status === 401 || response.status === 403) throw new HighLevelError("unauthorized", "HighLevel refused the authorization. Install the app again.");
  if (!response.ok) throw new HighLevelError("unavailable", `HighLevel answered ${response.status}. Try again in a few minutes.`);
  return tokensFrom((await response.json()) as Record<string, unknown>, Date.now());
}

export const mockHighLevel: { api: HighLevelApi | null; tokens: ((grant: "authorization_code" | "refresh_token", value: string) => HighLevelTokens) | null } = { api: null, tokens: null };

export async function exchangeCode(app: HighLevelApp, code: string, redirect: string, fetcher: Fetch = fetch): Promise<HighLevelTokens> {
  if (mockHighLevel.tokens) return mockHighLevel.tokens("authorization_code", code);
  return tokenRequest(fetcher, { client_id: app.clientId, client_secret: app.clientSecret, grant_type: "authorization_code", code, user_type: "Location", redirect_uri: redirect });
}

/** Refresh tokens rotate: the caller must store the new one before using the access token. */
export async function refreshTokens(app: HighLevelApp, refreshToken: string, redirect: string, fetcher: Fetch = fetch): Promise<HighLevelTokens> {
  if (mockHighLevel.tokens) return mockHighLevel.tokens("refresh_token", refreshToken);
  return tokenRequest(fetcher, { client_id: app.clientId, client_secret: app.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken, user_type: "Location", redirect_uri: redirect });
}

// ── Messages ─────────────────────────────────────────────────────────────────────────────────────

export type HighLevelMessage = {
  id: string;
  kind: "call" | "sms" | "email" | "voicemail" | "other";
  direction: "incoming" | "outgoing";
  body: string;
  subject?: string;
  contactId?: string;
  conversationId?: string;
  locationId?: string;
  occurredAt: number;
  callDuration?: number;
  callStatus?: string;
  from?: string;
  to?: string;
};

function kindOf(raw: Record<string, unknown>): HighLevelMessage["kind"] {
  const t = String(raw.messageTypeString ?? raw.messageType ?? "").toUpperCase();
  if (t.includes("VOICEMAIL")) return "voicemail";
  if (t.includes("CALL")) return "call";
  if (t.includes("SMS")) return "sms";
  if (t.includes("EMAIL")) return "email";
  return "other";
}

const plain = (html: string) => html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, " ").trim();

/** A message from the API or a webhook. Email HTML is reduced to its text; the quoted history is removed later. */
export function parseHighLevelMessage(raw: unknown): HighLevelMessage | null {
  const m = raw as Record<string, unknown>;
  const id = typeof m?.messageId === "string" ? m.messageId : typeof m?.id === "string" ? m.id : null;
  if (!id) return null;
  const kind = kindOf(m);
  const meta = (m.meta ?? {}) as Record<string, unknown>;
  const duration = Number(m.callDuration ?? meta.callDuration);
  const body = typeof m.plainText === "string" ? m.plainText : typeof m.body === "string" ? (kind === "email" ? plain(m.body) : m.body) : "";
  const at = typeof m.dateAdded === "string" ? Date.parse(m.dateAdded) : typeof m.dateAdded === "number" ? m.dateAdded : NaN;
  return {
    id,
    kind,
    direction: m.direction === "outbound" || m.direction === "outgoing" ? "outgoing" : "incoming",
    body: body.slice(0, 20_000),
    ...(typeof m.subject === "string" ? { subject: m.subject.slice(0, 300) } : {}),
    ...(typeof m.contactId === "string" ? { contactId: m.contactId } : {}),
    ...(typeof m.conversationId === "string" ? { conversationId: m.conversationId } : {}),
    ...(typeof m.locationId === "string" ? { locationId: m.locationId } : {}),
    occurredAt: Number.isFinite(at) ? at : Date.now(),
    ...(Number.isFinite(duration) && duration > 0 ? { callDuration: duration } : {}),
    ...(typeof (m.callStatus ?? meta.callStatus) === "string" ? { callStatus: String(m.callStatus ?? meta.callStatus) } : {}),
    ...(typeof m.from === "string" ? { from: m.from } : {}),
    ...(typeof m.to === "string" ? { to: m.to } : {}),
  };
}

export type HighLevelSentence = { channel: number | null; start: number; end: number; text: string };

/** A call's transcription. HighLevel names no speaker, only a media channel; Selestial does not guess who spoke. */
export function parseTranscription(raw: unknown): HighLevelSentence[] {
  const r = raw as Record<string, unknown> | unknown[];
  const list = Array.isArray(r) ? r : Array.isArray((r as Record<string, unknown>)?.sentences) ? ((r as Record<string, unknown>).sentences as unknown[]) : Array.isArray((r as Record<string, unknown>)?.transcription) ? ((r as Record<string, unknown>).transcription as unknown[]) : [];
  return list
    .map((x) => x as Record<string, unknown>)
    .filter((x) => typeof x?.transcript === "string" && (x.transcript as string).trim())
    .sort((a, b) => Number(a.sentenceIndex ?? 0) - Number(b.sentenceIndex ?? 0))
    .map((x) => ({ channel: typeof x.mediaChannel === "number" ? x.mediaChannel : null, start: Number(x.startTime ?? 0) / 1000, end: Number(x.endTime ?? 0) / 1000, text: String(x.transcript).slice(0, 2000) }));
}

export interface HighLevelApi {
  /** Conversations with activity since `since`, newest first, at most `limit`. */
  conversations(locationId: string, since: number, limit: number): Promise<{ id: string; contactId?: string; lastMessageAt?: number }[]>;
  /** One page of a conversation's messages; `next` continues it. */
  messages(conversationId: string, after?: string): Promise<{ messages: HighLevelMessage[]; next: string | null }>;
  /** The call's transcription, or [] when there is none (yet). */
  transcription(locationId: string, messageId: string): Promise<HighLevelSentence[]>;
  /** A contact's phone numbers and email addresses, to match a customer on evidence. */
  contact(contactId: string): Promise<{ phones: string[]; emails: string[]; name?: string } | null>;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function highLevelClient(accessToken: string, version: string, fetcher: Fetch = fetch): HighLevelApi {
  if (mockHighLevel.api) return mockHighLevel.api;
  let last = 0;
  async function get(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // 100 requests per 10 seconds per location: never closer than 110ms apart.
      const wait = last + 110 - Date.now();
      if (wait > 0) await pause(wait);
      last = Date.now();
      const response = await fetcher(`${HL_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}`, Version: version, Accept: "application/json" } });
      if (response.status === 429) {
        await pause(Math.min(10_000, 1000 * 2 ** attempt));
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new HighLevelError("unauthorized", "HighLevel refused Selestial's access. Install the app again.");
      if (response.status === 404) throw new HighLevelError("not_found", "HighLevel has no such record.");
      if (!response.ok) throw new HighLevelError("unavailable", `HighLevel answered ${response.status}.`);
      return response.json();
    }
    throw new HighLevelError("rate_limited", "HighLevel is limiting requests right now. Reading resumes on the next sync.");
  }
  return {
    async conversations(locationId, since, limit) {
      const data = (await get(`/conversations/search?locationId=${encodeURIComponent(locationId)}&sort=desc&sortBy=last_message_date&limit=${Math.min(100, limit)}&startAfterDate=${since}`)) as { conversations?: Record<string, unknown>[] };
      return (data.conversations ?? []).filter((c) => typeof c.id === "string").map((c) => ({ id: String(c.id), ...(typeof c.contactId === "string" ? { contactId: c.contactId } : {}), ...(typeof c.lastMessageDate === "number" ? { lastMessageAt: c.lastMessageDate } : {}) }));
    },
    async messages(conversationId, after) {
      const data = (await get(`/conversations/${encodeURIComponent(conversationId)}/messages?limit=50&type=TYPE_SMS,TYPE_CALL,TYPE_EMAIL${after ? `&lastMessageId=${encodeURIComponent(after)}` : ""}`)) as { messages?: { messages?: unknown[]; lastMessageId?: string; nextPage?: boolean } };
      const page = data.messages ?? {};
      return { messages: (page.messages ?? []).map(parseHighLevelMessage).filter((m): m is HighLevelMessage => m !== null), next: page.nextPage && page.lastMessageId ? page.lastMessageId : null };
    },
    async transcription(locationId, messageId) {
      try {
        return parseTranscription(await get(`/conversations/locations/${encodeURIComponent(locationId)}/messages/${encodeURIComponent(messageId)}/transcription`));
      } catch (error) {
        if (error instanceof HighLevelError && error.kind === "not_found") return [];
        throw error;
      }
    },
    async contact(contactId) {
      try {
        const data = (await get(`/contacts/${encodeURIComponent(contactId)}`)) as { contact?: Record<string, unknown> };
        const c = data.contact ?? {};
        const phones = [c.phone, ...(Array.isArray(c.additionalPhones) ? c.additionalPhones.map((p) => (p as Record<string, unknown>)?.phone ?? p) : [])].filter((p): p is string => typeof p === "string" && p.length > 0);
        const emails = [c.email, ...(Array.isArray(c.additionalEmails) ? c.additionalEmails.map((e) => (e as Record<string, unknown>)?.email ?? e) : [])].filter((e): e is string => typeof e === "string" && e.includes("@"));
        return { phones, emails, ...(typeof c.name === "string" ? { name: c.name } : {}) };
      } catch (error) {
        if (error instanceof HighLevelError && error.kind === "not_found") return null;
        throw error;
      }
    },
  };
}

// ── Webhook signatures ───────────────────────────────────────────────────────────────────────────

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** For tests only: a key pair's public half can stand in for HighLevel's. */
export const highLevelKeyOverride: { spkiBase64: string | null } = { spkiBase64: null };

/**
 * Whether a delivery carries HighLevel's Ed25519 signature over its exact body. Fails closed: a missing or
 * malformed signature, or a runtime that cannot verify Ed25519, accepts nothing. The older RSA header
 * (`X-WH-Signature`) was retired by HighLevel on September 1, 2026 and is not accepted.
 */
export async function verifyHighLevel(body: string, signature: string | null): Promise<boolean> {
  if (!signature || signature.length > 200) return false;
  try {
    const key = await crypto.subtle.importKey("spki", fromBase64(highLevelKeyOverride.spkiBase64 ?? HL_WEBHOOK_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64(signature), new TextEncoder().encode(body));
  } catch {
    return false;
  }
}
