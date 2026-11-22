"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";

import { agentPortrait } from "@/components/app/agent";
import { LogoMark } from "@/components/brand/logo";
import {
  BroomIcon,
  ChatIcon,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  DashboardIcon,
  FileText,
  GearIcon,
  Hand,
  HouseIcon,
  InsightsIcon,
  LightningIcon,
  PriceTagIcon,
  Search,
  SirenIcon,
  Sparkles,
  Wallet,
  type LucideIcon,
} from "@/components/icons";
import { agentBadge, approvalsBadge, tabBadge, type SidebarFacts } from "@/lib/app/badges";
import { DEPARTMENTS, FOOTER_ITEMS, PERSISTENT_ITEMS, SHARED_ITEMS, type AgentId, type AgentNav, type Badge, type DepartmentId, type NavItem, type NavItemId, type Role } from "@/lib/app/navigation";
import {
  activeFor,
  agentsIn,
  disclosedTabs,
  hrefFor,
  mayShow,
  parseSidebarState,
  selectDepartment,
  serializeSidebarState,
  sidebarStorageKey,
  syncToPath,
  toggleAgent,
  type SidebarState,
} from "@/lib/app/navigation-helpers";
import { cn } from "@/lib/utils";

// Everything below is drawn from src/lib/app/navigation.ts. This file adds only icons and markup.

const ITEM_ICON: Record<NavItemId, LucideIcon> = {
  home: DashboardIcon,
  approvals: Hand,
  inbox: ChatIcon,
  search: Search,
  chat: Sparkles,
  services: PriceTagIcon,
  customers: HouseIcon,
  agreements: FileText,
  cleaners: BroomIcon,
  finance: Wallet,
  reports: InsightsIcon,
  settings: GearIcon,
};

// ── Remembered state ────────────────────────────────────────────────────────────────────────────────

type Held = { key: string; path: string; state: SidebarState };
type SidebarStore = { state: SidebarState; update: (change: (state: SidebarState) => SidebarState) => void };
const SidebarContext = createContext<SidebarStore | null>(null);

function stored(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Holds the selected department and the open agents for one person in one company, and keeps them
 * across visits. One store serves both the desktop sidebar and the phone drawer, so they never disagree.
 */
export function SidebarStateProvider({ userId, companyId, children }: { userId: string; companyId: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const key = sidebarStorageKey(userId, companyId);
  const fresh = (): Held => ({ key, path: pathname, state: syncToPath(parseSidebarState(stored(key)), pathname) });
  const [held, setHeld] = useState<Held>(fresh);

  // Arriving somewhere new, by a click or a deep link, opens the agent that page belongs to. Staying on a
  // page changes nothing, so a person can switch department or close an agent while they are on its page.
  let current = held;
  if (held.key !== key) {
    current = fresh();
    setHeld(current);
  } else if (held.path !== pathname) {
    current = { ...held, path: pathname, state: syncToPath(held.state, pathname) };
    setHeld(current);
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(current.key, serializeSidebarState(current.state));
    } catch {
      // Private browsing or a full disk: the sidebar still works, it just is not remembered.
    }
  }, [current.key, current.state]);

  const update: SidebarStore["update"] = (change) => setHeld((before) => ({ ...before, state: change(before.state) }));
  return <SidebarContext.Provider value={{ state: current.state, update }}>{children}</SidebarContext.Provider>;
}

function useSidebarStore(): SidebarStore {
  const store = useContext(SidebarContext);
  if (!store) throw new Error("The sidebar needs a SidebarStateProvider");
  return store;
}

// ── Badges ──────────────────────────────────────────────────────────────────────────────────────────

const BADGE: Record<Badge["kind"], { icon: LucideIcon; tone: string; word: string }> = {
  urgent: { icon: SirenIcon, tone: "border-destructive/40 bg-destructive/10 text-destructive-foreground", word: "Urgent" },
  decision: { icon: Hand, tone: "border-warning/50 bg-warning/15 text-warning-foreground", word: "Needs your decision" },
  attention: { icon: CircleDashed, tone: "border-info/40 bg-info/10 text-info-foreground", word: "To look at" },
  working: { icon: LightningIcon, tone: "border-border bg-muted text-muted-foreground", word: "In progress" },
};

