"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef } from "react";

import { startFoundingClaim, type ClaimState } from "@/app/founding/actions";
import { Button } from "@/components/ui/button";
import { trackFounding } from "@/lib/founding/analytics";
import { CLAIM, OFFER, STATUS } from "@/lib/founding/content";
import { cn } from "@/lib/utils";

import { CURRENT_SOFTWARE, PRIORITIES, TEAM_SIZES } from "../../../convex/lib/founding/offer";
import { ClaimCta } from "./enrollment";
import { useFounding } from "./status-context";

const control =
  "h-12 w-full rounded-lg border border-border bg-background px-3.5 text-[15px] text-strong shadow-xs transition-colors outline-none placeholder:text-muted-foreground hover:border-[#6838ef]/40 focus-visible:border-[#6838ef] focus-visible:ring-3 focus-visible:ring-[#6838ef]/20 aria-invalid:border-destructive";

function Select({ name, label, options, invalid }: { name: string; label: string; options: readonly (readonly [string, string])[]; invalid: boolean }) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-strong">
        {label}
      </label>
      <div className="relative">
        <select id={id} name={name} required defaultValue="" aria-invalid={invalid || undefined} className={cn(control, "appearance-none pr-10")}>
        <option value="" disabled>
          {CLAIM.choose}
        </option>
        {options.map(([value, words]) => (
          <option key={value} value={value}>
            {words}
          </option>
        ))}
      </select>
        <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </div>
    </div>
  );
}

function PriorityChoice({ invalid }: { invalid: boolean }) {
  return (
    <fieldset className="grid gap-1.5" aria-invalid={invalid || undefined}>
      <legend className="mb-1.5 text-sm font-medium text-strong">{CLAIM.fields.priority}</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PRIORITIES.map(([value, words]) => (
          <label key={value} className="relative flex h-12 cursor-pointer items-center justify-center rounded-lg border border-border bg-background px-3 text-[15px] text-strong transition-colors hover:border-[#6838ef]/40 has-checked:border-[#6838ef] has-checked:bg-[#f3efff] has-checked:font-medium has-focus-visible:ring-3 has-focus-visible:ring-[#6838ef]/25">
            <input type="radio" name="priority" value={value} required className="sr-only" />
            {words}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const ERRORS: Record<Exclude<ClaimState["status"], "idle">, string> = CLAIM.errors;

/**
 * The claim: four business answers, then account creation. It asks only what the account can't already
 * tell us (name and work email come from sign-up, and an existing account just signs in). Submitting
 * saves the answers and goes straight on to sign-up; it is never presented as a finished founding signup.
 */
export function ClaimForm() {
  const { view } = useFounding();
  const [state, action, pending] = useActionState(startFoundingClaim, { status: "idle" } as ClaimState);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const nameId = useId();

  /** Campaign attribution from the address, standard UTM fields only; the server keeps them only if plain. */
  const attribute = () => {
    const params = new URLSearchParams(window.location.search);
    for (const key of ["utm_source", "utm_medium", "utm_campaign"]) {
      const input = formRef.current?.elements.namedItem(key);
      if (input instanceof HTMLInputElement) input.value = (params.get(key) ?? "").slice(0, 60);
    }
  };

  useEffect(() => {
    if (state.status !== "idle") errorRef.current?.focus();
  }, [state]);

  if (!view.canClaim) {
    const notice = view.state === "closed_full" ? STATUS.closedFull : view.state === "closed_deadline" || view.state === "closed" ? STATUS.closedDeadline : view.state === "unavailable" ? STATUS.unavailable : STATUS.notOpen;
    return (
      <div className="rounded-2xl border border-border bg-card p-6 sm:p-8">
        <p className="font-heading text-xl tracking-tight text-strong">{notice.title}</p>
        <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-muted-foreground">{notice.body}</p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <ClaimCta position="claim-closed" />
          <Link href="/login?next=%2Fapp" className="inline-flex h-12 items-center justify-center rounded-[10px] border border-border bg-background px-5 text-[15px] font-medium text-strong hover:bg-muted">
            {CLAIM.signIn.replace(" to claim for your company", "")}
          </Link>
        </div>
      </div>
    );
  }

  const invalid = state.status === "invalid";
  return (
    <form
      ref={formRef}
      action={action}
      onSubmit={() => {
        attribute();
        trackFounding("founding_signup_started");
      }} className="rounded-2xl border border-border bg-card p-5 shadow-[0_24px_60px_-36px_rgba(81,38,199,0.5)] sm:p-8">
      <ol className="mb-7 grid grid-cols-4 gap-2" aria-label="Claim steps">
        {CLAIM.stepsLabel.map((label, index) => (
          <li key={label} className="grid gap-1.5" aria-current={index === 0 ? "step" : undefined}>
            <span aria-hidden className={cn("h-1 rounded-full", index === 0 ? "bg-[#f3efff]0" : "bg-[#f3efff]0/15")} />
            <span className={cn("text-[11px] font-medium tracking-wide uppercase sm:text-xs", index === 0 ? "text-[#5126c7]" : "text-muted-foreground")}>
              <span className="sr-only">Step {index + 1} of 4: </span>
              {label}
            </span>
          </li>
        ))}
      </ol>
      <div className="grid gap-5">
        <div className="grid gap-1.5">
          <label htmlFor={nameId} className="text-sm font-medium text-strong">
            {CLAIM.fields.companyName}
          </label>
          <input id={nameId} name="companyName" required maxLength={160} autoComplete="organization" aria-invalid={invalid || undefined} className={control} />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <Select name="currentSoftware" label={CLAIM.fields.currentSoftware} options={CURRENT_SOFTWARE} invalid={invalid} />
          <Select name="teamSize" label={CLAIM.fields.teamSize} options={TEAM_SIZES} invalid={invalid} />
        </div>
        <PriorityChoice invalid={invalid} />
        <input type="hidden" name="utm_source" defaultValue="" />
        <input type="hidden" name="utm_medium" defaultValue="" />
        <input type="hidden" name="utm_campaign" defaultValue="" />
      </div>
      <p ref={errorRef} tabIndex={-1} role="alert" className={cn("mt-5 text-sm font-medium text-destructive outline-none", state.status === "idle" && "sr-only")}>
        {state.status !== "idle" ? ERRORS[state.status] : ""}
      </p>
      <div className="mt-6 rounded-xl bg-[#f5f2ff] px-4 py-3 text-sm leading-relaxed text-strong ring-1 ring-[#6838ef]/15">{OFFER.payment}</div>
      <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Button type="submit" variant="gradient" size="xl" loading={pending} className="h-12! w-full rounded-[10px]! px-6! text-[15px]! before:rounded-[9px]! sm:w-auto">
          {pending ? CLAIM.sending : CLAIM.submit}
        </Button>
        <p className="text-sm text-muted-foreground">
          {CLAIM.already}{" "}
          <Link href={`/login?next=${encodeURIComponent("/app/founding")}`} className="font-medium text-[#5126c7] underline-offset-4 hover:underline">
            {CLAIM.signIn}
          </Link>
        </p>
      </div>
      <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
        {CLAIM.privacy}{" "}
        <Link href="/privacy" className="underline underline-offset-2 hover:text-strong">
          Privacy Policy
        </Link>{" "}
        and{" "}
        <Link href="/terms" className="underline underline-offset-2 hover:text-strong">
          Terms
        </Link>
        .
      </p>
    </form>
  );
}
