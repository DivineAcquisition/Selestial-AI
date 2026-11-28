"use client";

import Image from "next/image";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { DESK, type DeskNode } from "@/lib/recruiter-offer/content";
import { cn } from "@/lib/utils";

/**
 * The hero's picture of Recruiter at work, built like the Founding Access desk
 * (src/components/founding/agent-desk.tsx): Recruiter in the middle, joined to where applications come
 * from, to you and to onboarding; a feed of steps moving from Working to Done; and the one decision that
 * waits for you. Demonstration data, labelled. Pauses while hovered or focused; still when the visitor
 * prefers reduced motion. Decorative for screen readers apart from its label and caption.
 */

const HUB = { x: 50, y: 48 };
const sx = (x: number) => (x / 100) * 160;
const sy = (y: number) => (y / 100) * 84;
const NODES = DESK.nodes;
const NODE_IDS = Object.keys(NODES) as DeskNode[];

const BEAT_MS = 1500;
const REST_BEATS = 3;
const TOTAL = DESK.steps.length * 2 + REST_BEATS;
const FIRST_BEAT = 3;

function usePrefersStill(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia("(prefers-reduced-motion: reduce)");
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

function useBeat(paused: boolean, still: boolean) {
  const [beat, setBeat] = useState(FIRST_BEAT);
  useEffect(() => {
    if (still) {
      // Reduced motion: show the finished feed with the owner's decision answered.
      const id = window.setTimeout(() => setBeat(DESK.steps.length * 2 - 1), 0);
      return () => window.clearTimeout(id);
    }
    if (paused) return;
    const id = window.setInterval(() => setBeat((current) => (current + 1) % TOTAL), BEAT_MS);
    return () => window.clearInterval(id);
  }, [paused, still]);
  return beat;
}

const ICONS: Record<DeskNode, ReactNode> = {
  inbox: <path d="M2.5 9.5h3l1 2h3l1-2h3M3.5 4h9l1 5.5V13H2.5V9.5z" />,
  link: <path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 014.5 9l1-1" />,
  owner: (
    <>
      <circle cx="8" cy="5.2" r="2.6" />
      <path d="M3 14c.5-2.8 2.5-4.4 5-4.4s4.5 1.6 5 4.4" />
    </>
  ),
  onboarding: <path d="M3.5 8.5l2.5 2.5 6.5-7M3 14h10" />,
};

function NodeIcon({ node, on }: { node: DeskNode; on: boolean }) {
  return (
    <span aria-hidden className={cn("grid size-10 place-items-center rounded-full ring-2 ring-white transition-colors", node === "owner" ? "bg-[#1d1240] text-white" : on ? "bg-white text-[#6838ef]" : "bg-white text-[#5b5478]")}>
      <svg viewBox="0 0 16 16" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {ICONS[node]}
      </svg>
    </span>
  );
}

function StepAvatar({ actor }: { actor: "recruiter" | "owner" }) {
  if (actor === "owner") {
    return (
      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-[#1d1240] text-white">
        <svg viewBox="0 0 16 16" className="size-[55%]" fill="currentColor">
          <circle cx="8" cy="5.2" r="2.9" />
          <path d="M2.6 14c.5-3 2.7-4.7 5.4-4.7s4.9 1.7 5.4 4.7z" />
        </svg>
      </span>
    );
  }
  return <Image src="/agents/recruiter.webp" alt="" width={56} height={56} aria-hidden className="size-7 shrink-0 rounded-full ring-1 ring-[#e7e1fb]" />;
}

function Status({ actor, done }: { actor: "recruiter" | "owner"; done: boolean }) {
  if (done) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-600/15">
        <svg aria-hidden viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
        Done
      </span>
    );
  }
  if (actor === "owner") return <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-600/20">Needs you</span>;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#f1ecff] px-2 py-0.5 text-[11px] font-medium text-[#5126c7] ring-1 ring-[#6838ef]/20">
      <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-[#6838ef] motion-reduce:animate-none" />
      Working
    </span>
  );
}

