"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/*
 * The application's layout, shared. docs/foundation/07-layout.md explains the rules; globals.css holds
 * the numbers ("Application layout" and "Overlay layers").
 *
 * Two kinds of thing live here:
 *
 * 1. Measurements. A few parts of the frame change size while a page is open: the header grows when a
 *    support banner appears, a booking's action bar appears on a phone, a save bar sticks to the bottom
 *    once there is something to save, the chat panel opens beside the page. Each one reports its real size
 *    into a CSS variable, and everything that must stay clear of it reads that variable. Nothing guesses.
 *
 * 2. Page layouts. Four shapes cover the product: a focused form, a wide workspace, a main area with an
 *    inspector beside it, and a record's detail view. Each is a width and a rhythm, never a second
 *    padding: the shell already provides the gutters.
 */

// ── Measurements ────────────────────────────────────────────────────────────────────────────────────

type Variable = "--app-chrome-height" | "--app-toolbar-height" | "--app-bottom-bar" | "--app-dock-lift" | "--app-panel-width";

const reported = new Map<Variable, Map<symbol, number>>();

/** Writes the largest size anyone has reported, or clears the variable so its default applies. */
function publish(name: Variable) {
  if (typeof document === "undefined") return;
  const values = [...(reported.get(name)?.values() ?? [])];
  const style = document.documentElement.style;
  if (values.length === 0) style.removeProperty(name);
  else style.setProperty(name, `${Math.max(...values)}px`);
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Reports an element's size into a layout variable for as long as it is mounted and `active`. An element
 * hidden by a breakpoint (display: none) reports zero, so a phone-only bar stops counting on a desk.
 * `measure` turns the element into the number to report; it defaults to its height.
 */
export function useLayoutVariable(name: Variable, ref: React.RefObject<HTMLElement | null>, active = true, measure: (element: HTMLElement) => number = (element) => element.getBoundingClientRect().height, onScroll = false) {
  const latest = useRef(measure);
  useIsomorphicLayoutEffect(() => {
    latest.current = measure;
  });
  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    const key = Symbol(name);
    const values = reported.get(name) ?? new Map<symbol, number>();
    reported.set(name, values);
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const visible = element.getClientRects().length > 0;
        const next = visible ? Math.max(0, Math.round(latest.current(element))) : 0;
        if (values.get(key) === next) return;
        values.set(key, next);
        publish(name);
      });
    };
    values.set(key, element.getClientRects().length > 0 ? Math.max(0, Math.round(latest.current(element))) : 0);
    publish(name);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update);
    if (onScroll) window.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update);
      values.delete(key);
      publish(name);
    };
  }, [name, ref, active, onScroll]);
}

/**
 * A page's own toolbar that sticks under the header (the booking workspace's top bar). It sits at
 * `top-app-chrome`; inspectors and anything else sticky start below it.
 */
export function useStickyToolbar(ref: React.RefObject<HTMLElement | null>, active = true) {
  // A toolbar that is only sticky from some width on reports nothing while it scrolls with the page.
  useLayoutVariable("--app-toolbar-height", ref, active, (element) => (getComputedStyle(element).position === "sticky" ? element.getBoundingClientRect().height : 0));
}

/**
 * How much of the bottom of the screen a bar takes up right now: from its top edge to the bottom of the
 * screen while it is on screen, nothing once it has scrolled away. Stuck to the bottom, that is its height
 * plus its offset; at the end of the page, where it rests in the flow, it is wherever it really sits.
 */
function coveredFromBottom(element: HTMLElement): number {
  const box = element.getBoundingClientRect();
  const screen = window.innerHeight;
  if (box.bottom <= 0 || box.top >= screen) return 0;
  return screen - box.top;
}

/**
 * A bar fixed to the bottom of the screen (a phone's booking summary, say). The page keeps room for it
 * under its last row, and the team console rises above it.
 */
export function useBottomBar(ref: React.RefObject<HTMLElement | null>, active = true) {
  useLayoutVariable("--app-bottom-bar", ref, active);
}

/**
 * A bar that sticks to the bottom of the page while there is something to do (a save bar with unsaved
 * changes, a step's footer). It sits in the page's flow, so it needs no extra room; only the team console
 * rises above it so neither covers the other.
 */
export function useDockLift(ref: React.RefObject<HTMLElement | null>, active = true) {
  useLayoutVariable("--app-dock-lift", ref, active, coveredFromBottom, true);
}

/**
 * A bar of actions that sticks to the bottom of the page while it is in use: a form's save area, a
 * review's "Apply" row. It stays in the page's flow, sits on the sticky layer, keeps clear of a phone's
 * home indicator, and lifts the team console above it while `active`.
 */
