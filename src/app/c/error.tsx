"use client";

import { ConvexError } from "convex/values";

import { Notice, Page } from "@/components/cleaner/shell";

/** A link that names nothing, or a page that could not load. The same words either way: nothing about why. */
export default function CleanerError({ error, reset }: { error: Error; reset: () => void }) {
  // The business behind the link was deleted at its Owner's request (convex/companyDeletion.ts).
  if (error instanceof ConvexError && (error.data as { code?: string } | undefined)?.code === "gone") {
    return (
      <Page company={null} title="This page is no longer available">
        <Notice tone="warn" title="This page is no longer available" testId="state-gone">
          The business that sent this link no longer uses Selestial. Contact the business directly if you need anything.
        </Notice>
      </Page>
    );
  }
  return (
    <Page company={null} title="This link can't be opened">
      <Notice tone="warn" title="This link is not valid, or the page could not load" testId="state-invalid">
        Check that you opened the full link from your text message. If it still does not work, ask the office to send a new one.
      </Notice>
      <button type="button" onClick={reset} className="min-h-12 w-full rounded-xl border border-border px-4 text-base font-semibold">
        Try again
      </button>
    </Page>
  );
}
