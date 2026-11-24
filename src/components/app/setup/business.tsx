"use client";

/**
 * "Your business setup": what Selestial prepared from the owner's answers, read from the records
 * themselves. One card per kind of output, each saying what was made, from what, where it stands, what is
 * missing, what was left alone and why, and the one next thing to do. Nothing here publishes or sends.
 */
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";

import { useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { ArrowUpRight, CheckCircle2, CircleAlertIcon, LoaderCircle, RefreshCw, Sparkles } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { BusinessInputs } from "./business-inputs";

type View = FunctionReturnType<typeof api.configure.workspace>;
type Card = View["cards"][number];
type Kind = Card["kind"];

const KIND: Record<Kind, { title: string; lead: string; empty: string; open: { label: string; href: string } }> = {
  services: { title: "Services & prices", lead: "A draft for each service you offer, with prices worked out from your costs when you gave them.", empty: "No services were prepared.", open: { label: "Open Services & Pricing", href: "/app/services" } },
  booking: { title: "Booking form", lead: "A draft booking form for each kind of customer, offering those services, with desktop and mobile previews.", empty: "No booking form was prepared.", open: { label: "Open Booking forms", href: "/app/agents/sales/booking-forms" } },
  agreements: { title: "Agreements", lead: "Starting agreements that fit your services. Decisions only you can make are marked to confirm.", empty: "No agreement was prepared.", open: { label: "Open Agreements", href: "/app/agreements" } },
  standards: { title: "Job standards", lead: "What a finished visit must show, for each kind of cleaning, so reviews check the same things.", empty: "No standard was prepared.", open: { label: "Open Quality", href: "/app/agents/quality/standards" } },
};

export const STATUS: Record<Card["status"], { words: string; variant: "success" | "warning" | "info" | "outline" | "error" }> = {
  not_started: { words: "Not started", variant: "outline" },
  preparing: { words: "Preparing", variant: "info" },
  ready: { words: "Ready to review", variant: "info" },
  needs_info: { words: "Needs information", variant: "warning" },
  approved: { words: "Approved", variant: "success" },
  published: { words: "Published", variant: "success" },
  failed: { words: "Couldn't complete", variant: "error" },
};

/** The next thing to do on a card, specific to where it stands. */
export function nextAction(card: Pick<Card, "kind" | "status" | "missing" | "items">): { label: string; href: string } | null {
  if (card.status === "preparing" || card.status === "not_started" || card.status === "failed") return null;
  if (card.missing[0]) return { label: card.missing[0].words, href: card.missing[0].href };
  const open = card.items.find((item) => item.status === "needs_info" || item.status === "ready");
  if (!open) return null;
  const verb = card.kind === "services" ? "Review and publish" : card.kind === "booking" ? "Preview and publish" : card.kind === "agreements" ? "Review and approve" : "Review and publish";
  return { label: `${verb} “${open.label}”`, href: open.href };
}

function OutputCard({ card, canEdit }: { card: Card; canEdit: boolean }) {
  const { companyId } = useCompany();
  const regenerate = useMutation(api.configure.regenerate);
  const { busy, error, run } = useRun();
  const info = KIND[card.kind];
  const status = STATUS[card.status];
  const next = nextAction(card);
  return (
    <article className="grid gap-3 rounded-2xl border border-border bg-card p-4 sm:p-5" aria-labelledby={`card-${card.kind}`}>
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={`card-${card.kind}`} className="text-base font-semibold text-strong">
            {info.title}
          </h2>
          <p className="text-sm text-muted-foreground">{info.lead}</p>
        </div>
        <Badge variant={status.variant}>
          {card.status === "preparing" ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {status.words}
        </Badge>
      </header>

      {card.status === "preparing" && card.kind === "booking" && card.dependsOn.length ? <p className="text-sm text-muted-foreground">Waits for your service drafts, then offers them.</p> : null}
      {card.retrying ? <p className="text-sm text-muted-foreground">The last try didn&apos;t finish ({card.error}). Trying again on its own.</p> : null}
      {card.status === "failed" ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-strong">
          This couldn&apos;t be prepared: {card.error ?? "something went wrong"}. Everything else is unaffected.
        </p>
      ) : null}
      {card.changed ? <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-strong">Your answers changed since this was prepared. Prepare it again to update the drafts you haven&apos;t changed.</p> : null}

      {card.items.length ? (
        <ul className="grid gap-1.5">
          {card.items.map((item) => (
            <li key={item.href + item.label}>
              <Link href={item.href} className="flex min-w-0 items-start gap-3 rounded-xl border border-border px-3.5 py-3 text-sm hover:border-brand-500/40 focus-visible:outline-2 focus-visible:outline-brand-500">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-strong">{item.label}</span>
                    <Badge variant={STATUS[item.status].variant} size="sm">
                      {STATUS[item.status].words}
                    </Badge>
                  </span>
                  <span className="block text-muted-foreground">{item.detail}</span>
                  {item.flags.length ? <span className="mt-1 block text-xs text-warning-foreground">{item.flags.join(" · ")}</span> : null}
                </span>
                <ArrowUpRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      ) : card.status !== "preparing" && card.status !== "not_started" ? (
        <p className="text-sm text-muted-foreground">{info.empty}</p>
      ) : null}

      {card.missing.length ? (
        <div className="grid gap-1">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Still needed</h3>
          <ul className="grid gap-1 text-sm">
            {card.missing.map((m) => (
              <li key={m.words} className="flex gap-2">
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden />
                <Link href={m.href} className="text-strong underline-offset-2 hover:underline">
                  {m.words}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {card.kept.length ? (
        <div className="grid gap-1">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Left as it was</h3>
          <ul className="grid gap-1 text-sm">
            {card.kept.map((k) => (
              <li key={k.label + k.why}>
                <Link href={k.href} className="font-medium text-strong underline-offset-2 hover:underline">
                  {k.label}
                </Link>
                <span className="text-muted-foreground">: {k.why}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {card.notes.length ? (
        <details className="rounded-lg bg-muted/40 px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium text-strong">How this was prepared</summary>
          <ul className="mt-2 grid list-disc gap-1 pl-5 text-muted-foreground">
            {card.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {next ? (
          <Button variant="primary" size="sm" render={<Link href={next.href} />}>
            {next.label}
          </Button>
        ) : null}
        <Button variant="outline" size="sm" render={<Link href={info.open.href} />}>
          {info.open.label}
        </Button>
        {canEdit && (card.status === "failed" || card.changed || card.status === "ready" || card.status === "needs_info") ? (
          <Button variant="ghost" size="sm" loading={busy} onClick={() => void run(() => regenerate({ companyId, kind: card.kind }))}>
            <RefreshCw aria-hidden className="size-4" />
            {card.status === "failed" ? "Try again" : "Prepare again"}
          </Button>
        ) : null}
      </div>
      <FormError message={error} />
    </article>
  );
}

/** The Prepare button and its outcome, for the setup flow's prepare step and the top of the review page. */
export function PrepareBusiness({ showLink = true }: { showLink?: boolean }) {
  const { companyId } = useCompany();
  const view = useQuery(api.configure.workspace, { companyId });
  const startPrep = useMutation(api.configure.start);
  const { busy, error, run } = useRun();
  if (view === undefined) return <Skeleton className="h-28 rounded-2xl" />;
  const preparing = view.cards.filter((c) => c.status === "preparing").length;
  const done = view.cards.filter((c) => c.status !== "preparing" && c.status !== "not_started").length;
  const anyChanged = view.cards.some((c) => c.changed || c.status === "not_started");
  return (
    <section className="grid gap-3 rounded-2xl border border-brand-500/30 bg-brand-500/[0.04] p-4 sm:p-5" aria-labelledby="prepare-business">
      <h2 id="prepare-business" className="flex items-center gap-2 text-base font-semibold text-strong">
        <Sparkles className="size-4 text-brand-300" aria-hidden />
        Your business setup
      </h2>
      {!view.ready ? (
        <p className="text-sm text-muted-foreground">Tell us who you clean for in your company details, and Selestial can prepare your services, booking form, agreements and job standards.</p>
      ) : !view.started ? (
        <p className="text-sm text-muted-foreground">
          Selestial will prepare drafts for {view.preparing.join(", ")}, a booking form, agreements and job standards. It runs in the background, so you can leave. Nothing is published or sent.
        </p>
      ) : preparing ? (
        <p className="flex items-center gap-2 text-sm text-strong" role="status">
          <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
          Preparing {preparing} of {view.cards.length}. You can leave this page; it keeps going.
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-strong" role="status">
          <CheckCircle2 className="size-4 text-success" aria-hidden />
          {done} of {view.cards.length} prepared and waiting for your review.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {view.canEdit && view.ready && (!view.started || anyChanged) ? (
          <Button variant="primary" size="sm" loading={busy} onClick={() => void run(() => startPrep({ companyId }))}>
            {view.started ? "Update my business setup" : "Prepare my business setup"}
          </Button>
        ) : null}
        {showLink && view.started ? (
          <Button variant="outline" size="sm" render={<Link href="/app/setup/business" />}>
            Review your business setup
          </Button>
        ) : null}
      </div>
      {!view.canEdit ? <p className="text-xs text-muted-foreground">Only the Owner can prepare the business setup.</p> : null}
      <FormError message={error} />
    </section>
  );
}

export function BusinessSetup() {
  const { companyId } = useCompany();
  const view = useQuery(api.configure.workspace, { companyId });
  if (view === undefined) return <Skeleton className="mx-auto mt-8 h-96 w-full max-w-4xl rounded-2xl" />;
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-5 px-4 py-6 sm:px-6 sm:py-10">
      <header className="grid gap-2">
        <p className="text-xs font-medium tracking-wide text-brand-300 uppercase">Your business setup</p>
        <h1 className="font-heading text-2xl tracking-tight text-strong sm:text-3xl">Review what Selestial prepared</h1>
        <p className="text-sm text-muted-foreground">Each card is read from the records it made, right now. Drafts become live only when you publish or approve them, and anything you change is never overwritten.</p>
      </header>
      <PrepareBusiness showLink={false} />
      {view.started ? (
        <div className="grid gap-4">
          {view.cards.map((card) => (
            <OutputCard key={card.kind} card={card} canEdit={view.canEdit} />
          ))}
        </div>
      ) : null}
      <h2 className="mt-2 text-lg font-semibold text-strong">Your answers</h2>
      <p className="-mt-3 text-sm text-muted-foreground">Change any of these and the drafts you haven&apos;t edited are prepared again to match.</p>
      <BusinessInputs />
    </div>
  );
}
