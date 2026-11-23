"use client";

/**
 * The cleaner's guided steps as the office sees them: the same steps, states and order as the cleaner's own
 * page (convex/lib/cleaners/steps.ts), with what the office needs to do on each: countersign the agreement,
 * confirm the pay preference (Finance), see the supplies answers, training and the tax document's state.
 */
import { useMutation } from "convex/react";

import { canManage, useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { useNow } from "@/components/app/use-now";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useStableQuery } from "@/lib/app/stable-query";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

const TONE = { todo: "outline", needs_changes: "warning", office_review: "info", waiting_on_office: "warning", done: "success", not_needed: "outline" } as const;

export function GuidedStatusCard({ cleanerId }: { cleanerId: Id<"cleaners"> }) {
  const { companyId, role } = useCompany();
  const now = useNow();
  const data = useStableQuery(api.onboardingSetup.forCleaner, canManage(role) && now ? { companyId, cleanerId, asOf: now } : "skip");
  const confirm = useMutation(api.onboardingSetup.confirmPayout);
  const countersign = useMutation(api.onboardingSetup.countersignLink);
  const download = useMutation(api.onboardingSetup.taxDocument);
  const retry = useMutation(api.onboardingSetup.retryTaxDocument);
  const { busy, error, run } = useRun();
  if (!data) return null;
  return (
    <section className="grid gap-3 rounded-2xl border border-border bg-card p-4 sm:p-5" aria-label="Guided onboarding">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-strong">Guided steps</h3>
          <p className="text-sm text-muted-foreground">
            {data.journey.words.title}: {data.journey.finished} of {data.journey.total} finished by them. The same steps they see on their link.
          </p>
        </div>
        {data.phoneVerifiedAt ? <Badge variant="success" size="sm">Phone verified</Badge> : null}
      </div>
      <FormError message={error} />
      <ol className="divide-y divide-border">
        {data.journey.steps.map((step) => (
          <li key={step.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <span className="text-sm">
              <span className="mr-2 text-muted-foreground">{step.number}.</span>
              <span className="font-medium text-strong">{step.title}</span>
              {step.open.length ? <span className="block pl-5 text-xs text-muted-foreground">Still open: {step.open.join(", ")}</span> : null}
              {step.type === "signature" && data.agreement ? <span className="block pl-5 text-xs text-muted-foreground">{data.agreement.title} · {data.agreement.workflow.replace(/_/g, " ")}{data.agreement.workerSignedAt ? ` · they signed ${new Date(data.agreement.workerSignedAt).toLocaleDateString()}` : ""}</span> : null}
              {step.type === "checklist" && data.supplies ? <span className="block pl-5 text-xs text-muted-foreground">Has {data.supplies.have.length}; not yet: {data.supplies.missing.join(", ") || "nothing"}</span> : null}
              {step.type === "payment_setup" && data.payout ? <span className="block pl-5 text-xs text-muted-foreground">Prefers {data.payout.method}{data.payout.handle ? ` (${data.payout.handle})` : ""}{data.payout.mailingAddress ? ` · ${data.payout.mailingAddress}` : ""} · {data.payout.status === "confirmed" ? "confirmed" : "waiting for Finance to confirm"}</span> : null}
              {step.type === "payment_setup" && data.tax ? <span className="block pl-5 text-xs text-muted-foreground">Tax document: {data.tax.words}{data.tax.legalName ? ` · ${data.tax.legalName}` : ""}{data.tax.tinLast4 ? `, ending ${data.tax.tinLast4}` : ""}{data.tax.reason ? ` · ${data.tax.reason}` : ""}{data.tax.problem ? ` · ${data.tax.problem}` : ""}</span> : null}
              {step.type === "training" ? <span className="block pl-5 text-xs text-muted-foreground">{data.training.map((m) => `${m.title}${m.completed ? " ✓" : ""}`).join(" · ")}</span> : null}
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <Badge variant={TONE[step.state]} size="sm">{data.stepWords[step.state]}</Badge>
              {step.type === "signature" && data.agreement?.youCanCountersign ? (
                <Button size="xs" variant="primary" loading={busy} onClick={() => void run(async () => window.open((await countersign({ companyId, cleanerId })).url, "_blank", "noopener"))}>
                  Countersign
                </Button>
              ) : null}
              {step.type === "payment_setup" && data.mayConfirmPay && data.payout && data.payout.status !== "confirmed" ? (
                <Button size="xs" variant="outline" loading={busy} onClick={() => void run(() => confirm({ companyId, cleanerId }))}>
                  Confirm pay preference
                </Button>
              ) : null}
              {step.type === "payment_setup" && data.tax?.hasDocument && data.mayConfirmPay ? (
                <Button size="xs" variant="ghost" loading={busy} onClick={() => void run(async () => window.open((await download({ companyId, cleanerId })).url, "_blank", "noopener"))}>
                  Tax document
                </Button>
              ) : null}
              {step.type === "payment_setup" && data.tax?.status === "failed" && data.mayConfirmPay ? (
                <Button size="xs" variant="ghost" loading={busy} onClick={() => void run(() => retry({ companyId, cleanerId }))}>
                  Try again
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
