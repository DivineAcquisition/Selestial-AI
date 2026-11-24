/**
 * Telnyx, for texts. Sending is one request with an Idempotency-Key, so a retry of the same message is
 * the same message at Telnyx. Verified on November 21, 2026 in Telnyx's OpenAPI for POST /v2/messages: a
 * successful response is replayed for 24 hours with `Idempotent-Replayed: true`; the same key still in
 * progress is 409 (10036); the same key with a different body is 422; errors are not replayed. Webhooks are Ed25519-signed over "{timestamp}|{raw body}" and are refused
 * when the signature does not verify or the timestamp is more than five minutes from now.
 *
 * Settings on the deployment: TELNYX_API_KEY (the API v2 key), TELNYX_PUBLIC_KEY (the account's webhook
 * public key, base64), and optionally TELNYX_MESSAGING_PROFILE_ID.
 *
 * Each text names its own webhook address (this deployment's /webhooks/telnyx), so delivery reports come
 * here whatever the number's messaging profile points at. Texts coming IN go to the profile's webhook,
 * so the company's number needs a profile whose webhook is https://<deployment>.convex.site/webhooks/telnyx.
 */
import { sendBlocked } from "../environment";
import type { MessagingProvider, SendInput, SendResult } from "./provider";

const API = "https://api.telnyx.com/v2/messages";
const FIVE_MINUTES = 5 * 60;
/**
 * How long a send may take. A request that times out may still have reached Telnyx, so it is never
 * failed or retried blindly: it is left unconfirmed and checked again under the same idempotency key.
 */
const SEND_TIMEOUT_MS = 15_000;

/**
 * Words for a person from Telnyx's error codes, never the raw response. Only codes whose meaning
 * Telnyx's references agree on are listed; any other code is named as a code. Only a rate limit or
 * Telnyx's own trouble is worth trying again.
 */
const ERRORS: Record<string, { retryable: boolean; problem: string }> = {
  "40001": { retryable: false, problem: "The carrier says this number cannot receive texts (it may be a landline)." },
  "40002": { retryable: false, problem: "The carrier blocked this text as spam." },
  "40305": { retryable: false, problem: "The company's texting number is not assigned to a Telnyx messaging profile." },
  "40310": { retryable: false, problem: "The phone number on file is not valid." },
  "40329": { retryable: false, problem: "Selestial's toll-free number isn't verified yet, so carriers block its texts." },
};

/**
 * 40300 "Blocked due to STOP message": the recipient opted out of this messaging profile at Telnyx
 * (developers.telnyx.com/docs/messaging/messages/advanced-opt-in-out). Recorded as a suppression.
 */
const PROVIDER_BLOCK = "40300";
const BLOCK_WORDS = "This number opted out of texts from this business with the carrier (it replied STOP), so the text was not sent.";

