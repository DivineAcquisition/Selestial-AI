"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { AgentAvatar } from "@/components/app/agent";
import { useCompany } from "@/components/app/company";
import { useDetail } from "@/components/app/detail-panel";
import { FormError, useRun } from "@/components/app/form";
import { PageHeader, Panel } from "@/components/app/shell";
import { useNow } from "@/components/app/use-now";
import { Loader2, PauseCircleIcon, Play, TriangleAlert } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { until, whenLabel } from "@/lib/app/format";
import { cn } from "@/lib/utils";

import { api } from "../../../../../convex/_generated/api";
import { BulkSend, FindingCard, FindingState, PossiblyHiring, type FindingView } from "./findings";
import { PipelineFlow, STAGE_WORDS, STEPS, stepOf, WhoActs, type ApplicationRow } from "./shared";

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (n: number, capital = false) => {
  const word = n <= 10 ? WORDS[n] : String(n);
  return capital ? word.charAt(0).toUpperCase() + word.slice(1) : word;
};

/** What each kind of open finding means, as part of a sentence about one or more people. */
const PHRASE: Partial<Record<FindingView["kind"], [string, string]>> = {
  new_application: ["is ready for an application link", "are ready for an application link"],
  employment_inquiry: ["asked about work", "asked about work"],
  availability_given: ["replied with availability", "replied with availability"],
  pay_question: ["asked about pay", "asked about pay"],
  applicant_question: ["asked a question", "asked questions"],
  contact_needed: ["needs a contact method", "need a contact method"],
  delivery_failed: ["had an email that didn't go through", "had emails that didn't go through"],
  incomplete_application: ["is due a reminder", "are due a reminder"],
  follow_up_ended: ["hasn't finished after the last reminder", "haven't finished after the last reminder"],
  decision_needed: ["finished the application and waits for your decision", "finished the application and wait for your decision"],
  role_needed: ["applied for a role Recruiter couldn't match", "applied for roles Recruiter couldn't match"],
  role_not_open: ["applied for a role that isn't open", "applied for roles that aren't open"],
  interview_soon: ["has an interview coming up", "have interviews coming up"],
};

/**
 * The brief at the top, built only from the findings on record. "Recruiter found 6 new applicants. Four are
 * ready for an application link, one replied with availability, and one needs a contact method."
 */
