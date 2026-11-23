"use client";

/**
 * The last step of connecting a Google tool (Drive, Calendar, Business Profile, Ads, booked-job reporting;
 * convex/google.ts). Google's answer only leaves the authorization waiting; the browser lands back here with a
 * one-time value in the address (?pending=…). This shows WHICH Google account is about to be connected and
 * asks the signed-in Owner who started it to confirm. Until they do, Selestial uses nothing, and after fifteen
 * minutes the access is thrown away.
 */
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { api } from "../../../../convex/_generated/api";

type Finished = { kind: "connected" | "cancelled" | "not_connected"; email: string; result: string };

export function ConfirmGoogle({ token, describe }: { token: string; describe: (result: string) => string }) {
  const { companyId } = useCompany();
  const pending = useQuery(api.google.pendingConnect, { companyId, token });
  const confirm = useMutation(api.google.confirmConnect);
  const cancel = useMutation(api.google.cancelConnect);
  const { busy, error, run } = useRun();
  const [finished, setFinished] = useState<Finished | null>(null);

  if (finished) {
    const words =
      finished.kind === "cancelled"
        ? `${finished.email} was not connected. Selestial has thrown away the access Google gave it.`
        : finished.result === "expired"
          ? `That took longer than 15 minutes, so ${finished.email} was not connected. Please start again.`
          : describe(finished.result);
    return (
      <p role="status" className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-strong">
        {words}
      </p>
    );
  }
  if (pending === undefined) return <Skeleton className="h-24 rounded-xl" />;
  if (pending === null) {
    return (
      <p role="status" className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-strong">
        Nothing was connected. This Google sign-in can only be finished by the Owner who started it, signed in to Selestial in this browser, within 15 minutes. If that was you, please start again. If you didn&apos;t start it, you can close this page: Selestial throws the access away by itself.
      </p>
    );
  }
  return (
    <div role="group" aria-label="Confirm the Google account to connect" className="grid gap-3 rounded-xl border border-border bg-card p-4">
      <div className="grid gap-1">
        <p className="text-sm text-muted-foreground">Google is ready to connect {pending.label} with this account. Check it before you go on.</p>
        <p className="break-all text-lg font-semibold text-strong">{pending.email}</p>
      </div>
      <ul className="grid gap-1 text-sm text-muted-foreground">
        <li>{pending.does}</li>
        {pending.replaces ? <li>This replaces {pending.replaces} for {pending.label}. What was chosen for it stops being used.</li> : null}
        {!pending.complete ? <li>Google granted only part of what this tool needs, so it will stay off until you reconnect and allow everything.</li> : null}
      </ul>
      <p className="text-xs text-muted-foreground">Nothing is used until you confirm. If this isn&apos;t the account you meant, choose “Don&apos;t connect”.</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="primary"
          loading={busy}
          onClick={() =>
            void run(async () => {
              const done = await confirm({ companyId, token });
              setFinished({ kind: done.connected ? "connected" : "not_connected", email: done.email, result: done.result });
            })
          }
        >
          Connect {pending.email}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await cancel({ companyId, token });
              setFinished({ kind: "cancelled", email: pending.email, result: "cancelled" });
            })
          }
        >
          Don&apos;t connect
        </Button>
      </div>
      <FormError message={error} />
    </div>
  );
}
