"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { PageHeader, Panel } from "@/components/app/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FACTS } from "@/lib/trust/documents/types";

import { api } from "../../../../convex/_generated/api";

/** What happened on the way back from Intuit, in words. */
export const RESULT_WORDS: Record<string, { tone: "ok" | "bad"; words: string }> = {
  connected: { tone: "ok", words: "QuickBooks is connected." },
  declined: { tone: "bad", words: "QuickBooks wasn't connected because access wasn't allowed. Connect again when you're ready." },
  expired: { tone: "bad", words: "That sign-in took too long or was already used. Start again." },
  failed: { tone: "bad", words: `QuickBooks couldn't be connected. Nothing was changed. Try again, and email ${FACTS.supportEmail} if it keeps happening.` },
};

/** An email to Selestial support about QuickBooks, with what support needs to trace it with Intuit. Never a token. */
export function supportMail(input: { companyName: string | null; realmId: string | null; error: { at: number; kind: string; status?: number; intuitTid?: string; message: string } | null }): string {
  const lines = [
    "What happened:",
    "",
    "",
    "---",
    `QuickBooks company: ${input.companyName ?? "unknown"}${input.realmId ? ` (realm ${input.realmId})` : ""}`,
    ...(input.error ? [`Last error: ${input.error.message}`, `When: ${new Date(input.error.at).toISOString()}`, `Kind: ${input.error.kind}${input.error.status ? `, HTTP ${input.error.status}` : ""}`, `QuickBooks request id (intuit_tid): ${input.error.intuitTid ?? "none"}`] : []),
  ];
  return `mailto:${FACTS.supportEmail}?subject=${encodeURIComponent("QuickBooks connection help")}&body=${encodeURIComponent(lines.join("\n"))}`;
}

const when = (at: number) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Settings › Connected apps › QuickBooks Online: connect, check, reconnect and disconnect. Only the Owner changes it. */
export function QuickBooksSetupScreen() {
  const { companyId } = useCompany();
  const view = useQuery(api.quickbooks.status, { companyId });
  const result = useSearchParams().get("result");
  const start = useMutation(api.quickbooks.startConnect);
  const disconnect = useMutation(api.quickbooks.disconnect);
  const checkNow = useMutation(api.quickbooks.checkNow);
  const { busy, error, run } = useRun();
  const [confirming, setConfirming] = useState(false);
  const [checking, setChecking] = useState(false);
  const shown = result ? RESULT_WORDS[result] : undefined;

  const connect = () =>
    void run(async () => {
      const { url } = await start({ companyId, returnTo: window.location.origin });
      window.location.assign(url);
    });

  return (
    <div className="grid gap-5">
      <Link href="/app/settings/integrations" className="text-sm font-medium text-muted-foreground hover:text-strong">
        ← Connected apps
      </Link>
      <PageHeader title="QuickBooks Online" lead="Connect your QuickBooks Online company. Selestial confirms the connection works, keeps it working, and asks you to reconnect if QuickBooks ever ends it. Syncing customers, invoices and payments is being built next; nothing is written to QuickBooks yet." />

      {shown ? (
        <p role="status" className={shown.tone === "ok" ? "rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-sm text-strong" : "rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-strong"}>
          {shown.words}
        </p>
      ) : null}

      {view === undefined ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : !view.available ? (
        <Panel title="Not available yet">
          <p className="text-sm text-muted-foreground">Connecting QuickBooks isn&apos;t switched on for Selestial yet. Contact support if you need it.</p>
        </Panel>
      ) : !view.connection ? (
        <Panel title="Connect QuickBooks">
          <div className="grid gap-3 text-sm">
            <p className="text-muted-foreground">You&apos;ll sign in to Intuit, choose your QuickBooks company, and allow Selestial to use its accounting records. You come straight back here.</p>
            {view.environment === "sandbox" ? <p className="text-xs text-muted-foreground">This connects to a QuickBooks sandbox (test) company.</p> : null}
            {view.canManage ? (
              <div>
                <Button variant="primary" size="sm" loading={busy} onClick={connect}>
                  Connect QuickBooks
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Only the Owner can connect QuickBooks.</p>
            )}
            <FormError message={error} />
          </div>
        </Panel>
      ) : (
        <Panel title="Your QuickBooks company">
          <div className="grid gap-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-strong">{view.connection.companyName ?? "QuickBooks company"}</span>
              {view.connection.status === "connected" ? <Badge variant="success">Connected</Badge> : <Badge variant="warning">Needs reconnecting</Badge>}
              {view.connection.environment === "sandbox" ? <Badge variant="outline">Sandbox</Badge> : null}
            </div>
            <p className="text-muted-foreground">
              Connected {when(view.connection.connectedAt)}
              {view.connection.lastCheckedAt ? ` · last checked ${when(view.connection.lastCheckedAt)}` : ""}
            </p>
            {view.connection.lastError ? (
              <div role="status" className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                <p className="text-strong">Last problem ({when(view.connection.lastError.at)}): {view.connection.lastError.message}</p>
                {view.connection.lastError.intuitTid ? <p className="mt-0.5 text-xs text-muted-foreground">QuickBooks request id: {view.connection.lastError.intuitTid}</p> : null}
              </div>
            ) : null}
            {view.connection.status === "needs_reconnect" ? (
              <p role="alert" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-strong">
                {view.connection.problem ?? "QuickBooks ended Selestial's access."} Reconnect to continue. Nothing in QuickBooks was changed.
              </p>
            ) : null}
            {view.canManage ? (
              <div className="flex flex-wrap gap-2">
                {view.connection.status === "needs_reconnect" ? (
                  <Button variant="primary" size="sm" loading={busy} onClick={connect}>
                    Reconnect QuickBooks
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={busy && checking}
                    onClick={() =>
                      void run(async () => {
                        setChecking(true);
                        try {
                          await checkNow({ companyId });
                        } finally {
                          setChecking(false);
                        }
                      })
                    }
                  >
                    Check connection
                  </Button>
                )}
                {confirming ? (
                  <>
                    <Button variant="destructive" size="sm" loading={busy && !checking} onClick={() => void run(async () => (await disconnect({ companyId }), setConfirming(false)))}>
                      Yes, disconnect
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                      Keep connected
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                    Disconnect
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Only the Owner can reconnect or disconnect QuickBooks.</p>
            )}
            <p className="text-xs text-muted-foreground">
              Something not right?{" "}
              <a href={supportMail({ companyName: view.connection.companyName, realmId: view.connection.realmId, error: view.connection.lastError })} className="font-medium text-brand-600 underline-offset-2 hover:underline">
                Contact Selestial support
              </a>
              {view.connection.lastError?.intuitTid ? " (the QuickBooks request id is included)" : ""}.
            </p>
            {confirming ? <p className="text-xs text-muted-foreground">Disconnecting ends Selestial&apos;s access at Intuit too. You can connect again any time.</p> : null}
            <FormError message={error} />
          </div>
        </Panel>
      )}
    </div>
  );
}
