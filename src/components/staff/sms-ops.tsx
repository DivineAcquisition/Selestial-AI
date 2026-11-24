"use client";

/**
 * Staff › Texting operations: whether texting is healthy across Selestial (convex/smsOps.ts). The Telnyx
 * account, the send queue, the last day of company texts, Selestial's own texts and sign-in codes, and the
 * open texting incidents. Below, each staff member's own phone for critical alerts (convex/staffAlerts.ts).
 */
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { Field, FormError, useRun } from "@/components/app/form";
import { PageHeader, Panel } from "@/components/app/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PhoneInput, phoneProblem } from "@/components/ui/fields";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

import { api } from "../../../convex/_generated/api";

const REFUSAL_WORDS: Record<string, string> = {
  sender_not_ready: "Code sender not set up (Clerk delivers)",
  destination_limit: "Too many to one number",
  person_limit: "Too many for one person",
  number_block_limit: "Too many to one number block",
  platform_limit: "Hourly circuit breaker",
  unsupported_route: "Not a supported US number",
  provider_block: "Opted out with the carrier",
};

function ago(now: number, at: number | null): string {
  if (at === null) return "—";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`;
}

function waiting(now: number, row: { count: number; oldest: number | null }): string {
  return row.count === 0 ? "0" : `${row.count} · oldest ${ago(now, row.oldest)}`;
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "bad" | "warn" }) {
  return (
    <div className="rounded-xl bg-muted/50 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${tone === "bad" ? "text-destructive-foreground" : tone === "warn" ? "text-warning-foreground" : "text-strong"}`}>{value}</p>
    </div>
  );
}

