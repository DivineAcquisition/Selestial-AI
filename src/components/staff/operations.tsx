"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";

import { Field, FormError, SelectInput, TextArea, TextInput, useRun } from "@/components/app/form";
import { useNow } from "@/components/app/use-now";
import { Activity, AlertTriangle, CheckCircle2, Clock, ExternalLink, RefreshCw, ShieldCheck } from "@/components/icons";
import { StartSupport } from "@/components/staff/support-start";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

/**
 * The staff Operations workspace (docs/operations/01-recovery.md §Staff workspace). Every count comes
 * from a record: incidents the monitor opened, or the workflows' own rows read live. Nothing here is a
 * score. The incident panel holds the investigation and every staff action, each needing its capability
 * on the server and a reason in the log.
 */

const VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "attention", label: "Needs attention" },
  { id: "agent_work", label: "Agent work" },
  { id: "communications", label: "Communications" },
  { id: "connections", label: "Connections" },
  { id: "billing", label: "Billing" },
  { id: "activity", label: "Activity" },
] as const;
type View = (typeof VIEWS)[number]["id"];

const SEVERITY: Record<string, { label: string; variant: "error" | "warning" | "info" | "outline"; dot: string }> = {
  critical: { label: "Critical", variant: "error", dot: "bg-destructive" },
  high: { label: "High", variant: "warning", dot: "bg-warning" },
  medium: { label: "Medium", variant: "info", dot: "bg-info" },
  low: { label: "Low", variant: "outline", dot: "bg-muted-foreground/50" },
};
const STATE: Record<string, { label: string; tone: string }> = {
  investigating: { label: "Investigating", tone: "text-info-foreground bg-info/10" },
  recovering: { label: "Recovering automatically", tone: "text-success-foreground bg-success/10" },
  waiting_owner: { label: "Waiting for owner", tone: "text-warning-foreground bg-warning/10" },
  waiting_provider: { label: "Waiting for provider", tone: "text-muted-foreground bg-muted" },
  needs_staff: { label: "Needs staff action", tone: "text-destructive-foreground bg-destructive/10" },
  resolved: { label: "Resolved", tone: "text-success-foreground bg-success/10" },
};
const CATEGORY_LABEL: Record<string, string> = { agent_work: "Agent work", communications: "Communications", connections: "Connections", billing: "Billing", platform: "Platform" };

export function ago(at: number | null | undefined, now: number): string {
  if (!at) return "never";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function when(at: number) {
  return new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function StatePill({ state }: { state: string }) {
  const info = STATE[state] ?? { label: state, tone: "bg-muted text-muted-foreground" };
  return <span className={cn("inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", info.tone)}>{info.label}</span>;
}

function SeverityDot({ severity }: { severity: string }) {
  const info = SEVERITY[severity] ?? SEVERITY.low;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-strong">
      <span className={cn("size-2 rounded-full", info.dot)} aria-hidden />
      {info.label}
    </span>
  );
}

// ── The workspace ─────────────────────────────────────────────────────────────────────────────────

export function OperationsWorkspace() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = (VIEWS.find((v) => v.id === params.get("view"))?.id ?? "overview") as View;
  const incidentId = params.get("incident") as Id<"incidents"> | null;
  const now = useNow();
  const overview = useQuery(api.operations.overview, now ? { asOf: now } : "skip");

  const go = useCallback(
    (next: { view?: View; incident?: string | null }) => {
      const url = new URLSearchParams(params.toString());
      if (next.view) url.set("view", next.view);
      if (next.incident === null) url.delete("incident");
      else if (next.incident) url.set("incident", next.incident);
      router.replace(`${pathname}?${url.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );
  const open = useCallback((id: string) => go({ incident: id }), [go]);
  const caps = new Set(overview?.me.capabilities ?? []);
  const attention = overview ? overview.counts.byState.needs_staff + overview.counts.byState.investigating + overview.counts.byState.waiting_owner + overview.counts.byState.waiting_provider : null;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl text-strong">Operations</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">What is broken, who it affects, what recovery is doing, and who acts next. Every number is read from a record.</p>
        </div>
        {overview ? <MonitorStatus overview={overview} now={now} /> : null}
      </div>

      <nav aria-label="Operations views" className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
        {VIEWS.map((item) => {
          const count = item.id === "attention" ? attention : item.id === "overview" || item.id === "activity" ? null : overview?.counts.byCategory[item.id as keyof typeof overview.counts.byCategory];
          const active = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => go({ view: item.id })}
              aria-current={active ? "page" : undefined}
              className={cn("-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-brand-500", active ? "border-brand-500 font-semibold text-strong" : "border-transparent text-muted-foreground hover:text-strong")}
            >
              {item.label}
              {count ? <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-strong">{count}</span> : null}
            </button>
          );
        })}
      </nav>

      {overview === undefined ? (
        <div className="grid gap-3" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : view === "overview" ? (
        <OverviewView overview={overview} now={now} onOpen={open} onView={(next) => go({ view: next })} />
      ) : view === "activity" ? (
        <ActivityView now={now} onOpen={open} />
      ) : (
        <IncidentView view={view} now={now} onOpen={open} />
      )}

      <IncidentPanel id={incidentId} now={now} caps={caps} onClose={() => go({ incident: null })} onOpen={open} />
    </div>
  );
}

type OverviewData = NonNullable<ReturnType<typeof useQuery<typeof api.operations.overview>>>;

function MonitorStatus({ overview, now }: { overview: OverviewData; now: number }) {
  const failing = overview.monitor.filter((row) => row.failing).length;
  return (
    <div className={cn("flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs", overview.monitorStale || failing ? "border-warning/50 bg-warning/10 text-warning-foreground" : "border-border bg-card text-muted-foreground")} role="status">
      {overview.monitorStale || failing ? <AlertTriangle className="size-3.5" aria-hidden /> : <Activity className="size-3.5" aria-hidden />}
      {overview.lastMonitorRun === null ? "The monitor has not run yet" : overview.monitorStale ? `Monitor stale: some checks haven't run in time (last run ${ago(overview.lastMonitorRun, now)})` : failing ? `${failing} check${failing === 1 ? "" : "s"} failing` : `Monitor ran ${ago(overview.lastMonitorRun, now)}`}
    </div>
  );
}

function Tile({ label, value, sub, tone, onClick }: { label: string; value: string | number; sub: string; tone?: "bad" | "warn" | "ok"; onClick?: () => void }) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp type={onClick ? "button" : undefined} onClick={onClick} className={cn("rounded-xl border border-border bg-card p-3 text-left", onClick && "hover:border-brand-500/40 focus-visible:outline-2 focus-visible:outline-brand-500")}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-1 font-heading text-2xl tabular-nums", tone === "bad" ? "text-destructive" : tone === "warn" ? "text-warning-foreground" : "text-strong")}>{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
    </Comp>
  );
}

