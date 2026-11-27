/**
 * Which host shows what. One Vercel project answers on several hosts, so the app decides what each
 * host serves: the public site, the signed-in workspace, the link pages sent in texts, the Selestial
 * staff console, and hosts that are attached but not built yet.
 *
 * Host names come from settings, never from strings in this file. A host that no setting names
 * (localhost, a preview deployment, an old domain) is left alone and can reach every route. With no
 * settings at all, nothing here changes any response.
 *
 * This is routing, not access control. Sign-in and every read and write are checked elsewhere.
 * These are pure functions: no request, no Next.js. src/proxy.ts applies them.
 */
import { isAuthPath } from "./auth/routes";

export const HOST_ROLES = ["public", "app", "link", "admin", "founding", "docs", "status"] as const;
export type HostRole = (typeof HOST_ROLES)[number];

/** The setting that names each host. Each holds an origin, such as https://app.selestial.io. */
export const HOST_SETTINGS: Record<HostRole, string> = {
  public: "NEXT_PUBLIC_SITE_ORIGIN",
  app: "APP_ORIGIN",
  link: "LINK_ORIGIN",
  admin: "ADMIN_ORIGIN",
  /** The Selestial Founding Access page, for example https://access.selestial.io. Its root shows /founding and it serves nothing else. */
  founding: "FOUNDING_ORIGIN",
  docs: "DOCS_ORIGIN",
  status: "STATUS_ORIGIN",
};

/** Hosts that are attached to the project but have nothing built behind them yet. */
export const UNBUILT_ROLES: readonly HostRole[] = ["docs", "status"];

/** What a person sees on a host that is not built. */
const UNBUILT_MESSAGE: Record<string, string> = {
  docs: "Not available yet.",
  status: "Not available yet.",
};

/** The page the founding host shows at its root (the address bar keeps "/"). */
export const FOUNDING_PATH = "/founding";

/** Where the staff host opens: the Operations workspace. */
export const ADMIN_LANDING = "/staff/operations";

/** The origin configured for each role. A role with no valid setting is absent. */
export type HostMap = Partial<Record<HostRole, string>>;

type Env = Record<string, string | undefined>;

/** "https://App.Selestial.io/" becomes "https://app.selestial.io". Anything that is not a plain origin is rejected. */
export function parseOrigin(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
  return url.origin;
}

