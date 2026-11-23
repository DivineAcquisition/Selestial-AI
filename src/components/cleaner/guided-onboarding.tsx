"use client";

/**
 * The guided onboarding a new cleaner lands on from their company's link. One focused column: the company's
 * name, logo and support contact, a personal welcome, progress counted from their own steps, one "Continue
 * setup" button, the next step open and finished steps folded away but always there to look at again.
 *
 * Each step is a purpose-built control (a signature panel, a code entry, a checklist, a guide with an
 * explicit agreement, pay cards, training), never an upload unless the company genuinely asked for a
 * document. Progress lives on the record, so closing the page, or opening the link on another phone,
 * resumes exactly where they were. Nothing on this page is decided by the page: every state comes from the
 * same steps the office sees (convex/lib/cleaners/steps.ts).
 *
 * `token` is null in the Owner's preview: the same screens render, and nothing can be sent.
 */
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import {
  BookOpen,
  CalendarIcon,
  CameraIcon,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Clock,
  FileText,
  Lock,
  Mail,
  MapPin,
  MessageSquareWarning,
  Phone,
  PlayCircle,
  SendIcon,
  ShieldCheck,
  Sparkles,
  Wallet,
  type LucideIcon,
} from "@/components/icons";
import { PlainDoc } from "@/components/public/plain-doc";
import { Checkbox } from "@/components/ui/selection";
import { cn } from "@/lib/utils";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Problem, problemWords } from "./shell";
import { fmt } from "./time";
import { TrainingHub } from "./training-hub";

export type GuidedView = NonNullable<FunctionReturnType<typeof api.cleanerOnboarding.view>>;
type Step = GuidedView["journey"]["steps"][number];

