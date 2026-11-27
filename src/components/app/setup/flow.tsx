"use client";

/**
 * Company setup: choose an outcome → confirm essentials → add relevant context → build the workspace →
 * review the first useful result. About three short decisions before anything is prepared; everything
 * else (full hours, ZIP codes, every agreement, every integration, every permission) can wait.
 *
 * Saving is the same on every screen (autosave.ts): edits save on their own after a pause and before every
 * move, "Saved" means the server has them, and another tab's newer save is never overwritten silently.
 * Leaving and coming back, a reload, or a trip to an integration resumes at the same stage.
 */
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCompany } from "@/components/app/company";
import { messageOf } from "@/components/app/form";
import { Modal } from "@/components/app/modal";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Rocket, Sparkles } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/selection";
import { Skeleton } from "@/components/ui/skeleton";
import { LANDING_PATH } from "@/lib/app/navigation";
import { timeZoneLabel, timeZoneOptions } from "@/lib/app/timezones";
import { cn } from "@/lib/utils";

import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { CATEGORY_CHOICES } from "../../../../convex/lib/setup/facts";
import { PRIORITY_INFO, STAGES, type StageId } from "../../../../convex/lib/setup/path";
import { safeSetupPath } from "../../../../convex/lib/setup/routes";
import type { Priority } from "../../../../convex/lib/setup/schema";
import { STATUS_WORDS, useAutosave, type Patch } from "./autosave";
import { ResultPanel } from "./build-panel";
import { BuildStep, ContextStep, contextBlocked, contextNeeded, EssentialsStep, OutcomeStep, StepHeading, type Form } from "./steps";

type View = FunctionReturnType<typeof api.setup.state>;
type Setup = NonNullable<View["setup"]>;
type Value = string | string[];

export function SetupScreen() {
  const { companyId } = useCompany();
  const view = useQuery(api.setup.state, { companyId });
  const begin = useMutation(api.setup.begin);
  const [version, setVersion] = useState(0);
  if (view === undefined) {
    return (
      <div className="mx-auto grid min-h-dvh max-w-5xl content-start gap-4 p-6" aria-busy="true" aria-label="Loading your setup">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    );
  }
  if (!view.canEdit) return <Message title="Setup is the Owner's" body="Your company's Owner sets this up. You can start working in the workspace now." />;
  if (!view.setup) {
    return (
      <Message title="Your company is already working in Selestial" body="Setup is optional for you. Going through it lets you confirm what Selestial knows about your company and choose what it helps with first. Nothing you have is changed, and no permission is reset.">
        <Button variant="primary" onClick={() => void begin({ companyId })}>
          Go through setup
        </Button>
      </Message>
    );
  }
  return <Flow key={version} view={view} setup={view.setup} onReload={() => setVersion((value) => value + 1)} />;
}

