/**
 * Which backend this is, and what a backend that is not production may do (docs/foundation/06-deployments.md).
 *
 * Production is decided by the deployment's own name, which Convex sets in CONVEX_CLOUD_URL, against
 * the list below. Every other deployment (the test backend, a restored copy, a developer's own) is not
 * production, without anyone having to remember a setting: it is safe by default.
 *
 * A backend that is not production:
 *  - sends email and texts only to the addresses in TEST_RECIPIENTS (comma-separated), never to a real
 *    customer, cleaner, applicant or owner;
 *  - refuses Telnyx calls that buy or change anything (numbers, brands, campaigns);
 *  - never writes to a company's Google account (calendar events, review replies, ads, conversion uploads,
 *    Drive and Sheets files, notification channels): refused at the one call wrapper, convex/lib/google/http.ts.
 *    Signing in, refreshing a token and reads still work; a Google job that would write is settled once as not run;
 *  - ignores live Stripe and Autumn keys, so nothing it does can charge a real card.
 *
 * Code run with no deployment at all (the test harness) has no name and is left as it is.
 */

/** The live backend. Keep scripts/build.mjs's copy the same (convex/environment.test.ts checks). */
export const PRODUCTION_DEPLOYMENTS: readonly string[] = ["stoic-gazelle-731"];

export type Environment = "production" | "non_production" | "unknown";

/**
 * Custom domains and the deployment each belongs to. Convex binds a custom domain to exactly one deployment,
 * and when one is set as the deployment's client address, CONVEX_CLOUD_URL carries the domain instead of
 * <name>.convex.cloud. Without this, the live backend would stop recognising itself as production.
 */
export const DEPLOYMENT_DOMAINS: Readonly<Record<string, string>> = { "api.selestial.io": "stoic-gazelle-731" };

/** The deployment's name, from https://<name>.convex.cloud or a known custom domain, or null outside a deployment. */
export function deploymentName(env: Record<string, string | undefined> = process.env): string | null {
  const url = env.CONVEX_CLOUD_URL?.trim();
  if (!url) return null;
  const match = /^https?:\/\/([a-z0-9-]+)\.convex\.cloud\/?$/i.exec(url);
  if (match) return match[1].toLowerCase();
  const domain = /^https:\/\/([a-z0-9.-]+)\/?$/i.exec(url)?.[1].toLowerCase();
  return (domain && DEPLOYMENT_DOMAINS[domain]) || url;
}

/**
 * The address people see for this backend's HTTP routes: integration webhooks today, the public API and MCP
 * later. On the live backend it is its custom domain (api.selestial.io, served by HTTP actions). OAuth returns
 * and provider webhooks stay registered on the deployment's own CONVEX_SITE_URL, which keeps working.
 * PUBLIC_API_ORIGIN overrides it; elsewhere it is the deployment's own site address.
 */
export function publicApiOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const set = env.PUBLIC_API_ORIGIN?.trim().replace(/\/+$/, "");
  if (set && /^https:\/\/[a-z0-9.-]+$/i.test(set)) return set;
  const name = deploymentName(env);
  const domain = Object.entries(DEPLOYMENT_DOMAINS).find(([, owner]) => owner === name)?.[0];
  if (domain && PRODUCTION_DEPLOYMENTS.includes(name!)) return `https://${domain}`;
  const site = env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
  return site && /^https?:\/\//.test(site) ? site : null;
}

export function environment(env: Record<string, string | undefined> = process.env): Environment {
  const name = deploymentName(env);
  if (name === null) return "unknown";
  return PRODUCTION_DEPLOYMENTS.includes(name) ? "production" : "non_production";
}

/** True only on a deployment known not to be production. */
export function isNonProduction(): boolean {
  return environment() === "non_production";
}

/**
 * Where a backend that used to be live passes on requests for its old addresses: MOVED_TO, the live
 * backend's site address (https://<name>.convex.site). Emails, texts and providers sent before the move
 * still carry the old address (an Unsubscribe button, a crew photo, a webhook), so those requests are
 * forwarded unchanged and answered by the live backend. Only a non-production backend forwards, and only
 * to a Convex site address.
 */
export function movedTo(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.MOVED_TO?.trim().replace(/\/+$/, "");
  if (!value || environment(env) !== "non_production") return null;
  const match = /^https:\/\/([a-z0-9-]+)\.convex\.site$/i.exec(value);
  if (!match || match[1].toLowerCase() === deploymentName(env)) return null;
  return value;
}

const phoneDigits = (value: string) => value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/** Whether a non-production backend may send to this address. */
export function testRecipientAllowed(to: string): boolean {
  const allowed = (process.env.TEST_RECIPIENTS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const address = to.trim().toLowerCase();
  if (address.includes("@")) return allowed.includes(address);
  const digits = phoneDigits(address);
  return digits.length >= 10 && allowed.some((item) => !item.includes("@") && phoneDigits(item) === digits);
}

export const NOT_SENT_ON_TEST = "Not sent: this is not the production backend, and the address is not on its TEST_RECIPIENTS list.";

/** Null when this send may go; otherwise why it may not. */
export function sendBlocked(to: string): string | null {
  if (!isNonProduction()) return null;
  return testRecipientAllowed(to) ? null : NOT_SENT_ON_TEST;
}
