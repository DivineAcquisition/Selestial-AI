"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConversationBody } from "@/components/app/chat/thread";
import { ActionMenu } from "@/components/app/clients/menu";
import { useCompany } from "@/components/app/company";
import { Field, FormError, TextArea, TextInput, useRun } from "@/components/app/form";
import { ArrowLeft, ChevronDown, Eye, RollbackIcon, RotateCcw, SendIcon, Sparkles } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { useConfirm } from "@/components/ui/fields/confirm";
import { Sheet, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { changePath, EDITOR_SECTIONS, SERVICES_ROOT, sectionOf, type EditorSection } from "@/lib/app/services";
import { newClientKey } from "@/lib/app/chat/session";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { checkSpec, priceSummary } from "../../../../convex/lib/services/engine";
import { CATEGORY_LABELS, type Spec } from "../../../../convex/lib/services/spec";
import { canonical, keptTemplateAmounts, type KeptAmount } from "../../../../convex/lib/services/store";
import { TEMPLATES } from "../../../../convex/lib/services/templates";
import { ServicePreview } from "./preview";
import { PropertyPrices } from "./property-prices";
import { ChangeBadge, day, Empty, formatCents, Notice, SectionTitle, Toggle, when } from "./shared";
import { BasicsStep, ExtrasStep, PricingStep, ScopeStep, TeamStep, type StepProps } from "./steps";

type View = NonNullable<ReturnType<typeof useQuery<typeof api.services.service>>>;
type Costs = Parameters<typeof ServicePreview>[0]["costs"];
type Rail = "preview" | "assistant" | "review";

/** One service: its workspace while a draft is open, or its live version with its history. */
export function ServiceBuilder({ serviceId }: { serviceId: string }) {
  const { companyId } = useCompany();
  const view = useQuery(api.services.service, { companyId, serviceId: serviceId as Id<"services"> });
  const profile = useQuery(api.services.profile, { companyId });
  if (view === undefined) return <Skeleton className="h-[32rem] rounded-2xl" />;
  const main = view.draft && view.canDraft ? <ServiceWorkspace key={`${view.service.id}`} view={view} costs={profile?.costs ?? null} canSeeCosts={view.canPublish} /> : <LiveService view={view} costs={profile?.costs ?? null} />;
  // A property's own price follows the live version, whether or not a draft is open.
  if (!view.live) return main;
  return (
    <div className="grid grid-cols-1 gap-5">
      {main}
      <PropertyPrices serviceId={view.service.id} spec={view.live.spec} />
    </div>
  );
}

// ── The service workspace ───────────────────────────────────────────────────────────────────────────

type SaveState = { kind: "saved"; at: number } | { kind: "saving" } | { kind: "unsaved" } | { kind: "conflict"; by: string; at: number; revision: number } | { kind: "error"; message: string };

const RAIL_TABS: { id: Rail; label: string }[] = [
  { id: "preview", label: "Preview" },
  { id: "assistant", label: "Selestial" },
  { id: "review", label: "Review" },
];

/**
 * One page for the whole service: three sections edited in place, with the customer preview, Selestial
 * and Review & publish beside it (a sheet on a phone).
 *
 * Edits land on screen at once and are saved after a short pause, naming the revision they started from.
 * If someone (a person, or Selestial) saved first, the save is refused and both versions are kept until
 * the person chooses. A newer draft from elsewhere is adopted automatically only when nothing here is
 * unsaved, so Selestial's edits appear live without ever replacing what the person is typing.
 */
function ServiceWorkspace({ view, costs, canSeeCosts }: { view: View; costs: Costs; canSeeCosts: boolean }) {
  const { companyId } = useCompany();
  const params = useSearchParams();
  const draft = view.draft!;
  const save = useMutation(api.services.saveDraft);
  const [spec, setSpec] = useState<Spec>(draft.spec);
  const [base, setBase] = useState({ revision: draft.revision, spec: draft.spec });
  const [seen, setSeen] = useState(draft.revision);
  const [state, setState] = useState<SaveState>({ kind: "saved", at: draft.updatedAt });
  const asked = params?.get("panel");
  const [rail, setRail] = useState<Rail>(asked === "assistant" || asked === "review" ? asked : draft.step === "review" ? "review" : "preview");
  const [sheet, setSheet] = useState<Rail | null>(null);
  const [closed, setClosed] = useState<EditorSection[]>([]);
  const [seed, setSeed] = useState<{ text: string; n: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ spec: draft.spec, revision: draft.revision });
  const dirty = canonical(spec) !== canonical(base.spec);

  // Someone else saved (Selestial, another tab, a teammate). With nothing unsaved here, show theirs at once.
  if (draft.revision !== seen) {
    setSeen(draft.revision);
    if (!dirty) {
      setBase({ revision: draft.revision, spec: draft.spec });
      setSpec(draft.spec);
      setState({ kind: "saved", at: draft.updatedAt });
    }
  }
  useEffect(() => {
    latest.current = { ...latest.current, revision: base.revision };
  }, [base.revision]);

  const flush = useCallback(
    async (next: Spec, revision: number): Promise<number | null> => {
      setState({ kind: "saving" });
      try {
        const result = await save({ companyId, serviceId: view.service.id, expectedRevision: revision, spec: next, step: draft.step });
        if (!result.ok) {
          setState({ kind: "conflict", by: result.conflict.by, at: result.conflict.at, revision: result.conflict.revision });
          return null;
        }
        latest.current = { ...latest.current, revision: result.revision };
        setBase({ revision: result.revision, spec: next });
        setState({ kind: "saved", at: Date.now() });
        return result.revision;
      } catch (error) {
        setState({ kind: "error", message: (error as { data?: { message?: string } }).data?.message ?? "That could not be saved. Your edits are still here." });
        return null;
      }
    },
    [companyId, draft.step, save, view.service.id],
  );

  /** Saves anything waiting now. The revision the screen shows afterwards, or null when it couldn't save. */
  const settle = useCallback(async (): Promise<number | null> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (canonical(latest.current.spec) === canonical(base.spec)) return latest.current.revision;
    return flush(latest.current.spec, latest.current.revision);
  }, [base.spec, flush]);

  // Leaving with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const stop = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", stop);
    return () => window.removeEventListener("beforeunload", stop);
  }, [dirty]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  // An address ending in #price (or #service, #booking) opens at that section.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (EDITOR_SECTIONS.some((s) => s.id === id)) document.getElementById(`section-${id}`)?.scrollIntoView({ block: "start" });
  }, []);

  const edit = (change: (current: Spec) => Spec) => {
    if (state.kind === "conflict") return;
    const next = change(latest.current.spec);
    latest.current = { ...latest.current, spec: next };
    setSpec(next);
    setState((s) => (s.kind === "error" || s.kind === "saving" ? s : { kind: "unsaved" }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(latest.current.spec, latest.current.revision), 900);
  };
  const problems = useMemo(() => checkSpec(spec), [spec]);
  const blockers = problems.filter((p) => p.severity === "blocker");
  const template = useMemo(() => TEMPLATES.find((t) => t.id === view.service.templateId)?.spec ?? null, [view.service.templateId]);
  const kept = useMemo(() => (spec.illustrative && template ? keptTemplateAmounts(spec, template) : []), [spec, template]);
  const props: StepProps = { spec, edit, disabled: state.kind === "conflict" };

  const goTo = (target: EditorSection | "review") => {
    if (target === "review") return open("review");
    setClosed((list) => list.filter((s) => s !== target));
    setSheet(null);
    requestAnimationFrame(() => {
      const el = document.getElementById(`section-${target}`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
      el?.querySelector<HTMLElement>("h2 button")?.focus({ preventScroll: true });
    });
  };
  /** Opens a panel: beside the editor on a wide screen, as a sheet on a phone. */
  const open = (next: Rail) => {
    setRail(next);
    if (typeof window !== "undefined" && !window.matchMedia("(min-width: 64rem)").matches) setSheet(next);
  };
  const ask = (text: string) => {
    setSeed((last) => ({ text, n: (last?.n ?? 0) + 1 }));
    open("assistant");
  };

  const panel = (which: Rail) =>
    which === "preview" ? (
      <ServicePreview spec={spec} costs={costs} canSeeCosts={canSeeCosts} />
    ) : which === "assistant" ? (
      <AssistantPanel serviceId={view.service.id} settle={settle} seed={seed} />
    ) : (
      <ReviewPanel view={view} spec={spec} edit={edit} kept={kept} revision={base.revision} dirty={dirty || state.kind === "saving"} blockers={blockers.map((b) => ({ message: b.message, section: sectionOf(b.field) }))} goTo={goTo} settle={settle} />
    );

  return (
    <div className="grid grid-cols-1 gap-4 pb-20 lg:pb-0">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link href={SERVICES_ROOT} className="inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-strong focus-visible:outline-2 focus-visible:outline-brand-500/50">
            <ArrowLeft aria-hidden className="size-4" /> All services
          </Link>
          <h1 className="mt-1 truncate font-heading text-2xl tracking-tight text-strong">{spec.name || "New service"}</h1>
          <p className="text-sm text-muted-foreground">
            {CATEGORY_LABELS[spec.category]} · {priceSummary(spec)} · {view.live ? `draft of live version ${view.live.version}` : "not live yet"}
            {draft.rollbackOf ? ` · rolling back to version ${draft.rollbackOf}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SaveStatus state={state} />
          <ActionMenu
            label="More actions"
            className="h-8 rounded-lg border border-border bg-card px-2"
            actions={[
              { label: "Help me price this", onSelect: () => ask("Help me price this service. Ask me for any amount you'd need, and use only the amounts I give or that are already on it.") },
              { label: "What's missing before review?", onSelect: () => ask("What's missing before this service can be reviewed? List the blockers in order.") },
              ...(canSeeCosts ? [{ label: "Check my costs", onSelect: () => open("preview") }] : []),
              { label: "Compare example jobs", href: `${SERVICES_ROOT}/studio` },
              { label: "Market research", href: `${SERVICES_ROOT}/research` },
              { label: "Review history", href: `${SERVICES_ROOT}/changes` },
            ]}
          />
          <Button size="sm" variant="primary" onClick={() => open("review")}>
            {view.canPublish ? "Review & publish" : "Submit for review"}
          </Button>
        </div>
      </header>

      {state.kind === "conflict" ? (
        <ConflictBanner
          by={state.by}
          at={state.at}
          onLoadLatest={() => {
            latest.current = { spec: draft.spec, revision: draft.revision };
            setSpec(draft.spec);
            setBase({ revision: draft.revision, spec: draft.spec });
            setState({ kind: "saved", at: draft.updatedAt });
          }}
          onKeepMine={() => {
            latest.current = { ...latest.current, revision: state.revision };
            void flush(spec, state.revision);
          }}
        />
      ) : null}
      {spec.illustrative ? (
        <Notice tone="warning" title="Example prices">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-strong">{kept.length ? `${kept.length} price${kept.length === 1 ? " is" : "s are"} still the template's example.` : "Some amounts came from a template or an import."} Confirm or replace them for your market before publishing.</span>
            <Button size="xs" variant="secondary" onClick={() => open("review")}>
              See which
            </Button>
          </span>
        </Notice>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="grid min-w-0 grid-cols-1 gap-4">
          {EDITOR_SECTIONS.map((section) => {
            const issues = blockers.filter((b) => sectionOf(b.field) === section.id).length;
            const isOpen = !closed.includes(section.id);
            return (
              <section key={section.id} id={`section-${section.id}`} aria-labelledby={`title-${section.id}`} className="scroll-mt-24 rounded-2xl border border-border bg-card">
                <h2 id={`title-${section.id}`} className="text-base">
                  <button type="button" aria-expanded={isOpen} aria-controls={`body-${section.id}`} onClick={() => setClosed((list) => (isOpen ? [...list, section.id] : list.filter((s) => s !== section.id)))} className="flex w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left focus-visible:outline-2 focus-visible:outline-brand-500/50 sm:px-6">
                    <span className="min-w-0 flex-1">
                      <span className="block font-heading text-lg tracking-tight text-strong">{section.label}</span>
                      <span className="block text-sm font-normal text-muted-foreground">{section.blurb}</span>
                    </span>
                    {issues ? (
                      <Badge variant="warning" size="sm">
                        {issues} to fix
                      </Badge>
                    ) : null}
                    <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", isOpen && "rotate-180")} />
                  </button>
                </h2>
                {isOpen ? (
                  <div id={`body-${section.id}`} className="grid gap-8 border-t border-border px-4 py-5 sm:px-6">
                    {section.id === "service" ? (
                      <>
                        <BasicsStep {...props} />
                        <ScopeStep {...props} />
                      </>
                    ) : section.id === "price" ? (
                      <>
                        <PricingStep {...props} />
                        <ExtrasStep {...props} part="extras" />
                        <MoreOptions label="More options" detail="Recurring discounts, condition, travel, rush, demand, promotions and minimum charge">
                          <ExtrasStep {...props} part="adjustments" />
                        </MoreOptions>
                      </>
                    ) : (
                      <TeamStep {...props} />
                    )}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>

        {/* Beside the editor on a wide screen. */}
        <aside aria-label="Preview, Selestial and review" className="hidden min-w-0 lg:sticky lg:top-app-sticky lg:flex lg:max-h-app-sticky lg:flex-col lg:gap-3 lg:self-start">
          <RailTabs value={rail} onChange={setRail} />
          <div className="min-h-0 flex-1 overflow-y-auto">{panel(rail)}</div>
        </aside>
      </div>

      {/* On a phone: a bar at the bottom opens each panel as a sheet. */}
      <nav aria-label="Service panels" className="fixed inset-x-0 bottom-0 z-sticky flex gap-2 border-t border-border bg-background/95 px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
        <Button size="sm" variant="secondary" className="flex-1" onClick={() => setSheet("preview")}>
          <Eye aria-hidden /> Preview
        </Button>
        <Button size="sm" variant="secondary" className="flex-1" onClick={() => setSheet("assistant")}>
          <Sparkles aria-hidden /> Selestial
        </Button>
        <Button size="sm" variant="primary" className="flex-1" onClick={() => setSheet("review")}>
          {view.canPublish ? "Publish" : "Submit"}
        </Button>
      </nav>
      <Sheet open={sheet !== null} onOpenChange={(next) => !next && setSheet(null)}>
        <SheetPopup side="bottom" className="max-h-[88dvh] bg-card">
          <div className="px-4 pt-4 pr-12">
            <SheetTitle className="text-lg">{sheet === "assistant" ? "Selestial" : sheet === "review" ? (view.canPublish ? "Review & publish" : "Submit for review") : "Customer preview"}</SheetTitle>
          </div>
          <SheetPanel className="p-4">{sheet ? panel(sheet) : null}</SheetPanel>
        </SheetPopup>
      </Sheet>
    </div>
  );
}

function RailTabs({ value, onChange }: { value: Rail; onChange: (rail: Rail) => void }) {
  return (
    <div role="tablist" aria-label="Beside the editor" className="flex rounded-xl border border-border bg-card p-1">
      {RAIL_TABS.map((tab) => (
        <button key={tab.id} type="button" role="tab" aria-selected={value === tab.id} onClick={() => onChange(tab.id)} className={cn("min-h-8 flex-1 rounded-lg text-sm transition-colors focus-visible:outline-2 focus-visible:outline-brand-500/50", value === tab.id ? "bg-brand-500/10 font-medium text-strong" : "text-muted-foreground hover:text-strong")}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Settings most services don't need, folded until they are wanted. */
function MoreOptions({ label, detail, children }: { label: string; detail: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-brand-500/50">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-strong">{label}</span>
          <span className="block text-xs text-muted-foreground">{detail}</span>
        </span>
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      {open ? <div className="border-t border-border p-4">{children}</div> : null}
    </div>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  const text = state.kind === "saving" ? "Saving…" : state.kind === "unsaved" ? "Unsaved changes" : state.kind === "saved" ? `Draft saved ${when(state.at)}` : state.kind === "conflict" ? "Not saved: a newer version exists" : "Not saved";
  return (
    <p role="status" aria-live="polite" className={cn("rounded-full border px-3 py-1 text-xs", state.kind === "saved" ? "border-border text-muted-foreground" : state.kind === "saving" || state.kind === "unsaved" ? "border-brand-500/30 text-strong" : "border-destructive/40 text-destructive-foreground")}>
      {text}
      {state.kind === "error" ? `: ${state.message}` : ""}
    </p>
  );
}

function ConflictBanner({ by, at, onLoadLatest, onKeepMine }: { by: string; at: number; onLoadLatest: () => void; onKeepMine: () => void }) {
  return (
    <div role="alert" className="grid grid-cols-1 gap-2 rounded-xl border border-warning/50 bg-warning/10 px-4 py-3 text-sm">
      <p className="font-medium text-strong">
        {by} saved this draft at {when(at)}, after you opened it.
      </p>
      <p className="text-muted-foreground">Nothing was overwritten. Your edits are still on screen. Load theirs to continue from it, or save yours over it on purpose.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={onLoadLatest}>
          Load the latest (drop my edits)
        </Button>
        <Button size="sm" variant="ghost" onClick={onKeepMine}>
          Save my version over theirs
        </Button>
      </div>
    </div>
  );
}

// ── Selestial, beside the service ──────────────────────────────────────────────────────────────────

const STARTERS = ["Help me price this", "What's missing before review?", "Write the customer description", "Suggest what's included and not included"];

/**
 * Selestial working on this one service, in place. It is the same assistant as Chat, with the same tools
 * and credits, focused on this draft: each request carries the revision on screen, so an answer that
 * arrives after newer edits changes nothing. Its edits are listed with what they changed, and each can be
 * undone without touching anything edited since.
 */
function AssistantPanel({ serviceId, settle, seed }: { serviceId: Id<"services">; settle: () => Promise<number | null>; seed: { text: string; n: number } | null }) {
  const { companyId } = useCompany();
  const found = useQuery(api.services.assistant, { companyId, serviceId });
  const [started, setStarted] = useState<string | null>(null);
  const conversationId = started ?? found?.conversationId ?? null;
  const thread = useQuery(api.chat.thread, conversationId ? { companyId, conversationId } : "skip");
  const send = useMutation(api.chat.send);
  const stop = useMutation(api.chat.stop);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // A request from the More menu fills the box; the person sends it.
  const [seenSeed, setSeenSeed] = useState(0);
  if (seed && seed.n !== seenSeed) {
    setSeenSeed(seed.n);
    setText(seed.text);
  }
  const live = thread?.run?.status === "running" || thread?.run?.status === "queued";

  const submit = useCallback(
    async (words: string) => {
      const message = words.trim();
      if (!message || sending) return;
      setError(null);
      setSending(true);
      try {
        // Unsaved edits are saved first, so Selestial works from exactly what is on screen.
        const revision = await settle();
        if (revision === null) throw new Error("Your latest edits aren't saved yet, so nothing was sent. Resolve the save above, then ask again.");
        const result = await send({ companyId, conversationId: conversationId ?? undefined, text: message, clientKey: newClientKey(), origin: { kind: "service_draft", serviceId }, draftRevision: revision, page: typeof window === "undefined" ? undefined : window.location.pathname });
        setStarted(result.conversationId as string);
        setText("");
      } catch (caught) {
        setError((caught as { data?: { message?: string } }).data?.message ?? (caught as Error).message ?? "That couldn't be sent.");
      } finally {
        setSending(false);
      }
    },
    [companyId, conversationId, send, sending, serviceId, settle],
  );

  return (
    <div className="grid gap-3">
      <div className="rounded-xl border border-border bg-card p-3">
        <p className="text-sm font-medium text-strong">Selestial on this service</p>
        <p className="mt-0.5 text-xs text-muted-foreground">It reads and edits this draft only, uses only amounts you give or that are already here, and never publishes. Each answer uses one Chat credit; a retry of a failed answer isn&apos;t charged again.</p>
      </div>
      <DraftEdits serviceId={serviceId} />
      {conversationId ? (
        <div className="max-h-[28rem] overflow-y-auto rounded-xl border border-border bg-card px-3">
          <ConversationBody conversationId={conversationId} compact onChoice={(choice) => void submit(choice)} />
        </div>
      ) : (
        <ul className="grid gap-1.5">
          {STARTERS.map((starter) => (
            <li key={starter}>
              <button type="button" onClick={() => setText(starter)} className="w-full rounded-lg border border-border bg-card px-3 py-2 text-left text-sm text-strong hover:border-brand-500/40 focus-visible:outline-2 focus-visible:outline-brand-500/50">
                {starter}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(text);
        }}
      >
        <label className="sr-only" htmlFor={`ask-${serviceId}`}>
          Ask Selestial about this service
        </label>
        <TextArea id={`ask-${serviceId}`} rows={3} value={text} onChange={(event) => setText(event.target.value)} placeholder="Ask about this service, or say what to change…" onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit(text);
          }
        }} />
        <FormError message={error} />
        <div className="flex items-center justify-end gap-2">
          {live ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => conversationId && void stop({ companyId, conversationId }).catch(() => undefined)}>
              Stop
            </Button>
          ) : null}
          <Button type="submit" size="sm" variant="primary" loading={sending} disabled={!text.trim() || live}>
            <SendIcon aria-hidden /> Send
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Selestial's edits to this draft: what each changed, and a safe undo. */
function DraftEdits({ serviceId }: { serviceId: Id<"services"> }) {
  const { companyId } = useCompany();
  const edits = useQuery(api.services.draftEdits, { companyId, serviceId });
  const undo = useMutation(api.services.undoEdit);
  const { busy, error, run } = useRun();
  const [shown, setShown] = useState<string | null>(null);
  if (!edits?.length) return null;
  return (
    <div className="grid gap-2 rounded-xl border border-border bg-card p-3">
      <p className="text-sm font-medium text-strong">Changes Selestial made</p>
      <ul className="grid gap-2">
        {edits.slice(0, 5).map((e) => (
          <li key={e.id} className="grid gap-1.5 rounded-lg border border-border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 text-strong">
                {e.parts.join(", ")} <span className="text-xs text-muted-foreground">· {when(e.at)}</span>
              </span>
              {e.undone ? (
                <Badge variant="outline" size="sm">
                  Undone
                </Badge>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="xs" variant="ghost" aria-expanded={shown === e.id} onClick={() => setShown(shown === e.id ? null : e.id)}>
                {shown === e.id ? "Hide changes" : "View changes"}
              </Button>
              {e.canUndo ? (
                <Button size="xs" variant="secondary" loading={busy} onClick={() => void run(() => undo({ companyId, editId: e.id }))}>
                  <RotateCcw aria-hidden /> Undo
                </Button>
              ) : null}
            </div>
            {shown === e.id ? (
              <ul className="grid gap-0.5 text-xs text-muted-foreground">
                {e.summary.length ? e.summary.map((line) => <li key={line}>• {line}</li>) : <li>• {e.parts.join(", ")} changed</li>}
              </ul>
            ) : null}
            {!e.undone && e.canUndo && e.keptIfUndone.length ? <p className="text-xs text-muted-foreground">Undo keeps {e.keptIfUndone.join(", ")}: changed again since.</p> : null}
            {e.undone && e.undone.kept.length ? <p className="text-xs text-muted-foreground">Kept {e.undone.kept.join(", ")}: changed again since.</p> : null}
          </li>
        ))}
      </ul>
      <FormError message={error} />
    </div>
  );
}

// ── Review & publish ────────────────────────────────────────────────────────────────────────────────

/**
 * Review & publish, in the workspace. What changes and what publishing does are read from the saved
 * draft by the server, from what the application really does. The Owner publishes the exact revision
 * they reviewed; a Manager submits it for the Owner. A change already in review is approved here for its
 * exact version.
 */
function ReviewPanel({ view, spec, edit, kept, revision, dirty, blockers, goTo, settle }: { view: View; spec: Spec; edit: StepProps["edit"]; kept: KeptAmount[]; revision: number; dirty: boolean; blockers: { message: string; section: EditorSection | "review" }[]; goTo: (section: EditorSection | "review") => void; settle: () => Promise<number | null> }) {
  const { companyId } = useCompany();
  const router = useRouter();
  const preview = useQuery(api.services.reviewPreview, { companyId, serviceId: view.service.id });
  const submit = useMutation(api.services.submit);
  const publish = useMutation(api.services.publishDraft);
  const approve = useMutation(api.services.approve);
  const discard = useMutation(api.services.discardDraft);
  const { busy, error, run } = useRun();
  const { ask, element: confirmDialog } = useConfirm();
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState({ required: false, note: "" });
  const [contracts, setContracts] = useState({ required: false, note: "" });
  const [startsOn, setStartsOn] = useState("");
  const [more, setMore] = useState(false);
  const unconfirmed = spec.requirements.filter((r) => !r.confirmed);
  if (!preview) return <Skeleton className="h-64 rounded-xl" />;
  const d = preview.draft;
  const behind = dirty || (d !== null && d.revision !== revision);
  const open = preview.openChange;
  const nothing = d === null || d.sameAsLive || d.changes.length === 0;
  const effectiveAt = startsOn ? new Date(`${startsOn}T00:00:00`).getTime() : undefined;
  const later = effectiveAt && startsOn > localDay(new Date()) ? { effectiveAt } : {};
  const canAct = !behind && blockers.length === 0 && !nothing && reason.trim().length > 0;
  return (
    <div className="grid gap-4">
      {confirmDialog}
      {behind ? (
        <p role="status" className="rounded-lg border border-brand-500/30 px-3 py-2 text-sm text-strong">
          Saving your latest edits. The review below updates when they are saved.
        </p>
      ) : null}
      {open ? (
        <Notice tone="info" title={open.state === "in_review" ? "Waiting for review" : open.state === "scheduled" ? "Scheduled" : "Approved"}>
          <span className="grid gap-2">
            <span>{open.fromThisDraft ? "This draft was submitted" : "An earlier version of this draft was submitted"} {when(open.submittedAt)}.</span>
            <span className="flex flex-wrap gap-2">
              {open.state === "in_review" && preview.canPublish && open.fromThisDraft ? (
                <Button size="xs" variant="primary" loading={busy} onClick={() => void run(async () => approve({ companyId, changeId: open.id, hash: open.hash, publish: true }))}>
                  Approve and publish
                </Button>
              ) : null}
              <Link href={changePath(open.id)} className={buttonVariants({ size: "xs", variant: "secondary" })}>
                Open the change
              </Link>
            </span>
          </span>
        </Notice>
      ) : null}

      <ReviewBlock title={view.live ? `What changes from live version ${view.live.version}` : "What this adds"}>
        {d && d.changes.length ? (
          <ul className="grid gap-0.5 text-sm text-muted-foreground">
            {d.changes.map((c) => (
              <li key={c}>• {c}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing yet: this draft matches the live version.</p>
        )}
      </ReviewBlock>

      {d && d.prices.length ? (
        <ReviewBlock title="Example prices">
          <table className="w-full text-sm">
            <thead className="sr-only">
              <tr>
                <th>Job</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              {d.prices.map((p) => (
                <tr key={p.label} className="border-t border-border first:border-0">
                  <td className="py-1.5 pr-2 text-muted-foreground">{p.label}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">{p.before !== null ? formatCents(p.before) : view.live ? "—" : ""}</td>
                  <td className="py-1.5 text-right font-medium tabular-nums text-strong">{p.after !== null ? formatCents(p.after) : p.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ReviewBlock>
      ) : null}

      {spec.illustrative || unconfirmed.length ? (
        <div className="grid gap-3 rounded-xl border border-warning/40 bg-warning/[0.07] p-3">
          <p className="text-sm font-medium text-strong">Only you can confirm these</p>
          {kept.length ? (
            <ul aria-label="Prices still from the template" className="flex flex-wrap gap-1.5">
              {kept.map((k) => (
                <li key={k.key}>
                  <button type="button" onClick={() => goTo("price")} className="rounded-full border border-border bg-card px-2.5 py-0.5 text-xs text-strong hover:border-brand-500/40 focus-visible:outline-2 focus-visible:outline-brand-500/50">
                    {k.label} <span className="tabular-nums text-muted-foreground">{k.value}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {spec.illustrative ? <Toggle label={kept.length ? "These prices are right for my market" : "I've replaced or confirmed every amount for my market"} tip="Template and imported amounts are examples until you say otherwise. Confirming is recorded with this version." checked={false} onChange={(on) => on && edit((s) => ({ ...s, illustrative: false }))} /> : null}
          {unconfirmed.map((r) => (
            <Toggle key={r.id} label={`My company has: ${r.label}`} description="Confirm only what is true today. It is recorded with this version." checked={false} onChange={(on) => on && edit((s) => ({ ...s, requirements: s.requirements.map((x) => (x.id === r.id ? { ...x, confirmed: true } : x)) }))} />
          ))}
        </div>
      ) : null}

      {blockers.length ? (
        <ReviewBlock title="To fix first">
          <ul className="grid gap-1">
            {blockers.map((b, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.05] px-3 py-1.5 text-sm text-strong">
                {b.message}
                {b.section !== "review" ? (
                  <Button size="xs" variant="ghost" onClick={() => goTo(b.section)}>
                    Fix
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </ReviewBlock>
      ) : null}
      {d && d.warnings.length ? (
        <ReviewBlock title="Worth a look">
          <ul className="grid gap-0.5 text-sm text-muted-foreground">
            {d.warnings.map((w) => (
              <li key={w}>• {w}</li>
            ))}
          </ul>
        </ReviewBlock>
      ) : null}

      {d ? (
        <ReviewBlock title="What publishing does">
          <ul className="grid gap-1 text-sm text-muted-foreground">
            {d.impact.map((line) => (
              <li key={line}>• {line}</li>
            ))}
          </ul>
          {preview.forms.length ? (
            <ul aria-label="Booking forms that offer it" className="mt-2 grid gap-1">
              {preview.forms.map((f) => (
                <li key={f.id}>
                  <Link href={`/app/agents/sales/booking-forms/${f.id}`} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-strong hover:border-brand-500/40">
                    {f.name}
                    <Badge variant={f.live ? "success" : "outline"} size="sm">
                      {f.live ? "Live form" : "Not published"}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </ReviewBlock>
      ) : null}

      <div className="grid gap-3 rounded-xl border border-border bg-card p-3">
        <Field label="Why this change" hint="Kept with the version, and read first by whoever reviews it.">
          <TextArea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Our supply and labor costs went up this year." />
        </Field>
        <button type="button" aria-expanded={more} onClick={() => setMore((v) => !v)} className="inline-flex w-fit items-center gap-1 rounded-md text-sm font-medium text-brand-300 focus-visible:outline-2 focus-visible:outline-brand-500/50">
          More options <ChevronDown aria-hidden className={cn("size-4 transition-transform motion-reduce:transition-none", more && "rotate-180")} />
        </button>
        {more ? (
          <div className="grid gap-3">
            <Toggle label="Customers need to be told" description="Booked visits keep their price either way. Use this when what customers see changes." checked={notice.required} onChange={(required) => setNotice({ ...notice, required })} />
            {notice.required ? <TextInput aria-label="What customers should be told" value={notice.note} onChange={(e) => setNotice({ ...notice, note: e.target.value })} placeholder="New price applies to bookings from March 1" /> : null}
            <Toggle label="Agreements need review" description="Signed agreements keep their terms until amended. Name the ones to look at." checked={contracts.required} onChange={(required) => setContracts({ ...contracts, required })} />
            {contracts.required ? <TextInput aria-label="Which agreements" value={contracts.note} onChange={(e) => setContracts({ ...contracts, note: e.target.value })} placeholder="Recurring service agreements" /> : null}
            <Field label="Takes effect" hint="Leave empty to take effect when published.">
              <TextInput type="date" value={startsOn} min={localDay(new Date())} onChange={(e) => setStartsOn(e.target.value)} />
            </Field>
          </div>
        ) : null}
        <FormError message={error} />
        <div className="flex flex-wrap gap-2">
          {preview.canPublish ? (
            <Button
              variant="primary"
              loading={busy}
              disabled={!canAct || open !== null}
              onClick={() =>
                void ask({
                  title: later.effectiveAt ? `Schedule ${spec.name || "this service"}?` : `Publish ${spec.name || "this service"}?`,
                  body: later.effectiveAt ? `It becomes the live version on ${day(later.effectiveAt)}.` : "It becomes the live version now.",
                  details: (d?.impact ?? []).slice(0, 4).map((line, i) => ({ label: i === 0 ? "What happens" : "", value: line })),
                  confirmLabel: later.effectiveAt ? "Schedule it" : "Publish",
                  cancelLabel: "Not yet",
                  action: async () => {
                    const settled = await settle();
                    if (settled === null || settled !== revision) throw new Error("Your latest edits were saved just now. Check the review again, then publish.");
                    await publish({ companyId, serviceId: view.service.id, expectedRevision: revision, reason, customerNotice: notice, contractReview: contracts, ...later });
                  },
                })
              }
            >
              {later.effectiveAt ? "Schedule" : "Publish"}
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={busy}
              disabled={!canAct || open !== null}
              onClick={() =>
                void run(async () => {
                  const { changeId } = await submit({ companyId, serviceId: view.service.id, expectedRevision: revision, reason, customerNotice: notice, contractReview: contracts, ...later });
                  router.push(changePath(changeId));
                })
              }
            >
              Submit for review
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void ask({
                title: "Throw away this draft?",
                body: view.live ? "Your edits since the live version are deleted. The live version is not affected." : "This service has never been live, so the whole service is removed.",
                details: [{ label: "Service", value: view.service.name }],
                confirmLabel: "Throw away the draft",
                cancelLabel: "Keep the draft",
                tone: "danger",
                action: async () => {
                  const { removed } = await discard({ companyId, serviceId: view.service.id });
                  router.push(removed ? SERVICES_ROOT : `${SERVICES_ROOT}/${view.service.id}`);
                },
              })
            }
          >
            Discard draft
          </Button>
        </div>
        {!behind && !reason.trim() && !nothing && blockers.length === 0 ? <p className="text-xs text-muted-foreground">Say why, and it can be {preview.canPublish ? "published" : "submitted"}.</p> : null}
        {!preview.canPublish ? <p className="text-xs text-muted-foreground">Only the Owner publishes. They see exactly this version.</p> : null}
      </div>
    </div>
  );
}

/** A date as the browser's own YYYY-MM-DD, to compare with a date input. */
function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function ReviewBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-1.5">
      <h3 className="text-sm font-medium text-strong">{title}</h3>
      {children}
    </section>
  );
}

// ── A live service ──────────────────────────────────────────────────────────────────────────────────

function LiveService({ view, costs }: { view: View; costs: Parameters<typeof ServicePreview>[0]["costs"] }) {
  const { companyId } = useCompany();
  const editLive = useMutation(api.services.editLive);
  const rollback = useMutation(api.services.startRollback);
  const archive = useMutation(api.services.requestArchive);
  const router = useRouter();
  const { busy, error, run } = useRun();
  const { ask, element: confirmDialog } = useConfirm();
  if (!view.live) {
    return (
      <Empty title="Nothing to show yet" action={<Link href={SERVICES_ROOT} className={buttonVariants({ variant: "secondary", size: "sm" })}>All services</Link>}>
        This service has no live version{view.draft ? ", and its draft is open to Owners and Managers" : ""}.
      </Empty>
    );
  }
  const spec = view.live.spec;
  return (
    <div className="grid grid-cols-1 gap-5">
      {confirmDialog}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={SERVICES_ROOT} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-strong">
            <ArrowLeft aria-hidden className="size-4" /> All services
          </Link>
          <h1 className="mt-1 font-heading text-2xl tracking-tight text-strong">{spec.name}</h1>
          <p className="text-sm text-muted-foreground">
            {CATEGORY_LABELS[spec.category]} · live version {view.live.version}
            {view.service.publishedAt ? ` since ${day(view.service.publishedAt)}` : ""} · {view.service.status === "archived" ? "archived: new visits cannot use it" : "used for new quotes and visits"}
          </p>
        </div>
        {view.canDraft ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" loading={busy} onClick={() => void run(async () => editLive({ companyId, serviceId: view.service.id }))}>
              Edit this service
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                const reason = window.prompt(view.service.status === "archived" ? "Why restore it?" : "Why stop offering it? Booked visits keep it.");
                if (!reason) return;
                void run(async () => {
                  const { changeId } = await archive({ companyId, serviceId: view.service.id, reason, restore: view.service.status === "archived" });
                  router.push(changePath(changeId));
                });
              }}
            >
              {view.service.status === "archived" ? "Ask to restore" : "Ask to archive"}
            </Button>
          </div>
        ) : null}
      </div>
      <FormError message={error} />
      <div className="grid grid-cols-1 gap-5 @4xl/main:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="grid grid-cols-1 gap-5">
          <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <SectionTitle title="Versions" tip="Every published version is kept exactly as it was. Rolling back writes a new version from an old one, so history is never rewritten." />
            <ol aria-label="Version history" className="relative grid grid-cols-1 gap-3 before:absolute before:top-2 before:bottom-2 before:left-[0.6875rem] before:w-px before:bg-border">
              {view.versions.map((v) => (
                <li key={v.version} className="relative flex items-start gap-3">
                  <span aria-hidden className={cn("relative z-10 mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular-nums ring-4 ring-card", v.live ? "bg-brand-500 text-white" : "border border-border bg-card text-muted-foreground")}>
                    {v.version}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium text-strong">Version {v.version}</span>
                        {v.live ? (
                          <Badge variant="success" size="sm">
                            Live
                          </Badge>
                        ) : null}
                        {v.source === "rollback" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                            <RollbackIcon aria-hidden className="size-3" /> from version {v.basedOn}
                          </span>
                        ) : null}
                      </p>
                      <p className="text-sm text-muted-foreground">{v.summary}</p>
                      <p className="text-xs text-muted-foreground">
                        {when(v.createdAt)} · {v.by}
                        {v.source === "settings" ? " · moved from Settings" : v.source !== "rollback" && v.basedOn ? ` · based on version ${v.basedOn}` : ""}
                      </p>
                    </div>
                    {!v.live && view.canDraft ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void ask({
                            title: `Start a draft from version ${v.version}?`,
                            body: "The live version stays as it is. The new draft goes through review like any other change.",
                            confirmLabel: "Start the draft",
                            cancelLabel: "Cancel",
                            action: () => rollback({ companyId, serviceId: view.service.id, version: v.version, replaceDraft: false }),
                          })
                        }
                      >
                        <RollbackIcon aria-hidden /> Roll back to this
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </div>
          {view.changes.length ? (
            <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
              <SectionTitle title="Changes" />
              <ul className="grid grid-cols-1 gap-1.5">
                {view.changes.map((c) => (
                  <li key={c.id}>
                    <Link href={changePath(c.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:border-brand-500/40">
                      <span>
                        <span className="text-strong">{c.title}</span>
                        <span className="block text-xs text-muted-foreground">Submitted {when(c.submittedAt)}{c.publishedAt ? ` · live ${when(c.publishedAt)}` : ""}</span>
                      </span>
                      <ChangeBadge state={c.state} />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <ServicePreview spec={spec} costs={costs} canSeeCosts={view.canPublish} />
      </div>
    </div>
  );
}
