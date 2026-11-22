"use client";

/**
 * Moving in from another system, during setup: where the owner's records are now, then clients,
 * appointments, recurring service, history and cleaners, each with help that fits that system and that
 * task. The review step shows what came in and what still waits for the owner.
 *
 * Help opens only when asked. The one first-time suggestion (the export card for the chosen system) can be
 * dismissed; the link that reopens it stays beside each upload.
 */
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import Link from "next/link";
import { useState } from "react";

import { canManage, useCompany } from "@/components/app/company";
import { messageOf } from "@/components/app/form";
import { TutorialCard, TutorialLink, SourcePicker, useSource } from "@/components/app/tutorials/offer";
import { Check, ChevronDown, TriangleAlert, Users } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/fields";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { CADENCE_WORDS } from "../../../../convex/lib/migration/records";
import { PLATFORM_WORDS } from "../../../../convex/lib/tutorials/catalog";
import { ConnectedImport } from "./connectors";
import { ClientImport } from "./import";
import { RecordImport } from "./records-import";

function More({ id, title, hint, children }: { id: string; title: string; hint: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-2xl border border-border bg-card [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-2xl px-4 py-3 focus-visible:outline-2 focus-visible:outline-brand-500" aria-describedby={`${id}-hint`}>
        <span className="grid flex-1 gap-0.5">
          <span className="text-sm font-semibold text-strong">{title}</span>
          <span id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </span>
        </span>
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
      </summary>
      <div className="border-t border-border p-4">{children}</div>
    </details>
  );
}

export function MigrationRecordsStep() {
  const [platform, setPlatform] = useSource();
  const named = platform && platform !== "spreadsheet" ? PLATFORM_WORDS[platform] : null;
  return (
    <>
      <SourcePicker value={platform} onChange={setPlatform} />
      {platform ? <TutorialCard key={platform} placement="setup.source" platform={platform} dismissKey={`setup.source:${platform}`} /> : null}
      <section className="grid gap-2" aria-labelledby="clients-heading">
        <h2 id="clients-heading" className="text-sm font-semibold text-strong">
          Your clients
        </h2>
        {platform === "jobber" || platform === "housecall_pro" || platform === null ? <ConnectedImport /> : null}
        <p className="text-xs text-muted-foreground">{named ? `Or from a ${named} export:` : "Or from a spreadsheet, including an export from Jobber, Housecall Pro or BookingKoala:"}</p>
        <ClientImport platform={platform} />
      </section>
      <section className="grid gap-2" aria-labelledby="more-heading">
        <h2 id="more-heading" className="text-sm font-semibold text-strong">
          More from {named ?? "your old system"}
        </h2>
        <p className="-mt-1 text-xs text-muted-foreground">Optional. Import clients first: each row is matched to one of them.</p>
        <More id="appointments" title="Upcoming appointments" hint="Visits already booked.">
          <RecordImport kind="appointment" platform={platform} />
        </More>
        <More id="recurring" title="Recurring service" hint="Which clients repeat, and how often.">
          <RecordImport kind="recurring" platform={platform} />
        </More>
        <More id="history" title="Invoices and service history" hint="Kept on each client for reference.">
          <RecordImport kind="history" platform={platform} />
        </More>
        <More id="team" title="Cleaners and team" hint="Brought in on the Cleaners page.">
          <div className="grid gap-3">
            <TutorialCard placement="import.team" platform={platform} />
            <Button variant="outline" render={<Link href="/app/cleaners/import" />} className="justify-self-start">
              <Users aria-hidden />
              Open cleaner import
            </Button>
          </div>
        </More>
      </section>
    </>
  );
}

type Summary = FunctionReturnType<typeof api.migrationImports.summary>;

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const dayWords = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const PAGE = 12;

/** On the review step: what came in, what still waits, and how to check it. */
export function MigrationReview() {
  const { companyId, role } = useCompany();
  const summary = useQuery(api.migrationImports.summary, canManage(role) ? { companyId } : "skip");
  if (!summary) return null;
  const records = summary.appointments.waiting + summary.appointments.setUp + summary.appointments.skipped + summary.recurring.waiting + summary.recurring.setUp + summary.recurring.skipped;
  const any = summary.clients + records + summary.history > 0;
  if (!any) return null;
  const visits = summary.appointments.upcoming;
  const schedules = summary.recurring.totals;
  return (
    <section className="grid gap-3 rounded-2xl border border-border bg-card p-4" aria-labelledby="imported-heading">
      <h2 id="imported-heading" className="text-sm font-semibold text-strong">
        What you brought in
      </h2>
      {records > 0 ? <Reconciliation summary={summary} /> : null}
      <ul className="grid gap-1 text-sm text-strong sm:grid-cols-2">
        <li>{count(summary.clients, "client")}</li>
        <li>{count(summary.history, "history record")}</li>
      </ul>
      {records > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[26rem] text-left text-sm">
            <caption className="sr-only">Imported appointments and recurring schedules, with the prices from your old system</caption>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  Imported
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Waiting
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Set up
                </th>
                <th scope="col" className="py-1.5 pl-3 font-medium">
                  Skipped
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border border-t border-border">
              {(
                [
                  ["Upcoming appointments", visits],
                  ["Recurring schedules, per visit", schedules],
                ] as const
              ).map(([label, row]) => (
                <tr key={label}>
                  <th scope="row" className="py-2 pr-3 font-medium text-strong">
                    {label}
                  </th>
                  {[row.waiting, row.setUp, row.skipped].map((bucket, index) => (
                    <td key={index} className={cn("py-2 tabular-nums", index === 2 ? "pl-3" : "px-3")}>
                      <span className="text-strong">{bucket.count.toLocaleString("en-US")}</span>
                      {bucket.count > 0 ? <span className="block text-xs text-muted-foreground">{bucket.unpriced === bucket.count ? "no prices imported" : `${money(bucket.amountCents)}${bucket.unpriced ? `, ${bucket.unpriced} without a price` : ""}`}</span> : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {summary.recurring.waiting || summary.appointments.waiting ? <Waiting total={summary.recurring.waiting + summary.appointments.waiting} /> : null}
      <TutorialLink placement="migration.review" platform={null} label="How to check your imported records" />
    </section>
  );
}

/**
 * The check before the old system is switched off: imported visits in the next 30 days against the
 * visits actually on the calendar here, and imported schedules against the plans running here.
 */
function Reconciliation({ summary }: { summary: Summary }) {
  const { from, days, visits, schedules, missing, missingCount, settled } = summary.reconciliation;
  const [shown, setShown] = useState(5);
  const old = from ?? "your old system";
  const waiting = visits.waiting + schedules.waiting;
  const confirmed = visits.confirmedByYou + schedules.confirmedByYou;
  const nothingUpcoming = visits.total + schedules.total === 0;
  const importedNote = visits.importedUnpriced ? ` (${count(visits.importedUnpriced, "visit")} came without a price)` : "";
  return (
    <div role="status" aria-labelledby="reconcile-heading" className={cn("grid gap-3 rounded-xl border p-3.5 sm:p-4", settled ? "border-success/35 bg-success/[0.07]" : "border-warning/40 bg-warning/10")}>
      <div className="flex items-start gap-2.5">
        {settled ? <Check className="mt-0.5 size-4 shrink-0 text-success-foreground" aria-hidden /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden />}
        <div className="grid min-w-0 gap-1">
          <h3 id="reconcile-heading" className="text-sm font-semibold text-strong">
            Before you stop using {old}
          </h3>
          <p className="text-sm leading-relaxed text-strong">
            {nothingUpcoming ? (
              "Nothing imported is still upcoming. Every imported visit and schedule was skipped or has passed."
            ) : (
              <>
                {visits.scheduled.toLocaleString("en-US")} of {count(visits.total, "upcoming visit")} in the next {days} days {visits.scheduled === 1 && visits.total === 1 ? "is" : "are"} scheduled here; {money(visits.importedCents)} imported
                {importedNote} vs {money(visits.scheduledCents)} scheduled; {waiting.toLocaleString("en-US")} still waiting.
              </>
            )}
          </p>
          {schedules.total > 0 ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {schedules.withPlan.toLocaleString("en-US")} of {count(schedules.total, "recurring schedule")} {schedules.withPlan === 1 && schedules.total === 1 ? "has" : "have"} an active plan here; {money(schedules.importedCents)} per visit imported vs {money(schedules.scheduledCents)} on those plans.
            </p>
          ) : null}
          <p className="text-sm leading-relaxed text-muted-foreground">
            {settled
              ? confirmed
                ? `Nothing is waiting. ${count(confirmed, "record")} you marked done ${confirmed === 1 ? "has" : "have"} no matching visit or plan here, so check your calendar covers ${confirmed === 1 ? "it" : "them"}.`
                : "Nothing is waiting. Everything upcoming is scheduled here or was skipped on purpose."
              : `Keep ${old} running until each waiting visit and schedule is booked here or skipped on purpose.`}
          </p>
        </div>
      </div>
      {missing.length ? (
        <div className="grid gap-1.5">
          <p className="text-xs font-medium text-strong">
            {count(missingCount, "upcoming visit")} with no visit here on that day
          </p>
          <ul className="grid gap-1" aria-label="Upcoming imported visits not on the calendar here">
            {missing.slice(0, shown).map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-card/70 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <Link href={`/app/clients/${row.customerId}/services?view=plans`} className="rounded font-medium text-strong underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-500">
                    {row.client || "Client"}
                  </Link>
                  <span className="block text-xs text-muted-foreground">
                    {dayWords(row.day)}
                    {row.time ? ` at ${row.time}` : ""}
                    {row.amountCents !== null ? ` · ${money(row.amountCents)}` : ""}
                  </span>
                </span>
                <Badge variant={row.state === "waiting" ? "warning" : "outline"} size="sm">
                  {row.state === "waiting" ? "Waiting" : "Marked done by you"}
                </Badge>
              </li>
            ))}
          </ul>
          {missing.length > shown ? (
            <Button size="xs" variant="ghost" className="justify-self-start" onClick={() => setShown((n) => n + 10)}>
              Show {Math.min(10, missing.length - shown)} more
            </Button>
          ) : missingCount > missing.length ? (
            <p className="text-xs text-muted-foreground">Showing the first {missing.length}. The rest appear as these are booked or skipped.</p>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs leading-relaxed text-muted-foreground">Importing never creates bookings or sends messages. A visit or a plan starts only when you book it yourself from the client&rsquo;s page.</p>
    </div>
  );
}

function Waiting({ total }: { total: number }) {
  const { companyId } = useCompany();
  const recurring = useQuery(api.migrationImports.waiting, { companyId, kind: "recurring" });
  const appointments = useQuery(api.migrationImports.waiting, { companyId, kind: "appointment" });
  const decide = useMutation(api.migrationImports.decide);
  const { ask, element } = useConfirm();
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const all = [...(recurring ?? []).map((row) => ({ ...row, kind: "recurring" as const })), ...(appointments ?? []).map((row) => ({ ...row, kind: "appointment" as const }))];
  const rows = all.slice(0, shown);
  type Row = (typeof all)[number];
  const what = (row: Row) => (row.kind === "recurring" ? "recurring schedule" : "appointment");

  const markDone = async (row: Row) => {
    const recordId = row.id as Id<"migrationRecords">;
    setBusy(row.id);
    setSaid(null);
    try {
      const result = await decide({ companyId, recordId, review: "set_up" });
      if (result.outcome === "linked") setSaid({ tone: "ok", text: `${row.client}: marked done and linked to the ${result.to === "visit" ? `visit on ${row.day ? dayWords(row.day) : "that day"}` : "recurring plan"} in Selestial.` });
      else if (result.outcome === "confirm_needed") {
        const confirmed = await ask({
          title: `Mark ${row.client}'s ${what(row)} done without a ${row.kind === "recurring" ? "plan" : "visit"} here?`,
          body: result.message,
          details: [
            { label: "Client", value: row.client },
            row.kind === "recurring" ? { label: "Schedule", value: row.cadence ? CADENCE_WORDS[row.cadence] : `"${row.frequency ?? ""}"` } : { label: "Visit", value: `${row.day ? dayWords(row.day) : "No date"}${row.time ? ` at ${row.time}` : ""}` },
          ],
          confirmLabel: "I've set this up myself",
          cancelLabel: "Keep it waiting",
          action: () => decide({ companyId, recordId, review: "set_up", confirmSelf: true }),
        });
        if (confirmed) setSaid({ tone: "ok", text: `${row.client}: marked done on your word. Selestial made no visit or plan.` });
      }
    } catch (error) {
      setSaid({ tone: "error", text: messageOf(error) });
    } finally {
      setBusy(null);
    }
  };

  const skip = async (row: Row) => {
    const skipped = await ask({
      title: `Skip ${row.client}'s ${what(row)}?`,
      body: "It stops counting as waiting and stays on the client's page for reference. Nothing is booked, cancelled or sent, here or in your old system.",
      confirmLabel: "Skip it",
      cancelLabel: "Keep it waiting",
      action: () => decide({ companyId, recordId: row.id as Id<"migrationRecords">, review: "dismissed" }),
    });
    if (skipped) setSaid({ tone: "ok", text: `${row.client}: skipped.` });
  };

  return (
    <div className="grid gap-2">
      <h3 className="text-xs font-medium text-strong">
        Waiting for you ({total.toLocaleString("en-US")})
      </h3>
      <ul className="grid gap-1.5" aria-label="Waiting for you">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 basis-48">
              <span className="font-medium text-strong">{row.client}</span>
              <span className="block text-xs text-muted-foreground">
                {row.kind === "recurring" ? (row.cadence ? CADENCE_WORDS[row.cadence] : `"${row.frequency ?? ""}" · choose the schedule`) : `Visit ${row.day ? dayWords(row.day) : ""}${row.time ? ` at ${row.time}` : ""}`}
                {row.amountCents !== null ? ` · ${money(row.amountCents)}` : ""}
                {row.description ? ` · ${row.description}` : ""}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              {/* Opens the client's existing plan form and its schedule preview; nothing is created from here. */}
              <Button size="xs" variant="outline" render={<Link href={`/app/clients/${row.customerId}/services?view=plans`} />}>
                {row.kind === "recurring" ? "Review schedule" : "Open client"}
              </Button>
              <Button size="xs" variant="ghost" loading={busy === row.id} disabled={busy !== null && busy !== row.id} onClick={() => void markDone(row)}>
                Mark done
              </Button>
              <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void skip(row)}>
                Skip
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {all.length > shown ? (
        <Button size="xs" variant="outline" className="justify-self-start" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, all.length - shown)} more ({(all.length - shown).toLocaleString("en-US")} not shown)
        </Button>
      ) : null}
      <p aria-live="polite" className={cn("text-xs", said?.tone === "error" ? "text-destructive-foreground" : "text-muted-foreground", said ? "" : "sr-only")}>
        {said?.text ?? ""}
      </p>
      {element}
    </div>
  );
}

/** On a client's services tab: what was imported for them, kept as it came. */
export function ImportedRecords({ customerId }: { customerId: Id<"customers"> }) {
  const { companyId, role } = useCompany();
  const rows = useQuery(api.migrationImports.forClient, canManage(role) ? { companyId, customerId } : "skip");
  if (!rows?.length) return null;
  return (
    <details className="rounded-2xl border border-border bg-card [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium text-strong">
        Brought from your old system ({rows.length})
        <ChevronDown className="ml-auto size-4 text-muted-foreground" aria-hidden />
      </summary>
      <ul className="grid gap-1 border-t border-border p-3 text-sm">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap gap-x-3 rounded-lg px-2 py-1.5">
            <span className="w-24 shrink-0 tabular-nums text-muted-foreground">{row.day ?? "—"}</span>
            <span className="min-w-0 flex-1 text-strong">
              {row.kind === "recurring" ? `Recurring: ${row.cadence ? CADENCE_WORDS[row.cadence] : (row.frequency ?? "")}` : row.kind === "appointment" ? `Appointment${row.time ? ` at ${row.time}` : ""}` : "History"}
              {row.description ? ` · ${row.description}` : ""}
              {row.reference ? ` · #${row.reference}` : ""}
            </span>
            {row.amountCents !== null ? <span className="tabular-nums text-muted-foreground">{money(row.amountCents)}</span> : null}
          </li>
        ))}
      </ul>
      <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">Kept for reference as it came. Nothing here is booked, billed or sent.</p>
    </details>
  );
}
