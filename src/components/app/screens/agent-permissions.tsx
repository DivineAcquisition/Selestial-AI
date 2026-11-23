"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useId, useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, FormError, TextInput, useRun } from "@/components/app/form";
import { Select } from "@/components/ui/selection";
import { ArrowRight, ChevronDown, HistoryIcon, Info, PauseCircleIcon, Play } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MoneyField } from "@/components/ui/fields";
import { Skeleton } from "@/components/ui/skeleton";
import { centsFrom, clock, longDay, money, zonedInstant } from "@/lib/app/format";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import { ActionHistory, AgentSummary, ControlHistory, Overview, Presets, RoutingEditor, TestRules, type Workspace } from "./agent-controls";

/** The four permission levels, in the owner's words. The ids are the permission engine's and do not change. */
export const LEVELS = [
  { id: "off", label: "Off", meaning: "The agent never does this." },
  { id: "propose", label: "Ask me first", meaning: "The agent prepares it. You approve, change or skip it." },
  { id: "execute_and_report", label: "Act and notify me", meaning: "The agent does it and tells you each time." },
  { id: "execute", label: "Act automatically", meaning: "The agent does it. You can see it in Activity." },
] as const;
type Level = (typeof LEVELS)[number]["id"];
const rank = (level: string) => LEVELS.findIndex((row) => row.id === level);
export const levelLabel = (level: string) => LEVELS[rank(level)]?.label ?? "Off";

type StatusKind = "ready" | "approval_required" | "setup_required" | "paused" | "limit_reached" | "unavailable" | "off";

/**
 * One action as `api.permissions.list` returns it. The fields after `changed` are the effective status the
 * server works out with the checks execution uses; callers that pass an older shape still render.
 */
export type Action = {
  key: string;
  label: string;
  level: Level;
  ceiling: Level;
  standard: Level;
  money: boolean;
  perActionCents: number | null;
  perDayCents: number | null;
  changed: boolean;
  agent?: string;
  until?: number | null;
  implemented?: boolean;
  unavailable?: string | null;
  note?: string | null;
  measures?: string | null;
  status?: { status: StatusKind; words: string; reason: string; next: { label: string; href: string } | null; expired: boolean };
  allowance?: { day: string; usedCents: number; committedCents: number; reservedCents: number; resetsAt: number; perDayCents: number; perActionCents: number | null } | null;
  approvers?: { words: string; people: { memberId: string; name: string; role: string }[]; warning: string | null };
  ownerDecides?: boolean;
};

const TONE: Record<StatusKind, "success" | "info" | "warning" | "outline" | "error"> = {
  ready: "success",
  approval_required: "info",
  setup_required: "warning",
  paused: "outline",
  limit_reached: "warning",
  unavailable: "outline",
  off: "outline",
};

export function StatusBadge({ status, words }: { status: StatusKind; words: string }) {
  return (
    <Badge variant={TONE[status]} size="sm">
      {words}
    </Badge>
  );
}

const link = "font-medium text-brand-600 underline-offset-2 hover:underline";

