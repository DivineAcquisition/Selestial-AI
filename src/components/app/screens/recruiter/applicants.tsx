"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, TextInput, useRun } from "@/components/app/form";
import { Select } from "@/components/ui/selection";
import { PageHeader, Panel } from "@/components/app/shell";
import { useNow } from "@/components/app/use-now";
import { Mail, MessageSquareText, Paperclip, X } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { until, whenLabel } from "@/lib/app/format";
import { cn } from "@/lib/utils";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { FindingCard } from "./findings";
import { OffersScreen } from "./offers";
import { OnboardingScreen } from "./onboarding";
import { ScreeningScreen } from "./screening";
import { CLOSURE_WORDS, CriteriaList, EvidenceTrace, JourneyTimeline, PipelineFlow, RECOMMENDATION, SOURCE_WORDS, STAGE_WORDS, STEPS, stepOf, WhoActs, type ApplicationDetail, type ApplicationRow, type TraceStep } from "./shared";
import { EmailInput } from "@/components/ui/fields";

const VIEWS = [
  { id: "all", label: "Everyone" },
  { id: "decisions", label: "Needs a decision" },
  { id: "offers", label: "Offers" },
  { id: "onboarding", label: "Onboarding" },
] as const;
type View = (typeof VIEWS)[number]["id"];

const WHO: { value: string; label: string }[] = [
  { value: "you", label: "Needs you" },
  { value: "recruiter", label: "Recruiter is on it" },
  { value: "applicant", label: "Waiting on applicant" },
];

function whoActs(row: ApplicationRow): "you" | "recruiter" | "applicant" {
  if (row.withPerson || row.nextAction?.by === "owner") return "you";
  if (row.waitingOnReply || row.nextAction?.by === "applicant") return "applicant";
  return "recruiter";
}

/**
 * Applicants: everyone Recruiter is working with, searchable and filtered by stage, role, source and who
 * acts next, with one opened beside the list. Decisions, offers and onboarding are views of the same people.
 */
