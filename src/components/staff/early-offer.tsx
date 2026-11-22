"use client";

/**
 * Staff › Operations › Billing: the early-user offer (convex/earlyOffer.ts). How many of the 15 places are
 * used, which companies hold them, when each moves to $299 and whether that move is on Autumn's record, and a
 * way to give back a place that was reserved and never paid. Releasing needs the billing.adjust capability; a
 * paid place can never be released.
 */
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { Field, FormError, TextArea, useRun } from "@/components/app/form";
import { Panel } from "@/components/app/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

type Row = FunctionReturnType<typeof api.earlyOffer.overview>["rows"][number];

const day = (at: number | null) => (at ? new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");

const STATE: Record<Row["state"], { label: string; variant: "success" | "info" | "outline" | "warning" }> = {
  claimed: { label: "Paying $199", variant: "success" },
  ended: { label: "Offer ended", variant: "outline" },
  reserved: { label: "Reserved, not paid", variant: "info" },
  expired: { label: "Reservation expired", variant: "warning" },
  released: { label: "Released", variant: "outline" },
};

function moveWords(row: Row): string {
  if (row.state === "ended") return row.endReason === "cancelled" ? `Cancelled ${day(row.endedAt)}` : `Moved to $299 ${day(row.endedAt)}`;
  if (row.state !== "claimed") return "—";
  const when = `$299 from ${day(row.offerEndsAt)}`;
  if (row.switch === "scheduled") return `${when} · scheduled in Autumn`;
  if (row.switch === "failing") return `${when} · failing: ${row.switchProblem ?? "see incident"}`;
  if (row.switch === "requested") return `${when} · asked, not yet confirmed`;
  return `${when} · asked in the 12th period`;
}

export function EarlyOfferPanel() {
  const data = useQuery(api.earlyOffer.overview, {});
  const me = useQuery(api.staff.me, {});
  const [releasing, setReleasing] = useState<Row | null>(null);
  if (data === undefined) return <Skeleton className="h-40 rounded-2xl" />;
  const canRelease = me?.capabilities.includes("billing.adjust") ?? false;
  const shown = data.rows.filter((row) => row.state !== "released");
  return (
    <Panel title="Early-user offer">
      <div className="grid gap-4 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <p className="text-2xl font-semibold tabular-nums text-strong">
            {data.used} <span className="text-base font-normal text-muted-foreground">of {data.places} places used</span>
          </p>
          <p className="text-sm text-muted-foreground">
            {data.claimed} paid · {data.used - data.claimed} reserved awaiting payment · {data.env === "sandbox" ? "Sandbox" : "Production"}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">$199 a month for 12 months, then $299, for the first 15 companies whose first payment succeeds. A paid place stays used after cancellation.</p>
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">No company holds or has reserved a place yet.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[640px] text-sm">
              <caption className="sr-only">Companies holding or reserving an early-user place</caption>
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-4 py-1.5 font-medium sm:px-0">Company</th>
                  <th scope="col" className="py-1.5 font-medium">State</th>
                  <th scope="col" className="py-1.5 font-medium">Paid</th>
                  <th scope="col" className="py-1.5 font-medium">Moves to $299</th>
                  <th scope="col" className="py-1.5 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.id} className="border-t border-border align-top">
                    <td className="px-4 py-2 font-medium text-strong sm:px-0">{row.company}</td>
                    <td className="py-2">
                      <Badge variant={STATE[row.state].variant}>{STATE[row.state].label}</Badge>
                    </td>
                    <td className="py-2 text-muted-foreground">{row.state === "reserved" || row.state === "expired" ? `Reserved ${day(row.reservedAt)}` : day(row.claimedAt)}</td>
                    <td className={row.switch === "failing" ? "py-2 text-destructive-foreground" : "py-2 text-muted-foreground"}>{moveWords(row)}</td>
                    <td className="py-2 text-right">
                      {(row.state === "reserved" || row.state === "expired") && canRelease ? (
                        <Button size="sm" variant="outline" onClick={() => setReleasing(row)}>
                          Release place
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!canRelease && shown.some((row) => row.state === "reserved" || row.state === "expired") ? <p className="text-xs text-muted-foreground">Releasing an unpaid reservation needs the Billing adjustments capability, granted by a staff admin.</p> : null}
        {releasing ? <ReleaseForm row={releasing} onDone={() => setReleasing(null)} /> : null}
      </div>
    </Panel>
  );
}

function ReleaseForm({ row, onDone }: { row: Row; onDone: () => void }) {
  const release = useMutation(api.earlyOffer.release);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useRun();
  return (
    <form aria-label={`Release the place reserved by ${row.company}`} className="grid gap-3 rounded-xl border border-border p-4" onSubmit={(event) => (event.preventDefault(), void run(async () => (await release({ offerId: row.id as Id<"earlyOffers">, reason }), onDone())))}>
      <p className="text-sm text-strong">
        Give back the place reserved by <span className="font-medium">{row.company}</span>. Only do this when they will not pay: if Autumn later reports the $199 payment anyway, it is honored and the place is used again.
      </p>
      <Field label="Why" hint="Recorded with the release.">
        <TextArea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} autoFocus />
      </Field>
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={reason.trim().length < 5}>
          Release place
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
