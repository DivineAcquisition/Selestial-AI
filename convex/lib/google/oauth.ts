/**
 * The company's Google authorization: the consent URL, the code exchange, refreshing, and revoking.
 * Requests ask only for the features being turned on; Google adds them to what the account already
 * granted (include_granted_scopes). The refresh token is sealed (../recruiter/secrets.ts) before it is
 * stored and is never sent to a browser.
 */
import { GoogleError, googleCall, type Fetch } from "./http";

const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";

export type GoogleApp = { clientId: string; clientSecret: string };

export function googleApp(): GoogleApp | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";

/**
 * The one redirect address Google returns to, shared with the Gmail inbox connection.
 *
 * Google verifies an app only when every redirect address is on a domain the app's owner has proven they
 * own, and *.convex.site cannot be. GOOGLE_OAUTH_REDIRECT_URI moves it onto Selestial's own domain
 * (https://app.selestial.io/oauth/google/callback), which the site passes straight through to this backend
 * (next.config.ts). It must be the exact address registered on the OAuth client, so it is only used when it
 * is an https address ending in the callback path; otherwise the deployment's own site address is used.
 */
export function redirectUri(env: Record<string, string | undefined> = process.env): string | null {
  const set = env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (set && /^https:\/\/[a-z0-9.-]+\/oauth\/google\/callback$/i.test(set)) return set;
  const site = env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
  return site ? `${site}${GOOGLE_CALLBACK_PATH}` : null;
}

export function consentUrl(app: GoogleApp, input: { redirectUri: string; state: string; scopes: string[]; loginHint?: string; selectAccount?: boolean }): string {
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: input.scopes.join(" "),
    access_type: "offline",
    // Each tool is its own connection, so a grant carries only that tool's scopes.
    include_granted_scopes: "false",
    // "consent" makes Google return a refresh token every time; "select_account" lets the Owner pick a different Google account.
    prompt: input.selectAccount ? "consent select_account" : "consent",
    state: input.state,
    ...(input.loginHint ? { login_hint: input.loginHint } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export type Tokens = { accessToken: string; refreshToken: string | null; scopes: string[]; expiresIn: number; idToken: string | null };

export async function exchange(app: GoogleApp, code: string, redirect: string, fetcher?: Fetch): Promise<Tokens> {
  const body = await googleCall<{ access_token?: string; refresh_token?: string; scope?: string; expires_in?: number; id_token?: string }>(TOKEN, null, {
    method: "POST",
    rawBody: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirect, grant_type: "authorization_code" }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    fetcher,
  });
  if (!body.access_token) throw new GoogleError("invalid", "Google did not return an access token.");
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null, scopes: (body.scope ?? "").split(" ").filter(Boolean), expiresIn: body.expires_in ?? 3600, idToken: body.id_token ?? null };
}

/** A fresh access token. An authorization the account has ended (revoked, password reset, expired) is "auth". */
export async function refresh(app: GoogleApp, refreshToken: string, fetcher?: Fetch): Promise<{ accessToken: string; scopes: string[] }> {
  try {
    const body = await googleCall<{ access_token?: string; scope?: string }>(TOKEN, null, {
      method: "POST",
      rawBody: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      fetcher,
    });
    if (!body.access_token) throw new GoogleError("invalid", "Google did not return an access token.");
    return { accessToken: body.access_token, scopes: (body.scope ?? "").split(" ").filter(Boolean) };
  } catch (error) {
    // Google answers invalid_grant with 400 when a refresh token no longer works.
    if (error instanceof GoogleError && (error.kind === "invalid" || error.kind === "auth") && /invalid_grant|expired|revoked|Token has been/i.test(error.message)) throw new GoogleError("auth", "Google ended this authorization. The Owner needs to reconnect.");
    throw error;
  }
}

/** Tells Google to end the grant. Disconnecting does not depend on it succeeding: Selestial stops at once either way. */
export async function revoke(token: string, fetcher?: Fetch): Promise<boolean> {
  try {
    await googleCall(REVOKE, null, { method: "POST", rawBody: new URLSearchParams({ token }).toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" }, fetcher });
    return true;
  } catch {
    return false;
  }
}

/** The account the grant belongs to, from the id token Google returned with the code (not verified here: it came straight from Google's token endpoint over TLS). */
export function identityFrom(idToken: string | null): { sub: string; email: string | null } | null {
  if (!idToken) return null;
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))) as { sub?: string; email?: string };
    return json.sub ? { sub: json.sub, email: json.email?.toLowerCase() ?? null } : null;
  } catch {
    return null;
  }
}