export function ApplicantsScreen() {
  const { companyId, timezone } = useCompany();
  const now = useNow();
  const params = useSearchParams();
  const router = useRouter();
  const rows = useQuery(api.applications.list, { companyId });
  const initialStep = params.get("step");
  const [step, setStep] = useState<number | null>(initialStep !== null && Number.isInteger(Number(initialStep)) ? Number(initialStep) : null);
  const [search, setSearch] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [roleFilter, setRoleFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [whoFilter, setWhoFilter] = useState("");
  const openId = params.get("open") as Id<"applications"> | null;
  const view: View = (VIEWS.find((entry) => entry.id === params.get("view"))?.id ?? "all") as View;
  const setOpen = (id: Id<"applications"> | null) => router.replace(id ? `/app/agents/recruiter/applicants?open=${id}` : "/app/agents/recruiter/applicants", { scroll: false });
  const setView = (next: View) => router.replace(next === "all" ? "/app/agents/recruiter/applicants" : `/app/agents/recruiter/applicants?view=${next}`, { scroll: false });
  const lead = "Everyone Recruiter is working with, from the first email to onboarding.";

  if (!rows) {
    return (
      <>
        <PageHeader title="Applicants" lead={lead} />
        <Skeleton className="h-96 rounded-2xl" />
      </>
    );
  }
  const closed = (row: ApplicationRow) => Boolean(row.closure) || row.stage === "closed" || row.stage === "withdrawn";
  const live = rows.filter((row) => !closed(row));
  const counts = STEPS.map((_, index) => live.filter((row) => stepOf(row.stage) === index).length);
  const needle = search.trim().toLowerCase();
  const roles = [...new Set(rows.map((row) => row.role ?? row.roleSeen).filter((value): value is string => Boolean(value)))].sort();
  const sources = [...new Set(rows.map((row) => row.source))];
  const list = rows
    .filter((row) => (showClosed ? closed(row) : !closed(row)))
    .filter((row) => step === null || stepOf(row.stage) === step)
    .filter((row) => !roleFilter || (row.role ?? row.roleSeen) === roleFilter)
    .filter((row) => !sourceFilter || row.source === sourceFilter)
    .filter((row) => !whoFilter || whoActs(row) === whoFilter)
    .filter((row) => !needle || `${row.name ?? ""} ${row.role ?? ""} ${row.roleSeen ?? ""} ${row.contact.address ?? ""}`.toLowerCase().includes(needle))
    .sort((a, b) => b.appliedAt - a.appliedAt);

  const tabs = (
    <div role="tablist" aria-label="Applicant views" className="mb-4 flex flex-wrap gap-1.5">
      {VIEWS.map((entry) => (
        <button key={entry.id} type="button" role="tab" aria-selected={view === entry.id} onClick={() => setView(entry.id)} className={cn("rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-brand-500", view === entry.id ? "border-brand-500 bg-brand-500/10 font-medium text-strong" : "border-border text-muted-foreground hover:text-strong")}>
          {entry.label}
        </button>
      ))}
    </div>
  );
  if (view !== "all") {
    return (
      <>
        <PageHeader title="Applicants" lead={lead} actions={<AddApplicant />} />
        {tabs}
        {view === "decisions" ? <ScreeningScreen embedded /> : view === "offers" ? <OffersScreen embedded /> : <OnboardingScreen embedded />}
      </>
    );
  }

  return (
    <>
      <PageHeader title="Applicants" lead={lead} actions={<AddApplicant />} />
      {tabs}
      <Panel className="mb-5">
        <PipelineFlow counts={counts} selected={step} onSelect={(index) => setStep(step === index ? null : index)} />
      </Panel>
      <div className={cn("grid grid-cols-[minmax(0,1fr)] items-start gap-5", openId ? "@4xl/main:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]" : "")}>
        <Panel
          title={`${showClosed ? "Closed" : step === null ? "In the pipeline" : STEPS[step].label} · ${list.length}`}
          flush
          action={
            <div className="flex flex-wrap items-center gap-2">
              <TextInput aria-label="Search applicants" placeholder="Search" value={search} onChange={(event) => setSearch(event.target.value)} className="h-8 w-36" />
              <Button size="xs" variant="ghost" onClick={() => setShowClosed(!showClosed)}>
                {showClosed ? "Show open" : "Show closed"}
              </Button>
            </div>
          }
        >
          <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2.5 sm:px-5">
            <Select value={roleFilter} onValueChange={(next) => setRoleFilter(next ?? "")} options={roles.map((value) => ({ value, label: value }))} emptyLabel="Any role" placeholder="Any role" aria-label="Filter by role" />
            <Select value={sourceFilter} onValueChange={(next) => setSourceFilter(next ?? "")} options={sources.map((value) => ({ value, label: SOURCE_WORDS[value] }))} emptyLabel="Any source" placeholder="Any source" aria-label="Filter by source" />
            <Select value={whoFilter} onValueChange={(next) => setWhoFilter(next ?? "")} options={WHO} emptyLabel="Any next step" placeholder="Any next step" aria-label="Filter by who acts next" />
          </div>
          {list.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">{rows.length === 0 ? "No applications yet. Recruiter files them from the hiring inbox, or add one by hand." : "Nobody matches."}</p>
          ) : (
            <ul className="divide-y divide-border">
              {list.map((row) => (
                <li key={row.applicationId}>
                  <button type="button" onClick={() => setOpen(row.applicationId)} aria-current={openId === row.applicationId} className={cn("grid w-full gap-1 px-4 py-3 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500 sm:px-5", openId === row.applicationId && "bg-brand-500/5")}>
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-strong">{row.detailsRemoved ? "Details removed" : (row.name ?? "Name not known")}</span>
                      <WhoActs row={row} />
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {row.role ?? (row.roleSeen ? `“${row.roleSeen}” (not matched to a role)` : "No role yet")} · {SOURCE_WORDS[row.source]} · {STAGE_WORDS[row.stage]}
                      {row.closure ? ` · ${CLOSURE_WORDS[row.closure.reason]}` : ""}
                    </span>
                    {row.nextAction ? (
                      <span className="text-xs text-muted-foreground">
                        Next: {row.nextAction.what}
                        {row.nextAction.dueAt ? ` · ${until(row.nextAction.dueAt, now).text}` : ""}
                      </span>
                    ) : null}
                    {row.contact.bounced ? <span className="text-xs font-medium text-destructive-foreground">An email to this address bounced.</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {openId ? <ApplicantDetail applicationId={openId} now={now} timezone={timezone} onClose={() => setOpen(null)} /> : null}
      </div>
    </>
  );
}

function AddApplicant() {
  const { companyId, role } = useCompany();
  const needs = useQuery(api.hiringNeeds.list, { companyId, status: "open" });
  const add = useMutation(api.applications.addManually);
  const { busy, error, run } = useRun();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ needId: "", name: "", email: "", phone: "" });
  if (role === "office") return null;
  if (!open)
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Add an applicant
      </Button>
    );
  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await add({ companyId, needId: form.needId as Id<"hiringNeeds">, name: form.name, email: form.email, phone: form.phone || undefined });
          setOpen(false);
          setForm({ needId: "", name: "", email: "", phone: "" });
        });
      }}
    >
      <Select value={form.needId} onValueChange={(next) => setForm({ ...form, needId: next ?? "" })} options={[...(needs?.map((need) => ({ value: need._id, label: need.title })) ?? [])]} emptyLabel="Role…" placeholder="Role…" required aria-label="Role" searchable="auto" />
      <TextInput aria-label="Name" placeholder="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
      <EmailInput aria-label="Email" placeholder="Email" value={form.email} onChange={(text) => setForm({ ...form, email: text })} required />
      <TextInput aria-label="Phone" placeholder="Phone (optional)" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
      <Button type="submit" size="sm" variant="primary" loading={busy}>
        Add
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      <FormError message={error} />
    </form>
  );
}

