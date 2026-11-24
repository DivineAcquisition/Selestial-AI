"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useMemo, useState } from "react";

import { useCompany } from "@/components/app/company";
import { SectionMark } from "@/components/app/settings/marks";
import { ArrowUpRight, ChevronDown, Search } from "@/components/icons";
import { Sheet, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { menuSectionForPath, menuSections, SETTINGS_GROUPS, SETTINGS_ROOT, searchSections, searchShortcuts, sectionsFor, type SettingsRole, type SettingsSection, type SettingsShortcut } from "@/lib/app/settings";
import { cn } from "@/lib/utils";

/** The list itself, free of hooks, so it renders the same on the server and is easy to check. */
export function SettingsNavList({ sections, shortcuts = [], activeId, onNavigate, showPurpose = false }: { sections: readonly SettingsSection[]; shortcuts?: readonly SettingsShortcut[]; activeId: string | undefined; onNavigate?: () => void; showPurpose?: boolean }) {
  if (sections.length === 0 && shortcuts.length === 0) return <p className="px-2 py-3 text-sm text-muted-foreground">No settings match that. Try another word, like &ldquo;hours&rdquo; or &ldquo;invoices&rdquo;.</p>;
  return (
    <div className="grid gap-4">
      {SETTINGS_GROUPS.map((group) => {
        const rows = sections.filter((row) => row.group === group.id);
        if (rows.length === 0) return null;
        return (
          <div key={group.id}>
            <p className="px-2 text-[0.6875rem] font-semibold tracking-wide text-muted-foreground uppercase">{group.label}</p>
            <ul className="mt-1 grid gap-0.5">
              {rows.map((row) => {
                const active = activeId === row.id;
                return (
                  <li key={row.id}>
                    <Link
                      href={row.path}
                      aria-current={active ? "page" : undefined}
                      onClick={onNavigate}
                      className={cn(
                        "relative flex items-start gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500",
                        active ? "bg-brand-500/10 font-medium text-strong before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-brand-500" : "text-muted-foreground hover:bg-muted hover:text-strong",
                      )}
                    >
                      <SectionMark id={row.id} size="sm" />
                      <span className="min-w-0 pt-0.5">
                        <span className="block">{row.label}</span>
                        {showPurpose ? <span className="mt-0.5 block text-xs font-normal leading-snug text-muted-foreground">{row.purpose}</span> : null}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {shortcuts.length > 0 ? (
        <div>
          <p className="px-2 text-[0.6875rem] font-semibold tracking-wide text-muted-foreground uppercase">Elsewhere in Selestial</p>
          <ul className="mt-1 grid gap-0.5">
            {shortcuts.map((row) => (
              <li key={row.id}>
                <Link href={row.href} onClick={onNavigate} className="flex items-start gap-2.5 rounded-lg px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500">
                  <ArrowUpRight aria-hidden className="mt-1 size-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-strong">
                      {row.label} <span className="font-normal text-muted-foreground">· {row.where}</span>
                    </span>
                    <span className="mt-0.5 block text-xs leading-snug">{row.purpose}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the menu lists for a search. Empty: the menu itself. Otherwise every page the role may open
 * that matches, including pages reached from another page, and settings that live in other workspaces.
 */
export function navResults(query: string, role: SettingsRole) {
  const open = sectionsFor(role).filter((row) => !row.oldAddress);
  const searching = query.trim().length > 0;
  return { sections: searching ? searchSections(query, open) : menuSections(open), shortcuts: searchShortcuts(query, role), searching };
}

function SearchBox({ id, value, onChange, autoFocus }: { id: string; value: string; onChange: (value: string) => void; autoFocus?: boolean }) {
  return (
    <div className="relative mb-3">
      <label className="sr-only" htmlFor={id}>
        Search settings
      </label>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        id={id}
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search settings"
        autoComplete="off"
        className="block min-h-10 w-full rounded-lg border border-border bg-card py-1.5 pr-3 pl-8 text-sm text-strong placeholder:text-muted-foreground/70 focus-visible:border-brand-500/60 focus-visible:outline-2 focus-visible:outline-brand-500/30"
      />
    </div>
  );
}

/**
 * The Settings menu. Beside the page on a wide screen. On a phone it is one compact bar naming the
 * current page; the full menu opens over the page, so the form is never pushed below a long list.
 * Only the pages the signed-in role may open are listed, and a search narrows them.
 */
export function SettingsNav() {
  const { role } = useCompany();
  const pathname = usePathname() ?? SETTINGS_ROOT;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const id = useId();
  const { sections, shortcuts, searching } = useMemo(() => navResults(query, role), [query, role]);
  const current = menuSectionForPath(pathname);
  const onOverview = pathname.replace(/\/+$/, "") === SETTINGS_ROOT;

  // The shared sheet traps focus, returns it to "All settings" on close, locks the page behind it and closes on Escape.
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const close = () => onOpenChange(false);

  const overviewLink = (onClick?: () => void) => (
    <Link
      href={SETTINGS_ROOT}
      onClick={onClick}
      aria-current={onOverview ? "page" : undefined}
      className={cn("mb-3 block rounded-lg px-2 py-1.5 text-sm", onOverview ? "bg-brand-500/10 font-medium text-strong" : "text-muted-foreground hover:bg-muted hover:text-strong")}
    >
      Overview
    </Link>
  );

  return (
    <>
      {/* Without room beside the form: one bar. */}
      <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2 @4xl/main:hidden">
        <div className="min-w-0">
          <Link href={SETTINGS_ROOT} className="text-xs text-muted-foreground hover:text-strong">
            Settings
          </Link>
          <p className="truncate text-sm font-medium text-strong">{onOverview ? "Overview" : (current?.label ?? "Settings")}</p>
        </div>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-strong focus-visible:outline-2 focus-visible:outline-brand-500"
        >
          All settings
          <ChevronDown aria-hidden className="size-4" />
        </button>
      </div>

      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetPopup side="bottom" className="max-h-[85dvh] rounded-t-2xl bg-card">
          <div className="min-h-0 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <SheetTitle className="mb-3 pr-10 text-base text-strong">All settings</SheetTitle>
            <SearchBox id={`${id}-search-sheet`} value={query} onChange={setQuery} />
            {overviewLink(close)}
            <SettingsNavList sections={sections} shortcuts={shortcuts} activeId={onOverview ? undefined : current?.id} onNavigate={close} showPurpose={searching} />
          </div>
        </SheetPopup>
      </Sheet>

      {/* With room beside the form: a grouped menu. */}
      <nav aria-label="Settings" className="hidden rounded-2xl border border-border bg-card p-3 @4xl/main:sticky @4xl/main:top-app-sticky @4xl/main:block @4xl/main:max-h-app-sticky @4xl/main:self-start @4xl/main:overflow-y-auto">
        <SearchBox id={`${id}-search`} value={query} onChange={setQuery} />
        {overviewLink()}
        <SettingsNavList sections={sections} shortcuts={shortcuts} activeId={onOverview ? undefined : current?.id} showPurpose={searching} />
      </nav>
    </>
  );
}
