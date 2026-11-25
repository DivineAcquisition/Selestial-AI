"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { IntentDialog } from "@/components/app/settings/billing";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { FOUNDING_MONTHS, FOUNDING_PRICE, OFFER, RENEWAL_PRICE, SUPPORT_EMAIL } from "@/lib/founding/content";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { FoundingStep } from "../../../../convex/founding";
import { CURRENT_SOFTWARE, PRIORITIES, TEAM_SIZES } from "../../../../convex/lib/founding/offer";

const day = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

const NOT_ELIGIBLE: Record<Extract<FoundingStep, { kind: "not_eligible" }>["reason"], { title: string; body: string }> = {
  has_plan: { title: "This company already has a plan", body: "Founding access is for a company's first plan. If you run another company, switch to it and claim there." },
  held_before: { title: "This company has held founding access before", body: "The founding price applies once per company, so it can't be claimed again here." },
  paid_before: { title: "This company has paid for a plan before", body: "Founding access is for a company's first plan payment, so it isn't available here." },
  full: { title: "All founding places are taken", body: "You can still choose Operate in Plan & Usage." },
  enrollment_closed: { title: "Founding enrollment has closed", body: "No new founding places are offered. You can still choose Operate in Plan & Usage." },
  not_open: { title: "Founding enrollment isn't open yet", body: "Your answers are saved. We'll let you know when you can claim." },
  billing_off: { title: "Payment isn't available yet", body: `Your answers are saved, and nothing has been charged. Email ${SUPPORT_EMAIL} and we'll help you finish.` },
};

function Card({ tone = "plain", title, children }: { tone?: "plain" | "good" | "wait" | "warn"; title: string; children: React.ReactNode }) {
  const ring = tone === "good" ? "border-success/40 bg-success/5" : tone === "wait" ? "border-[#6838ef]/30 bg-[#f3efff]0/5" : tone === "warn" ? "border-warning/50 bg-warning/10" : "border-border bg-card";
  return (
    <section role="status" className={`rounded-2xl border p-6 ${ring}`}>
      <h2 className="font-heading text-xl tracking-tight text-strong">{title}</h2>
      <div className="mt-2 grid gap-3 text-[15px] leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

function Answers({ companyId }: { companyId: Id<"companies"> }) {
  const save = useMutation(api.founding.saveProfile);
  const { busy, error, run } = useRun();
  const [values, setValues] = useState({ currentSoftware: "", teamSize: "", priority: "" });
  const select = "h-11 w-full rounded-lg border border-border bg-background px-3 text-[15px] text-strong";
  return (
    <form
      className="grid gap-4 rounded-2xl border border-border bg-card p-6"
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => save({ companyId, ...values }));
      }}
    >
      <div>
        <h2 className="font-heading text-xl tracking-tight text-strong">Three quick questions</h2>
        <p className="mt-1 text-sm text-muted-foreground">So setup starts from how your business runs. You won&apos;t be asked again.</p>
      </div>
      {(
        [
          ["currentSoftware", "What do you use today to run bookings?", CURRENT_SOFTWARE],
          ["teamSize", "About how many people clean for you?", TEAM_SIZES],
          ["priority", "What should Selestial help with first?", PRIORITIES],
        ] as const
      ).map(([name, label, options]) => (
        <label key={name} className="grid gap-1.5 text-sm font-medium text-strong">
          {label}
          <select required className={select} value={values[name]} onChange={(event) => setValues({ ...values, [name]: event.target.value })}>
            <option value="" disabled>
              Select one
            </option>
            {options.map(([value, words]) => (
              <option key={value} value={value}>
                {words}
              </option>
            ))}
          </select>
        </label>
      ))}
      <FormError message={error} />
      <div>
        <Button type="submit" variant="primary" loading={busy}>
          Save answers
        </Button>
      </div>
    </form>
  );
}

/**
 * Founding Access inside the workspace: the claim from the public page is linked to this company (the
 * claim key then leaves the address bar), and the Owner sees one of four states, read from billing alone:
 * access claimed, payment still processing, ready to pay, or something needs attention. Paying opens the
 * same purchase as Plan & Usage: the server decides the founding price, never this page.
 */
