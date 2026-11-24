/**
 * QuickBooks Online authorization (Intuit OAuth 2.0): configuration, Intuit's discovery document, the
 * sign-in address, and the token calls (code exchange, refresh, revoke).
 *
 * Endpoints are read from Intuit's discovery document, never written here, so a change Intuit publishes
 * is picked up without a release. The document is cached for a day; if it cannot be read, the last good
 * copy is used, and only on a cold start with no copy are Intuit's documented defaults used.
 *
 * Tokens: an access token lasts about an hour and is reused until shortly before it expires. A refresh
 * token lasts about 100 days and Intuit may return a new one on any refresh; the newest is always kept.
 * Refresh tokens are sealed (../recruiter/secrets.ts) before they are stored and never reach a browser.
 *
 * Needs QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET from the app in Intuit's developer portal, and
 * QUICKBOOKS_ENVIRONMENT ("sandbox" or "production", sandbox when unset). See docs/integrations/quickbooks.md.
 */

export type QuickBooksEnvironment = "sandbox" | "production";
export type QuickBooksApp = { clientId: string; clientSecret: string; environment: QuickBooksEnvironment };
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** The one permission Selestial asks for: read and write the company's accounting records. */
export const QUICKBOOKS_SCOPES = ["com.intuit.quickbooks.accounting"] as const;
export const QUICKBOOKS_CALLBACK_PATH = "/oauth/quickbooks/callback";

export function quickbooksApp(env: Record<string, string | undefined> = process.env): QuickBooksApp | null {
  const clientId = env.QUICKBOOKS_CLIENT_ID?.trim();
  const clientSecret = env.QUICKBOOKS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, environment: env.QUICKBOOKS_ENVIRONMENT?.trim().toLowerCase() === "production" ? "production" : "sandbox" };
}

/**
 * Where Intuit sends the Owner back. QUICKBOOKS_REDIRECT_URI puts it on Selestial's own domain
 * (https://app.selestial.io/oauth/quickbooks/callback, passed straight through to this backend by
 * next.config.ts); otherwise it is the backend's own site address. It must match a redirect URI on the
 * Intuit app exactly.
 */
export function quickbooksRedirect(env: Record<string, string | undefined> = process.env): string | null {
  const set = env.QUICKBOOKS_REDIRECT_URI?.trim();
  if (set && /^https:\/\/[a-z0-9.-]+\/oauth\/quickbooks\/callback$/i.test(set)) return set;
  const site = env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
  return site ? `${site}${QUICKBOOKS_CALLBACK_PATH}` : null;
}

/** The accounting API's address for each environment. */
export function apiBase(environment: QuickBooksEnvironment): string {
  return environment === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
}

// ── Discovery ───────────────────────────────────────────────────────────────────────────────────

export type Endpoints = { authorization: string; token: string; revocation: string };

const DISCOVERY: Record<QuickBooksEnvironment, string> = {
  production: "https://developer.api.intuit.com/.well-known/openid_configuration",
  sandbox: "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration",
};
/** Intuit's documented endpoints, used only when the discovery document has never been read. */
export const DEFAULT_ENDPOINTS: Endpoints = {
  authorization: "https://appcenter.intuit.com/connect/oauth2",
  token: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revocation: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
};
export const DISCOVERY_LIFE = 24 * 60 * 60 * 1000;
const discovered = new Map<QuickBooksEnvironment, { endpoints: Endpoints; at: number }>();

/** Tests only. */
export function forgetDiscoveryForTests() {
  discovered.clear();
}

const intuitHost = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "intuit.com" || url.hostname.endsWith(".intuit.com"));
  } catch {
    return false;
  }
};

