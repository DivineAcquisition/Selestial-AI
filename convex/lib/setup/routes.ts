/**
 * Where an Owner may go while their setup is still in progress. Pure, and shared by the app's gate and
 * the server, so both agree on the list.
 *
 * Setup sends the owner to other pages to connect an inbox, import cleaners or customers, add a job,
 * review a draft or approve something. Those pages are reached normally, with the full workspace around
 * them and a "Return to setup" bar on top; every other page still sends the owner back to setup. This is
 * an allowlist of exact pages and page families, never "anything under /app".
 *
 * Authentication, company membership and role checks are unchanged: they run on every page and every
 * request as they always do. This only decides whether setup redirects.
 */

/** Pages setup itself owns: always shown full screen while setup is in progress. */
export const SETUP_ROOT = "/app/setup";

type Rule = { path: string; family: boolean; kind: HandoffKind };

export type HandoffKind = "integration" | "inbox" | "import" | "migration" | "records" | "review" | "approvals" | "billing" | "texting" | "help";

/** `family` allows the page and everything under it; otherwise only the page itself. */
const RULES: Rule[] = [
  // Integrations, and where every OAuth provider returns (Google returns to /app/settings/integrations).
  { path: "/app/integrations", family: true, kind: "integration" },
  { path: "/app/settings/integrations", family: true, kind: "integration" },
  { path: "/app/settings/connections", family: true, kind: "integration" },
  // The recruiting-only hiring inbox connection and the hiring role.
  { path: "/app/agents/recruiter/applicants", family: false, kind: "inbox" },
  { path: "/app/agents/recruiter/hiring-setup", family: false, kind: "review" },
  { path: "/app/agents/recruiter/hiring-needs", family: false, kind: "review" },
  { path: "/app/agents/recruiter/forms", family: true, kind: "review" },
  // Imports and migration.
  { path: "/app/cleaners/import", family: false, kind: "import" },
  { path: "/app/migration", family: true, kind: "migration" },
  { path: "/app/help", family: true, kind: "help" },
  // One real record: a job, a cleaner, a customer.
  { path: "/app/schedule", family: false, kind: "records" },
  { path: "/app/cleaners", family: false, kind: "records" },
  { path: "/app/clients", family: false, kind: "records" },
  // Drafts setup prepared, reviewed where they live.
  { path: "/app/services", family: true, kind: "review" },
  { path: "/app/agents/sales/booking-forms", family: true, kind: "review" },
  { path: "/app/agents/sales/playbook", family: false, kind: "review" },
  { path: "/app/agreements", family: true, kind: "review" },
  { path: "/app/first-work", family: false, kind: "review" },
  // Approvals setup asks for.
  { path: "/app/approvals", family: false, kind: "approvals" },
  // Billing and payments, when the outcome needs them.
  { path: "/app/settings/billing", family: false, kind: "billing" },
  { path: "/app/finance/setup", family: false, kind: "billing" },
  // Business texting registration: it never blocks drafts, but the owner may start it.
  { path: "/app/texting", family: false, kind: "texting" },
  { path: "/app/founding", family: false, kind: "billing" },
];

function clean(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? "";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function isSetupPage(pathname: string): boolean {
  const path = clean(pathname);
  return path === SETUP_ROOT || path.startsWith(`${SETUP_ROOT}/`);
}

/** The handoff a page is, or null when setup should send the owner back. */
export function setupDestination(pathname: string): HandoffKind | null {
  const path = clean(pathname);
  for (const rule of RULES) {
    if (path === rule.path || (rule.family && path.startsWith(`${rule.path}/`))) return rule.kind;
  }
  return null;
}

/** Whether an Owner in setup may stay on this page. */
export function allowedDuringSetup(pathname: string): boolean {
  return isSetupPage(pathname) || setupDestination(pathname) !== null;
}

/**
 * A return or handoff address that is safe to follow: a path inside the app, on this site, to a page setup
 * allows. Anything else (another site, a protocol-relative "//", a backslash trick, an encoded scheme) is
 * refused and returns null, so it can never become an open redirect.
 */
export function safeSetupPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 300) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  for (const value of [raw, decoded]) {
    if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value) || /^\/[^/]*:/.test(value)) return null;
  }
  const [path, query = ""] = raw.split("?", 2);
  if (!/^\/[A-Za-z0-9/_\-.]*$/.test(path) || path.includes("..")) return null;
  if (!allowedDuringSetup(path)) return null;
  const search = query.split("#")[0];
  return search && /^[A-Za-z0-9_\-.=&%+]*$/.test(search) ? `${path}?${search}` : path;
}
