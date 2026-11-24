"use client";

import { useMemo, useState, useSyncExternalStore } from "react";

import { FormError } from "@/components/app/form";
import { AlertTriangle, Check, Sparkles, XIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { sectionOf, type EditorSection } from "@/lib/app/services";
import { cn } from "@/lib/utils";

import { suggestPricing } from "../../../../convex/lib/configure/pricing";
import { checkSpec, priceSummary } from "../../../../convex/lib/services/engine";
import type { Costs } from "../../../../convex/lib/services/profit";
import type { Spec } from "../../../../convex/lib/services/spec";
import { hasPrice, type KeptAmount } from "../../../../convex/lib/services/store";
import { formatCents, Toggle } from "./shared";
import { PricingStep, type StepProps } from "./steps";

/**
 * What a draft still needs, split by who can do it:
 *  - selestial: words and lists Selestial can draft from what is already on the service (a description,
 *    what's included and not, the questions a price needs). Never an amount.
 *  - price: the price itself. Only the person sets it, here, or (for the Owner) from their own costs.
 *  - confirm: what only the company can say: that example prices fit its market, that it has what the
 *    work requires.
 *  - fix: anything else a check found, with the section where it is fixed.
 */
export type Gap = { id: string; kind: "selestial" | "price" | "confirm" | "fix"; label: string; detail: string; section: EditorSection | "review"; ask?: string };

export function gapsOf(spec: Spec): Gap[] {
  const gaps: Gap[] = [];
  if (!spec.summary.trim()) gaps.push({ id: "summary", kind: "selestial", label: "Customer description", detail: "A short description customers read before they book.", section: "service", ask: "Write a short, plain customer description (what the visit covers, not how it's priced)." });
  if (spec.included.length === 0) gaps.push({ id: "included", kind: "selestial", label: "What's included", detail: "The tasks the crew does, grouped by room or area.", section: "service", ask: "Suggest the included tasks, grouped by room or area, as they'd appear on the crew's checklist." });
  if (spec.excluded.length === 0) gaps.push({ id: "excluded", kind: "selestial", label: "What's not included", detail: "Saying what isn't included prevents most disagreements.", section: "service", ask: "Suggest what is not included, so customers know before they book." });
  if (spec.questions.length === 0 && spec.pricing.method !== "fixed") gaps.push({ id: "questions", kind: "selestial", label: "Questions a price needs", detail: "What to ask a customer before quoting.", section: "booking", ask: "Suggest the few questions a customer should answer before a price, and when an answer means a walkthrough first." });
  const problems = checkSpec(spec);
  const pricingBlocked = problems.some((p) => p.severity === "blocker" && p.field.startsWith("pricing"));
  if (!hasPrice(spec) || pricingBlocked) gaps.push({ id: "price", kind: "price", label: "The price", detail: "Every amount with its unit. Only you set prices.", section: "price" });
  if (spec.illustrative) gaps.push({ id: "illustrative", kind: "confirm", label: "Example prices", detail: "Amounts from a template or an import stay examples until you confirm or replace them.", section: "review" });
  for (const r of spec.requirements.filter((x) => !x.confirmed)) gaps.push({ id: `req-${r.id}`, kind: "confirm", label: r.label, detail: "Confirm only what is true for your company today.", section: "review" });
  const covered = new Set(["summary", "included", "excluded", "illustrative"]);
  for (const p of problems) {
    if (p.severity !== "blocker" || covered.has(p.field) || p.field.startsWith("pricing") || p.field.startsWith("requirements")) continue;
    if (gaps.some((g) => g.kind === "fix" && g.detail === p.message)) continue;
    gaps.push({ id: `fix-${p.field}-${gaps.length}`, kind: "fix", label: "Needs a fix", detail: p.message, section: sectionOf(p.field) });
  }
  return gaps;
}

/** The request for Selestial, built only from what the person ticked. */
export function finishRequest(gaps: Gap[]): string {
  const asks = gaps.filter((g) => g.kind === "selestial" && g.ask).map((g, i) => `${i + 1}. ${g.ask}`);
  return ["Help me finish this service's draft:", ...asks, "Use only what's already on the service and what I've told you. Don't change any price or amount, and don't submit or publish. When you're done, tell me in one line what's still missing."].join("\n");
}

/**
 * The Finish draft pop-up. Everything the draft still needs, in one place: tick what Selestial should
 * draft, set the price right here, confirm what only you can. Edits made here are the same edits as in the
 * editor (saved, versioned, conflict-checked); Selestial's are listed beside the editor with Undo.
 */
export function FinishDialog({
  open,
  onClose,
  spec,
  edit,
  disabled,
  kept,
  costs,
  canPublish,
  onAsk,
  onGoTo,
}: {
  open: boolean;
  onClose: () => void;
  spec: Spec;
  edit: StepProps["edit"];
  disabled: boolean;
  kept: KeptAmount[];
  costs: Costs | null;
  canPublish: boolean;
  onAsk: (request: string) => Promise<void>;
  onGoTo: (section: EditorSection | "review") => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className="bg-card sm:max-w-2xl">
        {open ? <FinishBody spec={spec} edit={edit} disabled={disabled} kept={kept} costs={costs} canPublish={canPublish} onAsk={onAsk} onGoTo={onGoTo} onClose={onClose} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

export function FinishBody({ spec, edit, disabled, kept, costs, canPublish, onAsk, onGoTo, onClose }: { spec: Spec; edit: StepProps["edit"]; disabled: boolean; kept: KeptAmount[]; costs: Costs | null; canPublish: boolean; onAsk: (request: string) => Promise<void>; onGoTo: (section: EditorSection | "review") => void; onClose: () => void }) {
  const gaps = gapsOf(spec);
  // What was missing when the pop-up opened stays listed, ticked off as it is done.
  const [first] = useState(() => gapsOf(spec));
  const open = new Set(gaps.map((g) => g.id));
  const drafts = first.filter((g) => g.kind === "selestial");
  const [skip, setSkip] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picked = drafts.filter((g) => open.has(g.id) && !skip.includes(g.id));
  const fromCosts = useMemo(() => (canPublish && costs ? suggestPricing(spec, costs) : null), [canPublish, costs, spec]);
  const left = gaps.filter((g) => g.kind !== "selestial").length;
  const finish = async () => {
    if (!picked.length) return onClose();
    setError(null);
    setSending(true);
    try {
      await onAsk(finishRequest(picked));
      onClose();
    } catch (caught) {
      setError((caught as { data?: { message?: string } }).data?.message ?? (caught as Error).message ?? "That couldn't be sent.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Finish {spec.name || "this service"}</DialogTitle>
        <DialogDescription>{gaps.length ? `${gaps.length} thing${gaps.length === 1 ? "" : "s"} left before it can be ${canPublish ? "published" : "submitted"}.` : "Nothing left: it's ready for review."}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-5">
        {drafts.length ? (
          <section aria-labelledby="finish-selestial" className="grid gap-2">
            <h3 id="finish-selestial" className="flex items-center gap-1.5 text-sm font-semibold text-strong">
              <Sparkles aria-hidden className="size-4 text-brand-600" /> Selestial can draft these
            </h3>
            <ul className="grid gap-1.5">
              {drafts.map((g) => {
                const done = !open.has(g.id);
                const id = `finish-${g.id}`;
                return (
                  <li key={g.id} className={cn("flex items-start gap-3 rounded-xl border px-3 py-2.5", done ? "border-border bg-muted/40" : "border-border bg-card")}>
                    {done ? (
                      <span className="mt-0.5 grid size-4 place-items-center rounded-full bg-success text-white">
                        <Check aria-hidden className="size-3" />
                      </span>
                    ) : (
                      <input id={id} type="checkbox" className="mt-1 size-4 accent-brand-500" checked={!skip.includes(g.id)} onChange={(event) => setSkip((list) => (event.target.checked ? list.filter((x) => x !== g.id) : [...list, g.id]))} />
                    )}
                    <label htmlFor={done ? undefined : id} className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-strong">
                        {g.label}
                        {done ? <span className="sr-only">, done</span> : null}
                      </span>
                      <span className="block text-xs text-muted-foreground">{done ? "Done." : g.detail}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground">Selestial writes from what&apos;s already on the service and never sets an amount. You see each change beside the editor and can undo it. One request uses one Chat credit.</p>
          </section>
        ) : null}

        {first.some((g) => g.kind === "price") ? (
          <section aria-labelledby="finish-price" className="grid gap-3">
            <h3 id="finish-price" className="flex items-center gap-2 text-sm font-semibold text-strong">
              The price {open.has("price") ? null : <DoneTag />}
            </h3>
            {fromCosts?.basis === "costs" && open.has("price") ? <CostSuggestion spec={spec} suggestion={fromCosts} edit={edit} disabled={disabled} /> : null}
            <div className="rounded-xl border border-border p-3 sm:p-4">
              <PricingStep spec={spec} edit={edit} disabled={disabled} />
            </div>
          </section>
        ) : null}

        {first.some((g) => g.kind === "confirm") ? (
          <section aria-labelledby="finish-confirm" className="grid gap-3 rounded-xl border border-warning/40 bg-warning/[0.07] p-3 sm:p-4">
            <h3 id="finish-confirm" className="text-sm font-semibold text-strong">
              Only you can confirm these
            </h3>
            {spec.illustrative ? (
              <>
                {kept.length ? (
                  <ul aria-label="Prices still the template's examples" className="flex flex-wrap gap-1.5">
                    {kept.map((k) => (
                      <li key={k.key} className="rounded-full border border-border bg-card px-2.5 py-0.5 text-xs text-strong">
                        {k.label} <span className="tabular-nums text-muted-foreground">{k.value}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {fromCosts?.basis === "costs" && !first.some((g) => g.kind === "price") ? <CostSuggestion spec={spec} suggestion={fromCosts} edit={edit} disabled={disabled} /> : null}
                <Toggle label={kept.length ? "These prices are right for my market" : "I've replaced or confirmed every amount for my market"} tip="Confirming is recorded with this version." checked={false} disabled={disabled} onChange={(on) => on && edit((s) => ({ ...s, illustrative: false }))} />
              </>
            ) : first.some((g) => g.id === "illustrative") ? (
              <p className="flex items-center gap-2 text-sm text-strong">
                Example prices confirmed <DoneTag />
              </p>
            ) : null}
            {spec.requirements.map((r) => (
              <Toggle key={r.id} label={`My company has: ${r.label}`} description="Confirm only what is true today." checked={r.confirmed} disabled={disabled || r.confirmed} onChange={(on) => on && edit((s) => ({ ...s, requirements: s.requirements.map((x) => (x.id === r.id ? { ...x, confirmed: true } : x)) }))} />
            ))}
          </section>
        ) : null}

        {gaps.some((g) => g.kind === "fix") ? (
          <section aria-labelledby="finish-fix" className="grid gap-2">
            <h3 id="finish-fix" className="text-sm font-semibold text-strong">
              Also needs a fix
            </h3>
            <ul className="grid gap-1.5">
              {gaps
                .filter((g) => g.kind === "fix")
                .map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.05] px-3 py-1.5 text-sm text-strong">
                    <span className="flex items-start gap-1.5">
                      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                      {g.detail}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        onClose();
                        onGoTo(g.section);
                      }}
                    >
                      Fix
                    </Button>
                  </li>
                ))}
            </ul>
          </section>
        ) : null}
        <FormError message={error} />
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {picked.length ? "Not now" : "Close"}
        </Button>
        <Button variant="primary" loading={sending} disabled={disabled} onClick={() => void finish()}>
          {picked.length ? (
            <>
              <Sparkles aria-hidden /> Ask Selestial to draft {picked.length}
            </>
          ) : left ? (
            "Done for now"
          ) : (
            "Done"
          )}
        </Button>
      </DialogFooter>
    </>
  );
}

function DoneTag() {
  return (
    <Badge variant="success" size="sm">
      Done
    </Badge>
  );
}

/** The Owner's own costs, worked into prices by the same arithmetic as onboarding, with every assumption shown. */
function CostSuggestion({ spec, suggestion, edit, disabled }: { spec: Spec; suggestion: ReturnType<typeof suggestPricing>; edit: StepProps["edit"]; disabled: boolean }) {
  const [shown, setShown] = useState(false);
  const before = priceSummary(spec);
  const after = priceSummary(suggestion.spec);
  if (before === after && !spec.illustrative) return null;
  return (
    <div className="grid gap-2 rounded-xl border border-brand-500/30 bg-card p-3">
      <p className="text-sm font-medium text-strong">Work it out from your costs</p>
      <p className="text-sm text-muted-foreground">
        {suggestion.typical ? (
          <>
            {suggestion.typical.label}: <span className="font-medium tabular-nums text-strong">{formatCents(suggestion.typical.priceCents)}</span>
            {suggestion.typical.marginPercent !== null ? ` at about ${Math.round(suggestion.typical.marginPercent)}% after direct costs` : ""}. The service becomes {after.charAt(0).toLowerCase() + after.slice(1)}.
          </>
        ) : (
          `The service becomes ${after.charAt(0).toLowerCase() + after.slice(1)}.`
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="secondary" disabled={disabled} onClick={() => edit((s) => ({ ...s, pricing: suggestion.spec.pricing, addOns: suggestion.spec.addOns, modifiers: { ...s.modifiers, minimumCents: suggestion.spec.modifiers.minimumCents }, illustrative: false }))}>
          Use these prices
        </Button>
        <Button size="xs" variant="ghost" aria-expanded={shown} onClick={() => setShown((v) => !v)}>
          {shown ? "Hide how" : "How it was worked out"}
        </Button>
      </div>
      {shown ? (
        <ul className="grid gap-0.5 text-xs text-muted-foreground">
          {suggestion.assumptions.map((a) => (
            <li key={a}>• {a}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── The pop-up prompt ───────────────────────────────────────────────────────────────────────────────

const KEY = (serviceId: string) => `selestial:finish-dismissed:${serviceId}`;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function readDismissed(serviceId: string): boolean {
  try {
    return window.sessionStorage.getItem(KEY(serviceId)) === "1";
  } catch {
    return false;
  }
}

/**
 * A small prompt that pops up when a draft is opened with things left, offering to finish it. Not modal:
 * it never blocks the editor. "Not now" hides it for this browser session.
 */
export function FinishPrompt({ serviceId, gaps, hidden, onOpen }: { serviceId: string; gaps: Gap[]; hidden: boolean; onOpen: () => void }) {
  const dismissed = useSyncExternalStore(
    subscribe,
    () => readDismissed(serviceId),
    () => true,
  );
  if (dismissed || hidden || gaps.length === 0) return null;
  const dismiss = () => {
    try {
      window.sessionStorage.setItem(KEY(serviceId), "1");
    } catch {
      // Private windows may refuse storage: it simply shows again next time.
    }
    listeners.forEach((l) => l());
  };
  const byYou = gaps.filter((g) => g.kind !== "selestial").length;
  const bySelestial = gaps.length - byYou;
  return (
    <aside aria-label="Finish this draft" className="fixed right-4 bottom-20 z-floating w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-brand-500/30 bg-card p-4 shadow-[0_18px_50px_-20px_rgba(15,10,40,0.45)] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 lg:bottom-6">
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-500/10 text-brand-600">
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-strong">
            {gaps.length} thing{gaps.length === 1 ? "" : "s"} left on this draft
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {bySelestial ? `Selestial can draft ${bySelestial}` : ""}
            {bySelestial && byYou ? "; " : ""}
            {byYou ? `${byYou} need${byYou === 1 ? "s" : ""} you` : ""}.
          </p>
        </div>
        <button type="button" aria-label="Not now" onClick={dismiss} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-strong focus-visible:outline-2 focus-visible:outline-brand-500/50">
          <XIcon aria-hidden className="size-4" />
        </button>
      </div>
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="primary" className="flex-1" onClick={onOpen}>
          Finish this draft
        </Button>
        <Button size="sm" variant="ghost" onClick={dismiss}>
          Not now
        </Button>
      </div>
    </aside>
  );
}