export function StickyBar({ active = true, className, children, ...rest }: { active?: boolean; className?: string; children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  const bar = useRef<HTMLDivElement>(null);
  useDockLift(bar, active);
  return (
    <div ref={bar} {...rest} className={cn(active && "sticky bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-sticky", className)}>
      {children}
    </div>
  );
}

// ── Page layouts ────────────────────────────────────────────────────────────────────────────────────

const WIDTH = {
  /** Settings, guided setup, one task at a time: a readable column. */
  focused: "max-w-(--app-width-focused)",
  /** A customer, a cleaner, a property, an agreement: room for a record and its side facts. */
  detail: "max-w-(--app-width-detail)",
  /** Tables, schedules, boards and pipelines: as wide as the frame allows. */
  wide: "max-w-(--app-width-wide)",
} as const;

export type PageWidth = keyof typeof WIDTH;

/**
 * One page's frame inside the shell. It sets a width and the space between sections, and nothing else:
 * the shell already provides the gutters, so a page never adds its own.
 */
export function Page({ width = "wide", className, children, ...rest }: { width?: PageWidth; className?: string; children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn("mx-auto grid w-full min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-5", WIDTH[width], className)}>
      {children}
    </div>
  );
}

/**
 * A main area with an inspector beside it: a builder and its preview, a booking and its summary. The two
 * sit side by side only when the space left after the sidebar and any open panel can hold both (a
 * container query on the page, not the screen width); otherwise the inspector follows the main area.
 * The inspector sticks below the header and scrolls on its own when it is taller than the screen.
 */
export function WithInspector({ inspector, inspectorLabel, children, className, inspectorClassName, stackedInspector = true }: { inspector: React.ReactNode; inspectorLabel: string; children: React.ReactNode; className?: string; inspectorClassName?: string; stackedInspector?: boolean }) {
  return (
    <div className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-5 @5xl/main:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] @5xl/main:gap-6", className)}>
      <div className="grid min-w-0 gap-5">{children}</div>
      <aside aria-label={inspectorLabel} className={cn("min-w-0 @5xl/main:sticky @5xl/main:top-app-sticky @5xl/main:max-h-app-sticky @5xl/main:overflow-y-auto", !stackedInspector && "hidden @5xl/main:block", inspectorClassName)}>
        {inspector}
      </aside>
    </div>
  );
}

/**
 * A page's title, its one-line purpose, and its actions. The title and description always start at the
 * same place. Actions go secondary first and the primary action last, so the primary is always at the
 * end of the row: the far right on a wide screen. On a narrow screen the actions drop below the title
 * and wrap, still in that order.
 */
export function PageHeader({ title, lead, actions, eyebrow, crumbs, className }: { title: React.ReactNode; lead?: React.ReactNode; actions?: React.ReactNode; eyebrow?: React.ReactNode; crumbs?: readonly { label: string; href?: string | null }[]; className?: string }) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0 flex-[1_1_20rem]">
        {crumbs && crumbs.length > 0 ? <Breadcrumbs crumbs={crumbs} /> : null}
        {eyebrow ? <p className="mb-1 text-[0.6875rem] font-semibold tracking-wide text-brand-600 uppercase">{eyebrow}</p> : null}
        <h1 className="font-heading text-2xl tracking-tight break-words text-strong">{title}</h1>
        {lead ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{lead}</p> : null}
      </div>
      {actions ? <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A trail back up: links for the steps that have a page, plain words for those that do not. */
export function Breadcrumbs({ crumbs }: { crumbs: readonly { label: string; href?: string | null }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-1.5">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        {crumbs.map((crumb, index) => (
          <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
            {index > 0 ? <span aria-hidden>›</span> : null}
            {crumb.href && index < crumbs.length - 1 ? (
              <Link href={crumb.href} className="truncate hover:text-strong hover:underline">
                {crumb.label}
              </Link>
            ) : (
              <span className="truncate" aria-current={index === crumbs.length - 1 ? "page" : undefined}>
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * A workspace's page tabs. When there are more tabs than room they scroll sideways inside their own strip;
 * the page itself never grows wider. The open tab is scrolled into view.
 */
export function PageTabs({ label, tabs, activeId }: { label: string; tabs: readonly { id: string; label: React.ReactNode; href: string; trailing?: React.ReactNode }[]; activeId: string | undefined }) {
  const strip = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const active = strip.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);
  return (
    <nav aria-label={label} className="min-w-0">
      <ul ref={strip} className="flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain border-b border-border [scrollbar-width:thin]">
        {tabs.map((tab) => (
          <li key={tab.id} className="shrink-0">
            <Link
              href={tab.href}
              aria-current={activeId === tab.id ? "page" : undefined}
              className={cn(
                "flex min-h-10 items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500/60",
                activeId === tab.id ? "border-brand-500 font-medium text-strong" : "border-transparent text-muted-foreground hover:text-strong",
              )}
            >
              {tab.label}
              {tab.trailing}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
