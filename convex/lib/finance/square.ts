/**
 * Square's REST API, called directly for Finance (docs/finance/square.md).
 *
 * Each cleaning company authorizes its own Square account through OAuth (the code flow). Selestial
 * stores that company's tokens sealed and acts only with them: there is no platform token that can reach
 * every company, and the access token configured as SQUARE_ACCESS_TOKEN is deliberately never read.
 *
 * Every call keeps the HTTP status and classifies it like convex/lib/finance/stripe.ts:
 *   ok          2xx: Square answered.
 *   refused     4xx: Square said no, with its first error's code and words. Nothing happened.
 *   unavailable 5xx, 429, timeout or network failure. For a write this is UNCERTAIN: it may have
 *               happened. The caller marks the record "checking" and asks again with the SAME
 *               idempotency key, or looks the object up. A write is never retried under a new key.
 *
 * Settings on the Convex deployment (names only; values are never logged or sent to a browser):
 *   SQUARE_APPLICATION_ID            the application's ID. "sandbox-sq0idb-…" is Sandbox, "sq0idp-…" Production.
 *   SQUARE_APPLICATION_SECRET        the OAuth secret for the same application and environment.
 *   SQUARE_WEBHOOK_SIGNATURE_KEY     the signature key of the webhook subscription pointed at /webhooks/square.
 *   SQUARE_OAUTH_REDIRECT_URI        optional: the exact redirect URL registered with Square, when it is not
 *                                    the deployment's own <site>/oauth/square/callback.
 *   SQUARE_WEBHOOK_URL               optional: the exact notification URL registered with Square, when it is
 *                                    not <site>/webhooks/square. Square signs the URL, so it must match.
 *   MAILBOX_TOKEN_KEY                the 32-byte key every stored authorization is sealed with.
 */
import { isNonProduction } from "../environment";

/** The API version Selestial was built and tested against. Sent on every call, never left to the app's default. */
export const SQUARE_VERSION = "2026-11-18";
const TIMEOUT_MS = 15_000;

export const SQUARE_CALLBACK_PATH = "/oauth/square/callback";
export const SQUARE_WEBHOOK_PATH = "/webhooks/square";

/** Only what the built features use: read the business and its locations, make checkout links, read and refund payments. */
export const SQUARE_SCOPES = ["MERCHANT_PROFILE_READ", "ORDERS_READ", "ORDERS_WRITE", "PAYMENTS_READ", "PAYMENTS_WRITE"] as const;

/** Square's webhook events Finance listens for. Anything else is acknowledged and ignored. */
export const SQUARE_EVENTS = ["payment.created", "payment.updated", "refund.created", "refund.updated", "oauth.authorization.revoked"] as const;

export type SquareEnvironment = "sandbox" | "production";

export type SquareConfig = {
  environment: SquareEnvironment;
  applicationId: string;
  /** Absent until set: connecting is then blocked with an honest reason. */
  secret: string | null;
  webhookKey: string | null;
  apiBase: string;
  redirectUri: string | null;
  webhookUrl: string | null;
};

type Env = Record<string, string | undefined>;

function siteOrigin(env: Env): string | null {
  const site = env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
  return site && /^https:\/\//.test(site) ? site : null;
}

/** The exact redirect URL registered with Square: the override when it ends in the callback path, else the deployment's own. */
export function squareRedirectUri(env: Env = process.env): string | null {
  const set = env.SQUARE_OAUTH_REDIRECT_URI?.trim();
  if (set && /^https:\/\/[a-z0-9.-]+\/oauth\/square\/callback$/i.test(set)) return set;
  const site = siteOrigin(env);
  return site ? `${site}${SQUARE_CALLBACK_PATH}` : null;
}

/** The exact notification URL Square signs. The override when it ends in the webhook path, else the deployment's own. */
export function squareWebhookUrl(env: Env = process.env): string | null {
  const set = env.SQUARE_WEBHOOK_URL?.trim();
  if (set && /^https:\/\/[a-z0-9.-]+\/webhooks\/square$/i.test(set)) return set;
  const site = siteOrigin(env);
  return site ? `${site}${SQUARE_WEBHOOK_PATH}` : null;
}

