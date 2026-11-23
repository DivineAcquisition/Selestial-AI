"use client";

/**
 * The parts of Agent Controls around the permission rows: the overview, each agent's summary, presets,
 * approval routing, "Test these rules", and the history of changes with restore. Everything shown is read
 * from records; nothing is estimated or decorative.
 */
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useId, useState } from "react";

import { AgentAvatar, AGENT_NAME } from "@/components/app/agent";
import { useCompany } from "@/components/app/company";
import { Field, FormError, useRun } from "@/components/app/form";
import { Modal } from "@/components/app/modal";
import { useNow } from "@/components/app/use-now";
import { ChevronDown, PauseCircleIcon, Play } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/selection";
import { Skeleton } from "@/components/ui/skeleton";
import { ago, clock, longDay, money, whenLabel } from "@/lib/app/format";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { Action } from "./agent-permissions";

export type Workspace = FunctionReturnType<typeof api.controls.workspace>;
type AgentRow = Workspace["agents"][number];

const link = "font-medium text-brand-600 underline-offset-2 hover:underline";

// ── Overview ─────────────────────────────────────────────────────────────────────────────────────

export function Overview({ workspace }: { workspace: Workspace }) {
  const o = workspace.overview;
  const cells: { label: string; value: number; href?: string; attention?: boolean }[] = [
    { label: "Agents working", value: o.working },
    { label: "Paused", value: o.paused, attention: o.paused > 0 },
    { label: "Actions needing setup", value: o.setupRequired, attention: o.setupRequired > 0 },
    { label: "Daily limits reached", value: o.limitReached, attention: o.limitReached > 0 },
    { label: "Waiting for approval", value: o.awaitingApproval, href: "/app/approvals" },
    { label: "Past their deadline", value: o.overdueApproval, href: "/app/approvals", attention: o.overdueApproval > 0 },
  ];
  return (
    <div className="grid gap-2">
      {workspace.suspended ? <p className="rounded-xl border border-warning/30 bg-warning/8 px-3 py-2 text-sm text-warning-foreground">Selestial has suspended this company&rsquo;s outbound activity. No agent sends anything until it is lifted.</p> : null}
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {cells.map((cell) => (
          <div key={cell.label} className="rounded-xl border border-border bg-card px-3 py-2.5">
            <dt className="text-xs text-muted-foreground">{cell.label}</dt>
            <dd className={cn("font-heading text-xl tabular-nums text-strong", cell.attention && "text-warning-foreground")}>
              {cell.href && cell.value > 0 ? (
                <Link href={cell.href} className="underline-offset-2 hover:underline">
                  {cell.value}
                </Link>
              ) : (
                cell.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ── One agent ────────────────────────────────────────────────────────────────────────────────────

export function AgentSummary({ agent, owner, busy, onTogglePause, children }: { agent: AgentRow; owner: boolean; busy: boolean; onTogglePause: () => void; children: React.ReactNode }) {
  const { timezone } = useCompany();
  const [open, setOpen] = useState(false);
  const panel = useId();
  const now = useNow();
  const l = agent.levels;
  return (
    <li className="rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-start gap-3 p-4 sm:p-5">
        <AgentAvatar agent={agent.agent} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-strong">{AGENT_NAME[agent.agent]}</h3>
            {agent.paused ? (
              <Badge variant="outline" size="sm">
                Paused
              </Badge>
            ) : null}
            {!agent.plan.ok ? (
              <Badge variant="warning" size="sm">
                Not on your plan
              </Badge>
            ) : null}
            {agent.setupRequired ? (
              <Badge variant="warning" size="sm">
                {agent.setupRequired} need setup
              </Badge>
            ) : null}
            {agent.limitReached ? (
              <Badge variant="warning" size="sm">
                Limit reached
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{agent.responsibility}</p>
          {!agent.plan.ok && agent.plan.words ? <p className="mt-1 text-xs text-muted-foreground">{agent.plan.words}</p> : null}
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <div>
              <dt className="inline text-muted-foreground">Settings: </dt>
              <dd className="inline text-strong">
                {l.execute} automatic, {l.execute_and_report} act and notify, {l.propose} ask first, {l.off} off{agent.unavailable ? `; ${agent.unavailable} not available` : ""}
              </dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Work: </dt>
              <dd className="inline text-strong">
                {agent.work.open} open, {agent.work.waiting} waiting on someone, {agent.work.withPerson} with a person
                {agent.awaitingApproval ? (
                  <>
                    ,{" "}
                    <Link href="/app/approvals" className={link}>
                      {agent.awaitingApproval} awaiting approval
                    </Link>
                  </>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Last finished: </dt>
              <dd className="inline text-strong">{agent.lastResult ? `${agent.lastResult.outcome ?? agent.lastResult.title} (${ago(agent.lastResult.at, now, timezone)})` : "Nothing yet"}</dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Next: </dt>
              <dd className="inline text-strong">{agent.next ? `${agent.next.title}, due ${whenLabel(agent.next.dueAt, now, timezone)}` : "Nothing scheduled"}</dd>
            </div>
          </dl>
          <p className="mt-1.5 text-xs">
            <Link href={agent.playbook} className={link}>
              Open the {AGENT_NAME[agent.agent]} playbook
            </Link>
          </p>
        </div>
        {owner ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={onTogglePause}>
            {agent.paused ? <Play aria-hidden /> : <PauseCircleIcon aria-hidden />}
            {agent.paused ? "Resume" : "Pause"}
          </Button>
        ) : null}
      </div>
      <div className="border-t border-border">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500 sm:px-5"
        >
          <span className="font-medium text-strong">Actions and boundaries</span>
          <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
        {open ? (
          <div id={panel} className="px-4 pb-2 sm:px-5">
            {owner ? <p className="pb-1 text-xs text-muted-foreground">Lowering a level applies at once. Raising one shows what it would change before you confirm.</p> : null}
            {children}
          </div>
        ) : null}
      </div>
    </li>
  );
}

// ── Presets ──────────────────────────────────────────────────────────────────────────────────────

const PRESETS = [
  { id: "review_first", label: "Review first", words: "Everything a customer, cleaner or applicant would see asks you first." },
  { id: "routine", label: "Routine work delegated", words: "Reminders, confirmations and follow-ups run on their own; anything with money or judgment still asks." },
] as const;

export function Presets({ workspace }: { workspace: Workspace }) {
  const { companyId } = useCompany();
  const [chosen, setChosen] = useState<"review_first" | "routine" | null>(null);
  const preview = useQuery(api.permissions.presetPreview, chosen ? { companyId, preset: chosen } : "skip");
  const apply = useMutation(api.permissions.applyPreset);
  const { busy, error, run } = useRun();
  const current = workspace.preset;
  return (
    <section aria-labelledby="presets" className="grid gap-2 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <h2 id="presets" className="font-heading text-base tracking-tight text-strong">
        Starting point
      </h2>
      <p className="text-sm text-muted-foreground">
        Your settings now match: <span className="font-medium text-strong">{current === "custom" ? "Custom" : PRESETS.find((p) => p.id === current)?.label}</span>. A preset is a shortcut for the same settings below; you see every change before it applies.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {PRESETS.map((preset) => (
          <div key={preset.id} className={cn("grid gap-1 rounded-xl border px-3 py-2.5", current === preset.id ? "border-brand-500/50" : "border-border")}>
            <span className="text-sm font-medium text-strong">{preset.label}</span>
            <span className="text-xs text-muted-foreground">{preset.words}</span>
            <Button variant="outline" size="sm" className="mt-1 justify-self-start" onClick={() => setChosen(preset.id)} disabled={current === preset.id}>
              {current === preset.id ? "In use" : "Preview"}
            </Button>
          </div>
        ))}
      </div>
      <Modal open={chosen !== null} onClose={() => setChosen(null)} title={chosen ? `Apply ${PRESETS.find((p) => p.id === chosen)?.label}` : ""} description="Nothing changes until you apply.">
        {!preview ? (
          <Skeleton className="h-32 rounded-xl" />
        ) : (
          <div className="grid gap-3 text-sm">
            {preview.changes.length ? (
              <div>
                <h3 className="font-medium text-strong">Will change ({preview.changes.length})</h3>
                <ul className="mt-1 grid gap-1 text-xs text-muted-foreground">
                  {preview.changes.map((row) => (
                    <li key={row.action}>
                      <span className="text-strong">{row.label}</span> ({AGENT_NAME[row.agent as keyof typeof AGENT_NAME]}): {levelWords(row.from)} → {levelWords(row.to)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-muted-foreground">Nothing would change.</p>
            )}
            {preview.kept.length ? (
              <div>
                <h3 className="font-medium text-strong">Left as they are</h3>
                <ul className="mt-1 grid gap-1 text-xs text-muted-foreground">
                  {preview.kept.map((row) => (
                    <li key={row.action}>
                      <span className="text-strong">{row.label}</span>: {row.why}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">{preview.unchanged}</p>
            <FormError message={error} />
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                disabled={!preview.changes.length}
                onClick={() =>
                  void run(async () => {
                    await apply({ companyId, preset: chosen!, expectedRevision: preview.revision });
                    setChosen(null);
                  })
                }
              >
                Apply {preview.changes.length} change{preview.changes.length === 1 ? "" : "s"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setChosen(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}

const LEVEL_WORDS: Record<string, string> = { off: "Off", propose: "Ask me first", execute_and_report: "Act and notify me", execute: "Act automatically" };
const levelWords = (level: string) => LEVEL_WORDS[level] ?? level;

// ── Who decides ──────────────────────────────────────────────────────────────────────────────────

export function RoutingEditor({ action, revision }: { action: Action; revision?: number }) {
  const { companyId } = useCompany();
  const members = useQuery(api.members.list, { companyId });
  const setRouting = useMutation(api.permissions.setRouting);
  const { busy, error, run } = useRun();
  const [choice, setChoice] = useState<string | null>(null);
  const [backup, setBackup] = useState<string | null>(null);
  if (action.ownerDecides) return <p className="mt-1">Only an Owner decides this, always. That can&rsquo;t be changed.</p>;
  if (!members) return null;
  const deciders = members.filter((m) => m.status === "active" && (m.role === "owner" || m.role === "manager"));
  const options = [{ value: "any", label: "Any Owner or Manager" }, { value: "owner", label: "Owners only" }, ...deciders.map((m) => ({ value: m.id, label: `${m.name} (${m.role === "owner" ? "Owner" : "Manager"}), with any Owner` }))];
  const person = choice && choice !== "any" && choice !== "owner";
  return (
    <form
      className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        if (!choice) return;
        void run(async () => {
          await setRouting({ companyId, action: action.key, approver: choice === "any" ? null : choice === "owner" ? { kind: "owner" } : { kind: "member", memberId: choice as Id<"members"> }, backupMemberId: person && backup ? (backup as Id<"members">) : null, ...(revision !== undefined ? { expectedRevision: revision } : {}) });
          setChoice(null);
        });
      }}
    >
      <Field label="Change who decides">
        <Select value={choice} onValueChange={(value) => setChoice(value)} options={options} placeholder="Choose…" />
      </Field>
      {person ? (
        <Field label="Backup (optional)">
          <Select value={backup} onValueChange={(value) => setBackup(value)} options={deciders.filter((m) => m.id !== choice).map((m) => ({ value: m.id, label: m.name }))} emptyLabel="No backup" />
        </Field>
      ) : (
        <span />
      )}
      <Button type="submit" variant="outline" size="sm" loading={busy} disabled={!choice}>
        Save
      </Button>
      <div className="sm:col-span-3">
        <FormError message={error} />
      </div>
    </form>
  );
}

// ── Test these rules ─────────────────────────────────────────────────────────────────────────────

const SCENARIOS = [
  { id: "cleaner_declines", label: "A cleaner declines tomorrow's visit" },
  { id: "quote_unanswered", label: "A lead hasn't answered a quote" },
  { id: "applicant_missing_info", label: "An applicant is missing information" },
  { id: "correction_visit", label: "A customer asks for a correction visit" },
] as const;
type Scenario = (typeof SCENARIOS)[number]["id"];

const DECISION_TONE = { act: "success", act_and_notify: "success", ask: "info", refuse: "warning" } as const;
const DECISION_WORDS = { act: "Would act", act_and_notify: "Would act and notify", ask: "Would ask first", refuse: "Would not act" } as const;

export function TestRules() {
  const { companyId } = useCompany();
  const [scenario, setScenario] = useState<Scenario>("cleaner_declines");
  const [record, setRecord] = useState<string | null>(null);
  const [ran, setRan] = useState<{ scenario: Scenario; recordId?: string } | null>(null);
  const records = useQuery(api.controls.scenarioRecords, { companyId, scenario });
  const result = useQuery(api.controls.simulate, ran ? { companyId, ...ran } : "skip");
  return (
    <section aria-labelledby="test-rules" className="grid gap-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div>
        <h2 id="test-rules" className="font-heading text-base tracking-tight text-strong">
          Test these rules
        </h2>
        <p className="text-sm text-muted-foreground">See what an agent would do under today&rsquo;s settings. It uses the same checks as live work. Nothing is sent, assigned, charged or changed.</p>
      </div>
      <form
        className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          setRan({ scenario, ...(record ? { recordId: record } : {}) });
        }}
      >
        <Field label="Situation">
          <Select
            value={scenario}
            onValueChange={(value) => {
              if (!value) return;
              setScenario(value);
              setRecord(null);
            }}
            options={SCENARIOS.map((s) => ({ value: s.id, label: s.label }))}
          />
        </Field>
        <Field label="Run it against">
          <Select value={record} onValueChange={(value) => setRecord(value)} options={(records?.records ?? []).map((r) => ({ value: r.id, label: r.label }))} emptyLabel="A labeled sample" loading={records === undefined} emptyText="No matching records; a sample is used." />
        </Field>
        <Button type="submit" variant="primary" size="sm">
          Run test
        </Button>
      </form>
      {ran && result === undefined ? <Skeleton className="h-32 rounded-xl" /> : null}
      {result ? (
        <div className="grid gap-2 rounded-xl border border-dashed border-border p-3 text-sm" aria-live="polite">
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" size="sm">
              Hypothetical
            </Badge>
            {result.sample ? (
              <Badge variant="outline" size="sm">
                Sample scenario
              </Badge>
            ) : null}
            <span className="font-medium text-strong">{result.words}</span>
            {result.record ? (
              <Link href={result.record.href} className={cn("text-xs", link)}>
                {result.record.label}
              </Link>
            ) : null}
          </p>
          {result.story.map((line) => (
            <p key={line} className="text-muted-foreground">
              {line}
            </p>
          ))}
          {result.steps.map((step) => (
            <div key={step.action} className="grid gap-1 rounded-lg bg-muted px-3 py-2">
              <p className="flex flex-wrap items-center gap-2">
                <Badge variant={DECISION_TONE[step.decision]} size="sm">
                  {DECISION_WORDS[step.decision]}
                </Badge>
                <span className="text-strong">{step.label}</span>
                <span className="text-xs text-muted-foreground">Setting: {step.setting}</span>
              </p>
              <p className="text-xs text-muted-foreground">{step.decisionWords}</p>
              {step.rule ? (
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-strong">Rule:</span> {step.rule.words}{" "}
                  <Link href={step.rule.href} className={link}>
                    Playbook
                  </Link>
                </p>
              ) : null}
              {step.approvers ? <p className="text-xs text-muted-foreground">Decided by: {step.approvers}.</p> : null}
              {step.missing.map((m) => (
                <p key={m.words} className="text-xs text-warning-foreground">
                  Missing: {m.words}{" "}
                  {m.next ? (
                    <Link href={m.next.href} className={link}>
                      {m.next.label}
                    </Link>
                  ) : null}
                </p>
              ))}
            </div>
          ))}
          {result.cost ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-strong">Cost:</span> {result.cost.cents !== null ? `${money(result.cost.cents)}. ` : ""}
              {result.cost.words}
            </p>
          ) : null}
          {result.next ? (
            <p className="text-xs">
              Next step:{" "}
              <Link href={result.next.href} className={link}>
                {result.next.label}
              </Link>
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">{result.note}</p>
        </div>
      ) : null}
    </section>
  );
}

// ── History and restore ──────────────────────────────────────────────────────────────────────────

const KIND_WORDS: Record<string, string> = { permission: "Level", routing: "Who decides", preset: "Preset", restore: "Restore", pause: "Pause", resume: "Resume", expired: "Temporary level ended" };

export function ControlHistory({ owner }: { owner: boolean }) {
  const { companyId, timezone } = useCompany();
  const changes = useQuery(api.permissions.changes, { companyId, limit: 20 });
  const [restoring, setRestoring] = useState<number | null>(null);
  const preview = useQuery(api.permissions.restorePreview, owner && restoring !== null ? { companyId, revision: restoring } : "skip");
  const restore = useMutation(api.permissions.restore);
  const { busy, error, run } = useRun();
  return (
    <section aria-labelledby="control-history" className="grid gap-2 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <h2 id="control-history" className="font-heading text-base tracking-tight text-strong">
        History of changes
      </h2>
      {!changes ? (
        <Skeleton className="h-24 rounded-xl" />
      ) : changes.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No changes yet. Every change to these settings will be listed here, with who made it.</p>
      ) : (
        <ol className="divide-y divide-border text-sm">
          {changes.rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="text-strong">{row.summary}</span>
                <span className="block text-xs text-muted-foreground">
                  {KIND_WORDS[row.kind] ?? row.kind} · {row.by} · {longDay(row.at, timezone)} at {clock(row.at, timezone)}
                </span>
              </span>
              {owner && row.kind !== "pause" && row.kind !== "resume" ? (
                <Button variant="ghost" size="sm" onClick={() => setRestoring(row.revision)}>
                  Restore settings from before this
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <Modal open={restoring !== null} onClose={() => setRestoring(null)} title="Restore previous settings" description="Nothing changes until you confirm.">
        {!preview ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : (
          <div className="grid gap-3 text-sm">
            <p className="text-strong">{preview.restoring}</p>
            {preview.changes.length ? (
              <ul className="grid gap-1 text-xs text-muted-foreground">
                {preview.changes.map((row) => (
                  <li key={row.action}>
                    <span className="text-strong">{row.label}</span>: {row.from} → {row.to}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">The settings already match; nothing would change.</p>
            )}
            {preview.refused.length ? (
              <div>
                <h3 className="text-xs font-medium text-strong">Can&rsquo;t be restored</h3>
                <ul className="grid gap-1 text-xs text-muted-foreground">
                  {preview.refused.map((row) => (
                    <li key={row.action}>
                      {row.label}: {row.why}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ul className="grid list-disc gap-1 pl-5 text-xs text-muted-foreground">
              {preview.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <FormError message={error} />
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                disabled={!preview.changes.length}
                onClick={() =>
                  void run(async () => {
                    await restore({ companyId, revision: restoring!, expectedRevision: preview.revision });
                    setRestoring(null);
                  })
                }
              >
                Restore
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRestoring(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}

const STAGE_WORDS: Record<string, string> = { prepared: "Prepared (nothing sent)", queued: "Queued to send", submitted: "Accepted by the provider", delivered: "Delivered", completed: "Completed" };

/** One action's settings and what happened under them. */
export function ActionHistory({ action, onClose }: { action: string | null; onClose: () => void }) {
  const { companyId, timezone } = useCompany();
  const history = useQuery(api.controls.actionHistory, action ? { companyId, action } : "skip");
  const when = (at: number) => `${longDay(at, timezone)} at ${clock(at, timezone)}`;
  return (
    <Modal open={action !== null} onClose={onClose} title={history?.label ?? "History"} description="Settings, approvals and work done under them. Counts are of records, not estimates.">
      {!history ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (
        <div className="grid gap-4 text-sm">
          <div>
            <h3 className="font-medium text-strong">Now</h3>
            <p className="text-xs text-muted-foreground">
              {history.setting.words}
              {history.setting.perActionCents !== null && history.setting.perDayCents !== null ? `, up to ${money(history.setting.perActionCents)} each and ${money(history.setting.perDayCents)} a day` : ""}
              {history.setting.until ? `, until ${when(history.setting.until)}` : ""}.{" "}
              {history.setting.isDefault ? "Never changed: this is the starting setting." : `Last changed by ${history.setting.changedBy} on ${when(history.setting.changedAt!)}.`}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            {[
              ["Reported as done", history.counts.reported],
              ["Waiting for approval", history.counts.waiting],
              ["Expired, not done", history.counts.expired],
              ["Approved and carried out", history.counts.carriedOut],
              ["Approved, then blocked", history.counts.approvedBlocked],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border px-2 py-1.5">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="tabular-nums text-strong">{value}</dd>
              </div>
            ))}
          </dl>
          <div>
            <h3 className="font-medium text-strong">Setting changes</h3>
            {history.changes.length ? (
              <ol className="mt-1 grid gap-1 text-xs text-muted-foreground">
                {history.changes.map((c) => (
                  <li key={c.revision}>
                    <span className="text-strong">{c.from && c.to && c.from !== c.to ? `${c.from} → ${c.to}` : c.summary}</span> · {c.by} · {when(c.at)}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-muted-foreground">No changes recorded.</p>
            )}
          </div>
          <div>
            <h3 className="font-medium text-strong">Approvals</h3>
            {history.approvals.length ? (
              <ul className="mt-1 grid gap-1.5 text-xs">
                {history.approvals.map((a) => (
                  <li key={a.id}>
                    <Link href={a.href} className={link}>
                      {a.summary}
                    </Link>
                    <span className="block text-muted-foreground">
                      {a.state} · {when(a.at)}
                      {a.detail ? ` · ${a.detail}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">None.</p>
            )}
          </div>
          <div>
            <h3 className="font-medium text-strong">Done without asking (reported)</h3>
            {history.reports.length ? (
              <ul className="mt-1 grid gap-1 text-xs text-muted-foreground">
                {history.reports.map((r) => (
                  <li key={`${r.at}:${r.subject}:${r.stage}`}>
                    {STAGE_WORDS[r.stage] ?? r.stage}
                    {r.ok === false ? " (failed)" : ""}
                    {r.kind ? ` · ${r.kind.replace(/_/g, " ")}` : ""} · {when(r.at)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">None in the last {history.reportsScanned.days} days. Only &ldquo;Act and notify me&rdquo; work is reported; &ldquo;Act automatically&rdquo; work is in Activity.</p>
            )}
            {!history.reportsScanned.complete ? <p className="text-xs text-muted-foreground">Showing what was found in the latest {history.reportsScanned.events} events.</p> : null}
          </div>
          {history.blocked.length ? (
            <div>
              <h3 className="font-medium text-strong">Blocked, failed or cancelled</h3>
              <ul className="mt-1 grid gap-1 text-xs text-muted-foreground">
                {history.blocked.map((b) => (
                  <li key={`${b.at}:${b.summary}`}>
                    {b.summary} · {b.status} · {when(b.at)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
