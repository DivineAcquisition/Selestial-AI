"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useCompany } from "@/components/app/company";
import { Breadcrumbs, useBottomBar, useStickyToolbar } from "@/components/app/layout";
import { useDeclareNavOwner } from "@/components/app/nav-owner";
import { FormError, messageOf } from "@/components/app/form";
import { ArrowLeft, ChatIcon, ChevronDown, Eye, Save } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { money } from "@/lib/app/format";
import { breadcrumbsFor } from "@/lib/app/navigation-helpers";
import { workspaceOwner, workspaceReturn, workspaceTitle } from "@/lib/app/sales-workspace";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { BookingActions } from "./booking-actions";
import { CustomerSection } from "./customer-section";
import { Chip } from "./kit";
import { PaymentSection } from "./payment-section";
import { ProposalWorkspace } from "./proposal-sections";
import { ScheduleSection } from "./schedule-section";
import { ServiceSection } from "./service-section";
import { BookingSummary } from "./summary";
import { useDraft, type SaveState, type Segment, type Working } from "./use-draft";
import { SegmentedControl, Select } from "@/components/ui/selection";

const SEGMENTS: { id: Segment; label: string }[] = [
  { id: "residential", label: "Residential" },
  { id: "commercial", label: "Commercial" },
  { id: "office", label: "Office" },
  { id: "str", label: "Short-term rental" },
];

