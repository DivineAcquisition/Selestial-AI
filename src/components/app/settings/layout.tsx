"use client";

import { BusinessDraftProvider } from "@/components/app/settings/business-draft";
import { SettingsNav } from "@/components/app/settings/nav";

/**
 * Every Settings page sits inside this: a secondary navigation beside the page when there is room for it. The business draft is
 * held here, above the pages, so edits survive moving between Settings pages.
 */
export function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <BusinessDraftProvider>
      {/*
        The menu sits beside the form only when the room left after the main sidebar can hold both with
        the form still comfortable; otherwise it is one compact bar above the form.
      */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 @4xl/main:grid-cols-[13.5rem_minmax(0,1fr)] @4xl/main:gap-6 @6xl/main:grid-cols-[15rem_minmax(0,1fr)] @6xl/main:gap-8">
        <SettingsNav />
        {/* A size container, so forms inside choose their columns from the room they have, not the screen width. */}
        <div className="@container min-w-0">{children}</div>
      </div>
    </BusinessDraftProvider>
  );
}
