"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { canManage, useCompany } from "@/components/app/company";
import { useBusinessDraft } from "@/components/app/settings/business-draft";
import { Guard } from "@/components/app/settings/guard";
import { SectionMark } from "@/components/app/settings/marks";
import { ChevronRight } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { legacyTarget, mayOpen, sectionById, type SettingsRole } from "@/lib/app/settings";

import { api } from "../../../../convex/_generated/api";

/** The jobs owners come to Settings for most, in their words, each pointing at the page that does it. */
const COMMON_TASKS: readonly { section: string; task: string; detail: string; ownerOnly?: boolean; href?: string }[] = [
  { section: "business", task: "Change your booking hours", detail: "Set the days and times customers can book.", ownerOnly: true },
  // Services live in Company → Services & Pricing; the task still starts here.
  { section: "services", href: "/app/services", task: "Update services and prices", detail: "Under Company → Services & Pricing.", ownerOnly: true },
  { section: "people", task: "Invite a team member", detail: "Give someone in your office access.", ownerOnly: true },
  { section: "agents", task: "Decide what your agents may do", detail: "Choose what needs your approval first.", ownerOnly: true },
  { section: "messaging", task: "Set up email and texting", detail: "Sender, registration, quiet hours and consent.", ownerOnly: true },
  { section: "billing", task: "Check your plan and credits", detail: "Credits left, usage and invoices." },
];

/** What a role sees first: the common tasks it can actually do. */
export function commonTasksFor(role: SettingsRole) {
  return COMMON_TASKS.filter((row) => {
    if (row.href) return !row.ownerOnly || role === "owner";
    const section = sectionById(row.section);
    if (!section || !mayOpen(section, role)) return false;
    return !row.ownerOnly || role === "owner";
  });
}

// ── Setup status ─────────────────────────────────────────────────────────────────────────────────

export type SetupState = "ready" | "attention" | "incomplete" | "checking" | "none";
export type SetupRow = { section: string; state: SetupState; words: string };

type Operation = { key: string; state: "ready" | "blocked" | "attention"; label: string; blockers: { words: string; href?: string }[] };

const STATE_BADGE: Record<Exclude<SetupState, "none">, { label: string; variant: "success" | "warning" | "error" | "outline" }> = {
  ready: { label: "Ready", variant: "success" },
  attention: { label: "Needs attention", variant: "warning" },
  incomplete: { label: "Setup incomplete", variant: "error" },
  checking: { label: "Checking", variant: "outline" },
};

const firstWords = (ops: readonly Operation[]) => ops.flatMap((op) => op.blockers.map((blocker) => blocker.words))[0];

/**
 * Where each part of setup stands, in words, from the same checks the server runs. Free of hooks so it
 * is easy to check: `undefined` inputs are still loading, `null` means this role cannot see that fact.
 */
export function setupStatus(input: { role: SettingsRole; configured: boolean | undefined; operations: readonly Operation[] | undefined; appIssues: number | null | undefined }): SetupRow[] {
  const { role, configured, operations, appIssues } = input;
  const op = (key: string) => operations?.find((row) => row.key === key);
  const rows: SetupRow[] = [];

  const profileGaps = (operations ?? []).flatMap((row) => row.blockers).filter((blocker) => blocker.href?.startsWith("/app/settings/business"));
  rows.push(
    configured === undefined || operations === undefined
      ? { section: "business", state: "checking", words: "Checking your company details…" }
      : !configured
        ? { section: "business", state: "incomplete", words: "Add your company name, time zone, service area and booking hours." }
        : profileGaps.length > 0
          ? { section: "business", state: "attention", words: profileGaps[0].words }
          : { section: "business", state: "ready", words: "Your business and legal details are filled in." },
  );

  const sending = [op("sms"), op("email")].filter((row): row is Operation => row !== undefined);
  rows.push(
    operations === undefined
      ? { section: "messaging", state: "checking", words: "Checking email and texting…" }
      : sending.every((row) => row.state === "ready")
        ? { section: "messaging", state: "ready", words: "Your company can text and email." }
        : { section: "messaging", state: sending.some((row) => row.state === "blocked") ? "incomplete" : "attention", words: firstWords(sending.filter((row) => row.state !== "ready")) ?? sending.find((row) => row.state !== "ready")!.label },
  );

  const agents = op("agents");
  rows.push(
    operations === undefined
      ? { section: "agents", state: "checking", words: "Checking your agents…" }
      : !agents || agents.state === "ready"
        ? { section: "agents", state: "ready", words: "Your agents can work and send." }
        : { section: "agents", state: agents.state === "blocked" ? "incomplete" : "attention", words: firstWords([agents]) ?? agents.label },
  );

  rows.push(
    appIssues === undefined
      ? { section: "integrations", state: "checking", words: "Checking your connections…" }
      : appIssues === null
        ? { section: "integrations", state: "none", words: "The apps Selestial works with for you." }
        : appIssues > 0
          ? { section: "integrations", state: "attention", words: `${appIssues} connection${appIssues === 1 ? " needs" : "s need"} attention.` }
          : { section: "integrations", state: "ready", words: "No connection problems." },
  );

  const terms = op("agreements");
  if (role === "owner" && terms && terms.state !== "ready") rows.push({ section: "agreements", state: "attention", words: firstWords([terms]) ?? terms.label });
  return rows;
}

