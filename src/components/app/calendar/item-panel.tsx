"use client";

import Link from "next/link";

import { ArrowUpRight, TriangleAlert } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { durationLabel, longDay } from "@/lib/app/format";
import { LAYER_LABEL } from "@/lib/app/calendar";
import { cn } from "@/lib/utils";

import { LAYER_LOOK, timeLabel, TIMING_WORDS, type Item } from "./look";

/** The address keeps the open item, as `?item=<source>:<id>`, so it can be shared and Back closes it. */
export const ITEM_PARAM = "item";

const OPEN_LABEL: Partial<Record<Item["kind"], string>> = {
  interview: "Open in Recruiter › Interviews",
  interview_slot: "Open in Recruiter › Interviews",
  walkthrough: "Open the walkthrough",
  time_off: "Open the cleaner's availability",
  unavailable: "Open the cleaner's availability",
  renewal_due: "Open the agreement",
  projected_visit: "Open the recurring plan",
};

/**
 * One item that is not a visit or a task (those open in the shared record panel). It shows what the
 * record says and where to act on it. Nothing here edits a copy: changes are made on the record's page.
 */
export function ItemPanel({ item, missing, timezone, onClose }: { item: Item | null; missing: boolean; timezone: string; onClose: () => void }) {
  const open = item !== null || missing;
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetPopup side="right" className="max-w-md bg-card">
        <SheetTitle className="sr-only">{item?.title ?? "Calendar item"}</SheetTitle>
        <ScrollArea className="min-h-0 flex-1">
          {item ? (
            <div className="grid gap-5 p-6">
              <div className="grid gap-1.5">
                <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  <span className={cn("size-2 rounded-full", LAYER_LOOK[item.layer].swatch)} aria-hidden />
                  {LAYER_LABEL[item.layer]}
                  {item.timing !== "appointment" ? <span className="font-medium normal-case tracking-normal">· {TIMING_WORDS[item.timing]}</span> : null}
                </p>
                <h2 className="font-heading text-xl tracking-tight text-strong">{item.title}</h2>
                <p className="text-sm font-medium text-strong">{item.statusLabel}</p>
              </div>

              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">When</dt>
                <dd className="text-strong">
                  {longDay(item.startsAt, timezone)}
                  <br />
                  {timeLabel(item, timezone)}
                  {item.timing !== "due" && !item.allDay ? <span className="text-muted-foreground"> · {durationLabel(item.endsAt - item.startsAt)}</span> : null}
                </dd>
                <dt className="text-muted-foreground">Time zone</dt>
                <dd className="text-strong">
                  {item.timezone.replace(/_/g, " ")}
                  {item.timezone !== timezone ? <span className="block text-xs text-muted-foreground">Shown here on the company&apos;s clock ({timezone.replace(/_/g, " ")}).</span> : null}
                </dd>
                {item.detail ? (
                  <>
                    <dt className="text-muted-foreground">Details</dt>
                    <dd className="text-strong">{item.detail}</dd>
                  </>
                ) : null}
                {item.customerName ? (
                  <>
                    <dt className="text-muted-foreground">Client</dt>
                    <dd className="text-strong">{item.customerName}</dd>
                  </>
                ) : null}
                {item.resources.length > 0 ? (
                  <>
                    <dt className="text-muted-foreground">People</dt>
                    <dd className="text-strong">{item.resources.map((row) => `${row.name}${row.state === "offered" ? " (offered)" : ""}`).join(", ")}</dd>
                  </>
                ) : null}
              </dl>

              {item.problems.length > 0 ? (
                <div className="grid gap-1 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-foreground">
                  {item.problems.map((words) => (
                    <p key={words} className="flex items-start gap-1.5">
                      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                      {words}
                    </p>
                  ))}
                </div>
              ) : null}

              {item.timing === "projected" ? <p className="text-sm text-muted-foreground">This visit is not booked yet. The plan books it automatically when it comes within its booking window, and Dispatch staffs it then. Change the plan on its own page.</p> : null}
              {item.kind === "external_busy" ? <p className="text-sm text-muted-foreground">Selestial reads only free and busy times from connected calendars, so it shows this as Busy and knows nothing else about it.</p> : null}

              {item.href ? (
                <div>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={item.href}>
                      {OPEN_LABEL[item.kind] ?? "Open the record"}
                      <ArrowUpRight aria-hidden />
                    </Link>
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-3 p-6">
              <p className="text-base font-semibold text-strong">This item is not in view</p>
              <p className="text-sm leading-relaxed text-muted-foreground">It may be outside the dates shown, hidden by a filter, changed, or not something your role can open.</p>
              <div>
                <Button variant="outline" size="sm" onClick={onClose}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </ScrollArea>
      </SheetPopup>
    </Sheet>
  );
}
