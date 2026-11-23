"use client";

/**
 * The training hub: the company's modules, required and optional, each with what completes it. A video
 * counts once it has played to its end without skipping ahead (the server keeps the furthest point watched
 * in order, so leaving resumes there); a guide counts once each section is read in order and its questions
 * answered. Opening a module or leaving it half way records a start and nothing else.
 */
import { useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";

import { ArrowLeft, BookOpen, Check, CheckCircle2, PlayCircle } from "@/components/icons";
import { cn } from "@/lib/utils";

import { api } from "../../../convex/_generated/api";
import type { GuidedView } from "./guided-onboarding";
import { Problem, problemWords } from "./shell";

type Module = GuidedView["training"]["modules"][number];

export function TrainingHub({ view, token, onBack }: { view: GuidedView; token: string | null; onBack: () => void }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const module = view.training.modules.find((m) => m.key === openKey) ?? null;
  const required = view.training.modules.filter((m) => m.required);
  const done = required.filter((m) => m.completedAt).length;
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-xl items-center gap-2 px-4">
          <button type="button" onClick={module ? () => setOpenKey(null) : onBack} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg pr-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none">
            <ArrowLeft aria-hidden className="size-4" />
            {module ? "All training" : "Back to setup"}
          </button>
          <span className="ml-auto text-xs text-muted-foreground">{view.company.name}</span>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-5 pb-16">
        {module ? (
          <ModuleView key={module.key} module={module} token={token} onDone={() => setOpenKey(null)} />
        ) : (
          <>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Your training</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {done} of {required.length} required {required.length === 1 ? "module" : "modules"} complete. Your place is saved in each one.
              </p>
            </div>
            <ul className="flex flex-col gap-3">
              {view.training.modules.map((m) => (
                <li key={m.key}>
                  <button type="button" onClick={() => setOpenKey(m.key)} className="flex w-full items-start gap-3 rounded-3xl border border-border bg-card p-4 text-left shadow-sm hover:border-brand-500/40 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none" data-testid={`module-${m.key}`}>
                    <span aria-hidden className={cn("grid size-12 shrink-0 place-items-center rounded-2xl", m.completedAt ? "bg-emerald-500/15 text-emerald-700" : "bg-brand-500/10 text-brand-600")}>{m.completedAt ? <Check className="size-6" /> : m.kind === "video" ? <PlayCircle className="size-6" /> : <BookOpen className="size-6" />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">{m.title}</span>
                      {m.summary ? <span className="mt-0.5 block text-sm text-muted-foreground">{m.summary}</span> : null}
                      <span className="mt-2 flex flex-wrap gap-2 text-xs">
                        <span className={cn("rounded-full px-2 py-0.5 font-semibold", m.required ? "bg-brand-500/10 text-brand-700 dark:text-brand-300" : "bg-muted text-muted-foreground")}>{m.required ? "Required" : "Optional"}</span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{m.kind === "video" ? "Video" : "Guide"}{m.minutes ? ` · ${m.minutes} min` : ""}</span>
                        {m.completedAt ? <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-semibold text-emerald-800 dark:text-emerald-300">Completed</span> : m.kind === "guide" && m.sectionsRead.length ? <span className="rounded-full bg-muted px-2 py-0.5">{m.sectionsRead.length} of {m.sections?.length ?? 0} read</span> : null}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {required.length > 0 && done === required.length ? (
              <p role="status" className="flex items-center gap-2 rounded-2xl bg-emerald-500/10 p-3 text-sm font-medium text-emerald-900 dark:text-emerald-200">
                <CheckCircle2 aria-hidden className="size-5" /> Required training complete. You can come back to any module.
              </p>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

function ModuleView({ module, token, onDone }: { module: Module; token: string | null; onDone: () => void }) {
  const start = useMutation(api.cleanerOnboarding.startModule);
  const started = useRef(false);
  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    void start({ token, moduleKey: module.key }).catch(() => undefined);
  }, [start, token, module.key]);
  return (
    <article className="flex flex-col gap-4">
      <div>
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{module.required ? "Required" : "Optional"} · {module.kind === "video" ? "Video" : "Guide"}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{module.title}</h1>
        {module.summary ? <p className="mt-1 text-sm text-muted-foreground">{module.summary}</p> : null}
      </div>
      {module.kind === "video" ? <VideoModule module={module} token={token} /> : <GuideModule module={module} token={token} onDone={onDone} />}
    </article>
  );
}

function VideoModule({ module, token }: { module: Module; token: string | null }) {
  const report = useMutation(api.cleanerOnboarding.videoProgress);
  const ref = useRef<HTMLVideoElement>(null);
  const watched = useRef(module.watchedSeconds);
  const last = useRef(0);
  const [done, setDone] = useState(Boolean(module.completedAt));
  const [problem, setProblem] = useState<string | null>(null);
  const send = (force = false) => {
    const video = ref.current;
    if (!video || !token || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const now = Date.now();
    if (!force && now - last.current < 8000) return;
    last.current = now;
    report({ token, moduleKey: module.key, position: video.currentTime, duration: video.duration })
      .then((result) => {
        watched.current = Math.max(watched.current, result.watchedSeconds);
        if (result.completed) setDone(true);
      })
      .catch((error) => setProblem(problemWords(error)));
  };
  return (
    <>
      <div className="overflow-hidden rounded-3xl border border-border bg-black">
        <video
          ref={ref}
          src={module.videoUrl}
          controls
          playsInline
          preload="metadata"
          className="aspect-video w-full"
          onLoadedMetadata={(event) => {
            // Resume where they left off.
            if (watched.current > 1) event.currentTarget.currentTime = Math.min(watched.current, event.currentTarget.duration - 1);
          }}
          onTimeUpdate={() => send()}
          onSeeking={(event) => {
            // Skipping ahead past what was watched is not watching: it goes back to the furthest point watched.
            const video = event.currentTarget;
            if (!done && video.currentTime > watched.current + 3) video.currentTime = watched.current;
          }}
          onPause={() => send(true)}
          onEnded={() => send(true)}
        >
          <track kind="captions" />
        </video>
      </div>
      <Problem message={problem} />
      {done ? (
        <p role="status" className="flex items-center gap-2 rounded-2xl bg-emerald-500/10 p-3 text-sm font-medium text-emerald-900 dark:text-emerald-200">
          <CheckCircle2 aria-hidden className="size-5" /> Watched to the end. This module is complete.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">It counts once it plays to the end. You can pause and come back; your place is saved.</p>
      )}
    </>
  );
}

function GuideModule({ module, token, onDone }: { module: Module; token: string | null; onDone: () => void }) {
  const read = useMutation(api.cleanerOnboarding.readSection);
  const sections = module.sections ?? [];
  const [readCount, setReadCount] = useState(module.completedAt ? sections.length : module.sectionsRead.length);
  const [index, setIndex] = useState(Math.min(readCount, sections.length - 1));
  const [answer, setAnswer] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const section = sections[index];
  const complete = readCount >= sections.length;
  const alreadyRead = index < readCount;
  const next = async () => {
    if (alreadyRead) {
      setIndex(Math.min(index + 1, sections.length - 1));
      setAnswer(null);
      return;
    }
    if (!token) {
      setProblem("This is a preview. Nothing is recorded from here.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const result = await read({ token, moduleKey: module.key, index, answer: answer ?? undefined });
      setReadCount(result.read);
      setAnswer(null);
      if (index < sections.length - 1) setIndex(index + 1);
    } catch (error) {
      setProblem(problemWords(error));
    } finally {
      setBusy(false);
    }
  };
  if (!section) return null;
  return (
    <>
      <div className="flex items-center gap-1.5" aria-label={`Section ${index + 1} of ${sections.length}`}>
        {sections.map((_, i) => (
          <span key={i} aria-hidden className={cn("h-1.5 flex-1 rounded-full", i < readCount ? "bg-emerald-500" : i === index ? "bg-brand-600" : "bg-muted")} />
        ))}
      </div>
      <section className="flex flex-col gap-3 rounded-3xl border border-border bg-card p-5 shadow-sm" aria-live="polite">
        <p className="text-xs font-medium text-muted-foreground">
          Section {index + 1} of {sections.length}
        </p>
        <h2 className="text-lg font-semibold">{section.title}</h2>
        <p className="text-[15px] leading-relaxed">{section.body}</p>
        {section.check && !alreadyRead ? (
          <fieldset className="mt-2 flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold">{section.check.question}</legend>
            {section.check.options.map((option, i) => (
              <label key={option} className={cn("flex min-h-12 cursor-pointer items-center gap-3 rounded-2xl border px-3 text-sm", answer === i ? "border-brand-600 bg-brand-500/5" : "border-border")}>
                <input type="radio" name={`check-${module.key}-${index}`} checked={answer === i} onChange={() => setAnswer(i)} className="size-4 accent-brand-600" />
                {option}
              </label>
            ))}
          </fieldset>
        ) : null}
      </section>
      <Problem message={problem} />
      {complete && index === sections.length - 1 ? (
        <>
          <p role="status" className="flex items-center gap-2 rounded-2xl bg-emerald-500/10 p-3 text-sm font-medium text-emerald-900 dark:text-emerald-200">
            <CheckCircle2 aria-hidden className="size-5" /> Every section read. This module is complete.
          </p>
          <button type="button" onClick={onDone} className="min-h-12 rounded-xl border border-border font-semibold">
            Back to all training
          </button>
        </>
      ) : (
        <div className="flex gap-2">
          {index > 0 ? (
            <button type="button" onClick={() => { setIndex(index - 1); setAnswer(null); }} className="min-h-12 flex-1 rounded-xl border border-border font-semibold">
              Back
            </button>
          ) : null}
          <button type="button" disabled={busy || (Boolean(section.check) && !alreadyRead && answer === null)} onClick={() => void next()} className="min-h-12 flex-[2] rounded-xl bg-brand-600 font-semibold text-white disabled:opacity-50" data-testid="section-next">
            {busy ? "Saving…" : alreadyRead ? "Next" : section.check ? "Check answer and continue" : index === sections.length - 1 ? "Finish" : "I've read this, next"}
          </button>
        </div>
      )}
    </>
  );
}
