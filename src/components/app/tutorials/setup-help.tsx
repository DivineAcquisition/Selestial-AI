"use client";

/**
 * Where the setup guides meet the screens they teach: a compact "Need a hand?" card beside the task, and the
 * getting-started collection (Home and Help & tutorials). Both open the one tutorial dialog (host.tsx); nothing
 * opens by itself, and nothing here plays sound.
 *
 * A guide that is not published shows nothing: no promise of a video that isn't there. One published without a
 * video offers its written steps instead. Whether a task is done comes from the company's records
 * (tutorials.setupStatus), never from watching.
 */
import { useQuery } from "convex/react";
import Link from "next/link";
import { useSyncExternalStore } from "react";

import { useCompany } from "@/components/app/company";
import { ArrowRight, Check, PlayCircle, X } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Placement } from "../../../../convex/lib/tutorials/catalog";
import { isSetupGuide, lengthWords, useOptionalTutorials, useTutorials, type PublishedTutorial } from "./host";

/** The published setup guides, in series order. Undefined while loading. */
export function useSetupGuides(): PublishedTutorial[] | undefined {
  const { published } = useTutorials();
  if (!published) return undefined;
  return published.filter(isSetupGuide).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

/** "Need a hand? Watch how to set up your services · 1 min 40 sec": one quiet card beside the task. */
export function SetupHelpCard({ tutorialId, placement, continueLabel, className }: { tutorialId: string; placement: Placement; continueLabel?: string; className?: string }) {
  const tutorials = useOptionalTutorials();
  const tutorial = tutorials?.published?.find((row) => row.id === tutorialId);
  if (!tutorials || !tutorial) return null;
  const { open } = tutorials;
  const words = tutorial.media ? `Watch how to ${tutorial.short ?? tutorial.title.toLowerCase()}` : `Read how to ${tutorial.short ?? tutorial.title.toLowerCase()}`;
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-sm", className)}>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-500/10 text-brand-300" aria-hidden>
        <PlayCircle className="size-[1.125rem]" />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="font-medium text-strong">Need a hand?</p>
        <button
          type="button"
          onClick={() => open(tutorial.id, placement, { continueLabel })}
          className="justify-self-start rounded-md text-left text-brand-300 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-brand-500"
        >
          {words}
          {tutorial.media ? <span className="text-muted-foreground"> · {lengthWords(tutorial.media.durationSeconds)}</span> : null}
        </button>
      </div>
    </div>
  );
}

// ── Getting started ────────────────────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();

/** Closing the Home collection is remembered on this device, per company. Help & tutorials always lists them. */
function useClosed(companyId: string): [boolean, () => void] {
  const key = `selestial:getting-started-closed:${companyId}`;
  const closed = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => {
      try {
        return window.localStorage.getItem(key) === "1";
      } catch {
        return false;
      }
    },
    () => false,
  );
  return [
    closed,
    () => {
      try {
        window.localStorage.setItem(key, "1");
      } catch {
        // Private browsing: it simply shows again next time.
      }
      listeners.forEach((listener) => listener());
    },
  ];
}

/**
 * The six setup guides in order, each with its real length and whether its task is done in this company.
 * `compact` is the Home version: closable, and gone once every task is done.
 */
export function GettingStarted({ placement, compact = false }: { placement: Placement; compact?: boolean }) {
  const { companyId } = useCompany();
  const { open } = useTutorials();
  const guides = useSetupGuides();
  const status = useQuery(api.tutorials.setupStatus, { companyId });
  const [closed, close] = useClosed(companyId);
  const done = new Set((status ?? []).filter((row) => row.done).map((row) => row.id));

  if (compact && (closed || !guides?.length || (status && guides.every((guide) => done.has(guide.id))))) return null;
  if (!compact && guides === undefined) return <Skeleton className="h-40 rounded-2xl" />;
  if (!guides?.length) return null;
  const left = guides.filter((guide) => !done.has(guide.id)).length;

  return (
    <section className="grid gap-3 rounded-2xl border border-border bg-card p-4" aria-labelledby={`getting-started-${placement}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={`getting-started-${placement}`} className="text-sm font-semibold text-strong">
            Getting started
          </h2>
          <p className="text-xs text-muted-foreground">
            Short videos of each setup task in Selestial.{status ? ` ${left === 0 ? "Every task is done." : `${left} of ${guides.length} still to do.`}` : ""}
          </p>
        </div>
        {compact ? (
          <button type="button" onClick={close} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:text-strong focus-visible:outline-2 focus-visible:outline-brand-500" aria-label="Close the getting started videos on Home">
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>
      <ol className={cn("grid gap-1.5", compact ? "sm:grid-cols-2 xl:grid-cols-3" : "sm:grid-cols-2")}>
        {guides.map((guide) => {
          const isDone = done.has(guide.id);
          return (
            <li key={guide.id}>
              <button
                type="button"
                onClick={() => open(guide.id, placement)}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-border px-3 py-2 text-left text-sm hover:border-brand-500/40 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-brand-500"
              >
                <span className="relative grid aspect-video w-16 shrink-0 place-items-center overflow-hidden rounded-md bg-muted" aria-hidden>
                  {guide.media ? (
                    // eslint-disable-next-line @next/next/no-img-element -- the poster from media storage, loaded lazily
                    <img src={guide.media.poster} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
                  ) : null}
                  <PlayCircle className="relative size-5 text-white drop-shadow" />
                </span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="font-medium text-strong">
                    <span className="text-muted-foreground">{guide.order}.</span> {guide.title}
                  </span>
                  <span className="text-xs text-muted-foreground">{guide.media ? lengthWords(guide.media.durationSeconds) : "Written steps"}</span>
                </span>
                {status ? (
                  isDone ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success-foreground">
                      <Check className="size-3" aria-hidden />
                      Done
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground">To do</span>
                  )
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
      {compact ? (
        <Link href="/app/help" className="inline-flex items-center gap-1 justify-self-start text-xs font-medium text-brand-300 underline-offset-2 hover:underline">
          All help and tutorials
          <ArrowRight className="size-3" aria-hidden />
        </Link>
      ) : (
        <p className="text-xs text-muted-foreground">“Done” comes from what&apos;s set up in your company, not from watching.</p>
      )}
    </section>
  );
}
