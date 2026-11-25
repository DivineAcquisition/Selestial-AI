/**
 * Drawn illustrations of Selestial at work, used instead of product screenshots on the Founding Access page.
 * Each shows work the product supports today; every name, price and time is made up, and every picture is
 * labelled "Illustration · demonstration data" where it appears. Decorative to screen readers: each carries
 * one plain-language description (role="img" + aria-label) in place of its contents.
 */
import Image from "next/image";
import type { ReactNode } from "react";

import { LogoGlyph } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

type Agent = "sales" | "dispatch" | "recruiter" | "retention";

function Face({ agent, size = 28 }: { agent: Agent; size?: number }) {
  return <Image src={`/agents/${agent}.webp`} alt="" width={size * 2} height={size * 2} className="shrink-0 rounded-full ring-2 ring-white" style={{ width: size, height: size }} />;
}

function Owner({ size = 28 }: { size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-full bg-[#1d1240] text-white ring-2 ring-white" style={{ width: size, height: size }}>
      <svg viewBox="0 0 16 16" className="size-[55%]" fill="currentColor" aria-hidden>
        <circle cx="8" cy="5.2" r="2.9" />
        <path d="M2.6 14c.5-3 2.7-4.7 5.4-4.7s4.9 1.7 5.4 4.7z" />
      </svg>
    </span>
  );
}

type Tone = "done" | "working" | "you" | "queued";
const TONES: Record<Tone, string> = {
  done: "bg-emerald-50 text-emerald-700 ring-emerald-600/15",
  working: "bg-[#f1ecff] text-[#5126c7] ring-[#6838ef]/20",
  you: "bg-amber-50 text-amber-800 ring-amber-600/20",
  queued: "bg-slate-50 text-slate-600 ring-slate-500/15",
};
function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1", TONES[tone])}>
      {tone === "working" ? <span aria-hidden className="size-1.5 rounded-full bg-[#6838ef]" /> : null}
      {tone === "done" ? (
        <svg aria-hidden viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      ) : null}
      {children}
    </span>
  );
}

/** The frame every illustration sits in: a soft white card on a lavender field, with a tiny title bar. */
function Frame({ label, title, children, className }: { label: string; title: string; children: ReactNode; className?: string }) {
  return (
    <div role="img" aria-label={label} className={cn("relative overflow-hidden rounded-2xl border border-[#e7e1fb] bg-white shadow-[0_24px_60px_-34px_rgba(81,38,199,0.45)]", className)}>
      <div aria-hidden className="flex items-center gap-2 border-b border-[#efeafd] bg-[#fbfaff] px-3.5 py-2.5">
        <span className="flex gap-1">
          <span className="size-2 rounded-full bg-[#e3dcfb]" />
          <span className="size-2 rounded-full bg-[#e3dcfb]" />
          <span className="size-2 rounded-full bg-[#e3dcfb]" />
        </span>
        <span className="ml-1 text-[11px] font-medium text-[#6b6488]">{title}</span>
      </div>
      <div aria-hidden className="p-4">
        {children}
      </div>
    </div>
  );
}

// ── Walkthrough ──────────────────────────────────────────────────────────────────────────────────

