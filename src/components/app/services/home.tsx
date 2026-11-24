"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { AlertTriangle, ArrowRight, CheckCircle2, LoaderCircle, Plus, Sparkles, Upload } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Skeleton } from "@/components/ui/skeleton";
import { REVIEW_ALL_PATH, SERVICES_ROOT, servicePath } from "@/lib/app/services";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import { CATEGORY_LABELS } from "../../../../convex/lib/services/spec";
import { Empty, Notice, when } from "./shared";
import { SetupHelpCard } from "@/components/app/tutorials/setup-help";

type Catalog = NonNullable<ReturnType<typeof useQuery<typeof api.services.catalog>>>;
type Row = Catalog["services"][number];
type Start = NonNullable<ReturnType<typeof useQuery<typeof api.services.startingPoint>>>;
type Prep = NonNullable<ReturnType<typeof useQuery<typeof api.configure.workspace>>>;

const FILTERS = [
  { id: "live", label: "Live" },
  { id: "drafts", label: "Drafts" },
  { id: "archived", label: "Archived" },
] as const;
type Filter = (typeof FILTERS)[number]["id"];

export const matches = (row: Row, filter: Filter) => (filter === "live" ? row.status === "active" : filter === "drafts" ? row.status !== "archived" && row.draft !== null : row.status === "archived");

/** A draft that is complete and differs from what is live: ready for the Owner to publish, or to submit. */
export const reviewable = (row: Row) => row.status !== "archived" && row.draft !== null && row.draft.blockers === 0 && (row.live === null || row.draft.changed) && row.openChange === null;