/** The host name of an origin or a Host header, lower case, without a port. */
export function hostName(value: string): string {
  const text = value.trim().toLowerCase();
  const withoutScheme = text.replace(/^[a-z]+:\/\//, "");
  return withoutScheme.split("/")[0].replace(/:\d+$/, "");
}

const withoutWww = (host: string) => host.replace(/^www\./, "");

/**
 * Reads the settings. A setting that is missing or malformed leaves its role out. If two roles name
 * the same host, the first in HOST_ROLES keeps it, so one host never has two meanings.
 */
export function hostMap(env: Env): HostMap {
  const map: HostMap = {};
  const taken = new Set<string>();
  for (const role of HOST_ROLES) {
    const origin = parseOrigin(env[HOST_SETTINGS[role]]);
    if (!origin) continue;
    const host = withoutWww(hostName(origin));
    if (taken.has(host)) continue;
    taken.add(host);
    map[role] = origin;
  }
  return map;
}

/**
 * The role of a host, or null for a host no setting names. The public site answers on its name with
 * and without "www", because the bare domain redirects to it.
 */
export function roleOfHost(host: string, map: HostMap): HostRole | null {
  const name = hostName(host);
  for (const role of HOST_ROLES) {
    const origin = map[role];
    if (!origin) continue;
    const configured = hostName(origin);
    if (name === configured) return role;
    if (role === "public" && withoutWww(name) === withoutWww(configured)) return role;
  }
  return null;
}

/** Which host a path belongs to. "shared" paths are served on every host. */
export type PathRole = "public" | "app" | "link" | "admin" | "founding" | "shared";

const under = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

export function roleOfPath(pathname: string): PathRole {
  const path = pathname === "" ? "/" : pathname;
  // Crawler rules, icons, domain checks and Clerk's own proxy path are needed wherever the app answers.
  if (path === "/robots.txt" || path === "/icon.svg" || path === "/favicon.ico") return "shared";
  if (under(path, "/.well-known") || under(path, "/__clerk")) return "shared";
  // Google's and QuickBooks' return after an Owner allows access, passed straight through to the backend (next.config.ts).
  if (path === "/oauth/google/callback" || path === "/oauth/quickbooks/callback") return "shared";
  // Founding Access: the page and its live status. The claim itself continues on the workspace host.
  if (under(path, FOUNDING_PATH) || under(path, "/api/founding")) return "founding";
  // The Selestial staff console. Sign-in stays on the workspace host, which staff share with everyone.
  if (under(path, "/staff")) return "admin";
  if (under(path, "/app") || isAuthPath(path)) return "app";
  // Link pages need no sign-in: cleaner links (/c), booking (/b) and notice unsubscribe pages (/n).
  if (under(path, "/c") || under(path, "/b") || under(path, "/n")) return "link";
  return "public";
}

export type Decision =
  | { kind: "next"; noindex: boolean }
  /** Serve another path's page at this address (the founding host's root shows /founding). */
  | { kind: "rewrite"; to: string; noindex: boolean }
  | { kind: "redirect"; to: string }
  | { kind: "not_found"; message: string };

export type HostRequest = { host: string; pathname: string; search?: string; method?: string };

/**
 * What to do with a request. A page is served on one host only: on any other configured host it
 * redirects to the right one, or is not found.
 */
export function decide(request: HostRequest, map: HostMap): Decision {
  const role = roleOfHost(request.host, map);
  // A host no setting names: local development, previews. Everything stays reachable.
  if (role === null) return { kind: "next", noindex: false };

  const path = roleOfPath(request.pathname);
  // The founding page is a public marketing page: indexable on its own host.
  const noindex = role !== "public" && role !== "founding";
  if (path === "shared") return { kind: "next", noindex };

  if (UNBUILT_ROLES.includes(role)) return { kind: "not_found", message: UNBUILT_MESSAGE[role] };

  const safe = request.method === undefined || request.method === "GET" || request.method === "HEAD";
  const send = (to: HostRole, pathname: string): Decision => {
    const origin = map[to];
    // The right host is not set up yet, so there is nowhere to send the person: serve it here.
    if (!origin) return { kind: "next", noindex };
    // Only a plain page load is redirected. A form post to the wrong host is refused, not replayed.
    if (!safe) return { kind: "not_found", message: "Not found." };
    // No other host leads to the founding host. Its page is reached only at its own address.
    if (to === "founding") return { kind: "not_found", message: "Not found." };
    return { kind: "redirect", to: `${origin}${pathname}${request.search ?? ""}` };
  };

  if (role === "founding") {
    // The root shows the founding page; its own path redirects to the root so there is one address.
    if (request.pathname === "/" || request.pathname === "") return { kind: "rewrite", to: FOUNDING_PATH, noindex };
    if (request.pathname === FOUNDING_PATH) return safe ? { kind: "redirect", to: `${map.founding}/${request.search ?? ""}` } : { kind: "next", noindex };
    if (path === "founding") return { kind: "next", noindex };
    // The founding host serves the founding page and nothing else, and never forwards elsewhere. The
    // page's own links to sign-up and legal pages point at their hosts directly (hrefFor).
    return { kind: "not_found", message: "Not found." };
  }

  if (role === "public") {
    if (path === "public") return { kind: "next", noindex };
    return send(path, request.pathname);
  }

  if (role === "app") {
    if (path === "app") return { kind: "next", noindex };
    // The workspace host has no front page of its own: its root opens the workspace.
    if (request.pathname === "/" || request.pathname === "") return safe ? { kind: "redirect", to: `${map.app}/app` } : { kind: "not_found", message: "Not found." };
    return send(path, request.pathname);
  }

  if (role === "admin") {
    if (path === "admin") return { kind: "next", noindex };
    // The staff host's root opens Operations.
    if (request.pathname === "/" || request.pathname === "") return safe ? { kind: "redirect", to: `${map.admin}${ADMIN_LANDING}` } : { kind: "not_found", message: "Not found." };
    // Sign-in, a company workspace opened in a support session (/app?support=...), and public pages
    // each go to their own host, keeping the path and query.
    return send(path, request.pathname);
  }

  // The link host serves link pages and nothing else: no marketing, no workspace.
  if (path === "link") return { kind: "next", noindex };
  if ((request.pathname === "/" || request.pathname === "") && map.public && safe) return { kind: "redirect", to: `${map.public}/` };
  return { kind: "not_found", message: "Not found." };
}

/**
 * Whether search engines may index a host. Only the public site is indexed. Before the public
 * site's host is set, this answers yes for every host, which is how the site behaved before.
 */
export function indexable(host: string, map: HostMap): boolean {
  if (!map.public) return true;
  const role = roleOfHost(host, map);
  return role === "public" || role === "founding";
}

/**
 * A link from the founding page to a page it does not serve itself ("/signup?next=...", "/terms"), at
 * the host that does serve it. Fragments, founding paths and hosts that are not set stay as written.
 */
export function hrefFor(href: string, map: HostMap): string {
  if (!href.startsWith("/")) return href;
  const path = roleOfPath(href.split(/[?#]/)[0]);
  if (path === "founding" || path === "shared") return href;
  const origin = map[path];
  return origin ? `${origin}${href}` : href;
}

/** The public site's origin for canonical links and the sitemap, when it is set. */
export function publicOrigin(map: HostMap): string | null {
  return map.public ?? null;
}