export function SmsOperations() {
  const view = useQuery(api.smsOps.overview, {});
  return (
    <>
      <PageHeader title="Texting operations" lead="Whether texting is healthy across Selestial: the Telnyx account, what's waiting to send, how texts fared, Selestial's own sign-in codes and notices, and what needs a look. Counts only: no message words, codes or full numbers." />
      {view === undefined ? (
        <Skeleton className="h-96 rounded-2xl" />
      ) : (
        <div className="grid gap-4">
          <Panel title="Telnyx account" action={view.telnyx ? <Badge variant={view.telnyx.outcome === "ok" ? "success" : "error"}>{view.telnyx.outcome === "ok" ? "Key works" : view.telnyx.outcome === "refused" ? "Key refused" : "Not answering"}</Badge> : <Badge variant="outline">Not checked yet</Badge>}>
            {view.telnyx ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="Last read-only check" value={`${ago(view.now, view.telnyx.at)} ago`} />
                <Stat label="Available balance" value={view.telnyx.balanceDollars === null ? "—" : `$${view.telnyx.balanceDollars.toFixed(2)}`} tone={view.telnyx.balanceDollars !== null && view.telnyx.balanceDollars < 50 ? "warn" : undefined} />
                <Stat label="Selestial's own texts, last day" value={`$${view.platform.spendDollars.toFixed(2)}`} />
                {view.telnyx.detail ? <p className="text-sm text-destructive-foreground sm:col-span-3">{view.telnyx.detail}</p> : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">The hourly check hasn&rsquo;t run on this backend yet, or TELNYX_API_KEY isn&rsquo;t set.</p>
            )}
          </Panel>

          <Panel title="Send queue (company texts)">
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Queued" value={waiting(view.now, view.queue.queued)} />
              <Stat label="Held (hours, funds, pause)" value={waiting(view.now, view.queue.held)} />
              <Stat label="Sending now" value={waiting(view.now, view.queue.sending)} tone={view.queue.sending.count > 0 && view.queue.sending.oldest !== null && view.now - view.queue.sending.oldest > 10 * 60_000 ? "warn" : undefined} />
              <Stat label="Not known whether sent" value={view.queue.unconfirmed.count} tone={view.queue.unconfirmed.count > 0 ? "warn" : undefined} />
            </div>
          </Panel>

          <Panel title="Company texts, last 24 hours">
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Delivered" value={view.day.delivered} />
              <Stat label="Provider accepted" value={view.day.accepted} />
              <Stat label="Delivery not confirmed" value={view.day.notConfirmed} tone={view.day.notConfirmed > 0 ? "warn" : undefined} />
              <Stat label="Failed" value={view.day.failed} tone={view.day.failed > 0 ? "bad" : undefined} />
            </div>
          </Panel>

          <Panel title="Selestial's own texts, last 24 hours">
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Sign-in codes sent" value={view.platform.codesSent} />
              <Stat label="Codes failed or unconfirmed" value={view.platform.codesFailed} tone={view.platform.codesFailed > 0 ? "bad" : undefined} />
              <Stat label="Notices and alerts sent" value={view.platform.notices} />
            </div>
            {Object.keys(view.platform.codesRefused).length ? (
              <div className="mt-3 grid gap-1">
                <p className="text-sm font-medium text-strong">Codes not sent, by reason</p>
                <ul className="grid gap-1 text-sm text-muted-foreground">
                  {Object.entries(view.platform.codesRefused).map(([reason, count]) => (
                    <li key={reason} className="flex justify-between gap-3 rounded-lg bg-muted/40 px-3 py-1.5">
                      <span>{REFUSAL_WORDS[reason] ?? reason}</span>
                      <span className="tabular-nums text-strong">{count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Panel>

          <Panel title="Open texting incidents">
            {view.incidents.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Nothing open.</p>
            ) : (
              <ul className="divide-y divide-border">
                {view.incidents.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <span className="min-w-0 text-sm text-strong">{row.title}</span>
                    <span className="flex items-center gap-2">
                      <Badge variant={row.severity === "critical" ? "error" : row.severity === "high" ? "warning" : "outline"}>{row.severity}</Badge>
                      <span className="text-xs text-muted-foreground">{ago(view.now, row.since)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Details, records and recovery are in{" "}
              <Link href="/staff/operations" className="font-medium text-strong underline-offset-2 hover:underline">
                Operations
              </Link>
              .
            </p>
          </Panel>

          <AlertPhone />
        </div>
      )}
    </>
  );
}

/** This staff member's own phone for critical alerts, confirmed with a code. */
function AlertPhone() {
  const mine = useQuery(api.staffAlerts.mine, {});
  const start = useMutation(api.staffAlerts.startPhone);
  const confirm = useMutation(api.staffAlerts.confirmPhone);
  const remove = useMutation(api.staffAlerts.removePhone);
  const { busy, error, run } = useRun();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  if (mine === undefined) return null;
  return (
    <Panel title="My alert phone">
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">Critical incidents are also texted to your own confirmed phone, naming the incident and its reference only. It isn&rsquo;t a sign-in method and approves nothing.</p>
        {!mine.senderReady ? (
          <p className="text-sm text-muted-foreground">Selestial&rsquo;s notice sender isn&rsquo;t set up yet (PLATFORM_SMS_NOTICES_FROM and _PROFILE_ID), so alert texts can&rsquo;t be sent.</p>
        ) : mine.phoneLast4 ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-strong">Alerts go to your phone ending {mine.phoneLast4}.</p>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => remove({}))}>
              Stop alert texts
            </Button>
          </div>
        ) : mine.pending ? (
          <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => (event.preventDefault(), void run(() => confirm({ code })))}>
            <Field label={`Code sent to the phone ending ${mine.pending.last4}`}>
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />
            </Field>
            <Button type="submit" size="sm" loading={busy} disabled={code.length !== 6}>
              Confirm
            </Button>
          </form>
        ) : (
          <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => (event.preventDefault(), void run(() => start({ phone })))}>
            <Field label="Your mobile number">
              <PhoneInput value={phone} onChange={setPhone} />
            </Field>
            <Button type="submit" size="sm" loading={busy} disabled={!phone.trim() || phoneProblem(phone) !== null}>
              Text me a code
            </Button>
          </form>
        )}
        <FormError message={error} />
      </div>
    </Panel>
  );
}
