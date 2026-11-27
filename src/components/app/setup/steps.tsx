"use client";

/**
 * The screens of setup: choose an outcome, confirm essentials, add relevant context, build. Each one only
 * edits the form; saving is the flow's (autosave.ts), so every screen saves the same way.
 */
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { AgentAvatar, type AgentId } from "@/components/app/agent";
import { useCompany } from "@/components/app/company";
import { Field, messageOf, TextInput } from "@/components/app/form";
import { PermissionRow, type Action } from "@/components/app/screens/agent-permissions";
import { ArrowUpRight, CalendarCheckIcon as CalendarCheck, Check, ChevronDown, CircleHelp, Coins, HandHeartIcon as HandHeart, Info, LayoutGrid, Megaphone, PenLine, ShieldCheck, UserPlusIcon } from "@/components/icons";
import { SelectionCard, SelectionCards } from "@/components/ui/selection";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { CATEGORY_CHOICES, type Choice, type FactKey } from "../../../../convex/lib/setup/facts";
import { connectionsFor, contextFor, pricingPath, PRIORITY_INFO, UNSURE, type Known, type Question } from "../../../../convex/lib/setup/path";
import type { Priority } from "../../../../convex/lib/setup/schema";
import { BusinessInputs } from "./business-inputs";
import { TimeZonePicker, zoneHint } from "./time-zone";
import { WebsitePanel } from "./website-panel";
import type { Patch } from "./autosave";

type View = FunctionReturnType<typeof api.setup.state>;
type Value = string | string[];

export type Form = { priority: Priority | null; secondary: Priority[]; answers: Record<string, Value>; facts: Record<string, Value>; name: string; timezone: string; methods: string[] };

const one = (value: Value | undefined) => (typeof value === "string" ? value : "");
const many = (value: Value | undefined) => (Array.isArray(value) ? value : []);
const asOptions = (choices: Choice[]) => choices.map((choice) => ({ value: choice.value, label: choice.label, description: choice.hint }));

export function StepHeading({ eyebrow, title, lead, id }: { eyebrow: string; title: string; lead?: string; id: string }) {
  return (
    <header className="grid gap-1.5">
      <p className="text-xs font-semibold tracking-wide text-[#6838ef] uppercase">{eyebrow}</p>
      <h1 id={id} tabIndex={-1} className="font-display text-2xl font-semibold text-balance text-strong outline-none sm:text-3xl">
        {title}
      </h1>
      {lead ? <p className="text-sm text-muted-foreground">{lead}</p> : null}
    </header>
  );
}

