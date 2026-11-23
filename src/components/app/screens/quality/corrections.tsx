"use client";

/**
 * Corrections Quality scoped: where each stands with Retention, the Owner and Dispatch, what it cost (Owner
 * only), whether Quality verified the work, and, separately, what the customer said. Nothing is "resolved".
 */
import { useCompany } from "@/components/app/company";
import { PageHeader, Panel } from "@/components/app/shell";
import { useNow } from "@/components/app/use-now";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { money, whenLabel } from "@/lib/app/format";
import { useStableQuery } from "@/lib/app/stable-query";

import { api } from "../../../../../convex/_generated/api";
import { CaseWorkspace } from "./case-workspace";
import { Empty, useParam } from "./shared";

const STEPS = ["proposed", "approved", "scheduled", "crew_accepted", "completed", "quality_verified"] as const;
const STEP_WORDS: Record<(typeof STEPS)[number], string> = { proposed: "Proposed", approved: "Approved", scheduled: "Scheduled", crew_accepted: "Crew accepted", completed: "Completed", quality_verified: "Quality verified" };

export function QualityCorrectionsScreen() {
  const { companyId, timezone, role } = useCompany();
  const now = useNow();
  const rows = useStableQuery(api.quality.corrections, { companyId });
  const { openId, open, close } = useParam("case");
  return (
    <>
      <PageHeader title="Corrections" lead="Corrections Quality scoped. Retention arranges them with the customer, the Owner sets the crew's pay, Dispatch staffs them, and Quality checks the work. What the customer says is kept apart." />
      {rows === undefined ? (
        <Skeleton className="h-48 rounded-2xl" aria-busy="true" />
      ) : rows.length ? (
        <div className="grid gap-3">
          {rows.map((c) => {
            const reached = STEPS.indexOf(c.state as (typeof STEPS)[number]);
            return (
              <Panel key={c.id}>
                <div className="grid gap-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <button type="button" className="text-left text-base font-semibold text-strong hover:underline" onClick={() => open(c.caseId)}>{c.caseTitle}</button>
                    <span className="flex flex-wrap gap-1.5">
                      <Badge variant={c.state === "quality_verified" ? "success" : c.state === "verification_failed" || c.state === "blocked" ? "warning" : "outline"} size="sm">{c.stateWords}</Badge>
                      <Badge variant={c.customer === "confirmed" ? "success" : c.customer === "dissatisfied" ? "warning" : "outline"} size="sm">{c.customerWords}</Badge>
                    </span>
                  </div>
                  <ol className="grid grid-cols-3 gap-1 sm:grid-cols-6" aria-label="Where the correction stands">
                    {STEPS.map((step, i) => (
                      <li key={step} className={`rounded-md border px-2 py-1 text-center text-[11px] ${i <= reached && reached >= 0 ? "border-brand-500/40 bg-brand-500/10 text-strong" : "border-border text-muted-foreground"}`}>
                        {STEP_WORDS[step]}
                        <span className="sr-only">{i <= reached && reached >= 0 ? ": reached" : ": not yet"}</span>
                      </li>
                    ))}
                  </ol>
                  <p className="text-sm text-foreground">{c.scope === "targeted" ? "Targeted" : "Full"}: {c.areas.join(", ") || "the reported work"} · {c.minutes} min{c.visit ? ` · ${c.visit.day}` : ""}</p>
                  <p className="text-xs text-muted-foreground">Acceptance: {c.acceptance}</p>
                  {c.remedy?.payNeeded ? <p className="text-xs font-medium text-warning-foreground">Waiting for the Owner to set the crew&rsquo;s pay, which books the visit.</p> : null}
                  {c.verification ? <p className="text-xs text-muted-foreground">Verification {whenLabel(c.verification.at, now, timezone)}: {c.verification.detail}</p> : null}
                  {role === "owner" ? <p className="text-xs text-muted-foreground">{c.estimatedCostCents !== null ? `Estimated ${money(c.estimatedCostCents)}` : "No reliable estimate"}{c.actualCostCents !== null ? ` · actual ${money(c.actualCostCents)}` : ""}{c.costBasis ? ` · ${c.costBasis}` : ""}</p> : null}
                </div>
              </Panel>
            );
          })}
        </div>
      ) : (
        <Empty title="No corrections" body="When a reviewed finding shows a service miss, a correction is scoped on its case and handed to Retention." />
      )}
      <CaseWorkspace id={openId} onClose={close} />
    </>
  );
}
