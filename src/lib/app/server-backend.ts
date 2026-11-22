/**
 * The backend address a server action may call. Server actions read their settings when they RUN, so the
 * build-time guard in scripts/build.mjs (which leaves the live backend's address out of a preview build)
 * does not cover them: on Vercel a preview's server still receives the shared NEXT_PUBLIC_CONVEX_URL.
 *
 * So the same rule is applied again here, at run time: a deployment that is not Vercel production
 * (a preview, or `vercel dev`) never calls the live backend. Which backend is live is the one list in
 * convex/lib/environment.ts, which scripts/build.mjs must match (convex/environment.test.ts checks).
 */
import { DEPLOYMENT_DOMAINS, PRODUCTION_DEPLOYMENTS } from "../../../convex/lib/environment";

/** The deployment an address belongs to when it is the live one, by its own name or its custom domain. */
export function isLiveBackend(url: string): boolean {
  const host = /^https?:\/\/([a-z0-9.-]+?)(?::\d+)?(?:\/.*)?$/i.exec(url.trim())?.[1].toLowerCase();
  if (!host) return false;
  const named = /^([a-z0-9-]+)\.convex\.(?:cloud|site)$/.exec(host)?.[1];
  const name = named ?? DEPLOYMENT_DOMAINS[host];
  return name !== undefined && PRODUCTION_DEPLOYMENTS.includes(name);
}

/**
 * The address to call, or null when there is none or this server must not use it. The defaults are written
 * out as `process.env.NAME` on purpose, so the production build keeps the address it was built with.
 */
export function serverBackendUrl(url: string | undefined = process.env.NEXT_PUBLIC_CONVEX_URL, vercelEnv: string | undefined = process.env.VERCEL_ENV): string | null {
  const address = url?.trim();
  if (!address || !/^https:\/\//.test(address)) return null;
  const where = vercelEnv?.trim();
  if (where && where !== "production" && isLiveBackend(address)) return null;
  return address;
}
