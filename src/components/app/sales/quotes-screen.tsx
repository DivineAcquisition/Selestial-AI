"use client";

/**
 * Sales › Quotes & Proposals: saved quotes and their follow-through, and commercial, office and short-term
 * rental proposals from draft to acceptance. Starting and resuming bookings is Internal Booking's
 * (internal-booking-screen.tsx). A quote saved from a booking stays listed here, and "Continue to booking"
 * opens its draft; the quote and the draft are the same records in both places, never copies.
 */
import { useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { PageHeader, Panel } from "@/components/app/shell";
import { ArrowRight, BuildingsIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/selection";
import { Skeleton } from "@/components/ui/skeleton";
import { money } from "@/lib/app/format";
import { INTERNAL_BOOKING_PATH, workspaceHref } from "@/lib/app/sales-workspace";

import { api } from "../../../../convex/_generated/api";
import { Chip } from "./kit";

const QUOTE_TONE: Record<string, "neutral" | "brand" | "success" | "warning" | "danger"> = { saved: "brand", sent: "brand", accepted: "success", expired: "warning", superseded: "neutral", withdrawn: "neutral", declined: "danger", awaiting_approval: "warning" };
const QUOTE_WORDS: Record<string, string> = { sent: "Sent", accepted: "Accepted", expired: "Expired", superseded: "Replaced", withdrawn: "Withdrawn", declined: "Declined", awaiting_approval: "Waiting for approval" };
const SEGMENT_WORD: Record<string, string> = { residential: "Residential", commercial: "Commercial", office: "Office", str: "Short-term rental" };
const DRAFT_WORDS: Record<string, string> = { open: "Draft", quoted: "Draft", proposal_created: "Proposal created" };

/** Which saved quotes to list, by where each stands. A quote past its hold reads as expired. */
type QuoteShow = "all" | "open" | "accepted" | "expired" | "closed";
const QUOTE_SHOWS: { id: QuoteShow; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Saved or sent" },
  { id: "accepted", label: "Accepted" },
  { id: "expired", label: "Expired" },
  { id: "closed", label: "Withdrawn or declined" },
];
const QUOTE_GROUP: Record<string, Exclude<QuoteShow, "all">> = { saved: "open", sent: "open", awaiting_approval: "open", accepted: "accepted", expired: "expired", withdrawn: "closed", declined: "closed", superseded: "closed" };
const QUOTE_EMPTY: Record<Exclude<QuoteShow, "all">, string> = {
  open: "No quote is saved or with a customer right now.",
  accepted: "No quote has been accepted yet.",
  expired: "No quote has expired.",
  closed: "No quote has been withdrawn, declined or replaced.",
};

type View = "quotes" | "proposals" | "drafts";
const VIEWS: { id: View; label: string }[] = [
  { id: "quotes", label: "Quotes" },
  { id: "proposals", label: "Proposals" },
  { id: "drafts", label: "Proposal drafts" },
];

function shortDay(at: number) {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function QuotesProposalsScreen() {
  const { companyId } = useCompany();
  const quotes = useQuery(api.sales.quotes, { companyId });
  // Proposal drafts only, chosen before the list's limit: booking drafts are Internal Booking's.
  const drafts = useQuery(api.sales.drafts, { companyId, mode: "proposal" });
  const proposals = useQuery(api.proposals.list, { companyId });
  const [view, setView] = useState<View>("quotes");
  const [quoteShow, setQuoteShow] = useState<QuoteShow>("all");
  // Only proposal drafts still being prepared: a proposal that was created is listed under Proposals.
  const proposalDrafts = drafts?.filter((d) => d.mode === "proposal" && (d.status === "open" || d.status === "quoted"));
  const shownQuotes = quotes?.filter((q) => quoteShow === "all" || QUOTE_GROUP[q.status] === quoteShow);
  return (
    <div className="min-w-0">
      <PageHeader
        title="Quotes & Proposals"
        lead="Review saved quotes and follow them through, and prepare and manage commercial, office or short-term rental proposals."
        actions={
          <Button asChild>
            <Link href="/app/agents/sales/new?mode=proposal&segment=commercial&from=quotes">
              <BuildingsIcon aria-hidden className="size-4" /> New proposal
            </Link>
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl label="Show" hideLabel value={view} options={VIEWS} onChange={setView} density="compact" />
        <p className="text-sm text-muted-foreground">
          Booking for a customer?{" "}
          <Link href={INTERNAL_BOOKING_PATH} className="font-medium text-strong underline-offset-4 hover:underline">
            Go to Internal Booking
          </Link>
        </p>
      </div>
      {view === "quotes" && quotes && quotes.length > 0 ? <SegmentedControl label="Quote status" hideLabel value={quoteShow} options={QUOTE_SHOWS} onChange={setQuoteShow} density="compact" className="mb-3" /> : null}
      {view === "quotes" ? (
        <Panel flush>
          {quotes === undefined || shownQuotes === undefined ? (
            <Skeleton className="m-4 h-32" />
          ) : quotes.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No quotes yet. A quote is saved from a booking in{" "}
              <Link href={INTERNAL_BOOKING_PATH} className="font-medium text-strong underline-offset-4 hover:underline">
                Internal Booking
              </Link>{" "}
              with Save quote.
            </p>
          ) : shownQuotes.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">{quoteShow === "all" ? "" : QUOTE_EMPTY[quoteShow]}</p>
          ) : (
            <ul className="divide-y divide-border">
              {shownQuotes.map((q) => (
                <li key={q._id}>
                  <Link href={workspaceHref(q.draftId, "saved-quote")} className="group flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500">
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="truncate text-sm font-medium text-strong">{q.customer}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {q.service}
                        {q.cadence ? ` · ${q.cadence}` : ""} · by {q.by ?? "a team member"} {shortDay(q.createdAt)}
                      </p>
                    </div>
                    <span className="text-sm font-semibold text-strong tabular-nums">{money(q.firstCents ?? q.totalCents)}</span>
                    <Chip tone={QUOTE_TONE[q.status] ?? "neutral"}>{q.status === "saved" ? `Held until ${shortDay(q.expiresAt)}` : (QUOTE_WORDS[q.status] ?? q.status)}</Chip>
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-brand-300 group-hover:underline">
                      {q.status === "saved" || q.status === "sent" ? "Continue to booking" : "Open"}
                      <ArrowRight aria-hidden className="size-4" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}
      {view === "proposals" ? (
        <Panel flush>
          {proposals === undefined ? (
            <Skeleton className="m-4 h-32" />
          ) : proposals.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No proposals yet. Start one with New proposal.</p>
          ) : (
            <ul className="divide-y divide-border">
              {proposals.map((p) => (
                <li key={p._id}>
                  <Link href={p.setupId ? `/app/agents/sales/setups/${p.setupId}` : p.draftId ? workspaceHref(p.draftId, "quotes") : "/app/agents/sales/quotes-proposals"} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-strong">{p.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {p.customer} · {SEGMENT_WORD[p.template] ?? p.template} · {p.sites} site{p.sites === 1 ? "" : "s"}
                        {p.version ? ` · v${p.version}` : ""}
                      </p>
                    </div>
                    <Chip tone={p.status === "accepted" ? "success" : p.status === "changes_requested" || p.status === "expired" ? "warning" : p.status === "declined" ? "danger" : "brand"}>{p.statusWords}</Chip>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}
      {view === "drafts" ? (
        <Panel flush>
          {proposalDrafts === undefined ? (
            <Skeleton className="m-4 h-32" />
          ) : proposalDrafts.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No proposal drafts in progress. Booking drafts are in Internal Booking.</p>
          ) : (
            <ul className="divide-y divide-border">
              {proposalDrafts.map((d) => (
                <li key={d._id}>
                  <Link href={workspaceHref(d._id, "quotes")} className="group flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-strong">{d.customer ?? "Customer not chosen"}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {SEGMENT_WORD[d.segment] ?? d.segment} proposal · edited by {d.by ?? "a team member"} {shortDay(d.updatedAt)}
                      </p>
                    </div>
                    <Chip tone="neutral">{DRAFT_WORDS[d.status] ?? d.status.replace(/_/g, " ")}</Chip>
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-brand-300 group-hover:underline">
                      Continue
                      <ArrowRight aria-hidden className="size-4" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}
    </div>
  );
}