export function briefFrom(open: FindingView[]): string {
  if (open.length === 0) return "Nothing is waiting. Recruiter files new applications and replies from the hiring inbox as they arrive.";
  const fresh = open.filter((row) => row.kind === "new_application" || row.kind === "employment_inquiry" || row.kind === "contact_needed" || row.kind === "role_needed");
  const groups = new Map<FindingView["kind"], number>();
  for (const row of open) if (PHRASE[row.kind]) groups.set(row.kind, (groups.get(row.kind) ?? 0) + 1);
  const parts = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${count(n)} ${PHRASE[kind]![n === 1 ? 0 : 1]}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}` : parts[0];
  const lead = fresh.length ? `Recruiter found ${count(fresh.length)} new ${fresh.length === 1 ? "applicant" : "applicants"}.` : `Recruiter is following ${count(open.length)} ${open.length === 1 ? "applicant" : "applicants"}.`;
  return `${lead} ${list.charAt(0).toUpperCase()}${list.slice(1)}.`;
}

/**
 * Recruiter's overview: a brief from the records, what it found, what it has ready to send, what is
 * scheduled, what has happened, and a compact pipeline. Each applicant appears once among the open work.
 */
export function RecruiterOverviewScreen() {
  const { companyId, timezone, role } = useCompany();
  const now = useNow();
  const router = useRouter();
  const open = useDetail();
  const overview = useQuery(api.recruiter.overview, { companyId });
  const applications = useQuery(api.applications.list, { companyId });
  const findings = useQuery(api.recruiterFindings.list, { companyId, outcomesSince: now ? now - 7 * 86_400_000 : 0 });
  const runs = useQuery(api.recruiter.inboxRuns, role === "office" ? "skip" : { companyId });
  const requests = useQuery(api.recruiter.staffingRequests, { companyId });
  const pauseAgent = useMutation(api.companies.pauseAgent);
  const resumeAgent = useMutation(api.companies.resumeAgent);
  const { busy, error, run } = useRun();

  const header = (
    <PageHeader
      title="Recruiter"
      lead="Finds hiring conversations, explains them, prepares the next message, and tracks what happened."
      actions={
        role === "owner" && overview ? (
          <Button variant="outline" size="sm" loading={busy} onClick={() => void run(() => (overview.paused ? resumeAgent : pauseAgent)({ companyId, agent: "recruiter" }))}>
            {overview.paused ? <Play aria-hidden /> : <PauseCircleIcon aria-hidden />}
            {overview.paused ? "Resume Recruiter" : "Pause Recruiter"}
          </Button>
        ) : null
      }
    />
  );
  if (!overview || !applications || !findings) {
    return (
      <>
        {header}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      </>
    );
  }

  const attention = findings.open.filter((row) => row.status === "needs_attention");
  const ready = findings.open.filter((row) => row.status === "ready");
  const scheduled = findings.open.filter((row) => row.status === "scheduled");
  const live = applications.filter((row) => !row.closure && row.stage !== "closed" && row.stage !== "withdrawn");
  const counts = STEPS.map((_, index) => live.filter((row) => stepOf(row.stage) === index).length);
  const latest = runs?.flatMap((inbox) => inbox.runs.map((entry) => ({ ...entry, address: inbox.address }))).sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  const reading = latest !== null && latest.finishedAt === null && now - latest.startedAt < 5 * 60_000;
  const broken = runs?.find((inbox) => inbox.status === "expired" || inbox.status === "error") ?? null;

  return (
    <>
      {header}
      <FormError message={error} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <Panel>
          <div className="flex items-start gap-3">
            <AgentAvatar agent="recruiter" size="md" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={overview.paused ? "warning" : "success"} size="sm">
                  {overview.paused ? "Paused" : "On"}
                </Badge>
                {/* Only real runs: a spinner shows only while a read is actually in progress. */}
                {reading ? (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin text-brand-300" aria-hidden /> <span className="agent-shimmer font-medium text-strong">Reading {latest!.address}</span>
                  </span>
                ) : latest ? (
                  <span className="text-muted-foreground">
                    Last read {whenLabel(latest.startedAt, now, timezone)}
                    {latest.outcome === "failed" ? " · didn't finish" : latest.filed ? ` · ${latest.filed} new ${latest.filed === 1 ? "email" : "emails"} looked at` : " · nothing new"}
                  </span>
                ) : overview.inboxConnected ? (
                  <span className="text-muted-foreground">Waiting for the first read of the hiring inbox</span>
                ) : null}
              </div>
              <p className="mt-3 text-base leading-relaxed text-strong">{overview.paused ? "Recruiter is paused: it reads no mail and sends nothing by itself. You can still send what is prepared." : briefFrom(findings.open)}</p>
              {!overview.inboxConnected || broken ? (
                <p className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-strong">
                  <TriangleAlert className="size-4 text-warning-foreground" aria-hidden />
                  {broken ? `${broken.address} can't be read right now. ${broken.problem ?? ""}` : "No hiring inbox is connected, so Recruiter can't see new applications."}
                  <Button size="xs" variant="outline" render={<Link href="/app/agents/recruiter/hiring-setup#inbox" />}>
                    {broken ? "Fix it in Hiring setup" : "Connect one in Hiring setup"}
                  </Button>
                </p>
              ) : null}
            </div>
          </div>
        </Panel>

        <section aria-labelledby="findings-new" className="grid min-w-0 gap-3">
          <SectionTitle id="findings-new" title="New findings" count={attention.length} hint="Things Recruiter found that need you to decide or do something." />
          {attention.length === 0 ? <Empty text="Nothing needs you right now." /> : <Cards rows={attention} />}
        </section>

        <section aria-labelledby="findings-ready" className="grid min-w-0 gap-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <SectionTitle id="findings-ready" title="Ready to send" count={ready.length} hint="Prepared messages. Each shows who gets it and what it says; Send is your go-ahead." />
            <BulkSend ready={ready} />
          </div>
          {ready.length === 0 ? <Empty text="No messages are waiting to be sent." /> : <Cards rows={ready} />}
        </section>

        <PossiblyHiring />

        <div className="grid items-start gap-5 xl:grid-cols-2">
          <Panel title={`Scheduled follow-ups · ${scheduled.length}`}>
            {scheduled.length === 0 ? (
              <p className="text-sm text-muted-foreground">No reminders or interview reminders are scheduled.</p>
            ) : (
              <ul className="grid gap-2">
                {scheduled.map((row) => (
                  <CompactRow key={row.findingId} row={row} />
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Recent outcomes" action={<span className="text-xs text-muted-foreground">Last 7 days</span>}>
            {findings.outcomes.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing has been sent or dismissed this week.</p>
            ) : (
              <ul className="grid gap-2">
                {findings.outcomes.slice(0, 12).map((row) => (
                  <CompactRow key={row.findingId} row={row} showOutcome />
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <Panel title="Hiring pipeline" action={<Link href="/app/agents/recruiter/applicants" className="text-xs font-medium text-brand-300 hover:underline">All applicants</Link>}>
          <PipelineFlow counts={counts} onSelect={(index) => router.push(`/app/agents/recruiter/applicants?step=${index}`)} />
        </Panel>

        {requests && requests.length > 0 ? (
          <Panel title="Staffing requests from Dispatch">
            <ul className="grid gap-2">
              {requests.map((row) => {
                const due = until(row.dueAt, now);
                return (
                  <li key={row.taskId}>
                    <button type="button" onClick={() => open({ kind: "task", id: row.taskId })} className="grid w-full gap-0.5 rounded-xl border border-border bg-background px-3 py-2.5 text-left text-sm hover:border-brand-500/50 focus-visible:outline-2 focus-visible:outline-brand-500">
                      <span className="font-medium text-strong">
                        {row.title} {row.kind === "urgent_hire" ? <Badge variant="error" size="sm">Urgent</Badge> : null}
                      </span>
                      {row.what ? <span className="text-xs text-muted-foreground">{row.what}</span> : null}
                      <span className={cn("text-xs", due.late ? "font-medium text-destructive-foreground" : "text-muted-foreground")}>Due {whenLabel(row.dueAt, now, timezone)} · {due.text}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Panel>
        ) : null}
      </div>
    </>
  );
}

function SectionTitle({ id, title, count: n, hint }: { id: string; title: string; count: number; hint: string }) {
  return (
    <div>
      <h2 id={id} className="font-heading text-lg tracking-tight text-strong">
        {title} <span className="text-sm font-normal text-muted-foreground tabular-nums">· {n}</span>
      </h2>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{text}</p>;
}

function Cards({ rows }: { rows: FindingView[] }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
      {rows.map((row) => (
        <FindingCard key={row.findingId} finding={row} />
      ))}
    </div>
  );
}

function CompactRow({ row, showOutcome = false }: { row: FindingView; showOutcome?: boolean }) {
  return (
    <li>
      <Link href={`/app/agents/recruiter/applicants?open=${row.applicationId}`} className="grid gap-0.5 rounded-xl border border-border bg-background px-3 py-2 text-sm hover:border-brand-500/50 focus-visible:outline-2 focus-visible:outline-brand-500">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-strong">{row.headline}</span>
          <FindingState finding={row} />
        </span>
        {showOutcome && row.outcome ? <span className="text-xs text-muted-foreground">{row.outcome}</span> : <span className="text-xs text-muted-foreground">{row.next}</span>}
      </Link>
    </li>
  );
}

/** A plain list of applicants, for screens that show people rather than findings. */
export function PeopleList({ rows, now }: { rows: ApplicationRow[]; now: number; timezone?: string }) {
  return (
    <ul className="grid gap-2">
      {rows.map((row) => (
        <li key={row.applicationId}>
          <Link href={`/app/agents/recruiter/applicants?open=${row.applicationId}`} className="grid gap-0.5 rounded-xl border border-border bg-background px-3 py-2.5 text-sm hover:border-brand-500/50 focus-visible:outline-2 focus-visible:outline-brand-500">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-strong">{row.detailsRemoved ? "Details removed" : (row.name ?? "Name not known")}</span>
              <WhoActs row={row} />
            </span>
            <span className="text-xs text-muted-foreground">
              {row.role ?? row.roleSeen ?? "No role yet"} · {STAGE_WORDS[row.stage]}
            </span>
            {row.nextAction ? (
              <span className="text-xs text-muted-foreground">
                Next: {row.nextAction.what}
                {row.nextAction.dueAt ? ` · ${until(row.nextAction.dueAt, now).text}` : ""}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}
