"use client";

import { useRef, useState } from "react";

import { AgentMark } from "@/components/marketing/agent-mark";
import { trackRecruiter } from "@/lib/recruiter-offer/analytics";
import { WORKFLOW, type WorkflowStep } from "@/lib/recruiter-offer/content";
import { cn } from "@/lib/utils";

const ROWS: { key: keyof Pick<WorkflowStep, "receives" | "prepares" | "next">; label: string }[] = [
  { key: "receives", label: "What Recruiter receives" },
  { key: "prepares", label: "What it organizes or prepares" },
  { key: "next", label: "What happens next" },
];

/**
 * The interactive workflow: five real tabs (arrow keys, Home and End move between them; the panel is
 * labelled by its tab). A demonstration with sample data, and it says so.
 */
export function WorkflowPreview() {
  const steps = WORKFLOW.steps;
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const select = (index: number, focus = false) => {
    const next = (index + steps.length) % steps.length;
    setActive(next);
    if (focus) tabs.current[next]?.focus();
    trackRecruiter("recruiter_workflow_step_selected", { step: steps[next].id });
  };
  const step = steps[active];
  return (
    <div className="overflow-hidden rounded-3xl border border-border bg-white shadow-[0_30px_80px_-50px_rgba(33,26,53,0.5)]">
      <div role="tablist" aria-label="Recruiting steps" className="flex flex-wrap gap-1.5 border-b border-border bg-[#f8f9fc] p-2 sm:p-3">
        {steps.map((s, i) => (
          <button
            key={s.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            id={`wf-tab-${s.id}`}
            type="button"
            role="tab"
            aria-selected={i === active}
            aria-controls={`wf-panel-${s.id}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => select(i)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); select(i + 1, true); }
              else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); select(i - 1, true); }
              else if (e.key === "Home") { e.preventDefault(); select(0, true); }
              else if (e.key === "End") { e.preventDefault(); select(steps.length - 1, true); }
            }}
            className={cn(
              "inline-flex h-10 items-center gap-2 rounded-xl px-3.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#6838ef]/60 motion-reduce:transition-none",
              i === active ? "bg-white text-[#5126c7] shadow-[0_1px_2px_rgba(33,26,53,0.08),0_0_0_1px_#e2d9ff]" : "text-muted-foreground hover:bg-white/70 hover:text-strong",
            )}
          >
            <span className={cn("grid size-5 place-items-center rounded-full text-[11px] tabular-nums", i === active ? "bg-[#6838ef] text-white" : "bg-[#eee8ff] text-[#5126c7]")}>{i + 1}</span>
            {s.label}
          </button>
        ))}
      </div>
      <div id={`wf-panel-${step.id}`} role="tabpanel" aria-labelledby={`wf-tab-${step.id}`} tabIndex={0} className="grid gap-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#6838ef]/40 lg:grid-cols-[1.1fr_0.9fr]">
        <dl className="grid content-start gap-px bg-border lg:border-r lg:border-border">
          {ROWS.map((row) => (
            <div key={row.key} className="bg-white p-5 sm:p-6">
              <dt className="text-[11px] font-semibold tracking-[0.12em] text-[#5126c7] uppercase">{row.label}</dt>
              <dd className="mt-2 text-[15px] leading-relaxed text-strong">{step[row.key]}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col justify-between gap-6 bg-[#f8f9fc] p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <AgentMark id="recruiter" size="lg" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-strong">Recruiter</p>
              <p className="text-xs text-muted-foreground">Step {active + 1} of {steps.length} · {step.label}</p>
              <p className="mt-4 text-[11px] font-semibold tracking-[0.12em] text-[#5126c7] uppercase">What you see</p>
              <p className="mt-2 rounded-2xl rounded-tl-sm border border-border bg-white p-3.5 text-[14px] leading-relaxed text-strong shadow-sm">{step.ownerSees}</p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{WORKFLOW.demoNote}</p>
            <button
              type="button"
              onClick={() => select(active + 1)}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-white px-3 text-sm font-medium text-strong hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-[#6838ef]/60"
            >
              {active === steps.length - 1 ? "Start over" : `Next: ${steps[active + 1].label}`}
              <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3l5 5-5 5" /></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
