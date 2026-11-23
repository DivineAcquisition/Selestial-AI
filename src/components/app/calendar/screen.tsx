"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useCompany } from "@/components/app/company";
import { useDetail } from "@/components/app/detail-panel";
import { Modal } from "@/components/app/modal";
import { NewVisitForm } from "@/components/app/screens/forms";
import { Incomplete } from "@/components/app/screens/dispatch/shared";
import { ChevronDown, ChevronLeft, ChevronRight, FunnelIcon, PanelLeftIcon, Plus, TriangleAlert, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/selection";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/components/app/use-now";
import { DEFAULT_LAYERS, EMPTY_STATE, LAYER_IDS, LAYER_LABEL, parsePreferences, parseState, preferencesKey, rangeFor, stepDate, VIEW_LABEL, VIEWS, writeState, type CalendarState, type LayerId, type View } from "@/lib/app/calendar";
import { localDate, whenLabel } from "@/lib/app/format";
import { linkTo } from "@/lib/app/navigation-helpers";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { InterviewForm, MemberHoursForm, TaskForm } from "./create-forms";
import { EVENT_KIND_LABEL, EventForm, type EventKind } from "./event-form";
import { ItemPanel, ITEM_PARAM } from "./item-panel";
import { MoveEventDialog, MoveVisitDialog } from "./move-dialog";
import { itemLabel, LAYER_LOOK, timeLabel, TimingMark, type CalendarData, type Item } from "./look";
import { Agenda, MonthGrid, TeamLanes, TimeGrid } from "./views";

// ── Remembered view and layers, per person and company ─────────────────────────────────────────────

function usePreferences(companyId: string) {
  const { userId } = useAuth();
  const key = preferencesKey(userId ?? "signed-out", companyId);
  const [saved] = useState(() => {
    try {
      return parsePreferences(typeof window === "undefined" ? null : window.localStorage.getItem(key));
    } catch {
      return parsePreferences(null);
    }
  });
  const remember = (state: CalendarState) => {
    try {
      window.localStorage.setItem(key, JSON.stringify({ view: state.view, layers: state.layers }));
    } catch {
      // Private browsing or a full disk: Calendar still works, it just is not remembered.
    }
  };
  return { saved, remember };
}

/** On a narrow screen the default is the readable list, not a seven-column grid. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

// ── Filters ─────────────────────────────────────────────────────────────────────────────────────────

const STATUS_FILTERS: { id: string; label: string; test: (item: Item) => boolean }[] = [
  { id: "attention", label: "Needs attention", test: (item) => item.problems.length > 0 },
  { id: "unstaffed", label: "Not fully staffed", test: (item) => ["booked", "offer_sent", "partly_staffed"].includes(item.status) },
  { id: "fully_staffed", label: "Fully staffed", test: (item) => item.status === "fully_staffed" },
  { id: "in_progress", label: "In progress", test: (item) => item.status === "in_progress" },
  { id: "under_review", label: "Done · under review", test: (item) => item.status === "under_review" },
  { id: "completed", label: "Completed or held", test: (item) => item.status === "completed" },
  { id: "proposed", label: "Proposed, not confirmed", test: (item) => item.timing === "proposed" },
  { id: "projected", label: "Projected, not booked", test: (item) => item.timing === "projected" },
  { id: "cancelled", label: "Cancelled", test: (item) => item.status === "cancelled" },
];

const AGENT_LABEL: Record<string, string> = { dispatch: "Dispatch", recruiter: "Recruiter", sales: "Sales", retention: "Retention", quality: "Quality" };

function applyFilters(items: Item[], state: CalendarState, data: CalendarData): Item[] {
  const crew = data.resources.crews.find((row) => row.id === state.cleaner);
  const cleaners = state.cleaner ? new Set(crew ? crew.cleanerIds : [state.cleaner]) : null;
  const status = STATUS_FILTERS.find((row) => row.id === state.status);
  return items.filter((item) => {
    // Cancelled visits stay in the record and are one filter away; they do not crowd the working view.
    if (item.status === "cancelled" && state.status !== "cancelled") return false;
    if (cleaners && !item.resources.some((row) => row.kind === "cleaner" && cleaners.has(row.id))) return false;
    if (state.member && !item.resources.some((row) => row.kind === "member" && row.id === state.member)) return false;
    if (state.customer && item.customerId !== state.customer) return false;
    if (state.agent && item.agent !== state.agent) return false;
    if (status && !status.test(item)) return false;
    return true;
  });
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string | null; options: { value: string; label: string }[]; onChange: (value: string | null) => void }) {
  const id = useId();
  return (
    <div className="grid min-w-[10rem] flex-1 gap-1 sm:max-w-[14rem]">
      <span id={id} className="text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      <Select aria-labelledby={id} value={value ?? ""} onValueChange={(next) => onChange(next || null)} options={options} emptyLabel="Any" placeholder="Any" searchable="auto" density="compact" />
    </div>
  );
}

// ── Create ──────────────────────────────────────────────────────────────────────────────────────────

type Creating = "visit" | "interview" | "task" | "hours" | EventKind;

const MENU_GROUP = "px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase";

/**
 * Everything Calendar can create, each through its own workflow: a booking through Sales, a visit
 * through Dispatch, an interview through Recruiter, a walkthrough from a Sales proposal, and Calendar's
 * own events. Office creates visits, bookings and Dispatch's dated tasks.
 */
function CreateMenu({ manager, onCreate }: { manager: boolean; onCreate: (what: Creating) => void }) {
  const [open, setOpen] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const menu = useId();
  const item = "flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-1.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-brand-500";
  const choose = (what: Creating) => {
    setOpen(false);
    onCreate(what);
  };
  const entry = (what: Creating, title: string, description: string) => (
    <button role="menuitem" type="button" className={item} onClick={() => choose(what)}>
      <span className="text-sm font-medium text-strong">{title}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </button>
  );
  return (
    <div
      ref={shell}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
      onBlur={(event) => {
        if (!shell.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Button variant="primary" size="sm" onClick={() => setOpen((before) => !before)} aria-haspopup="menu" aria-expanded={open} aria-controls={menu}>
        <Plus aria-hidden />
        Create
        <ChevronDown className="size-3.5" aria-hidden />
      </Button>
      {open ? (
        <div id={menu} role="menu" aria-label="Create" className="absolute right-0 z-popover mt-1 grid max-h-[min(36rem,80dvh)] w-80 gap-0.5 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-lg">
          <p className={MENU_GROUP} role="presentation">Cleaning</p>
          <Link role="menuitem" href="/app/agents/sales/new?mode=booking&from=calendar" className={item} onClick={() => setOpen(false)}>
            <span className="text-sm font-medium text-strong">Cleaning booking</span>
            <span className="text-xs text-muted-foreground">Service, price, property and recurrence, through Sales.</span>
          </Link>
          {entry("visit", "One visit", "A single visit at a set time, staffed by Dispatch.")}
          {manager ? (
            <>
              <Link role="menuitem" href="/app/agents/sales/new?mode=proposal&from=calendar" className={item} onClick={() => setOpen(false)}>
                <span className="text-sm font-medium text-strong">Estimate or walkthrough</span>
                <span className="text-xs text-muted-foreground">Starts a proposal in Sales, where the site walkthrough is booked.</span>
              </Link>
              {entry("inspection", "Inspection", "A quality inspection at a property, by a member or lead cleaner.")}
              <p className={MENU_GROUP} role="presentation">Team</p>
              {entry("interview", "Interview", "For an applicant Recruiter is waiting to interview.")}
              {entry("training", "Training session", "For new hires and cleaners, linked to their onboarding.")}
              {entry("unavailable", "Unavailable time", "An Owner or Manager away. Blocks only them.")}
              <p className={MENU_GROUP} role="presentation">Business</p>
              {entry("meeting", "Business event", "An internal meeting.")}
              {entry("appointment", "Appointment", "A manual appointment, such as a supplier call.")}
            </>
          ) : null}
          {entry("task", "Dated task", "A due date in an agent's queue. It reserves no time.")}
          {manager ? entry("hours", "Working hours", "When an Owner or Manager usually works, for conflict checks.") : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Needs attention ─────────────────────────────────────────────────────────────────────────────────

function Attention({ items, timezone, now, onOpen, onClose }: { items: Item[]; timezone: string; now: number; onOpen: (item: Item) => void; onClose?: () => void }) {
  return (
    <section aria-labelledby="calendar-attention" className="rounded-2xl border border-border bg-card">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 id="calendar-attention" className="flex items-center gap-1.5 text-sm font-semibold text-strong">
          <TriangleAlert className={cn("size-4", items.length ? "text-destructive-foreground" : "text-muted-foreground")} aria-hidden />
          Needs attention
          <span className="text-muted-foreground tabular-nums">{items.length}</span>
        </h2>
        {onClose ? (
          <Button variant="ghost" size="icon-sm" aria-label="Hide Needs attention" onClick={onClose}>
            <X aria-hidden />
          </Button>
        ) : null}
      </header>
      {items.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted-foreground">Nothing in this range needs you. Problems appear here as soon as the record shows them.</p>
      ) : (
        <ul className="max-h-[32rem] divide-y divide-border overflow-y-auto">
          {items.map((item) => (
            <li key={item.key}>
              <button type="button" onClick={() => onOpen(item)} aria-label={itemLabel(item, timezone)} className="grid w-full gap-0.5 px-4 py-2.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500">
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-strong">
                  <span className={cn("size-2 shrink-0 rounded-full", LAYER_LOOK[item.layer].swatch)} aria-hidden />
                  <span className="truncate">{item.title}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {whenLabel(item.startsAt, now, timezone)} · {timeLabel(item, timezone)}
                </span>
                {item.problems.slice(0, 3).map((words) => (
                  <span key={words} className="text-xs text-destructive-foreground">
                    {words}
                  </span>
                ))}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── The screen ──────────────────────────────────────────────────────────────────────────────────────

export function CalendarScreen() {
  const { companyId, timezone, role } = useCompany();
  const manager = role === "owner" || role === "manager";
  const now = useNow();
  const narrow = useNarrow();
  const openDetail = useDetail();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { saved, remember } = usePreferences(companyId);
  const state = parseState(params, saved.view ?? (narrow ? "agenda" : "week"));
  const layers: LayerId[] = state.layers ?? saved.layers ?? [...DEFAULT_LAYERS];
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [moving, setMoving] = useState<{ item: Item; to: { startsAt: number; endsAt: number } } | null>(null);
  /**
   * What can be dragged: a visit that has not started, and Calendar's own events that are still on, for
   * Owners and Managers. Projected visits, other records and anything private to someone else cannot.
   */
  const canMove = (item: Item) =>
    manager &&
    ((item.source.table === "jobs" && item.timing === "appointment" && ["booked", "offer_sent", "partly_staffed", "fully_staffed"].includes(item.status)) ||
      (item.source.table === "calendarEvents" && item.title !== "Busy" && !["completed", "cancelled"].includes(item.status)));

  // New things start on the day being looked at, or today.
  const createDay = state.date ?? (now ? localDate(now, timezone) : null);
  const range = useMemo(() => (now ? rangeFor(state.view, state.date, now, timezone) : null), [now, state.view, state.date, timezone]);
  const data = useQuery(api.calendar.range, range ? { companyId, from: range.from, to: range.to, layers } : "skip");

  const update = (change: Partial<CalendarState>) => {
    const next = { ...state, ...change };
    if (change.view || change.layers) remember({ ...next, layers: next.layers ?? layers });
    router.replace(`${pathname}?${writeState(next, params).toString()}`, { scroll: false });
  };

  const visible = useMemo(() => (data ? applyFilters(data.items, state, data) : []), [data, state]);
  const attention = visible.filter((item) => item.problems.length > 0 && item.timing !== "projected");
  const selectedKey = params.get(ITEM_PARAM);
  const selected = selectedKey && data ? (data.items.find((item) => item.key === selectedKey) ?? null) : null;

  const onOpen = (item: Item) => {
    // A visit and a task open in the shared record panel, the same one Dispatch and Approvals use.
    if (item.source.table === "jobs" && item.source.id) return openDetail({ kind: "job", id: item.source.id as never });
    if (item.source.table === "tasks") return openDetail({ kind: "task", id: item.source.id as never });
    const next = new URLSearchParams(params);
    next.set(ITEM_PARAM, item.key);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const closeItem = () => {
    const next = new URLSearchParams(params);
    next.delete(ITEM_PARAM);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  // Keyboard: T for today, the arrows for the previous and next range, when focus is not in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.altKey || event.ctrlKey || event.metaKey || !now) return;
      if (target && (target.closest("input, textarea, select, [contenteditable], [role=dialog], [role=menu], [role=listbox]") !== null)) return;
      if (event.key === "t" || event.key === "T") update({ date: null });
      else if (event.key === "ArrowLeft" && event.shiftKey) update({ date: stepDate(state.view, state.date, -1, now, timezone) });
      else if (event.key === "ArrowRight" && event.shiftKey) update({ date: stepDate(state.view, state.date, 1, now, timezone) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const allowed = (data?.layers ?? (manager ? LAYER_IDS : ["jobs", "availability", "deadlines"])) as LayerId[];
  const customers = data ? [...new Map(data.items.filter((item) => item.customerId && item.customerName).map((item) => [item.customerId!, item.customerName!])).entries()].sort((a, b) => a[1].localeCompare(b[1])) : [];
  const activeFilters = [state.cleaner, state.member, state.customer, state.status, state.agent].filter(Boolean).length;
  const zone = now ? new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" }).formatToParts(new Date(now)).find((part) => part.type === "timeZoneName")?.value : null;
  const dispatchSchedule = linkTo("dispatch.schedule");

  return (
    <div className="grid gap-3">
      {/* The toolbar: compact, and it wraps rather than scrolls on a narrow screen. */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="mr-1 font-heading text-2xl tracking-tight text-strong">Calendar</h1>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => update({ date: null })} aria-keyshortcuts="T">
            Today
          </Button>
          <Button variant="outline" size="icon-sm" aria-label={`Previous ${state.view === "month" ? "month" : state.view === "week" ? "week" : state.view === "agenda" ? "two weeks" : "day"}`} aria-keyshortcuts="Shift+ArrowLeft" onClick={() => now && update({ date: stepDate(state.view, state.date, -1, now, timezone) })}>
            <ChevronLeft aria-hidden />
          </Button>
          <Button variant="outline" size="icon-sm" aria-label={`Next ${state.view === "month" ? "month" : state.view === "week" ? "week" : state.view === "agenda" ? "two weeks" : "day"}`} aria-keyshortcuts="Shift+ArrowRight" onClick={() => now && update({ date: stepDate(state.view, state.date, 1, now, timezone) })}>
            <ChevronRight aria-hidden />
          </Button>
        </div>
        <p className="min-w-0 text-sm font-semibold text-strong" aria-live="polite">
          {range?.label ?? ""}
        </p>
        <span className="text-xs text-muted-foreground" title="Every time on this page is on the company's clock">
          {zone ? `Times in ${timezone.replace(/_/g, " ")} (${zone})` : null}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="View" className="inline-flex rounded-lg border border-border bg-muted p-0.5">
            {VIEWS.map((view) => (
              <button
                key={view}
                type="button"
                role="tab"
                aria-selected={state.view === view}
                onClick={() => update({ view })}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-brand-500", state.view === view ? "bg-card text-strong shadow-sm" : "text-muted-foreground hover:text-strong")}
              >
                {VIEW_LABEL[view as View]}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => setFiltersOpen((before) => !before)} aria-expanded={filtersOpen} aria-controls="calendar-filters">
            <FunnelIcon aria-hidden />
            Filters
            {activeFilters > 0 ? <span className="rounded-full bg-brand-500 px-1.5 text-[10px] font-semibold text-white tabular-nums">{activeFilters}</span> : null}
          </Button>
          <Button variant="ghost" size="icon-sm" className="hidden xl:inline-flex" aria-label={railOpen ? "Hide Needs attention" : "Show Needs attention"} aria-pressed={railOpen} onClick={() => setRailOpen((before) => !before)}>
            <PanelLeftIcon className="rotate-180" aria-hidden />
          </Button>
          <CreateMenu manager={manager} onCreate={setCreating} />
        </div>
      </header>

      {filtersOpen ? (
        <section id="calendar-filters" aria-label="Filters" className="grid gap-3 rounded-2xl border border-border bg-card p-3 sm:p-4">
          <fieldset className="flex flex-wrap gap-1.5">
            <legend className="mb-1.5 text-[11px] font-medium text-muted-foreground">Show</legend>
            {LAYER_IDS.filter((layer) => allowed.includes(layer)).map((layer) => {
              const on = layers.includes(layer);
              return (
                <button
                  key={layer}
                  type="button"
                  aria-pressed={on}
                  onClick={() => update({ layers: on ? layers.filter((row) => row !== layer) : LAYER_IDS.filter((row) => row === layer || layers.includes(row)) })}
                  className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-brand-500", on ? "border-brand-500/40 bg-brand-500/10 text-strong" : "border-border text-muted-foreground hover:text-strong")}
                >
                  <span className={cn("size-2 rounded-full", LAYER_LOOK[layer].swatch, !on && "opacity-40")} aria-hidden />
                  {LAYER_LABEL[layer]}
                </button>
              );
            })}
          </fieldset>
          <div className="flex flex-wrap items-end gap-3">
            <FilterSelect
              label="Cleaner or crew"
              value={state.cleaner}
              onChange={(cleaner) => update({ cleaner })}
              options={[...(data?.resources.crews ?? []).map((crew) => ({ value: crew.id, label: `Crew · ${crew.name}` })), ...(data?.resources.cleaners ?? []).map((cleaner) => ({ value: cleaner.id, label: cleaner.name }))]}
            />
            {manager ? <FilterSelect label="Responsible person" value={state.member} onChange={(member) => update({ member })} options={(data?.resources.members ?? []).map((member) => ({ value: member.id, label: member.name }))} /> : null}
            <FilterSelect label="Client" value={state.customer} onChange={(customer) => update({ customer })} options={customers.map(([value, label]) => ({ value, label }))} />
            <FilterSelect label="Status" value={state.status} onChange={(status) => update({ status })} options={STATUS_FILTERS.map((row) => ({ value: row.id, label: row.label }))} />
            <FilterSelect label="Agent" value={state.agent} onChange={(agent) => update({ agent })} options={Object.entries(AGENT_LABEL).map(([value, label]) => ({ value, label }))} />
            {activeFilters > 0 || state.layers !== null ? (
              <Button variant="ghost" size="sm" onClick={() => update({ ...EMPTY_STATE, view: state.view, date: state.date, layers: [...DEFAULT_LAYERS].filter((layer) => allowed.includes(layer)) })}>
                Clear filters
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {data?.limits.length ? <Incomplete what={`records (${data.limits.map((row) => row.source).join(", ")})`} /> : null}
      {data?.external && layers.includes("external") && data.external.state !== "connected" ? (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {data.external.state === "reconnect" ? `Google Calendar for ${data.external.email ?? "the company"} needs to be reconnected, so busy times are not shown. Calendar works without it.` : "No Google Calendar is connected, so outside busy times are not shown. Calendar works without one."}
          {manager ? (
            <Link href="/app/settings/integrations" className="shrink-0 font-medium text-brand-300 underline-offset-4 hover:underline">
              Integrations
            </Link>
          ) : null}
        </p>
      ) : null}

      {/* On a narrow screen Needs attention is a line that opens; on a wide one, a rail beside the calendar. */}
      {attention.length > 0 ? (
        <details className="rounded-xl border border-destructive/30 bg-destructive/5 xl:hidden">
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium text-destructive-foreground">
            <TriangleAlert className="size-4" aria-hidden />
            {attention.length} {attention.length === 1 ? "thing needs" : "things need"} attention
          </summary>
          <div className="p-2">
            <Attention items={attention} timezone={timezone} now={now} onOpen={onOpen} />
          </div>
        </details>
      ) : null}

      <div className={cn("grid items-start gap-3", railOpen && "xl:grid-cols-[minmax(0,1fr)_18rem]")}>
        <section aria-label={`${VIEW_LABEL[state.view]} view, ${range?.label ?? ""}`} className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card">
          {data === undefined || !range ? (
            <div className="grid gap-2 p-5" aria-busy="true">
              <Skeleton className="h-8" />
              <Skeleton className="h-64" />
            </div>
          ) : state.view === "month" ? (
            <MonthGrid range={range} items={visible} timezone={timezone} now={now} onOpen={onOpen} onDay={(date) => update({ view: "day", date })} />
          ) : state.view === "agenda" ? (
            <Agenda range={range} items={visible} timezone={timezone} now={now} onOpen={onOpen} />
          ) : state.view === "team" ? (
            <TeamLanes data={data} range={range} items={visible} timezone={timezone} onOpen={onOpen} cleanerIds={state.cleaner ? new Set(data.resources.crews.find((crew) => crew.id === state.cleaner)?.cleanerIds ?? [state.cleaner]) : null} />
          ) : (
            <TimeGrid range={range} items={visible} timezone={timezone} now={now} onOpen={onOpen} dense={state.view === "week"} canMove={canMove} onMove={(item, to) => setMoving({ item, to })} />
          )}
          {data && visible.length === 0 && state.view !== "agenda" ? (
            <p className="border-t border-border px-5 py-3 text-center text-xs text-muted-foreground">Nothing is scheduled here with the layers and filters chosen.</p>
          ) : null}
        </section>
        {railOpen ? (
          <aside className="hidden xl:block" aria-label="Needs attention">
            <Attention items={attention} timezone={timezone} now={now} onOpen={onOpen} onClose={() => setRailOpen(false)} />
          </aside>
        ) : null}
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {LAYER_IDS.filter((layer) => layers.includes(layer) && allowed.includes(layer)).map((layer) => (
          <span key={layer} className="inline-flex items-center gap-1.5">
            <span className={cn("size-2.5 rounded-sm", LAYER_LOOK[layer].swatch)} aria-hidden />
            {LAYER_LABEL[layer]}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <TimingMark item={{ timing: "proposed", problems: [] }} /> Proposed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <TimingMark item={{ timing: "projected", problems: [] }} /> Projected, not booked
        </span>
        <span className="inline-flex items-center gap-1.5">
          <TimingMark item={{ timing: "due", problems: [] }} /> Due date
        </span>
        {dispatchSchedule ? (
          <Link href={dispatchSchedule} className="ml-auto font-medium text-brand-300 underline-offset-4 hover:underline">
            Staffing view in Dispatch › Schedule
          </Link>
        ) : null}
        {data ? <span className="w-full">Visits keep {data.bufferMinutes} minutes between them for each cleaner. That is the company&apos;s setting, not a measured drive: travel time is not looked up.</span> : null}
      </footer>

      <ItemPanel item={selected} missing={Boolean(selectedKey) && data !== undefined && selected === null} timezone={timezone} onClose={closeItem} />

      <Modal open={moving !== null} onClose={() => setMoving(null)} title={moving?.item.source.table === "jobs" ? "Move the visit" : "Move the event"} description="Nothing is saved until you confirm.">
        {moving?.item.source.table === "jobs" ? (
          <MoveVisitDialog item={moving.item} proposed={moving.to} onDone={() => setMoving(null)} />
        ) : moving ? (
          <MoveEventDialog eventId={moving.item.source.id as Id<"calendarEvents">} proposed={moving.to} onDone={() => setMoving(null)} />
        ) : null}
      </Modal>
      <Modal open={creating === "visit"} onClose={() => setCreating(null)} title="Add a visit" description="A visit is a promise to the customer. It is staffed only when every cleaner it needs has accepted.">
        <NewVisitForm onDone={() => setCreating(null)} />
      </Modal>
      <Modal open={creating === "interview"} onClose={() => setCreating(null)} title="Book an interview">
        <InterviewForm day={createDay} onDone={() => setCreating(null)} />
      </Modal>
      <Modal open={creating === "task"} onClose={() => setCreating(null)} title="Add a dated task">
        <TaskForm day={createDay} onDone={() => setCreating(null)} />
      </Modal>
      <Modal open={creating === "hours"} onClose={() => setCreating(null)} title="Working hours">
        <MemberHoursForm onDone={() => setCreating(null)} />
      </Modal>
      {(["meeting", "appointment", "unavailable", "training", "inspection"] as const).map((kind) => (
        <Modal key={kind} open={creating === kind} onClose={() => setCreating(null)} title={EVENT_KIND_LABEL[kind].title}>
          <EventForm kind={kind} day={createDay} onDone={() => setCreating(null)} />
        </Modal>
      ))}
    </div>
  );
}
