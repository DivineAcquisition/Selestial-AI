import { ChildLinks, ParentLink } from "@/components/app/settings/section-links";
import { ViewOnlyNote } from "@/components/app/settings/view-only";
import { sectionById } from "@/lib/app/settings";

/**
 * A Settings page's title and one helpful sentence. Both come from the catalog, so the menu, the
 * search and the page never word them differently. People who cannot change the page are told so once.
 * A page reached from another page links back to it; a page with pages beneath it lists them last.
 */
export function SectionPage({ id, title, children }: { id: string; /** A heading for the page itself, when it reads better than the menu label. */ title?: string; children: React.ReactNode }) {
  const section = sectionById(id);
  if (!section) throw new Error(`No settings section named ${id}`);
  return (
    <>
      <header className="mb-5">
        {section.parent ? <ParentLink id={section.id} /> : null}
        <h1 className="font-heading text-2xl tracking-tight text-strong">{title ?? section.label}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{section.purpose}</p>
        <ViewOnlyNote id={section.id} />
      </header>
      {children}
      <ChildLinks id={section.id} />
    </>
  );
}