const STATE_CHIP: Record<Step["state"], { label: string; tone: string }> = {
  todo: { label: "To do", tone: "bg-brand-500/10 text-brand-700 dark:text-brand-300" },
  needs_changes: { label: "Needs a change", tone: "bg-amber-500/15 text-amber-800 dark:text-amber-300" },
  office_review: { label: "With the office", tone: "bg-sky-500/10 text-sky-800 dark:text-sky-300" },
  waiting_on_office: { label: "Waiting on the office", tone: "bg-muted text-muted-foreground" },
  done: { label: "Done", tone: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" },
  not_needed: { label: "Not needed", tone: "bg-muted text-muted-foreground" },
};

const JOURNEY: Record<GuidedView["journey"]["state"], { title: string; body: string; tone: string }> = {
  in_progress: { title: "Continue setup", body: "Your progress saves as you go. Come back to this link any time.", tone: "" },
  office_review: { title: "Office review", body: "Your steps are finished. The office is checking what you sent and will let you know.", tone: "border-sky-500/30 bg-sky-500/5" },
  steps_finished: { title: "Your steps are finished", body: "There is nothing more for you to do. The office makes your account active, and then job offers can start.", tone: "border-emerald-500/30 bg-emerald-500/5" },
  ready: { title: "Ready for assignments", body: "You can be offered jobs that match your hours and areas. Offers arrive by text or email.", tone: "border-emerald-500/30 bg-emerald-500/5" },
  not_active: { title: "Not active", body: "Your account is not active right now. Contact the office with any question.", tone: "border-border bg-muted/40" },
};

const STEP_ICON: Record<Step["type"], LucideIcon> = {
  signature: FileText,
  contact_verification: Phone,
  checklist: ClipboardList,
  guide_acknowledgment: BookOpen,
  payment_setup: Wallet,
  document_upload: CameraIcon,
  training: PlayCircle,
};

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Runs one action at a time; a refusal is shown in the server's own words. In the preview nothing runs. */
function useAct(live: boolean) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const act = async (name: string, work: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false;
    if (!live) {
      setProblem("This is a preview. Nothing is sent from here.");
      return false;
    }
    setBusy(name);
    setProblem(null);
    try {
      await work();
      return true;
    } catch (error) {
      setProblem(problemWords(error));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, problem, setProblem, act };
}

function Button({ kind = "primary", busy, disabled, onClick, children, testId, className }: { kind?: "primary" | "secondary" | "ghost"; busy?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode; testId?: string; className?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      className={cn(
        "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-50",
        kind === "primary" && "bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800",
        kind === "secondary" && "border border-border bg-background text-foreground hover:bg-muted",
        kind === "ghost" && "text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {busy ? (
        <>
          <span aria-hidden className="size-4 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin" />
          Saving…
        </>
      ) : (
        children
      )}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const inputClass = "h-12 w-full rounded-xl border border-border bg-background px-3 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20";

function Saved({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-2 rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-200">
      <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Aside({ icon: Icon = ShieldCheck, children }: { icon?: LucideIcon; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────────

export function GuidedOnboarding({ view, token, onOpenPortal }: { view: GuidedView; token: string | null; onOpenPortal?: () => void }) {
  const live = token !== null;
  const steps = view.focus ? view.journey.steps.filter((step) => step.keys.includes(view.focus!)) : view.journey.steps;
  const [open, setOpen] = useState<string | null>(view.focus ? (steps[0]?.id ?? null) : view.journey.next);
  const [training, setTraining] = useState(false);
  const refs = useRef(new Map<string, HTMLElement>());
  // When a step finishes, the next one opens by itself, so the cleaner always knows what is next.
  const lastNext = useRef(view.journey.next);
  useEffect(() => {
    if (view.journey.next !== lastNext.current) {
      const finished = lastNext.current;
      lastNext.current = view.journey.next;
      // Opening the next step as the record changes, so the cleaner never has to find it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpen((current) => (current === finished || current === null ? view.journey.next : current));
    }
  }, [view.journey.next]);

  const goTo = (id: string | null) => {
    if (!id) return;
    setOpen(id);
    requestAnimationFrame(() => {
      const node = refs.current.get(id);
      node?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      node?.querySelector<HTMLElement>("[data-step-heading]")?.focus();
    });
  };

  if (training && view.training.key) {
    return <TrainingHub view={view} token={token} onBack={() => setTraining(false)} />;
  }

  const percent = view.journey.total ? Math.round((view.journey.finished / view.journey.total) * 100) : 0;
  const status = JOURNEY[view.journey.state];
  const support = view.company.support;

  return (
    <div className="min-h-dvh bg-gradient-to-b from-brand-500/[0.06] via-background to-background">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-xl items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            {view.company.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={view.company.logoUrl} alt="" className="size-8 rounded-lg object-contain" />
            ) : (
              <span aria-hidden className="grid size-8 place-items-center rounded-lg text-sm font-bold text-white" style={{ background: view.company.brandColor ?? "var(--color-brand-600, #5b33d6)" }}>
                {view.company.name.slice(0, 1)}
              </span>
            )}
            <span className="truncate text-sm font-semibold" data-testid="company">
              {view.company.name}
            </span>
          </div>
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Onboarding</span>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-5 pb-16">
        {!live ? <p className="rounded-xl border border-dashed border-brand-500/40 bg-brand-500/5 px-3 py-2 text-center text-sm text-brand-800 dark:text-brand-200">Preview: this is what a new cleaner sees. Nothing can be sent from here.</p> : null}

        <section aria-labelledby="welcome" className="flex flex-col gap-4 rounded-3xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-2xl bg-brand-500/10 text-brand-600">
              <Sparkles className="size-6" />
            </span>
            <div className="min-w-0">
              <h1 id="welcome" className="text-2xl font-semibold tracking-tight">
                Welcome, {view.firstName}
              </h1>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{view.company.welcome ?? `A few short steps to get you ready to work with ${view.company.name}. Each one saves as you go.`}</p>
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span>
                {view.journey.finished} of {view.journey.total} steps finished
              </span>
              <span>{percent}%</span>
            </div>
            <div role="progressbar" aria-label="Your onboarding" aria-valuemin={0} aria-valuemax={view.journey.total} aria-valuenow={view.journey.finished} aria-valuetext={`${view.journey.finished} of ${view.journey.total} steps finished`} className="h-2.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-brand-600 motion-safe:transition-[width] motion-safe:duration-500" style={{ width: `${percent}%` }} />
            </div>
          </div>
          {view.journey.state === "in_progress" && view.journey.next ? (
            <Button testId="continue" onClick={() => goTo(view.journey.next)} className="w-full">
              Continue setup
            </Button>
          ) : (
            <div role="status" className={cn("rounded-2xl border p-4", status.tone)} data-testid="journey-state">
              <p className="flex items-center gap-2 font-semibold">
                {view.journey.state === "ready" || view.journey.state === "steps_finished" ? <CheckCircle2 aria-hidden className="size-5 text-emerald-600" /> : <Clock aria-hidden className="size-5 text-sky-600" />}
                {status.title}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{status.body}</p>
            </div>
          )}
        </section>

        <ol className="flex flex-col gap-3" aria-label="Your steps">
          {steps.map((step) => (
            <li
              key={step.id}
              ref={(node) => {
                if (node) refs.current.set(step.id, node);
              }}
              className="scroll-mt-20"
            >
              <StepCard step={step} open={open === step.id} onToggle={() => setOpen(open === step.id ? null : step.id)}>
                <StepBody step={step} view={view} token={token} onTraining={() => setTraining(true)} />
              </StepCard>
            </li>
          ))}
        </ol>

        {view.journey.state !== "in_progress" && !view.focus ? (
          <section className={cn("rounded-3xl border p-5 text-center", status.tone)}>
            <span aria-hidden className="mx-auto grid size-12 place-items-center rounded-full bg-emerald-500/15 text-emerald-700">
              <Check className="size-6" />
            </span>
            <h2 className="mt-3 text-lg font-semibold">{status.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{status.body}</p>
          </section>
        ) : null}

        <section aria-label="Help" className="rounded-2xl border border-border bg-card p-4 text-sm">
          <p className="font-medium">Questions? Contact {view.company.name}</p>
          <div className="mt-2 flex flex-col gap-1.5 text-muted-foreground">
            {support.phone ? (
              <a href={`tel:${support.phone}`} className="inline-flex items-center gap-2 font-medium text-foreground underline-offset-4 hover:underline">
                <Phone aria-hidden className="size-4" /> {support.phone}
              </a>
            ) : null}
            {support.email ? (
              <a href={`mailto:${support.email}`} className="inline-flex items-center gap-2 font-medium text-foreground underline-offset-4 hover:underline">
                <Mail aria-hidden className="size-4" /> {support.email}
              </a>
            ) : null}
            {support.hours ? <span>{support.hours}</span> : null}
            {!support.phone && !support.email ? <span>Reply to the message this link came in, and the office will help.</span> : null}
          </div>
        </section>

        <div className="flex flex-col items-center gap-2 text-center text-xs text-muted-foreground">
          <p>This link is only for you. It works until {fmt(view.expiresAt, view.timezone, { month: "short", day: "numeric" })}.</p>
          {onOpenPortal ? (
            <button type="button" onClick={onOpenPortal} className="font-medium text-foreground underline underline-offset-4">
              Open my full portal (jobs, hours and pay)
            </button>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function StepCard({ step, open, onToggle, children }: { step: Step; open: boolean; onToggle: () => void; children: ReactNode }) {
  const Icon = STEP_ICON[step.type];
  const chip = STATE_CHIP[step.state];
  const finished = step.state === "done" || step.state === "not_needed";
  const bodyId = useId();
  return (
    <article className={cn("overflow-hidden rounded-3xl border bg-card shadow-sm motion-safe:transition-colors", open ? "border-brand-500/40 ring-1 ring-brand-500/15" : finished ? "border-emerald-500/25" : "border-border", step.locked && "opacity-75")} data-testid={`step-${step.id}`} data-state={step.state}>
      <h2>
        <button type="button" data-step-heading aria-expanded={open} aria-controls={bodyId} onClick={onToggle} className="flex w-full items-start gap-3 p-4 text-left focus-visible:bg-muted/60 focus-visible:outline-none">
          <span aria-hidden className={cn("grid size-10 shrink-0 place-items-center rounded-2xl text-sm font-bold", finished ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : step.state === "office_review" ? "bg-sky-500/10 text-sky-700" : step.locked ? "bg-muted text-muted-foreground" : "bg-brand-500/10 text-brand-700 dark:text-brand-300")}>
            {finished ? <Check className="size-5" /> : step.number}
          </span>
          <span className="min-w-0 flex-1">
            <span className="sr-only">Step {step.number}: </span>
            <span className="block text-base leading-snug font-semibold">{step.title}</span>
            <span className="mt-1 flex flex-wrap items-center gap-2">
              <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", chip.tone)}>{step.locked ? "After step 2" : chip.label}</span>
              {step.blocksWork && !finished ? <span className="text-xs text-muted-foreground">Needed before your first job</span> : null}
            </span>
          </span>
          <Icon aria-hidden className={cn("mt-1 size-5 shrink-0", finished ? "text-emerald-600" : "text-muted-foreground")} />
          <ChevronDown aria-hidden className={cn("mt-1 size-5 shrink-0 text-muted-foreground motion-safe:transition-transform", open && "rotate-180")} />
        </button>
      </h2>
      <div id={bodyId} hidden={!open} className="flex flex-col gap-4 border-t border-border/70 px-4 pt-4 pb-5">
        {step.description ? <p className="text-sm text-muted-foreground">{step.description}</p> : null}
        {step.changes ? (
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <MessageSquareWarning aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-700" />
            <span>
              <span className="font-semibold">What to change: </span>
              {step.changes}
            </span>
          </div>
        ) : null}
        {open ? children : null}
      </div>
    </article>
  );
}

function StepBody({ step, view, token, onTraining }: { step: Step; view: GuidedView; token: string | null; onTraining: () => void }) {
  if (step.locked) return <Aside icon={Lock}>Verify your phone in step 2 first. Pay details are protected by that code.</Aside>;
  switch (step.type) {
    case "signature":
      return <AgreementStep step={step} view={view} token={token} />;
    case "contact_verification":
      return <ContactStep step={step} view={view} token={token} />;
    case "checklist":
      return <SuppliesStep view={view} token={token} />;
    case "guide_acknowledgment":
      return <GuideStep stepKey={step.id} view={view} token={token} />;
    case "payment_setup":
      return <PaymentStep step={step} view={view} token={token} />;
    case "document_upload":
      return <DocumentStep step={step} view={view} token={token} />;
    case "training":
      return <TrainingStep step={step} view={view} onOpen={onTraining} />;
  }
}

// ── 1. Agreement ─────────────────────────────────────────────────────────────────────────────────

function AgreementStep({ step, view, token }: { step: Step; view: GuidedView; token: string | null }) {
  const a = view.agreement;
  const sign = useMutation(api.cleanerOnboarding.signAgreement);
  const { busy, problem, act } = useAct(token !== null);
  const [name, setName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [showCopy, setShowCopy] = useState(false);
  const agreeId = useId();
  if (!a) return <Aside icon={Clock}>The office is preparing your agreement. You will see it here as soon as it is sent, and we will let you know.</Aside>;
  const facts = (
    <dl className="grid grid-cols-1 gap-2 rounded-2xl bg-muted/50 p-3 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-xs text-muted-foreground">Agreement</dt>
        <dd className="font-medium">{a.title}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Your role</dt>
        <dd className="font-medium">{a.role}</dd>
      </div>
      {a.pay ? (
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Approved pay</dt>
          <dd className="font-medium">{a.pay}</dd>
        </div>
      ) : null}
    </dl>
  );
  if (a.signedAt) {
    return (
      <>
        {facts}
        <Saved>
          You signed as {a.typedName} on {fmt(a.signedAt, view.timezone, { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}.
          {step.state === "office_review" ? ` Waiting for ${a.others.filter((o) => !o.signed).map((o) => o.name).join(" and ") || "the company"} to sign.` : " Every signer has signed."}
        </Saved>
        <Button kind="secondary" onClick={() => setShowCopy(!showCopy)}>
          <FileText aria-hidden className="size-4" /> {showCopy ? "Hide your signed copy" : "View your signed copy"}
        </Button>
        {showCopy && token ? <SignedCopy token={token} /> : null}
      </>
    );
  }
  if (!a.canSign || !a.markdown) {
    return (
      <>
        {facts}
        <Aside icon={Clock}>{a.hosted ? "This agreement can no longer be signed here. Ask the office for a new one." : "This agreement is signed through the signing service's email. Look for it in your inbox."}</Aside>
      </>
    );
  }
  return (
    <>
      {facts}
      <div className="max-h-[55vh] overflow-y-auto rounded-2xl border border-border bg-background p-4 text-[15px] leading-relaxed" tabIndex={0} aria-label={`${a.title}, version ${a.version}`}>
        <PlainDoc markdown={a.markdown} />
      </div>
      <p className="text-xs text-muted-foreground">
        Version {a.version}
        {a.expiresAt ? ` · sign by ${fmt(a.expiresAt, view.timezone, { month: "short", day: "numeric" })}` : ""}. Opening or scrolling this is not signing it.
      </p>
      <Field label="Type your full legal name to sign" hint="Your typed name is your electronic signature.">
        {(id) => <input id={id} value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" className={cn(inputClass, "font-medium")} data-testid="sign-name" />}
      </Field>
      <div className="flex items-start gap-3">
        <Checkbox id={agreeId} checked={agreed} onCheckedChange={setAgreed} className="mt-0.5" />
        <label htmlFor={agreeId} className="text-sm">
          {a.consent}
        </label>
      </div>
      <Problem message={problem} />
      <Button testId="sign" busy={busy === "sign"} disabled={!agreed || name.trim().length < 2} onClick={() => void act("sign", () => sign({ token: token!, typedName: name, hash: a.hash!, agreed, userAgent: navigator.userAgent.slice(0, 300) }))}>
        Sign agreement
      </Button>
    </>
  );
}

function SignedCopy({ token }: { token: string }) {
  const copy = useQuery(api.cleanerOnboarding.signedCopy, { token });
  if (copy === undefined) return <div aria-busy className="h-32 rounded-2xl bg-muted motion-safe:animate-pulse" />;
  if (copy === null) return <Aside>Your signed copy is not available yet.</Aside>;
  return (
    <div className="rounded-2xl border border-border bg-background p-4 text-[15px] leading-relaxed">
      <PlainDoc markdown={copy.markdown} />
      <div className="mt-4 border-t border-border pt-3 text-sm">
        <p className="font-semibold">Signatures</p>
        {copy.signatures.map((row) => (
          <p key={`${row.role}-${row.name}`} className="text-muted-foreground">
            {row.name} ({row.role}): {row.typedName ? `signed as "${row.typedName}"` : "not signed yet"}
            {row.at ? `, ${new Date(row.at).toLocaleString()}` : ""}
          </p>
        ))}
        <p className="mt-2 text-xs text-muted-foreground">Version {copy.version} · fingerprint {copy.hash.slice(0, 12)}</p>
      </div>
      <Button kind="secondary" className="mt-3 w-full" onClick={() => window.print()}>
        Print or save as PDF
      </Button>
    </div>
  );
}

// ── 2. Phone and details ─────────────────────────────────────────────────────────────────────────

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ORDER = [1, 2, 3, 4, 5, 6, 0];
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const toMinute = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

function ContactStep({ step, view, token }: { step: Step; view: GuidedView; token: string | null }) {
  const send = useMutation(api.cleanerOnboarding.sendPhoneCode);
  const verify = useMutation(api.cleanerOnboarding.verifyPhone);
  const texts = useMutation(api.cleanerOnboarding.workTexts);
  const confirmWithout = useMutation(api.portal.confirmContact);
  const setWeek = useMutation(api.portal.setAvailability);
  const { busy, problem, act } = useAct(token !== null);
  const c = view.contact;
  const [phone, setPhone] = useState(c.phone ?? "");
  const [email, setEmail] = useState(c.email ?? "");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [noText, setNoText] = useState(false);
  const [optIn, setOptIn] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const initial = Object.fromEntries(ORDER.map((day) => [day, c.windows.find((row) => row.weekday === day) ?? null])) as Record<number, { startMinute: number; endMinute: number } | null>;
  const [week, setWeekState] = useState(initial);
  const [areas, setAreas] = useState(c.areas.join(", "));
  const optInId = useId();
  const verified = c.phoneVerifiedAt !== null;
  const hoursOpen = step.open.some((label) => /availability|hours/i.test(label)) || (c.asksHours && c.windows.length === 0);
  const areasOpen = step.open.some((label) => /area/i.test(label)) || (c.asksAreas && c.areas.length === 0);

  return (
    <>
      <section aria-label="Mobile number" className="flex flex-col gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Phone aria-hidden className="size-4 text-brand-600" /> Your mobile number
        </h3>
        {verified ? (
          <Saved>Verified: {c.phone}. Dispatch uses this number for job offers.</Saved>
        ) : (
          <>
            <Field label="Mobile number" hint="We text a 6-digit code to prove the phone is yours. Fix the number here if it is wrong.">
              {(id) => <input id={id} value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" className={inputClass} data-testid="phone" />}
            </Field>
            {sentTo ? (
              <>
                <Field label={`Code sent to ${sentTo}`} hint="It works for 10 minutes. You have 5 tries.">
                  {(id) => <input id={id} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="••••••" className={cn(inputClass, "text-center text-2xl tracking-[0.5em]")} data-testid="code" />}
                </Field>
                <Button testId="verify" busy={busy === "verify"} disabled={code.length !== 6} onClick={() => void act("verify", async () => { const result = await verify({ token: token!, code, email: email || undefined }); setSaved(result.emailPending ? "Phone verified. The office will check your new email." : "Phone verified. Thank you."); setSentTo(null); setCode(""); })}>
                  Verify phone
                </Button>
                <div className="flex flex-wrap justify-between gap-2 text-sm">
                  <button type="button" className="font-medium text-brand-700 underline-offset-4 hover:underline dark:text-brand-300" onClick={() => void act("send", async () => setSentTo((await send({ token: token!, phone })).sentTo))}>
                    Send a new code
                  </button>
                  <button type="button" className="text-muted-foreground underline-offset-4 hover:underline" onClick={() => { setSentTo(null); setCode(""); }}>
                    Change the number
                  </button>
                </div>
              </>
            ) : (
              <Button testId="send-code" busy={busy === "send"} disabled={phone.replace(/\D/g, "").length < 10} onClick={() => void act("send", async () => { try { setSentTo((await send({ token: token!, phone })).sentTo); } catch (error) { if (problemWords(error).startsWith("We could not text")) setNoText(true); throw error; } })}>
                <SendIcon aria-hidden className="size-4" /> Text me a code
              </Button>
            )}
            {noText ? (
              <Button kind="secondary" busy={busy === "without"} onClick={() => void act("without", async () => { await confirmWithout({ token: token!, phone, email: email || undefined, workTexts: false }); setSaved("Sent to the office to check."); })}>
                Confirm without a code
              </Button>
            ) : null}
          </>
        )}
      </section>

      <section aria-label="Email" className="flex flex-col gap-3">
        <Field label="Email" hint={verified ? "To change it, tell the office." : "Change it here if it is wrong; the office checks a new address."}>
          {(id) => <input id={id} type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" disabled={verified} className={inputClass} />}
        </Field>
      </section>

      <section aria-label="Work texts" className="flex items-start gap-3 rounded-2xl bg-muted/40 p-3">
        <Checkbox id={optInId} checked={optIn} onCheckedChange={(next) => { setOptIn(next); void act("texts", () => texts({ token: token!, agree: next })); }} className="mt-0.5" />
        <label htmlFor={optInId} className="text-sm">
          <span className="font-medium">Optional: </span>
          {c.textsWording}
          <span className="block text-xs text-muted-foreground">Separate from verifying your phone. You can change it any time.</span>
        </label>
      </section>

      {hoursOpen ? (
        <section aria-label="Weekly availability" className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <CalendarIcon aria-hidden className="size-4 text-brand-600" /> The days and hours you can work
          </h3>
          {ORDER.map((day) => {
            const window = week[day];
            return (
              <div key={day} className="flex min-h-11 items-center gap-2">
                <label className="flex w-20 items-center gap-2 text-sm font-medium">
                  <Checkbox checked={Boolean(window)} onCheckedChange={(checked) => setWeekState({ ...week, [day]: checked ? { startMinute: 8 * 60, endMinute: 17 * 60 } : null })} />
                  {DAYS[day]}
                </label>
                {window ? (
                  <span className="flex flex-1 items-center gap-1.5">
                    <input type="time" aria-label={`${DAYS[day]} from`} value={toTime(window.startMinute)} onChange={(event) => setWeekState({ ...week, [day]: { ...window, startMinute: toMinute(event.target.value) } })} className="h-11 flex-1 rounded-lg border border-border bg-background px-2 text-base" />
                    <span aria-hidden className="text-muted-foreground">–</span>
                    <input type="time" aria-label={`${DAYS[day]} until`} value={toTime(window.endMinute)} onChange={(event) => setWeekState({ ...week, [day]: { ...window, endMinute: toMinute(event.target.value) } })} className="h-11 flex-1 rounded-lg border border-border bg-background px-2 text-base" />
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">Not working</span>
                )}
              </div>
            );
          })}
          {areasOpen ? (
            <Field label="ZIP codes you will travel to" hint="Separate them with commas.">
              {(id) => (
                <span className="relative">
                  <MapPin aria-hidden className="absolute top-3.5 left-3 size-5 text-muted-foreground" />
                  <input id={id} value={areas} onChange={(event) => setAreas(event.target.value)} inputMode="numeric" className={cn(inputClass, "pl-10")} />
                </span>
              )}
            </Field>
          ) : null}
          <Button kind="secondary" busy={busy === "hours"} onClick={() => void act("hours", async () => { await setWeek({ token: token!, windows: ORDER.flatMap((day) => (week[day] ? [{ weekday: day, ...week[day]! }] : [])), areas: areasOpen ? areas.split(/[,\s]+/).filter(Boolean) : undefined }); setSaved("Hours saved."); })}>
            Save my hours
          </Button>
        </section>
      ) : null}
      <Problem message={problem} />
      {saved ? <Saved>{saved}</Saved> : null}
    </>
  );
}

// ── 3. Supplies ──────────────────────────────────────────────────────────────────────────────────

const CATEGORY_WORDS: Record<string, string> = { solutions: "Cleaning solutions", tools: "Tools", safety: "Safety", specialty: "Specialty equipment" };

function SuppliesStep({ view, token }: { view: GuidedView; token: string | null }) {
  const submit = useMutation(api.cleanerOnboarding.submitSupplies);
  const { busy, problem, act } = useAct(token !== null);
  const s = view.supplies!;
  const [answers, setAnswers] = useState<Record<string, "have" | "missing">>(s.answers);
  const [saved, setSaved] = useState<string | null>(null);
  const asked = s.items.filter((item) => item.provider === "cleaner");
  const provided = s.items.filter((item) => item.provider === "company");
  const groups = useMemo(() => {
    const out = new Map<string, typeof asked>();
    for (const item of asked) out.set(item.category, [...(out.get(item.category) ?? []), item]);
    return [...out.entries()];
  }, [asked]);
  const answered = asked.filter((item) => answers[item.id]).length;
  const set = (id: string, answer: "have" | "missing") => setAnswers({ ...answers, [id]: answer });
  return (
    <>
      <Aside icon={Info}>Tick what you already own. Missing something is fine: answer truthfully, and the office {s.rule === "required_for_visit" ? "only offers you visits you have the supplies for" : "sees what you have when planning visits"}.</Aside>
      {provided.length ? (
        <div className="rounded-2xl bg-muted/40 p-3 text-sm">
          <p className="font-medium">{view.company.name} provides</p>
          <p className="text-muted-foreground">{provided.map((item) => item.label).join(", ")}</p>
        </div>
      ) : null}
      {groups.map(([category, items]) => (
        <fieldset key={category} className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">
            {CATEGORY_WORDS[category] ?? category}
            {category === "specialty" ? <span className="block text-xs font-normal text-muted-foreground">Only for some kinds of work, shown under each item.</span> : null}
          </legend>
          {category === "specialty" ? (
            <button type="button" className="self-start text-xs font-medium text-muted-foreground underline underline-offset-4" onClick={() => setAnswers({ ...answers, ...Object.fromEntries(items.map((item) => [item.id, answers[item.id] ?? "missing"])) })}>
              I don&apos;t have any of these yet
            </button>
          ) : null}
          {items.map((item) => (
            <div key={item.id} role="radiogroup" aria-label={item.label} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border p-3">
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-medium">{item.label}</span>
                {item.forServices.length ? <span className="block text-xs text-muted-foreground">For {item.forServices.join(", ")} work</span> : null}
                {!item.required ? <span className="block text-xs text-muted-foreground">Nice to have</span> : null}
              </span>
              <span className="flex gap-1.5">
                {(["have", "missing"] as const).map((answer) => (
                  <button key={answer} type="button" role="radio" aria-checked={answers[item.id] === answer} onClick={() => set(item.id, answer)} className={cn("min-h-11 rounded-xl border px-3 text-sm font-medium", answers[item.id] === answer ? (answer === "have" ? "border-emerald-600 bg-emerald-600 text-white" : "border-foreground/70 bg-foreground/80 text-background") : "border-border bg-background")}>
                    {answer === "have" ? "I have it" : "Not yet"}
                  </button>
                ))}
              </span>
            </div>
          ))}
        </fieldset>
      ))}
      <Problem message={problem} />
      {saved ? <Saved>{saved}</Saved> : null}
      <Button testId="save-supplies" busy={busy === "supplies"} disabled={answered < asked.length} onClick={() => void act("supplies", async () => { const result = await submit({ token: token!, answers }); setSaved(`Saved: ${result.have} you have, ${result.missing} not yet.`); })}>
        {answered < asked.length ? `Answer all items (${answered} of ${asked.length})` : s.submittedAt ? "Update my supplies" : "Save my supplies"}
      </Button>
    </>
  );
}

const Info = ShieldCheck;

// ── 4 and 5. Guides ──────────────────────────────────────────────────────────────────────────────

const STAGE_ICONS: LucideIcon[] = [Mail, Check, FileText, MapPin, MessageSquareWarning, ClipboardList, CameraIcon, Wallet];

function GuideStep({ stepKey, view, token }: { stepKey: string; view: GuidedView; token: string | null }) {
  const guide = view.guides.find((row) => row.key === stepKey)!;
  const acknowledgeGuide = useMutation(api.cleanerOnboarding.acknowledgeGuide);
  const acknowledgeWords = useMutation(api.portal.acknowledge);
  const { busy, problem, act } = useAct(token !== null);
  const [agreed, setAgreed] = useState(false);
  const agreeId = useId();
  const journey = stepKey === "job_day";
  return (
    <>
      {guide.intro ? <p className="text-sm">{guide.intro}</p> : null}
      {guide.imageUrl ? (
        <figure className="overflow-hidden rounded-2xl border border-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={guide.imageUrl} alt={guide.imageAlt ?? `${guide.title}. The same content is written out below.`} className="w-full" />
        </figure>
      ) : null}
      {journey ? (
        <ol className="relative flex flex-col gap-0" aria-label={guide.title}>
          {guide.sections.map((section, index) => {
            const Icon = STAGE_ICONS[index % STAGE_ICONS.length];
            return (
              <li key={section.title} className="relative flex gap-3 pb-4 last:pb-0">
                {index < guide.sections.length - 1 ? <span aria-hidden className="absolute top-10 bottom-0 left-5 w-px bg-brand-500/25" /> : null}
                <span aria-hidden className="relative z-10 grid size-10 shrink-0 place-items-center rounded-full border border-brand-500/30 bg-background text-brand-600">
                  <Icon className="size-5" />
                </span>
                <div className="min-w-0 pt-1.5">
                  <p className="text-sm font-semibold">
                    <span className="text-muted-foreground">{index + 1}. </span>
                    {section.title}
                  </p>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{section.body}</p>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {guide.sections.map((section) => (
            <div key={section.title} className="rounded-2xl border border-border bg-background p-3">
              {"imageUrl" in section && section.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={section.imageUrl} alt={section.imageAlt ?? ""} className="mb-2 w-full rounded-xl" />
              ) : null}
              <p className="text-sm font-semibold">{section.title}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{section.body}</p>
            </div>
          ))}
        </div>
      )}
      {guide.agreedAt ? (
        <Saved>You agreed on {fmt(guide.agreedAt, view.timezone, { month: "long", day: "numeric" })}.</Saved>
      ) : (
        <>
          <div className="flex items-start gap-3 rounded-2xl border border-border p-3">
            <Checkbox id={agreeId} checked={agreed} onCheckedChange={setAgreed} className="mt-0.5" />
            <label htmlFor={agreeId} className="text-sm font-medium">
              {guide.agreeLabel}
            </label>
          </div>
          <Problem message={problem} />
          <Button testId={`agree-${stepKey}`} busy={busy === "agree"} disabled={!agreed} onClick={() => void act("agree", () => (guide.hash ? acknowledgeGuide({ token: token!, key: stepKey, hash: guide.hash, agreed }) : acknowledgeWords({ token: token!, key: stepKey, words: ("words" in guide ? guide.words : "") ?? "" })))}>
            Confirm
          </Button>
        </>
      )}
    </>
  );
}

// ── 6. Pay, and the tax document behind it ───────────────────────────────────────────────────────

function PaymentStep({ step, view, token }: { step: Step; view: GuidedView; token: string | null }) {
  const p = view.payment;
  const request = useMutation(api.portal.requestCode);
  const verifyCode = useMutation(api.portal.verifyCode);
  const setPayout = useMutation(api.cleanerOnboarding.setPayout);
  const { busy, problem, act } = useAct(token !== null);
  const [method, setMethod] = useState<string>(p.current?.method ?? "");
  const [handle, setHandle] = useState(p.current?.handle ?? "");
  const [mailing, setMailing] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const preview = token === null;

  if (!view.verified && !preview) {
    return (
      <>
        <Aside icon={Lock}>Pay and tax details are private. To open them, we send a code to your verified phone. It works for 10 minutes.</Aside>
        {sentTo ? (
          <>
            <Field label={`Code sent to ${sentTo}`}>{(id) => <input id={id} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" className={cn(inputClass, "text-center text-2xl tracking-[0.5em]")} />}</Field>
            <Button busy={busy === "unlock"} disabled={code.length !== 6} onClick={() => void act("unlock", () => verifyCode({ token: token!, code }))}>
              Open pay setup
            </Button>
          </>
        ) : (
          <Button busy={busy === "code"} onClick={() => void act("code", async () => setSentTo((await request({ token: token! })).sentTo))}>
            Send me a code
          </Button>
        )}
        <Problem message={problem} />
      </>
    );
  }

  const chosen = p.methods.find((m) => m.id === method);
  return (
    <>
      <div className="rounded-2xl bg-muted/50 p-3 text-sm">
        <p className="font-medium">When you are paid</p>
        <p className="text-muted-foreground">{p.schedule}</p>
        {p.pay ? <p className="mt-2 text-muted-foreground">Your approved pay: <span className="font-medium text-foreground">{p.pay}</span></p> : null}
        {p.instructions ? <p className="mt-2 text-muted-foreground">{p.instructions}</p> : null}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">How would you like to be paid?</legend>
        <div role="radiogroup" aria-label="Payment method" className="grid gap-2">
          {p.methods.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={method === m.id} onClick={() => setMethod(m.id)} className={cn("flex min-h-14 items-start gap-3 rounded-2xl border p-3 text-left", method === m.id ? "border-brand-600 bg-brand-500/5 ring-1 ring-brand-600/30" : "border-border bg-background")}>
              <span aria-hidden className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2", method === m.id ? "border-brand-600" : "border-muted-foreground/40")}>{method === m.id ? <span className="size-2.5 rounded-full bg-brand-600" /> : null}</span>
              <span>
                <span className="block text-sm font-semibold">{m.label}</span>
                <span className="block text-xs text-muted-foreground">{m.detail}</span>
              </span>
            </button>
          ))}
        </div>
      </fieldset>
      {method === "zelle" ? <Field label="Email or mobile number registered with Zelle">{(id) => <input id={id} value={handle} onChange={(event) => setHandle(event.target.value)} autoComplete="off" className={inputClass} />}</Field> : null}
      {method === "venmo" ? <Field label="Venmo username">{(id) => <input id={id} value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="@your-name" autoComplete="off" className={inputClass} />}</Field> : null}
      {method === "check" ? <Field label="Mailing address for checks">{(id) => <input id={id} value={mailing} onChange={(event) => setMailing(event.target.value)} autoComplete="street-address" className={inputClass} />}</Field> : null}
      <Aside icon={ShieldCheck}>This records how you would like to be paid. The office confirms it before your first payment, and pays on the pay run. Bank account and tax numbers are never typed into a note.</Aside>
      {p.current ? <Saved>{p.current.status === "confirmed" ? `${p.current.label} is confirmed by the office.` : `${p.current.label} is recorded. The office will confirm it.`}</Saved> : null}
      <Problem message={problem} />
      {saved ? <Saved>{saved}</Saved> : null}
      <Button testId="save-payout" busy={busy === "payout"} disabled={!chosen} onClick={() => void act("payout", async () => { await setPayout({ token: token!, method, handle: handle || undefined, mailingAddress: mailing || undefined }); setSaved("Saved. The office will confirm it before your first payment."); })}>
        {p.current ? "Update how I get paid" : "Save how I get paid"}
      </Button>
      {p.tax ? <TaxSection view={view} token={token} stepState={step.state} /> : null}
    </>
  );
}

function TaxSection({ view, token, stepState }: { view: GuidedView; token: string | null; stepState: Step["state"] }) {
  const tax = view.payment.tax!;
  const save = useMutation(api.cleanerOnboarding.saveTaxInfo);
  const certify = useMutation(api.cleanerOnboarding.certifyTax);
  const { busy, problem, act } = useAct(token !== null);
  const [form, setForm] = useState({ legalName: tax.legalName ?? "", businessName: "", tinType: (tax.tinType ?? "ssn") as "ssn" | "ein" | "itin", tin: "", line1: "", city: "", state: "", postalCode: "" });
  const [typed, setTyped] = useState("");
  const [agreed, setAgreed] = useState(false);
  const certId = useId();
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });
  void stepState;
  if (tax.form !== "w9" || tax.status === "not_applicable") return null;
  const wrap = (children: ReactNode) => (
    <section aria-label="Tax document" className="mt-2 flex flex-col gap-3 rounded-2xl border border-border p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck aria-hidden className="size-4 text-brand-600" /> Tax details for your W-9
      </h3>
      {children}
    </section>
  );
  if (tax.status === "completed") return wrap(<Saved>Your tax document is complete. Nothing else is needed.</Saved>);
  if (tax.status === "preparing") return wrap(<Aside icon={Clock}>Thanks. Your tax document is being prepared from what you certified. Nothing else is needed from you.</Aside>);
  if (tax.status === "failed") return wrap(<Aside icon={Clock}>The office is finishing your tax document. Nothing is needed from you unless they ask.</Aside>);
  if (!tax.secureReady) return wrap(<Aside icon={Clock}>The office will contact you about your tax document. Nothing is needed from you here.</Aside>);
  if (tax.status === "awaiting_confirmation") {
    return wrap(
      <>
        <p className="text-sm text-muted-foreground">
          {tax.legalName} · {tax.tinType?.toUpperCase()} ending {tax.tinLast4}. Read the certification and sign it with your name.
        </p>
        <p className="max-h-48 overflow-y-auto rounded-xl bg-muted/50 p-3 text-xs leading-relaxed" tabIndex={0}>
          {tax.certification}
        </p>
        <Field label="Type your legal name to certify">{(id) => <input id={id} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" className={inputClass} />}</Field>
        <div className="flex items-start gap-3">
          <Checkbox id={certId} checked={agreed} onCheckedChange={setAgreed} className="mt-0.5" />
          <label htmlFor={certId} className="text-sm">I certify the statements above are true.</label>
        </div>
        <Problem message={problem} />
        <Button busy={busy === "certify"} disabled={!agreed || typed.trim().length < 2} onClick={() => void act("certify", () => certify({ token: token!, typedName: typed, agreed }))}>
          Certify and finish
        </Button>
        <button type="button" className="self-start text-xs text-muted-foreground underline underline-offset-4" onClick={() => void act("edit", () => Promise.resolve())}>
          To change your details, fill the form in again below.
        </button>
        <TaxForm form={form} set={set} setForm={setForm} busy={busy} onSave={() => void act("save", () => save({ token: token!, ...form }))} compact />
      </>,
    );
  }
  return wrap(
    <>
      <p className="text-sm text-muted-foreground">The company needs a W-9 to report what it pays you. Give your details once here; the form is prepared for you, and you sign it. Only the last four digits of your number are ever shown again.</p>
      <TaxForm form={form} set={set} setForm={setForm} busy={busy} onSave={() => void act("save", () => save({ token: token!, ...form }))} />
      <Problem message={problem} />
    </>,
  );
}

type TaxFormState = { legalName: string; businessName: string; tinType: "ssn" | "ein" | "itin"; tin: string; line1: string; city: string; state: string; postalCode: string };

function TaxForm({ form, set, setForm, busy, onSave, compact }: { form: TaxFormState; set: (key: keyof TaxFormState) => (value: string) => void; setForm: (form: TaxFormState) => void; busy: string | null; onSave: () => void; compact?: boolean }) {
  const [show, setShow] = useState(!compact);
  if (!show) return null;
  return (
    <div className="flex flex-col gap-3">
      <Field label="Legal name (as on your tax return)">{(id) => <input id={id} value={form.legalName} onChange={(event) => set("legalName")(event.target.value)} autoComplete="name" className={inputClass} />}</Field>
      <Field label="Business name (optional)">{(id) => <input id={id} value={form.businessName} onChange={(event) => set("businessName")(event.target.value)} autoComplete="organization" className={inputClass} />}</Field>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">Taxpayer number type</legend>
        <div role="radiogroup" aria-label="Taxpayer number type" className="grid grid-cols-3 gap-2">
          {(["ssn", "itin", "ein"] as const).map((type) => (
            <button key={type} type="button" role="radio" aria-checked={form.tinType === type} onClick={() => setForm({ ...form, tinType: type })} className={cn("min-h-11 rounded-xl border text-sm font-semibold", form.tinType === type ? "border-brand-600 bg-brand-500/5" : "border-border")}>
              {type.toUpperCase()}
            </button>
          ))}
        </div>
      </fieldset>
      <Field label="Number" hint="9 digits. Sealed when saved; only the last four are shown again.">
        {(id) => <input id={id} value={form.tin} onChange={(event) => set("tin")(event.target.value.replace(/[^\d-]/g, "").slice(0, 11))} inputMode="numeric" autoComplete="off" type="password" className={inputClass} />}
      </Field>
      <Field label="Street address">{(id) => <input id={id} value={form.line1} onChange={(event) => set("line1")(event.target.value)} autoComplete="address-line1" className={inputClass} />}</Field>
      <div className="grid grid-cols-[1fr_5rem_7rem] gap-2">
        <Field label="City">{(id) => <input id={id} value={form.city} onChange={(event) => set("city")(event.target.value)} autoComplete="address-level2" className={inputClass} />}</Field>
        <Field label="State">{(id) => <input id={id} value={form.state} onChange={(event) => set("state")(event.target.value.slice(0, 2))} autoComplete="address-level1" className={cn(inputClass, "uppercase")} />}</Field>
        <Field label="ZIP">{(id) => <input id={id} value={form.postalCode} onChange={(event) => set("postalCode")(event.target.value)} inputMode="numeric" autoComplete="postal-code" className={inputClass} />}</Field>
      </div>
      <Button kind={compact ? "secondary" : "primary"} busy={busy === "save"} disabled={!form.legalName || form.tin.replace(/\D/g, "").length !== 9 || !form.line1 || !form.city || form.state.length !== 2 || !form.postalCode} onClick={onSave}>
        Save tax details
      </Button>
      {compact ? (
        <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setShow(false)}>
          Cancel
        </button>
      ) : null}
    </div>
  );
}

// ── A document the company genuinely needs ───────────────────────────────────────────────────────

function DocumentStep({ step, view, token }: { step: Step; view: GuidedView; token: string | null }) {
  const doc = view.documents.find((row) => row.key === step.id);
  const uploadUrl = useMutation(api.portal.uploadUrl);
  const submit = useMutation(api.portal.submitRequirement);
  const { busy, problem, act } = useAct(token !== null);
  const [files, setFiles] = useState<File[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  if (step.state === "office_review") return <Aside icon={Clock}>Sent. The office checks it; nothing counts until they do.</Aside>;
  if (step.state === "done") return <Saved>Accepted by the office.</Saved>;
  return (
    <>
      <Aside icon={FileText}>The company needs a copy of this document. A clear photo or a PDF works.</Aside>
      <label className="flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed border-border px-3 text-sm font-medium focus-within:ring-2 focus-within:ring-brand-500">
        <CameraIcon aria-hidden className="size-5" />
        {files.length ? `${files.length} ${files.length === 1 ? "file" : "files"} chosen` : "Take a photo or choose a file"}
        <input type="file" accept="application/pdf,image/*" multiple className="sr-only" onChange={(event) => setFiles([...(event.target.files ?? [])].slice(0, 5))} />
      </label>
      <Problem message={problem} />
      {saved ? <Saved>{saved}</Saved> : null}
      <Button busy={busy === "upload"} disabled={files.length === 0} onClick={() => void act("upload", async () => { const storageIds: Id<"_storage">[] = []; for (const file of files) { const response = await fetch(await uploadUrl({ token: token! }), { method: "POST", headers: { "Content-Type": file.type }, body: file }); storageIds.push(((await response.json()) as { storageId: Id<"_storage"> }).storageId); } await submit({ token: token!, key: step.id, storageIds }); setSaved("Sent. The office will check it."); })}>
        Send {doc?.label.toLowerCase() ?? "document"}
      </Button>
    </>
  );
}

// ── 7. Training ──────────────────────────────────────────────────────────────────────────────────

function TrainingStep({ step, view, onOpen }: { step: Step; view: GuidedView; onOpen: () => void }) {
  const modules = view.training.modules;
  const required = modules.filter((m) => m.required);
  const done = required.filter((m) => m.completedAt).length;
  if (modules.length === 0) return <Aside icon={Clock}>The office will arrange your training and record it here.</Aside>;
  return (
    <>
      <ul className="flex flex-col gap-2">
        {modules.map((m) => (
          <li key={m.key} className="flex items-center gap-3 rounded-2xl border border-border p-3">
            <span aria-hidden className={cn("grid size-9 shrink-0 place-items-center rounded-xl", m.completedAt ? "bg-emerald-500/15 text-emerald-700" : "bg-brand-500/10 text-brand-600")}>{m.completedAt ? <Check className="size-5" /> : m.kind === "video" ? <PlayCircle className="size-5" /> : <BookOpen className="size-5" />}</span>
            <span className="min-w-0 flex-1 text-sm">
              <span className="block font-medium">{m.title}</span>
              <span className="block text-xs text-muted-foreground">
                {m.kind === "video" ? "Video" : "Guide with questions"}
                {m.minutes ? ` · about ${m.minutes} min` : ""} · {m.required ? "Required" : "Optional"}
                {m.completedAt ? " · Completed" : m.kind === "guide" && m.sectionsRead.length ? ` · ${m.sectionsRead.length} of ${m.sections?.length ?? 0} read` : ""}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        {done} of {required.length} required {required.length === 1 ? "module" : "modules"} complete. A video counts once it plays to the end; a guide once every section is read and its questions answered. Skipping does not count.
      </p>
      <Button testId="open-training" onClick={onOpen}>
        <PlayCircle aria-hidden className="size-5" /> {step.state === "done" ? "Open training again" : done > 0 ? "Continue training" : "Start training"}
      </Button>
    </>
  );
}