function Inquiry() {
  return (
    <div className="grid gap-2.5 text-[13px] leading-snug">
      <div className="max-w-[88%] rounded-2xl rounded-bl-md bg-slate-100 px-3 py-2 text-slate-800">Hi! 3 bed, 2 bath and a very dirty oven. Could you come Friday?</div>
      <div className="ml-auto flex max-w-[92%] items-end gap-2">
        <div className="rounded-2xl rounded-br-md bg-[#6838ef] px-3 py-2 text-white">
          A deep clean with the oven is <b>$285</b>, from your price list. Friday 9:00 is open. Shall I book it?
        </div>
        <Face agent="sales" size={24} />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 rounded-xl border border-[#efeafd] px-3 py-2">
        <span className="text-[12px] text-[#6b6488]">Quote within your pricing rules</span>
        <Chip tone="done">Sent</Chip>
      </div>
    </div>
  );
}

function Booking() {
  const rows = [
    ["Service", "Deep clean + oven"],
    ["When", "Friday · arrives 9:00–10:00"],
    ["Where", "Oak St · 3 bed, 2 bath"],
    ["Price", "$285 · pay after the visit"],
  ];
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-emerald-50 text-emerald-600 ring-1 ring-emerald-600/15">
          <svg viewBox="0 0 16 16" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3.5 8.5l3 3 6-7" />
          </svg>
        </span>
        <div>
          <p className="font-heading text-[15px] text-strong">Booking confirmed</p>
          <p className="text-[12px] text-[#6b6488]">One confirmation sent to the customer</p>
        </div>
      </div>
      <dl className="grid gap-1.5 rounded-xl bg-[#fbfaff] p-3 text-[12.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-[#6b6488]">{k}</dt>
            <dd className="text-right font-medium text-strong">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center gap-2 text-[12px] text-[#6b6488]">
        <Face agent="sales" size={20} />
        Handed to Dispatch for coverage
      </div>
    </div>
  );
}

function Dispatch() {
  const options = [
    { name: "Maria R.", why: "Usual cleaner · 4 mi", tone: "done" as const, state: "Accepted" },
    { name: "Priya S.", why: "Available · 6 mi", tone: "queued" as const, state: "Next" },
    { name: "Jo T.", why: "Not enough time between jobs", tone: "queued" as const, state: "Ruled out" },
  ];
  return (
    <div className="grid gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Face agent="dispatch" size={24} />
          <p className="text-[13px] font-medium text-strong">Friday 9:00 · needs a cleaner</p>
        </div>
        <Chip tone="done">Covered</Chip>
      </div>
      <ul className="grid gap-1.5">
        {options.map((o, i) => (
          <li key={o.name} className={cn("flex items-center justify-between gap-2 rounded-xl border px-3 py-2", i === 0 ? "border-emerald-200 bg-emerald-50/50" : "border-[#efeafd]", i === 2 && "opacity-60")}>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-strong">{o.name}</span>
              <span className="block truncate text-[11.5px] text-[#6b6488]">{o.why}</span>
            </span>
            <Chip tone={o.tone}>{o.state}</Chip>
          </li>
        ))}
      </ul>
      <p className="text-[11.5px] text-[#6b6488]">Offer sent by text link · next option held in reserve</p>
    </div>
  );
}

function Outcome() {
  const items: { who: Agent | "you"; text: string; tone: Tone; state: string }[] = [
    { who: "sales", text: "New customer booked for Friday, $285", tone: "done", state: "Booked" },
    { who: "you", text: "You approved a discount above your limit", tone: "done", state: "Recorded" },
    { who: "dispatch", text: "Maria R. accepted Friday 9:00", tone: "done", state: "Covered" },
    { who: "retention", text: "Feedback request after the visit", tone: "working", state: "Scheduled" },
  ];
  return (
    <div className="grid gap-4 md:grid-cols-[0.8fr_1.2fr] md:items-center">
      <div className="rounded-xl bg-[linear-gradient(135deg,#f4f0ff,#ffffff)] p-4 ring-1 ring-[#efeafd]">
        <p className="text-[11px] font-semibold tracking-[0.12em] text-[#5126c7] uppercase">Today’s summary</p>
        <p className="mt-2 font-heading text-[22px] leading-tight text-strong">One inquiry became a covered, booked visit.</p>
        <p className="mt-2 text-[12.5px] text-[#6b6488]">1 decision needed you. Everything else stayed within your rules.</p>
      </div>
      <ul className="grid gap-1.5">
        {items.map((item) => (
          <li key={item.text} className="flex items-center gap-3 rounded-xl border border-[#efeafd] px-3 py-2">
            {item.who === "you" ? <Owner size={24} /> : <Face agent={item.who} size={24} />}
            <span className="min-w-0 flex-1 truncate text-[13px] text-strong">{item.text}</span>
            <Chip tone={item.tone}>{item.state}</Chip>
          </li>
        ))}
      </ul>
    </div>
  );
}

const WALK = {
  inquiry: { title: "Sales · New inquiry", body: Inquiry },
  booking: { title: "Booking", body: Booking },
  dispatch: { title: "Dispatch · Coverage", body: Dispatch },
  outcome: { title: "Your day", body: Outcome },
} as const;

export function WalkIllustration({ visual, label }: { visual: keyof typeof WALK; label: string }) {
  const { title, body: Body } = WALK[visual];
  return (
    <Frame label={label} title={title} className="w-full">
      <Body />
    </Frame>
  );
}

// ── A day in Selestial: one lane per agent ──────────────────────────────────────────────────────

const LANES: { agent: Agent; name: string; tasks: { text: string; tone: Tone; state: string }[] }[] = [
  { agent: "sales", name: "Sales", tasks: [{ text: "Quote for 3 bed, 2 bath", tone: "done", state: "Sent" }, { text: "Follow up: office clean", tone: "working", state: "Working" }] },
  { agent: "dispatch", name: "Dispatch", tasks: [{ text: "Friday 9:00 coverage", tone: "done", state: "Covered" }, { text: "Tuesday swap request", tone: "working", state: "Working" }] },
  { agent: "recruiter", name: "Recruiter", tasks: [{ text: "2 new applicants", tone: "working", state: "Screening" }, { text: "Onboarding: Dana K.", tone: "queued", state: "4 of 6" }] },
  { agent: "retention", name: "Retention", tasks: [{ text: "Concern: missed oven", tone: "you", state: "Needs you" }, { text: "Renewal: Harbor Dental", tone: "queued", state: "Next week" }] },
];

export function WorkspaceIllustration({ label, caption }: { label: string; caption: string }) {
  return (
    <figure>
      <Frame label={label} title="Today · your agents">
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-[#fbfaff] px-3 py-2.5 ring-1 ring-[#efeafd]">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-white ring-1 ring-[#e7e1fb]">
              <LogoGlyph className="h-5" />
            </span>
            <p className="text-[13px] font-medium text-strong">4 agents working · 1 decision waiting for you</p>
          </div>
          <Chip tone="you">Review</Chip>
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {LANES.map((lane) => (
            <div key={lane.agent} className="rounded-xl border border-[#efeafd] p-3">
              <div className="mb-2 flex items-center gap-2">
                <Face agent={lane.agent} size={24} />
                <p className="text-[13px] font-semibold text-strong">{lane.name}</p>
              </div>
              <ul className="grid gap-1.5">
                {lane.tasks.map((task) => (
                  <li key={task.text} className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12.5px] text-[#4b4566]">{task.text}</span>
                    <Chip tone={task.tone}>{task.state}</Chip>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Frame>
      <figcaption className="mt-3 text-xs leading-relaxed text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}

// ── Guided setup: files in, records checked, nothing live until released ────────────────────────

export function SetupIllustration({ label, caption }: { label: string; caption: string }) {
  const files = ["customers.csv", "properties.csv", "recurring.csv"];
  const checks: { text: string; tone: Tone; state: string }[] = [
    { text: "Ready to create", tone: "done", state: "48" },
    { text: "Possible duplicates", tone: "you", state: "2" },
    { text: "Needs a correction", tone: "you", state: "1" },
    { text: "Upcoming visits held", tone: "working", state: "12" },
  ];
  return (
    <figure>
      <Frame label={label} title="Bring your business to Selestial">
        <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1.2fr]">
          <ul className="grid gap-1.5">
            {files.map((file) => (
              <li key={file} className="flex items-center gap-2 rounded-lg border border-[#efeafd] bg-[#fbfaff] px-2.5 py-2 text-[12.5px] text-strong">
                <svg aria-hidden viewBox="0 0 16 16" className="size-4 text-[#6838ef]" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 1.8h5.2L12.5 5v9.2H4z M9 1.8V5.2h3.4" strokeLinejoin="round" />
                </svg>
                {file}
              </li>
            ))}
            <li className="px-1 text-[11px] text-[#6b6488]">Exported from your current software</li>
          </ul>
          <div className="flex items-center justify-center sm:flex-col">
            <span className="h-px w-8 bg-[linear-gradient(90deg,#d9ceff,#6838ef)] sm:h-8 sm:w-px sm:bg-[linear-gradient(180deg,#d9ceff,#6838ef)]" />
            <span className="grid size-11 place-items-center rounded-xl bg-white shadow-[0_8px_24px_-10px_rgba(104,56,239,0.6)] ring-1 ring-[#e7e1fb]">
              <LogoGlyph className="h-6" />
            </span>
            <span className="h-px w-8 bg-[linear-gradient(90deg,#6838ef,#d9ceff)] sm:h-8 sm:w-px sm:bg-[linear-gradient(180deg,#6838ef,#d9ceff)]" />
          </div>
          <ul className="grid gap-1.5">
            {checks.map((check) => (
              <li key={check.text} className="flex items-center justify-between gap-2 rounded-lg border border-[#efeafd] px-2.5 py-2 text-[12.5px] text-strong">
                {check.text}
                <Chip tone={check.tone}>{check.state}</Chip>
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-[#f4f0ff] px-3 py-2.5 text-[12.5px] text-[#3b1f99]">
          <svg aria-hidden viewBox="0 0 16 16" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
            <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
          </svg>
          Nothing goes live until you review it and release it.
        </div>
      </Frame>
      <figcaption className="mt-3 text-xs leading-relaxed text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