/** How Recruiter got from the email to here, each step with its evidence. */
function traceFor(detail: ApplicationDetail): TraceStep[] {
  const steps: TraceStep[] = [];
  const firstIn = detail.conversation.find((row) => row.direction === "in");
  steps.push({
    id: "found",
    title: firstIn ? `Found in the hiring inbox${firstIn.direction === "in" && firstIn.source ? ` (${SOURCE_WORDS[firstIn.source]})` : ""}` : detail.source === "manual" ? "Added by hand" : "Filed",
    status: "done",
    summary: firstIn && firstIn.direction === "in" ? `${MESSAGE_KIND[firstIn.classification] ?? "An email"}${firstIn.subject ? `: “${firstIn.subject}”` : ""}.` : undefined,
    detail: firstIn && firstIn.direction === "in" && firstIn.excerpt ? <p className="whitespace-pre-line text-muted-foreground">{firstIn.excerpt}</p> : undefined,
  });
  steps.push({
    id: "contact",
    title: "Way to reach them",
    status: detail.contact.status === "direct" ? "done" : detail.contact.status === "missing" || detail.contact.status === "conflict" ? "attention" : "pending",
    summary: detail.contact.words,
    detail: detail.contactEvidence.length ? (
      <ul className="grid gap-1">
        {detail.contactEvidence.map((row) => (
          <li key={`${row.address}${row.where}`}>
            <span className="font-medium text-strong">{row.address}</span> <span className="text-muted-foreground">· {EVIDENCE_WORDS[row.kind] ?? row.kind} · found in {row.where.replace(/^header: /, "the email's ").replace(/^body: /, "the email text, ").replace(/^model: /, "")}</span>
          </li>
        ))}
      </ul>
    ) : undefined,
  });
  if (detail.facts.length)
    steps.push({
      id: "facts",
      title: `${detail.facts.length} ${detail.facts.length === 1 ? "fact" : "facts"} noted`,
      status: "done",
      summary: "Each with where it came from.",
      detail: (
        <dl className="grid gap-1">
          {detail.facts.map((fact) => (
            <div key={`${fact.field}${fact.where}`} className="grid grid-cols-[8rem_1fr] gap-2">
              <dt className="text-muted-foreground">{FACT_WORDS[fact.field] ?? fact.field.replace(/_/g, " ")}</dt>
              <dd className="text-strong">
                {fact.value} <span className="text-xs text-muted-foreground">(they reported it in {fact.from === "resume" ? "a resume" : fact.from === "form" ? "the application form" : fact.from === "owner" ? "a note from you" : "the email"})</span>
              </dd>
            </div>
          ))}
        </dl>
      ),
    });
  steps.push({
    id: "form",
    title: detail.form?.submittedAt ? "Application submitted" : detail.completion.startedAt ? "Application started" : detail.completion.invitedAt ? "Invited to apply" : "Not invited yet",
    status: detail.form?.submittedAt ? "done" : detail.completion.invitedAt ? "pending" : "pending",
    summary: detail.form ? `${detail.form.answered} of ${detail.form.required} required answers${detail.remindersSent ? ` · ${detail.remindersSent} reminder${detail.remindersSent === 1 ? "" : "s"} sent` : ""}` : undefined,
    detail: detail.form?.answers.length ? (
      <dl className="grid gap-1.5">
        {detail.form.answers.map((answer) => (
          <div key={answer.key}>
            <dt className="text-xs text-muted-foreground">{answer.label}</dt>
            <dd className="text-strong">{answer.answer}</dd>
          </div>
        ))}
      </dl>
    ) : undefined,
  });
  if (detail.screening)
    steps.push({
      id: "screening",
      title: RECOMMENDATION[detail.screening.recommendation].label,
      status: detail.screening.recommendation === "advance" ? "done" : "attention",
      summary: detail.screening.summary.suggestedNextStep,
      detail: (
        <div className="grid gap-2">
          <CriteriaList results={detail.screening.results} />
          {detail.screening.missing.length ? <p className="text-xs text-warning-foreground">Missing: {detail.screening.missing.join(", ")}</p> : null}
          {detail.screening.contradictions.length ? <p className="text-xs text-warning-foreground">Contradictions: {detail.screening.contradictions.join("; ")}</p> : null}
        </div>
      ),
    });
  for (const decision of detail.decisions) steps.push({ id: `decision-${decision._id}`, title: `Decided: ${decision.decision}${decision.automatic ? " (automatic, by a published requirement)" : ""}`, status: decision.decision === "reject" ? "failed" : "done", summary: decision.reason ?? undefined });
  return steps;
}

