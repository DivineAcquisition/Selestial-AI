"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { trackFounding } from "@/lib/founding/analytics";
import { CTA, STATUS } from "@/lib/founding/content";
import { closingDate } from "@/lib/founding/view";
import { cn } from "@/lib/utils";

import { useFounding } from "./status-context";

const ctaShape = "h-12! rounded-[10px]! px-6! text-[15px]! before:rounded-[9px]!";

/**
 * The one primary action. While a claim can start it is "Claim founding access" and goes to the claim
 * form; once enrollment is not open it becomes the configured next step (start on Operate, or talk with us),
 * so a closed offer never shows a claim button.
 */
export function ClaimCta({ position, className, fullWidth = false, inverse = false }: { position: string; className?: string; fullWidth?: boolean; inverse?: boolean }) {
  const { view } = useFounding();
  if (inverse) {
    // On the violet closing panel: a white button, same destinations as below.
    const href = view.canClaim ? "#claim" : view.state === "not_open" || view.state === "unavailable" ? "/book-a-call" : "/signup";
    const words = view.canClaim ? CTA : view.state === "not_open" || view.state === "unavailable" ? STATUS.talkCta : STATUS.afterCta;
    return (
      <a href={href} data-cta-position={position} onClick={() => view.canClaim && trackFounding("founding_cta_selected", position)} className={cn("inline-flex h-12 items-center justify-center rounded-[10px] bg-white px-6 text-[15px] font-semibold text-[#5126c7] shadow-[0_10px_30px_-12px_rgba(0,0,0,0.45)] transition-colors hover:bg-[#f3efff] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white", className)}>
        {words}
      </a>
    );
  }
  if (view.canClaim) {
    return (
      <Button variant="gradient" size="xl" className={cn(ctaShape, fullWidth && "w-full", className)} render={<a href="#claim" data-cta-position={position} onClick={() => trackFounding("founding_cta_selected", position)} />}>
        {CTA}
      </Button>
    );
  }
  if (view.state === "not_open" || view.state === "unavailable") {
    return (
      <Button variant="gradient" size="xl" className={cn(ctaShape, fullWidth && "w-full", className)} render={<Link href="/book-a-call" data-cta-position={position} />}>
        {STATUS.talkCta}
      </Button>
    );
  }
  return (
    <Button variant="gradient" size="xl" className={cn(ctaShape, fullWidth && "w-full", className)} render={<Link href="/signup" data-cta-position={position} />}>
      {STATUS.afterCta}
    </Button>
  );
}

function Unit({ value, label }: { value: number; label: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-[#f3efff] px-3 py-2.5 text-center ring-1 ring-[#6838ef]/10">
      <p className="font-heading text-2xl leading-none tracking-tight text-strong tabular-nums sm:text-[28px]">{String(value).padStart(2, "0")}</p>
      <p className="mt-1.5 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">{label}</p>
    </div>
  );
}

function Notice({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div>
      <p className="font-heading text-lg tracking-tight text-strong">{title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
      {children}
    </div>
  );
}

/**
 * Countdown, closing date, verified count and places left, in one calm card. The count is the server's
 * verified figure; if it can't be read, nothing stands in for it. Places left show only because a real
 * limit exists. The timer is not a live region: it never announces itself.
 */
export function EnrollmentStatus({ className }: { className?: string }) {
  const { view, left } = useFounding();

  useEffect(() => {
    trackFounding("founding_page_viewed");
  }, []);

  const count =
    view.joined === null ? (
      <p className="text-sm text-muted-foreground">{STATUS.countUnavailable}</p>
    ) : (
      <p className="text-sm text-strong">
        <span className="font-semibold tabular-nums">{STATUS.joined(view.joined)}</span>
      </p>
    );

  return (
    <section aria-labelledby="enrollment-title" className={cn("rounded-2xl border border-border bg-card p-5 shadow-[0_18px_44px_-30px_rgba(81,38,199,0.45)] sm:p-6", className)}>
      <h2 id="enrollment-title" className="sr-only">
        Founding enrollment status
      </h2>
      {view.state === "open" && left && view.endsAt !== null ? (
        <>
          <p className="text-xs font-semibold tracking-[0.14em] text-[#5126c7] uppercase">{STATUS.timerLabel}</p>
          <div className="mt-3 grid grid-cols-3 gap-2" role="timer" aria-label={`${left.days} days, ${left.hours} hours and ${left.minutes} minutes`}>
            <Unit value={left.days} label={STATUS.units.days} />
            <Unit value={left.hours} label={STATUS.units.hours} />
            <Unit value={left.minutes} label={STATUS.units.minutes} />
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            {STATUS.closes} <time dateTime={new Date(view.endsAt).toISOString()} className="font-medium text-strong">{closingDate(view.endsAt, view.timezone)}</time>
          </p>
          <p className="mt-4 border-t border-border pt-4 text-sm text-strong">{STATUS.explain}</p>
          <p className="mt-1 text-sm text-muted-foreground">{STATUS.benefit}</p>
        </>
      ) : view.state === "closed_deadline" || view.state === "closed" ? (
        <Notice {...(view.state === "closed" ? STATUS.closed : STATUS.closedDeadline)}>
          {view.endsAt !== null && view.state === "closed_deadline" ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {STATUS.closes.replace("Closes", "Closed")} <time dateTime={new Date(view.endsAt).toISOString()}>{closingDate(view.endsAt, view.timezone)}</time>
            </p>
          ) : null}
        </Notice>
      ) : view.state === "closed_full" ? (
        <Notice {...STATUS.closedFull} />
      ) : view.state === "unavailable" ? (
        <Notice {...STATUS.unavailable} />
      ) : (
        <Notice {...STATUS.notOpen} />
      )}
      {view.state !== "unavailable" ? (
        <div className="mt-4 flex flex-col gap-1 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          {count}
          {view.placesLeft !== null ? <p className="text-sm font-medium text-[#5126c7] tabular-nums">{STATUS.placesLeft(view.placesLeft)}</p> : null}
        </div>
      ) : null}
      {view.joined !== null && view.state !== "unavailable" ? <p className="mt-1 text-xs text-muted-foreground">{STATUS.countNote}</p> : null}
    </section>
  );
}
