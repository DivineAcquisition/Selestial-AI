"use client";

/**
 * Hiring setup: the roles, where Recruiter finds hiring mail, what it may send by itself, the Owner's
 * Hiring FAQ, and the application and messaging rules. The services Recruiter relies on are listed last,
 * collapsed, in plain words; technical names stay out of the everyday screens.
 */
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, FormError, TextArea, TextInput, useRun } from "@/components/app/form";
import { HiringInboxPanel, RecruitingRules } from "@/components/app/settings/recruiting";
import { PageHeader, Panel } from "@/components/app/shell";
import { useNow } from "@/components/app/use-now";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/selection";
import { whenLabel } from "@/lib/app/format";
import { cn } from "@/lib/utils";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { HiringNeedsScreen } from "./hiring-needs";

const SECTIONS = [
  { id: "roles", label: "Open roles" },
  { id: "inbox", label: "Hiring inbox" },
  { id: "communication", label: "What Recruiter sends" },
  { id: "faq", label: "Hiring FAQ" },
  { id: "rules", label: "Application and messages" },
] as const;

export function HiringSetupScreen() {
  return (
    <>
      <PageHeader title="Hiring setup" lead="Your roles, where Recruiter finds hiring mail, what it may send by itself, and the answers it may give." />
      <nav aria-label="Hiring setup sections" className="mb-5 flex flex-wrap gap-1.5">
        {SECTIONS.map((section) => (
          <a key={section.id} href={`#${section.id}`} className="rounded-full border border-border px-3 py-1 text-sm text-muted-foreground hover:text-strong focus-visible:outline-2 focus-visible:outline-brand-500">
            {section.label}
          </a>
        ))}
      </nav>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
        <section id="roles" aria-labelledby="roles-title" className="scroll-mt-20">
          <h2 id="roles-title" className="mb-3 font-heading text-lg tracking-tight text-strong">
            Open roles
          </h2>
          <HiringNeedsScreen embedded />
        </section>
        <section id="inbox" aria-labelledby="inbox-title" className="grid scroll-mt-20 gap-4">
          <h2 id="inbox-title" className="font-heading text-lg tracking-tight text-strong">
            Hiring inbox
          </h2>
          <Discovery />
          <HiringInboxPanel />
          <Forwarding />
          <RecentReads />
        </section>
        <section id="communication" aria-labelledby="communication-title" className="scroll-mt-20">
          <h2 id="communication-title" className="mb-3 font-heading text-lg tracking-tight text-strong">
            What Recruiter sends by itself
          </h2>
          <Automation />
        </section>
        <section id="faq" aria-labelledby="faq-title" className="scroll-mt-20">
          <h2 id="faq-title" className="mb-3 font-heading text-lg tracking-tight text-strong">
            Hiring FAQ
          </h2>
          <HiringFaq />
        </section>
        <section id="rules" aria-labelledby="rules-title" className="grid scroll-mt-20 gap-4">
          <h2 id="rules-title" className="font-heading text-lg tracking-tight text-strong">
            Application and messages
          </h2>
          <RecruitingRules inbox={false} />
          <Services />
        </section>
      </div>
    </>
  );
}

const MODES = [
  { id: "hiring_inbox", title: "A hiring inbox", recommended: true, words: "The whole mailbox is for hiring (for example hiring@yourcompany). Recruiter still leaves alone what is plainly not hiring mail." },
  { id: "label", title: "A Gmail label", recommended: true, words: "You file hiring mail under one label in your business inbox. Recruiter reads only mail with that label, including mail you label later." },
  { id: "search", title: "Find hiring emails in my business inbox", recommended: false, words: "Recruiter searches a shared inbox for job-board notices and clear hiring words. It may miss an inquiry that never says what it's about; those can land in “Possibly hiring-related”." },
] as const;

