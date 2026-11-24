"use client";

/**
 * Email & texting › Business texting: where the company's texting stands, its number and provider, which
 * connection carries each agent's texts, what is blocking sending and the one next step, how this week's
 * texts fared, and the Owner's pause and test text. Every state comes from real records
 * (convex/businessTexting.ts); nothing here infers progress from what someone clicked.
 */
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { useRun } from "@/components/app/form";
import { Panel } from "@/components/app/shell";
import { ArrowRight, MessageSquareText } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/fields";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import { formatPhone } from "./context";

type Overview = (typeof api.businessTexting.overview)["_returnType"];

const TONE: Record<Overview["tone"], "success" | "warning" | "info" | "error" | "outline"> = { good: "success", warning: "warning", bad: "error", progress: "info", neutral: "outline" };
const VIA: Record<Overview["routes"][number]["via"], string> = { selestial: "Your Selestial number", quo: "Your Quo number", none: "Not available yet" };

function Week({ week }: { week: Overview["week"] }) {
  const rows = [
    { label: "Delivered", value: week.delivered },
    { label: "Provider accepted", value: week.accepted },
    { label: "Waiting", value: week.waiting },
    { label: "Delivery not confirmed", value: week.notConfirmed },
    { label: "Failed", value: week.failed },
    { label: "Not sent", value: week.notSent },
  ];
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return (
    <div className="grid gap-2">
      <h3 className="text-sm font-semibold text-strong">Texts in the last 7 days</h3>
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">No texts yet this week.</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="text-sm font-semibold tabular-nums text-strong">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function BusinessTexting() {
  const { companyId, role } = useCompany();
  const view = useQuery(api.businessTexting.overview, { companyId });
  const pause = useMutation(api.companies.pauseMessaging);
  const resume = useMutation(api.companies.resumeMessaging);
  const sendTest = useMutation(api.businessTexting.sendTest);
  const { ask, element: confirmDialog } = useConfirm();
  const { busy, error, run } = useRun();
  const [said, setSaid] = useState<string | null>(null);
  const owner = role === "owner";

  if (view === undefined) return <Skeleton className="h-56" />;

  return (
    <Panel title="Business texting" action={<Badge variant={TONE[view.tone]}>{view.label}</Badge>}>
      <div className="grid gap-5">
        <div className="flex items-start gap-3">
          <MessageSquareText className="mt-0.5 size-5 shrink-0 text-brand-300" aria-hidden />
          <div className="grid gap-1">
            <p className="text-sm text-strong">{view.number ? `Texts go out from ${formatPhone(view.number)}${view.senderName ? ` as ${view.senderName}` : ""}.` : view.about}</p>
            {view.number ? <p className="text-sm text-muted-foreground">{view.about}</p> : view.step ? <p className="text-sm text-muted-foreground">{view.step}</p> : null}
            {view.provider.quo ? <p className="text-xs text-muted-foreground">Quo numbers connected: {view.provider.quo.numbers.map(formatPhone).join(", ")}{view.provider.quo.forNew ? ", used for new conversations" : ""}.</p> : null}
          </div>
        </div>

        {view.blockers.length ? (
          <ul className="grid gap-2" aria-label="What's affecting texting">
            {view.blockers.map((row) => (
              <li key={row.key} className={cn("flex flex-wrap items-start justify-between gap-3 rounded-xl border px-4 py-3", row.severity === "blocks" ? "border-amber-500/30 bg-amber-500/10" : "border-border bg-muted/40")}>
                <p className="min-w-0 flex-1 text-sm text-strong">{row.words}</p>
                {row.action ? (
                  <Link href={row.action.href} className="shrink-0 text-sm font-medium text-strong underline underline-offset-2 hover:no-underline">
                    {row.action.label}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {view.next && owner && !view.blockers.some((row) => row.action?.href === view.next?.href) ? (
          <Link href={view.next.href} className="inline-flex h-9 w-fit items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
            {view.next.label}
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        ) : view.next && !owner ? (
          <p className="text-xs text-muted-foreground">Your company&apos;s Owner sets this up.</p>
        ) : null}

        <div className="grid gap-2">
          <h3 className="text-sm font-semibold text-strong">Who texts through what</h3>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {view.routes.map((row) => (
              <li key={row.agent} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="text-sm text-strong">{row.name}</span>
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  {VIA[row.via]}
                  {row.paused ? <Badge variant="warning">Paused</Badge> : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">A conversation stays on the number it started on, so nobody gets the same text twice from two numbers.</p>
        </div>

        <Week week={view.week} />

        {owner && view.state !== "not_configured" && view.state !== "setup_in_progress" ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            {view.paused ? (
              <Button size="sm" loading={busy} onClick={() =>
                  void run(async () => {
                    const { released } = await resume({ companyId });
                    setSaid(released === 0 ? "Texting resumed." : `Texting resumed. ${released} waiting ${released === 1 ? "message is" : "messages are"} going out now.`);
                  })
                }>
                Resume texting
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void ask({
                    title: "Pause all texting?",
                    body: "Every text to your customers, cleaners and applicants waits until you resume, whoever prepared it. Nothing is lost, and replies to STOP and HELP still go out.",
                    confirmLabel: "Pause texting",
                    cancelLabel: "Keep texting on",
                    action: async () => {
                      await pause({ companyId });
                      setSaid("Texting is paused. Messages wait until you resume.");
                    },
                  })
                }
              >
                Pause all texting
              </Button>
            )}
            {view.canTest ? (
              <Button size="sm" variant="ghost" loading={busy} onClick={() => void run(async () => setSaid(`Test text on its way to your phone ending ${(await sendTest({ companyId })).last4}.`))}>
                Send me a test text
              </Button>
            ) : null}
          </div>
        ) : null}

        <div aria-live="polite">
          {error ? (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          ) : said ? (
            <p className="text-sm text-emerald-700">{said}</p>
          ) : null}
        </div>

        {!view.provider.quo && view.state !== "ready" ? (
          <p className="text-xs text-muted-foreground">
            Already text from Quo (formerly OpenPhone)?{" "}
            <Link href="/app/settings/integrations/quo" className="font-medium text-strong underline-offset-2 hover:underline">
              Connect your Quo account instead
            </Link>
            .
          </p>
        ) : null}
      </div>
      {confirmDialog}
    </Panel>
  );
}
