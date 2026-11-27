"use client";

/**
 * Cancel subscription: one dialog with progressive steps (docs/billing/05-cancellation.md).
 *
 *   reason → (10% offer) → what would help → (15% offer) → confirm → canceled → (reactivated)
 *
 * Everything shown about money and dates comes from the server (api.cancellation.flow), worked out from
 * Autumn's record and Stripe's subscription. Nothing here decides a price. A discount or a cancellation is
 * shown as done only when the server says billing confirmed it. Closing the dialog, at any step, changes
 * nothing; a clear way to cancel is on every step.
 */
import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, messageOf } from "@/components/app/form";
import { Check } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup } from "@/components/ui/selection/radio";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { CANCEL_REASON_WORDS, CANCEL_REASONS, STAY_NEED_WORDS, STAY_NEEDS, type CancelReason, type StayNeed } from "../../../../convex/lib/billing/retention";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

export type Flow = NonNullable<ReturnType<typeof useQuery<typeof api.cancellation.flow>>>;
export type Step = "reason" | "routing" | "offer10" | "need" | "offer15" | "applying" | "confirm" | "canceling" | "canceled";

/** Dollars and cents, always both, so every amount on an offer reads the same way. */
export const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(cents / 100);
const date = (at: number | null | undefined) => (at ? new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "the end of your billing period");
const shortDate = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const DISCLOSURE = "Applies to your subscription only. SMS, email, credits, and other usage charges are unchanged. Taxes, if applicable, are additional.";

export function CancelFlowDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className="max-w-xl bg-card text-strong">
        {open ? <FlowBody onClose={onClose} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function FlowBody({ onClose }: { onClose: () => void }) {
  const { companyId } = useCompany();
  const start = useMutation(api.cancellation.start);
  const [flowId, setFlowId] = useState<Id<"cancelFlows"> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start({ companyId })
      .then(setFlowId)
      .catch((caught: unknown) => setProblem(messageOf(caught)));
  }, [companyId, start]);
  if (problem)
    return (
      <Frame title="We couldn’t open this right now" description={problem}>
        <Actions>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </Actions>
      </Frame>
    );
  if (!flowId)
    return (
      <Frame title="Cancel subscription" description="Getting your subscription details…">
        <Skeleton className="h-40 rounded-xl" />
      </Frame>
    );
  return <Steps flowId={flowId} onClose={onClose} />;
}

/** What the steps can ask of the server. The connected dialog sends each to Convex; a preview can stub them. */
export type FlowActions = {
  answer: (input: { step: "reason" | "need" | "detail" | "skip"; code?: string; note?: string }) => Promise<unknown>;
  seen: (offerId: "save10_once" | "save15_three", outcome: "viewed" | "declined") => Promise<unknown>;
  keep: () => Promise<unknown>;
  accept: (offerId: "save10_once" | "save15_three", version: string) => Promise<unknown>;
  recheck: () => Promise<unknown>;
  cancel: () => Promise<unknown>;
  resume: () => Promise<unknown>;
};

function Steps({ flowId, onClose }: { flowId: Id<"cancelFlows">; onClose: () => void }) {
  const { companyId } = useCompany();
  const flow = useQuery(api.cancellation.flow, { companyId, flowId });
  const answer = useMutation(api.cancellation.answer);
  const seen = useMutation(api.cancellation.offerSeen);
  const keep = useMutation(api.cancellation.keep);
  const accept = useMutation(api.cancellation.accept);
  const recheck = useMutation(api.cancellation.recheck);
  const cancel = useMutation(api.billing.cancelPlan);
  const resume = useMutation(api.billing.resumePlan);
  const actions = useMemo<FlowActions>(
    () => ({
      answer: (input) => answer({ companyId, flowId, ...input }),
      seen: (offerId, outcome) => seen({ companyId, flowId, offerId, outcome }),
      keep: () => keep({ companyId, flowId }),
      accept: (offerId, version) => accept({ companyId, flowId, offerId, version }),
      recheck: () => recheck({ companyId, flowId }),
      cancel: () => cancel({ companyId, flowId }),
      resume: () => resume({ companyId, flowId }),
    }),
    [answer, seen, keep, accept, recheck, cancel, resume, companyId, flowId],
  );
  if (!flow)
    return (
      <Frame title="Cancel subscription">
        <Skeleton className="h-40 rounded-xl" />
      </Frame>
    );
  return <CancelFlowSteps flow={flow} actions={actions} onClose={onClose} />;
}