/**
 * A badge is words with an icon. The color only reinforces what the words already say. It never grows
 * past its row: a long label is cut short on screen, and the whole label stays in its accessible name and
 * its tooltip.
 */
function NavBadge({ badge }: { badge: Badge }) {
  const look = BADGE[badge.kind];
  const Icon = look.icon;
  return (
    <span title={badge.label} className={cn("inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-semibold", look.tone)}>
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="sr-only">{look.word}: </span>
      <span className="min-w-0 truncate">{badge.label}</span>
    </span>
  );
}

function NotBuilt({ quiet }: { quiet?: boolean }) {
  return quiet ? <span className="sr-only"> (not built yet)</span> : <span className="shrink-0 rounded-full border border-dashed border-border px-1.5 py-0.5 text-[10px] leading-none font-medium whitespace-nowrap text-muted-foreground">Not built yet</span>;
}

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────────

/*
 * Every row in the sidebar sits on the same columns, so icons, avatars, names, badges and arrows line up
 * whichever section or department they are in:
 *
 *   | 8px | 24px mark | 10px | name (and status beneath it) ……… | trailing: badge or 32px arrow |
 *
 * A work tab sits on a guide line drawn through the centre of the mark column, and its name starts where
 * an agent's name starts. The numbers live here once: MARK is the mark column, INSET the child inset.
 */
const row = "flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium";
const MARK = "flex size-6 shrink-0 items-center justify-center";
/** The guide line sits under the middle of the mark column (8px padding + 12px). */
const GUIDE = "ml-5 border-l border-border";
/** A work tab's name starts in the name column: 8 + 24 + 10 = 42px from the row's edge, less the 21px guide. */
const INSET = "pl-[1.3125rem]";
const linked = "text-muted-foreground hover:bg-muted hover:text-strong focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500";
const current = "bg-brand-950 text-brand-300";
const arrow =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-strong focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500";

