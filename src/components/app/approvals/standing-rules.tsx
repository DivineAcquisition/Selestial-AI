"use client";

import { useMutation, useQuery } from "convex/react";

import { canManage, useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { Button } from "@/components/ui/button";
import { dayName } from "@/lib/app/format";

import { api } from "../../../../convex/_generated/api";

/** The rules people kept from their reasons on Approvals. Removing one lets the agent propose it again. */
export function StandingRules() {
  const { companyId, role, timezone } = useCompany();
  const manager = canManage(role);
  const rules = useQuery(api.approvalRules.list, manager ? { companyId } : "skip");
  const remove = useMutation(api.approvalRules.remove);
  const { busy, error, run } = useRun();
  if (!manager || !rules || rules.length === 0) return null;
  return (
    <section aria-labelledby="standing-rules" className="mt-8 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <h2 id="standing-rules" className="text-sm font-semibold text-strong">
        Standing rules
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">Kept from reasons you gave when skipping a proposal. The agent follows them until you remove one.</p>
      <FormError message={error} />
      <ul className="mt-3 grid gap-2">
        {rules.map((rule) => (
          <li key={rule.ruleId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2.5">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-strong">{rule.words}</span>
              <span className="block text-xs text-muted-foreground">
                “{rule.why}” · {rule.by}, {dayName(rule.at, timezone)}
              </span>
            </span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => remove({ companyId, ruleId: rule.ruleId }))}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