/** What raising an action would change, from the server, with the revision the change is applied against. */
function RaisePreview({ action, level, perActionCents, perDayCents, until, onDone, onCancel }: { action: Action; level: Level; perActionCents?: number; perDayCents?: number; until?: number; onDone: () => void; onCancel: () => void }) {
  const { companyId } = useCompany();
  const preview = useQuery(api.permissions.previewChange, { companyId, action: action.key, level, ...(perActionCents !== undefined ? { perActionCents } : {}), ...(perDayCents !== undefined ? { perDayCents } : {}), ...(until !== undefined ? { until } : {}) });
  const set = useMutation(api.permissions.set);
  const { busy, error, run } = useRun();
  if (!preview) return <Skeleton className="h-24 rounded-xl" />;
  return (
    <div className="grid gap-2 text-sm" aria-live="polite">
      <p className="font-medium text-strong">
        {preview.from} → {preview.to}
      </p>
      {preview.refused ? <p className="text-destructive-foreground">{preview.refused}</p> : null}
      {preview.enabling ? <p className="text-strong">{preview.enabling}</p> : null}
      {preview.conditions.length ? (
        <ul className="grid list-disc gap-1 pl-5 text-xs text-muted-foreground">
          {preview.conditions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-strong">After the change: {preview.after.words}.</span> {preview.after.reason}{" "}
        {preview.after.next ? (
          <Link href={preview.after.next.href} className={link}>
            {preview.after.next.label}
          </Link>
        ) : null}
      </p>
      {preview.eligible.map((row) => (
        <div key={row.words} className="text-xs text-muted-foreground">
          <span className="font-medium text-strong">{row.count}</span> {row.words}
          {row.examples.length ? (
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {row.examples.map((example) => (
                <li key={example.href}>
                  <Link href={example.href} className={link}>
                    {example.label}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{preview.pending.words}</p>
      <p className="text-xs text-muted-foreground">{preview.drafts}</p>
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="primary"
          size="sm"
          loading={busy}
          disabled={Boolean(preview.refused)}
          onClick={() =>
            void run(async () => {
              await set({ companyId, action: action.key, level, ...(perActionCents !== undefined ? { perActionCents } : {}), ...(perDayCents !== undefined ? { perDayCents } : {}), until: until ?? null, expectedRevision: preview.revision });
              onDone();
            })
          }
        >
          Confirm: {preview.to}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * One action's permission, with its effective status, why, and the next step. Only the Owner changes it,
 * never past its ceiling. Lowering applies at once; raising shows what it would change first and is applied
 * against the settings that preview was made from.
 */
export function PermissionRow({ action, canEdit, rule, revision, onHistory }: { action: Action; canEdit: boolean; rule?: { words: string; href: string }; revision?: number; onHistory?: () => void }) {
  const { companyId, timezone } = useCompany();
  const set = useMutation(api.permissions.set);
  const { busy, error, run, setError } = useRun();
  const [draft, setDraft] = useState<Level | null>(null);
  const [step, setStep] = useState<"limits" | "preview">("limits");
  const [saved, setSaved] = useState(false);
  const [perAction, setPerAction] = useState(action.perActionCents !== null ? (action.perActionCents / 100).toFixed(2) : "");
  const [perDay, setPerDay] = useState(action.perDayCents !== null ? (action.perDayCents / 100).toFixed(2) : "");
  const [untilDate, setUntilDate] = useState("");
  const [untilTime, setUntilTime] = useState("18:00");
  const [details, setDetails] = useState(false);
  const id = useId();
  const unavailable = action.implemented === false;
  const lower = (level: Level) =>
    run(async () => {
      await set({ companyId, action: action.key, level, ...(revision !== undefined ? { expectedRevision: revision } : {}) });
      setDraft(null);
      setSaved(true);
    });
  const limits = action.money ? { perActionCents: centsFrom(perAction) ?? undefined, perDayCents: centsFrom(perDay) ?? undefined } : {};
  const until = untilDate ? (zonedInstant(untilDate, untilTime, timezone) ?? undefined) : undefined;
  const spends = action.money && action.perActionCents !== null && action.perDayCents !== null && rank(action.level) > rank("propose");
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-full text-sm text-strong sm:basis-auto">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span id={`${id}-label`}>{action.label}</span>
            {action.status ? <StatusBadge status={action.status.status} words={action.status.words} /> : null}
          </span>
          {action.status ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {action.status.reason}{" "}
              {action.status.next && !(action.status.status === "paused" && action.status.next.href === "/app/settings/agents") ? (
                <Link href={action.status.next.href} className={link}>
                  {action.status.next.label}
                </Link>
              ) : null}
            </span>
          ) : action.ceiling === "propose" ? (
            <span className="block text-xs text-muted-foreground">Always needs your approval.</span>
          ) : (
            <span className="block text-xs text-muted-foreground">{LEVELS[rank(action.level)]?.meaning}</span>
          )}
          {spends ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Up to {money(action.perActionCents!)} each time and {money(action.perDayCents!)} a day without asking
              {action.allowance ? `; ${money(action.allowance.usedCents)} used today, resetting ${longDay(action.allowance.resetsAt, timezone)} at ${clock(action.allowance.resetsAt, timezone)}` : ""}. Anything more needs approval.
            </span>
          ) : null}
          {action.until && rank(action.level) > rank("propose") && !action.status?.expired ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Temporary: back to Ask me first on {longDay(action.until, timezone)} at {clock(action.until, timezone)}.
            </span>
          ) : null}
          {rule ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              <span className="font-medium text-strong">Rule:</span> {rule.words}{" "}
              <Link href={rule.href} className={link}>
                Edit in the playbook
              </Link>
            </span>
          ) : null}
        </div>
        {canEdit && !unavailable ? (
          <span className="flex w-full items-center gap-2 sm:w-auto">
            {saved && !busy && !error ? (
              <span role="status" className="text-xs text-success">
                Saved
              </span>
            ) : null}
            <Select
              aria-labelledby={`${id}-label`}
              aria-describedby={`${id}-effect`}
              className="w-full sm:w-auto sm:min-w-52"
              disabled={busy}
              value={draft ?? action.level}
              // Levels past the ceiling stay in the list, disabled with the reason, so the owner sees why they can't be chosen.
              options={LEVELS.map((level) => ({ value: level.id, label: level.label, description: level.meaning, ...(rank(level.id) > rank(action.ceiling) ? { disabled: true, disabledReason: `Not allowed for this action. The most it can do is “${levelLabel(action.ceiling)}”.` } : {}) }))}
              onValueChange={(level) => {
                if (!level || level === action.level) return setDraft(null);
                setSaved(false);
                setError(null);
                // Less authority applies at once. More authority is previewed first.
                if (rank(level) < rank(action.level)) return void lower(level);
                setDraft(level);
                setStep(action.money && rank(level) > rank("propose") ? "limits" : "preview");
              }}
            />
            <span id={`${id}-effect`} className="sr-only">
              {LEVELS[rank(draft ?? action.level)]?.meaning} Lowering applies as soon as you choose. Raising shows what it would change before you confirm.
            </span>
          </span>
        ) : (
          <span className="rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-strong">{unavailable ? "Not available" : levelLabel(action.level)}</span>
        )}
      </div>
      {draft ? (
        <div className="mt-2 grid gap-3 rounded-xl border border-border bg-muted p-3">
          {step === "limits" ? (
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const [a, d] = [centsFrom(perAction), centsFrom(perDay)];
                if (a === null || d === null) return setError("Enter both limits as dollar amounts, like 50 or 50.00.");
                if (d < a) return setError("The daily limit can't be less than the limit for one action.");
                setError(null);
                setStep("preview");
              }}
            >
              <p className="text-sm text-strong">This action spends money. Choose how much the agent may spend without asking. Anything over these amounts waits for approval.</p>
              {action.measures ? <p className="text-xs text-muted-foreground">What counts: {action.measures}</p> : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Most for one action ($)">
                  <MoneyField value={perAction} onChange={(text) => setPerAction(text)} placeholder="50.00" required />
                </Field>
                <Field label="Most in one day ($)" hint="Your company's calendar day. It resets at midnight.">
                  <MoneyField value={perDay} onChange={(text) => setPerDay(text)} placeholder="200.00" required />
                </Field>
              </div>
              <FormError message={error} />
              <div className="flex gap-2">
                <Button type="submit" variant="primary" size="sm">
                  Review the change
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <>
              {rank(draft) > rank("propose") ? (
                <fieldset className="grid gap-2 sm:grid-cols-[1fr_1fr] sm:items-end">
                  <legend className="mb-1 text-xs text-muted-foreground">Optional: make it temporary. After this time it asks first again.</legend>
                  <Field label="Until (date)">
                    <TextInput type="date" value={untilDate} onChange={(event) => setUntilDate(event.target.value)} />
                  </Field>
                  <Field label="Time">
                    <TextInput type="time" value={untilTime} onChange={(event) => setUntilTime(event.target.value)} />
                  </Field>
                </fieldset>
              ) : null}
              <RaisePreview
                action={action}
                level={draft}
                {...limits}
                until={until}
                onDone={() => {
                  setDraft(null);
                  setSaved(true);
                }}
                onCancel={() => setDraft(null)}
              />
            </>
          )}
        </div>
      ) : null}
      <FormError message={draft ? null : error} />
      {action.approvers || action.note || onHistory ? (
        <div className="mt-1.5">
          <button type="button" aria-expanded={details} onClick={() => setDetails((value) => !value)} className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-strong focus-visible:outline-2 focus-visible:outline-brand-500">
            <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", details && "rotate-180")} />
            Who decides, reports and history
          </button>
          {details ? (
            <div className="mt-2 grid gap-2 rounded-lg border border-border px-3 py-2.5 text-xs text-muted-foreground">
              {action.note ? <p>{action.note}</p> : null}
              {action.approvers ? (
                <div>
                  <p>
                    <span className="font-medium text-strong">Who can approve:</span> {action.approvers.words}
                    {action.approvers.people.length ? ` (${action.approvers.people.map((p) => p.name).join(", ")})` : ""}.
                  </p>
                  {action.approvers.warning ? <p className="text-warning-foreground">{action.approvers.warning}</p> : null}
                  <p>Each request has its own deadline. If nobody decides by then it expires and nothing is done: silence is never approval.</p>
                  {canEdit && !unavailable ? <RoutingEditor action={action} revision={revision} /> : null}
                </div>
              ) : null}
              {onHistory ? (
                <button type="button" onClick={onHistory} className={cn("flex items-center gap-1 justify-self-start", link)}>
                  <HistoryIcon aria-hidden className="size-3.5" />
                  Settings changes and what happened under them
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Agent Controls: the company overview, then each agent's summary, its actions and boundaries, a place to
 * test the rules, and the history of changes. Only the Owner changes anything here.
 */
export function AgentPermissions() {
  const { companyId, role } = useCompany();
  const workspace = useQuery(api.controls.workspace, { companyId });
  const permissions = useQuery(api.permissions.list, { companyId });
  const pauseAgent = useMutation(api.companies.pauseAgent);
  const resumeAgent = useMutation(api.companies.resumeAgent);
  const pauseAll = useMutation(api.companies.pauseAll);
  const resumeAll = useMutation(api.companies.setPausedAgents);
  const { busy, error, run } = useRun();
  const [history, setHistory] = useState<string | null>(null);
  if (!workspace || !permissions) return <Skeleton className="h-64 rounded-2xl" />;
  const owner = workspace.canEdit;
  const manages = role === "owner" || role === "manager";
  const allPaused = workspace.overview.paused === workspace.agents.length;
  return (
    <div className="grid gap-6">
      <section aria-labelledby="controls-overview" className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="controls-overview" className="font-heading text-lg tracking-tight text-strong">
              Agent Controls
            </h2>
            <p className="text-sm text-muted-foreground">What each agent may do, whether it can right now, and what happened under each setting.</p>
          </div>
          {owner ? (
            <Button variant="outline" size="sm" loading={busy} onClick={() => void run(() => (allPaused ? resumeAll({ companyId, agents: [], expectedRevision: workspace.revision }) : pauseAll({ companyId })))}>
              {allPaused ? <Play aria-hidden /> : <PauseCircleIcon aria-hidden />}
              {allPaused ? "Resume all agents" : "Pause all agents"}
            </Button>
          ) : null}
        </div>
        <FormError message={error} />
        <Overview workspace={workspace} />
      </section>

      {owner ? <Presets workspace={workspace} /> : null}

      <section aria-labelledby="your-agents" className="grid gap-3">
        <h2 id="your-agents" className="font-heading text-lg tracking-tight text-strong">
          Agents, actions and boundaries
        </h2>
        <details className="rounded-xl border border-border bg-card px-4 py-2.5 text-sm">
          <summary className="cursor-pointer font-medium text-strong">What pausing does</summary>
          <ul className="mt-2 grid list-disc gap-1 pl-5 text-muted-foreground">
            <li>A paused agent starts nothing new and sends nothing. A message it had planned is stopped at the moment it would have gone.</li>
            <li>Incoming texts and emails are still received, opt-outs (STOP) are still honored, delivery reports still arrive, and billing still settles.</li>
            <li>You and your team can still send messages and work every record yourselves.</li>
            <li>A message the provider already accepted before you paused can&rsquo;t be recalled.</li>
            <li>Resuming doesn&rsquo;t send a pile of old messages: what was stopped stays stopped, and each piece of new work is checked again against the current settings.</li>
          </ul>
        </details>
        <ul className="grid gap-3">
          {workspace.agents.map((agent) => (
            <AgentSummary
              key={agent.agent}
              agent={agent}
              owner={owner}
              busy={busy}
              onTogglePause={() => void run(() => (agent.paused ? resumeAgent({ companyId, agent: agent.agent }) : pauseAgent({ companyId, agent: agent.agent })))}
            >
              <ul className="divide-y divide-border">
                {(permissions.actions as Action[])
                  .filter((action) => action.agent === agent.agent)
                  .sort((a, b) => Number(a.implemented === false) - Number(b.implemented === false))
                  .map((action) => (
                    <PermissionRow
                      key={`${action.key}:${action.level}:${action.perActionCents}:${action.perDayCents}:${action.until}:${permissions.revision}`}
                      action={action}
                      canEdit={owner}
                      rule={workspace.rules[action.key]}
                      revision={permissions.revision}
                      onHistory={manages ? () => setHistory(action.key) : undefined}
                    />
                  ))}
              </ul>
            </AgentSummary>
          ))}
        </ul>
      </section>

      <section aria-labelledby="reports" className="grid gap-2 rounded-2xl border border-border bg-card p-4 text-sm sm:p-5">
        <h2 id="reports" className="font-heading text-base tracking-tight text-strong">
          Who is told when an agent acts
        </h2>
        <p className="text-muted-foreground">
          For actions set to &ldquo;Act and notify me&rdquo;, each report goes by {workspace.reports.channel.charAt(0).toLowerCase() + workspace.reports.channel.slice(1)}, once per step, so a retry doesn&rsquo;t send it twice.
        </p>
        <p className="text-muted-foreground">
          <span className="font-medium text-strong">Receiving reports:</span> {workspace.reports.on.length ? workspace.reports.on.join(", ") : "nobody"}.
          {workspace.reports.off.length ? (
            <>
              {" "}
              <span className="font-medium text-warning-foreground">Turned off by:</span> {workspace.reports.off.join(", ")}.
            </>
          ) : null}
        </p>
        {workspace.reports.on.length === 0 ? <p className="text-warning-foreground">Nobody will get these reports. Agents still act, and their work is in Activity.</p> : null}
        <p>
          <Link href={workspace.reports.settings} className={cn("inline-flex items-center gap-1", link)}>
            Notification preferences <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </p>
      </section>

      {manages ? <TestRules /> : null}
      {manages ? <ControlHistory owner={owner} /> : null}

      <details className="group rounded-2xl border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-strong focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500 sm:px-5 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            <Info aria-hidden className="size-4 text-muted-foreground" />
            What the permission choices mean, and what always needs a person
          </span>
          <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="grid gap-4 border-t border-border px-4 py-4 sm:px-5">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {LEVELS.map((level) => (
              <div key={level.id}>
                <dt className="font-medium text-strong">{level.label}</dt>
                <dd className="text-xs leading-relaxed text-muted-foreground">{level.meaning}</dd>
              </div>
            ))}
          </dl>
          <div>
            <h3 className="text-sm font-semibold text-strong">Always done by a person, whatever you choose</h3>
            <ul className="mt-1.5 grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
              {permissions.personOnly.map((row) => (
                <li key={row.key} className="flex gap-2">
                  <span aria-hidden>·</span>
                  {row.label}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              One opt-in exception: Recruiter may decline an applicant who doesn&rsquo;t meet a requirement you marked fixed and published, decided from their answers and never on judgment, only if you choose that. Have counsel review it, and the wording of your Terms and Security Overview, before you turn it on.
            </p>
          </div>
        </div>
      </details>

      <ActionHistory action={history} onClose={() => setHistory(null)} />
    </div>
  );
}

export type { Workspace };
