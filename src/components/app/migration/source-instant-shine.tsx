"use client";

/**
 * Moving from Instant Shine: load the read-only export, see what each record becomes before anything is
 * staged, stage it into this migration for the usual review, and apply the company settings it carries. Every
 * count here is computed from the export itself; nothing is imported, sent or charged from this panel.
 */
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { ArrowUpRight, CheckCircle2, CircleAlertIcon, Clock, Upload } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import { adaptInstantShine, type Adapted, type Outcome, type Snapshot } from "../../../../convex/lib/migration/sources/instantShine/adapt";
import { CATALOG_BY_TABLE, FAMILY_WORDS, type Family } from "../../../../convex/lib/migration/sources/instantShine/catalog";

type Report = Omit<Adapted, "files"> & { files: { kind: string; name: string; rows: number }[] };

const OUTCOME: Record<Outcome, { words: string; tone: string }> = {
  staged: { words: "Moving into Selestial", tone: "text-success-foreground" },
  merged: { words: "Combined with a matching record", tone: "text-success-foreground" },
  review: { words: "Waiting for your decision", tone: "text-warning-foreground" },
  archived: { words: "Kept as history", tone: "text-muted-foreground" },
  retained: { words: "Stays in Instant Shine for now", tone: "text-muted-foreground" },
  excluded: { words: "Not moved", tone: "text-muted-foreground" },
};

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clock = (m: number) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${m >= 720 ? "PM" : "AM"}`;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Today on the company's own calendar, so "upcoming" means the same thing as in Selestial. */
function todayIn(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Who runs each workflow while the pilot is on. Nothing moves from Instant Shine until the Owner switches it. */
const WORKFLOWS: { name: string; now: string; blocker: string }[] = [
  { name: "Team", now: "Instant Shine", blocker: "Cleaners arrive as onboarding with no invitation. Release the team, then invite each cleaner when you're ready." },
  { name: "Schedule and crews", now: "Instant Shine", blocker: "Visits stay held until you release them. Instant Shine's reminders and photo links keep running for its own visits." },
  { name: "Recurring visits", now: "Instant Shine", blocker: "Each recurring customer needs a next visit date and arrival time; Instant Shine never recorded them." },
  { name: "Customer messages", now: "Instant Shine", blocker: "Texting and email stay off here until messaging is set up and you switch it on. Opt-outs are applied first." },
  { name: "Online booking", now: "Instant Shine", blocker: "Your booking page stays where it is. Publish Selestial's only when you move bookings over." },
  { name: "Payments", now: "Instant Shine (Stripe)", blocker: "Deposits and balances are charged by Instant Shine's Stripe account. Nothing is charged, refunded or paid out here." },
];

export function InstantShinePanel() {
  const { companyId, timezone, role } = useCompany();
  const saved = useQuery(api.migrationSources.report, { companyId });
  const stageFile = useMutation(api.migrationSources.stageFile);
  const stageRows = useMutation(api.migrationSources.stageRows);
  const finishFile = useMutation(api.migrationSources.finishFile);
  const saveReport = useMutation(api.migrationSources.saveReport);
  const saveAvailability = useMutation(api.configure.saveAvailability);
  const setPolicy = useMutation(api.dispatchOps.setPolicy);
  const applyPay = useMutation(api.migrationSources.applyImportedPay);
  const { busy, error, run } = useRun();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [include, setInclude] = useState<string[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [applied, setApplied] = useState<Record<string, string>>({});
  const owner = role === "owner";

  const adapted = useMemo(() => (snapshot ? adaptInstantShine(snapshot, { today: todayIn(timezone), include }) : null), [snapshot, include, timezone]);
  const report: Report | null = useMemo(() => {
    if (adapted) return { ...adapted, files: adapted.files.map((f) => ({ kind: f.kind, name: f.name, rows: f.rows.length })) };
    if (!saved) return null;
    try {
      return JSON.parse(saved.report) as Report;
    } catch {
      return null;
    }
  }, [adapted, saved]);

  const load = (file: File) =>
    void run(async () => {
      const parsed = JSON.parse(await file.text()) as Snapshot;
      if (!parsed || typeof parsed !== "object" || !parsed.tables) throw new Error("This isn't an Instant Shine export: it has no tables.");
      setSnapshot(parsed);
      setInclude([]);
    });

  const stage = () =>
    void run(async () => {
      if (!adapted) return;
      for (const [at, file] of adapted.files.entries()) {
        setProgress(`Staging ${file.name.toLowerCase()} (${at + 1} of ${adapted.files.length})…`);
        const { fileId, already } = await stageFile({ companyId, source: "instant_shine", kind: file.kind, name: file.name, header: file.header, rowCount: file.rows.length, sha256: await sha256(JSON.stringify([file.header, file.rows])) });
        if (!already) {
          for (let start = 0; start < file.rows.length; start += 400) await stageRows({ companyId, fileId, start, rows: file.rows.slice(start, start + 400).map((r) => r.cells) });
        }
        await finishFile({ companyId, fileId });
      }
      const { files, ...rest } = adapted;
      await saveReport({ companyId, source: "instant_shine", instance: adapted.instance, snapshotAt: adapted.snapshotAt, report: JSON.stringify({ ...rest, files: files.map((f) => ({ kind: f.kind, name: f.name, rows: f.rows.length })) }) });
      setProgress("Staged. Review each record in the steps below; nothing is imported until you start the import.");
    });

  const families = useMemo(() => {
    if (!report) return [];
    const by = new Map<Family, { outcomes: Partial<Record<Outcome, number>>; total: number; reasons: Map<string, number> }>();
    for (const r of report.records) {
      const family = CATALOG_BY_TABLE.get(r.table)?.family ?? "platform";
      const entry = by.get(family) ?? { outcomes: {} as Partial<Record<Outcome, number>>, total: 0, reasons: new Map<string, number>() };
      entry.outcomes[r.outcome] = (entry.outcomes[r.outcome] ?? 0) + 1;
      entry.total += 1;
      const reason = r.outcome === "review" || r.outcome === "excluded" ? r.reason.replace(/\(.*?\)/g, "").trim() : "";
      if (reason) entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1);
      by.set(family, entry);
    }
    return [...by.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [report]);

  const pending = report ? report.records.filter((r) => r.outcome === "review").length : 0;
  const pay = report?.config.pay.rule;

  return (
    <section aria-labelledby="instant-shine" className="grid gap-5 rounded-2xl border border-brand-500/30 bg-card p-5 sm:p-6">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="instant-shine" className="font-heading text-xl tracking-tight text-strong">
            Moving from Instant Shine
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Load the read-only export of your Instant Shine workspace. You&apos;ll see what each record becomes before anything is staged, and Instant Shine keeps running everything until you move each part over.</p>
        </div>
        {report ? <Badge variant={report.consistent === false ? "warning" : "outline"}>{report.snapshotAt ? `Export from ${new Date(report.snapshotAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Export loaded"}</Badge> : null}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <label className={cn("inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-strong hover:border-brand-500/40", busy && "pointer-events-none opacity-60")}>
          <Upload aria-hidden className="size-4" />
          {snapshot ? "Load a newer export" : "Load the export"}
          <input type="file" accept=".json,application/json" className="sr-only" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
        </label>
        {adapted ? (
          <Button variant="primary" size="sm" loading={busy} onClick={stage}>
            Stage for review
          </Button>
        ) : null}
        {progress ? (
          <p role="status" className="text-sm text-muted-foreground">
            {progress}
          </p>
        ) : null}
      </div>
      {report?.consistent === false ? <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-strong">Instant Shine changed while this export was taken. Take a new export before staging.</p> : null}
      <FormError message={error} />

      {report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat icon={CheckCircle2} value={report.records.filter((r) => r.outcome === "staged" || r.outcome === "merged").length} words="records moving into Selestial" />
            <Stat icon={CircleAlertIcon} value={pending} words={pending === 1 ? "waits for your decision" : "wait for your decision"} />
            <Stat icon={Clock} value={report.records.filter((r) => r.outcome === "archived" || r.outcome === "retained").length} words="kept as history or left in Instant Shine" />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {families.map(([family, entry]) => (
              <article key={family} className="grid content-start gap-2 rounded-xl border border-border p-4">
                <h3 className="text-sm font-semibold text-strong">{FAMILY_WORDS[family]}</h3>
                <ul className="grid gap-1 text-sm">
                  {(Object.keys(OUTCOME) as Outcome[])
                    .filter((o) => entry.outcomes[o])
                    .map((o) => (
                      <li key={o} className="flex justify-between gap-3">
                        <span className={OUTCOME[o].tone}>{OUTCOME[o].words}</span>
                        <span className="font-medium text-strong tabular-nums">{entry.outcomes[o]}</span>
                      </li>
                    ))}
                </ul>
                {entry.reasons.size ? (
                  <ul className="mt-1 grid gap-1 border-t border-border pt-2 text-xs text-muted-foreground">
                    {[...entry.reasons.entries()].slice(0, 3).map(([reason, n]) => (
                      <li key={reason}>
                        {n > 1 ? `${n} × ` : ""}
                        {reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>

          {report.flags.heldBack.length ? (
            <div className="grid gap-2">
              <h3 className="text-sm font-semibold text-strong">Held back: looks like a test or staff record</h3>
              <p className="-mt-1 text-xs text-muted-foreground">{snapshot ? "Tick any that are real, and they're included when you stage." : "Load the export again to include any of these."}</p>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {report.flags.heldBack.map((h) => (
                  <li key={h.ref} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                    {snapshot ? <input type="checkbox" className="mt-0.5 size-4 accent-brand-500" checked={include.includes(h.ref)} onChange={(e) => setInclude((cur) => (e.target.checked ? [...cur, h.ref] : cur.filter((x) => x !== h.ref)))} aria-label={`Include ${h.label}`} /> : null}
                    <span className="min-w-0">
                      <span className="block font-medium text-strong">{h.label}</span>
                      <span className="block text-xs text-muted-foreground">{h.why}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-2">
            <article className="grid content-start gap-2 rounded-xl border border-border p-4">
              <h3 className="text-sm font-semibold text-strong">Money, as Instant Shine recorded it</h3>
              <p className="text-xs text-muted-foreground">Kept for reference. Nothing here is charged, refunded or turned into an invoice; Instant Shine&apos;s Stripe account keeps handling payments.</p>
              <table className="mt-1 w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="font-medium">Payment</th>
                    <th className="text-right font-medium">Visits</th>
                    <th className="text-right font-medium">Total</th>
                    <th className="text-right font-medium">Deposits</th>
                    <th className="text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {report.finance.totals.map((t) => (
                    <tr key={t.paymentStatus} className="border-t border-border">
                      <td className="py-1.5 capitalize">{t.paymentStatus.replace(/_/g, " ")}</td>
                      <td className="text-right tabular-nums">{t.visits}</td>
                      <td className="text-right tabular-nums">{money(t.totalCents)}</td>
                      <td className="text-right tabular-nums">{money(t.depositCents)}</td>
                      <td className="text-right tabular-nums">{money(t.balanceCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>

            <article className="grid content-start gap-3 rounded-xl border border-border p-4">
              <h3 className="text-sm font-semibold text-strong">Settings from Instant Shine</h3>
              <SettingRow
                title={`${report.config.serviceAreas.length} ZIP codes, ${report.config.hours.length ? `${report.config.hours.map((h) => DAYS[h.weekday]).join(", ")} ${clock(report.config.hours[0].startMinute)}–${clock(report.config.hours[0].endMinute)}` : "no hours"}`}
                detail={`Booking area and hours, in ${report.config.timezone ?? "your time zone"}.${report.flags.outOfArea ? ` ${report.flags.outOfArea} customers are at ZIP codes outside this list: add those first if you serve them.` : ""}`}
                done={applied.areas}
                action={owner ? { label: "Apply to your booking area and hours", run: () => void run(async () => (await saveAvailability({ companyId, serviceAreas: report.config.serviceAreas, hours: report.config.hours }), setApplied((a) => ({ ...a, areas: "Applied." })))) } : null}
              />
              <SettingRow
                title={pay ? `${pay.shareBps / 100}% of the job, split by crew` : "Crew pay varies by crew size"}
                detail={pay ? "Instant Shine's pay for contractors. Applied to imported cleaners with no pay set yet; pay you've already set is kept. Imported visits keep the exact pay recorded on them." : "Set each cleaner's pay in Team: Selestial can't hold a different rate per crew size in one share."}
                done={applied.pay}
                action={owner && pay ? { label: "Use this crew pay", run: () => void run(async () => { await setPolicy({ companyId, policy: { crewPayMode: "split_by_crew" } }); const result = await applyPay({ companyId, shareBps: pay.shareBps }); setApplied((a) => ({ ...a, pay: `Crew pay set. ${result.set} cleaner${result.set === 1 ? "" : "s"} updated, ${result.kept} kept as they were.` })); }) } : null}
              />
              {report.config.promotions.map((p) => (
                <SettingRow key={p.code} title={`Promotion ${p.code}`} detail={`${p.words}. Selestial applies a promotion only after you approve it in Services & Pricing.`} done={undefined} action={null} />
              ))}
              {!owner ? <p className="text-xs text-muted-foreground">Only the Owner applies these.</p> : null}
            </article>
          </div>

          <article className="grid gap-2 rounded-xl border border-border p-4">
            <h3 className="text-sm font-semibold text-strong">Who runs what during the pilot</h3>
            <ul className="divide-y divide-border text-sm">
              {WORKFLOWS.map((w) => (
                <li key={w.name} className="grid gap-1 py-2 sm:grid-cols-[10rem_11rem_minmax(0,1fr)] sm:items-start sm:gap-3">
                  <span className="font-medium text-strong">{w.name}</span>
                  <span>
                    <Badge variant="outline">{w.now}</Badge>
                  </span>
                  <span className="text-muted-foreground">{w.blocker}</span>
                </li>
              ))}
            </ul>
          </article>

          {report.links.some((l) => l.count) ? (
            <article className="grid gap-2 rounded-xl border border-border p-4">
              <h3 className="text-sm font-semibold text-strong">Links customers and cleaners already have</h3>
              <ul className="grid gap-1 text-sm">
                {report.links
                  .filter((l) => l.count)
                  .map((l) => (
                    <li key={l.kind}>
                      <span className="font-medium text-strong">
                        {l.count} {l.kind.toLowerCase()}
                      </span>
                      <span className="text-muted-foreground">: {l.what}</span>
                    </li>
                  ))}
              </ul>
            </article>
          ) : null}

          <div className="flex flex-wrap gap-2 text-sm">
            <Button variant="outline" size="sm" render={<Link href="/app/clients" />}>
              Clients <ArrowUpRight aria-hidden className="size-3.5" />
            </Button>
            <Button variant="outline" size="sm" render={<Link href="/app/cleaners" />}>
              Cleaners <ArrowUpRight aria-hidden className="size-3.5" />
            </Button>
            <Button variant="outline" size="sm" render={<Link href="/app/services" />}>
              Services & Pricing <ArrowUpRight aria-hidden className="size-3.5" />
            </Button>
          </div>
        </>
      ) : saved === undefined ? null : (
        <p className="text-sm text-muted-foreground">No export loaded yet.</p>
      )}
    </section>
  );
}

function Stat({ icon: Icon, value, words }: { icon: typeof CheckCircle2; value: number; words: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border px-4 py-3">
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <p className="min-w-0 text-sm text-muted-foreground">
        <span className="block text-xl font-semibold text-strong tabular-nums">{value}</span>
        {words}
      </p>
    </div>
  );
}

function SettingRow({ title, detail, done, action }: { title: string; detail: string; done: string | undefined; action: { label: string; run: () => void } | null }) {
  return (
    <div className="grid gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <p className="text-sm font-medium text-strong">{title}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
      {done ? (
        <p role="status" className="text-xs text-success-foreground">
          {done}
        </p>
      ) : action ? (
        <div>
          <Button variant="outline" size="sm" onClick={action.run}>
            {action.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
