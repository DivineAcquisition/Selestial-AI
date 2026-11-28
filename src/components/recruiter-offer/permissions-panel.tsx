"use client";

import { useState } from "react";

import { AgentMark } from "@/components/marketing/agent-mark";
import { trackRecruiter } from "@/lib/recruiter-offer/analytics";
import { PERMISSIONS } from "@/lib/recruiter-offer/content";
import { cn } from "@/lib/utils";

const RANK = { off: 0, propose: 1, execute_and_report: 2, execute: 3 } as const;

/**
 * Pick one of Recruiter's tasks and a permission, and read what Recruiter would do — built like the main
 * site's autonomy dial (src/components/marketing/autonomy-dial.tsx). Levels above a task's ceiling are
 * disabled and explained. It changes nothing: it shows the setting.
 */
export function PermissionsPanel() {
  const [actionIndex, setActionIndex] = useState(0);
  const [levelId, setLevelId] = useState<(typeof PERMISSIONS.levels)[number]["id"]>("propose");
  const action = PERMISSIONS.actions[actionIndex];
  const ceiling = RANK[action.ceiling];
  const effective = RANK[levelId] > ceiling ? "propose" : levelId;
  const level = PERMISSIONS.levels.find((l) => l.id === effective)!;
  const locked = "locked" in action ? action.locked : null;

  return (
    <div className="rounded-3xl border border-border bg-white p-5 shadow-[0_30px_80px_-55px_rgba(33,26,53,0.5)] sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <AgentMark id="recruiter" size="md" />
          <h3 className="font-heading text-[17px] tracking-tight text-strong">{PERMISSIONS.title}</h3>
        </div>
        <span className="rounded-full border border-[#e2d9ff] bg-[#eee8ff] px-2.5 py-1 text-[11px] font-semibold text-[#5126c7]">Example</span>
      </div>

      <fieldset className="mt-5">
        <legend className="text-xs font-medium text-muted-foreground">{PERMISSIONS.actionLabel}</legend>
        <div className="mt-2 grid gap-1.5">
          {PERMISSIONS.actions.map((item, index) => (
            <label
              key={item.id}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-sm transition-colors has-focus-visible:outline-2 has-focus-visible:outline-[#6838ef]",
                index === actionIndex ? "border-[#cfc2ff] bg-[#f7f4ff] text-strong" : "border-border bg-white text-muted-foreground hover:text-strong",
              )}
            >
              <input
                type="radio"
                name="recruiter-permission-action"
                className="sr-only"
                checked={index === actionIndex}
                onChange={() => {
                  setActionIndex(index);
                  trackRecruiter("recruiter_workflow_step_selected", { step: `perm-${item.id}`.slice(0, 32) });
                }}
              />
              <span className="min-w-0 font-medium">{item.label}</span>
              {"locked" in item ? <span className="shrink-0 text-[11px] font-medium text-[#5126c7]">Always reviewed</span> : null}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-5">
        <legend className="text-xs font-medium text-muted-foreground">{PERMISSIONS.levelLabel}</legend>
        <div className="mt-2 grid grid-cols-2 gap-1 rounded-xl border border-border bg-[#f1f3f8] p-1 sm:grid-cols-4">
          {PERMISSIONS.levels.map((item) => {
            const disabled = RANK[item.id] > ceiling;
            const on = item.id === effective;
            return (
              <label
                key={item.id}
                className={cn(
                  "rounded-lg px-2 py-2 text-center text-xs font-medium transition-colors has-focus-visible:outline-2 has-focus-visible:outline-[#6838ef]",
                  disabled ? "cursor-not-allowed text-muted-foreground/50" : "cursor-pointer",
                  on ? "bg-white text-[#5126c7] shadow-[0_1px_2px_rgba(33,26,53,0.08),0_0_0_1px_#e2d9ff]" : !disabled && "text-muted-foreground hover:text-strong",
                )}
              >
                <input type="radio" name="recruiter-permission-level" className="sr-only" checked={on} disabled={disabled} onChange={() => setLevelId(item.id)} />
                {item.label}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-4 rounded-xl border border-border bg-[#f8f9fc] p-4" aria-live="polite">
        <p className="text-xs font-medium text-[#5126c7]">Recruiter · {action.label}</p>
        <p className="mt-1.5 text-sm leading-relaxed text-strong">{level.body}</p>
        {locked ? <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{locked}</p> : null}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{PERMISSIONS.note}</p>
    </div>
  );
}