function DeskMap({ active, still }: { active: DeskNode; still: boolean }) {
  return (
    <div className="relative aspect-[16/8.4] w-full">
      <svg aria-hidden viewBox="0 0 160 84" className="absolute inset-0 size-full overflow-visible">
        <defs>
          <linearGradient id="recruiter-beam" gradientUnits="userSpaceOnUse" x1="30" y1="0" x2="130" y2="0">
            <stop offset="0" stopColor="#8e6df6" />
            <stop offset="1" stopColor="#5126c7" />
          </linearGradient>
        </defs>
        {NODE_IDS.map((node) => {
          const n = NODES[node];
          return (
            <g key={node}>
              <line x1={sx(HUB.x)} y1={sy(HUB.y)} x2={sx(n.x)} y2={sy(n.y)} stroke="rgba(104,56,239,0.28)" strokeWidth={0.35} strokeDasharray="1 1.4" />
              {node === active ? (
                <motion.line
                  key={`${node}-beam`}
                  x1={sx(n.x)}
                  y1={sy(n.y)}
                  x2={sx(HUB.x)}
                  y2={sy(HUB.y)}
                  stroke="url(#recruiter-beam)"
                  strokeWidth={0.9}
                  strokeLinecap="round"
                  initial={still ? false : { pathLength: 0, opacity: 0.4 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ duration: 0.7, ease: "easeOut" }}
                />
              ) : null}
            </g>
          );
        })}
      </svg>

      {/* The hub: Recruiter. */}
      <div className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${HUB.x}%`, top: `${HUB.y}%` }}>
        <div className="relative flex flex-col items-center gap-1.5">
          <div className="relative rounded-full bg-gradient-to-br from-[#8e6df6] to-[#5126c7] p-[3px] shadow-[0_14px_40px_-12px_rgba(104,56,239,0.7)]">
            {!still ? <span aria-hidden className="absolute -inset-1 animate-ping rounded-full border border-[#6838ef]/25 [animation-duration:2.8s]" /> : null}
            <Image src="/agents/recruiter.webp" alt="" width={112} height={112} aria-hidden className="size-14 rounded-full ring-2 ring-white sm:size-16" />
          </div>
          <span className="rounded-full bg-[#6838ef] px-2 py-0.5 text-[11px] font-semibold text-white">Recruiter</span>
        </div>
      </div>

      {NODE_IDS.map((node) => {
        const n = NODES[node];
        const on = node === active;
        return (
          <div key={node} className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5" style={{ left: `${n.x}%`, top: `${n.y}%` }}>
            <motion.div animate={{ scale: on ? 1.08 : 1 }} transition={{ duration: still ? 0 : 0.3 }} className={cn("rounded-full p-[3px] transition-shadow duration-300", on ? "bg-gradient-to-br from-[#8e6df6] to-[#5126c7] shadow-[0_10px_28px_-6px_rgba(104,56,239,0.65)]" : "bg-[#ece6ff]")}>
              <NodeIcon node={node} on={on} />
            </motion.div>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap transition-colors", on ? "bg-white text-[#5126c7] ring-1 ring-[#d9ceff]" : "text-[#5b5478]")}>{n.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function RecruiterDesk() {
  const still = usePrefersStill();
  const [paused, setPaused] = useState(false);
  const beat = useBeat(paused, still);
  const resting = beat >= DESK.steps.length * 2;
  const stepIndex = resting ? DESK.steps.length - 1 : Math.floor(beat / 2);
  const currentDone = resting || beat % 2 === 1;
  const visible = DESK.steps.slice(0, stepIndex + 1).slice(-4);
  const current = DESK.steps[stepIndex];
  const waiting = current.actor === "owner" && !currentDone;
  const doneCount = currentDone ? stepIndex + 1 : stepIndex;

  return (
    <figure
      aria-label={DESK.label}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="relative w-full overflow-hidden rounded-[22px] border border-[#e7e1fb] bg-white/90 p-4 shadow-[0_40px_100px_-40px_rgba(81,38,199,0.45),0_0_0_1px_rgba(104,56,239,0.04)] backdrop-blur-xl sm:p-5"
    >
      <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-48 w-[80%] -translate-x-1/2 rounded-full bg-[#b39eff]/25 blur-3xl" />

      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="relative flex size-2">
            {!still ? <span aria-hidden className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" /> : null}
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          <p className="text-[13px] font-medium whitespace-nowrap text-strong">{DESK.title}</p>
        </div>
        <p className="shrink-0 rounded-full bg-[#f4f0ff] px-2.5 py-1 text-[10px] font-semibold tracking-[0.12em] whitespace-nowrap text-[#5b5478] uppercase ring-1 ring-[#e7e1fb]">
          <span className="sm:hidden">Demo data</span>
          <span className="hidden sm:inline">{DESK.demo}</span>
        </p>
      </div>

      <div className="relative mt-3 rounded-2xl bg-[radial-gradient(80%_80%_at_50%_45%,#f6f2ff,#fbfaff)] px-2 pt-4 pb-7 ring-1 ring-[#efeafd]">
        <DeskMap active={current.node} still={still} />
      </div>

      <ol aria-hidden className="relative mt-3 grid min-h-[268px] grid-cols-[minmax(0,1fr)] content-start gap-2">
        <AnimatePresence initial={false} mode="popLayout">
          {visible.map((step) => {
            const index = DESK.steps.indexOf(step);
            const done = index < stepIndex || currentDone;
            return (
              <motion.li
                key={step.id}
                layout={!still}
                initial={still ? false : { opacity: 0, y: 14, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={still ? undefined : { opacity: 0, y: -10, transition: { duration: 0.25 } }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className={cn(
                  "flex min-w-0 items-start gap-3 rounded-xl border px-3 py-2.5",
                  step.actor === "owner" && !done ? "border-amber-200 bg-amber-50/70" : index === stepIndex && !done ? "border-[#d9ceff] bg-[#f7f4ff]" : "border-[#efeafd] bg-white",
                )}
              >
                <StepAvatar actor={step.actor} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[13px] font-medium text-strong">{step.title}</p>
                    <Status actor={step.actor} done={done} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-[#6b6488]">{done ? step.done : step.detail}</p>
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>

      <div className="relative mt-3 flex items-center justify-between gap-3 border-t border-[#efeafd] pt-3 text-xs">
        <p className={cn("transition-colors", waiting ? "font-medium text-amber-800" : "text-[#5b5478]")}>{waiting ? DESK.waiting : DESK.clear}</p>
        <p className="text-[#8a83a6] tabular-nums">
          {doneCount} of {DESK.steps.length} handled
        </p>
      </div>
      <figcaption className="sr-only">{DESK.caption}</figcaption>
    </figure>
  );
}