/** The arrow that opens and closes a group. One icon, turned, so open and closed read as one control. */
function Disclosure({ open, controls, label, onToggle }: { open: boolean; controls: string; label: string; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={controls} aria-label={label} className={arrow}>
      <ChevronRight className={cn("size-3.5 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
    </button>
  );
}

/** A company-wide destination. One that is not built is listed and says so; it is not a link. */
function ItemRow({ item, active, badge, onNavigate }: { item: NavItem; active: boolean; badge?: Badge | null; onNavigate?: () => void }) {
  const Icon = ITEM_ICON[item.id];
  const href = hrefFor(item);
  const inner = (
    <>
      <span className={MARK}>
        <Icon className={cn("size-[18px]", active && "text-brand-300")} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {href === null ? <NotBuilt /> : badge ? <span className="flex max-w-[55%] min-w-0 justify-end">{<NavBadge badge={badge} />}</span> : null}
    </>
  );
  if (href === null) {
    return (
      <span className={cn(row, "text-muted-foreground/70")} aria-disabled="true">
        {inner}
      </span>
    );
  }
  return (
    <Link href={href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={cn(row, active ? current : linked)}>
      {inner}
    </Link>
  );
}

/** A work tab, or any link listed inside a group. Same height, same inset, everywhere. */
function ChildRow({ href, label, on, onNavigate, trailing, ariaLabel, muted }: { href: string | null; label: string; on?: boolean; onNavigate?: () => void; trailing?: React.ReactNode; ariaLabel?: string; muted?: boolean }) {
  const classes = cn("relative flex min-h-8 min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-[13px]", INSET);
  if (href === null) {
    return (
      <span className={cn(classes, "text-muted-foreground/70")} aria-disabled="true">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {trailing}
      </span>
    );
  }
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={on ? "page" : undefined}
      aria-label={ariaLabel}
      className={cn(
        classes,
        "font-medium",
        // The active tab is marked on the guide line as well as by its fill, so it is found at a glance.
        on ? cn(current, "before:absolute before:inset-y-1.5 before:-left-px before:w-0.5 before:rounded-full before:bg-brand-500") : muted ? cn(linked, "text-muted-foreground/80") : linked,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </Link>
  );
}

/**
 * One agent: a name that opens its overview, a separate arrow that only opens and closes its work tabs,
 * the tabs themselves, and one status beneath the name. The two controls never do each other's job, and
 * neither sits inside the other.
 */
function AgentRow({ agent, open, active, facts, onToggle, onNavigate }: { agent: AgentNav; open: boolean; active: { agent: AgentId | null; tab: string | null }; facts?: SidebarFacts; onToggle: () => void; onNavigate?: () => void }) {
  const panel = useId();
  const built = agent.workflow === "built";
  // An agent that is not released opens its coming-soon page, at the path its overview will have.
  const notice = agent.overview.availability.status === "planned" && agent.overview.availability.notice === true;
  const overview = hrefFor(agent.overview) ?? (notice ? agent.overview.path : null);
  const here = active.agent === agent.id;
  const onOverview = here && active.tab === null;
  const badge = built ? agentBadge(agent.id, facts) : null;
  const tabs = disclosedTabs(agent);
  const expandable = tabs.length > 0;
  const status = built ? badge ? <NavBadge badge={badge} /> : null : <span className="text-[11px] leading-none font-medium text-brand-300">Coming soon</span>;
  const name = (
    <>
      <span className={MARK}>
        <Image src={agentPortrait(agent.id)} alt="" width={48} height={48} aria-hidden className={cn("size-6 rounded-full object-cover ring-1", built ? "ring-brand-500/30" : "opacity-50 grayscale ring-border")} />
      </span>
      <span className="grid min-w-0 flex-1 gap-1">
        <span className={cn("truncate", here && !onOverview && "font-semibold text-strong")}>{agent.label}</span>
        {status ? <span className="flex min-w-0">{status}</span> : null}
      </span>
    </>
  );
  return (
    <li>
      {/* The open overview fills the whole row, arrow column included, so the highlight reads as one line. */}
      <div className={cn("flex items-center gap-0.5 rounded-lg", onOverview && current)}>
        {overview ? (
          <Link href={overview} onClick={onNavigate} aria-current={onOverview ? "page" : undefined} className={cn(row, "flex-1", onOverview ? "text-brand-300 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500" : linked)}>
            {name}
          </Link>
        ) : (
          // No overview page exists for this agent yet, so its name is not a link. It does not toggle the tabs either.
          <span className={cn(row, "flex-1", built ? "text-strong" : "text-muted-foreground/80")}>{name}</span>
        )}
        {expandable ? <Disclosure open={open} controls={panel} label={`${agent.label}’s work tabs`} onToggle={onToggle} /> : <span className="size-8 shrink-0" aria-hidden />}
      </div>
      {expandable && open ? (
        <ul id={panel} aria-label={`${agent.label}’s work tabs`} className={cn("mt-0.5 mb-1.5 grid gap-0.5", GUIDE)}>
          {tabs.map((tab) => {
            const href = hrefFor(tab);
            const mark = tabBadge(agent.id, tab.id, facts);
            return (
              <li key={tab.id}>
                <ChildRow
                  href={href}
                  label={tab.label}
                  on={here && active.tab === tab.id}
                  onNavigate={onNavigate}
                  muted={!built}
                  trailing={href === null ? <NotBuilt quiet={!built} /> : mark ? <span className="flex max-w-[60%] min-w-0 justify-end"><NavBadge badge={mark} /></span> : null}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Chat, under Company. The name opens the conversation workspace; the separate arrow only shows and
 * hides previous chats, and never starts a new one. The list itself comes from the live record.
 */
function ChatRow({ item, active, onNavigate, sessions }: { item: NavItem; active: boolean; onNavigate?: () => void; sessions?: (onNavigate?: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const href = hrefFor(item) ?? item.path;
  return (
    <li>
      <div className={cn("flex items-center gap-0.5 rounded-lg", active && current)}>
        <Link href={href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={cn(row, "flex-1", active ? "text-brand-300 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500" : linked)}>
          <span className={MARK}>
            <Sparkles className={cn("size-[18px]", active && "text-brand-300")} aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
        </Link>
        {sessions ? <Disclosure open={open} controls={panel} label="Previous chats" onToggle={() => setOpen((before) => !before)} /> : null}
      </div>
      {open && sessions ? (
        <div id={panel} className={cn("mt-0.5 mb-1.5 py-0.5", GUIDE, INSET)}>
          {sessions(onNavigate)}
        </div>
      ) : null}
    </li>
  );
}

// ── Business selector ───────────────────────────────────────────────────────────────────────────────

export type BusinessOption = { companyId: string; name: string };

/** The active cleaning company. Choosing another changes the whole workspace and its data. */
function BusinessSelector({ company, businesses, activeId, onSwitch }: { company: string; businesses: BusinessOption[]; activeId: string; onSwitch: (companyId: string) => void }) {
  const [open, setOpen] = useState(false);
  const menu = useId();
  const shell = useRef<HTMLDivElement>(null);
  const label = (
    <>
      <LogoMark className="size-7 shrink-0" />
      <span className="min-w-0 flex-1 text-left">
        {/* Two lines before it is cut short, and the full name in the tooltip: a long company name stays readable. */}
        <span title={company} className="line-clamp-2 text-sm leading-snug font-semibold break-words text-strong">
          {company}
        </span>
        <span className="block text-[11px] text-muted-foreground">Selestial</span>
      </span>
    </>
  );
  // With one company there is nothing to choose, so it is shown and not offered as a control.
  if (businesses.length < 2) return <div className="flex min-h-16 items-center gap-2.5 border-b border-border px-[1.125rem] py-3">{label}</div>;
  return (
    <div
      ref={shell}
      className="relative border-b border-border px-3 py-2"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
      onBlur={(event) => {
        if (!shell.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((before) => !before)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menu}
        className="flex min-h-12 w-full items-center gap-2.5 rounded-xl px-1.5 py-1.5 hover:bg-muted focus-visible:outline-2 focus-visible:outline-brand-500"
      >
        {label}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {open ? (
        <ul id={menu} role="menu" aria-label="Switch company" className="absolute inset-x-3 top-full z-popover mt-1 grid max-h-[min(20rem,60dvh)] gap-0.5 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-lg">
          {businesses.map((business) => {
            const active = business.companyId === activeId;
            return (
              <li key={business.companyId} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => {
                    setOpen(false);
                    if (!active) onSwitch(business.companyId);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-strong hover:bg-muted focus-visible:outline-2 focus-visible:outline-brand-500"
                >
                  <span className="min-w-0 flex-1 break-words">{business.name}</span>
                  {active ? <Check className="size-4 shrink-0 text-brand-300" aria-label="Current company" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// ── Department tabs ─────────────────────────────────────────────────────────────────────────────────

/**
 * Choosing a department changes which agents are listed. It goes nowhere and filters nothing else. A
 * small mark shows which department holds the page that is open, so it can be found again after
 * browsing another department.
 */
function DepartmentTabs({ selected, onSelect, panelId, tabId, holdsCurrent }: { selected: DepartmentId; onSelect: (department: DepartmentId) => void; panelId: string; tabId: (department: DepartmentId) => string; holdsCurrent: DepartmentId | null }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const go = (index: number) => {
    const next = DEPARTMENTS[(index + DEPARTMENTS.length) % DEPARTMENTS.length];
    onSelect(next.id);
    refs.current[next.id]?.focus();
  };
  const at = DEPARTMENTS.findIndex((department) => department.id === selected);
  return (
    <div
      role="tablist"
      aria-label="Department"
      className="grid grid-cols-3 gap-0.5 rounded-xl border border-border bg-muted p-0.5"
      onKeyDown={(event) => {
        const keys: Record<string, number> = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: DEPARTMENTS.length - 1 };
        if (!(event.key in keys)) return;
        event.preventDefault();
        go(keys[event.key]);
      }}
    >
      {DEPARTMENTS.map((department) => {
        const on = department.id === selected;
        const here = holdsCurrent === department.id && !on;
        return (
          <button
            key={department.id}
            id={tabId(department.id)}
            ref={(node) => {
              refs.current[department.id] = node;
            }}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={panelId}
            tabIndex={on ? 0 : -1}
            onClick={() => onSelect(department.id)}
            className={cn(
              "relative min-h-8 min-w-0 truncate rounded-[10px] px-1.5 text-xs font-semibold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500",
              on ? "bg-card text-strong shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-strong",
            )}
          >
            {department.label}
            {here ? (
              <>
                <span className="absolute top-1 right-1 size-1.5 rounded-full bg-brand-500" aria-hidden />
                <span className="sr-only"> (the open page is here)</span>
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ── The sidebar ─────────────────────────────────────────────────────────────────────────────────────

const heading = "px-2 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase";

/**
 * Keeps the open page's link on screen. It scrolls only when that link is out of view, and only when
 * the page changes, so browsing the list never jumps back.
 */
function useActiveInView(container: React.RefObject<HTMLElement | null>, pathname: string) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const box = container.current;
      const link = box?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!box || !link) return;
      const outer = box.getBoundingClientRect();
      const inner = link.getBoundingClientRect();
      if (inner.top < outer.top || inner.bottom > outer.bottom) link.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [container, pathname]);
}

/**
 * The sidebar, in its fixed order (SIDEBAR_SECTIONS): business, the company-wide shortcuts, the
 * department tabs with the agents they list directly beneath them, the shared records, and Settings.
 *
 * `onNavigate` is called when a destination is chosen, so a phone's drawer can close. Choosing a
 * department or pressing an agent's arrow does not call it.
 */
export function Sidebar({
  company,
  companyId,
  businesses,
  onSwitchBusiness,
  role,
  facts,
  onNavigate,
  chatSessions,
}: {
  company: string;
  companyId: string;
  businesses: BusinessOption[];
  onSwitchBusiness: (companyId: string) => void;
  role: Role;
  /** The record's facts behind the badges. Undefined while loading: no badge is shown, never a guessed one. */
  facts?: SidebarFacts;
  onNavigate?: () => void;
  /** Previous chats under Chat, drawn by the caller from the live record. */
  chatSessions?: (onNavigate?: () => void) => React.ReactNode;
}) {
  const pathname = usePathname();
  const { state, update } = useSidebarStore();
  const active = activeFor(pathname);
  const ids = useId();
  const panelId = `${ids}-agents`;
  const tabId = (department: DepartmentId) => `${ids}-tab-${department}`;
  const scroller = useRef<HTMLDivElement>(null);
  useActiveInView(scroller, pathname);
  // Showing a link is a courtesy. Whether a person may read or change anything is decided in Convex.
  const shown = (items: readonly NavItem[]) => items.filter((item) => mayShow(item, role));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BusinessSelector company={company} businesses={businesses} activeId={companyId} onSwitch={onSwitchBusiness} />

      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
        <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-3 pt-3 pb-3">
          <ul className="grid gap-0.5" aria-label="Company-wide">
            {shown(PERSISTENT_ITEMS).map((item) => (
              <li key={item.id}>
                <ItemRow item={item} active={active.item === item.id} badge={item.id === "approvals" ? approvalsBadge(facts) : null} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>

          <section aria-labelledby={`${ids}-agents-heading`} className="grid gap-2">
            <h2 id={`${ids}-agents-heading`} className={heading}>
              Agents
            </h2>
            <DepartmentTabs selected={state.department} onSelect={(next) => update((before) => selectDepartment(before, next))} panelId={panelId} tabId={tabId} holdsCurrent={active.department} />
            <ul id={panelId} role="tabpanel" aria-labelledby={tabId(state.department)} className="grid gap-0.5">
              {agentsIn(state.department).map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  open={state.expanded.includes(agent.id)}
                  active={active}
                  facts={facts}
                  onToggle={() => update((before) => toggleAgent(before, agent.id))}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          </section>

          <section aria-labelledby={`${ids}-company-heading`} className="grid gap-2">
            <h2 id={`${ids}-company-heading`} className={heading}>
              Company
            </h2>
            <ul className="grid gap-0.5">
              {shown(SHARED_ITEMS).map((item) =>
                item.id === "chat" ? (
                  <ChatRow key={item.id} item={item} active={active.item === item.id} onNavigate={onNavigate} sessions={chatSessions} />
                ) : (
                  <li key={item.id}>
                    <ItemRow item={item} active={active.item === item.id} onNavigate={onNavigate} />
                  </li>
                ),
              )}
            </ul>
          </section>
        </div>

        {/* Settings stays in reach at the bottom, whatever is open above it. */}
        <ul className="grid gap-0.5 border-t border-border px-3 py-2.5">
          {shown(FOOTER_ITEMS).map((item) => (
            <li key={item.id}>
              <ItemRow item={item} active={active.item === item.id} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
