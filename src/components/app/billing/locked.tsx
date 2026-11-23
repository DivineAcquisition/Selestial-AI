"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";

import { useRun } from "@/components/app/form";
import { useNow } from "@/components/app/use-now";
import { UserMenu, useSignOut } from "@/components/auth/user-menu";
import { Logo } from "@/components/brand/logo";
import { CalendarIcon, Check, CheckCircle2, Lock, PauseCircleIcon, RefreshCw, ShieldCheck, Wallet, XCircle } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

export type LockStatus = FunctionReturnType<typeof api.billingLock.status>;

const DAY = 86_400_000;

function money(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function day(at: number, timezone?: string) {
  return new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", ...(timezone ? { timeZone: timezone } : {}) });
}

/** What the lock leaves running, so nobody worries their customers were cut off. */
const STILL_WORKING = ["Customers can book from your booking pages", "Quote and payment links keep working", "Cleaners keep their portal and job links", "Every record is kept, nothing is deleted"];
const PAUSED = ["Your team can't open the workspace", "Every agent is paused: no new texts, emails or AI work"];

type Step = { label: string; detail: string; state: "done" | "failed" | "current" | "upcoming" };

function Timeline({ steps }: { steps: Step[] }) {
  return (
    <ol className="relative grid gap-5">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const Icon = step.state === "failed" ? XCircle : step.state === "current" ? Lock : step.state === "upcoming" ? CalendarIcon : CheckCircle2;
        return (
          <li key={step.label} className="relative flex gap-3">
            {!last ? <span aria-hidden className="absolute top-8 left-[15px] h-[calc(100%-12px)] w-px bg-border" /> : null}
            <span
              aria-hidden
              className={cn(
                "relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border",
                step.state === "failed" && "border-destructive/30 bg-destructive/10 text-destructive-foreground",
                step.state === "current" && "border-brand-500/40 bg-brand-500/15 text-brand-300 shadow-[0_0_0_4px_rgba(104,56,239,0.12)]",
                step.state === "upcoming" && "border-dashed border-border bg-background text-muted-foreground",
                step.state === "done" && "border-success/40 bg-success/10 text-success-foreground",
              )}
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 pt-1">
              <span className={cn("block text-sm font-medium", step.state === "upcoming" ? "text-muted-foreground" : "text-strong")}>{step.label}</span>
              <span className="block text-xs leading-relaxed text-muted-foreground">{step.detail}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** "Update card": Stripe's secure page, reached through the same billing intent the Plan & Usage page uses. */
function useCardUpdate(companyId: Id<"companies">) {
  const portal = useMutation(api.billing.openBillingPortal);
  const [intentId, setIntentId] = useState<Id<"billingIntents"> | null>(null);
  const intent = useQuery(api.billing.intent, intentId ? { companyId, intentId } : "skip");
  useEffect(() => {
    if (intent?.url) window.location.assign(intent.url);
  }, [intent?.url]);
  const waiting = intentId !== null && !intent?.url && !intent?.problem;
  return { start: async () => setIntentId((await portal({ companyId, purpose: "payment_method" })) as Id<"billingIntents">), waiting, problem: intent?.problem ?? null };
}

/**
 * The whole app, while the Selestial plan is unpaid after two failed payments (convex/billingLock.ts).
 * The Owner sees what's owed and pays; everyone else sees who can. The page reopens by itself the
 * moment Stripe reports the payment, because the lock is read live.
 */
/**
 * The Owner's records stay theirs while the account is locked: one file with everything the company holds,
 * prepared on request and downloadable for 24 hours. Nothing here needs the plan to be paid.
 */
function LockedExport({ companyId }: { companyId: Id<"companies"> }) {
  const rows = useQuery(api.dataRights.exports, { companyId });
  const request = useMutation(api.dataRights.requestExport);
  const download = useMutation(api.dataRights.downloadUrl);
  const { busy, error, run } = useRun();
  const latest = rows?.find((row) => row.status === "ready" || row.status === "preparing") ?? null;
  return (
    <section className="rounded-3xl border border-border bg-card p-6" aria-labelledby="locked-export">
      <h2 id="locked-export" className="text-sm font-semibold text-strong">
        Your records are still yours
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">Download one file with every record your company holds. Nothing is deleted while the account is locked.</p>
      <div className="mt-4">
        {latest?.status === "ready" ? (
          <Button
            variant="outline"
            size="sm"
            loading={busy}
            onClick={() =>
              void run(async () => {
                const { url } = await download({ companyId, exportId: latest.id });
                window.location.assign(url);
              })
            }
          >
            Download your records
          </Button>
        ) : latest?.status === "preparing" ? (
          <p className="text-sm text-strong" role="status">
            Preparing your file. It appears here when it&rsquo;s ready, usually within a few minutes.
          </p>
        ) : (
          <Button variant="outline" size="sm" loading={busy} onClick={() => void run(() => request({ companyId }))}>
            Prepare a download
          </Button>
        )}
      </div>
      {error ? (
        <p className="mt-3 text-sm text-destructive-foreground" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function AccountLocked({ companyId, status, businesses, onSwitch }: { companyId: Id<"companies">; status: LockStatus; businesses?: { companyId: string; name: string; locked?: boolean }[]; onSwitch?: (companyId: string) => void }) {
  const refresh = useMutation(api.billing.refresh);
  const card = useCardUpdate(companyId);
  const { busy, error, run } = useRun();
  const signOut = useSignOut();
  const timezone = status.timezone;
  const amount = money(status.amountCents, status.currency);
  const now = useNow();
  const daysLeft = status.cancelAt && now ? Math.max(0, Math.ceil((status.cancelAt - now) / DAY)) : null;
  const others = (businesses ?? []).filter((row) => row.companyId !== companyId);

  const steps: Step[] = [
    { label: "Payment didn't go through", detail: status.firstFailedAt ? day(status.firstFailedAt, timezone) : "First attempt", state: "failed" },
    { label: "Tried again, also declined", detail: status.lastFailedAt ? `${day(status.lastFailedAt, timezone)} · attempt ${status.attempts}` : `Attempt ${status.attempts}`, state: "failed" },
    { label: "Account locked", detail: status.lockedAt ? `Since ${day(status.lockedAt, timezone)}. Pay to reopen it at once.` : "Pay to reopen it at once.", state: "current" },
    { label: "Plan canceled if still unpaid", detail: status.cancelAt ? `${day(status.cancelAt, timezone)}${daysLeft !== null ? ` · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : ""}` : "After 30 days locked", state: "upcoming" },
  ];

  return (
    <main className="relative isolate min-h-dvh overflow-hidden bg-background">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-40 -z-10 h-[520px] bg-[radial-gradient(ellipse_at_top,rgba(104,56,239,0.22),transparent_65%)]" />
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_right,rgba(104,56,239,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(104,56,239,0.05)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />

      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <UserMenu />
      </header>

      <div className="mx-auto w-full max-w-5xl px-4 pb-16 sm:px-6">
        <div className="mx-auto mt-4 grid max-w-4xl gap-5 lg:mt-10 lg:grid-cols-[1.25fr_1fr]">
          <section className="rounded-3xl border border-border bg-card p-6 shadow-[0_30px_80px_-40px_rgba(41,20,110,0.45)] sm:p-8" aria-labelledby="locked-title">
            <div className="flex items-center gap-3">
              <span className="relative flex size-12 items-center justify-center rounded-2xl border border-brand-500/30 bg-gradient-to-b from-brand-500/20 to-brand-500/5 text-brand-300" aria-hidden>
                <Lock className="size-6" />
                <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full border-2 border-card bg-destructive text-white">
                  <XCircle className="size-3" />
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive-foreground">
                <span className="size-1.5 rounded-full bg-destructive" aria-hidden />
                Account locked · payment failed
              </span>
            </div>

            <h1 id="locked-title" className="mt-6 font-heading text-2xl tracking-tight text-balance text-strong sm:text-3xl">
              {status.companyName}&rsquo;s account is locked until the payment goes through
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
              We tried twice to collect the Selestial plan payment and both attempts were declined. {status.owner ? "Pay the invoice and your workspace reopens right away, with everything just as you left it." : `Only the Owner${status.ownerName ? `, ${status.ownerName},` : ""} can pay. Once they do, the workspace reopens for everyone right away.`}
            </p>

            <div className="mt-6 rounded-2xl border border-border bg-background p-4 sm:p-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <span>
                  <span className="block text-xs font-medium tracking-wide text-muted-foreground uppercase">Amount due</span>
                  <span className="mt-1 block font-heading text-4xl tracking-tight text-strong tabular-nums">{amount}</span>
                </span>
                {daysLeft !== null ? (
                  <span className="rounded-xl border border-border bg-card px-3 py-2 text-right">
                    <span className="block text-xs text-muted-foreground">Plan canceled in</span>
                    <span className="block text-sm font-semibold text-strong tabular-nums">
                      {daysLeft} day{daysLeft === 1 ? "" : "s"}
                    </span>
                  </span>
                ) : null}
              </div>
              {status.owner && status.failure ? <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">Card issuer said: {status.failure}</p> : null}
            </div>

            {status.owner ? (
              <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
                {status.payUrl ? (
                  <a href={status.payUrl} className={cn(buttonVariants({ variant: "gradient", size: "lg" }), "w-full sm:col-span-2")}>
                    <Wallet className="size-4" aria-hidden />
                    Pay {amount} now
                  </a>
                ) : null}
                <Button variant={status.payUrl ? "outline" : "gradient"} size="lg" className={cn("w-full", !status.payUrl && "sm:col-span-2")} loading={busy || card.waiting} onClick={() => void run(card.start)}>
                  Update card
                </Button>
                <Button variant="outline" size="lg" className="w-full" loading={busy} onClick={() => void run(() => refresh({ companyId }))}>
                  <RefreshCw className="size-4" aria-hidden />
                  I&rsquo;ve paid, check again
                </Button>
              </div>
            ) : (
              <div className="mt-6 rounded-2xl border border-brand-500/25 bg-brand-500/5 p-4 text-sm text-strong">
                <p className="font-medium">Ask {status.ownerName ?? "your company's Owner"} to pay</p>
                <p className="mt-1 text-muted-foreground">They&rsquo;ve been emailed the details. This page opens by itself the moment the payment goes through.</p>
              </div>
            )}
            {error || card.problem ? <p className="mt-3 text-sm text-destructive-foreground" role="alert">{error ?? card.problem}</p> : null}
            <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
              Payments are handled on Stripe&rsquo;s secure page. Selestial never sees your card number.
            </p>
          </section>

          <aside className="grid content-start gap-5">
            <section className="rounded-3xl border border-border bg-card p-6" aria-labelledby="locked-timeline">
              <h2 id="locked-timeline" className="text-sm font-semibold text-strong">
                What happened
              </h2>
              <div className="mt-4">
                <Timeline steps={steps} />
              </div>
            </section>

            <section className="rounded-3xl border border-border bg-card p-6" aria-labelledby="locked-running">
              <h2 id="locked-running" className="text-sm font-semibold text-strong">
                While it&rsquo;s locked
              </h2>
              <ul className="mt-3 grid gap-2 text-sm">
                {STILL_WORKING.map((line) => (
                  <li key={line} className="flex gap-2 text-strong">
                    <Check className="mt-0.5 size-4 shrink-0 text-success-foreground" aria-hidden />
                    {line}
                  </li>
                ))}
                {PAUSED.map((line) => (
                  <li key={line} className="flex gap-2 text-muted-foreground">
                    <PauseCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {line}
                  </li>
                ))}
              </ul>
            </section>
            {status.owner ? <LockedExport companyId={companyId} /> : null}
          </aside>
        </div>

        <div className="mx-auto mt-8 flex max-w-4xl flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          {others.length && onSwitch
            ? others.map((row) => (
                <button key={row.companyId} type="button" className="font-medium text-brand-300 underline-offset-4 hover:underline" onClick={() => onSwitch(row.companyId)}>
                  Switch to {row.name}
                </button>
              ))
            : null}
          <button type="button" className="font-medium underline-offset-4 hover:underline" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </div>
    </main>
  );
}

/** Reads the lock and shows it; a moment of loading while the status arrives. */
export function LockedGate({ companyId, businesses, onSwitch, fallback }: { companyId: Id<"companies">; businesses?: { companyId: string; name: string; locked?: boolean }[]; onSwitch?: (companyId: string) => void; fallback: React.ReactNode }) {
  const status = useQuery(api.billingLock.status, { companyId });
  if (status === undefined) return <>{fallback}</>;
  return <AccountLocked companyId={companyId} status={status} businesses={businesses} onSwitch={onSwitch} />;
}

/**
 * Inside the workspace, after the first failed payment: the Owner is told before anything locks, with
 * the amount, the next try and the one thing to do. Nobody else sees it.
 */
export function PaymentWarning({ companyId }: { companyId: Id<"companies"> }) {
  const status = useQuery(api.billingLock.status, { companyId });
  const card = useCardUpdate(companyId);
  const { busy, run } = useRun();
  const warning = status?.warning;
  if (!status?.owner || !warning || status.locked) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-destructive/25 bg-destructive/8 px-4 py-2.5 text-sm text-strong sm:px-6">
      <XCircle className="size-4 shrink-0 text-destructive-foreground" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium">Your Selestial payment of {money(warning.amountCents, warning.currency)} didn&rsquo;t go through.</span>{" "}
        <span className="text-muted-foreground">
          {warning.nextAttemptAt ? `We'll try again on ${day(warning.nextAttemptAt, status.timezone)}. ` : "We'll try again soon. "}If that fails too, the account locks until it&rsquo;s paid.
        </span>
      </p>
      <span className="flex shrink-0 gap-2">
        {warning.payUrl ? (
          <a href={warning.payUrl} className={buttonVariants({ variant: "primary", size: "sm" })}>
            Pay now
          </a>
        ) : null}
        <Button size="sm" variant="outline" loading={busy || card.waiting} onClick={() => void run(card.start)}>
          Update card
        </Button>
      </span>
    </div>
  );
}