function OverviewView({ overview, now, onOpen, onView }: { overview: OverviewData; now: number; onOpen: (id: string) => void; onView: (view: View) => void }) {
  const s = overview.counts.bySeverity;
  const st = overview.counts.byState;
  return (
    <div className="grid gap-4">
      {overview.isolation.role !== "production" ? (
        <p className="flex items-start gap-2 rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-sm text-info-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            This is the <strong>{overview.isolation.role}</strong> backend{overview.isolation.declared ? "" : " (worked out from its address; set SELESTIAL_DEPLOYMENT to declare it)"}.{" "}
            {overview.isolation.role === "test" ? `Texts and emails go only to ${overview.isolation.testRecipients ?? 0} listed test recipients; live payment keys are refused.` : overview.isolation.role === "restore" ? "Restored data: nothing is sent, nothing is charged, no scheduled job runs." : "Local: stand-in providers only."}
          </span>
        </p>
      ) : null}

      <section aria-label="Summary" className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Tile label="What is broken" value={overview.counts.open} sub={`${s.critical} critical · ${s.high} high · ${s.medium + s.low} other`} tone={s.critical ? "bad" : s.high ? "warn" : undefined} onClick={() => onView("attention")} />
        <Tile label="Who is affected" value={overview.affectedCompanies} sub={`${overview.affectedCompanies === 1 ? "company" : "companies"}${overview.platform.length ? ` · ${overview.platform.length} platform` : ""}`} />
        <Tile label="Business blocked" value={overview.blocked.length} sub="high or critical company incidents" tone={overview.blocked.length ? "warn" : undefined} />
        <Tile label="Recovering on its own" value={st.recovering} sub={`${overview.recovered.length} recovered in 24 h`} tone={st.recovering ? "ok" : undefined} />
        <Tile label="Who acts next" value={st.needs_staff + st.investigating} sub={`staff · ${st.waiting_owner} owner · ${st.waiting_provider} provider`} tone={st.needs_staff ? "bad" : undefined} onClick={() => onView("attention")} />
      </section>

      {overview.platform.length ? (
        <section className="rounded-xl border border-destructive/40 bg-destructive/5 p-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-strong">
            <AlertTriangle className="size-4 text-destructive" aria-hidden /> Platform incidents
          </h2>
          <ul className="mt-2 grid gap-1.5">
            {overview.platform.map((row) => (
              <li key={row.id}>
                <button type="button" onClick={() => onOpen(row.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-card px-3 py-2 text-left text-sm hover:bg-overlay/[0.03] focus-visible:outline-2 focus-visible:outline-brand-500">
                  <span className="font-mono text-xs text-muted-foreground">{row.reference}</span>
                  <span className="min-w-0 flex-1 font-medium text-strong">{row.title}</span>
                  <span className="text-xs text-muted-foreground">{row.occurrences} companies</span>
                  <StatePill state={row.state} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <section className="rounded-xl border border-border bg-card">
          <header className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold text-strong">Needs staff now</h2>
            <button type="button" onClick={() => onView("attention")} className="text-xs font-medium text-brand-700 hover:underline">
              All that needs attention
            </button>
          </header>
          {overview.urgent.length ? <IncidentTable rows={overview.urgent} now={now} onOpen={onOpen} compact /> : <Empty words="Nothing needs staff right now." />}
        </section>
        <section className="rounded-xl border border-border bg-card">
          <header className="border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold text-strong">Recent recoveries</h2>
          </header>
          {overview.recovered.length ? (
            <ul className="divide-y divide-border">
              {overview.recovered.slice(0, 8).map((row) => (
                <li key={row.id}>
                  <button type="button" onClick={() => onOpen(row.id)} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-overlay/[0.03] focus-visible:outline-2 focus-visible:outline-brand-500">
                    <CheckCircle2 className={cn("mt-0.5 size-4 shrink-0", row.how === "verified" ? "text-success" : "text-muted-foreground")} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-strong">{row.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {row.company} · {row.how === "verified" ? "verified" : "dismissed"} {ago(row.resolvedAt, now)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty words="No incidents closed in the last day." />
          )}
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <section className="rounded-xl border border-border bg-card">
          <header className="border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold text-strong">Monitor checks</h2>
            <p className="text-xs text-muted-foreground">Each check reads one workflow&apos;s own records. Stale means it missed three of its runs.</p>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Check</th>
                  <th className="px-3 py-1.5 font-medium">Every</th>
                  <th className="px-3 py-1.5 font-medium">Last run</th>
                  <th className="px-3 py-1.5 font-medium">Found</th>
                  <th className="px-3 py-1.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {overview.monitor.map((row) => (
                  <tr key={row.name} title={row.about}>
                    <td className="px-3 py-1.5 font-mono text-xs text-strong">{row.name}</td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">{Math.round(row.everyMs / 60_000)}m</td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">{ago(row.lastRunAt, now)}</td>
                    <td className="px-3 py-1.5 text-xs tabular-nums">{row.found}</td>
                    <td className="px-3 py-1.5">{row.failing ? <Badge variant="error">Failing</Badge> : row.stale ? <Badge variant="warning">Stale</Badge> : !row.complete ? <Badge variant="info">Partial</Badge> : <Badge variant="success">OK</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="rounded-xl border border-border bg-card">
          <header className="border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold text-strong">Outbound stops</h2>
            <p className="text-xs text-muted-foreground">Companies whose outbound texts, emails and autonomous actions Selestial stopped.</p>
          </header>
          {overview.outboundStops.length ? (
            <ul className="divide-y divide-border">
              {overview.outboundStops.map((row) => (
                <li key={row.companyId} className="px-3 py-2 text-sm">
                  <p className="font-medium text-strong">{row.company}</p>
                  <p className="text-xs text-muted-foreground">
                    Since {when(row.at)} · {row.reason}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty words="No company's outbound sending is stopped." />
          )}
        </section>
      </div>
    </div>
  );
}

function Empty({ words }: { words: string }) {
  return <p className="px-3 py-8 text-center text-sm text-muted-foreground">{words}</p>;
}

type Row = NonNullable<ReturnType<typeof useQuery<typeof api.operations.incidents>>>[number];

/** A compact, keyboard-navigable table: arrow keys move between rows, Enter opens the panel. */
function IncidentTable({ rows, now, onOpen, compact }: { rows: Row[]; now: number; onOpen: (id: string) => void; compact?: boolean }) {
  const body = useRef<HTMLTableSectionElement>(null);
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(body.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    const next = buttons[Math.min(Math.max(index + (event.key === "ArrowDown" ? 1 : -1), 0), buttons.length - 1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-1.5 font-medium">Severity</th>
            <th className="px-3 py-1.5 font-medium">Incident</th>
            {compact ? null : <th className="px-3 py-1.5 font-medium">Category</th>}
            <th className="px-3 py-1.5 font-medium">State</th>
            <th className="px-3 py-1.5 font-medium">Seen</th>
            {compact ? null : <th className="px-3 py-1.5 font-medium">Tries</th>}
            {compact ? null : <th className="px-3 py-1.5 font-medium">Assigned</th>}
          </tr>
        </thead>
        <tbody ref={body} onKeyDown={onKey} className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.id} data-row tabIndex={0} onClick={() => onOpen(row.id)} onKeyDown={(event) => (event.key === "Enter" ? onOpen(row.id) : undefined)} className="cursor-pointer hover:bg-overlay/[0.03] focus-visible:bg-brand-500/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500" aria-label={`${row.reference} ${row.title}, ${row.company}`}>
              <td className="px-3 py-2 align-top">
                <SeverityDot severity={row.severity} />
              </td>
              <td className="max-w-[28rem] px-3 py-2 align-top">
                <p className="truncate font-medium text-strong">{row.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  <span className="font-mono">{row.reference}</span> · {row.company}
                  {row.occurrences > 1 ? ` · ${row.occurrences} ${row.scope === "platform" ? "companies" : "items"}` : ""}
                  {row.supportRequestedAt ? " · owner asked for help" : ""}
                  {row.parentId ? " · part of a platform incident" : ""}
                </p>
              </td>
              {compact ? null : <td className="px-3 py-2 align-top text-xs text-muted-foreground">{CATEGORY_LABEL[row.category]}</td>}
              <td className="px-3 py-2 align-top">
                <StatePill state={row.state} />
              </td>
              <td className="px-3 py-2 align-top text-xs whitespace-nowrap text-muted-foreground" title={`First ${when(row.firstSeenAt)}`}>
                {ago(row.lastSeenAt, now)}
              </td>
              {compact ? null : <td className="px-3 py-2 align-top text-xs tabular-nums text-muted-foreground">{row.recoveryAttempts}</td>}
              {compact ? null : <td className="px-3 py-2 align-top text-xs text-muted-foreground">{row.assignedTo ?? "—"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={cn("rounded-full border px-2.5 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-brand-500", active ? "border-brand-500 bg-brand-500/10 text-brand-700" : "border-border bg-card text-muted-foreground hover:text-strong")}>
      {children}
    </button>
  );
}

function IncidentView({ view, now, onOpen }: { view: Exclude<View, "overview" | "activity">; now: number; onOpen: (id: string) => void }) {
  const [severity, setSeverity] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [mine, setMine] = useState(false);
  const [resolved, setResolved] = useState(false);
  const rows = useQuery(api.operations.incidents, { view, ...(severity ? { severity } : {}), ...(state ? { state } : {}), ...(mine ? { mine } : {}), ...(resolved ? { resolved } : {}) });
  return (
    <div className="grid gap-3">
      {view === "agent_work" ? <AgentWorkLive now={now} /> : view === "communications" || view === "connections" || view === "billing" ? <LiveCounts view={view} now={now} /> : null}
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filters">
        {Object.entries(SEVERITY).map(([id, info]) => (
          <Chip key={id} active={severity === id} onClick={() => setSeverity(severity === id ? null : id)}>
            {info.label}
          </Chip>
        ))}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        {["needs_staff", "waiting_owner", "waiting_provider", "recovering", "investigating"].map((id) => (
          <Chip key={id} active={state === id} onClick={() => setState(state === id ? null : id)}>
            {STATE[id].label}
          </Chip>
        ))}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <Chip active={mine} onClick={() => setMine(!mine)}>
          Assigned to me
        </Chip>
        <Chip active={resolved} onClick={() => setResolved(!resolved)}>
          Resolved
        </Chip>
      </div>
      <section className="rounded-xl border border-border bg-card">
        {rows === undefined ? <Skeleton className="m-3 h-40" /> : rows.length ? <IncidentTable rows={rows} now={now} onOpen={onOpen} /> : <Empty words={resolved ? "Nothing resolved matches." : "Nothing open matches. The monitor opens incidents as it finds them."} />}
      </section>
    </div>
  );
}

function AgentWorkLive({ now }: { now: number }) {
  const data = useQuery(api.operations.agentWork, now ? { asOf: now } : "skip");
  if (!data) return <Skeleton className="h-40 rounded-xl" />;
  return (
    <div className="grid gap-3 lg:grid-cols-[1.3fr_1fr]">
      <section className="rounded-xl border border-border bg-card">
        <header className="border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold text-strong">Work by workflow, live</h2>
          <p className="text-xs text-muted-foreground">Read from each workflow&apos;s own rows. Waiting includes normal waits (approvals, connections, review).</p>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                {["Workflow", "Running", "Waiting", "Stalled", "Failed", "Recovered 24h"].map((h) => (
                  <th key={h} className="px-3 py-1.5 font-medium whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.rows.map((row) => (
                <tr key={row.workflow} title={row.recovery}>
                  <td className="px-3 py-1.5 font-medium text-strong">{row.workflow}</td>
                  <td className="px-3 py-1.5 tabular-nums">{row.running}</td>
                  <td className="px-3 py-1.5 tabular-nums">{row.waiting}</td>
                  <td className={cn("px-3 py-1.5 tabular-nums", row.stalled !== "0" && row.stalled !== "—" && "font-semibold text-destructive")}>{row.stalled}</td>
                  <td className="px-3 py-1.5 tabular-nums">{row.failed}</td>
                  <td className="px-3 py-1.5 tabular-nums">{row.recovered}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="rounded-xl border border-border bg-card">
        <header className="border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold text-strong">Stalled, failed and uncertain items</h2>
        </header>
        {data.items.length ? (
          <ul className="max-h-80 divide-y divide-border overflow-y-auto">
            {data.items.map((item, i) => (
              <li key={i} className="px-3 py-2 text-sm">
                <p className="flex items-center gap-2">
                  <span className="truncate font-medium text-strong">{item.what}</span>
                  <Badge variant={item.state === "stalled" ? "error" : item.state === "uncertain" ? "warning" : "outline"} size="sm">
                    {item.state}
                  </Badge>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {item.company} · {item.workflow} · {ago(item.since, now)} · {item.attempts} {item.attempts === 1 ? "try" : "tries"}
                </p>
                {item.detail ? <p className="mt-0.5 line-clamp-2 font-mono text-[11px] text-muted-foreground">{item.detail}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty words="Nothing stalled, failed or uncertain." />
        )}
      </section>
    </div>
  );
}

function LiveCounts({ view, now }: { view: "communications" | "connections" | "billing"; now: number }) {
  const data = useQuery(api.operations.live, now ? { asOf: now } : "skip");
  if (!data) return <Skeleton className="h-24 rounded-xl" />;
  const tiles: { label: string; value: string; sub: string; warn?: boolean }[] =
    view === "communications"
      ? [
          { label: "Unconfirmed sends", value: data.communications.unconfirmed, sub: `${data.communications.reconciling} being checked with the provider`, warn: data.communications.unconfirmed !== "0" },
          { label: "Failed, 24 h", value: data.communications.failed24h, sub: data.communications.failedByProvider.map((p) => `${p.provider} ${p.count}`).join(" · ") || "none" },
          { label: "Waiting", value: data.communications.heldForFunds, sub: `for funds · ${data.communications.heldForInbox} for an inbox · ${data.communications.heldQuietHours} quiet hours · ${data.communications.heldBillingUnavailable} billing down` },
          { label: "Sends open > 5 min", value: data.communications.sendingOver5m, sub: "the outbox sweep closes these", warn: data.communications.sendingOver5m !== "0" },
          { label: "Unrouted inbound, 24 h", value: data.communications.inboundUnrouted24h, sub: "texts to numbers no company uses" },
          { label: "Texting registrations", value: data.communications.texting.needsOwner, sub: `need the owner · ${data.communications.texting.awaitingReview} await review · ${data.communications.texting.withCarriers} with carriers · ${data.communications.texting.interrupted} paused · ${data.communications.texting.failed} stopped · ${data.communications.texting.active} active` },
        ]
      : view === "connections"
        ? [
            { label: "Gmail inboxes expired", value: data.connections.mailboxesExpired, sub: `${data.connections.mailboxesError} in error · ${data.connections.mailboxesConnected} connected`, warn: data.connections.mailboxesExpired !== "0" },
            { label: "Google tools expired", value: data.connections.googleExpired, sub: "Calendar, Drive, Business Profile, Ads" },
            { label: "Other apps expired", value: data.connections.connectorsExpired, sub: "Jobber, Housecall Pro" },
          ]
        : [
            { label: "AI charges unverified", value: data.billing.aiUnverified, sub: `${data.billing.aiRetrying} retrying 3+ times · ${data.billing.aiPending} pending`, warn: data.billing.aiUnverified !== "0" },
            { label: "Messaging charges unverified", value: data.billing.messagingUnverified, sub: "settlement could not be confirmed" },
            { label: "Top-ups failed, 7 days", value: data.billing.topUpsFailed7d, sub: "owners are asked to add funds" },
            { label: "Balance attention", value: data.billing.messagingAttention, sub: "overdraft floor, inbound spikes" },
          ];
  return (
    <section className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-xl border border-border bg-card p-3">
          <p className="text-xs font-medium text-muted-foreground">{tile.label}</p>
          <p className={cn("mt-1 font-heading text-xl tabular-nums", tile.warn ? "text-warning-foreground" : "text-strong")}>{tile.value}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{tile.sub}</p>
        </div>
      ))}
      {view === "billing" ? (
        <Link href="/staff/messaging" className="flex items-center gap-1 self-center text-xs font-medium text-brand-700 hover:underline">
          Messaging money <ExternalLink className="size-3" aria-hidden />
        </Link>
      ) : null}
    </section>
  );
}

function ActivityView({ now, onOpen }: { now: number; onOpen: (id: string) => void }) {
  const [actor, setActor] = useState<"staff" | "system" | "member" | null>(null);
  const rows = useQuery(api.operations.activity, { limit: 150, ...(actor ? { actor } : {}) });
  const sessions = useQuery(api.support.sessions, {});
  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <section className="rounded-xl border border-border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold text-strong">Interventions and recovery history</h2>
          <div className="flex gap-1.5">
            {(["staff", "system", "member"] as const).map((id) => (
              <Chip key={id} active={actor === id} onClick={() => setActor(actor === id ? null : id)}>
                {id === "staff" ? "Staff" : id === "system" ? "Selestial" : "Owners"}
              </Chip>
            ))}
          </div>
        </header>
        {rows === undefined ? (
          <Skeleton className="m-3 h-40" />
        ) : rows.length ? (
          <ol className="divide-y divide-border">
            {rows.map((row) => (
              <li key={row.id} className="grid grid-cols-[5.5rem_1fr] gap-3 px-3 py-2 text-sm">
                <span className="text-xs text-muted-foreground" title={when(row.at)}>
                  {ago(row.at, now)}
                </span>
                <span className="min-w-0">
                  <span className="text-strong">{row.words}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {row.actor}
                    {row.viaSession ? " · in a support session" : ""}
                    {row.company ? ` · ${row.company}` : ""}
                    {row.incident ? (
                      <>
                        {" · "}
                        <button type="button" onClick={() => onOpen(row.incident!.id)} className="font-mono text-brand-700 hover:underline">
                          {row.incident.reference}
                        </button>
                      </>
                    ) : null}
                  </span>
                  {row.detail ? <span className="mt-0.5 block font-mono text-[11px] break-words text-muted-foreground">{row.detail}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <Empty words="Nothing recorded yet." />
        )}
      </section>
      <section className="rounded-xl border border-border bg-card">
        <header className="border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold text-strong">Support sessions</h2>
          <p className="text-xs text-muted-foreground">Every admin entry into a customer workspace, with its reason.</p>
        </header>
        {sessions === undefined ? (
          <Skeleton className="m-3 h-24" />
        ) : sessions.length ? (
          <ul className="divide-y divide-border">
            {sessions.map((row) => (
              <li key={row.id} className="px-3 py-2 text-sm">
                <p className="flex items-center gap-2">
                  <span className="truncate font-medium text-strong">{row.company}</span>
                  <Badge variant={row.mode === "manage" ? "warning" : "outline"} size="sm">
                    {row.mode === "manage" ? "Manage" : "View"}
                  </Badge>
                  {row.live ? (
                    <Badge variant="success" size="sm">
                      Live
                    </Badge>
                  ) : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.staff} · {ago(row.startedAt, now)} · {row.changes} {row.changes === 1 ? "change" : "changes"}
                </p>
                <p className="line-clamp-2 text-xs text-muted-foreground">{row.reason}</p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty words="No support sessions yet." />
        )}
      </section>
    </div>
  );
}

// ── The incident panel ────────────────────────────────────────────────────────────────────────────

const JOBS = [
  { id: "operations.monitor", label: "Operations: run due checks" },
  { id: "activation.sweep", label: "Activation: recover and resume first work" },
  { id: "messaging.sweepStuck", label: "Outbox: find sends that never finished" },
  { id: "billing.sweep", label: "Billing: settle and recover AI work" },
  { id: "messagingBilling.sweep", label: "Messaging charges: settle and recover" },
  { id: "texting.reconcile", label: "Texting registrations: reconcile" },
  { id: "googleWork.tick", label: "Google: work the queue" },
  { id: "salesAgent.sweep", label: "Sales: pick up what a missed trigger left" },
  { id: "retentionWork.sweep", label: "Retention: reconcile and follow through" },
  { id: "chatRuns.sweep", label: "Chat: close interrupted responses" },
];

function IncidentPanel({ id, now, caps, onClose, onOpen }: { id: Id<"incidents"> | null; now: number; caps: Set<string>; onClose: () => void; onOpen: (id: string) => void }) {
  return (
    <Sheet open={id !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetPopup side="right" className="max-w-2xl bg-card text-foreground">
        <SheetTitle className="sr-only">Incident</SheetTitle>
        {id ? <IncidentDetail id={id} now={now} caps={caps} onOpen={onOpen} /> : null}
      </SheetPopup>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border px-5 py-3">
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function IncidentDetail({ id, now, caps, onOpen }: { id: Id<"incidents">; now: number; caps: Set<string>; onOpen: (id: string) => void }) {
  const row = useQuery(api.operations.incident, { id });
  const assign = useMutation(api.operations.assign);
  const verify = useMutation(api.operations.verify);
  const note = useMutation(api.operations.note);
  const dismiss = useMutation(api.operations.dismiss);
  const recover = useMutation(api.operations.runRecovery);
  const stop = useMutation(api.operations.stopOutbound);
  const resume = useMutation(api.operations.resumeOutbound);
  const reconcile = useMutation(api.operations.reconcileMessage);
  const { busy, error, run } = useRun();
  const [form, setForm] = useState<null | "note" | "dismiss" | "recover" | "stop" | "resume" | "support">(null);
  const [words, setWords] = useState("");
  const [job, setJob] = useState("operations.monitor");
  const [verified, setVerified] = useState<string | null>(null);
  const can = (cap: string) => caps.has(cap);
  const messages = useMemo(() => row?.related.filter((r) => r.table === "messages") ?? [], [row]);
  if (row === undefined) return <Skeleton className="m-5 h-80" />;
  const submit = (fn: () => Promise<unknown>) =>
    run(async () => {
      await fn();
      setForm(null);
      setWords("");
    });
  return (
    <div className="flex h-full flex-col overflow-y-auto pb-6">
      <header className="px-5 pt-5 pb-3">
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{row.reference}</span>
          <span>·</span>
          <span>{CATEGORY_LABEL[row.category]}</span>
          <span>·</span>
          <span className="font-mono">{row.kind}</span>
        </p>
        <h2 className="mt-1 pr-8 font-heading text-lg text-strong">{row.title}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SeverityDot severity={row.severity} />
          <StatePill state={row.state} />
          <span className="text-xs text-muted-foreground">
            {row.company} · first {when(row.firstSeenAt)} · last {ago(row.lastSeenAt, now)}
          </span>
        </div>
        {row.supportRequestedAt ? <p className="mt-2 rounded-md bg-warning/10 px-2 py-1 text-xs text-warning-foreground">The owner asked for help {ago(row.supportRequestedAt, now)}. They have not been asked to describe anything.</p> : null}
      </header>

      <div className="flex flex-wrap gap-1.5 px-5 pb-3">
        {can("operations.act") ? (
          <>
            <Button size="sm" variant="outline" loading={busy && form === null} onClick={() => void run(async () => assign({ id, ...(row.assignedTo ? { staffId: null } : {}) }))}>
              {row.assignedTo ? `Unassign (${row.assignedTo})` : "Assign to me"}
            </Button>
            {row.state !== "resolved" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void run(async () => {
                    const result = await verify({ id });
                    setVerified(result.open ? "Checked again: still happening." : "Checked again: resolved, with the check's evidence.");
                  })
                }
              >
                <RefreshCw className="size-3.5" aria-hidden /> Verify now
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => setForm(form === "recover" ? null : "recover")}>
              Run recovery job
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setForm(form === "note" ? null : "note")}>
              Add note
            </Button>
          </>
        ) : null}
        {row.companyId && can("workspace.view") ? (
          <Button size="sm" variant="primary" onClick={() => setForm(form === "support" ? null : "support")}>
            Open company workspace
          </Button>
        ) : null}
        {row.companyId && can("communications.act") ? (
          <Button size="sm" variant={row.companyState?.outboundStop ? "outline" : "destructive-outline"} onClick={() => setForm(form === "stop" || form === "resume" ? null : row.companyState?.outboundStop ? "resume" : "stop")}>
            {row.companyState?.outboundStop ? "Resume outbound…" : "Stop outbound…"}
          </Button>
        ) : null}
        {can("operations.act") && row.state !== "resolved" ? (
          <Button size="sm" variant="ghost" onClick={() => setForm(form === "dismiss" ? null : "dismiss")}>
            Dismiss…
          </Button>
        ) : null}
      </div>
      {verified ? <p className="mx-5 mb-2 text-xs text-muted-foreground">{verified}</p> : null}
      <FormError message={error} />

      {form === "support" && row.companyId ? (
        <div className="mx-5 mb-3 rounded-lg border border-border p-3">
          <StartSupport companyId={row.companyId as Id<"companies">} companyName={row.company} incidentId={id} onDone={() => setForm(null)} />
        </div>
      ) : null}
      {form === "note" || form === "dismiss" || form === "recover" ? (
        <form
          className="mx-5 mb-3 grid gap-2 rounded-lg border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(() => (form === "note" ? note({ id, words }) : form === "dismiss" ? dismiss({ id, reason: words }) : recover({ id, job, reason: words })));
          }}
        >
          {form === "recover" ? (
            <Field label="Job" hint="The workflow's own idempotent recovery, run now. It re-checks every record before acting.">
              <SelectInput value={job} onChange={(event) => setJob(event.target.value)}>
                {JOBS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </SelectInput>
            </Field>
          ) : null}
          <Field label={form === "note" ? "Note (staff only)" : form === "dismiss" ? "Why this isn't actionable" : "Reason"} hint={form === "dismiss" ? "Closes it as dismissed. The same problem, unchanged, stays closed for a week." : undefined}>
            <TextArea value={words} onChange={(event) => setWords(event.target.value)} rows={2} required />
          </Field>
          <div>
            <Button type="submit" size="sm" variant={form === "dismiss" ? "destructive-outline" : "primary"} loading={busy}>
              {form === "note" ? "Add note" : form === "dismiss" ? "Dismiss incident" : "Run it"}
            </Button>
          </div>
        </form>
      ) : null}
      {(form === "stop" || form === "resume") && row.companyId ? (
        <OutboundControl companyId={row.companyId as Id<"companies">} incidentId={id} stopped={row.companyState?.outboundStop ?? null} onStop={(reason) => submit(() => stop({ companyId: row.companyId as Id<"companies">, reason, incidentId: id }))} onResume={(reason) => submit(() => resume({ companyId: row.companyId as Id<"companies">, reason }))} busy={busy} />
      ) : null}

      <Section title="What it means">
        <p className="text-sm text-strong">{row.impact}</p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          <span className="font-medium text-strong">Already done: </span>
          {row.done}
        </p>
        {row.action ? (
          <p className="mt-1.5 text-sm text-muted-foreground">
            <span className="font-medium text-strong">Owner&apos;s action: </span>
            {row.action.label}
            {row.action.href ? <span className="font-mono text-xs"> → {row.action.href}</span> : null}
            {row.ownerVisible ? null : " (not shown to the owner)"}
          </p>
        ) : null}
      </Section>
      <Section title="Who acts next">
        <p className="text-sm text-strong">{row.next}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {row.recoveryAttempts} automatic recovery {row.recoveryAttempts === 1 ? "attempt" : "attempts"}
          {row.check ? ` · check ${row.check.name} last ran ${ago(row.check.lastRunAt, now)}` : ""}
          {row.notified.ownerAt ? ` · owner emailed ${ago(row.notified.ownerAt, now)}` : ""}
          {row.notified.staffAt ? ` · staff alerted ${ago(row.notified.staffAt, now)}` : ""}
        </p>
      </Section>
      {row.diagnostics ? (
        <Section title="Diagnostics (staff only)">
          <p className="rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-words text-strong">{row.diagnostics}</p>
        </Section>
      ) : null}
      {row.parent || row.children.length ? (
        <Section title={row.parent ? "Part of" : `Companies affected (${row.children.length})`}>
          <ul className="grid gap-1">
            {(row.parent ? [row.parent] : row.children).map((child) => (
              <li key={child.id}>
                <button type="button" onClick={() => onOpen(child.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-overlay/[0.04]">
                  <span className="font-mono text-xs text-muted-foreground">{child.reference}</span>
                  <span className="min-w-0 flex-1 truncate text-strong">{row.parent ? child.title : child.company}</span>
                  <StatePill state={child.state} />
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {row.related.length ? (
        <Section title={`Records (${row.related.length})`}>
          <ul className="grid gap-1 text-sm">
            {row.related.map((r) => (
              <li key={`${r.table}:${r.id}`} className="flex flex-wrap items-center gap-2">
                <span className="text-strong">{r.label}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {r.table}/{r.id}
                </span>
                {r.table === "messages" && can("communications.act") && row.state !== "resolved" ? (
                  <Button size="xs" variant="outline" onClick={() => void run(async () => reconcile({ messageId: r.id as Id<"messages">, reason: `Staff reconcile from ${row.reference}` }))}>
                    Check with provider
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {messages.length ? <p className="mt-1.5 text-xs text-muted-foreground">Checking re-sends under the message&apos;s own idempotency key, inside Telnyx&apos;s 24-hour replay window, after consent, pauses and the record are checked again. If the first attempt went, Telnyx replays it and nothing is sent twice.</p> : null}
        </Section>
      ) : null}
      {row.sessions.length ? (
        <Section title="Support sessions for this incident">
          <ul className="grid gap-1 text-sm">
            {row.sessions.map((s) => (
              <li key={s.id} className="text-muted-foreground">
                {when(s.startedAt)} · {s.mode === "manage" ? "Manage" : "View"} · {s.changes} changes {s.endedAt ? `· ended ${ago(s.endedAt, now)}` : "· live"}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {row.resolution ? (
        <Section title="Resolution">
          <p className="text-sm text-strong">
            {row.resolution.how === "verified" ? "Verified by the check" : `Dismissed by ${row.resolution.by ?? "staff"}`}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{row.resolution.evidence}</p>
        </Section>
      ) : null}
      <Section title="Timeline">
        <ol className="grid gap-2">
          {row.log.map((entry) => (
            <li key={entry.id} className="grid grid-cols-[4.5rem_1fr] gap-2 text-sm">
              <span className="text-xs text-muted-foreground" title={when(entry.at)}>
                <Clock className="mr-1 inline size-3" aria-hidden />
                {ago(entry.at, now)}
              </span>
              <span>
                <span className="text-strong">{entry.words}</span>
                <span className="block text-xs text-muted-foreground">{entry.actor}</span>
                {entry.detail ? <span className="mt-0.5 block font-mono text-[11px] break-words text-muted-foreground">{entry.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

function OutboundControl({ stopped, onStop, onResume, busy }: { companyId: Id<"companies">; incidentId: Id<"incidents">; stopped: { at: number; reason: string } | null; onStop: (reason: string) => void; onResume: (reason: string) => void; busy: boolean }) {
  const [reason, setReason] = useState("");
  return (
    <form
      className="mx-5 mb-3 grid gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (stopped) onResume(reason);
        else onStop(reason);
      }}
    >
      <p className="text-sm font-medium text-strong">{stopped ? "Outbound sending is stopped for this company" : "Stop this company's outbound activity"}</p>
      <p className="text-xs text-muted-foreground">
        {stopped
          ? `Stopped ${when(stopped.at)}: ${stopped.reason}. Resuming lets new work go through the usual checks. Nothing refused while stopped is sent.`
          : "Stops every outbound text and email, and with them agents' autonomous sends. Keeps working: inbound texts, STOP/HELP/START replies, delivery reports, billing reconciliation and public pages. A text the provider already accepted cannot be recalled."}
      </p>
      <TextInput value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason (recorded and shown to staff)" required />
      <div>
        <Button type="submit" size="sm" variant={stopped ? "primary" : "destructive"} loading={busy}>
          {stopped ? "Resume outbound" : "Stop outbound now"}
        </Button>
      </div>
    </form>
  );
}