/** The steps themselves, drawn only from the server's view of the flow. */
export function CancelFlowSteps({ flow, actions, onClose, initialStep = "reason" }: { flow: Flow; actions: FlowActions; onClose: () => void; initialStep?: Step }) {
  const [step, setStep] = useState<Step>(initialStep);
  const [reason, setReason] = useState<CancelReason | null>(null);
  const [reasonNote, setReasonNote] = useState("");
  const [need, setNeed] = useState<StayNeed | null>(null);
  const [needNote, setNeedNote] = useState("");
  // The follow-up for setup or reliability reasons: asked once, beside the first offer or, without one, on the confirmation.
  const [detail, setDetail] = useState("");
  const [detailSaved, setDetailSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reactivating, setReactivating] = useState(false);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (caught) {
      setError(messageOf(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Terms older than the server allows are read again on their own, so what's shown can always be accepted.
  const stale = (flow.offers.save10_once.eligible && flow.offers.save10_once.stale) || (flow.offers.save15_three.eligible && flow.offers.save15_three.stale);
  const { recheck, seen } = actions;
  useEffect(() => {
    if (stale) void recheck().catch(() => undefined);
  }, [stale, recheck]);

  // The step shown is worked out from the server's answer: after the first question it waits until the server
  // knows which offers can be made, and a cancellation shows as done only once Autumn's record has the end date.
  const current: Step =
    step === "routing" && !flow.checking
      ? flow.offers.save10_once.eligible
        ? "offer10"
        : flow.offers.save15_three.eligible
          ? "need"
          : "confirm"
      : step === "canceling" && flow.cancel?.stage === "done" && flow.plan.endsAt !== null
        ? "canceled"
        : step;

  // Each offer is recorded as shown once it's on screen. Seeing an offer uses nothing up.
  useEffect(() => {
    if (current === "offer10" || current === "offer15") void seen(current === "offer10" ? "save10_once" : "save15_three", "viewed").catch(() => undefined);
  }, [current, seen]);

  const saveDetail = async () => {
    const text = detail.trim();
    if (!flow.detail || !text || text === detailSaved) return;
    await actions.answer({ step: "detail", note: text }).catch(() => undefined);
    setDetailSaved(text);
  };
  const detailField = flow.detail ? <Note label={flow.detail.question} value={detail} onChange={setDetail} /> : null;

  const toConfirm = async (from: "reason" | "need" | "offer") => {
    if (from !== "offer") await actions.answer({ step: "skip" }).catch(() => undefined);
    setStep("confirm");
  };
  const keepIt = async () => {
    await actions.keep().catch(() => undefined);
    onClose();
  };
  const decline = async (offerId: "save10_once" | "save15_three") => {
    await seen(offerId, "declined").catch(() => undefined);
  };

  const plan = flow.plan;
  const accessEnd = plan.endsAt ?? plan.periodEnd;

  switch (current) {
    case "reason":
      return (
        <Frame title="What’s making you consider leaving?" description="Your answer helps us understand what needs to improve." progress={1}>
          <RadioGroup aria-label="Reason for considering cancellation" value={reason} onValueChange={setReason} options={CANCEL_REASONS.map((code) => ({ value: code, label: CANCEL_REASON_WORDS[code] }))} />
          <Note label="What could we have done better?" value={reasonNote} onChange={setReasonNote} />
          <FormError message={error} />
          <Actions>
            <Button variant="link" className="sm:mr-auto" onClick={() => void toConfirm("reason")}>
              Skip and cancel
            </Button>
            <Button variant="outline" onClick={() => void keepIt()}>
              Keep my subscription
            </Button>
            <Button variant="default" loading={busy} onClick={() => void run(async () => { await actions.answer({ step: "reason", code: reason ?? undefined, note: reasonNote || undefined }); setStep("routing"); })}>
              Continue
            </Button>
          </Actions>
        </Frame>
      );
    case "routing":
      return (
        <Frame title="One moment" description="Checking your subscription details.">
          <Skeleton className="h-32 rounded-xl" />
          <Actions>
            <Button variant="link" className="sm:mr-auto" onClick={() => setStep("confirm")}>
              Continue to cancel
            </Button>
          </Actions>
        </Frame>
      );
    case "offer10": {
      const offer = flow.offers.save10_once;
      if (!offer.eligible) return <Unavailable onNext={() => setStep(flow.offers.save15_three.eligible ? "need" : "confirm")} words={offer.words} />;
      const first = offer.renewals[0];
      return (
        <Frame title="Would a little breathing room help?" description="Stay with Selestial and get 10% off your next monthly subscription payment." progress={2}>
          <div className="rounded-xl border border-brand-500/20 bg-brand-500/[0.07] p-4">
            <dl className="grid gap-2 text-sm">
              <Row label={`Next payment, ${shortDate(first.at)}`}>
                <span className="mr-2 text-muted-foreground line-through decoration-brand-500/60">
                  <span className="sr-only">Normally </span>
                  {usd(first.baseCents)}
                </span>
                <span className="font-semibold text-strong">{usd(first.totalCents)}</span>
              </Row>
              <Row label="You save">{usd(first.discountCents)}</Row>
              <Row label={`From ${shortDate(offer.resumesAt)}`}>{usd(offer.resumesCents)} a month</Row>
            </dl>
          </div>
          <Disclosure />
          {detailField}
          {stale ? <p className="text-xs text-muted-foreground" role="status">Refreshing these terms…</p> : null}
          <FormError message={error} />
          <Actions>
            <Button variant="outline" onClick={() => void saveDetail().then(() => decline("save10_once")).then(() => setStep(flow.offers.save15_three.eligible ? "need" : "confirm"))}>
              Continue cancellation
            </Button>
            <Button variant="default" loading={busy} disabled={stale} onClick={() => void run(async () => { await saveDetail(); await actions.accept("save10_once", offer.version); setStep("applying"); })}>
              Apply 10% discount
            </Button>
          </Actions>
        </Frame>
      );
    }
    case "need":
      return (
        <Frame title="What would need to change for Selestial to be worth keeping?" progress={3}>
          <RadioGroup aria-label="What would make staying worthwhile" value={need} onValueChange={setNeed} options={STAY_NEEDS.map((code) => ({ value: code, label: STAY_NEED_WORDS[code] }))} />
          <Note label="Tell us what’s missing." value={needNote} onChange={setNeedNote} />
          <FormError message={error} />
          <Actions>
            <Button variant="link" className="sm:mr-auto" onClick={() => void toConfirm("need")}>
              Skip and cancel
            </Button>
            <Button
              variant="default"
              loading={busy}
              onClick={() =>
                void run(async () => {
                  await actions.answer({ step: "need", code: need ?? undefined, note: needNote || undefined });
                  setStep(need === "nothing" || !flow.offers.save15_three.eligible ? "confirm" : "offer15");
                })
              }
            >
              Continue
            </Button>
          </Actions>
        </Frame>
      );
    case "offer15": {
      const offer = flow.offers.save15_three;
      if (!offer.eligible) return <Unavailable onNext={() => setStep("confirm")} words={offer.words} />;
      return (
        <Frame title="More time to make Selestial work for you." description="Get 15% off your subscription for your next three monthly payments." progress={4}>
          <div className="overflow-hidden rounded-xl border border-brand-500/20">
            <table className="w-full text-sm">
              <caption className="sr-only">Your next three subscription payments with 15% off</caption>
              <thead className="bg-brand-500/[0.07] text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Payment date
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    You pay
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    You save
                  </th>
                </tr>
              </thead>
              <tbody>
                {offer.renewals.map((row) => (
                  <tr key={row.at} className="border-t border-border">
                    <td className="px-3 py-2 text-strong">{shortDate(row.at)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span className="mr-2 text-xs text-muted-foreground line-through">
                        <span className="sr-only">Normally </span>
                        {usd(row.baseCents)}
                      </span>
                      <span className="font-semibold text-strong">{usd(row.totalCents)}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{usd(row.discountCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-border bg-brand-500/[0.04]">
                <tr>
                  <th scope="row" className="px-3 py-2 text-left font-medium text-strong">
                    Three payments
                  </th>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{usd(offer.totalCents)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{usd(offer.savingsCents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-sm text-muted-foreground">
            Your normal price of <span className="font-medium text-strong">{usd(offer.resumesCents)} a month</span> resumes on {date(offer.resumesAt)}.
          </p>
          <Disclosure />
          {stale ? <p className="text-xs text-muted-foreground" role="status">Refreshing these terms…</p> : null}
          <FormError message={error} />
          <Actions>
            <Button variant="outline" onClick={() => void decline("save15_three").then(() => setStep("confirm"))}>
              Cancel subscription
            </Button>
            <Button variant="default" loading={busy} disabled={stale} onClick={() => void run(async () => { await actions.accept("save15_three", offer.version); setStep("applying"); })}>
              Stay with 15% off
            </Button>
          </Actions>
        </Frame>
      );
    }
    case "applying": {
      const accepted = flow.accepted;
      if (!accepted || accepted.state === "pending")
        return (
          <Frame title="Applying your discount" description="Confirming the change with billing. This usually takes a few seconds.">
            <Pending />
          </Frame>
        );
      if (accepted.state === "applied")
        return (
          <Frame title="Your discount is applied" description={`Your subscription stays active with ${accepted.percent}% off ${accepted.renewals.length === 1 ? "your next payment" : `your next ${accepted.renewals.length} payments`}.`} done>
            <ul className="grid gap-1.5 rounded-xl border border-brand-500/20 bg-brand-500/[0.07] p-4 text-sm">
              {accepted.renewals.map((row) => (
                <li key={row.at} className="flex justify-between gap-3">
                  <span>{shortDate(row.at)}</span>
                  <span className="font-semibold tabular-nums">{usd(row.totalCents)}</span>
                </li>
              ))}
              <li className="flex justify-between gap-3 border-t border-brand-500/15 pt-1.5 text-muted-foreground">
                <span>From {shortDate(accepted.resumesAt)}</span>
                <span className="tabular-nums">{usd(accepted.resumesCents)} a month</span>
              </li>
            </ul>
            <Disclosure />
            <Actions>
              <Button variant="default" onClick={onClose}>
                Done
              </Button>
            </Actions>
          </Frame>
        );
      if (accepted.state === "unconfirmed")
        return (
          <Frame title="Still confirming your discount" description={accepted.problem ?? "Billing hasn’t confirmed the discount yet. We’ll keep checking, and it will never be applied twice."}>
            <p className="text-sm text-muted-foreground">You can close this. Plan & Usage shows the discount as soon as billing confirms it, and we’ll email you.</p>
            <Actions>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </Actions>
          </Frame>
        );
      return (
        <Frame title={accepted.termsChanged ? "The terms changed" : "The discount wasn’t applied"} description={accepted.problem ?? "Nothing changed on your subscription."}>
          <Actions>
            <Button variant="link" className="sm:mr-auto" onClick={() => setStep("confirm")}>
              Continue to cancel
            </Button>
            <Button variant="outline" onClick={() => void keepIt()}>
              Keep my subscription
            </Button>
            {accepted.termsChanged && (flow.offers[accepted.offerId].eligible ?? false) ? (
              <Button variant="default" onClick={() => setStep(accepted.offerId === "save10_once" ? "offer10" : "offer15")}>
                Review the new terms
              </Button>
            ) : null}
          </Actions>
        </Frame>
      );
    }
    case "confirm":
    case "canceling": {
      const failed = flow.cancel?.stage === "failed";
      const waiting = current === "canceling" && !failed;
      return (
        <Frame title="Cancel your Selestial subscription?" description="Here’s exactly what happens.">
          {flow.offers.save10_once.eligible ? null : detailField}
          <dl className="grid gap-3 text-sm">
            <Fact label="Your subscription">
              {plan.name}
              {plan.monthlyCents ? ` · ${usd(plan.monthlyCents)} a month` : ""}
              {plan.earlyEndsAt ? `, your early-user price until ${date(plan.earlyEndsAt)}` : ""}
            </Fact>
            <Fact label="Paid access">Continues until {date(accessEnd)}. It won’t renew, and you won’t be charged again for the subscription.</Fact>
            <Fact label="Your agents">Keep working until {date(accessEnd)}. After that they stop: no new AI work runs and agents send no messages.</Fact>
            <Fact label="Scheduled messages and tasks">Agent messages and agent work planned for after {date(accessEnd)} won’t be sent or run, and aren’t sent later if you come back. You and your team can still send messages yourselves until then.</Fact>
            <Fact label="Usage you’ve already had">Texts, email and credits are paid from your prepaid balances as they’re used, so nothing more is charged for them. Unused messaging funds stay on your account; purchased credits can only be used with an active plan.</Fact>
            <Fact label="Your data">Your records stay in your workspace after access ends. You can still sign in to export or delete them from Settings. If you have a Selestial texting number, it isn’t released automatically: our team will contact you about keeping, moving or releasing it.</Fact>
          </dl>
          {failed ? (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-strong">
              We couldn’t cancel your subscription: {flow.cancel?.problem ?? "billing didn’t accept the change."} Your subscription is unchanged. Try again, or write to{" "}
              <a className="font-medium text-brand-600 underline underline-offset-2" href={`mailto:${flow.support.email}`}>
                {flow.support.email}
              </a>
              .
            </p>
          ) : null}
          {waiting ? (
            <p role="status" className="text-sm text-muted-foreground">
              Canceling with billing… This page updates as soon as it’s confirmed.
            </p>
          ) : null}
          <FormError message={error} />
          <Actions>
            <Button variant="outline" disabled={waiting} onClick={() => void keepIt()}>
              Keep subscription
            </Button>
            <Button variant="destructive" loading={busy || waiting} onClick={() => void run(async () => { await saveDetail(); await actions.cancel(); setStep("canceling"); })}>
              {failed ? "Try again" : "Confirm cancellation"}
            </Button>
          </Actions>
        </Frame>
      );
    }
    case "canceled": {
      const back = reactivating && flow.uncancel?.stage === "done" && plan.endsAt === null;
      if (back)
        return (
          <Frame title="Your subscription is active again" description={`It renews as usual on ${date(plan.periodEnd)}. Nothing was charged for reactivating.`} done>
            <Actions>
              <Button variant="default" onClick={onClose}>
                Done
              </Button>
            </Actions>
          </Frame>
        );
      const pending = reactivating && flow.uncancel?.stage !== "failed";
      return (
        <Frame title="Your subscription is canceled." description={`You can continue using Selestial until ${date(plan.endsAt)}.`} done>
          <p className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
            <span aria-hidden className="size-2 rounded-full bg-muted-foreground" />
            Renewal is off. We’ll email you a confirmation.
          </p>
          <p className="text-sm text-muted-foreground">Changed your mind? Reactivate any time before {date(plan.endsAt)}. Your plan simply continues; nothing is charged until your normal renewal.</p>
          {flow.uncancel?.stage === "failed" ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              We couldn’t reactivate it: {flow.uncancel.problem ?? "billing didn’t accept the change."} Try again in a moment.
            </p>
          ) : null}
          {pending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Reactivating with billing…
            </p>
          ) : null}
          <FormError message={error} />
          <Actions>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button variant="default" loading={busy || pending} onClick={() => void run(async () => { await actions.resume(); setStep("canceled"); setReactivating(true); })}>
              Reactivate subscription
            </Button>
          </Actions>
        </Frame>
      );
    }
  }
}

// ── Pieces ───────────────────────────────────────────────────────────────────────────────────────

const STEPS = 4;

function Frame({ title, description, progress, done, children }: { title: string; description?: string; progress?: number; done?: boolean; children: React.ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Each step moves the keyboard and screen readers to its own heading.
  useEffect(() => {
    heading.current?.focus();
  }, [title]);
  return (
    <div className="flex max-h-[calc(100dvh-3rem)] flex-col overflow-y-auto p-6 sm:max-h-[85dvh]">
      {progress ? (
        <div className="mb-4 flex items-center gap-1.5 pr-8" aria-hidden>
          {Array.from({ length: STEPS }, (_, index) => (
            <span key={index} className={cn("h-1 flex-1 rounded-full transition-colors duration-300 motion-reduce:transition-none", index < progress ? "bg-brand-500" : "bg-brand-500/15")} />
          ))}
        </div>
      ) : null}
      {done ? (
        <span aria-hidden className="mb-3 inline-flex size-9 items-center justify-center rounded-full bg-brand-500/[0.07] text-brand-600">
          <Check className="size-5" />
        </span>
      ) : null}
      <DialogTitle render={<h2 ref={heading} tabIndex={-1} />} className="pr-8 text-xl leading-snug text-strong outline-none">
        {title}
      </DialogTitle>
      {description ? <DialogDescription className="mt-1.5 text-sm text-muted-foreground">{description}</DialogDescription> : null}
      <div className="mt-5 grid gap-4 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">{children}</div>
    </div>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-end">{children}</div>;
}

function Note({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium text-strong">
        {label} <span className="font-normal text-muted-foreground">(optional)</span>
      </span>
      <textarea
        value={value}
        maxLength={1000}
        rows={3}
        onChange={(event) => onChange(event.target.value)}
        className="block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-strong placeholder:text-muted-foreground/70 focus-visible:border-brand-500/60 focus-visible:outline-2 focus-visible:outline-brand-500/30"
      />
    </label>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums text-strong">{children}</dd>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 border-l-2 border-brand-500/20 pl-3">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="text-strong">{children}</dd>
    </div>
  );
}

function Disclosure() {
  return <p className="text-xs leading-relaxed text-muted-foreground">{DISCLOSURE}</p>;
}

function Pending() {
  return (
    <div role="status" className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
      <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-brand-500 border-t-transparent motion-reduce:animate-none" />
      Waiting for billing to confirm…
    </div>
  );
}

function Unavailable({ onNext, words }: { onNext: () => void; words: string | null }) {
  useEffect(() => {
    if (!words) onNext();
  }, [words, onNext]);
  if (!words) return null;
  return (
    <Frame title="This offer isn’t available" description={words}>
      <Actions>
        <Button variant="default" onClick={onNext}>
          Continue
        </Button>
      </Actions>
    </Frame>
  );
}
