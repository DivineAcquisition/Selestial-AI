"use client";

/**
 * The pieces every Client Care screen is built from. A status is words with a mark, never a colour alone; who a
 * request waits on is always said; what a line rests on (a record, the client's words, a policy, a calculation)
 * is shown beside it. Nothing animates unless work is really under way.
 */
import type { FunctionReturnType } from "convex/server";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { AlertTriangle, ChatIcon, CheckCircle2, CircleDashed, Hand, Hourglass, LightningIcon, PauseCircleIcon } from "@/components/icons";
import { whenLabel } from "@/lib/app/format";
import { cn } from "@/lib/utils";

import type { api } from "../../../../../convex/_generated/api";

export type CareOverview = FunctionReturnType<typeof api.clientCare.overview>;
export type CareCard = CareOverview["decisions"][number];
export type CareDetail = FunctionReturnType<typeof api.clientCare.detail>;
export type CareFollowUp = FunctionReturnType<typeof api.clientCare.followUps>[number];
export type CareSetupView = FunctionReturnType<typeof api.clientCare.setup>;

export const CARE_PATH = "/app/agents/customer-care";
export const CARE_NAME = "Client Care";
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

type Status = CareCard["status"];
const STATUS_LOOK: Record<Status, { icon: typeof Hand; tone: string }> = {
  new: { icon: CircleDashed, tone: "border-brand-500/30 bg-brand-500/10 text-brand-300" },
  in_progress: { icon: LightningIcon, tone: "border-brand-500/30 bg-brand-500/10 text-brand-300" },
  waiting_customer: { icon: ChatIcon, tone: "border-border bg-muted text-strong" },
  waiting_team: { icon: Hourglass, tone: "border-border bg-muted text-strong" },
  waiting_owner: { icon: Hand, tone: "border-warning/40 bg-warning/10 text-warning-foreground" },
  resolved: { icon: CheckCircle2, tone: "border-success/30 bg-success/10 text-success-foreground" },
  closed_no_action: { icon: CheckCircle2, tone: "border-border bg-background text-muted-foreground" },
};

export function StatusPill({ status, words, className }: { status: Status; words: string; className?: string }) {
  const look = STATUS_LOOK[status];
  const Icon = look.icon;
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap", look.tone, className)}>
      <Icon className="size-3.5" aria-hidden />
      {words}
    </span>
  );
}

export function UrgencyFlag({ urgency }: { urgency: CareCard["urgency"] }) {
  if (urgency === "normal") return null;
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium", urgency === "urgent" ? "border-destructive/30 bg-destructive/10 text-destructive-foreground" : "border-warning/40 bg-warning/10 text-warning-foreground")}>
      <AlertTriangle className="size-3" aria-hidden />
      {urgency === "urgent" ? "Urgent" : "Soon"}
    </span>
  );
}

const BASIS: Record<string, { label: string; tone: string }> = {
  record: { label: "Record", tone: "border-success/30 bg-success/10 text-success-foreground" },
  customer: { label: "Client said", tone: "border-brand-500/30 bg-brand-500/10 text-brand-300" },
  policy: { label: "Policy", tone: "border-info/30 bg-info/10 text-info-foreground" },
  derived: { label: "Worked out", tone: "border-dashed border-border bg-background text-muted-foreground" },
};

export function BasisTag({ basis }: { basis: string }) {
  const look = BASIS[basis] ?? BASIS.record;
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-[11px] font-medium", look.tone)}>{look.label}</span>;
}

const MODE_LOOK: Record<CareFollowUp["mode"], { label: string; tone: string; icon: typeof Hand }> = {
  automatic: { label: "Automatic", tone: "border-success/30 bg-success/10 text-success-foreground", icon: LightningIcon },
    approval: { label: "Waiting for approval", tone: "border-warning/40 bg-warning/10 text-warning-foreground", icon: Hand },
    blocked: { label: "Needs a person", tone: "border-warning/40 bg-warning/10 text-warning-foreground", icon: AlertTriangle },
    held: { label: "With a person", tone: "border-border bg-muted text-strong", icon: Hand },
    paused: { label: "Client Care paused", tone: "border-border bg-muted text-muted-foreground", icon: PauseCircleIcon },
};

export function ModeTag({ mode }: { mode: CareFollowUp["mode"] }) {
  const look = MODE_LOOK[mode];
  const Icon = look.icon;
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap", look.tone)}>
      <Icon className="size-3.5" aria-hidden />
      {look.label}
    </span>
  );
}

/** Opens one request in the panel over the page, and keeps it in the address so it can be shared and reloaded. */
export function useRequestParam() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const openId = params.get("request");
  const set = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set("request", id);
      else next.delete("request");
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  return { openId, open: (id: string) => set(id), close: () => set(null) };
}

/** One request at a glance: who, what, which visit, where it stands, who has it and what happens next. */
export function RequestCard({ card, now, timezone, onOpen }: { card: CareCard; now: number | null; timezone: string; onOpen: (id: string) => void }) {
  const attention = card.urgency === "urgent" || card.status === "waiting_owner";
  return (
    <button
      type="button"
      onClick={() => onOpen(card.id)}
      className={cn("group relative grid w-full grid-cols-1 gap-2.5 overflow-hidden rounded-2xl border bg-card p-4 text-left transition-colors hover:border-brand-500/50 focus-visible:outline-2 focus-visible:outline-brand-500 sm:p-5", attention ? "border-warning/40" : "border-border")}
      aria-label={`${card.customer.name}: ${card.categoryWords}. ${card.statusWords}.`}
    >
      {attention ? <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", card.urgency === "urgent" ? "bg-destructive" : "bg-warning")} /> : null}
      <span className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <span className="min-w-0">
          <span className="block text-base font-semibold text-strong [overflow-wrap:anywhere]">
            {card.customer.name}
            {card.writer ? <span className="font-normal text-muted-foreground"> · {card.writer}</span> : null}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {card.categoryWords}
            {card.property ? ` · ${card.property}` : ""}
            {card.visit ? ` · visit ${card.visit}` : ""}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <UrgencyFlag urgency={card.urgency} />
          <StatusPill status={card.status} words={card.statusWords} />
        </span>
      </span>
      <span className="text-sm leading-snug text-foreground [overflow-wrap:anywhere]">{card.summary}</span>
      <span className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-3">
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <span className="font-semibold text-strong">{card.held ? "With " : "Next: "}</span>
          {card.held ? card.owner : (card.blocker ?? card.waiting ?? card.nextAction ?? "Client Care is working it.")}
        </span>
        <span className="whitespace-nowrap">
          {card.promisedBy ? `Update promised ${now ? whenLabel(card.promisedBy, now, timezone) : ""}` : card.lastUpdateAt && now ? `Client told ${whenLabel(card.lastUpdateAt, now, timezone)}` : now ? `Client wrote ${whenLabel(card.lastClientAt, now, timezone)}` : ""}
        </span>
      </span>
    </button>
  );
}
