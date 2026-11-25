"use client";

import Image from "next/image";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { LogoGlyph } from "@/components/brand/logo";
import { DESK } from "@/lib/founding/content";
import { cn } from "@/lib/utils";

type Actor = (typeof DESK.steps)[number]["agent"];

/** Where each actor sits on the desk, in percent of the map. Selestial is the hub in the middle. */
const NODES: Record<Actor, { x: number; y: number; label: string }> = {
  sales: { x: 14, y: 22, label: "Sales" },
  dispatch: { x: 86, y: 22, label: "Dispatch" },
  recruiter: { x: 14, y: 78, label: "Recruiter" },
  retention: { x: 86, y: 78, label: "Retention" },
  owner: { x: 50, y: 84, label: "You" },
};
const HUB = { x: 50, y: 42 };
/** Percent of the map to the SVG's 160 × 84 units. */
const sx = (x: number) => (x / 100) * 160;
const sy = (y: number) => (y / 100) * 84;
const ACTORS = Object.keys(NODES) as Actor[];

/** One beat of the loop. A step is first being worked, then done; the loop rests on the finished feed before starting again. */
const BEAT_MS = 1500;
const REST_BEATS = 3;
const TOTAL = DESK.steps.length * 2 + REST_BEATS;

/**
 * The beat the desk shows. Starts a few beats in (the same on the server and in the browser, so nothing
 * jumps at hydration), advances on a timer, pauses while hovered or focused, and shows the finished feed when
 * the visitor prefers reduced motion.
 */
/**
 * Whether the visitor asks for reduced motion. The server, and the browser while hydrating, assume full
 * motion, so both render the same markup; the real preference applies right after.
 */
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

/** The first paint opens mid-flow (the inquiry handled, the quote under way), the same on server and browser. */
const FIRST_BEAT = 3;

function useBeat(paused: boolean, still: boolean) {
  const [beat, setBeat] = useState(FIRST_BEAT);
  useEffect(() => {
    if (still) {
      const id = window.setTimeout(() => setBeat(DESK.steps.length * 2 - 1), 0);
      return () => window.clearTimeout(id);
    }
    if (paused) return;
    const id = window.setInterval(() => setBeat((current) => (current + 1) % TOTAL), BEAT_MS);
    return () => window.clearInterval(id);
  }, [paused, still]);
  return beat;
}

function Avatar({ actor, size = 40 }: { actor: Actor; size?: number }) {
  if (actor === "owner") {
    return (
      <span aria-hidden className="grid shrink-0 place-items-center rounded-full bg-white text-[#3b1f99]" style={{ width: size, height: size }}>
        <svg viewBox="0 0 16 16" className="size-[55%]" fill="currentColor">
          <circle cx="8" cy="5.2" r="2.9" />
          <path d="M2.6 14c.5-3 2.7-4.7 5.4-4.7s4.9 1.7 5.4 4.7z" />
        </svg>
      </span>
    );
  }
  return <Image src={`/agents/${actor}.webp`} alt="" width={size * 2} height={size * 2} aria-hidden className="shrink-0 rounded-full ring-1 ring-white/25" style={{ width: size, height: size }} />;
}

