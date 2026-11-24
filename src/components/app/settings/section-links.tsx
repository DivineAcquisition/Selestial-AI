"use client";

import Link from "next/link";

import { useCompany } from "@/components/app/company";
import { SectionMark } from "@/components/app/settings/marks";
import { ChevronLeft, ChevronRight } from "@/components/icons";
import { childSections, mayOpen, sectionById, sectionsFor, type SettingsRole, type SettingsSection } from "@/lib/app/settings";

/** The pages reached from this one, as a short list. Hook-free, so it renders the same on the server. */
export function ChildLinksList({ rows }: { rows: readonly SettingsSection[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Also in this section" className="mt-8 rounded-2xl border border-border bg-card">
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.id}>
            <Link href={row.path} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500 sm:px-5">
              <SectionMark id={row.id} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-strong">{row.label}</span>
                <span className="block text-xs text-muted-foreground">{row.purpose}</span>
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export const childLinksFor = (id: string, role: SettingsRole) => childSections(id, sectionsFor(role));

/** Pages reached from this one that the signed-in role may open, e.g. Activity history under My account & security. */
export function ChildLinks({ id }: { id: string }) {
  const { role } = useCompany();
  return <ChildLinksList rows={childLinksFor(id, role)} />;
}

/** On a page reached from another page: the way back to it. */
export function ParentLink({ id }: { id: string }) {
  const { role } = useCompany();
  const parent = sectionById(sectionById(id)?.parent ?? "");
  if (!parent || !mayOpen(parent, role)) return null;
  return (
    <Link href={parent.path} className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-strong">
      <ChevronLeft aria-hidden className="size-3.5" />
      {parent.label}
    </Link>
  );
}
