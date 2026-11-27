"use client";

/**
 * What "Build my workspace" made, in one place: the result for the owner's outcome first, with its real
 * records, then everything else, each in one truthful state. Counts come from the server's records: a
 * failed or waiting item is never counted as prepared, and nothing is called published unless it is.
 * Results show as they arrive, and one failed or blocked item never hides another that is ready.
 */
import { useMutation } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AgentAvatar, type AgentId } from "@/components/app/agent";
import { useCompany } from "@/components/app/company";
import { messageOf } from "@/components/app/form";
import { ArrowUpRight, CheckCircle2, CircleAlertIcon, LoaderCircle, RefreshCw } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { BUILD_STATE_WORDS, type BuildItem, type BuildState } from "../../../../convex/lib/setup/build";
import { safeSetupPath } from "../../../../convex/lib/setup/routes";
import { countWords } from "./business";

type Status = Extract<NonNullable<FunctionReturnType<typeof api.setup.buildStatus>>, { started: true }>;

export const STATE_TONE: Record<BuildState, "info" | "success" | "warning" | "error" | "outline"> = {
  preparing: "info",
  ready: "info",
  needs_input: "warning",
  waiting_connection: "warning",
  failed: "error",
  published: "success",
  done: "success",
  not_available: "outline",
};

export function StateBadge({ state }: { state: BuildState }) {
  return (
    <Badge variant={STATE_TONE[state]} size="sm">
      {state === "preparing" ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
      {BUILD_STATE_WORDS[state]}
    </Badge>
  );
}

/** Opens a prepared record from setup: recorded once as the first review, and as a handoff so "Return to setup" knows where they were. */
export function useOpen() {
  const { companyId } = useCompany();
  const router = useRouter();
  const opened = useMutation(api.setup.opened);
  const handoff = useMutation(api.setup.handoff);
  return async (href: string, key: string, beforeLeave?: () => Promise<unknown>) => {
    const safe = safeSetupPath(href);
    await beforeLeave?.();
    await opened({ companyId, key }).catch(() => undefined);
    if (safe) await handoff({ companyId, href: safe, phase: "started" }).catch(() => undefined);
    router.push(href);
  };
}

function Retry({ item }: { item: BuildItem }) {
  const { companyId } = useCompany();
  const retry = useMutation(api.setup.retryBuildItem);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!item.retry) return null;
  const target = item.retry;
  return (
    <>
      <Button
        variant="outline"
        size="xs"
        loading={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          retry({ companyId, ...(target.kind === "configure" ? { configureKind: target.outputKind } : { taskId: target.taskId as never }) })
            .catch((caught) => setError(messageOf(caught)))
            .finally(() => setBusy(false));
        }}
      >
        <RefreshCw aria-hidden className="size-3.5" />
        {item.state === "failed" ? "Try again" : "Check again"}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive-foreground">
          {error}
        </span>
      ) : null}
    </>
  );
}

function Outputs({ item, onOpen }: { item: BuildItem; onOpen: (href: string) => void }) {
  if (!item.outputs.length) return null;
  return (
    <ul className="grid gap-1.5">
      {item.outputs.slice(0, 4).map((output) => (
        <li key={output.href + output.label} className="flex flex-wrap items-center gap-2 rounded-lg bg-[#f7f5ff] px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-strong">{output.label}</span>
            <span className="block text-xs text-muted-foreground">{output.state}</span>
            {output.flags.length ? <span className="block text-xs text-warning-foreground">{output.flags.join(" · ")}</span> : null}
          </span>
          <Button variant="ghost" size="xs" onClick={() => onOpen(output.href)}>
            Open
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function ResultPanel({ status, onEdit, onFinishLater, beforeLeave }: { status: Status; onEdit: () => void; onFinishLater: () => void; beforeLeave?: () => Promise<unknown> }) {
  const open = useOpen();
  const { lead, rest, counts } = status;
  const go = (href: string, key: string) => void open(href, key, beforeLeave);
  const empty = counts.usable === 0 && counts.preparing === 0;
  return (
    <div className="grid gap-5">
      <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
        {countWords(counts)}
      </p>

      {lead ? (
        <article className="grid gap-3 rounded-2xl border border-[#6838ef]/30 bg-white p-4 shadow-[0_1px_2px_rgba(33,26,53,0.06),0_8px_24px_-12px_rgba(104,56,239,0.25)] sm:p-5" aria-labelledby="lead-result">
          <header className="flex flex-wrap items-start gap-3">
            {lead.agent ? <AgentAvatar agent={lead.agent as AgentId} size="sm" /> : null}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-muted-foreground">{lead.agent ? `${lead.agent.charAt(0).toUpperCase()}${lead.agent.slice(1)} · your first result` : "Your first result"}</p>
              <h2 id="lead-result" className="font-display text-xl font-semibold text-strong">
                {status.headline}
              </h2>
            </div>
            <StateBadge state={lead.state} />
          </header>
          <p className="text-sm text-strong">{lead.words}</p>
          <Outputs item={lead} onOpen={(href) => go(href, lead.key)} />
          <div className="flex flex-wrap items-center gap-2">
            {lead.outputs[0] && (lead.state === "ready" || lead.state === "published") ? (
              <Button variant="primary" onClick={() => go(lead.outputs[0].href, lead.key)}>
                Preview and review
              </Button>
            ) : lead.action ? (
              <Button variant="primary" onClick={() => go(lead.action!.href, lead.key)}>
                {lead.action.label}
              </Button>
            ) : null}
            <Button variant="outline" onClick={onEdit}>
              Make changes
            </Button>
            <Button variant="ghost" onClick={onFinishLater}>
              Finish later
            </Button>
            <Retry item={lead} />
          </div>
        </article>
      ) : null}

      {empty && !lead ? (
        <p className="rounded-xl border border-border bg-white px-4 py-3 text-sm text-muted-foreground">Nothing is ready to review yet. The items below say exactly what each one needs.</p>
      ) : null}

      {rest.length ? (
        <section className="grid gap-2" aria-labelledby="also-prepared">
          <h3 id="also-prepared" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Also in your workspace
          </h3>
          <ul className="grid gap-2">
            {rest.map((item) => (
              <li key={item.key} className={cn("grid gap-2 rounded-xl border bg-white p-3", item.state === "failed" ? "border-destructive/30" : "border-border")}>
                <div className="flex flex-wrap items-center gap-2">
                  {item.agent ? <AgentAvatar agent={item.agent as AgentId} size="xs" /> : null}
                  <p className="min-w-0 flex-1 text-sm font-medium text-strong">{item.title}</p>
                  <StateBadge state={item.state} />
                </div>
                <p className="flex gap-2 text-sm text-muted-foreground">
                  {item.state === "failed" || item.state === "needs_input" ? <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden /> : item.state === "ready" || item.state === "published" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : null}
                  <span>{item.words}</span>
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {item.outputs[0] ? (
                    <Button variant="outline" size="xs" onClick={() => go(item.outputs[0].href, item.key)}>
                      Preview and review
                    </Button>
                  ) : null}
                  {item.action && !(item.outputs[0] && item.action.href === item.outputs[0].href) ? (
                    <Button variant="outline" size="xs" render={<Link href={item.action.href} />} onClick={() => void beforeLeave?.()}>
                      {item.action.label}
                    </Button>
                  ) : null}
                  <Retry item={item} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {status.note ? <p className="text-xs text-muted-foreground">{status.note}</p> : null}
    </div>
  );
}