/** Which Square environment an application ID belongs to, by Square's own prefixes. Anything else is not trusted. */
export function environmentOf(applicationId: string): SquareEnvironment | null {
  if (/^sandbox-sq0idb-[\w-]{10,}$/.test(applicationId)) return "sandbox";
  if (/^sq0idp-[\w-]{10,}$/.test(applicationId)) return "production";
  return null;
}

/**
 * Square as this deployment may use it, or null when it can't be used at all. A deployment that is not
 * production never uses a Production application, so nothing it does can take a real payment.
 */
export function squareConfig(env: Env = process.env, nonProduction: boolean = isNonProduction()): SquareConfig | null {
  const applicationId = env.SQUARE_APPLICATION_ID?.trim() ?? "";
  const environment = environmentOf(applicationId);
  if (!environment) return null;
  if (environment === "production" && nonProduction) return null;
  const secret = env.SQUARE_APPLICATION_SECRET?.trim() || null;
  const webhookKey = env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim() || null;
  return {
    environment,
    applicationId,
    secret,
    webhookKey,
    apiBase: environment === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com",
    redirectUri: squareRedirectUri(env),
    webhookUrl: squareWebhookUrl(env),
  };
}

/**
 * What still stops companies from connecting Square on this deployment, in words for the Owner and the
 * setting names for Selestial's team. Empty means connecting can start. Values are never included.
 */
export function squareBlockers(config: SquareConfig | null, sealingReady: boolean, env: Env = process.env): { words: string; settings: string[] }[] {
  const out: { words: string; settings: string[] }[] = [];
  if (!config) {
    const id = env.SQUARE_APPLICATION_ID?.trim() ?? "";
    out.push(
      environmentOf(id) === "production"
        ? { words: "This is a test backend, so it never uses Selestial's live Square app.", settings: ["SQUARE_APPLICATION_ID (a Sandbox ID here)"] }
        : { words: "Selestial's Square app isn't set up on this backend.", settings: ["SQUARE_APPLICATION_ID"] },
    );
    return out;
  }
  if (!config.secret) out.push({ words: "Selestial's Square app secret isn't set yet.", settings: ["SQUARE_APPLICATION_SECRET"] });
  if (!config.redirectUri) out.push({ words: "This backend's public address isn't known, so Square has nowhere to send you back.", settings: ["CONVEX_SITE_URL or SQUARE_OAUTH_REDIRECT_URI"] });
  if (!sealingReady) out.push({ words: "The key Selestial seals authorizations with isn't set.", settings: ["MAILBOX_TOKEN_KEY"] });
  return out;
}

/** Why payments can't be confirmed as quickly as they should: without the webhook key, Selestial reads Square on a schedule only. */
export function webhookReady(config: SquareConfig | null): boolean {
  return Boolean(config?.webhookKey && config.webhookUrl);
}

/**
 * Square's authorization page. `session=false` is required in Production and ignored in Sandbox. The
 * redirect is the one registered for the application in Square's Developer Console (the code flow takes
 * no redirect_uri), which is why its exact value is shown to Selestial's team in setup.
 */
export function authorizeUrl(config: SquareConfig, state: string): string {
  const params = new URLSearchParams({ client_id: config.applicationId, scope: SQUARE_SCOPES.join(" "), state, response_type: "code" });
  if (config.environment === "production") params.set("session", "false");
  return `${config.apiBase}/oauth2/authorize?${params.toString()}`;
}

// ── Transport ────────────────────────────────────────────────────────────────────────────────────

let transport: typeof fetch | null = null;
/** Where requests go. Tests point this at a stand-in for Square; nothing else changes it. */
export function setSquareTransportForTests(next: typeof fetch | null): void {
  transport = next;
}

export type Answer<T> =
  | { kind: "ok"; data: T }
  | { kind: "refused"; status: number; code: string | null; message: string }
  | { kind: "unavailable"; status: number | null; message: string };

type Auth = { bearer: string } | { client: string } | null;

