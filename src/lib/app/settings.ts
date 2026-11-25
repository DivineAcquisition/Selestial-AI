/**
 * Settings, defined once.
 *
 * Every section of Settings is listed here: its page, who may open it, what it is for, and the words
 * people search for it by. The settings navigation, the overview, the search and the navigation
 * catalog (src/lib/app/navigation.ts) are all derived from this list. Nothing else keeps its own copy.
 *
 * Where a section's facts live is part of the definition, so that two screens never both claim to be
 * the source of one.
 */

export const SETTINGS_ROOT = "/app/settings";

export type SettingsRole = "owner" | "manager" | "office";

export const SETTINGS_GROUPS = [
  { id: "business", label: "Business" },
  { id: "automation", label: "Automation & communication" },
  { id: "subscription", label: "Subscription" },
  { id: "account", label: "Account & security" },
] as const;
export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];

export type SettingsSection = {
  id: string;
  label: string;
  group: SettingsGroupId;
  path: string;
  /** What the page is for, in one sentence an owner would recognise. */
  purpose: string;
  /** The least role that may open the page. Everything is checked again in Convex. */
  minimumRole: SettingsRole;
  /** Who may change what is on the page, in a phrase. Shown only to people who cannot change it. */
  access: string;
  /** Other words someone might search for it by. */
  keywords: readonly string[];
  /**
   * A page reached from another page rather than from the menu. It is highlighted as that page in the
   * menu, and searching finds the page that links to it.
   */
  parent?: string;
  /** An old address kept so links still work. It is never listed as a page of its own. */
  oldAddress?: boolean;
};

const section = (id: string, label: string, group: SettingsGroupId, purpose: string, access: string, keywords: string[], minimumRole: SettingsRole = "office", parent?: string): SettingsSection => ({
  id,
  label,
  group,
  path: `${SETTINGS_ROOT}/${id}`,
  purpose,
  minimumRole,
  access,
  keywords,
  ...(parent ? { parent } : {}),
});