export function FoundingClaim() {
  const { companyId, name, role } = useCompany();
  const router = useRouter();
  const attach = useMutation(api.founding.attachClaim);
  const change = useMutation(api.billing.startPlanChange);
  const owner = role === "owner";
  const status = useQuery(api.founding.mine, owner ? { companyId } : "skip");
  const setup = useQuery(api.setup.state, { companyId });
  const businesses = useQuery(api.companies.mine, {});
  const { busy, error, run } = useRun();
  const [intentId, setIntentId] = useState<Id<"billingIntents"> | null>(null);
  const [attachProblem, setAttachProblem] = useState<string | null>(null);
  const attached = useRef(false);

  useEffect(() => {
    if (!owner || attached.current) return;
    const claimKey = new URLSearchParams(window.location.search).get("claim");
    if (!claimKey) return;
    attached.current = true;
    attach({ companyId, claimKey })
      .catch((caught: unknown) => setAttachProblem(caught instanceof Error ? caught.message.replace(/^.*Uncaught \w+: /, "").split("\n")[0] : "That founding claim couldn't be linked."))
      // The key has done its job: it leaves the address bar and history.
      .finally(() => router.replace("/app/founding"));
  }, [owner, companyId, attach, router]);

  const step = status?.step;
  const otherCompanies = (businesses ?? []).filter((row) => row.companyId !== companyId && row.role === "owner").length;
  const setupRequired = setup?.required === true;

  return (
    <div className={setupRequired ? "min-h-screen bg-[#fbfaff]" : undefined}>
      {/* During setup this page is full screen, so it carries its own header; in the workspace the shell has one. */}
      {setupRequired ? (
        <header className="border-b border-border bg-background px-5 py-4 sm:px-8">
          <div className="mx-auto flex max-w-3xl items-center justify-between">
            <Logo />
            <span className="text-xs font-semibold tracking-[0.14em] text-[#5126c7] uppercase">Founding Access</span>
          </div>
        </header>
      ) : null}
      <main className="mx-auto grid max-w-3xl gap-6 px-5 py-10 sm:px-8">
        <div>
          <p className="text-sm text-muted-foreground">Claiming for</p>
          <h1 className="font-heading text-3xl tracking-tight text-strong">{name}</h1>
          {otherCompanies > 0 ? <p className="mt-1 text-sm text-muted-foreground">You own more than one company. Founding access applies to the company shown here; switch companies from the workspace menu to claim for another.</p> : null}
        </div>

        {attachProblem ? <Card tone="warn" title="Something needs attention"><p>{attachProblem}</p></Card> : null}

        {!owner ? (
          <Card title="Founding access is claimed by the Owner">
            <p>Ask your company&apos;s Owner to claim founding access from this page.</p>
          </Card>
        ) : status === undefined ? (
          <p className="text-sm text-muted-foreground">Checking your founding status…</p>
        ) : (
          <>
            {!status.answers && step?.kind !== "claimed" ? <Answers companyId={companyId} /> : null}

            {step?.kind === "claimed" ? (
              <Card tone="good" title="Founding access claimed">
                <p>
                  Your first payment went through. Your founding price of {FOUNDING_PRICE}/month applies until {day(step.endsAt)}, then {RENEWAL_PRICE}/month. Quality is on your plan alongside Sales, Dispatch, Recruiter and Retention.
                </p>
                <div className="flex flex-wrap gap-3">
                  <Button variant="primary" render={<Link href={setupRequired ? "/app/setup" : "/app/migration"} />}>
                    {setupRequired ? "Set up your company" : "Bring over your records"}
                  </Button>
                  <Button variant="outline" render={<Link href="/app/settings/billing" />}>
                    Plan & Usage
                  </Button>
                </div>
                <p className="text-sm">Setup is ready to begin. Questions? Email {SUPPORT_EMAIL}.</p>
              </Card>
            ) : step?.kind === "processing" ? (
              <Card tone="wait" title="Payment still processing">
                <p>Your founding place is held while the payment completes. This page updates as soon as billing confirms it; you can leave and come back.</p>
                <p className="text-sm">A place stays held for up to 24 hours for an unfinished payment page.</p>
              </Card>
            ) : step?.kind === "attention" ? (
              <Card tone="warn" title="Something needs attention">
                <p>{step.problem}</p>
                <div>
                  <Button variant="primary" loading={busy} onClick={() => void run(async () => setIntentId(await change({ companyId, plan: "operate" })))}>
                    Try again
                  </Button>
                </div>
              </Card>
            ) : step?.kind === "ready_to_pay" ? (
              <Card title={`Claim your founding price: ${FOUNDING_PRICE}/month`}>
                <p>
                  {FOUNDING_PRICE}/month for your first {FOUNDING_MONTHS} months, then {RENEWAL_PRICE}/month. {step.placesLeft} of the founding places are left; a place is yours once your first payment goes through.
                </p>
                <p className="text-sm">{OFFER.cancel}</p>
                <div>
                  <Button variant="primary" loading={busy} disabled={!status.answers} onClick={() => void run(async () => setIntentId(await change({ companyId, plan: "operate" })))}>
                    See the exact charge
                  </Button>
                </div>
                {!status.answers ? <p className="text-sm">Answer the three questions above first.</p> : null}
              </Card>
            ) : step?.kind === "not_eligible" ? (
              <Card title={NOT_ELIGIBLE[step.reason].title}>
                <p>{NOT_ELIGIBLE[step.reason].body}</p>
                {setupRequired ? (
                  <div>
                    <Button variant="outline" render={<Link href="/app/setup" />}>
                      Set up your company
                    </Button>
                  </div>
                ) : null}
              </Card>
            ) : null}

            {intentId ? <IntentDialog intentId={intentId} onClose={() => setIntentId(null)} /> : null}
            <FormError message={error} />
          </>
        )}
      </main>
    </div>
  );
}