/** The company's services: what is live, what is drafted, and the drafts Selestial prepared first. */
export function ServicesHome() {
  const { companyId, role } = useCompany();
  const catalog = useQuery(api.services.catalog, { companyId });
  const start = useQuery(api.services.startingPoint, { companyId });
  const prep = useQuery(api.configure.workspace, role === "owner" || role === "manager" ? { companyId } : "skip");
  const [picked, setPicked] = useState<Filter | null>(null);
  if (!catalog) return <Skeleton className="h-72 rounded-2xl" />;
  if (catalog.services.length === 0) return <FirstTime catalog={catalog} start={start ?? null} prep={prep ?? null} />;
  const anyLive = catalog.services.some((row) => row.status === "active");
  const preparedWaiting = catalog.services.some((row) => row.prepared && row.draft !== null && row.live === null && row.status !== "archived");
  const filter: Filter = picked ?? (anyLive && !preparedWaiting ? "live" : "drafts");
  const shown = catalog.services.filter((row) => matches(row, filter));
  const ready = catalog.services.filter(reviewable);
  const waiting = catalog.counts.waiting;
  return (
    <div className="grid grid-cols-1 gap-5">
      <SetupHelpCard tutorialId="setup-services" placement="services.home" />
      {catalog.canDraft ? <PreparedLead catalog={catalog} prep={prep ?? null} start={start ?? null} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Show" className="inline-flex rounded-xl border border-border bg-card p-1">
          {FILTERS.map((item) => {
            const count = catalog.services.filter((row) => matches(row, item.id)).length;
            return (
              <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} onClick={() => setPicked(item.id)} className={cn("min-h-8 rounded-lg px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-brand-500/50", filter === item.id ? "bg-brand-500/10 font-medium text-strong" : "text-muted-foreground hover:text-strong")}>
                {item.label} <span className="tabular-nums text-muted-foreground">{count}</span>
              </button>
            );
          })}
        </div>
        {catalog.canDraft && (waiting > 0 || ready.length > 1) ? (
          <Link href={REVIEW_ALL_PATH} className={buttonVariants({ variant: "secondary", size: "sm" })}>
            {waiting > 0 ? `${waiting} waiting for review` : `Review ${ready.length} drafts together`} <ArrowRight aria-hidden />
          </Link>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <Empty title={filter === "live" ? "Nothing live yet" : filter === "drafts" ? "No drafts" : "Nothing archived"}>{filter === "live" ? "Publish a draft and it appears here. New quotes and visits use only live services." : filter === "drafts" ? "Every service matches what is live." : "Archived services stay here, with their history."}</Empty>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((row) => (
            <li key={row.id}>
              <ServiceCard row={row} canDraft={catalog.canDraft} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── A service card ──────────────────────────────────────────────────────────────────────────────────

/** How customers get the service today, in words that match what booking really does. */
export function bookingWords(row: Pick<Row, "booking" | "status" | "live">): string {
  if (row.status === "archived") return "Not offered to new customers";
  if (row.booking.estimate) return "Customers ask for an estimate";
  if (!row.live) return row.booking.liveForms ? "Shows on your live booking form once published" : "Not online yet";
  if (row.booking.liveForms) return `Bookable online on ${row.booking.liveForms} live form${row.booking.liveForms === 1 ? "" : "s"}`;
  return row.booking.forms ? "On a booking form that isn't published" : "Not on a booking form";
}

function statusOf(row: Row): { label: string; tone: "success" | "info" | "warning" | "outline" } {
  if (row.status === "archived") return { label: "Archived", tone: "outline" };
  if (row.openChange) return { label: row.openChange.state === "scheduled" ? "Scheduled" : row.openChange.state === "approved" ? "Approved" : "In review", tone: "info" };
  if (row.live && row.draft?.changed) return { label: `Live v${row.live.version} · edits drafted`, tone: "success" };
  if (row.live) return { label: `Live v${row.live.version}`, tone: "success" };
  return { label: "Draft", tone: "warning" };
}

function ServiceCard({ row, canDraft }: { row: Row; canDraft: boolean }) {
  const status = statusOf(row);
  const price = row.live && !row.draft?.changed ? row.live.summary : row.draft ? (row.draft.priced ? row.draft.summary : null) : (row.live?.summary ?? null);
  const action = !canDraft ? "Open" : reviewable(row) ? "Review" : row.draft ? "Edit" : "Open";
  return (
    <Link href={servicePath(row.id)} className="group flex h-full flex-col gap-3 rounded-2xl border border-border bg-card p-4 transition-[border-color,box-shadow] hover:border-brand-500/40 hover:shadow-[0_10px_30px_-18px_rgba(104,56,239,0.45)] focus-visible:outline-2 focus-visible:outline-brand-500/50 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{CATEGORY_LABELS[row.category]}</p>
          <h3 className="mt-0.5 truncate font-heading text-lg tracking-tight text-strong">{row.draft?.name || row.name}</h3>
        </div>
        <Badge variant={status.tone} size="sm" className="shrink-0">
          {status.label}
        </Badge>
      </div>
      <div>
        <p className={cn("text-base font-semibold tabular-nums", price ? "text-strong" : "text-muted-foreground")}>{price ?? "No price yet"}</p>
        <p className="text-sm text-muted-foreground">{bookingWords(row)}</p>
      </div>
      {row.draft && row.draft.blockers > 0 && row.draft.firstBlocker ? (
        <p className="flex items-start gap-1.5 text-sm text-strong">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            {row.draft.firstBlocker}
            {row.draft.blockers > 1 ? <span className="text-muted-foreground"> · {row.draft.blockers - 1} more</span> : null}
          </span>
        </p>
      ) : row.draft?.illustrative ? (
        <p className="flex items-start gap-1.5 text-sm text-strong">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" /> Prices are examples until you confirm them.
        </p>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <span className="truncate">{row.draft ? `${row.prepared && row.draft.revision === 1 ? "Prepared by Selestial" : `Edited ${when(row.draft.updatedAt)} by ${row.draft.by}`}` : row.live ? `Published ${when(row.live.publishedAt)}` : ""}</span>
        <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-300 group-hover:underline">
          {action} <ArrowRight aria-hidden className="size-4" />
        </span>
      </div>
    </Link>
  );
}

// ── Prepared drafts and what they came from ──────────────────────────────────────────────────────────

/** Drafts Selestial prepared from onboarding lead the page until they are reviewed. */
function PreparedLead({ catalog, prep, start }: { catalog: Catalog; prep: Prep | null; start: Start | null }) {
  const card = prep?.cards.find((c) => c.kind === "services") ?? null;
  const prepared = catalog.services.filter((row) => row.prepared && row.draft !== null && row.live === null && row.status !== "archived");
  const preparing = card?.status === "preparing";
  if (!prepared.length && !preparing && card?.status !== "failed") return null;
  const examples = prepared.filter((row) => row.draft?.illustrative).length;
  const ready = prepared.filter((row) => row.draft && row.draft.blockers === 0).length;
  return (
    <section aria-labelledby="prepared" className="grid gap-4 rounded-2xl border border-brand-500/30 bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="prepared" className="flex items-center gap-2 text-base font-semibold text-strong">
            {preparing ? <LoaderCircle aria-hidden className="size-4 animate-spin text-brand-600 motion-reduce:animate-none" /> : <CheckCircle2 aria-hidden className="size-4 text-brand-600" />}
            {preparing ? "Selestial is preparing your services" : `${prepared.length} draft${prepared.length === 1 ? "" : "s"} prepared from your setup`}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground" role={preparing ? "status" : undefined}>
            {preparing
              ? "It runs in the background, so you can leave this page. Drafts appear here as they are made. Nothing is published."
              : `${ready ? `${ready} ready to review` : "Each needs a look before review"}${examples ? `, ${examples} still on example prices` : ""}. Nothing is live until it is published${catalog.canPublish ? "" : " by the Owner"}.`}
          </p>
        </div>
        {prepared.length ? (
          <Link href={REVIEW_ALL_PATH} className={buttonVariants({ variant: "primary", size: "sm" })}>
            Review services <ArrowRight aria-hidden />
          </Link>
        ) : null}
      </div>
      {card?.status === "failed" && card.error ? <Notice tone="warning" title="Preparing stopped">{card.error} Your setup is unchanged. Try again from your business setup.</Notice> : null}
      {examples && start ? <PricingPaths start={start} compact /> : null}
      {start ? <KnownFacts start={start} /> : null}
    </section>
  );
}

/** What Selestial is working from, with where each part came from. A conflict is shown, never picked. */
function KnownFacts({ start }: { start: Start }) {
  const WORDS = { confirmed: "Confirmed", imported: "Imported", suggested: "Suggested", unknown: "Not known yet" } as const;
  const TONES = { confirmed: "success", imported: "info", suggested: "warning", unknown: "outline" } as const;
  return (
    <details className="group rounded-xl border border-border bg-card px-4 py-3">
      <summary className="cursor-pointer list-none text-sm font-medium text-strong marker:hidden focus-visible:outline-2 focus-visible:outline-brand-500/50">
        What Selestial used <span className="font-normal text-muted-foreground">· from your company details</span>
      </summary>
      <dl className="mt-3 grid gap-2.5 text-sm">
        {start.known.map((fact) => (
          <div key={fact.key} className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
            <dt className="text-muted-foreground">{fact.label}</dt>
            <dd className="grid gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-strong">{fact.value ?? "—"}</span>
                <Badge variant={TONES[fact.provenance]} size="sm">
                  {WORDS[fact.provenance]}
                  {fact.from && fact.provenance !== "confirmed" ? ` · ${fact.from}` : ""}
                </Badge>
              </span>
              {fact.conflict ? (
                <span className="text-xs text-warning-foreground">
                  {fact.conflict.from} says “{fact.conflict.value}”. Choose one in your company details.
                </span>
              ) : null}
            </dd>
          </div>
        ))}
        <div className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
          <dt className="text-muted-foreground">Costs and margin</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <Badge variant={start.costs === "confirmed" ? "success" : "outline"} size="sm">
              {start.costs === "confirmed" ? "Confirmed" : "Not known yet"}
            </Badge>
            {start.costs !== "confirmed" && start.canConfigure ? (
              <Link href={`${SERVICES_ROOT}/setup`} className="text-xs font-medium text-brand-300 underline-offset-4 hover:underline">
                Add your costs
              </Link>
            ) : null}
          </dd>
        </div>
      </dl>
      {start.canConfigure ? (
        <Link href="/app/setup/business" className="mt-3 inline-block text-xs font-medium text-brand-300 underline-offset-4 hover:underline">
          Change these in your business setup
        </Link>
      ) : null}
    </details>
  );
}

/** The two ways to get real prices in: bring the ones you use, or work them out from your costs. */
function PricingPaths({ start, compact }: { start: Start; compact?: boolean }) {
  const paths = [
    { id: "existing", title: "Use my existing prices", body: "Paste or upload your price list. Each line keeps where it came from, and duplicates are flagged before anything is drafted.", href: `${SERVICES_ROOT}/new?mode=import`, icon: Upload },
    { id: "help", title: "Help me work out my prices", body: start.canConfigure ? "Tell Selestial what you pay and the margin you want. Prices are worked out from your costs, with the arithmetic shown." : "The Owner adds the company's costs; then prices are worked out from them, with the arithmetic shown.", href: start.canConfigure ? `${SERVICES_ROOT}/setup` : `${SERVICES_ROOT}/new?mode=selestial`, icon: Sparkles },
  ] as const;
  const recommended = start.pricing === "existing" ? "existing" : start.pricing === "help" ? "help" : null;
  return (
    <div className="grid gap-2">
      <p className="text-sm font-medium text-strong">{compact ? "Replace the example prices" : "Your prices"}</p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {paths.map(({ id, title, body, href, icon: Icon }) => (
          <li key={id}>
            <Link href={href} className={cn("flex h-full gap-3 rounded-xl border bg-card p-3.5 transition-colors hover:border-brand-500/50 focus-visible:outline-2 focus-visible:outline-brand-500/50", recommended === id ? "border-brand-500/50" : "border-border")}>
              <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-brand-600" />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-strong">
                  {title}
                  {recommended === id ? (
                    <Badge variant="info" size="sm">
                      Fits what you told us
                    </Badge>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{body}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── The first visit ─────────────────────────────────────────────────────────────────────────────────

/** Nothing yet: set up with Selestial from what onboarding knows, bring a price list, or start by hand. */
function FirstTime({ catalog, start, prep }: { catalog: Catalog; start: Start | null; prep: Prep | null }) {
  const { companyId } = useCompany();
  const regenerate = useMutation(api.configure.regenerate);
  const { busy, error, run } = useRun();
  if (!catalog.canDraft) {
    return (
      <Empty title="No services yet">
        The Owner or a Manager adds the company&apos;s services here. Once one is published, you&apos;ll see its scope and price, and new visits can use it.
      </Empty>
    );
  }
  const card = prep?.cards.find((c) => c.kind === "services") ?? null;
  const preparing = card?.status === "preparing";
  const knowsWhat = Boolean(prep?.ready);
  const canPrepare = catalog.canPublish && knowsWhat;
  return (
    <div className="grid grid-cols-1 gap-5">
      {catalog.legacyWaiting > 0 ? <Notice title="Moving your services from Settings">Your {catalog.legacyWaiting} service{catalog.legacyWaiting === 1 ? "" : "s"} from Settings will appear here once the Owner opens this page.</Notice> : null}
      <section aria-labelledby="first" className="grid gap-5 rounded-2xl border border-border bg-card px-5 py-6 sm:px-7">
        <div>
          <h2 id="first" className="font-heading text-xl tracking-tight text-strong">
            Set up what you sell
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {knowsWhat ? `Selestial can draft ${prep?.preparing.join(", ") || "your services"} from what you told it during setup. You check every price before anything goes live.` : "Tell Selestial who you clean for and it drafts your services. You check every price before anything goes live."}
          </p>
        </div>
        {preparing ? (
          <p role="status" className="flex items-center gap-2 text-sm text-strong">
            <LoaderCircle aria-hidden className="size-4 animate-spin text-brand-600 motion-reduce:animate-none" /> Preparing your services. You can leave this page; drafts appear here as they are made.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {canPrepare ? (
              <Button variant="primary" loading={busy} onClick={() => void run(() => regenerate({ companyId, kind: "services" }))}>
                <Sparkles aria-hidden /> Set up with Selestial
              </Button>
            ) : catalog.canPublish ? (
              <Link href="/app/setup" className={buttonVariants({ variant: "primary" })}>
                <Sparkles aria-hidden /> Set up with Selestial
              </Link>
            ) : (
              <Link href={`${SERVICES_ROOT}/new?mode=selestial`} className={buttonVariants({ variant: "primary" })}>
                <Sparkles aria-hidden /> Set up with Selestial
              </Link>
            )}
            <Link href={`${SERVICES_ROOT}/new?mode=import`} className={buttonVariants({ variant: "secondary" })}>
              <Upload aria-hidden /> Import prices
            </Link>
            <Link href={`${SERVICES_ROOT}/new?mode=blank`} className={buttonVariants({ variant: "ghost" })}>
              <Plus aria-hidden /> Create manually
            </Link>
          </div>
        )}
        {card?.status === "failed" && card.error ? <Notice tone="warning" title="Preparing stopped">{card.error} Nothing was changed. Try again.</Notice> : null}
        <FormError message={error} />
        {catalog.canPublish && !knowsWhat ? <p className="text-xs text-muted-foreground">Selestial first needs to know who you clean for. That takes a minute in your company setup.</p> : null}
        {start ? <PricingPaths start={start} /> : null}
        {start ? <KnownFacts start={start} /> : null}
      </section>
      <SetupHelpCard tutorialId="setup-services" placement="services.home" />
    </div>
  );
}
