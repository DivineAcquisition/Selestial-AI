"use client";

/**
 * The last step of connecting a Gmail inbox (convex/recruiterMailbox.ts). Google's answer only leaves the
 * mailbox waiting; the browser lands back here with a one-time value in the address (?pending=…). This
 * shows WHICH mailbox is about to be connected and asks the signed-in Owner who started it to confirm.
 * Until they do, Selestial reads and sends nothing, and after fifteen minutes the access is thrown away.
 */
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { api } from "../../../../convex/_generated/api";

type Finished = { kind: "connected" | "cancelled" | "late"; address: string };

export function ConfirmInbox({ token }: { token: string }) {
  const { companyId } = useCompany();
  const pending = useQuery(api.recruiterMailbox.pendingConnect, { companyId, token });
  const confirm = useMutation(api.recruiterMailbox.confirmConnect);
  const cancel = useMutation(api.recruiterMailbox.cancelConnect);
  const { busy, error, run } = useRun();
  const [finished, setFinished] = useState<Finished | null>(null);

  if (finished) {
    const words =
      finished.kind === "connected"
        ? `${finished.address} is connected. Selestial is reading it now.`
        : finished.kind === "cancelled"
          ? `${finished.address} was not connected. Selestial has thrown away the access Google gave it.`
          : `That took longer than 15 minutes, so ${finished.address} was not connected. Please start again.`;
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
        Nothing was connected. This Gmail sign-in can only be finished by the Owner who started it, signed in to Selestial in this browser, within 15 minutes. If that was you, please start again. If you didn&apos;t start it, you can close this page: Selestial throws the access away by itself.
      </p>
    );
  }
  return (
    <div role="group" aria-label="Confirm the inbox to connect" className="grid gap-3 rounded-xl border border-border bg-card p-4">
      <div className="grid gap-1">
        <p className="text-sm text-muted-foreground">Google is ready to connect this mailbox. Check the address before you go on.</p>
        <p className="break-all text-lg font-semibold text-strong">{pending.address}</p>
      </div>
      <ul className="grid gap-1 text-sm text-muted-foreground">
        <li>Used for: {pending.purposes.join(", ")}.</li>
        <li>{pending.label ? `Selestial reads only mail labelled “${pending.label}”` : "Selestial reads this inbox"}, from {new Date(pending.readsFrom).toLocaleDateString()} on.</li>
        <li>{pending.canSend ? "Selestial may send email as this address." : "Selestial will not send from this address."}</li>
      </ul>
      <p className="text-xs text-muted-foreground">Nothing is read or sent until you confirm. If this isn&apos;t the mailbox you meant, choose “Don&apos;t connect”.</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="primary"
          loading={busy}
          onClick={() =>
            void run(async () => {
              const done = await confirm({ companyId, token });
              setFinished({ kind: done.connected ? "connected" : "late", address: done.address });
            })
          }
        >
          Connect {pending.address}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await cancel({ companyId, token });
              setFinished({ kind: "cancelled", address: pending.address });
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