const OWNER_CHANGES = "Only the Owner can change these settings. You can view them.";

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  // Business
  section("business", "Company profile", "business", "Your company's name, time zone, service area and booking hours, and the legal details carriers and customers see.", OWNER_CHANGES, ["company", "profile", "name", "timezone", "time zone", "clock", "areas", "service area", "zip", "postal", "hours", "open", "opening", "schedule", "booking hours", "legal name", "ein", "tax id", "address", "representative", "support email", "support phone", "identity"]),
  section("people", "Office team & access", "business", "Who works in Selestial with you, what each person can do, and invitations.", "Only the Owner can invite people, change roles or remove access.", ["members", "team", "office", "staff", "roles", "owner", "manager", "invite", "invitation", "remove", "access"]),
  // Automation & communication
  section("agents", "Agent permissions", "automation", "What each agent may do on its own, what needs your approval, and pausing an agent. Each agent's own rules are under Configure.", OWNER_CHANGES, ["agents", "permissions", "approvals", "approve", "pause", "resume", "authority", "limits", "spending", "automatic", "ask me first", "configure", "dispatch", "recruiter", "sales", "retention", "quality"]),
  section("messaging", "Email & texting", "automation", "Whether your company can text and email, who messages come from, carrier registration, quiet hours and consent wording.", OWNER_CHANGES, ["messaging", "email", "texting", "sms", "text messages", "texting number", "sender", "from address", "registration", "10dlc", "carrier", "quiet hours", "consent", "opt out", "tcpa", "frequency", "disclosure", "wording"]),
  section("integrations", "Connected apps", "automation", "The apps Selestial works with for you, like Google, Gmail and your texting number: what needs attention, what is connected, and what you can add.", "Only the Owner can connect apps, choose what Selestial may use, or request a new one.", ["apps", "integrations", "connect", "connections", "google", "drive", "docs", "sheets", "calendar", "gmail", "business profile", "reviews", "google ads", "local services", "leads", "conversions", "quo", "openphone", "stripe", "quickbooks", "payments", "import", "jobber"]),
  section("email-branding", "Email branding", "automation", "Make emails sent through Selestial look like your business. We handle the sending setup.", OWNER_CHANGES, ["email branding", "branding", "logo", "brand", "colours", "colors", "sender name", "from name", "from address", "reply address", "reply-to", "replies", "signature", "email design", "test email", "what customers see"], "office", "messaging"),
  section("company-messages", "Company messages & previews", "automation", "Every email Selestial sends for your company, to your team, customers, applicants and cleaners, as it looks today.", "Anyone in the company can read these previews.", ["templates", "preview", "previews", "emails", "customer emails", "applicant emails", "cleaner emails", "what customers see"], "office", "messaging"),
  // Subscription
  section("billing", "Plan & usage", "subscription", "Your Selestial plan, credits and AI features, what your agents used, payment details and invoices.", "Only the Owner can see billing.", ["plan", "subscription", "invoice", "invoices", "payment", "card", "operate", "expand", "price", "credits", "usage", "top-up", "billing", "ai", "ai features", "ai usage", "images", "video", "photo review", "document search", "chat models", "allowance", "messaging balance"], "owner"),
  // Account & security
  section("security", "My account & security", "account", "Your own sign-in: password, two-step verification and signed-in devices. The Owner also finds Support access, Activity history and Selestial terms here.", "These settings are for your own account.", ["password", "two-factor", "2fa", "mfa", "two-step", "sessions", "devices", "sign in", "login", "account"]),
  section("notifications", "My notifications", "account", "What Selestial emails you about, and what happened to the notices it sent you.", "Each person chooses their own notifications.", ["notifications", "my email", "alerts", "digest", "weekly summary", "approvals", "escalations", "unsubscribe", "inbox"]),
  section("compliance", "Privacy & data", "account", "Download everything your company holds, erase a person's details, or ask for the company to be deleted.", "Only the Owner can export or erase data.", ["privacy", "data", "export", "download", "delete", "erase", "gdpr", "ccpa", "data request", "close company"]),
  section("support-access", "Support access", "account", "When Selestial Support opened your workspace, why, what it changed, and whether it may make changes.", "Only the Owner can see support access or allow changes.", ["support", "selestial support", "help", "access", "admin", "staff", "who looked", "history", "permission", "troubleshoot"], "owner", "security"),
  section("activity", "Activity history", "account", "A history of changes in your company and who made them.", "Only the Owner can see activity.", ["audit", "history", "log", "activity", "activity log", "events", "who changed", "changes"], "owner", "security"),
  section("agreements", "Selestial terms", "account", "The Selestial terms your company has accepted, who accepted them and when.", "Only the Owner can accept updated terms.", ["terms", "terms of service", "accept", "selestial", "platform", "versions", "legal"], "office", "security"),
  // Old address: AI features are part of Plan & usage now.
  { ...section("ai", "AI features", "subscription", "Which AI features your team can use, and this month's limits.", "Only the Owner can switch AI features.", ["ai", "features"], "owner", "billing"), oldAddress: true },
];

/**
 * Settings that belong to another workspace. Each has one editor, and it is there; Settings search
 * finds it so nobody has to know where it moved.
 */
export type SettingsShortcut = { id: string; label: string; where: string; href: string; purpose: string; keywords: readonly string[]; minimumRole: SettingsRole };

export const SETTINGS_SHORTCUTS: readonly SettingsShortcut[] = [
  { id: "services", label: "Services & pricing", where: "Company", href: "/app/services", purpose: "What you sell, how long it takes and what it costs.", keywords: ["services", "pricing", "prices", "catalog", "rates", "add-ons"], minimumRole: "owner" },
  { id: "customer-agreements", label: "Customer & cleaner agreements", where: "Agreements", href: "/app/agreements", purpose: "Agreements with your own customers and cleaners, and their templates.", keywords: ["agreements", "contracts", "templates", "signatures", "renewals"], minimumRole: "office" },
  { id: "dispatch", label: "Dispatch rules", where: "Dispatch", href: "/app/agents/dispatch/playbook", purpose: "How jobs are offered to cleaners, replacements, reminders, arrival checks, photos and checklists.", keywords: ["dispatch", "offers", "offering jobs", "replacement", "backup", "coverage", "buffer", "travel", "reminder", "arrival", "late", "no-show", "photos", "completion", "checklist", "crew pay"], minimumRole: "office" },
  { id: "recruiting", label: "Hiring setup", where: "Recruiter", href: "/app/agents/recruiter/hiring-setup", purpose: "Application links, follow-ups, interviews and the hiring inbox.", keywords: ["recruiting", "recruiter", "hiring", "applicants", "follow-ups", "interview", "gmail", "hiring inbox"], minimumRole: "office" },
  { id: "onboarding", label: "Cleaner onboarding", where: "Cleaners", href: "/app/cleaners/onboarding", purpose: "What a new cleaner needs before their first job, and who is ready.", keywords: ["onboarding", "new hire", "requirements", "documents", "background check", "ready to work"], minimumRole: "office" },
  { id: "sales", label: "Sales playbook", where: "Sales", href: "/app/agents/sales/playbook", purpose: "How Sales answers leads, quotes and follows up.", keywords: ["sales", "leads", "quotes", "follow-ups", "booking"], minimumRole: "office" },
  { id: "retention", label: "Retention playbook", where: "Retention", href: "/app/agents/retention/playbook", purpose: "How Retention keeps customers and wins them back.", keywords: ["retention", "churn", "win back", "renewals", "recovery"], minimumRole: "office" },
  { id: "quality", label: "Quality playbook", where: "Quality", href: "/app/agents/quality/playbook", purpose: "Standards, reviews and how complaints are handled.", keywords: ["quality", "standards", "reviews", "complaints", "corrections"], minimumRole: "office" },
  { id: "finance", label: "Customer invoices & payments", where: "Finance", href: "/app/finance/setup", purpose: "Your own Stripe account, invoice settings, cleaner pay and tips. Not your Selestial plan.", keywords: ["invoices", "customer payments", "stripe", "tax", "terms", "numbering", "pay tiers", "tips", "expenses", "payroll"], minimumRole: "owner" },
];