/** How Recruiter finds hiring mail in each connected inbox. */
function Discovery() {
  const { companyId, role } = useCompany();
  const overview = useQuery(api.recruiter.overview, { companyId });
  const set = useMutation(api.recruiter.setDiscovery);
  const { busy, error, run } = useRun();
  const [labels, setLabels] = useState<Record<string, string>>({});
  if (!overview) return <Skeleton className="h-40 rounded-2xl" />;
  const inboxes = overview.inbox.filter((row) => row.status !== "disconnected");
  if (inboxes.length === 0) return null;
  return (
    <Panel title="Where Recruiter looks for hiring mail">
      <p className="mb-3 text-sm text-muted-foreground">A dedicated inbox or a label gives the clearest boundary. Recruiter never opens mail outside the choice you make here, whichever way new mail arrives.</p>
      <FormError message={error} />
      <div className="grid gap-5">
        {inboxes.map((inbox) => {
          const label = labels[inbox.connectionId] ?? inbox.label ?? "";
          return (
            <fieldset key={inbox.connectionId} className="grid gap-2" disabled={role !== "owner" || busy}>
              <legend className="mb-1 text-sm font-medium text-strong">{inbox.address}</legend>
              <div className="grid gap-2 md:grid-cols-3">
                {MODES.map((mode) => {
                  const on = inbox.discovery === mode.id;
                  return (
                    <label key={mode.id} className={cn("grid cursor-pointer gap-1 rounded-xl border p-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand-500", on ? "border-brand-500 bg-brand-500/5" : "border-border hover:border-brand-500/50")}>
                      <span className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={`mode-${inbox.connectionId}`}
                          className="sr-only"
                          checked={on}
                          onChange={() => {
                            if (mode.id === "label" && !label.trim()) return setLabels({ ...labels, [inbox.connectionId]: label });
                            void run(() => set({ companyId, connectionId: inbox.connectionId as Id<"mailboxConnections">, mode: mode.id, label: mode.id === "label" ? label : undefined }));
                          }}
                        />
                        <span aria-hidden className={cn("grid size-4 place-items-center rounded-full border", on ? "border-brand-500" : "border-border")}>{on ? <span className="size-2 rounded-full bg-brand-500" /> : null}</span>
                        <span className="font-medium text-strong">{mode.title}</span>
                        {mode.recommended ? <Badge variant="outline" size="sm">Recommended</Badge> : null}
                      </span>
                      <span className="text-xs leading-relaxed text-muted-foreground">{mode.words}</span>
                    </label>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Label name" hint="Needed for the label option. It must already exist in Gmail; Recruiter doesn't create labels or filters.">
                  <TextInput value={label} placeholder="Hiring" onChange={(event) => setLabels({ ...labels, [inbox.connectionId]: event.target.value })} className="max-w-[14rem]" />
                </Field>
                <Button size="sm" variant="outline" disabled={!label.trim() || role !== "owner"} loading={busy} onClick={() => void run(() => set({ companyId, connectionId: inbox.connectionId as Id<"mailboxConnections">, mode: "label", label }))}>
                  Use this label
                </Button>
              </div>
            </fieldset>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">Gmail&apos;s read permission covers your whole mailbox: Google can&apos;t limit it to hiring mail. Selestial keeps to the boundary you choose here, and keeps nothing from mail outside it except an id that stops it being looked at twice.</p>
    </Panel>
  );
}

/**
 * Whether a job board's per-applicant forwarding address reaches applicants. Until the Owner confirms it,
 * Recruiter prepares nothing to such an address.
 */
function Forwarding() {
  const { companyId, role } = useCompany();
  const playbook = useQuery(api.recruiter.playbook, { companyId });
  const set = useMutation(api.recruiter.setVerifiedRelays);
  const { busy, error, run } = useRun();
  if (!playbook) return null;
  const confirmed = playbook.settings.verifiedRelays as string[];
  const boards = [
    { id: "indeed" as const, label: "Indeed" },
    { id: "ziprecruiter" as const, label: "ZipRecruiter" },
  ];
  return (
    <Panel title="Job-board forwarding addresses">
      <p className="mb-3 text-sm text-muted-foreground">Indeed and ZipRecruiter often give each applicant a forwarding address instead of their own. Recruiter writes to one only after you confirm that board&apos;s forwarding reaches applicants, for example by replying to one applicant through it and getting their answer. Selestial can&apos;t check this for you.</p>
      <ul className="grid gap-2">
        {boards.map((board) => {
          const on = confirmed.includes(board.id);
          return (
            <li key={board.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-sm">
              <span className="text-strong" id={`relay-${board.id}`}>
                {board.label} forwarding {on ? "is confirmed" : "is not confirmed"}
              </span>
              <label className="flex items-center gap-2">
                <Switch labelledBy={`relay-${board.id}`} checked={on} disabled={role !== "owner" || busy} onChange={(next) => void run(() => set({ companyId, sources: (next ? [...confirmed, board.id] : confirmed.filter((id) => id !== board.id)) as ("indeed" | "ziprecruiter")[] }))} />
                {on ? "Confirmed" : "Not confirmed"}
              </label>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">Changing this looks again at the applications you already have from that board. Messages are prepared, not sent: they go when you send them, or by themselves only where you switched that on.</p>
      <FormError message={error} />
    </Panel>
  );
}

/** The latest reads, as they really happened. */
function RecentReads() {
  const { companyId, role, timezone } = useCompany();
  const now = useNow();
  const runs = useQuery(api.recruiter.inboxRuns, role === "office" ? "skip" : { companyId });
  if (!runs || runs.length === 0) return null;
  return (
    <Panel title="Recent reads">
      <div className="grid gap-4">
        {runs.map((inbox) => (
          <div key={inbox.connectionId}>
            <p className="mb-1.5 text-sm font-medium text-strong">
              {inbox.address} {inbox.status !== "connected" ? <Badge variant="warning" size="sm">Needs attention</Badge> : null}
            </p>
            {inbox.problem ? <p className="mb-2 text-sm text-warning-foreground">{inbox.problem}</p> : null}
            {inbox.runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Not read yet.</p>
            ) : (
              <ul className="grid gap-1 text-sm">
                {inbox.runs.map((entry) => (
                  <li key={entry.startedAt} className="flex flex-wrap items-center gap-2">
                    <Badge variant={entry.outcome === "failed" ? "error" : entry.outcome === "partial" ? "warning" : entry.outcome === "read" ? "success" : "outline"} size="sm">
                      {entry.outcome === "failed" ? "Didn't finish" : entry.outcome === "partial" ? "More to read" : entry.outcome === "read" ? "Read" : "Reading"}
                    </Badge>
                    <span className="text-muted-foreground">{whenLabel(entry.startedAt, now, timezone)}</span>
                    <span className="text-strong">
                      {entry.filed} looked at · {entry.opened} opened{entry.possible ? ` · ${entry.possible} possibly hiring-related` : ""}
                    </span>
                    {entry.problem ? <span className="text-xs text-warning-foreground">{entry.problem}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** The five switches: each with its trigger, its message, and when it stops. */
function Automation() {
  const { companyId, role } = useCompany();
  const list = useQuery(api.recruiterAutomation.list, { companyId });
  const set = useMutation(api.recruiterAutomation.set);
  const { busy, error, run } = useRun();
  if (!list) return <Skeleton className="h-64 rounded-2xl" />;
  return (
    <Panel>
      <p className="mb-4 text-sm text-muted-foreground">Off means Recruiter prepares the message and you send it with one click. On means it goes by itself when its trigger happens, and stops when the conditions below say so. Hiring decisions are never sent by themselves.</p>
      {list.paused ? <p className="mb-3 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-strong">Recruiter is paused, so nothing goes by itself whatever these say.</p> : null}
      <FormError message={error} />
      <ul className="grid gap-3">
        {list.items.map((item) => (
          <li key={item.key} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1fr_auto] sm:items-start">
            <div className="grid gap-1 text-sm">
              <p className="font-medium text-strong" id={`auto-${item.key}`}>
                {item.title}
              </p>
              <p className="text-muted-foreground">
                <span className="font-medium text-strong">When: </span>
                {item.trigger}
              </p>
              <p className="text-muted-foreground">
                <span className="font-medium text-strong">Sends: </span>
                {item.message}
              </p>
              <p className="text-muted-foreground">
                <span className="font-medium text-strong">Stops: </span>
                {item.stops}
              </p>
              {item.limitation ? <p className="text-xs text-warning-foreground">{item.limitation}</p> : null}
            </div>
            <label className="flex items-center gap-2 text-sm text-strong">
              <Switch labelledBy={`auto-${item.key}`} checked={item.on} disabled={role !== "owner" || busy} onChange={(on) => void run(() => set({ companyId, key: item.key, on }))} />
              {item.on ? "On" : "Off"}
            </label>
          </li>
        ))}
      </ul>
      {role !== "owner" ? <p className="mt-3 text-xs text-muted-foreground">Only the Owner changes these.</p> : null}
    </Panel>
  );
}

/** The Owner's own answers, which with a role's approved details are all a drafted reply may say. */
function HiringFaq() {
  const { companyId, role } = useCompany();
  const playbook = useQuery(api.recruiter.playbook, { companyId });
  const update = useMutation(api.recruiter.updatePlaybook);
  const { busy, error, run } = useRun();
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (!playbook) return <Skeleton className="h-40 rounded-2xl" />;
  const value = text ?? playbook.settings.hiringFaq ?? "";
  return (
    <Panel>
      <Field label="Answers Recruiter may give applicants" hint="For example: whether you provide supplies, whether a car is needed, typical hours, how long hiring takes. Recruiter's drafted replies say nothing that isn't here or on the role.">
        <TextArea rows={8} value={value} disabled={role !== "owner"} onChange={(event) => (setText(event.target.value), setSaved(false))} placeholder={"Supplies: we provide all supplies and equipment.\nTransport: you need your own car.\nHours: most visits are weekdays between 8am and 4pm."} />
      </Field>
      {role === "owner" ? (
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="primary" loading={busy} disabled={text === null} onClick={() => void run(async () => (await update({ companyId, settings: { hiringFaq: value } }), setText(null), setSaved(true)))}>
            Save
          </Button>
          {saved ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
        </div>
      ) : null}
      <FormError message={error} />
    </Panel>
  );
}

/** The services Recruiter relies on, in plain words, out of the way. */
function Services() {
  const { companyId } = useCompany();
  const overview = useQuery(api.recruiter.overview, { companyId });
  if (!overview) return null;
  const rows = [
    { label: "Application links for applicants", on: overview.connections.applicantLinks, words: overview.connections.applicantLinks ? "Ready" : "Not set up yet" },
    { label: "Sending email", on: overview.connections.email !== null, words: overview.inbox.some((row) => row.sendsApplicantEmail) ? "From your connected inbox" : overview.connections.email ? "From a Selestial address under your company's name" : "Not set up yet" },
    { label: "Texting applicants who agreed", on: overview.connections.texting !== null, words: overview.connections.texting ? "Ready" : "Not set up yet" },
    { label: "Calendar for interview times", on: overview.connections.calendar !== null, words: overview.connections.calendar ? "Connected" : "Not connected: interview times are the ones you add" },
    { label: "Electronic signatures", on: overview.connections.signing !== null, words: overview.connections.signing ? "Connected" : "Not connected: a person records each signed agreement" },
    { label: "Reading emails", on: true, words: overview.connections.reader === "rules" ? "Job-board notices by Selestial's rules; AI reading isn't switched on" : "Job-board notices by rules first, other emails by AI (1 credit each)" },
  ];
  return (
    <details className="rounded-2xl border border-border bg-card p-4">
      <summary className="cursor-pointer text-sm font-medium text-strong">Services Recruiter uses</summary>
      <ul className="mt-3 grid gap-1.5 text-sm">
        {rows.map((row) => (
          <li key={row.label} className="flex flex-wrap items-center gap-2">
            <span aria-hidden className={cn("size-1.5 rounded-full", row.on ? "bg-success" : "bg-warning")} />
            <span className="text-strong">{row.label}:</span> <span className="text-muted-foreground">{row.words}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