/** Where this deployment takes Telnyx webhooks. Convex sets CONVEX_SITE_URL on every deployment. */
export function telnyxWebhookUrl(): string | null {
  const site = (process.env.TELNYX_WEBHOOK_URL ?? process.env.CONVEX_SITE_URL)?.trim().replace(/\/+$/, "");
  if (!site || !/^https:\/\//.test(site)) return null;
  return site.endsWith("/webhooks/telnyx") ? site : `${site}/webhooks/telnyx`;
}

export function telnyxConfigured(): boolean {
  return Boolean(process.env.TELNYX_API_KEY?.trim());
}

export function telnyxProvider(fetcher: typeof fetch = fetch): MessagingProvider {
  return {
    name: "telnyx",
    async send(input: SendInput): Promise<SendResult> {
      // A backend that is not production texts only its test recipients (convex/lib/environment.ts).
      const blocked = sendBlocked(input.to);
      if (blocked) return { ok: false, retryable: false, problem: blocked };
      const key = process.env.TELNYX_API_KEY?.trim();
      if (!key) return { ok: false, retryable: false, problem: "Telnyx is chosen, but its API key is not set on the deployment." };
      if (!input.from) return { ok: false, retryable: false, problem: "The company has no texting number to send from." };
      // The company's own profile; the deployment-wide one only for a number provisioned before profiles were per company.
      const profile = input.messagingProfileId?.trim() || process.env.TELNYX_MESSAGING_PROFILE_ID?.trim();
      const hooks = telnyxWebhookUrl();
      let response: Response;
      try {
        response = await fetcher(API, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json", "idempotency-key": `selestial-${input.idempotencyKey}`.slice(0, 255) },
          body: JSON.stringify({ from: input.from, to: input.to, text: input.body, type: "SMS", ...(profile ? { messaging_profile_id: profile } : {}), ...(hooks ? { webhook_url: hooks } : {}) }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        // Timed out or the connection dropped: Telnyx may have taken it. Checked again under the same key, never resent blindly.
        return { ok: false, retryable: false, uncertain: true, problem: "Telnyx didn't answer in time, so it isn't known yet whether the text went. It will be checked again under the same key; it is not sent twice." };
      }
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      if (response.ok) {
        const data = (json as { data?: { id?: unknown; parts?: unknown; to?: { status?: unknown }[] } } | null)?.data;
        if (typeof data?.id !== "string") return { ok: false, retryable: false, problem: "Telnyx answered without a message id, so it is not known whether the text went." };
        // Telnyx takes the message here. Whether the phone got it arrives later, by webhook.
        // `parts` is Telnyx's billable segment count for this text, after any smart encoding. It is what the text is charged on.
        const parts = typeof data.parts === "number" && Number.isInteger(data.parts) && data.parts > 0 ? data.parts : undefined;
        // A repeat of a key Telnyx already answered successfully is replayed, not sent again (verified in its OpenAPI, November 21, 2026).
        const replayed = response.headers.get("idempotent-replayed")?.trim().toLowerCase() === "true";
        return { ok: true, providerMessageId: data.id, delivered: data.to?.[0]?.status === "delivered", ...(parts ? { parts } : {}), ...(replayed ? { replayed: true } : {}) };
      }
      // An earlier request with this key is still being worked on at Telnyx (10036), so that attempt reached it and may
      // send. Unknown, never failed: it is left unconfirmed and checked again under the same key, which Telnyx replays.
      if (response.status === 409) return { ok: false, retryable: false, uncertain: true, problem: "Telnyx is still working on an earlier attempt of this text, so it may have gone. It will be checked again; it is not sent twice." };
      // Telnyx holds a different request under this key, so the first attempt reached it. Not failed, and not sent again.
      if (response.status === 422) return { ok: false, retryable: false, uncertain: true, problem: "Telnyx already has an earlier attempt of this text under its key, with different wording, so it was not sent again. It most likely went the first time." };
      const code = (json as { errors?: { code?: unknown }[] } | null)?.errors?.[0]?.code;
      if (code === PROVIDER_BLOCK) return { ok: false, retryable: false, providerBlock: true, problem: BLOCK_WORDS };
      const known = typeof code === "string" ? ERRORS[code] : undefined;
      if (known) return { ok: false, ...known };
      if (response.status === 429) return { ok: false, retryable: true, problem: "Telnyx asked us to slow down. The text will be tried again." };
      if (response.status >= 500) return { ok: false, retryable: true, problem: "Telnyx had a problem on its side. The text will be tried again." };
      if (response.status === 401 || response.status === 403) return { ok: false, retryable: false, problem: "Texting isn’t available right now." };
      return { ok: false, retryable: false, problem: `Telnyx would not send this text (${typeof code === "string" ? `code ${code}` : `status ${response.status}`}).` };
    },
  };
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value.trim());
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Whether a webhook came from Telnyx, unaltered and recent. Anything missing or malformed is false. */
export async function verifyTelnyx(input: { publicKey: string; signature: string | null; timestamp: string | null; body: string; now: number }): Promise<boolean> {
  if (!input.signature || !input.timestamp || !/^\d{9,11}$/.test(input.timestamp)) return false;
  if (Math.abs(Math.floor(input.now / 1000) - Number(input.timestamp)) > FIVE_MINUTES) return false;
  const key = base64Bytes(input.publicKey);
  const signature = base64Bytes(input.signature);
  if (!key || key.length !== 32 || !signature || signature.length !== 64) return false;
  try {
    const imported = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, imported, signature, new TextEncoder().encode(`${input.timestamp}|${input.body}`));
  } catch {
    return false;
  }
}

export type TelnyxEvent =
  /**
   * `unconfirmed`: finalized as `delivery_unconfirmed`, the carrier never said. `beforeCarrier`: finalized as
   * `sending_failed`, it never left Telnyx for the carrier network (Selestial doesn't charge for those).
   */
  | { kind: "receipt"; eventId: string; providerMessageId: string; outcome: "delivered" | "failed" | "unconfirmed"; problem: string | null; costUnits: number | null; errorCode: string | null; beforeCarrier: boolean; occurredAt: number | null }
  /** `autoresponseType`: Telnyx already answered this STOP, START or HELP itself (the profile's auto-response). */
  | { kind: "inbound"; eventId: string; from: string; to: string; text: string; receivedAt: number; providerMessageId: string | null; parts: number | null; media: number; autoresponseType: "stop" | "start" | "help" | null; messagingProfileId: string | null }
  /** A 10DLC brand, campaign or number update. Only a hint: the registration's state is always read back from Telnyx. */
  | { kind: "registration"; eventId: string; type: string; brandId: string | null; campaignId: string | null; phoneNumber: string | null }
  | { kind: "ignored" };

const s = (value: unknown) => (typeof value === "string" && value.length > 0 && value.length < 200 ? value : null);

/** A 10DLC callback, enveloped ({ data: { event_type, id, payload } }) or flat, as Telnyx documents both. */
function registrationEvent(parsed: unknown): TelnyxEvent | null {
  const root = parsed as { data?: { id?: unknown; event_type?: unknown; payload?: Record<string, unknown> } } & Record<string, unknown>;
  const data = root.data;
  const type = s(data?.event_type) ?? s(root.event_type) ?? s(root.eventType);
  const payload = (data?.payload ?? root) as Record<string, unknown>;
  const isRegistration = (type?.startsWith("10dlc.") ?? false) || (!data && (s(payload.brandId) !== null || s(payload.campaignId) !== null));
  if (!isRegistration) return null;
  const brandId = s(payload.brandId);
  const campaignId = s(payload.campaignId);
  const phoneNumber = s(payload.phoneNumber) ?? s(payload.phone_number);
  const eventId = s(data?.id) ?? s(root.id) ?? `${type ?? "10dlc"}:${brandId ?? ""}:${campaignId ?? ""}:${phoneNumber ?? ""}:${s(payload.eventType) ?? s(payload.type) ?? ""}:${s(payload.status) ?? ""}`;
  return { kind: "registration", eventId: eventId.slice(0, 200), type: type ?? "10dlc", brandId, campaignId, phoneNumber };
}

/** What a webhook says, in the shape the record takes. Events that change nothing here are ignored. */
export function telnyxEvent(body: string): TelnyxEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "ignored" };
  }
  const registration = registrationEvent(parsed);
  if (registration) return registration;
  const data = (parsed as { data?: { id?: unknown; event_type?: unknown; occurred_at?: unknown; payload?: Record<string, unknown> } }).data;
  if (!data || typeof data.id !== "string" || !data.payload) return { kind: "ignored" };
  const payload = data.payload as { id?: unknown; text?: unknown; parts?: unknown; media?: unknown[]; cost?: { amount?: unknown; currency?: unknown } | null; from?: { phone_number?: unknown }; to?: { phone_number?: unknown; status?: unknown }[]; errors?: { code?: unknown; title?: unknown }[]; autoresponse_type?: unknown; messaging_profile_id?: unknown };
  const occurred = typeof data.occurred_at === "string" ? Date.parse(data.occurred_at) : NaN;
  const occurredAt = Number.isFinite(occurred) ? occurred : null;
  // What Telnyx charged Selestial (USD, as a decimal string), kept in units of $0.0001 for internal margin tracking.
  const costAmount = payload.cost && payload.cost.currency === "USD" ? Number(payload.cost.amount) : NaN;
  const costUnits = Number.isFinite(costAmount) ? Math.round(costAmount * 10_000) : null;
  const firstCode = payload.errors?.[0]?.code;
  const errorCode = typeof firstCode === "string" ? firstCode.slice(0, 20) : null;
  if (data.event_type === "message.finalized") {
    const status = payload.to?.[0]?.status;
    if (typeof payload.id !== "string") return { kind: "ignored" };
    if (status === "delivered") return { kind: "receipt", eventId: data.id, providerMessageId: payload.id, outcome: "delivered", problem: null, costUnits, errorCode, beforeCarrier: false, occurredAt };
    if (status === "delivery_failed" || status === "sending_failed" || status === "expired") {
      const code = payload.errors?.[0]?.code;
      const problem = code === PROVIDER_BLOCK ? BLOCK_WORDS : typeof code === "string" ? (ERRORS[code]?.problem ?? null) : null;
      return { kind: "receipt", eventId: data.id, providerMessageId: payload.id, outcome: "failed", problem, costUnits, errorCode, beforeCarrier: status !== "delivery_failed", occurredAt };
    }
    // The carrier never confirmed the phone got it. Kept as its own state: "Delivery not confirmed", never "Delivered".
    if (status === "delivery_unconfirmed") return { kind: "receipt", eventId: data.id, providerMessageId: payload.id, outcome: "unconfirmed", problem: null, costUnits, errorCode, beforeCarrier: false, occurredAt };
    return { kind: "ignored" };
  }
  if (data.event_type === "message.received") {
    const from = payload.from?.phone_number;
    const to = payload.to?.[0]?.phone_number;
    if (typeof from !== "string" || typeof to !== "string") return { kind: "ignored" };
    const parts = typeof payload.parts === "number" && Number.isInteger(payload.parts) && payload.parts > 0 ? payload.parts : null;
    const auto = typeof payload.autoresponse_type === "string" ? payload.autoresponse_type.toLowerCase() : "";
    const autoresponseType = auto === "stop" || auto === "start" || auto === "help" ? auto : null;
    return { kind: "inbound", eventId: data.id, from, to, text: typeof payload.text === "string" ? payload.text : "", receivedAt: occurredAt ?? Date.now(), providerMessageId: typeof payload.id === "string" ? payload.id : null, parts, media: Array.isArray(payload.media) ? payload.media.length : 0, autoresponseType, messagingProfileId: s(payload.messaging_profile_id) };
  }
  return { kind: "ignored" };
}