/** The OAuth endpoints from Intuit's discovery document, cached for a day. Only intuit.com addresses are accepted. */
export async function endpoints(environment: QuickBooksEnvironment, fetcher: Fetcher, now = Date.now()): Promise<Endpoints> {
  const cached = discovered.get(environment);
  if (cached && now - cached.at < DISCOVERY_LIFE) return cached.endpoints;
  try {
    const response = await fetcher(DISCOVERY[environment], { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const json = (await response.json()) as Record<string, unknown>;
      if (intuitHost(json.authorization_endpoint) && intuitHost(json.token_endpoint) && intuitHost(json.revocation_endpoint)) {
        const found = { authorization: json.authorization_endpoint, token: json.token_endpoint, revocation: json.revocation_endpoint };
        discovered.set(environment, { endpoints: found, at: now });
        return found;
      }
    }
  } catch {
    // Fall through to the last good copy.
  }
  return cached?.endpoints ?? DEFAULT_ENDPOINTS;
}

export function authorizeUrl(app: QuickBooksApp, found: Endpoints, redirect: string, state: string): string {
  const params = new URLSearchParams({ client_id: app.clientId, response_type: "code", scope: QUICKBOOKS_SCOPES.join(" "), redirect_uri: redirect, state });
  return `${found.authorization}?${params.toString()}`;
}

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────

/**
 * What went wrong, by what Selestial should do about it:
 * - access_expired: the access token was refused (401). Refresh once and try again.
 * - grant_ended: the refresh token is expired, revoked or invalid (invalid_grant). Only reconnecting helps.
 * - transient: network trouble, rate limiting or Intuit's servers. Try again after a wait.
 * - rejected: the request itself was refused. Trying again would not help.
 */
export type QuickBooksErrorKind = "access_expired" | "grant_ended" | "transient" | "rejected";

export class QuickBooksError extends Error {
  constructor(
    readonly kind: QuickBooksErrorKind,
    message: string,
    readonly status?: number,
    /** Intuit's id for the request (intuit_tid), for Intuit support. */
    readonly intuitTid?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "QuickBooksError";
  }
}

export function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 60_000) : undefined;
}

// ── Token calls ─────────────────────────────────────────────────────────────────────────────────

export type Tokens = { accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number };

const basic = (app: QuickBooksApp) => `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`;

async function tokenCall(app: QuickBooksApp, found: Endpoints, form: Record<string, string>, fetcher: Fetcher, now: number): Promise<Tokens> {
  let response: Response;
  try {
    response = await fetcher(found.token, {
      method: "POST",
      headers: { Authorization: basic(app), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new QuickBooksError("transient", "QuickBooks couldn't be reached.");
  }
  const tid = response.headers.get("intuit_tid") ?? undefined;
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) throw new QuickBooksError("transient", "QuickBooks is busy. Try again shortly.", response.status, tid, retryAfter(response));
    // invalid_grant: the code or refresh token is expired, already used or revoked. Only signing in again helps.
    if (json.error === "invalid_grant") throw new QuickBooksError("grant_ended", "QuickBooks ended this authorization. Reconnect QuickBooks to continue.", response.status, tid);
    throw new QuickBooksError("rejected", "QuickBooks refused the request.", response.status, tid);
  }
  if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string") throw new QuickBooksError("rejected", "QuickBooks answered without the expected tokens.", response.status, tid);
  const seconds = (value: unknown, fallback: number) => (typeof value === "number" && value > 0 ? value : fallback);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    accessExpiresAt: now + seconds(json.expires_in, 3600) * 1000,
    refreshExpiresAt: now + seconds(json.x_refresh_token_expires_in, 100 * 24 * 3600) * 1000,
  };
}

export async function exchange(app: QuickBooksApp, code: string, redirect: string, fetcher: Fetcher, now = Date.now()): Promise<Tokens> {
  return tokenCall(app, await endpoints(app.environment, fetcher, now), { grant_type: "authorization_code", code, redirect_uri: redirect }, fetcher, now);
}

export async function refresh(app: QuickBooksApp, refreshToken: string, fetcher: Fetcher, now = Date.now()): Promise<Tokens> {
  return tokenCall(app, await endpoints(app.environment, fetcher, now), { grant_type: "refresh_token", refresh_token: refreshToken }, fetcher, now);
}

/** Revokes the authorization at Intuit, which disconnects the app on QuickBooks' side too. Never throws. */
export async function revoke(app: QuickBooksApp, token: string, fetcher: Fetcher): Promise<boolean> {
  try {
    const found = await endpoints(app.environment, fetcher);
    const response = await fetcher(found.revocation, {
      method: "POST",
      headers: { Authorization: basic(app), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(20_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
