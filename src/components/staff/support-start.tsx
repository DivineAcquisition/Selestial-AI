"use client";

import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Field, FormError, SelectInput, TextArea, TextInput, useRun } from "@/components/app/form";
import { ShieldCheck } from "@/components/icons";
import { storeSession } from "@/components/support/client";
import { Button } from "@/components/ui/button";
import { useNow } from "@/components/app/use-now";
import { ago } from "@/components/staff/operations";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

/**
 * "Open company workspace": what the admin sees before entering, and the start itself. The session opens
 * in a new tab that holds it (sessionStorage), so the staff console and other tabs keep their context.
 */
export function StartSupport({ companyId, companyName, incidentId, onDone }: { companyId: Id<"companies">; companyName: string; incidentId?: Id<"incidents">; onDone?: () => void }) {
  const me = useQuery(api.staff.me, {});
  const begin = useMutation(api.support.start);
  const router = useRouter();
  const { busy, error, run } = useRun();
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [minutes, setMinutes] = useState("30");
  const canManage = me?.capabilities.includes("workspace.manage") ?? false;
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const sessionId = await begin({ companyId, reason, ...(reference.trim() ? { reference } : {}), ...(incidentId ? { incidentId } : {}), minutes: Number(minutes) });
          // The new tab reads the session from its own address once, then keeps it in its own storage.
          const tab = window.open(`/app?support=${sessionId}`, "_blank", "noopener");
          if (!tab) {
            // Pop-ups blocked: this tab becomes the support tab instead.
            storeSession(sessionId);
            router.push("/app");
          }
          onDone?.();
        });
      }}
    >
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
        <div className="text-sm">
          <p className="font-semibold text-strong">Open {companyName}&apos;s workspace</p>
          <p className="text-xs text-muted-foreground">
            Starts in <strong>View</strong>: you see what the owner sees and nothing can be changed. {canManage ? "You can switch to Manage inside, with a reason and a fresh two-step sign-in; the owner is emailed." : "Your role can't switch to Manage."} The owner sees every session under Settings › Support access.
          </p>
        </div>
      </div>
      <Field label="Reason for access" hint="Shown to the owner, word for word.">
        <TextArea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} required minLength={10} maxLength={300} placeholder="Owner reported their hiring inbox stopped syncing" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Ticket or incident (optional)">
          <TextInput value={reference} onChange={(event) => setReference(event.target.value)} placeholder={incidentId ? "Linked to this incident" : "INC-…, ticket number"} maxLength={80} />
        </Field>
        <Field label="Session length">
          <SelectInput value={minutes} onChange={(event) => setMinutes(event.target.value)}>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
            <option value="120">2 hours (longest)</option>
          </SelectInput>
        </Field>
      </div>
      <FormError message={error} />
      <div>
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={reason.trim().length < 10}>
          Open in a new tab (View)
        </Button>
      </div>
    </form>
  );
}

/** The company directory for staff: find a company and open its workspace, or see its operational state. */
export function SupportDirectory() {
  const [search, setSearch] = useState("");
  const rows = useQuery(api.support.companies, { search });
  const [opening, setOpening] = useState<string | null>(null);
  const now = useNow();
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div>
          <h2 className="text-sm font-semibold text-strong">Open a company workspace</h2>
          <p className="text-xs text-muted-foreground">Time-bound, recorded, and disclosed to the owner. Being staff alone opens nothing.</p>
        </div>
        <TextInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search companies" className="max-w-xs" aria-label="Search companies" />
      </header>
      {rows === undefined ? (
        <p className="px-3 py-6 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">No companies match.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-strong">{row.name}</span>
                <span className="text-xs text-muted-foreground">
                  {row.openIncidents ? `${row.openIncidents} open incident${row.openIncidents === 1 ? "" : "s"}${row.worst ? ` (worst: ${row.worst})` : ""}` : "No open incidents"}
                  {row.outboundStopped ? " · outbound stopped" : ""}
                  {row.suspended ? " · suspended" : ""}
                  {row.pausedAgents.length ? ` · paused: ${row.pausedAgents.join(", ")}` : ""}
                  {" · joined "}
                  {now ? ago(row.createdAt, now) : ""}
                </span>
                <Button size="xs" variant="outline" onClick={() => setOpening(opening === row.id ? null : row.id)}>
                  Open company workspace
                </Button>
              </div>
              {opening === row.id ? (
                <div className="mt-2 rounded-lg border border-border p-3">
                  <StartSupport companyId={row.id} companyName={row.name} onDone={() => setOpening(null)} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The directory, for staff who may open workspaces; nothing for anyone else. */
export function SupportDirectoryIfAllowed() {
  const me = useQuery(api.staff.me, {});
  if (!me?.capabilities.includes("workspace.view")) return null;
  return <SupportDirectory />;
}