function SaveStatus({ state, onReload }: { state: SaveState; onReload: () => void }) {
  if (state.kind === "saving") return <span className="text-xs text-muted-foreground">Saving…</span>;
  if (state.kind === "dirty") return <span className="text-xs text-muted-foreground">Unsaved changes</span>;
  if (state.kind === "error")
    return (
      <span role="alert" className="text-xs text-destructive-foreground">
        Not saved: {state.message}
      </span>
    );
  if (state.kind === "conflict")
    return (
      <span role="alert" className="flex items-center gap-1.5 text-xs text-destructive-foreground">
        Changed in another window.
        <button type="button" onClick={onReload} className="font-medium underline">
          Load latest
        </button>
      </span>
    );
  return <span className="text-xs text-muted-foreground">{state.at ? `Draft saved ${new Date(state.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "Draft saved"}</span>;
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { id: T; label: string }[]; onChange: (value: T) => void }) {
  return <SegmentedControl label={label} hideLabel value={value} options={options} onChange={onChange} density="compact" />;
}

/** The customer's view of what they will receive, without anything internal. */
function CustomerPreview({ working, data, onClose }: { working: Working; data: NonNullable<ReturnType<typeof useDraft>["data"]>; onClose: () => void }) {
  const { companyId } = useCompany();
  const summary = useQuery(api.sales.price, { companyId, draftId: data.draft._id });
  const booking = summary?.mode === "booking" ? summary : null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="preview-title" className="fixed inset-0 z-modal grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 id="preview-title" className="font-heading text-lg text-strong">
            What the customer sees
          </h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        {booking?.visit ? (
          <div className="mt-4 grid gap-3 text-sm">
            <p className="font-medium text-strong">{booking.first ? `${booking.first.name}, then ${booking.visit.name}` : booking.visit.name}</p>
            {booking.cadence ? <p className="text-muted-foreground">{booking.cadence}</p> : null}
            <ul className="grid gap-1 text-strong">
              {booking.visit.includedScope.slice(0, 12).map((item) => (
                <li key={item}>✓ {item}</li>
              ))}
            </ul>
            <dl className="grid gap-1 border-t border-border pt-3">
              {booking.firstCents !== null ? (
                <div className="flex justify-between">
                  <dt>{working.bookingKind === "recurring" ? "First visit" : "Price"}</dt>
                  <dd className="font-semibold tabular-nums">{money(booking.firstCents)}</dd>
                </div>
              ) : null}
              {booking.ongoingCents !== null ? (
                <div className="flex justify-between">
                  <dt>Each visit after</dt>
                  <dd className="font-semibold tabular-nums">{money(booking.ongoingCents)}</dd>
                </div>
              ) : null}
              {booking.dueNowCents ? (
                <div className="flex justify-between">
                  <dt>Due now</dt>
                  <dd className="tabular-nums">{money(booking.dueNowCents)}</dd>
                </div>
              ) : null}
            </dl>
            {working.body.notes?.customer ? <p className="rounded-lg bg-muted/40 p-3 text-strong">{working.body.notes.customer}</p> : null}
            {working.body.agreement?.required ? <p className="text-xs text-muted-foreground">You’ll be asked to review and sign a service agreement.</p> : null}
            <p className="text-xs text-muted-foreground">Access notes and office notes are not shown to the customer.</p>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">Choose a service to preview it.</p>
        )}
      </div>
    </div>
  );
}

/**
 * `from` is where this visit came from (Internal Booking, Quotes & Proposals, Pipeline, a customer, Calendar,
 * Dispatch); the back link returns there. The sidebar and breadcrumbs follow the draft's mode, not the
 * address, which is the same for bookings and proposals: switching the mode moves them, and loses nothing.
 */
export function SalesWorkspace({ draftId, from }: { draftId: Id<"salesDrafts">; from?: string }) {
  const { companyId } = useCompany();
  const pathname = usePathname();
  const { data, working, state, update, setBody, flush, reload, revision } = useDraft(companyId, draftId);
  const owner = working ? workspaceOwner(working.mode) : null;
  useDeclareNavOwner(owner);
  const title = data && working ? workspaceTitle(data.customer && data.customer._id === working.customerId ? data.customer.name : (data.opportunity?.title ?? (working.mode === "booking" ? "New booking" : "New proposal")), working.mode) : null;
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
  const summary = useQuery(api.sales.price, { companyId, draftId });
  const sendChat = useMutation(api.chat.send);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [preview, setPreview] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  useStickyToolbar(toolbar, data !== undefined && data !== null && working !== null);

  if (data === undefined || working === null) return <Skeleton className="h-[70vh] rounded-2xl" />;
  if (data === null) return <p className="text-sm text-muted-foreground">This draft no longer exists.</p>;

  const booking = summary?.mode === "booking" ? summary : null;
  const sectionDone = (section: string) => Boolean(summary && !summary.needs.some((n) => n.section === section && n.blocking));
  const name = data.customer && data.customer._id === working.customerId ? data.customer.name : (data.opportunity?.title ?? "New customer");
  const back = workspaceReturn({ mode: working.mode, from, entry: data.draft.entry ?? null, customerId: working.customerId ?? null });
  const crumbs = [...breadcrumbsFor(pathname, owner), { label: name, href: null }];
  // Chat opens in a new tab with this draft as its context, so the call in progress is never lost.
  const askChat = () => {
    setChatError(null);
    const text = question.trim();
    if (!text) return;
    void flush()
      .then(() => sendChat({ companyId, text, clientKey: `sales-${draftId}-${Date.now()}`, origin: { kind: "sales_draft", draftId }, page: window.location.pathname }))
      .then((result) => {
        setAsking(false);
        setQuestion("");
        window.open(`/app/chat/${result.conversationId}`, "_blank", "noopener");
      })
      .catch((caught: unknown) => setChatError(messageOf(caught)));
  };

  return (
    <div className="mx-auto max-w-[1320px]">
      {/*
        Top bar. It sticks under the application header, never over it, and spans the page's gutters. On a
        phone, or on a short screen, it scrolls away with the page instead, so it never takes a quarter of the
        screen; the bar at the bottom keeps the summary and Review in reach there.
      */}
      <div ref={toolbar} className="relative z-sticky -mx-app-gutter mb-5 border-b border-border bg-background/90 px-app-gutter py-3 backdrop-blur @xl/main:tall:sticky @xl/main:tall:top-app-chrome">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link href={back.href} className="inline-flex min-h-9 items-center gap-1 rounded-lg text-sm text-muted-foreground hover:text-strong focus-visible:outline-2 focus-visible:outline-brand-500" title={`Back to ${back.label}`}>
            <ArrowLeft aria-hidden className="size-4" />
            <span className="sr-only">Back to {back.label}</span>
          </Link>
          <div className="min-w-0">
            <div className="hidden @xl/main:block [&_nav]:mb-0.5">
              <Breadcrumbs crumbs={crumbs} />
            </div>
            <p className="text-[0.6875rem] font-semibold tracking-wide text-brand-600 uppercase">{working.mode === "booking" ? (working.bookingKind === "recurring" ? "Recurring booking" : "One-time booking") : "Prepare proposal"}</p>
            <h1 className="truncate font-heading text-lg tracking-tight text-strong">{name}</h1>
          </div>
          <Segmented
            label="Workspace mode"
            value={working.mode}
            options={[
              { id: "booking", label: "Book service" },
              { id: "proposal", label: "Prepare proposal" },
            ]}
            onChange={(mode) => update({ mode, segment: mode === "proposal" && working.segment === "residential" ? "commercial" : working.segment })}
          />
          <label className="text-sm">
            <span className="sr-only">Service category</span>
            <Select value={working.segment} onValueChange={(next) => update({ segment: (next ?? "") as Segment })} options={SEGMENTS.filter((s) => working.mode === "booking" || s.id !== "residential").map((s) => ({ value: s.id, label: s.label }))} searchable="auto" density="compact" />
          </label>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <SaveStatus state={state} onReload={reload} />
            <Button size="sm" variant="outline" onClick={() => setPreview(true)} disabled={working.mode !== "booking"}>
              <Eye aria-hidden className="size-4" /> Customer preview
            </Button>
            <Button size="sm" variant="outline" aria-expanded={asking} aria-controls="ask-chat" onClick={() => setAsking((v) => !v)}>
              <ChatIcon aria-hidden className="size-4" /> Ask Chat
            </Button>
            <Button size="sm" onClick={() => void flush()} disabled={state.kind === "saved" || state.kind === "saving"}>
              <Save aria-hidden className="size-4" /> Save draft
            </Button>
          </div>
        </div>
        {asking ? (
          <form
            id="ask-chat"
            className="mt-3 flex flex-wrap items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              askChat();
            }}
          >
            <label className="min-w-64 flex-1">
              <span className="sr-only">Ask Chat about this draft</span>
              <textarea
                className="min-h-10 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-strong"
                rows={2}
                autoFocus
                placeholder="For example: what's still missing to book this? Compare weekly and every 2 weeks."
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </label>
            <Button type="submit" size="sm" disabled={!question.trim()}>
              Ask
            </Button>
            <p className="basis-full text-xs text-muted-foreground">Chat reads this draft and prepares changes; you apply them here. It can’t send, charge or confirm anything.</p>
          </form>
        ) : null}
        <FormError message={chatError} />
      </div>

      {working.mode === "proposal" ? (
        <ProposalWorkspace data={data} working={working} update={update} setBody={setBody} summary={summary} flush={flush} revision={revision} />
      ) : (
        <div className="grid grid-cols-1 gap-6 @4xl/main:grid-cols-12">
          <div className="grid min-w-0 gap-5 @4xl/main:col-span-8">
            <Segmented
              label="Booking type"
              value={working.bookingKind}
              options={[
                { id: "one_time", label: "One-time" },
                { id: "recurring", label: "Recurring" },
              ]}
              onChange={(bookingKind) => update({ bookingKind })}
            />
            <CustomerSection n={1} data={data} working={working} update={update} setBody={setBody} done={sectionDone("customer")} companyId={companyId} />
            <ServiceSection n={2} data={data} working={working} setBody={setBody} summary={summary} done={sectionDone("service")} />
            <ScheduleSection n={3} data={data} working={working} setBody={setBody} summary={summary} done={sectionDone("schedule")} companyId={companyId} />
            <PaymentSection n={4} working={working} setBody={setBody} summary={summary} done={sectionDone("payment")} />
            <BookingActions n={5} data={data} working={working} setBody={setBody} summary={summary} flush={flush} revision={revision} saving={state.kind !== "saved"} />
          </div>
          <aside className="hidden @4xl/main:col-span-4 @4xl/main:block" aria-label="Live summary">
            <div className="sticky top-app-sticky max-h-app-sticky overflow-y-auto">
              <BookingSummary data={data} working={working} summary={summary} saving={state.kind === "saving" || state.kind === "dirty"} />
            </div>
          </aside>
        </div>
      )}

      {/* Without room for the summary beside the form: a collapsible summary and an action bar that stay reachable. */}
      {working.mode === "booking" ? (
        <MobileBookingBar open={summaryOpen} onToggle={() => setSummaryOpen((v) => !v)} firstCents={booking?.firstCents ?? null} needs={booking ? booking.needs.length : null}>
          <BookingSummary data={data} working={working} summary={summary} saving={state.kind !== "saved"} />
        </MobileBookingBar>
      ) : null}
      {preview ? <CustomerPreview working={working} data={data} onClose={() => setPreview(false)} /> : null}
    </div>
  );
}

/**
 * The booking's summary and next step on a phone or tablet, fixed to the bottom of the screen. It starts
 * where the sidebar ends, keeps clear of the phone's home indicator, and tells the page how tall it is so
 * the last field can still be scrolled above it and the team console rises over it.
 */
function MobileBookingBar({ open, onToggle, firstCents, needs, children }: { open: boolean; onToggle: () => void; firstCents: number | null; needs: number | null; children: React.ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  useBottomBar(bar);
  return (
    <div ref={bar} className="fixed right-app-content bottom-0 left-app-content z-floating border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur @4xl/main:hidden">
      {open ? (
        <div id="mobile-summary" className="max-h-[min(60dvh,calc(100dvh-var(--app-chrome-height)-6rem))] overflow-y-auto px-4 pt-4">
          {children}
        </div>
      ) : null}
      <div className="flex items-center gap-3 px-4 py-3">
        <button type="button" aria-expanded={open} aria-controls="mobile-summary" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-brand-500">
          <ChevronDown aria-hidden className={cn("size-4 shrink-0 transition-transform", open ? "" : "rotate-180")} />
          <span className="min-w-0">
            <span className="block text-xs text-muted-foreground">{open ? "Hide summary" : "Show summary"}</span>
            <span className="block truncate font-semibold text-strong tabular-nums">{firstCents !== null ? money(firstCents) : "—"}</span>
          </span>
        </button>
        {/* Nothing is claimed until the price check has answered. */}
        {needs === null ? null : needs > 0 ? <Chip tone="warning">{needs} still needed</Chip> : <Chip tone="success">Ready</Chip>}
        <a href="#review" className="inline-flex min-h-9 shrink-0 items-center rounded-lg bg-brand-500 px-3 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
          Review
        </a>
      </div>
    </div>
  );
}