/** The sections listed in the Settings menu. Pages with a parent are reached from that page. */
export const menuSections = (list: readonly SettingsSection[]) => list.filter((row) => !row.parent);

const RANK: Record<SettingsRole, number> = { office: 0, manager: 1, owner: 2 };

export const mayOpen = (section: SettingsSection, role: SettingsRole) => RANK[role] >= RANK[section.minimumRole];

export const sectionsFor = (role: SettingsRole) => SETTINGS_SECTIONS.filter((row) => mayOpen(row, role));

export const sectionById = (id: string) => SETTINGS_SECTIONS.find((row) => row.id === id);

/** The section a path belongs to, including anything beneath it. */
export function sectionForPath(pathname: string): SettingsSection | undefined {
  const clean = pathname.split(/[?#]/)[0].replace(/\/+$/, "");
  return SETTINGS_SECTIONS.find((row) => clean === row.path || clean.startsWith(`${row.path}/`));
}

/** The menu entry a path belongs to: a page with a parent is shown as its parent. */
export function menuSectionForPath(pathname: string): SettingsSection | undefined {
  const own = sectionForPath(pathname);
  return own?.parent ? sectionById(own.parent) : own;
}

/** Sections whose label, purpose or keywords match every word typed. An empty query matches all. */
export function searchSections(query: string, list: readonly SettingsSection[] = SETTINGS_SECTIONS): SettingsSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...list];
  return list.filter((row) => {
    const haystack = `${row.label} ${row.purpose} ${row.keywords.join(" ")}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Shortcuts a role may follow whose words match every word typed. An empty query matches none. */
export function searchShortcuts(query: string, role: SettingsRole): SettingsShortcut[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return SETTINGS_SHORTCUTS.filter((row) => RANK[role] >= RANK[row.minimumRole]).filter((row) => {
    const haystack = `${row.label} ${row.where} ${row.purpose} ${row.keywords.join(" ")}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Pages reached from a page: support access, activity and terms from My account & security, for example. */
export const childSections = (parentId: string, list: readonly SettingsSection[] = SETTINGS_SECTIONS) => list.filter((row) => row.parent === parentId && !row.oldAddress);

/**
 * Old links that pointed at a part of one long Settings page, and the page that part lives on now.
 * A hash never reaches the server, so the overview reads it in the browser.
 */
export const LEGACY_HASHES: Readonly<Record<string, string>> = {
  security: `${SETTINGS_ROOT}/security`,
  agents: `${SETTINGS_ROOT}/agents`,
  dispatch: "/app/agents/dispatch/playbook",
  people: `${SETTINGS_ROOT}/people`,
  company: `${SETTINGS_ROOT}/business`,
  compliance: `${SETTINGS_ROOT}/compliance`,
  messaging: `${SETTINGS_ROOT}/messaging`,
  recruiting: "/app/agents/recruiter/hiring-setup",
  services: "/app/services",
};

export function legacyTarget(hash: string): string | null {
  return LEGACY_HASHES[hash.replace(/^#/, "").toLowerCase()] ?? null;
}
