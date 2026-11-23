/**
 * Calling Google for a company, with errors sorted into what a caller can act on. An "uncertain" error
 * means the request may have happened: a consequential write that ends uncertain is reconciled (looked
 * up by its idempotency key) before anything is tried again, never simply repeated.
 */
import { isNonProduction } from "../environment";

export type Fetch = typeof fetch;

export type GoogleErrorKind = "auth" | "forbidden" | "not_found" | "conflict" | "rate_limited" | "invalid" | "server" | "uncertain" | "not_configured" | "not_production";

export class GoogleError extends Error {
  constructor(
    readonly kind: GoogleErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "server" || this.kind === "uncertain";
  }
}

const ALLOWED_HOSTS = new Set([
  "oauth2.googleapis.com",
  "www.googleapis.com",
  "openidconnect.googleapis.com",
  "gmail.googleapis.com",
  "calendar-json.googleapis.com",
  "docs.googleapis.com",
  "sheets.googleapis.com",
  "mybusinessaccountmanagement.googleapis.com",
  "mybusinessbusinessinformation.googleapis.com",
  "mybusiness.googleapis.com",
  "mybusinessnotifications.googleapis.com",
  "googleads.googleapis.com",
  "localservices.googleapis.com",
  "datamanager.googleapis.com",
  "routes.googleapis.com",
  "routeoptimization.googleapis.com",
  "generativelanguage.googleapis.com",
  "places.googleapis.com",
]);

/** The message of a Google error body, without anything that could be a token or a personal detail. */
function describe(body: unknown, status: number): string {
  const error = (body as { error?: { message?: unknown; status?: unknown } | string } | null)?.error;
  const text = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : `HTTP ${status}`;
  return text.replace(/ya29\.[\w.-]+|Bearer\s+\S+/g, "[redacted]").slice(0, 300);
}

export const NOT_RUN_ON_TEST = "Not run: this is not the production backend, so nothing is written to a Google account.";

/** Hosts whose POSTs are Selestial's own sign-in or its own computation: no customer's Google account changes. */
const READ_ONLY_HOSTS = new Set(["oauth2.googleapis.com", "routes.googleapis.com", "routeoptimization.googleapis.com", "generativelanguage.googleapis.com", "places.googleapis.com"]);
/** POSTs that only read: a Google Ads query, Google Ads location lookups, and busy times from Calendar. */
const READ_ONLY_PATHS = [/\/googleAds:search$/, /^\/v\d+\/geoTargetConstants:suggest$/, /\/calendar\/v3\/freeBusy$/];

/**
 * Whether a call writes to a Google account: a calendar event, a public review reply, an ad, a reported
 * conversion, a Drive or Sheets file, a notification channel. Everything that is not a GET is a write
 * unless it is listed above as a read, so a new call is refused on a test backend until someone decides.
 */
export function writesToGoogle(url: string, method: string): boolean {
  if (method.toUpperCase() === "GET") return false;
  const { host, pathname } = new URL(url);
  return !READ_ONLY_HOSTS.has(host) && !READ_ONLY_PATHS.some((path) => path.test(pathname));
}

export type CallInit = { method?: string; body?: unknown; rawBody?: BodyInit; headers?: Record<string, string>; timeoutMs?: number; fetcher?: Fetch };

/** One call with a bearer token or headers. JSON in, JSON out. A network failure on a write is "uncertain". */
export async function googleCall<T>(url: string, token: string | null, init: CallInit = {}): Promise<T> {
  const host = new URL(url).host;
  if (!ALLOWED_HOSTS.has(host)) throw new GoogleError("invalid", `Selestial does not call ${host}.`);
  const method = init.method ?? "GET";
  // A backend that is not production (the test backend, a restored copy) holds copies of real companies'
  // Google access. It may sign in and read; it never writes to their accounts (convex/lib/environment.ts).
  if (isNonProduction() && writesToGoogle(url, method)) throw new GoogleError("not_production", NOT_RUN_ON_TEST);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await (init.fetcher ?? fetch)(url, {
      method,
      signal: controller.signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      body: init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
  } catch {
    throw new GoogleError(method === "GET" ? "server" : "uncertain", method === "GET" ? "Google did not answer." : "Google did not answer, so it is not known whether this happened.");
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 204) return {} as T;
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = null;
  }
  if (response.ok) return (body ?? {}) as T;
  const message = describe(body, response.status);
  const retryAfter = Number(response.headers.get("retry-after"));
  if (response.status === 401) throw new GoogleError("auth", message, 401);
  if (response.status === 403) throw new GoogleError(/rate|quota/i.test(message) ? "rate_limited" : "forbidden", message, 403);
  if (response.status === 404) throw new GoogleError("not_found", message, 404);
  if (response.status === 409) throw new GoogleError("conflict", message, 409);
  if (response.status === 412) throw new GoogleError("conflict", message, 412);
  if (response.status === 429) throw new GoogleError("rate_limited", message, 429, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
  if (response.status >= 500) throw new GoogleError(method === "GET" ? "server" : "uncertain", message, response.status);
  throw new GoogleError("invalid", message, response.status);
}

/** What went wrong with Google, in words for the person using Selestial. Technical detail stays in the job record. */
export function plainProblem(error: unknown): string {
  const kind = error instanceof GoogleError ? error.kind : null;
  if (kind === "not_found") return "Selestial can’t find this in your Google account. It may have been moved or deleted.";
  if (kind === "forbidden") return "Your Google account doesn’t let Selestial use this.";
  if (kind === "auth") return "Google access ended. Reconnect to continue.";
  if (kind === "not_production") return "Not done: this is a test copy of Selestial, which never changes a Google account.";
  if (kind === "not_configured") return "This isn’t available yet.";
  if (kind === "rate_limited" || kind === "server" || kind === "uncertain") return "Google didn’t answer just now. Selestial will try again.";
  return "Something went wrong with Google. Please try again.";
}