function DeskMap({ active, working, still }: { active: Actor | null; working: boolean; still: boolean }) {
  return (
    <div className="relative aspect-[16/8.4] w-full">
      <svg aria-hidden viewBox="0 0 160 84" className="absolute inset-0 size-full overflow-visible">
        {ACTORS.map((actor) => {
          const node = NODES[actor];
          const on = actor === active;
          return (
            <g key={actor}>
              <line x1={sx(HUB.x)} y1={sy(HUB.y)} x2={sx(node.x)} y2={sy(node.y)} stroke="rgba(255,255,255,0.2)" strokeWidth={0.35} strokeDasharray="1 1.4" />
              {on ? (
                <motion.line
                  key={`${actor}-beam`}
                  x1={sx(HUB.x)}
                  y1={sy(HUB.y)}
                  x2={sx(node.x)}
                  y2={sy(node.y)}
                  stroke="url(#desk-beam)"
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
        <defs>
          <linearGradient id="desk-beam" gradientUnits="userSpaceOnUse" x1="40" y1="0" x2="120" y2="0">
            <stop offset="0" stopColor="#b39eff" />
            <stop offset="1" stopColor="#ffffff" />
          </linearGradient>
        </defs>
      </svg>

      {/* The hub: Selestial, coordinating. */}
      <div className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${HUB.x}%`, top: `${HUB.y}%` }}>
        <div className="relative grid size-16 place-items-center rounded-2xl border border-white/20 bg-white/10 shadow-[0_0_60px_-10px_rgba(179,158,255,0.9)] backdrop-blur sm:size-[72px]">
          {!still ? <span aria-hidden className="absolute inset-0 animate-ping rounded-2xl border border-white/30 [animation-duration:2.8s]" /> : null}
          <LogoGlyph className="h-9 [filter:brightness(1.6)]" />
        </div>
      </div>

      {ACTORS.map((actor) => {
        const node = NODES[actor];
        const on = actor === active;
        return (
          <div key={actor} className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5" style={{ left: `${node.x}%`, top: `${node.y}%` }}>
            <motion.div animate={{ scale: on ? 1.08 : 1 }} transition={{ duration: 0.3 }} className={cn("rounded-full p-[3px] transition-shadow duration-300", on ? "bg-gradient-to-br from-[#b39eff] to-white shadow-[0_0_28px_-2px_rgba(179,158,255,0.95)]" : "bg-white/10")}>
              <Avatar actor={actor} size={actor === "owner" ? 34 : 40} />
            </motion.div>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap transition-colors", on ? "bg-white text-[#3b1f99]" : "text-white/70")}>
              {node.label}
              {on && working ? <span className="sr-only"> is working</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Status({ actor, done }: { actor: Actor; done: boolean }) {
  if (done) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-medium text-emerald-200 ring-1 ring-emerald-300/25">
        <svg aria-hidden viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
        Done
      </span>
    );
  }
  if (actor === "owner") return <span className="rounded-full bg-amber-300/15 px-2 py-0.5 text-[11px] font-medium text-amber-100 ring-1 ring-amber-200/30">Needs you</span>;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/85 ring-1 ring-white/15">
      <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-[#b39eff]" />
      Working
    </span>
  );
}

/**
 * The hero's picture of Selestial at work: agents taking a cleaning company's day forward and bringing the
 * owner the one decision above their limit. Every line is an example of work the product supports today,
 * with made-up names and figures, and the panel says so. Decorative for screen readers apart from its label:
 * the same story is told in words further down the page.
 */
export function AgentDesk() {
  const reduce = usePrefersStill();
  const [paused, setPaused] = useState(false);
  const beat = useBeat(paused, reduce);
  const resting = beat >= DESK.steps.length * 2;
  const stepIndex = resting ? DESK.steps.length - 1 : Math.floor(beat / 2);
  const currentDone = resting || beat % 2 === 1;
  const visible = DESK.steps.slice(0, stepIndex + 1).slice(-4);
  const current = DESK.steps[stepIndex];
  const waiting = current.agent === "owner" && !currentDone;
  const doneCount = currentDone ? stepIndex + 1 : stepIndex;

  return (
    <figure
      aria-label={DESK.label}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="relative w-full overflow-hidden rounded-[22px] border border-white/15 bg-white/[0.06] p-4 shadow-[0_40px_120px_-40px_rgba(10,4,40,0.9)] backdrop-blur-xl sm:p-5"
    >
      <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-48 w-[80%] -translate-x-1/2 rounded-full bg-[#8e6df6]/30 blur-3xl" />

      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="relative flex size-2">
            {!reduce ? <span aria-hidden className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-300 opacity-60" /> : null}
            <span className="relative inline-flex size-2 rounded-full bg-emerald-300" />
          </span>
          <p className="text-[13px] font-medium text-white">{DESK.title}</p>
        </div>
        <p className="rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-semibold tracking-[0.12em] text-white/75 uppercase ring-1 ring-white/10">{DESK.demo}</p>
      </div>

      <div className="relative mt-3 rounded-2xl bg-[#0d0727]/40 px-2 pt-3 pb-6 ring-1 ring-white/10">
        <DeskMap active={current.agent} working={!currentDone} still={reduce} />
      </div>

      <ol aria-hidden className="relative mt-3 grid min-h-[280px] grid-cols-[minmax(0,1fr)] content-start gap-2">
        <AnimatePresence initial={false} mode="popLayout">
          {visible.map((step) => {
            const index = DESK.steps.indexOf(step);
            const done = index < stepIndex || currentDone;
            return (
              <motion.li
                key={step.id}
                layout={!reduce}
                initial={reduce ? false : { opacity: 0, y: 14, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduce ? undefined : { opacity: 0, y: -10, transition: { duration: 0.25 } }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className={cn(
                  "flex min-w-0 items-start gap-3 rounded-xl border px-3 py-2.5",
                  step.agent === "owner" && !done ? "border-amber-200/40 bg-amber-200/10" : index === stepIndex && !done ? "border-white/25 bg-white/[0.12]" : "border-white/10 bg-white/[0.05]",
                )}
              >
                <Avatar actor={step.agent} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[13px] font-medium text-white">{step.title}</p>
                    <Status actor={step.agent} done={done} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-white/65">{done ? step.done : step.detail}</p>
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>

      <div className="relative mt-3 flex items-center justify-between gap-3 border-t border-white/10 pt-3 text-xs">
        <p className={cn("transition-colors", waiting ? "font-medium text-amber-100" : "text-white/70")}>{waiting ? DESK.waiting : DESK.clear}</p>
        <p className="text-white/55 tabular-nums">
          {doneCount} of {DESK.steps.length} handled
        </p>
      </div>
      <figcaption className="sr-only">{DESK.caption}</figcaption>
    </figure>
  );
}
