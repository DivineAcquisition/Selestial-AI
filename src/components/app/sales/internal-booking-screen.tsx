"use client";

/**
 * Sales › Internal Booking: where the company books service for a customer itself, and picks up a booking it
 * started. It opens the one booking workspace (workspace.tsx); it is not a second booking system.
 *
 * Opening this page creates nothing. A draft is made only when someone chooses New booking or New recurring
 * booking, under a key for that one click, so a double click or a retried request returns the same draft.
 */
import { useMutation, usePaginatedQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, messageOf } from "@/components/app/form";
import { PageHeader, Panel } from "@/components/app/shell";
import { useNow } from "@/components/app/use-now";
import { ArrowRight, CalendarIcon, HouseIcon, MapPin, Plus, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/selection";
import { Skeleton } from "@/components/ui/skeleton";
import { ago } from "@/lib/app/format";
import { QUOTES_PATH, workspaceHref } from "@/lib/app/sales-workspace";

import { api } from "../../../../convex/_generated/api";
import { Chip } from "./kit";

type Show = "active" | "booked" | "all";
const SHOWS: { id: Show; label: string }[] = [
  { id: "active", label: "In progress" },
  { id: "booked", label: "Booked" },
  { id: "all", label: "All" },
];
const TONE = { open: "neutral", quoted: "brand", requested: "warning", confirmed: "success" } as const;
const PAGE = 20;

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function InternalBookingScreen() {
  const { companyId, timezone } = useCompany();
  const now = useNow();
  const router = useRouter();
  const start = useMutation(api.sales.startDraft);
  const [show, setShow] = useState<Show>("active");
  const drafts = usePaginatedQuery(api.sales.bookingDrafts, { companyId, show }, { initialNumItems: PAGE });
  const [busy, setBusy] = useState<"one_time" | "recurring" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One key per kind of draft until it is made: clicking again, or a retry, asks for the same draft.
  const keys = useRef<Partial<Record<"one_time" | "recurring", string>>>({});

  const create = (kind: "one_time" | "recurring") => {
    if (busy) return;
    const clientKey = (keys.current[kind] ??= newKey());
    setBusy(kind);
    setError(null);
    start({ companyId, mode: "booking", ...(kind === "recurring" ? { bookingKind: "recurring" as const } : {}), from: "internal-booking", clientKey })
      .then((draftId) => {
        delete keys.current[kind];
        router.push(workspaceHref(draftId, "internal-booking"));
      })
      .catch((caught: unknown) => {
        setError(messageOf(caught));
        setBusy(null);
      });
  };

  const actions = (
    <>
      <Button variant="outline" loading={busy === "recurring"} disabled={busy !== null} onClick={() => create("recurring")}>
        <RefreshCw aria-hidden className="size-4" /> New recurring booking
      </Button>
      <Button loading={busy === "one_time"} disabled={busy !== null} onClick={() => create("one_time")}>
        <Plus aria-hidden className="size-4" /> New booking
      </Button>
    </>
  );

  const rows = drafts.results;
  const loading = drafts.status === "LoadingFirstPage";

  return (
    <div className="min-w-0">
      <PageHeader title="Internal Booking" lead="Book a service for a customer, arrange recurring cleaning, or continue a booking you started." actions={actions} />
      <FormError message={error} />

      <section aria-labelledby="drafts-heading" className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="drafts-heading" className="font-heading text-base text-strong">
            Booking drafts
          </h2>
          <SegmentedControl label="Show" hideLabel value={show} options={SHOWS} onChange={setShow} density="compact" />
        </div>

        <Panel flush>
          {loading ? (
            <div className="grid gap-2 p-4" aria-busy="true">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <span className="sr-only">Loading booking drafts</span>
            </div>
          ) : rows.length === 0 ? (
            <Empty show={show} onCreate={() => create("one_time")} busy={busy !== null} />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <li key={row._id}>
                  <Link href={workspaceHref(row._id, "internal-booking")} className="group flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500">
                    <div className="min-w-0 flex-1 basis-60">
                      <p className="truncate text-sm font-medium text-strong">{row.label ?? "Customer not chosen yet"}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        {row.property ? (
                          <span className="inline-flex min-w-0 items-center gap-1">
                            <MapPin aria-hidden className="size-3.5 shrink-0" />
                            <span className="truncate">{row.property}</span>
                          </span>
                        ) : null}
                        <span className="inline-flex items-center gap-1">
                          {row.kind === "recurring" ? <RefreshCw aria-hidden className="size-3.5" /> : <CalendarIcon aria-hidden className="size-3.5" />}
                          {row.kind === "recurring" ? "Recurring" : "One-time"}
                          {row.service ? ` · ${row.service}` : " · service not chosen"}
                        </span>
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="hidden text-xs text-muted-foreground sm:inline">
                        Updated {ago(row.updatedAt, now, timezone)}
                        {row.by ? ` by ${row.by}` : ""}
                      </span>
                      <Chip tone={TONE[row.status] ?? "neutral"}>{row.statusWords}</Chip>
                      <span className="inline-flex items-center gap-1 text-sm font-medium text-brand-300 group-hover:underline">
                        {row.status === "confirmed" ? "Open" : "Continue"}
                        <ArrowRight aria-hidden className="size-4" />
                        <span className="sr-only">{row.label ? ` booking for ${row.label}` : " booking"}</span>
                      </span>
                    </div>
                    <span className="basis-full text-xs text-muted-foreground sm:hidden">Updated {ago(row.updatedAt, now, timezone)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {drafts.status === "CanLoadMore" || drafts.status === "LoadingMore" ? (
          <div className="flex justify-center">
            <Button variant="secondary" size="sm" loading={drafts.status === "LoadingMore"} onClick={() => drafts.loadMore(PAGE)}>
              Show more
            </Button>
          </div>
        ) : null}

        <p className="text-sm text-muted-foreground">
          Need a commercial, office or short-term rental proposal, or a saved quote?{" "}
          <Link href={QUOTES_PATH} className="font-medium text-strong underline-offset-4 hover:underline">
            Go to Quotes &amp; Proposals
          </Link>
        </p>
      </section>
    </div>
  );
}

function Empty({ show, onCreate, busy }: { show: Show; onCreate: () => void; busy: boolean }) {
  if (show === "booked")
    return <p className="p-6 text-sm text-muted-foreground">No bookings have been confirmed from here yet. A booking shows here once the customer has confirmed it.</p>;
  return (
    <div className="flex flex-col items-start gap-3 p-6">
      <HouseIcon aria-hidden className="size-6 text-brand-600" />
      <div>
        <p className="font-medium text-strong">No booking drafts yet</p>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">Start a booking when a customer calls or writes. Find or add the customer, choose the service, pick a time, and review before anything is sent. Your progress saves as you go.</p>
      </div>
      <Button size="sm" disabled={busy} onClick={onCreate}>
        <Plus aria-hidden className="size-4" /> New booking
      </Button>
    </div>
  );
}