function Message({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  const router = useRouter();
  return (
    <main className="mx-auto grid min-h-dvh max-w-lg content-center gap-4 p-6 text-center">
      <h1 className="font-display text-2xl font-semibold text-strong">{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
      <div className="flex justify-center gap-2">
        {children}
        <Button variant="outline" onClick={() => router.push(LANDING_PATH)}>
          Open workspace
        </Button>
      </div>
    </main>
  );
}

const one = (value: Value | undefined) => (typeof value === "string" ? value : "");
const many = (value: Value | undefined) => (Array.isArray(value) ? value : []);

/** The form as the server has it: confirmed facts fill fields; anything only found on a website does not. */
function fromServer(view: View, setup: Setup): Form {
  return {
    priority: setup.priority,
    secondary: setup.secondary,
    answers: setup.answers,
    facts: Object.fromEntries(Object.entries(view.facts).filter(([, row]) => row.state === "confirmed").map(([key, row]) => [key, row.value])),
    name: view.company.name,
    timezone: view.company.timezone,
    methods: setup.methods,
  };
}

function apply(form: Form, patch: Patch): Form {
  return {
    ...form,
    ...(patch.priority !== undefined ? { priority: patch.priority as Priority } : {}),
    ...(patch.secondary !== undefined ? { secondary: patch.secondary as Priority[] } : {}),
    ...(patch.methods !== undefined ? { methods: patch.methods } : {}),
    answers: { ...form.answers, ...patch.answers },
    facts: { ...form.facts, ...patch.facts },
    name: patch.company?.name ?? form.name,
    timezone: patch.company?.timezone ?? form.timezone,
  };
}

const ORDER: StageId[] = STAGES.map((stage) => stage.id);

function Flow({ view, setup, onReload }: { view: View; setup: Setup; onReload: () => void }) {
  const { companyId } = useCompany();
  const router = useRouter();
  const saveSetup = useMutation(api.setup.save);
  const build = useMutation(api.setup.build);
  const exit = useMutation(api.setup.exit);
  const enter = useMutation(api.setup.enter);
  const resume = useMutation(api.setup.resume);
  const handoff = useMutation(api.setup.handoff);
  const questions = useQuery(api.setup.questions, { companyId });
  const status = useQuery(api.setup.buildStatus, { companyId });

  // A link can open a stage directly ("Return to setup", Home); otherwise setup resumes where it was.
  const [stepId, setStepId] = useState<StageId>(() => {
    const asked = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("step");
    const wanted = asked && (ORDER as string[]).includes(asked) ? (asked as StageId) : setup.step;
    return wanted === "result" && !setup.built ? "build" : wanted;
  });

  const save = useCallback(
    (input: Patch & { expectedRevision: number; step: string; skip?: string; confirmContext?: boolean }) =>
      saveSetup({ companyId, ...input, priority: input.priority as Priority | undefined, secondary: input.secondary as Priority[] | undefined, methods: input.methods as ("website" | "connect" | "manual")[] | undefined }),
    [saveSetup, companyId],
  );
  const autosave = useAutosave({ storageKey: `selestial.setup.pending.${companyId}`, serverRevision: setup.revision, step: stepId, save });
  const [form, setForm] = useState<Form>(() => apply(fromServer(view, setup), autosave.pending));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const zones = useMemo(() => new Set(timeZoneOptions(view.company.timezone).map((row) => row.id)), [view.company.timezone]);

  const update = useCallback(
    (patch: Patch) => {
      setForm((current) => apply(current, patch));
      autosave.edit(patch);
    },
    [autosave],
  );

  // Another tab or device saved while this one had nothing unsaved: show what it saved.
  const { external, clearExternal } = autosave;
  useEffect(() => {
    if (!external) return;
    clearExternal();
    onReload();
  }, [external, clearExternal, onReload]);

  // Coming back after "Save and exit" is recorded once, for the funnel.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !setup.exitedAt || (setup.resumedAt ?? 0) > setup.exitedAt) return;
    resumed.current = true;
    void resume({ companyId }).catch(() => undefined);
  }, [setup.exitedAt, setup.resumedAt, resume, companyId]);

  // Moving between stages puts focus on the new heading, for keyboard and screen reader users.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    document.getElementById("step-heading")?.focus();
  }, [stepId]);

  const records = questions?.records ?? null;
  const index = ORDER.indexOf(stepId);
  const info = PRIORITY_INFO.find((item) => item.id === form.priority);
  const built = status?.started === true;

  async function go(to: StageId, extra: { skip?: string; confirmContext?: boolean } = {}): Promise<boolean> {
    setError(null);
    const ok = await autosave.flush({ step: to, ...extra });
    if (ok) setStepId(to);
    return ok;
  }

  async function startBuild() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await autosave.flush({ step: "build", confirmContext: true }))) return;
      const result = await build({ companyId });
      autosave.adopt(result.revision);
      setStepId("result");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Leaves setup for a page it allows (an import, a connection, a draft): saved first, and remembered for "Return to setup". */
  async function leaveTo(href: string) {
    const safe = safeSetupPath(href);
    if (!safe) return;
    if (!(await autosave.flush())) return;
    await handoff({ companyId, href: safe, phase: "started" }).catch(() => undefined);
    router.push(safe);
  }

  async function exitNow() {
    setBusy(true);
    try {
      if (!(await autosave.flush())) {
        setLeaving(false);
        return;
      }
      await exit({ companyId });
      router.push(LANDING_PATH);
    } catch (caught) {
      setError(messageOf(caught));
      setLeaving(false);
    } finally {
      setBusy(false);
    }
  }

  async function openWorkspace() {
    setBusy(true);
    try {
      if (!(await autosave.flush())) return;
      await enter({ companyId });
      router.push(LANDING_PATH);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  const blocked =
    stepId === "outcome"
      ? form.priority
        ? null
        : "Choose what Selestial should help with first."
      : stepId === "essentials"
        ? !form.name.trim()
          ? "Your company needs a name."
          : !form.timezone || !zones.has(form.timezone)
            ? "Choose a time zone from the list."
            : !one(form.facts["company.location"]).trim()
              ? "Add where you're based."
              : many(form.facts["services.categories"]).length === 0
                ? "Choose at least one kind of cleaning."
                : null
        : stepId === "context"
          ? contextBlocked(form.priority, form, records)
          : null;

  const next = (): Promise<boolean> | void => {
    if (stepId === "outcome") return go("essentials");
    if (stepId === "essentials") return contextNeeded(form.priority, form, records, Boolean(view.prepared.service)) ? go("context") : go(built ? "result" : "build", { skip: "context" });
    if (stepId === "context") return go(built ? "result" : "build");
    if (stepId === "build") return built ? go("result") : void startBuild();
  };
  const previous = stepId === "result" ? "context" : stepId === "build" ? (contextNeeded(form.priority, form, records, Boolean(view.prepared.service)) ? "context" : "essentials") : index > 0 ? ORDER[index - 1] : null;

  const summary = <Summary form={form} />;
  const wide = stepId === "result" || stepId === "build";

  return (
    <div className="flex min-h-dvh flex-col bg-[#f7f5ff]">
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <p className="font-display text-base font-semibold text-strong">Selestial</p>
          <ol className="ml-2 hidden items-center gap-1 lg:flex" aria-label="Setup stages">
            {STAGES.map((item, at) => {
              const current = item.id === stepId;
              const done = index > at;
              return (
                <li key={item.id} aria-current={current ? "step" : undefined} className={cn("flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", current ? "bg-[#eee8ff] text-[#5126c7]" : done ? "text-strong" : "text-muted-foreground")}>
                  <span className={cn("grid size-4 place-items-center rounded-full text-[10px]", done ? "bg-[#6838ef] text-white" : current ? "bg-[#5126c7] text-white" : "bg-muted text-muted-foreground")} aria-hidden>
                    {done ? <Check className="size-3" /> : at + 1}
                  </span>
                  {item.label}
                </li>
              );
            })}
          </ol>
          <p className={cn("ml-auto text-xs", autosave.status === "failed" || autosave.status === "conflict" ? "font-medium text-destructive-foreground" : "text-muted-foreground")} role="status" aria-live="polite">
            {STATUS_WORDS[autosave.status]}
          </p>
          <Button variant="ghost" size="sm" onClick={() => setLeaving(true)}>
            Save and exit
          </Button>
        </div>
        <div className="mx-auto max-w-6xl px-4 pb-3 sm:px-6">
          <p className="mb-1 text-xs text-muted-foreground lg:hidden">
            {STAGES[index]?.label} · step {index + 1} of {STAGES.length}
          </p>
          <div className="h-1.5 overflow-hidden rounded-full bg-[#eee8ff]" role="progressbar" aria-valuemin={1} aria-valuemax={STAGES.length} aria-valuenow={index + 1} aria-label={`Setup: step ${index + 1} of ${STAGES.length}, ${STAGES[index]?.label}`}>
            <div className="h-full rounded-full bg-[#6838ef] transition-[width] motion-reduce:transition-none" style={{ width: `${((index + 1) / STAGES.length) * 100}%` }} />
          </div>
        </div>
      </header>

      {autosave.status === "conflict" || autosave.status === "failed" ? (
        <div className="border-b border-destructive/20 bg-destructive/5" role="alert">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2.5 text-sm sm:px-6">
            <p className="min-w-0 flex-1 text-strong">
              {autosave.status === "conflict" ? "Setup was changed in another tab or on another device. Your edits here are kept until you choose." : `Your latest changes aren't saved yet${autosave.error ? ` (${autosave.error})` : ""}. They're kept on this device.`}
            </p>
            {autosave.status === "conflict" ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    autosave.discard();
                    onReload();
                  }}
                >
                  Load the latest
                </Button>
                <Button variant="primary" size="sm" onClick={() => void autosave.keepMine()}>
                  Keep my changes
                </Button>
              </>
            ) : (
              <Button variant="primary" size="sm" onClick={() => void autosave.flush()}>
                Try again
              </Button>
            )}
          </div>
        </div>
      ) : null}

      <div className={cn("mx-auto grid w-full flex-1 gap-6 px-4 py-6 pb-28 sm:px-6", wide ? "max-w-3xl" : "max-w-6xl lg:grid-cols-[minmax(0,1fr)_20rem]")}>
        <main className="min-w-0" aria-labelledby="step-heading">
          <div className="grid gap-5 rounded-2xl border border-border bg-white p-5 shadow-[0_1px_2px_rgba(33,26,53,0.04)] sm:p-7">
            {stepId === "outcome" ? <OutcomeStep form={form} update={update} /> : null}
            {stepId === "essentials" ? <EssentialsStep view={view} form={form} update={update} /> : null}
            {stepId === "context" ? <ContextStep view={view} form={form} update={update} records={records} onLeave={(href) => void leaveTo(href)} /> : null}
            {stepId === "build" && form.priority ? (
              status?.started ? (
                <>
                  <StepHeading id="step-heading" eyebrow="Step 4 · Build" title="Your workspace is built" lead={status.outdated ? "Your answers changed since it was built. Update it to refresh the drafts you haven't edited; anything you changed is kept." : "Everything is running or ready. See your first result."} />
                  {status.outdated ? (
                    <Button variant="outline" className="justify-self-start" loading={busy} onClick={() => void startBuild()}>
                      Update my workspace
                    </Button>
                  ) : null}
                </>
              ) : (
                <BuildStep preview={status && !status.started ? status : undefined} outcome={form.priority} />
              )
            ) : null}
            {stepId === "result" && form.priority ? (
              <>
                <StepHeading id="step-heading" eyebrow={info ? `Your first result · ${info.title}` : "Your first result"} title={status?.started ? (status.counts.preparing && !status.counts.usable ? "Your workspace is being prepared" : "Here's what Selestial prepared") : "Preparing your workspace"} lead={status?.started && status.counts.preparing ? "Results appear here as they're ready. You can leave: the work keeps going." : undefined} />
                {status?.started ? <ResultPanel status={status} onEdit={() => void go(contextNeeded(form.priority, form, records, Boolean(view.prepared.service)) ? "context" : "essentials")} onFinishLater={() => setLeaving(true)} beforeLeave={() => autosave.flush()} /> : <Skeleton className="h-48 rounded-2xl" />}
                <MorePriorities form={form} update={update} onAdd={() => void startBuild()} busy={busy} running={status?.started === true && status.activation?.status === "running"} />
              </>
            ) : null}

            {error ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm text-strong" role="alert">
                {error}
              </div>
            ) : null}
          </div>

          {!wide ? (
            <details className="mt-4 rounded-2xl border border-border bg-white lg:hidden" open={previewOpen} onToggle={(event) => setPreviewOpen((event.target as HTMLDetailsElement).open)}>
              <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium text-strong">
                <Sparkles className="size-4 text-[#6838ef]" aria-hidden />
                What Selestial knows so far
                <ChevronDown className={cn("ml-auto size-4 text-muted-foreground transition-transform motion-reduce:transition-none", previewOpen && "rotate-180")} aria-hidden />
              </summary>
              <div className="border-t border-border p-4">{summary}</div>
            </details>
          ) : null}
        </main>

        {!wide ? (
          <aside className="hidden lg:block" aria-label="What Selestial knows so far">
            <div className="sticky top-6 rounded-2xl border border-border bg-white p-5">
              <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-strong">
                <Sparkles className="size-4 text-[#6838ef]" aria-hidden />
                What Selestial knows so far
              </p>
              {summary}
            </div>
          </aside>
        ) : null}
      </div>

      <footer className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
          {previous ? (
            <Button variant="ghost" onClick={() => void go(previous)} disabled={busy || autosave.status === "saving"}>
              <ArrowLeft aria-hidden />
              Back
            </Button>
          ) : null}
          <p className="min-w-0 flex-1 text-right text-xs text-muted-foreground" aria-live="polite">
            {blocked ?? ""}
          </p>
          {stepId === "result" ? (
            <Button variant="primary" size="lg" onClick={() => void openWorkspace()} loading={busy}>
              Open my workspace
              <ArrowRight aria-hidden />
            </Button>
          ) : stepId === "build" && !built ? (
            <Button variant="primary" size="lg" onClick={() => void startBuild()} disabled={busy || !form.priority} loading={busy}>
              <Rocket aria-hidden />
              Build my workspace
            </Button>
          ) : (
            <Button variant="primary" size="lg" onClick={() => void next()} disabled={Boolean(blocked) || busy} loading={autosave.status === "saving" && busy}>
              {stepId === "build" ? "See your result" : "Continue"}
              <ArrowRight aria-hidden />
            </Button>
          )}
        </div>
      </footer>

      <Modal open={leaving} onClose={() => setLeaving(false)} title="Save and exit setup?" description="Everything you entered is saved.">
        <div className="grid gap-3 text-sm">
          <p className="text-muted-foreground">
            {built
              ? "The preparation you started keeps running in the background, and you'll be notified when results are ready. Your agents send nothing and publish nothing on their own."
              : "Nothing has been prepared yet and no agent work has started. Come back from Home whenever you're ready: setup opens where you left it."}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setLeaving(false)}>
              Stay in setup
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void exitNow()}>
              Save and open my workspace
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Additional priorities, after the first result: optional, and added to the workspace only when the owner asks. */
function MorePriorities({ form, update, onAdd, busy, running }: { form: Form; update: (patch: Patch) => void; onAdd: () => void; busy: boolean; running: boolean }) {
  const others = PRIORITY_INFO.filter((item) => item.id !== form.priority);
  return (
    <details className="group rounded-2xl border border-border bg-white">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium text-strong focus-visible:outline-2 focus-visible:outline-brand-500">
        Add more priorities (optional)
        <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
      </summary>
      <div className="grid gap-3 border-t border-border p-4">
        <p id="more-priorities" className="text-sm text-muted-foreground">
          Choose anything else Selestial should help with. Nothing changes until you add it to your workspace.
        </p>
        <ChoiceChips aria-labelledby="more-priorities" options={others.map((item) => ({ value: item.id, label: item.title }))} value={form.secondary} onValueChange={(next) => update({ secondary: next })} />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={!form.secondary.length || running || busy} loading={busy} onClick={onAdd}>
            Add to my workspace
          </Button>
          {running ? <span className="text-xs text-muted-foreground">Your current work is still running. Add these once it settles.</span> : null}
        </div>
      </div>
    </details>
  );
}

/** What is known, in the owner's words as they type it. Nothing here is a guess: an empty line says "Not given yet". */
function Summary({ form }: { form: Form }) {
  const rows: [string, string][] = [
    ["Company", form.name.trim()],
    ["Based in", one(form.facts["company.location"])],
    ["Time zone", form.timezone ? timeZoneLabel(form.timezone) : ""],
    ["Cleans for", many(form.facts["services.categories"]).map((value) => CATEGORY_CHOICES.find((choice) => choice.value === value)?.label ?? value).join(", ")],
    ["Website", one(form.facts["company.website"])],
  ];
  const first = PRIORITY_INFO.find((item) => item.id === form.priority);
  return (
    <div className="grid gap-4">
      <div className="rounded-xl bg-[#eee8ff] px-3 py-2.5 text-sm">
        <p className="text-xs font-medium text-[#5126c7]">First outcome</p>
        <p className="text-strong">{first ? first.title : "Not chosen yet"}</p>
        {first ? <p className="mt-0.5 text-xs text-muted-foreground">{first.first}</p> : null}
      </div>
      <dl className="grid gap-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={cn("min-w-0 break-words", value ? "text-strong" : "text-muted-foreground italic")}>{value || "Not given yet"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