function ApplicantDetail({ applicationId, now, timezone, onClose }: { applicationId: Id<"applications">; now: number; timezone: string; onClose: () => void }) {
  const { companyId, role } = useCompany();
  const detail = useQuery(api.applications.get, { companyId, applicationId });
  const { busy, error, run } = useRun();
  const takeOver = useMutation(api.applications.takeOver);
  const handBack = useMutation(api.applications.handBack);
  const inviteAgain = useMutation(api.applications.inviteAgain);
  const answered = useMutation(api.applications.markReplyAnswered);
  const ask = useMutation(api.applications.askApplicant);
  const close = useMutation(api.applications.close);
  const [question, setQuestion] = useState("");
  const [closing, setClosing] = useState<"" | "not_selected" | "requirement_not_met" | "no_response" | "duplicate" | "other">("");
  if (detail === undefined) return <Skeleton className="h-96 rounded-2xl" />;
  if (detail === null) return <Panel title="Applicant">This applicant is not available.</Panel>;
  const manager = role !== "office";
  const open = !detail.closure && detail.stage !== "closed" && detail.stage !== "withdrawn";
  return (
    <Panel
      title={detail.detailsRemoved ? "Details removed" : (detail.applicant?.name ?? detail.name ?? "Applicant")}
      action={
        <Button size="xs" variant="ghost" onClick={onClose} aria-label="Close">
          <X aria-hidden />
        </Button>
      }
    >
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <WhoActs row={detail} />
          <span className="text-muted-foreground">
            {detail.role ?? detail.roleSeen ?? "No role yet"} · {SOURCE_WORDS[detail.source]} · applied {whenLabel(detail.appliedAt, now, timezone)}
          </span>
        </div>
        <PreparedStep applicationId={applicationId} fallback={detail.nextAction ? `${detail.nextAction.what}${detail.nextAction.dueAt ? ` · ${until(detail.nextAction.dueAt, now).text}` : ""}` : null} />
        <JourneyTimeline stage={detail.stage} times={detail.completion} />

        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">How Recruiter got here</h3>
          <EvidenceTrace steps={traceFor(detail)} />
        </section>

        {detail.applicant ? (
          <section className="grid gap-1 text-sm">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Contact</h3>
            <p className="text-strong">
              {detail.applicant.email ?? "No email"} {detail.applicant.phone ? `· ${detail.applicant.phone}` : ""} {detail.applicant.location ? `· ${detail.applicant.location}` : ""}
            </p>
            <p className="text-xs text-muted-foreground">{detail.applicant.mayBeTexted ? "Agreed to texts." : "Has not agreed to texts; email only."}</p>
            {detail.applicant.doNotContact ? <p className="text-xs font-medium text-destructive-foreground">Asked not to be contacted: {detail.applicant.doNotContact.reason}</p> : null}
          </section>
        ) : null}

        {detail.attachments.length ? (
          <section>
            <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Files</h3>
            <ul className="grid gap-1 text-sm">
              {detail.attachments.map((file) => (
                <li key={file.attachmentId} className="flex items-center gap-2">
                  <Paperclip className="size-4 text-muted-foreground" aria-hidden /> {file.fileName} <span className="text-xs text-muted-foreground">· {file.kind} · not verified</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Conversation</h3>
          {detail.conversation.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing sent or received yet.</p>
          ) : (
            <ol className="grid gap-2">
              {detail.conversation.map((row, index) => (
                <li key={index} className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm", row.direction === "out" ? "ml-auto bg-brand-500/10" : "bg-muted")}>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {row.direction === "out" ? (row.channel === "sms" ? <MessageSquareText className="size-3.5" aria-hidden /> : <Mail className="size-3.5" aria-hidden />) : <Mail className="size-3.5" aria-hidden />}
                    {row.direction === "out" ? `${PURPOSE_WORDS[row.purpose] ?? "Message"} · ${STATUS_WORDS[row.status] ?? row.status}` : `${MESSAGE_KIND[row.classification] ?? "Email"}`} · {whenLabel(row.at, now, timezone)}
                  </p>
                  {row.subject ? <p className="font-medium text-strong">{row.subject}</p> : null}
                  {row.direction === "in" && row.excerpt ? <p className="mt-0.5 line-clamp-4 whitespace-pre-line text-strong">{row.excerpt}</p> : null}
                  {row.direction === "in" && row.flag ? <Badge variant="warning" size="sm">{row.flag}</Badge> : null}
                  {row.direction === "out" && row.problem ? <p className="text-xs text-destructive-foreground">{row.problem}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </section>

        {manager && open ? (
          <section className="grid gap-3 border-t border-border pt-4">
            <div className="flex flex-wrap gap-2">
              {detail.withPerson ? (
                <Button size="sm" variant="outline" loading={busy} onClick={() => void run(() => handBack({ companyId, applicationId }))}>
                  Hand back to Recruiter
                </Button>
              ) : (
                <Button size="sm" variant="outline" loading={busy} onClick={() => void run(() => takeOver({ companyId, applicationId }))}>
                  Take over
                </Button>
              )}
              {detail.stage === "invited" || detail.stage === "application_started" ? (
                <Button size="sm" variant="outline" loading={busy} onClick={() => void run(() => inviteAgain({ companyId, applicationId }))}>
                  Invite again
                </Button>
              ) : null}
              {detail.waitingOnReply ? (
                <Button size="sm" variant="ghost" loading={busy} onClick={() => void run(() => answered({ companyId, applicationId }))}>
                  Mark reply answered
                </Button>
              ) : null}
              {detail.screening ? (
                <Button size="sm" variant="ghost" render={<Link href="/app/agents/recruiter/applicants?view=decisions" />}>
                  Screening and decision
                </Button>
              ) : null}
            </div>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await ask({ companyId, applicationId, question });
                  setQuestion("");
                });
              }}
            >
              <TextInput aria-label="Ask the applicant" placeholder="Ask the applicant something" value={question} onChange={(event) => setQuestion(event.target.value)} className="min-w-0 flex-1" />
              <Button type="submit" size="sm" variant="outline" disabled={!question.trim()} loading={busy}>
                Ask
              </Button>
            </form>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={closing} onValueChange={(next) => setClosing((next ?? "") as typeof closing)} options={[{ value: "not_selected", label: "Not selected" }, { value: "requirement_not_met", label: "A requirement is not met" }, { value: "no_response", label: "No response" }, { value: "duplicate", label: "Duplicate" }, { value: "other", label: "Other" }]} emptyLabel="Close the application…" placeholder="Close the application…" aria-label="Close the application" />
              {closing ? (
                <Button size="sm" variant="destructive-outline" loading={busy} onClick={() => void run(async () => (await close({ companyId, applicationId, reason: closing }), setClosing("")))}>
                  Close it
                </Button>
              ) : null}
              <span className="text-xs text-muted-foreground">A person decides every decline.</span>
            </div>
          </section>
        ) : null}
        <FormError message={error} />
      </div>
    </Panel>
  );
}

/** What an incoming email was, in the owner's words. */
const MESSAGE_KIND: Record<string, string> = {
  new_application: "Application",
  employment_inquiry: "Asked about work",
  applicant_reply: "Their reply",
  duplicate_notification: "Another notice about the same application",
  status_update: "Status update from the job board",
  possibly_hiring: "Possibly about hiring",
};
const EVIDENCE_WORDS: Record<string, string> = { direct: "their own address", relay: "job board forwarding address", notification: "a notice-only address", unknown: "not confirmed as theirs" };
const FACT_WORDS: Record<string, string> = { name: "Name", role: "Role", phone: "Phone", location: "Location", experience: "Experience", availability: "Availability", resume: "Resume", applied_at: "Applied" };
const PURPOSE_WORDS: Record<string, string> = {
  application_invitation: "Application link",
  application_follow_up: "Reminder",
  information_request: "Question to them",
  interview_invitation: "Interview times",
  interview_confirmation: "Interview confirmed",
  interview_reminder: "Interview reminder",
  hiring_offer: "Offer",
  application_decline: "Decline",
  urgent_outreach: "Staffing outreach",
  applicant_reply: "Reply",
};
const STATUS_WORDS: Record<string, string> = { queued: "waiting to send", held: "waiting for sending hours", sending: "sending", sent: "sent, delivery not confirmed", delivered: "delivered", failed: "didn't go through", not_sent: "not sent", unconfirmed: "not known whether it went" };

/** The application's prepared next step, as a finding card; what was done before, below it. */
function PreparedStep({ applicationId, fallback }: { applicationId: Id<"applications">; fallback: string | null }) {
  const { companyId } = useCompany();
  const rows = useQuery(api.recruiterFindings.forApplication, { companyId, applicationId });
  if (rows === undefined) return <Skeleton className="h-24 rounded-2xl" />;
  const current = rows.find((row) => row.status === "ready" || row.status === "needs_attention" || row.status === "scheduled") ?? null;
  const earlier = rows.filter((row) => row !== current).slice(0, 5);
  return (
    <section aria-label="Next step" className="grid gap-2">
      {current ? (
        <FindingCard finding={current} />
      ) : fallback ? (
        <div className="rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-sm">
          <span className="font-medium text-strong">Next:</span> <span className="text-strong">{fallback}</span>
        </div>
      ) : null}
      {earlier.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-semibold tracking-wide text-muted-foreground uppercase">Done before · {earlier.length}</summary>
          <ul className="mt-2 grid gap-1.5">
            {earlier.map((row) => (
              <li key={row.findingId} className="rounded-lg bg-muted/40 px-3 py-1.5">
                <span className="text-strong">{row.headline}</span> <span className="text-xs text-muted-foreground">· {row.outcome ?? row.next}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