function Why({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 rounded-xl bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

// ── 1. Outcome ──────────────────────────────────────────────────────────────────────────────────────

const OUTCOME_ICON: Record<Priority, typeof Megaphone> = { sales: Megaphone, dispatch: CalendarCheck, recruiter: UserPlusIcon, retention: HandHeart, pricing: Coins, booking: LayoutGrid };

export function OutcomeStep({ form, update }: { form: Form; update: (patch: Patch) => void }) {
  return (
    <>
      <StepHeading id="step-heading" eyebrow="Step 1 · Your outcome" title="What would you like Selestial to help you accomplish first?" lead="Pick one. You can add more priorities after your first result." />
      <SelectionCards
        type="single"
        aria-label="What Selestial should help with first"
        columns={2}
        value={form.priority}
        onValueChange={(id) => update({ priority: id, secondary: form.secondary.filter((value) => value !== id) })}
        options={PRIORITY_INFO.map((item) => {
          const Icon = OUTCOME_ICON[item.id];
          return { value: item.id, label: item.title, description: item.hint, icon: <Icon className="size-5" /> };
        })}
      />
    </>
  );
}

// ── 2. Essentials ───────────────────────────────────────────────────────────────────────────────────

export function EssentialsStep({ view, form, update }: { view: View; form: Form; update: (patch: Patch) => void }) {
  const [editName, setEditName] = useState(false);
  const fact = (key: FactKey, value: Value) => update({ facts: { [key]: value } });
  return (
    <>
      <StepHeading id="step-heading" eyebrow="Step 2 · Essentials" title="Confirm a few essentials" lead="Only what every part of your workspace needs. Anything already known is filled in." />
      <WebsitePanel facts={view.facts} current={form.facts} onUse={(key, value) => fact(key, value)} onStarted={() => update({ methods: [...new Set([...form.methods, "website"])] })} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-1.5">
          {editName ? (
            <Field label="Company name">
              <TextInput value={form.name} onChange={(event) => update({ company: { name: event.target.value } })} maxLength={160} autoComplete="organization" required autoFocus />
            </Field>
          ) : (
            <div className="grid gap-1">
              <p className="text-sm font-medium text-strong">Company name</p>
              <p className="flex items-center gap-2 text-sm text-strong">
                {form.name}
                <Button variant="ghost" size="xs" onClick={() => setEditName(true)} aria-label="Change your company name">
                  <PenLine aria-hidden className="size-3.5" />
                  Change
                </Button>
              </p>
            </div>
          )}
        </div>
        <Field label="Where you're based" hint="City and state is enough. Recruiter uses it for role locations." required>
          <TextInput value={one(form.facts["company.location"])} onChange={(event) => fact("company.location", event.target.value)} placeholder="Austin, TX" maxLength={120} autoComplete="address-level2" />
        </Field>
        <div className="grid content-start gap-1.5 sm:col-span-2">
          <label htmlFor="setup-timezone" className="text-sm font-medium text-strong">
            Time zone
          </label>
          <TimeZonePicker id="setup-timezone" value={form.timezone} onChange={(zone) => update({ company: { timezone: zone } })} describedBy="setup-timezone-hint" />
          <p id="setup-timezone-hint" className="text-xs text-muted-foreground">
            {zoneHint(form.timezone)}
          </p>
        </div>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-strong">What kinds of cleaning do you do?</legend>
        <SelectionCards type="multiple" aria-label="What kinds of cleaning do you do?" columns={2} value={many(form.facts["services.categories"])} onValueChange={(next) => fact("services.categories", next)} options={asOptions(CATEGORY_CHOICES)} />
      </fieldset>
      <Why>These shape the drafts Selestial prepares. They don&apos;t publish, price or send anything.</Why>
    </>
  );
}

// ── 3. Context ──────────────────────────────────────────────────────────────────────────────────────

function QuestionField({ question, form, update }: { question: Question; form: Form; update: (patch: Patch) => void }) {
  const value = question.fact ? form.facts[question.fact] : form.answers[question.id];
  const set = (next: Value) => update(question.fact ? { facts: { [question.fact]: next } } : { answers: { [question.id]: next } });
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-base font-semibold text-strong">
        {question.title}
        {question.optional ? <span className="ml-2 text-xs font-normal text-muted-foreground">Optional</span> : null}
      </legend>
      <p className="-mt-1 text-xs text-muted-foreground">{question.why}</p>
      {question.kind === "text" ? (
        <TextInput aria-label={question.title} value={one(value)} onChange={(event) => set(event.target.value)} placeholder={question.placeholder} maxLength={300} />
      ) : question.kind === "multi" ? (
        <div className="grid gap-2">
          <SelectionCards type="multiple" aria-label={question.title} columns={2} value={many(value).filter((item) => item !== UNSURE)} onValueChange={(next) => set(next)} options={asOptions(question.choices)} />
          {!question.fact ? <SelectionCard title="I'm not sure" description="We'll mark it as open and come back to it." selected={value === UNSURE} onPress={() => set(UNSURE)} /> : null}
        </div>
      ) : (
        <SelectionCards type="single" aria-label={question.title} value={typeof value === "string" ? value : null} onValueChange={(next) => set(next)} options={[...asOptions(question.choices), ...(question.id === "pricing.path" ? [] : [{ value: UNSURE, label: "I'm not sure", description: "We'll mark it as open and come back to it." }])]} />
      )}
    </fieldset>
  );
}

/** A link to another page setup sends the owner to: saved first, and remembered so "Return to setup" comes back here. */
export function HandoffButton({ href, children, onLeave, variant = "outline" }: { href: string; children: React.ReactNode; onLeave: (href: string) => void; variant?: "outline" | "ghost" | "primary" }) {
  return (
    <Button variant={variant} size="sm" onClick={() => onLeave(href)}>
      {children}
      <ArrowUpRight aria-hidden className="size-3.5" />
    </Button>
  );
}

function FirstService({ prepared }: { prepared: View["prepared"]["service"] }) {
  const { companyId } = useCompany();
  const saveFirst = useMutation(api.setup.saveFirstService);
  const [name, setName] = useState(prepared?.name ?? "");
  const [price, setPrice] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">(prepared ? "saved" : "idle");
  const [error, setError] = useState<string | null>(null);
  const cents = Math.round(Number(price.replace(/[$,\s]/g, "")) * 100);
  return (
    <section className="grid gap-3 rounded-2xl border border-border bg-white p-4" aria-labelledby="first-service">
      <div>
        <h2 id="first-service" className="text-base font-semibold text-strong">
          Your first service and its price
        </h2>
        <p className="text-sm text-muted-foreground">One is enough to start. It is saved as a draft: customers see it only after you publish it. Add the rest later, or import a price list in Services & Pricing.</p>
      </div>
      <form
        className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          setState("saving");
          setError(null);
          saveFirst({ companyId, name, priceCents: cents })
            .then(() => setState("saved"))
            .catch((caught) => {
              setState("failed");
              setError(messageOf(caught));
            });
        }}
      >
        <Field label="Service">
          <TextInput value={name} onChange={(event) => { setName(event.target.value); setState("idle"); }} placeholder="Standard home cleaning" maxLength={80} required />
        </Field>
        <Field label="Price ($)">
          <TextInput value={price} onChange={(event) => { setPrice(event.target.value); setState("idle"); }} inputMode="decimal" placeholder="150" required />
        </Field>
        <Button type="submit" variant="outline" loading={state === "saving"} disabled={!name.trim() || !(cents >= 100)}>
          {prepared ? "Update draft" : "Save as draft"}
        </Button>
      </form>
      <p role="status" className="text-xs text-muted-foreground">
        {state === "saved" ? (prepared ? `Saved as a draft: ${prepared.name}.` : "Saved as a draft.") : state === "failed" ? "" : ""}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-[#f7f5ff] px-3 py-2">
      <p className="text-lg font-semibold text-strong tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

export function ContextStep({ view, form, update, records, onLeave }: { view: View; form: Form; update: (patch: Patch) => void; records: Known["records"] | null; onLeave: (href: string) => void }) {
  if (!form.priority) return null;
  if (!records) return <Skeleton className="h-64 rounded-2xl" />;
  return <ContextQuestions view={view} form={form} update={update} records={records} onLeave={onLeave} outcome={form.priority} />;
}

function ContextQuestions({ view, form, update, records, onLeave, outcome }: { view: View; form: Form; update: (patch: Patch) => void; records: Known["records"]; onLeave: (href: string) => void; outcome: Priority }) {
  const known: Known = { answers: form.answers, facts: form.facts, records };
  const rows = contextFor(outcome, known);
  // What was open on arrival stays on screen while the owner answers it; only what was already known is set aside.
  const [openOnArrival] = useState(() => new Set(rows.filter((row) => row.answeredBy === null).map((row) => row.question.id)));
  const asked = rows.filter((row) => row.answeredBy === null || openOnArrival.has(row.question.id));
  const set = rows.filter((row) => !asked.includes(row));
  const path = pricingPath(form.answers);
  const info = PRIORITY_INFO.find((item) => item.id === outcome)!;
  const connections = connectionsFor(outcome);
  // For Dispatch and Retention the records matter most, so what they can see comes before the questions.
  const questionFields = asked.map((row) => <QuestionField key={row.question.id} question={row.question} form={form} update={update} />);
  return (
    <>
      <StepHeading id="step-heading" eyebrow={`Step 3 · ${info.title}`} title="Add what makes your first result useful" lead="Only what changes what Selestial prepares. Everything else can wait." />
      {outcome !== "dispatch" && outcome !== "retention" ? questionFields : null}

      {["pricing", "sales", "booking"].includes(outcome) && path === "existing" && records.activeServices === 0 ? <FirstService prepared={view.prepared.service} /> : null}
      {["pricing", "sales", "booking"].includes(outcome) && path === "assist" ? <BusinessInputs compact sections={["costs"]} /> : null}
      {["pricing", "sales", "booking"].includes(outcome) && path === "later" ? <Why>Customers can ask for a quote until you set prices. Any example prices Selestial prepares are marked as examples and are never published by themselves.</Why> : null}

      {outcome === "booking" ? (
        <details className="group rounded-2xl border border-border bg-white">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium text-strong focus-visible:outline-2 focus-visible:outline-brand-500">
            Booking hours and ZIP codes <span className="text-xs font-normal text-muted-foreground">Optional now, needed before publishing</span>
            <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
          </summary>
          <div className="border-t border-border p-3">
            <BusinessInputs compact sections={["availability"]} />
          </div>
        </details>
      ) : null}

      {outcome === "dispatch" ? (
        <section className="grid gap-3 rounded-2xl border border-border bg-white p-4" aria-labelledby="dispatch-records">
          <h2 id="dispatch-records" className="text-base font-semibold text-strong">
            What Dispatch can see
          </h2>
          <div className="grid grid-cols-2 gap-2">
            <Count label="Upcoming jobs, next 2 weeks" value={records.upcomingJobs} />
            <Count label="Cleaners ready for work" value={records.readyCleaners} />
          </div>
          <p className="text-sm text-muted-foreground">
            {records.upcomingJobs === 0
              ? "Add one upcoming job, and Dispatch reviews its coverage. Without one, your dispatch setup is still prepared and the review starts the moment a job is added."
              : records.readyCleaners === 0
                ? "Add your cleaners so Dispatch can propose who could cover each job. It never invents cleaners or availability."
                : "Dispatch has what it needs for a first coverage review. It proposes cleaners; it sends no offers without your permission."}
          </p>
          <div className="flex flex-wrap gap-2">
            <HandoffButton href="/app/schedule" onLeave={onLeave} variant={records.upcomingJobs === 0 ? "primary" : "outline"}>
              Add one upcoming job
            </HandoffButton>
            <HandoffButton href="/app/cleaners/import" onLeave={onLeave}>
              Import cleaners
            </HandoffButton>
            <HandoffButton href="/app/migration" onLeave={onLeave} variant="ghost">
              Bring in your schedule
            </HandoffButton>
          </div>
        </section>
      ) : null}

      {outcome === "retention" ? (
        <section className="grid gap-3 rounded-2xl border border-border bg-white p-4" aria-labelledby="retention-records">
          <h2 id="retention-records" className="text-base font-semibold text-strong">
            What Retention can see
          </h2>
          <div className="grid grid-cols-2 gap-2">
            <Count label="Customers" value={records.customers} />
            <Count label="Completed visits, 90 days" value={records.completedJobs} />
          </div>
          <p className="text-sm text-muted-foreground">
            {records.customers === 0 ? "Retention needs your customer list and past visits to find real follow-up opportunities. It never guesses who is at risk." : "Retention reviews these records for follow-ups that are actually due. Nothing is sent to a customer from setup."}
          </p>
          <div className="flex flex-wrap gap-2">
            <HandoffButton href="/app/migration" onLeave={onLeave} variant={records.customers === 0 ? "primary" : "outline"}>
              Import customers and past visits
            </HandoffButton>
            <HandoffButton href="/app/clients" onLeave={onLeave} variant="ghost">
              Add a customer
            </HandoffButton>
          </div>
        </section>
      ) : null}

      {outcome === "dispatch" || outcome === "retention" ? questionFields : null}

      {outcome === "recruiter" && (many(form.answers["hiring.sources"]).includes("email") || records.hiringInbox !== "none") ? (
        <section className="grid gap-2 rounded-2xl border border-border bg-white p-4" aria-labelledby="hiring-inbox">
          <h2 id="hiring-inbox" className="text-base font-semibold text-strong">
            Your hiring inbox {records.hiringInbox === "connected" ? <Check className="inline size-4 text-success" aria-label="connected" /> : null}
          </h2>
          <p className="text-sm text-muted-foreground">
            {records.hiringInbox === "connected"
              ? "Connected. Recruiter reads it only for applications, and invites nobody until a role is open and you allow it."
              : records.hiringInbox === "broken"
                ? "Your hiring inbox stopped working. Reconnect it, or continue: your role draft doesn't need it."
                : "Optional. Recruiter can read it only for job applications, after you authorize it. Nothing is read until then, and your role draft doesn't need it."}
          </p>
          {records.hiringInbox !== "connected" ? (
            <div>
              <HandoffButton href="/app/agents/recruiter/applicants" onLeave={onLeave}>
                {records.hiringInbox === "broken" ? "Reconnect your hiring inbox" : "Connect your hiring inbox"}
              </HandoffButton>
            </div>
          ) : null}
        </section>
      ) : null}

      {connections.length ? (
        <details className="group rounded-2xl border border-border bg-white">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium text-strong focus-visible:outline-2 focus-visible:outline-brand-500">
            Connections that help (optional)
            <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
          </summary>
          <ul className="grid gap-2 border-t border-border p-3 sm:grid-cols-2">
            {connections.map((connection) => (
              <li key={connection.id} className="grid gap-1 rounded-xl border border-border px-3.5 py-3 text-sm">
                <span className="font-medium text-strong">{connection.title}</span>
                <span className="text-muted-foreground">{connection.does}</span>
                <span>
                  <HandoffButton href={connection.href} onLeave={onLeave} variant="ghost">
                    Set up
                  </HandoffButton>
                </span>
              </li>
            ))}
          </ul>
          <p className="px-4 pb-3 text-xs text-muted-foreground">None is required. If a connection fails, you can come back and continue without it.</p>
        </details>
      ) : null}

      {set.length ? (
        <details className="rounded-xl bg-muted/40 px-3 py-2.5 text-sm">
          <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-strong">
            <CircleHelp className="size-4 text-muted-foreground" aria-hidden />
            Not asked: already known ({set.length})
          </summary>
          <ul className="mt-2 grid gap-1 text-muted-foreground">
            {set.map((row) => (
              <li key={row.question.id}>
                {row.question.title} <span className="text-xs">· {row.answeredBy}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {!asked.length && outcome !== "dispatch" && outcome !== "retention" ? <Why>Nothing else to ask: what you already gave covers it.</Why> : null}
    </>
  );
}

/** Whether "Add context" has anything to show. When it doesn't, the flow passes through it. */
export function contextNeeded(outcome: Priority | null, form: Form, records: Known["records"] | null, hasService: boolean): boolean {
  if (!outcome || !records) return true;
  const known: Known = { answers: form.answers, facts: form.facts, records };
  if (contextFor(outcome, known).some((row) => row.answeredBy === null)) return true;
  if (outcome === "dispatch" && (records.upcomingJobs === 0 || records.readyCleaners === 0)) return true;
  if (outcome === "retention" && records.customers === 0) return true;
  const path = pricingPath(form.answers);
  if (["pricing", "sales", "booking"].includes(outcome) && ((path === "existing" && records.activeServices === 0 && !hasService) || path === "assist")) return true;
  return false;
}

/** Required questions still open, for the Continue button's reason. */
export function contextBlocked(outcome: Priority | null, form: Form, records: Known["records"] | null): string | null {
  if (!outcome || !records) return null;
  const known: Known = { answers: form.answers, facts: form.facts, records };
  const open = contextFor(outcome, known).filter((row) => row.answeredBy === null && !row.question.optional);
  return open.length ? `Answer “${open[0].question.title}”, or choose “I'm not sure”.` : null;
}

// ── 4. Build ────────────────────────────────────────────────────────────────────────────────────────

const AGENT_FOR: Record<Priority, AgentId | null> = { sales: "sales", dispatch: "dispatch", recruiter: "recruiter", retention: "retention", pricing: "sales", booking: "sales" };

function Permissions({ outcome }: { outcome: Priority }) {
  const { companyId } = useCompany();
  const permissions = useQuery(api.permissions.list, { companyId });
  const agent = AGENT_FOR[outcome];
  const actions = (permissions?.actions ?? []).filter((action) => action.agent === agent) as (Action & { agent: string })[];
  return (
    <section className="grid gap-2 rounded-2xl border border-border bg-white p-4" aria-labelledby="control-heading">
      <h2 id="control-heading" className="flex items-center gap-2 text-sm font-semibold text-strong">
        <ShieldCheck className="size-4 text-[#6838ef]" aria-hidden />
        Your agents can prepare work now. You stay in control of what gets published, sent, or spent.
      </h2>
      <ul className="grid gap-1 text-sm text-muted-foreground">
        <li>
          <span className="font-medium text-strong">Prepared for you:</span> drafts, previews and reviews inside your workspace. Nobody outside sees them.
        </li>
        <li>
          <span className="font-medium text-strong">Needs your approval:</span> publishing a service, booking form or role, prices, agreement terms, and anything that costs money.
        </li>
        <li>
          <span className="font-medium text-strong">Sent only with your permission:</span> messages to customers, applicants or cleaners follow the settings below and are checked again when they go.
        </li>
      </ul>
      {actions.length ? (
        <details className="group rounded-xl border border-border">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium text-strong focus-visible:outline-2 focus-visible:outline-brand-500">
            What {actions[0] ? (agent ? agent.charAt(0).toUpperCase() + agent.slice(1) : "") : ""} may do on its own
            <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
          </summary>
          <div className="border-t border-border px-3 py-2">
            <p className="text-xs text-muted-foreground">These are your current settings. Building your workspace changes none of them.</p>
            <ul className="divide-y divide-border">
              {actions.map((action) => (
                <PermissionRow key={action.key} action={action} canEdit />
              ))}
            </ul>
          </div>
        </details>
      ) : null}
    </section>
  );
}

type Preview = Extract<NonNullable<FunctionReturnType<typeof api.setup.buildStatus>>, { started: false }>;

const KIND_WORDS: Record<string, string> = { services: "Service drafts", booking: "Booking form preview", agreements: "Agreement drafts", standards: "Job standards" };

export function BuildStep({ preview, outcome }: { preview: Preview | null | undefined; outcome: Priority }) {
  if (!preview) return <Skeleton className="h-48 rounded-2xl" />;
  const items = [...preview.configure.map((kind) => ({ key: kind, agent: "sales" as AgentId, title: KIND_WORDS[kind] ?? kind, note: null as string | null })), ...preview.tasks.map((task) => ({ key: task.template, agent: task.agent as AgentId, title: task.title, note: task.startsBlocked ? task.blocker : null }))];
  return (
    <>
      <StepHeading id="step-heading" eyebrow="Step 4 · Build" title="Build my workspace" lead={preview.sentence} />
      <section className="grid gap-2" aria-labelledby="will-prepare">
        <h2 id="will-prepare" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          What will be prepared
        </h2>
        <ul className="grid gap-2">
          {items.map((item) => (
            <li key={item.key} className={cn("flex items-start gap-3 rounded-xl border border-border bg-white px-3.5 py-3 text-sm")}>
              <AgentAvatar agent={item.agent} size="xs" />
              <span className="min-w-0">
                <span className="block font-medium text-strong">{item.title}</span>
                {item.note ? <span className="block text-xs text-muted-foreground">Will wait: {item.note}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <Permissions outcome={outcome} />
      <Why>It runs in the background: you can leave, and it keeps going. Pressing it again, or refreshing, never makes a second copy of anything.</Why>
    </>
  );
}