async function call<T>(config: SquareConfig, method: "GET" | "POST" | "DELETE", path: string, auth: Auth, body?: unknown): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await (transport ?? fetch)(`${config.apiBase}${path}`, {
      method,
      headers: {
        "Square-Version": SQUARE_VERSION,
        Accept: "application/json",
        ...(auth && "bearer" in auth ? { Authorization: `Bearer ${auth.bearer}` } : {}),
        ...(auth && "client" in auth ? { Authorization: `Client ${auth.client}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { kind: "unavailable", status: null, message: "Square could not be reached." };
  }
  if (response.status >= 200 && response.status < 300) {
    try {
      return { kind: "ok", data: (await response.json()) as T };
    } catch {
      return { kind: "unavailable", status: response.status, message: "Square's answer could not be read." };
    }
  }
  if (response.status === 429 || response.status >= 500) return { kind: "unavailable", status: response.status, message: "Square is busy or having a problem." };
  let code: string | null = null;
  let message = "Square declined the request.";
  try {
    const parsed = (await response.json()) as { errors?: { code?: unknown; detail?: unknown; category?: unknown }[]; message?: unknown; type?: unknown };
    const first = parsed.errors?.[0];
    if (typeof first?.code === "string") code = first.code.slice(0, 80);
    if (typeof first?.detail === "string") message = first.detail.slice(0, 300);
    // The OAuth endpoints answer with their own shape.
    if (!first && typeof parsed.type === "string") code = parsed.type.slice(0, 80);
    if (!first && typeof parsed.message === "string") message = parsed.message.slice(0, 300);
  } catch {
    // Keep the plain words.
  }
  return { kind: "refused", status: response.status, code, message };
}

/** Square's codes for an authorization that no longer works. The company must reconnect. */
export function authLost(answer: Answer<unknown>): boolean {
  return answer.kind === "refused" && (answer.status === 401 || ["ACCESS_TOKEN_EXPIRED", "ACCESS_TOKEN_REVOKED", "UNAUTHORIZED", "INSUFFICIENT_SCOPES"].includes(answer.code ?? ""));
}

// ── OAuth ────────────────────────────────────────────────────────────────────────────────────────

export type RawToken = { access_token?: string; token_type?: string; expires_at?: string; merchant_id?: string; refresh_token?: string };

export type Tokens = { accessToken: string; refreshToken: string; merchantId: string; accessExpiresAt: number };

export function tokensFrom(raw: RawToken, keepRefresh?: string): Tokens | null {
  const expires = raw.expires_at ? Date.parse(raw.expires_at) : NaN;
  const refreshToken = raw.refresh_token ?? keepRefresh;
  if (!raw.access_token || !refreshToken || !raw.merchant_id || !Number.isFinite(expires)) return null;
  return { accessToken: raw.access_token, refreshToken, merchantId: raw.merchant_id.slice(0, 191), accessExpiresAt: expires };
}

/** Trades the one-time code (valid five minutes) for the company's tokens. */
export function obtainToken(config: SquareConfig, code: string) {
  return call<RawToken>(config, "POST", "/oauth2/token", null, { client_id: config.applicationId, client_secret: config.secret, code, grant_type: "authorization_code" });
}

/** A new access token from the company's refresh token (which, in the code flow, does not change). */
export function refreshToken(config: SquareConfig, refresh: string) {
  return call<RawToken>(config, "POST", "/oauth2/token", null, { client_id: config.applicationId, client_secret: config.secret, refresh_token: refresh, grant_type: "refresh_token" });
}

/** Ends Selestial's access to one merchant's account. */
export function revokeToken(config: SquareConfig, merchantId: string) {
  return call<{ success?: boolean }>(config, "POST", "/oauth2/revoke", { client: config.secret ?? "" }, { client_id: config.applicationId, merchant_id: merchantId });
}

// ── Merchant and locations ───────────────────────────────────────────────────────────────────────

export type RawMerchant = { id?: string; business_name?: string; country?: string; currency?: string; status?: string; main_location_id?: string };
export type RawLocation = { id?: string; name?: string; business_name?: string; status?: string; currency?: string; country?: string; capabilities?: string[]; merchant_id?: string };

export function retrieveMerchant(config: SquareConfig, token: string) {
  return call<{ merchant?: RawMerchant }>(config, "GET", "/v2/merchants/me", { bearer: token });
}

export function listLocations(config: SquareConfig, token: string) {
  return call<{ locations?: RawLocation[] }>(config, "GET", "/v2/locations", { bearer: token });
}

export type LocationFacts = { id: string; name: string; currency: string | null; eligible: boolean; why: string | null };

/**
 * Whether online card payments can be taken at a location, as far as Square tells Selestial before a
 * payment: active, with card processing, in US dollars (Finance's only currency). Readable is not enough.
 */
export function locationFacts(raw: RawLocation): LocationFacts | null {
  if (typeof raw.id !== "string" || !raw.id) return null;
  const name = (raw.name || raw.business_name || "Location").slice(0, 120);
  const currency = typeof raw.currency === "string" ? raw.currency : null;
  const why =
    raw.status !== "ACTIVE"
      ? "This location is inactive in Square."
      : !(raw.capabilities ?? []).includes("CREDIT_CARD_PROCESSING")
        ? "Square hasn't enabled card processing for this location yet."
        : currency !== "USD"
          ? `This location takes payments in ${currency ?? "another currency"}. Selestial's invoices are in US dollars.`
          : null;
  return { id: raw.id.slice(0, 64), name, currency, eligible: why === null, why };
}

// ── Checkout (payment links) ─────────────────────────────────────────────────────────────────────

export type RawPaymentLink = { id?: string; version?: number; order_id?: string; url?: string; long_url?: string; description?: string };

/** The marker on every link Selestial makes, so an unclear creation can be found again without making another. */
export function linkMarker(paymentId: string): string {
  return `selestial-payment:${paymentId}`;
}

/**
 * A hosted checkout for exactly one payment attempt. The amount is the server's; Square adds no tax,
 * discount or tip; the tip the customer chose on Selestial's page is its own line. Card, Apple Pay and
 * Google Pay only. The idempotency key is the payment's own, on every try.
 */
export function createPaymentLink(
  config: SquareConfig,
  token: string,
  input: { paymentId: string; locationId: string; amountCents: number; tipCents: number; title: string; redirectUrl: string; buyerEmail?: string },
) {
  const lineItems = [{ name: input.title.slice(0, 500), quantity: "1", base_price_money: { amount: input.amountCents, currency: "USD" } }];
  if (input.tipCents > 0) lineItems.push({ name: "Tip for your cleaning crew", quantity: "1", base_price_money: { amount: input.tipCents, currency: "USD" } });
  return call<{ payment_link?: RawPaymentLink }>(config, "POST", "/v2/online-checkout/payment-links", { bearer: token }, {
    idempotency_key: `sel-${input.paymentId}`.slice(0, 192),
    description: linkMarker(input.paymentId),
    order: {
      location_id: input.locationId,
      reference_id: input.paymentId.slice(0, 40),
      line_items: lineItems,
      pricing_options: { auto_apply_taxes: false, auto_apply_discounts: false },
    },
    checkout_options: {
      redirect_url: input.redirectUrl,
      allow_tipping: false,
      ask_for_shipping_address: false,
      enable_coupon: false,
      enable_loyalty: false,
      accepted_payment_methods: { apple_pay: true, google_pay: true, cash_app_pay: false, afterpay_clearpay: false, bank_account: false },
    },
    ...(input.buyerEmail ? { pre_populated_data: { buyer_email: input.buyerEmail } } : {}),
  });
}

/** Closes a link and cancels its order, so it can no longer collect. */
export function deletePaymentLink(config: SquareConfig, token: string, linkId: string) {
  return call<{ id?: string; cancelled_order_id?: string }>(config, "DELETE", `/v2/online-checkout/payment-links/${encodeURIComponent(linkId)}`, { bearer: token });
}

export function listPaymentLinks(config: SquareConfig, token: string, cursor?: string) {
  return call<{ payment_links?: RawPaymentLink[]; cursor?: string }>(config, "GET", `/v2/online-checkout/payment-links?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { bearer: token });
}

// ── Orders, payments and refunds ─────────────────────────────────────────────────────────────────

export type RawOrder = { id?: string; location_id?: string; reference_id?: string; state?: string; tenders?: { id?: string; payment_id?: string; type?: string }[]; total_money?: { amount?: number; currency?: string } };

export type RawPayment = {
  id?: string;
  status?: string;
  order_id?: string;
  location_id?: string;
  amount_money?: { amount?: number; currency?: string };
  total_money?: { amount?: number; currency?: string };
  refunded_money?: { amount?: number; currency?: string };
  processing_fee?: { amount_money?: { amount?: number; currency?: string }; type?: string }[];
  receipt_url?: string;
  source_type?: string;
  card_details?: { card?: { card_brand?: string; last_4?: string }; status?: string; errors?: { code?: string; detail?: string }[] };
  wallet_details?: { brand?: string };
  refund_ids?: string[];
};

export type RawRefund = { id?: string; status?: string; payment_id?: string; location_id?: string; amount_money?: { amount?: number; currency?: string }; reason?: string };

export function retrieveOrder(config: SquareConfig, token: string, orderId: string) {
  return call<{ order?: RawOrder }>(config, "GET", `/v2/orders/${encodeURIComponent(orderId)}`, { bearer: token });
}

export function getPayment(config: SquareConfig, token: string, paymentId: string) {
  return call<{ payment?: RawPayment }>(config, "GET", `/v2/payments/${encodeURIComponent(paymentId)}`, { bearer: token });
}

/** A refund under the refund record's own key (Square allows 1 to 45 characters), on every try. */
export function refundPayment(config: SquareConfig, token: string, input: { refundId: string; squarePaymentId: string; amountCents: number; reason: string }) {
  return call<{ refund?: RawRefund }>(config, "POST", "/v2/refunds", { bearer: token }, {
    idempotency_key: input.refundId.slice(0, 45),
    payment_id: input.squarePaymentId,
    amount_money: { amount: input.amountCents, currency: "USD" },
    reason: input.reason.slice(0, 192),
  });
}

export function getRefund(config: SquareConfig, token: string, refundId: string) {
  return call<{ refund?: RawRefund }>(config, "GET", `/v2/refunds/${encodeURIComponent(refundId)}`, { bearer: token });
}

// ── Reading Square's answers into Finance's words ────────────────────────────────────────────────

export type PaymentOutcome = "awaiting_customer" | "processing" | "succeeded" | "failed" | "canceled";

export type SquarePaymentFacts = {
  status: PaymentOutcome;
  /** The Square payment that settled it (or is in flight), when there is one. */
  squarePaymentId: string | null;
  /** What Square received, invoice and tip together, when it completed. */
  receivedCents: number | null;
  /** Square's fee. Null when Square hasn't reported it yet: unknown, never zero. */
  feeCents: number | null;
  receiptUrl: string | null;
  methodLabel: string | null;
  problem: string | null;
  /** Payments on this order other than the one counted: a second buyer on the same link, which Square shouldn't allow. */
  extraPaymentIds: string[];
};

const BRAND: Record<string, string> = { VISA: "Visa", MASTERCARD: "Mastercard", AMERICAN_EXPRESS: "American Express", DISCOVER: "Discover", DISCOVER_DINERS: "Diners Club", JCB: "JCB", CHINA_UNIONPAY: "UnionPay", SQUARE_GIFT_CARD: "Square gift card", INTERAC: "Interac", EFTPOS: "EFTPOS", FELICA: "FeliCa" };

function methodOf(payment: RawPayment): string | null {
  if (payment.source_type === "WALLET") return payment.wallet_details?.brand ? `${payment.wallet_details.brand.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}` : "Digital wallet";
  const card = payment.card_details?.card;
  if (card?.last_4) return `${BRAND[card.card_brand ?? ""] ?? "Card"} ending ${card.last_4.slice(-4)}`;
  return payment.source_type === "CARD" ? "Card" : null;
}

function cents(money: { amount?: number; currency?: string } | undefined): number | null {
  return money && money.currency === "USD" && Number.isSafeInteger(money.amount) ? (money.amount as number) : null;
}

/** Square's fee, from the payment's fee list. Absent or not in dollars is unknown. */
export function feeOf(payment: RawPayment): number | null {
  if (!payment.processing_fee?.length) return null;
  let sum = 0;
  for (const fee of payment.processing_fee) {
    const amount = cents(fee.amount_money);
    if (amount === null) return null;
    sum += amount;
  }
  return sum;
}

/**
 * What an order and its payments say about one Selestial payment attempt. A completed Square payment is
 * received; approved or pending is in flight; a declined card leaves the link open for another try; a
 * canceled order with nothing completed was stopped. Money in another currency is never counted.
 */
export function orderOutcome(order: RawOrder | null, payments: RawPayment[]): SquarePaymentFacts {
  const usable = payments.filter((p) => typeof p.id === "string");
  const done = usable.filter((p) => p.status === "COMPLETED");
  const flying = usable.filter((p) => p.status === "APPROVED" || p.status === "PENDING");
  const failed = usable.filter((p) => p.status === "FAILED");
  const counted = done[0] ?? flying[0] ?? null;
  const base = { squarePaymentId: counted?.id ?? null, receivedCents: null as number | null, feeCents: null as number | null, receiptUrl: null as string | null, methodLabel: counted ? methodOf(counted) : null, problem: null as string | null, extraPaymentIds: [...done.slice(1), ...flying.slice(done.length ? 0 : 1)].map((p) => p.id!) };
  if (done[0]) {
    const received = cents(done[0].amount_money);
    if (received === null) return { ...base, status: "processing", problem: "Square reported this payment in a currency Selestial doesn't take. It needs checking in Square." };
    return { ...base, status: "succeeded", receivedCents: received, feeCents: feeOf(done[0]), receiptUrl: typeof done[0].receipt_url === "string" && done[0].receipt_url.startsWith("https://") ? done[0].receipt_url.slice(0, 500) : null };
  }
  if (flying[0]) return { ...base, status: "processing" };
  if (order?.state === "CANCELED") return { ...base, status: "canceled" };
  if (failed.length) return { ...base, status: "awaiting_customer", methodLabel: methodOf(failed[0]), problem: "Square declined the payment. The invoice is still unpaid, and the checkout link stays open for another try." };
  return { ...base, status: "awaiting_customer" };
}

/** The Square payment IDs on an order, from its tenders. */
export function tenderPaymentIds(order: RawOrder | null): string[] {
  return (order?.tenders ?? []).map((t) => t.payment_id ?? t.id).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 200);
}

export type SquareRefundFacts = { status: "pending" | "succeeded" | "failed" | "canceled"; problem: string | null };

export function refundFacts(raw: RawRefund): SquareRefundFacts {
  switch (raw.status) {
    case "COMPLETED":
      return { status: "succeeded", problem: null };
    case "REJECTED":
      return { status: "failed", problem: "Square rejected the refund: the Square account didn't have the funds to cover it." };
    case "FAILED":
      return { status: "failed", problem: "Square couldn't return the money to the customer's card." };
    default:
      return { status: "pending", problem: null };
  }
}

// ── Webhooks ─────────────────────────────────────────────────────────────────────────────────────

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Square's signature: base64 HMAC-SHA256 of the exact notification URL followed by the raw body, with the subscription's key. */
export async function squareSignature(key: string, notificationUrl: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(notificationUrl + body))));
}

/** Compared in constant time. No key, no URL or no header is never valid. */
export async function verifySquareSignature(input: { key: string | null; notificationUrl: string | null; body: string; header: string | null }): Promise<boolean> {
  if (!input.key || !input.notificationUrl || !input.header || input.header.length > 200) return false;
  const expected = await squareSignature(input.key, input.notificationUrl, input.body);
  if (expected.length !== input.header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ input.header.charCodeAt(i);
  return diff === 0;
}

export type SquareEvent = { eventId: string; type: string; merchantId: string; objectType: string | null; objectId: string | null };

/** The pointer an event carries: who, what kind, which object. Its object is never trusted; Selestial reads it back. */
export function parseSquareEvent(body: string): SquareEvent | null {
  let raw: { event_id?: unknown; type?: unknown; merchant_id?: unknown; data?: { type?: unknown; id?: unknown } };
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const text = (value: unknown, max: number) => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);
  const eventId = text(raw.event_id, 100);
  const type = text(raw.type, 80);
  const merchantId = text(raw.merchant_id, 191);
  if (!eventId || !type || !merchantId) return null;
  return { eventId, type, merchantId, objectType: text(raw.data?.type, 60), objectId: text(raw.data?.id, 200) };
}

export function signForTests(key: string, url: string, body: string): Promise<string> {
  return squareSignature(key, url, body);
}
