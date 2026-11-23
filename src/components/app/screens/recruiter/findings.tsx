"use client";

/**
 * What Recruiter found and prepared, as cards: who, what was reported, what is missing, the next step,
 * and the message itself beside its Send button. Sending is the person's own choice, made here; there is
 * no second approval screen. Every state shown comes from the records: "Sent" means the email service took
 * it, and "Delivered" appears only when the service reported delivery.
 */
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, TextArea, TextInput, useRun } from "@/components/app/form";
import { useNow } from "@/components/app/use-now";
import { CheckCircle2, Clock, ExternalLink, Eye, Hand, Loader2, Mail, PenLine, SendIcon, Sparkles, TriangleAlert, X } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { whenLabel } from "@/lib/app/format";
import { cn } from "@/lib/utils";

import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";

export type FindingView = FunctionReturnType<typeof api.recruiterFindings.list>["open"][number];

/** The button that sends each kind of prepared message, in the owner's words. */
export const SEND_LABEL: Record<NonNullable<FindingView["prepared"]>["kind"], string> = {
  application_link: "Send application link",
  inquiry_reply: "Send reply",
  reminder: "Send reminder",
  pay_reply: "Send pay answer",
  question_reply: "Send reply",
  interview_times: "Offer interview times",
  interview_reminder: "Send interview reminder",
};

const PURPOSE: Record<NonNullable<FindingView["prepared"]>["kind"], string> = {
  application_link: "Application link",
  inquiry_reply: "Reply about open roles",
  reminder: "Reminder to finish the application",
  pay_reply: "Answer about pay",
  question_reply: "Reply to their question",
  interview_times: "Interview times to choose from",
  interview_reminder: "Interview reminder",
};

/** The state of a finding as one readable badge. */
export function FindingState({ finding }: { finding: Pick<FindingView, "status" | "scheduledFor" | "delivery" | "automatic"> }) {
  const now = useNow();
  const { timezone } = useCompany();
  switch (finding.status) {
    case "ready":
      return (
        <Badge variant="info" size="sm">
          <SendIcon aria-hidden /> Ready to send
        </Badge>
      );
    case "scheduled":
      return (
        <Badge variant="outline" size="sm">
          <Clock aria-hidden /> {finding.scheduledFor ? `Scheduled · ${whenLabel(finding.scheduledFor, now, timezone)}` : "Scheduled"}
        </Badge>
      );
    case "sending":
      return (
        <Badge variant="outline" size="sm">
          <Loader2 className="animate-spin" aria-hidden /> Sending
        </Badge>
      );
    case "sent":
      return (
        <Badge variant="success" size="sm">
          <CheckCircle2 aria-hidden /> {finding.delivery?.status === "delivered" ? "Delivered" : "Sent · delivery not confirmed"}
          {finding.automatic ? " · automatic" : ""}
        </Badge>
      );
    case "needs_attention":
      return (
        <Badge variant="warning" size="sm">
          <Hand aria-hidden /> Needs you
        </Badge>
      );
    case "dismissed":
      return (
        <Badge variant="outline" size="sm">
          Dismissed
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" size="sm">
          Done
        </Badge>
      );
  }
}

