"use client";

/**
 * Staff › Operations › Billing: cancellations and retention offers (convex/cancellation.ts, report).
 *
 * What people answered, which offers they saw and took, what billing actually did, and what Stripe actually
 * collected. Collected revenue and projected (not yet paid) amounts are kept apart, and a retained company is
 * only one whose plan was still active N days after accepting: it says nothing about whether it would have left.
 */
import { useQuery } from "convex/react";
import { useState } from "react";

import { Panel } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { api } from "../../../convex/_generated/api";

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(cents / 100);
const day = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const OUTCOME: Record<string, string> = { kept: "Kept", offer_accepted: "Took an offer", cancel_requested: "Cancelling", canceled: "Canceled" };

export function CancellationsPanel() {
  const [days, setDays] = useState(90);
  const data = useQuery(api.cancellation.report, { days });
  if (data === undefined) return <Skeleton className="h-40 rounded-2xl" />;
  return (
    <Panel title="Cancellations and retention offers">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>
          {data.env === "sandbox" ? "Sandbox billing. " : ""}Last {days} days.
        </span>
        {[30, 90, 365].map((value) => (
          <Button key={value} size="xs" variant={value === days ? "secondary" : "ghost"} onClick={() => setDays(value)}>
            {value} days
          </Button>
        ))}
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Flows started" value={data.flowsStarted} />
        <Stat label="Could get an offer" value={data.eligible} />
        <Stat label="Cancellations confirmed" value={data.cancellations.done} hint={`${data.cancellations.failed} failed`} />
        <Stat label="Reactivations" value={data.reactivations.done} hint={`${data.failedOperations} failed billing operations`} />
      </dl>

      <h3 className="mt-5 text-sm font-semibold text-strong">Offers</h3>
      <table className="mt-1 w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1 font-medium">Offer</th>
            <th className="py-1 text-right font-medium">Viewed</th>
            <th className="py-1 text-right font-medium">Declined</th>
            <th className="py-1 text-right font-medium">Accepted</th>
            <th className="py-1 text-right font-medium">Applied in billing</th>
            <th className="py-1 text-right font-medium">Failed</th>
          </tr>
        </thead>
        <tbody>
          {data.offers.map((row) => (
            <tr key={row.offerId} className="border-t border-border">
              <td className="py-1.5">{row.offerId === "save10_once" ? "10% off one payment" : "15% off three payments"}</td>
              <td className="py-1.5 text-right tabular-nums">{row.viewed}</td>
              <td className="py-1.5 text-right tabular-nums">{row.declined}</td>
              <td className="py-1.5 text-right tabular-nums">{row.accepted}</td>
              <td className="py-1.5 text-right tabular-nums">{row.applied}</td>
              <td className="py-1.5 text-right tabular-nums">{row.failed}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="mt-5 text-sm font-semibold text-strong">Money, as Stripe reported it</h3>
      <dl className="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Subscription revenue collected" value={usd(data.money.collectedCents)} hint="Paid plan invoices after acceptance, less refunds" />
        <Stat label="Discounts on paid invoices" value={usd(data.money.discountsAppliedCents)} />
        <Stat label="Refunded" value={usd(data.money.refundedCents)} hint={`${data.money.failedInvoices} failed or unpaid invoices`} />
        <Stat label="Projected, not collected" value={usd(data.money.projectedCents)} hint="Discounted payments still to come. Not revenue." />
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">SMS, email and credit purchases are never included. Retention below counts plans still active after accepting; it doesn’t show whether a company would otherwise have left.</p>
      <dl className="mt-2 grid grid-cols-3 gap-3">
        {data.retention.map((row) => (
          <Stat key={row.days} label={`Still subscribed at ${row.days} days`} value={row.percent === null ? "—" : `${row.percent}%`} hint={`${row.retained} of ${row.eligible} old enough`} />
        ))}
      </dl>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Counts title="Why they considered leaving" rows={data.reasons} />
        <Counts title="What would make staying worthwhile" rows={data.needs} />
      </div>
      {data.ineligible.length ? <Counts title="Why no offer was made" rows={data.ineligible} /> : null}

      <h3 className="mt-5 text-sm font-semibold text-strong">Recent feedback</h3>
      {data.recent.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">Nobody has opened Cancel subscription in this period.</p>
      ) : (
        <ul className="mt-1 grid gap-2 text-sm">
          {data.recent.map((row) => (
            <li key={row.id} className="rounded-lg border border-border px-3 py-2">
              <p className="flex flex-wrap justify-between gap-2">
                <span className="font-medium text-strong">{row.company}</span>
                <span className="text-xs text-muted-foreground">
                  {day(row.at)} · {row.outcome ? OUTCOME[row.outcome] : "Closed without a choice"}
                  {row.skipped ? " · skipped the questions" : ""}
                </span>
              </p>
              {row.reason ? <p className="text-muted-foreground">{row.reason}</p> : null}
              {row.reasonNote ? <p className="text-strong">“{row.reasonNote}”</p> : null}
              {row.need ? <p className="text-muted-foreground">{row.need}</p> : null}
              {row.needNote ? <p className="text-strong">“{row.needNote}”</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-strong">{value}</dd>
      {hint ? <dd className="text-xs text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}

function Counts({ title, rows }: { title: string; rows: { key: string; label: string; count: number }[] }) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return (
    <div>
      <h3 className="text-sm font-semibold text-strong">{title}</h3>
      <ul className="mt-1 grid gap-1 text-sm">
        {rows.map((row) => (
          <li key={row.key} className="flex justify-between gap-2">
            <span className="text-muted-foreground">{row.label}</span>
            <span className="tabular-nums text-strong">
              {row.count}
              {total ? <span className="ml-1 text-xs text-muted-foreground">({Math.round((100 * row.count) / total)}%)</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