export function SetupStatusList({ rows }: { rows: readonly SetupRow[] }) {
  return (
    <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
      {rows.map((row) => {
        const section = sectionById(row.section);
        if (!section) return null;
        return (
          <li key={row.section}>
            <Link href={section.path} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500 sm:px-5">
              <SectionMark id={section.id} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-strong">{section.label}</span>
                  {row.state === "none" ? null : (
                    <Badge variant={STATE_BADGE[row.state].variant} size="sm">
                      {STATE_BADGE[row.state].label}
                    </Badge>
                  )}
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{row.words}</span>
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function SetupStatus() {
  const { companyId, role } = useCompany();
  const { configured, saved } = useBusinessDraft();
  const readiness = useQuery(api.compliance.readiness, { companyId });
  const issues = useQuery(api.operations.issues, canManage(role) ? { companyId } : "skip");
  const rows = setupStatus({
    role,
    configured: saved === undefined ? undefined : configured,
    operations: readiness?.operations as Operation[] | undefined,
    appIssues: canManage(role) ? (issues === undefined ? undefined : issues.open.filter((card) => card.places.includes("integrations")).length) : null,
  });
  return <SetupStatusList rows={rows} />;
}

/**
 * Settings used to be one long page with parts linked by a hash. A hash never reaches the server, so
 * the old links are carried to the page that holds that part now, here in the browser.
 */
function useLegacyHash() {
  const router = useRouter();
  useEffect(() => {
    const target = legacyTarget(window.location.hash);
    if (target) router.replace(target);
  }, [router]);
}

/**
 * The Settings overview: where setup stands and what to do next. The full list of pages is the
 * Settings menu (and its search), so it is not repeated here.
 */
export function SettingsOverview() {
  const { role } = useCompany();
  useLegacyHash();
  const tasks = commonTasksFor(role);
  return (
    <div className="grid gap-6">
      <header>
        <h1 className="font-heading text-2xl tracking-tight text-strong">Settings</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {role === "owner"
            ? "Where your setup stands, and the changes owners make most. Most pages save when you choose Save; switches that save at once say so."
            : "Where your company's setup stands. Only the Owner can change most settings; your own account and notifications are yours."}
        </p>
      </header>

      <section aria-labelledby="setup-status">
        <h2 id="setup-status" className="mb-2 text-sm font-semibold text-strong">
          Setup status
        </h2>
        <Guard>
          <SetupStatus />
        </Guard>
      </section>

      {tasks.length > 0 ? (
        <section aria-labelledby="common-tasks">
          <h2 id="common-tasks" className="mb-2 text-sm font-semibold text-strong">
            Common tasks
          </h2>
          <ul className="grid gap-2 @xl:grid-cols-2 @4xl:grid-cols-3">
            {tasks.map((row) => {
              const section = sectionById(row.section);
              return (
                <li key={row.task}>
                  <Link
                    href={row.href ?? section!.path}
                    className="group flex h-full items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 transition-colors hover:border-brand-500/50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500"
                  >
                    <SectionMark id={section?.id ?? row.section} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-strong">{row.task}</span>
                      <span className="block text-xs text-muted-foreground">{row.detail}</span>
                    </span>
                    <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <p className="text-sm text-muted-foreground">Every settings page is in the Settings menu. Search it by what you want to change, like &ldquo;quiet hours&rdquo; or &ldquo;invoices&rdquo;; it also finds settings kept in other workspaces, like Dispatch&apos;s rules.</p>
    </div>
  );
}
