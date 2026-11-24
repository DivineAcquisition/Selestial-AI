/**
 * Calls to the QuickBooks Online accounting API for one company (its realm). Each call is classified the
 * same way as the token calls (./oauth.ts): a 401 means the access token was refused, 429 and 5xx and
 * network trouble are transient, anything else is a rejection. Intuit's request id (intuit_tid) is kept on
 * every error so a failure can be traced with Intuit support.
 */
import { apiBase, QuickBooksError, retryAfter, type Fetcher, type QuickBooksEnvironment } from "./oauth";

/** The API minor version Selestial is written against. */
export const MINOR_VERSION = "75";

export async function qboGet<T>(input: { environment: QuickBooksEnvironment; realmId: string; path: string; accessToken: string; fetcher: Fetcher }): Promise<T> {
  if (!/^\d{1,32}$/.test(input.realmId)) throw new QuickBooksError("rejected", "That QuickBooks company id isn't valid.");
  const url = new URL(`${apiBase(input.environment)}/v3/company/${input.realmId}/${input.path.replace(/^\/+/, "")}`);
  url.searchParams.set("minorversion", MINOR_VERSION);
  let response: Response;
  try {
    response = await input.fetcher(url.toString(), { headers: { Authorization: `Bearer ${input.accessToken}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new QuickBooksError("transient", "QuickBooks couldn't be reached.");
  }
  const tid = response.headers.get("intuit_tid") ?? undefined;
  if (response.status === 401) throw new QuickBooksError("access_expired", "QuickBooks refused the access token.", 401, tid);
  if (response.status === 429 || response.status >= 500) throw new QuickBooksError("transient", "QuickBooks is busy. Try again shortly.", response.status, tid, retryAfter(response));
  if (!response.ok) throw new QuickBooksError("rejected", `QuickBooks refused the request: ${await faultWords(response)}`, response.status, tid);
  return (await response.json()) as T;
}

/**
 * Intuit's own words for a refused request (a syntax or validation error, for example), from its Fault
 * body: each error's code, message and detail. Never includes tokens; capped in length.
 */
export async function faultWords(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { Fault?: { type?: unknown; Error?: { code?: unknown; Message?: unknown; Detail?: unknown; element?: unknown }[] } } | null;
  const errors = Array.isArray(body?.Fault?.Error) ? body!.Fault!.Error! : [];
  const words = errors
    .map((error) => [typeof error.code === "string" ? `[${error.code}]` : null, typeof error.Message === "string" ? error.Message : null, typeof error.Detail === "string" ? error.Detail : null, typeof error.element === "string" && error.element ? `(field: ${error.element})` : null].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("; ");
  const type = typeof body?.Fault?.type === "string" ? body.Fault.type : null;
  return (words || type || `HTTP ${response.status}`).slice(0, 500);
}

export type Wait = (ms: number) => Promise<void>;
export const realWait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a call again after transient failures: up to `attempts` tries, waiting 0.5s, 1s, 2s … (or longer
 * when Intuit says how long with Retry-After). Anything that is not transient is thrown at once.
 */
export async function withRetry<T>(call: () => Promise<T>, wait: Wait = realWait, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof QuickBooksError) || error.kind !== "transient" || attempt >= attempts) throw error;
      await wait(Math.max(500 * 2 ** (attempt - 1), error.retryAfterMs ?? 0));
    }
  }
}

/** The company's name, from its CompanyInfo record. Used to confirm a connection works. */
export async function companyName(input: { environment: QuickBooksEnvironment; realmId: string; accessToken: string; fetcher: Fetcher }): Promise<string | null> {
  const body = await qboGet<{ CompanyInfo?: { CompanyName?: unknown; LegalName?: unknown } }>({ ...input, path: `companyinfo/${input.realmId}` });
  const name = body.CompanyInfo?.CompanyName ?? body.CompanyInfo?.LegalName;
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : null;
}
