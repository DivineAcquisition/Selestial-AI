"use client";

/**
 * "Save as a Google Doc" on an agreement's page (convex/googleDrive.ts, exportAgreement). It saves a copy of
 * the version being read into the Drive folder the Owner chose for agreements. A copy is for reading and
 * sharing: it never sends, approves or signs anything, and the agreement does not change. Shown only to
 * people who may export agreements; the server checks that again.
 */
import { useMutation, useQuery } from "convex/react";

import { useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { Button } from "@/components/ui/button";

import { api } from "../../../../convex/_generated/api";

const STATUS_WORDS: Record<string, string> = { queued: "Saving to Google Docs…", running: "Saving to Google Docs…", uncertain: "Checking with Google…", failed: "Not saved to Google Docs", cancelled: "Not saved to Google Docs" };

export function GoogleDocExport({ agreementId, version }: { agreementId: string; version: number }) {
  const { companyId } = useCompany();
  const ready = useQuery(api.googleDrive.docExportReady, { companyId });
  const exports = useQuery(api.googleDrive.exportsFor, { companyId, agreementId });
  const save = useMutation(api.googleDrive.exportAgreement);
  const { busy, error, run } = useRun();
  if (!ready?.connected) return null;
  if (!ready.folder) return <span className="self-center text-xs text-muted-foreground">To save Google Docs, the Owner chooses a Drive folder for agreements under Integrations › Google Drive.</span>;
  const mine = exports?.find((row) => row.version === version) ?? null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {mine?.status === "done" && mine.link ? (
        <a href={mine.link} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-strong hover:bg-muted">
          Open in Google Docs
        </a>
      ) : (
        <Button size="sm" variant="secondary" loading={busy || mine?.status === "queued" || mine?.status === "running"} onClick={() => void run(() => save({ companyId, agreementId, version }))} title={`A copy of version ${version} for reading, saved in “${ready.folder}”. It never signs or changes the agreement.`}>
          {mine && (mine.status === "failed" || mine.status === "cancelled") ? "Try saving as a Google Doc again" : "Save as a Google Doc"}
        </Button>
      )}
      {mine && mine.status !== "done" ? <span className="text-xs text-muted-foreground">{STATUS_WORDS[mine.status] ?? mine.status}{mine.error && (mine.status === "failed" || mine.status === "cancelled") ? `: ${mine.error}` : ""}</span> : null}
      <FormError message={error} />
    </span>
  );
}
