"use client";

import { useMutation } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, FormError, TextArea, useRun } from "@/components/app/form";
import { Modal } from "@/components/app/modal";
import { Notice } from "@/components/app/services/shared";
import { buttonVariants } from "@/components/ui/button-variants";
import { Select } from "@/components/ui/selection";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

const EMAIL = /[^\s<>,;"]+@[^\s<>,;"]+\.[^\s<>,;"]+/;

/** "Maria Lopez <maria@example.com>", "maria@example.com" or "Maria Lopez, maria@example.com", one per line. */
export function parseRecipients(text: string): { email: string; name?: string }[] {
  const out: { email: string; name?: string }[] = [];
  for (const line of text.split(/\n|;/)) {
    const match = line.match(EMAIL);
    if (!match) continue;
    const email = match[0].replace(/^<|>$/g, "").toLowerCase();
    const name = line.replace(match[0], "").replace(/[<>,"]/g, " ").replace(/\s+/g, " ").trim();
    out.push(name ? { email, name: name.slice(0, 80) } : { email });
  }
  return out;
}

const OUTCOME = { sent: "Sent", skipped: "Skipped", failed: "Not sent" } as const;

/**
 * Sends a role's application to people by email, each with their own private link. Choosing Send is the
 * approval; the usual sending checks still apply, and anyone already applying for the role is skipped.
 */
export function SendApplicationDialog({ open, onClose, roles, roleId }: { open: boolean; onClose: () => void; roles: { id: Id<"hiringNeeds">; title: string }[]; roleId?: Id<"hiringNeeds"> }) {
  const { companyId } = useCompany();
  const send = useMutation(api.applications.sendApplication);
  const { busy, error, run } = useRun();
  const [needId, setNeedId] = useState<string>(roleId ?? roles[0]?.id ?? "");
  const [text, setText] = useState("");
  const [results, setResults] = useState<{ email: string; outcome: keyof typeof OUTCOME; detail: string }[] | null>(null);
  const recipients = parseRecipients(text);
  const close = () => {
    setResults(null);
    setText("");
    onClose();
  };
  return (
    <Modal open={open} onClose={close} title="Send the application" description="Each person gets an email with their own private link to the role's application form. Their answers save as they go.">
      <div className="space-y-4">
        {roles.length === 0 ? (
          <Notice tone="warning" title="No open role">Open a role in Hiring setup first. The application is sent for a role.</Notice>
        ) : results ? (
          <>
            <Notice tone={results.every((row) => row.outcome === "sent") ? "success" : "info"} title={`${results.filter((row) => row.outcome === "sent").length} of ${results.length} sent`}>
              Everyone sent the link now shows in Applicants.
            </Notice>
            <ul className="max-h-64 space-y-1.5 overflow-y-auto text-sm" data-testid="send-results">
              {results.map((row) => (
                <li key={row.email} className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2">
                  <span className="min-w-0 truncate text-strong">{row.email}</span>
                  <span className={cn("shrink-0 text-right text-xs", row.outcome === "sent" ? "text-success-foreground" : "text-muted-foreground")}>
                    {OUTCOME[row.outcome]}
                    {row.outcome !== "sent" ? <span className="block max-w-[14rem]">{row.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setResults(null)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Send to more people
              </button>
              <button type="button" onClick={close} className={buttonVariants({ variant: "primary", size: "sm" })}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <Field label="Role">
              <Select value={needId} options={roles.map((role) => ({ value: role.id, label: role.title }))} onValueChange={(next) => setNeedId(next ?? "")} />
            </Field>
            <Field label="Who to send it to" hint="One person per line: an email address, or a name and an email address. Up to 50 at a time.">
              <TextArea rows={6} value={text} placeholder={"Maria Lopez <maria@example.com>\njames@example.com"} onChange={(event) => setText(event.target.value)} data-testid="send-recipients" />
            </Field>
            <p className="text-xs text-muted-foreground">
              {recipients.length === 0 ? "No email addresses yet." : `${recipients.length} ${recipients.length === 1 ? "person" : "people"}.`} The email uses this role&apos;s form&apos;s invitation wording and goes out within your sending hours.
            </p>
            <FormError message={error} />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={close} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !needId || recipients.length === 0 || recipients.length > 50}
                onClick={() => void run(async () => setResults(await send({ companyId, needId: needId as Id<"hiringNeeds">, recipients })))}
                className={buttonVariants({ variant: "primary", size: "sm" })}
                data-testid="send-application"
              >
                {busy ? "Sending…" : `Send to ${recipients.length || ""} ${recipients.length === 1 ? "person" : "people"}`.replace("  ", " ")}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