/** One finding: what Recruiter found, what it suggests, and the prepared message with its actions. */
export function FindingCard({ finding, compact = false }: { finding: FindingView; compact?: boolean }) {
  const { companyId, role, timezone } = useCompany();
  const now = useNow();
  const send = useMutation(api.recruiterFindings.send);
  const saveDraft = useMutation(api.recruiterFindings.saveDraft);
  const dismiss = useMutation(api.recruiterFindings.dismiss);
  const draft = useMutation(api.recruiterDrafts.request);
  const { busy, error, run } = useRun();
  const [editing, setEditing] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const prepared = finding.prepared;
  const [subject, setSubject] = useState(prepared?.subject ?? "");
  const [body, setBody] = useState(prepared?.body ?? "");
  const [result, setResult] = useState<string | null>(null);
  const canAct = role !== "office" && (finding.status === "ready" || finding.status === "needs_attention" || finding.status === "scheduled");
  const writable = prepared?.kind === "question_reply";
  const needsWords = writable && !prepared?.body.trim();
  const open = finding.status === "ready" || finding.status === "needs_attention" || finding.status === "scheduled";
  const title = `${finding.headline}`;

  const doSend = (edit?: { subject: string; body: string }) =>
    run(async () => {
      const answer = await send({ companyId, findingId: finding.findingId, edit });
      setResult(answer.ok ? null : answer.detail);
      if (answer.ok) setEditing(false);
    });

  return (
    <article className={cn("rounded-2xl border bg-background p-4", finding.status === "needs_attention" ? "border-warning/40" : finding.status === "ready" ? "border-brand-500/30" : "border-border")} aria-label={title}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-strong">{finding.headline}</h3>
          <p className="text-xs text-muted-foreground">
            {[finding.source, whenLabel(finding.discoveredAt, now, timezone)].filter(Boolean).join(" · ")}
          </p>
        </div>
        <FindingState finding={finding} />
      </header>

      {!compact ? (
        <div className="mt-2 grid gap-1 text-sm leading-relaxed">
          {finding.reported.map((line) => (
            <p key={line} className="text-strong">
              {line}
            </p>
          ))}
          <p className="text-muted-foreground">{finding.explanation}</p>
          {finding.missing.length && open ? <p className="text-xs text-muted-foreground">Not provided yet: {finding.missing.join(", ").toLowerCase()}.</p> : null}
        </div>
      ) : null}

      {open ? (
        <p className="mt-2 text-sm">
          <span className="font-medium text-strong">Next step:</span> <span className="text-strong">{finding.next}</span>
        </p>
      ) : finding.outcome ? (
        <p className="mt-2 text-sm text-muted-foreground">{finding.outcome}</p>
      ) : null}

      {prepared && open ? (
        <div className="mt-3 rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
            <Mail className="size-3.5" aria-hidden />
            <span>
              To <span className="font-medium text-strong">{prepared.to ?? "nobody yet"}</span>
              {prepared.toKind === "relay" ? " (job board forwarding)" : prepared.toKind === "direct" ? " (their own address)" : ""}
            </span>
            <span>· Email · {PURPOSE[prepared.kind]}</span>
            {prepared.writtenBy === "assistant" ? <span>· drafted by AI from approved information</span> : prepared.writtenBy === "person" ? <span>· your words</span> : null}
          </p>
          {prepared.limitation ? <p className="mt-1 text-warning-foreground">{prepared.limitation}</p> : null}
          {editing ? (
            <div className="mt-2 grid gap-2">
              <TextInput aria-label="Subject" value={subject} onChange={(event) => setSubject(event.target.value)} />
              <TextArea aria-label="Message" rows={8} value={body} onChange={(event) => setBody(event.target.value)} />
              {prepared.link ? <p className="text-muted-foreground">Keep {"{link}"} where the {prepared.link === "apply" ? "application" : "interview"} link goes; it is added at the end if removed.</p> : null}
            </div>
          ) : !needsWords ? (
            <>
              <p className="mt-1 font-medium text-strong">{prepared.subject}</p>
              <button type="button" className="mt-1 text-left text-muted-foreground hover:text-strong" aria-expanded={showMessage} onClick={() => setShowMessage(!showMessage)}>
                <span className={cn("block whitespace-pre-line", !showMessage && "line-clamp-3")}>{prepared.preview}</span>
                <span className="mt-0.5 inline-block font-medium text-brand-300">{showMessage ? "Show less" : "Show the whole message"}</span>
              </button>
            </>
          ) : (
            <p className="mt-1 text-muted-foreground">{finding.prepared?.reason ?? ""} Write the reply, or have Recruiter draft one.</p>
          )}
        </div>
      ) : null}

      {canAct && open ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {prepared && !needsWords && finding.status === "ready" && !editing ? (
            <Button size="sm" variant="primary" loading={busy} disabled={!prepared.to} onClick={() => void doSend()}>
              {SEND_LABEL[prepared.kind]}
            </Button>
          ) : null}
          {editing ? (
            <>
              <Button size="sm" variant="primary" loading={busy} disabled={!body.trim() || !prepared?.to} onClick={() => void doSend({ subject, body })}>
                Send as written
              </Button>
              <Button size="sm" variant="outline" loading={busy} onClick={() => void run(async () => (await saveDraft({ companyId, findingId: finding.findingId, subject, body }), setEditing(false)))}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </>
          ) : prepared ? (
            <Button size="sm" variant="outline" onClick={() => (setSubject(prepared.subject), setBody(prepared.body), setEditing(true))}>
              <PenLine aria-hidden /> {needsWords ? "Write reply" : "Edit message"}
            </Button>
          ) : null}
          {writable && !editing ? (
            <Button size="sm" variant="outline" loading={busy} onClick={() => void run(() => draft({ companyId, findingId: finding.findingId }))}>
              <Sparkles aria-hidden /> {needsWords ? "Draft a reply" : "Draft again"}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" render={<Link href={`/app/agents/recruiter/applicants?open=${finding.applicationId}`} />}>
            <Eye aria-hidden /> View source
          </Button>
          {!editing ? (
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void run(() => dismiss({ companyId, findingId: finding.findingId }))}>
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
      {writable && open ? <DraftNote finding={finding} /> : null}
      {result ? (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-warning-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {result}
        </p>
      ) : null}
      <FormError message={error} />
    </article>
  );
}

/** What happened to an AI draft request, when one is on the record. */
function DraftNote({ finding }: { finding: FindingView }) {
  const status = finding;
  if (!status.draft) return <p className="mt-2 text-xs text-muted-foreground">A drafted reply uses 1 Selestial Credit, only when it can be written from the role&apos;s details and your Hiring FAQ.</p>;
  if (status.draft.state === "drafting")
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Drafting from your approved information…
      </p>
    );
  return <p className="mt-2 text-xs text-warning-foreground">{status.draft.why ?? "No draft was written."}</p>;
}

/**
 * Sending several ready messages at once: the list of who gets what is shown first, and each one is
 * checked again when it goes, so one that changed is skipped and the rest still go.
 */
export function BulkSend({ ready }: { ready: FindingView[] }) {
  const { companyId, role } = useCompany();
  const sendMany = useMutation(api.recruiterFindings.sendMany);
  const { busy, error, run } = useRun();
  const [reviewing, setReviewing] = useState(false);
  const [results, setResults] = useState<{ ok: boolean; detail: string; findingId: Id<"recruiterFindings"> }[] | null>(null);
  const sendable = ready.filter((row) => row.prepared?.to && row.prepared.body.trim());
  if (role === "office" || sendable.length < 2) return null;
  if (!reviewing)
    return (
      <Button size="sm" variant="outline" onClick={() => (setResults(null), setReviewing(true))}>
        Review and send all ({sendable.length})
      </Button>
    );
  return (
    <div className="grid w-full gap-3 rounded-2xl border border-brand-500/30 bg-brand-500/5 p-4" role="region" aria-label="Send several messages">
      <p className="text-sm font-medium text-strong">These {sendable.length} messages will go, each checked again as it goes:</p>
      <ul className="grid gap-1.5 text-sm">
        {sendable.map((row) => {
          const answer = results?.find((entry) => entry.findingId === row.findingId);
          return (
            <li key={row.findingId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-background px-3 py-2">
              <span className="min-w-0">
                <span className="font-medium text-strong">{row.name ?? "Applicant"}</span> <span className="text-muted-foreground">· {row.prepared!.to} · {PURPOSE[row.prepared!.kind]}</span>
              </span>
              {answer ? <Badge variant={answer.ok ? "success" : "warning"} size="sm">{answer.ok ? "Sent" : answer.detail}</Badge> : null}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        {results ? (
          <Button size="sm" variant="outline" onClick={() => setReviewing(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void run(async () => setResults(await sendMany({ companyId, findingIds: sendable.map((row) => row.findingId) })))}>
              Send {sendable.length} messages
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setReviewing(false)}>
              Cancel
            </Button>
          </>
        )}
      </div>
      <FormError message={error} />
    </div>
  );
}

/**
 * Mail that might be about hiring and was not opened: its sender and subject only, kept 14 days. A person
 * includes it, ignores it, or opens it in Gmail.
 */
export function PossiblyHiring() {
  const { companyId, role } = useCompany();
  const now = useNow();
  const { timezone } = useCompany();
  const rows = useQuery(api.recruiterPossible.list, role === "office" ? "skip" : { companyId });
  const include = useMutation(api.recruiterPossible.include);
  const ignore = useMutation(api.recruiterPossible.ignore);
  const { busy, error, run } = useRun();
  if (!rows || rows.length === 0) return null;
  return (
    <section aria-labelledby="possibly-hiring" className="rounded-2xl border border-dashed border-border bg-card p-4">
      <h2 id="possibly-hiring" className="text-sm font-semibold text-strong">
        Possibly hiring-related · {rows.length}
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">Recruiter wasn&apos;t sure about these and didn&apos;t open them. Only the sender and subject are kept, for 14 days.</p>
      <ul className="mt-3 grid gap-2">
        {rows.map((row) => (
          <li key={row.sourceMessageId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-background px-3 py-2 text-sm">
            <span className="min-w-0">
              <span className="block truncate font-medium text-strong">{row.subject ?? "(no subject)"}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {row.from ?? "Unknown sender"} · {whenLabel(row.receivedAt, now, timezone)}
              </span>
            </span>
            <span className="flex gap-1.5">
              <Button size="xs" variant="outline" loading={busy} onClick={() => void run(() => include({ companyId, sourceMessageId: row.sourceMessageId }))}>
                Include in recruiting
              </Button>
              <Button size="xs" variant="ghost" loading={busy} onClick={() => void run(() => ignore({ companyId, sourceMessageId: row.sourceMessageId }))}>
                <X aria-hidden /> Ignore
              </Button>
              {row.openUrl ? (
                <Button size="xs" variant="ghost" render={<a href={row.openUrl} target="_blank" rel="noreferrer" />}>
                  <ExternalLink aria-hidden /> Open in Gmail
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <FormError message={error} />
    </section>
  );
}
