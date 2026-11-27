"use client";

/**
 * Setup's place on Home, for the Owner: the outcome they chose, the most useful thing prepared for it,
 * what is still running, the one next thing to do, and a short list of what else is left. It reads the
 * same records as setup, so it never shows a step that is done or a result that isn't real. Closing it
 * keeps a small "Show setup" link, so setup is never lost.
 */
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";

import { AgentAvatar, type AgentId } from "@/components/app/agent";
import { useCompany } from "@/components/app/company";
import { ArrowRight, ArrowUpRight, LoaderCircle, Sparkles, X } from "@/components/icons";
import { Button } from "@/components/ui/button";

import { api } from "../../../../convex/_generated/api";
import { PRIORITY_INFO } from "../../../../convex/lib/setup/path";
import { countWords } from "./business";
import { StateBadge } from "./build-panel";

export function SetupContinuation() {
  const { companyId, role } = useCompany();
  const owner = role === "owner";
  const view = useQuery(api.setup.state, owner ? { companyId } : "skip");
  const status = useQuery(api.setup.buildStatus, owner ? { companyId } : "skip");
  const list = useQuery(api.setupProgress.checklist, owner ? { companyId } : "skip");
  const dismiss = useMutation(api.setupProgress.dismissChecklist);
  const reopen = useMutation(api.setup.reopen);
  const setup = view?.setup;
  // In progress, the owner is in setup itself; a company with no setup row never sees this.
  if (!owner || !setup || setup.status !== "entered") return null;
  if (setup.checklistDismissed) {
    return (
      <p className="text-xs text-muted-foreground">
        <button type="button" className="font-medium text-[#5126c7] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-brand-500" onClick={() => void reopen({ companyId })}>
          Show setup progress
        </button>
      </p>
    );
  }
  const outcome = PRIORITY_INFO.find((item) => item.id === setup.priority);
  const started = status?.started === true ? status : null;
  const lead = started?.lead ?? null;
  // One next action: unfinished setup first, then the lead result's own next step, then what's left.
  const next = !started
    ? { label: setup.priority ? "Build my workspace" : "Choose what Selestial helps with first", href: `/app/setup?step=${setup.priority ? "build" : "outcome"}` }
    : lead?.state === "ready" && lead.outputs[0]
      ? { label: "Review your first result", href: lead.outputs[0].href }
      : lead?.action
        ? { label: lead.action.label, href: lead.action.href }
        : list?.items[0]
          ? { label: list.items[0].words, href: list.items[0].href }
          : null;
  const others = (list?.items ?? []).filter((item) => item.href !== next?.href).slice(0, 3);
  return (
    <section className="grid gap-3 rounded-2xl border border-[#6838ef]/25 bg-white p-4 sm:p-5" aria-labelledby="setup-continue">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#eee8ff] text-[#6838ef]" aria-hidden>
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-[#5126c7]">{outcome ? outcome.title : "Your setup"}</p>
          <h2 id="setup-continue" className="font-display text-lg font-semibold text-strong">
            {started ? started.headline : setup.priority ? "Your workspace isn't built yet" : "Finish setting up"}
          </h2>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {started ? countWords(started.counts) : "Your answers are saved. Nothing has been prepared and no agent work has started."}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Hide setup progress" onClick={() => void dismiss({ companyId })}>
          <X aria-hidden />
        </Button>
      </div>

      {lead ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[#f7f5ff] px-3 py-2.5 text-sm">
          {lead.agent ? <AgentAvatar agent={lead.agent as AgentId} size="xs" /> : null}
          <span className="min-w-0 flex-1 font-medium text-strong">{lead.outputs[0]?.label ?? lead.title}</span>
          <StateBadge state={lead.state} />
        </div>
      ) : null}
      {started && started.counts.preparing ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin text-[#6838ef] motion-reduce:animate-none" aria-hidden />
          {started.counts.preparing === 1 ? "1 item is" : `${started.counts.preparing} items are`} still being prepared. You&apos;ll be notified when it&apos;s ready.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {next ? (
          <Button variant="primary" size="sm" render={<Link href={next.href} />}>
            {next.label}
            <ArrowRight aria-hidden />
          </Button>
        ) : null}
        <Button variant="outline" size="sm" render={<Link href={`/app/setup?step=${started ? "result" : setup.step}`} />}>
          {started ? "Open setup" : "Continue setup"}
        </Button>
      </div>

      {others.length ? (
        <div className="grid gap-1 border-t border-border pt-2">
          <p className="text-xs font-medium text-muted-foreground">Also left, whenever you&apos;re ready</p>
          <ul className="grid gap-0.5">
            {others.map((item) => (
              <li key={item.words}>
                <Link href={item.href} className="flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm text-strong hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-brand-500">
                  <span className="size-3.5 shrink-0 rounded-full border-2 border-border" aria-hidden />
                  <span className="min-w-0 flex-1">{item.words}</span>
                  <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
