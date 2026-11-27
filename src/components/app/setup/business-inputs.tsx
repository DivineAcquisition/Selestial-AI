"use client";

/**
 * The few answers business configuration needs beyond company details: which services they offer, the
 * costs that decide a price, and where and when they take bookings. Each answer saves as it is given, to
 * its own home (a confirmed fact, the pricing profile, business settings), so setup and the review page
 * show the same thing. Every field can be left blank: blank means "I don't know", never zero.
 */
import { useMutation, useQuery } from "convex/react";
import { useRef, useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, messageOf, TextArea, TextInput } from "@/components/app/form";
import { Button } from "@/components/ui/button";
import { Checkbox, ChoiceChips, Select } from "@/components/ui/selection";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { CATEGORY_CHOICES } from "../../../../convex/lib/setup/facts";

type Inputs = FunctionReturnType<typeof api.configure.inputs>;
type Pay = Inputs["costs"]["pay"];
type Hours = Inputs["hours"];

const DAYS = [
  { weekday: 1, label: "Monday" },
  { weekday: 2, label: "Tuesday" },
  { weekday: 3, label: "Wednesday" },
  { weekday: 4, label: "Thursday" },
  { weekday: 5, label: "Friday" },
  { weekday: 6, label: "Saturday" },
  { weekday: 0, label: "Sunday" },
];

/** "$22.50" → 2250; blank → null. */
export function toCents(value: string): number | null {
  const clean = value.replace(/[$,\s]/g, "");
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
export const fromCents = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(cents % 100 ? 2 : 0));
const toNumber = (value: string) => {
  const clean = value.replace(/[%\s]/g, "");
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const minutes = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
/** ZIP codes from whatever the owner typed: spaces, commas or new lines. */
export const zipsFrom = (text: string) => [...new Set(text.split(/[\s,;]+/).map((z) => z.trim()).filter(Boolean))];

type SaveState = "idle" | "unsaved" | "saving" | "saved" | "failed";

/** "Saved" only once the server confirmed it; a change still in the field says "Unsaved changes". */
function Saved({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  return (
    <span role="status" className={cn("text-xs", state === "failed" ? "text-destructive-foreground" : "text-muted-foreground")}>
      {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "unsaved" ? "Unsaved changes" : "Not saved. Your entry is kept here; try again."}
    </span>
  );
}

function useSave() {
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  // Only the newest save may set the state, so a slow older response never shows "Saved" over a newer edit.
  const latest = useRef(0);
  async function save(work: () => Promise<unknown>) {
    const mine = ++latest.current;
    setState("saving");
    setError(null);
    try {
      await work();
      if (mine === latest.current) setState("saved");
    } catch (caught) {
      if (mine === latest.current) {
        setState("failed");
        setError(messageOf(caught));
      }
    }
  }
  const dirty = () => setState("unsaved");
  return { state, error, save, dirty };
}

type SectionId = "services" | "costs" | "availability";

/** The answers business configuration reads. Setup shows only the section its outcome needs; the review page shows all. */
export function BusinessInputs({ compact = false, sections = ["services", "costs", "availability"] }: { compact?: boolean; sections?: SectionId[] }) {
  const { companyId } = useCompany();
  const inputs = useQuery(api.configure.inputs, { companyId });
  if (inputs === undefined) return <Skeleton className="h-72 rounded-2xl" />;
  return (
    <div className="grid gap-5">
      {sections.includes("services") ? <Offering inputs={inputs} /> : null}
      {sections.includes("costs") ? <CostsForm inputs={inputs} compact={compact} /> : null}
      {sections.includes("availability") ? <Availability inputs={inputs} /> : null}
    </div>
  );
}

function Section({ id, title, lead, aside, children }: { id: string; title: string; lead: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="grid scroll-mt-20 gap-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <header className="grid gap-1">
        <div className="flex items-center gap-2">
          <h2 id={`${id}-heading`} className="text-base font-semibold text-strong">
            {title}
          </h2>
          <span className="ml-auto">{aside}</span>
        </div>
        <p className="text-sm text-muted-foreground">{lead}</p>
      </header>
      {children}
    </section>
  );
}

function Offering({ inputs }: { inputs: Inputs }) {
  const { companyId } = useCompany();
  const saveOffering = useMutation(api.configure.saveOffering);
  const { state, error, save } = useSave();
  const [picked, setPicked] = useState<string[]>(inputs.offered);
  if (!inputs.categories.length) {
    return (
      <Section id="services" title="Services you offer" lead="Tell us who you clean for in your company details first, and the services that fit appear here.">
        <p className="text-sm text-muted-foreground">Nothing to choose yet.</p>
      </Section>
    );
  }
  const toggle = (id: string) => {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    setPicked(next);
    void save(() => saveOffering({ companyId, offered: next }));
  };
  return (
    <Section id="services" title="Services you offer" lead="Pick what you do today. Each becomes a draft in Services & Pricing for you to review. If you skip this, the most common services for your kind of work are prepared." aside={<Saved state={state} />}>
      <div className="grid gap-4">
        {inputs.choices.map((group) => (
          <fieldset key={group.category} className="grid gap-2">
            <legend className="mb-1 text-sm font-medium text-strong">{CATEGORY_CHOICES.find((c) => c.value === group.category)?.label ?? group.category}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {group.choices.map((choice) => (
                <label key={choice.templateId} className={cn("flex cursor-pointer gap-3 rounded-xl border px-3.5 py-3 text-sm transition-colors", picked.includes(choice.templateId) ? "border-brand-500/50 bg-brand-500/5" : "border-border hover:border-brand-500/30")}>
                  <Checkbox className="mt-0.5 shrink-0" checked={picked.includes(choice.templateId)} onCheckedChange={() => toggle(choice.templateId)} disabled={!inputs.canEdit} />
                  <span className="min-w-0">
                    <span className="block font-medium text-strong">{choice.label}</span>
                    <span className="block text-muted-foreground">{choice.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        {!picked.length ? <p className="text-xs text-muted-foreground">Nothing picked, so the common services for your kind of work will be prepared. You can change this any time.</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
      </div>
    </Section>
  );
}

const PAY_OPTIONS = [
  { value: "hourly", label: "By the hour" },
  { value: "per_visit", label: "A set amount per visit" },
  { value: "revenue_share", label: "A share of the price" },
] as const;

export function CostsForm({ inputs, compact }: { inputs: Inputs; compact: boolean }) {
  const { companyId } = useCompany();
  const saveCosts = useMutation(api.configure.saveCosts);
  const { state, error, save, dirty } = useSave();
  const initial = inputs.costs;
  const [model, setModel] = useState<"" | NonNullable<Pay>["model"]>(initial.pay?.model ?? "");
  const [payAmount, setPayAmount] = useState(initial.pay?.model === "hourly" ? fromCents(initial.pay.hourlyCents) : initial.pay?.model === "per_visit" ? fromCents(initial.pay.amountCents) : initial.pay?.model === "revenue_share" ? String(initial.pay.sharePercent) : "");
  const [burden, setBurden] = useState(initial.pay?.model === "hourly" && initial.pay.burdenPercent ? String(initial.pay.burdenPercent) : "");
  const [margin, setMargin] = useState(initial.targetMarginPercent === null ? "" : String(initial.targetMarginPercent));
  const [minimum, setMinimum] = useState(fromCents(initial.minimumJobCents));
  const [supplies, setSupplies] = useState(fromCents(initial.suppliesPerVisitCents));

  function payFrom(nextModel: typeof model, amount: string, burdenText: string): Pay {
    if (nextModel === "hourly") {
      const cents = toCents(amount);
      return cents === null ? null : { model: "hourly", hourlyCents: cents, burdenPercent: toNumber(burdenText) ?? 0 };
    }
    if (nextModel === "per_visit") {
      const cents = toCents(amount);
      return cents === null ? null : { model: "per_visit", amountCents: cents };
    }
    if (nextModel === "revenue_share") {
      const share = toNumber(amount);
      return share === null ? null : { model: "revenue_share", sharePercent: share };
    }
    return null;
  }
  const commit = (overrides: Partial<{ model: typeof model; payAmount: string; burden: string; margin: string; minimum: string; supplies: string }> = {}) => {
    const v = { model, payAmount, burden, margin, minimum, supplies, ...overrides };
    void save(() => saveCosts({ companyId, pay: payFrom(v.model, v.payAmount, v.burden), targetMarginPercent: toNumber(v.margin), minimumJobCents: toCents(v.minimum), suppliesPerVisitCents: toCents(v.supplies) }));
  };
  const disabled = !inputs.canEdit;
  const edit = (set: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => {
    set(event.target.value);
    dirty();
  };

  return (
    <Section id="costs" title="What a job costs you" lead="Two answers are enough to start: how you pay cleaners and the margin you aim for. Selestial works out suggested prices and shows every assumption. They stay drafts until you approve them." aside={<Saved state={state} />}>
      <div className={cn("grid gap-3", !compact && "sm:grid-cols-2")}>
        <Field label="How you pay cleaners">
          <Select
            value={model}
            disabled={disabled}
            options={PAY_OPTIONS}
            placeholder="I don't know yet"
            emptyLabel="I don't know yet"
            onValueChange={(next) => {
              const value = (next ?? "") as typeof model;
              setModel(value);
              setPayAmount("");
              commit({ model: value, payAmount: "" });
            }}
          />
        </Field>
        {model ? (
          <Field label={model === "hourly" ? "Hourly wage ($)" : model === "per_visit" ? "Pay per visit ($)" : "Cleaner's share (%)"}>
            <TextInput inputMode="decimal" value={payAmount} disabled={disabled} onChange={edit(setPayAmount)} onBlur={() => commit()} placeholder={model === "revenue_share" ? "e.g. 45" : "e.g. 22"} />
          </Field>
        ) : null}
        <Field label="Margin you aim for (%)" hint="What's left of the price after direct costs.">
          <TextInput inputMode="decimal" value={margin} disabled={disabled} onChange={edit(setMargin)} onBlur={() => commit()} placeholder="e.g. 40" />
        </Field>
      </div>
      <details className="group rounded-xl border border-border px-3.5 py-2.5" open={Boolean(burden || minimum || supplies) || undefined}>
        <summary className="cursor-pointer text-sm font-medium text-strong focus-visible:outline-2 focus-visible:outline-brand-500">More costs (optional): payroll, minimum job, supplies</summary>
        <div className={cn("mt-3 grid gap-3", !compact && "sm:grid-cols-2")}>
          {model === "hourly" ? (
            <Field label="Payroll costs on top (%)" hint="Taxes, insurance and benefits, as a share of the wage. Leave blank for none.">
              <TextInput inputMode="decimal" value={burden} disabled={disabled} onChange={edit(setBurden)} onBlur={() => commit()} placeholder="e.g. 12" />
            </Field>
          ) : null}
          <Field label="Smallest job you take ($)">
            <TextInput inputMode="decimal" value={minimum} disabled={disabled} onChange={edit(setMinimum)} onBlur={() => commit()} placeholder="e.g. 120" />
          </Field>
          <Field label="Supplies per visit ($)">
            <TextInput inputMode="decimal" value={supplies} disabled={disabled} onChange={edit(setSupplies)} onBlur={() => commit()} placeholder="e.g. 8" />
          </Field>
        </div>
      </details>
      {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
    </Section>
  );
}

/** Copies one day's hours to the days chosen, keeping every other day as it is. Pure, for the shortcut below. */
export function copyHours(hours: Hours, from: number, to: number[]): Hours {
  const source = hours.find((h) => h.weekday === from);
  if (!source) return hours;
  const kept = hours.filter((h) => h.weekday === from || !to.includes(h.weekday));
  return [...kept, ...to.filter((day) => day !== from).map((weekday) => ({ weekday, startMinute: source.startMinute, endMinute: source.endMinute }))].sort((a, b) => a.weekday - b.weekday);
}

export function Availability({ inputs }: { inputs: Inputs }) {
  const { companyId } = useCompany();
  const saveAvailability = useMutation(api.configure.saveAvailability);
  const { state, error, save, dirty } = useSave();
  const [zips, setZips] = useState(inputs.serviceAreas.join(", "));
  const [hours, setHours] = useState<Hours>(inputs.hours);
  const [copying, setCopying] = useState<{ from: number; to: string[] } | null>(null);
  const disabled = !inputs.canEdit;
  const commit = (nextHours: Hours, nextZips = zips) => void save(async () => {
    const result = await saveAvailability({ companyId, serviceAreas: zipsFrom(nextZips), hours: nextHours });
    setZips(result.serviceAreas.join(", "));
  });
  const dayOf = (weekday: number) => hours.find((h) => h.weekday === weekday) ?? null;
  const setDay = (weekday: number, window: { startMinute: number; endMinute: number } | null, persist: boolean) => {
    const next = [...hours.filter((h) => h.weekday !== weekday), ...(window ? [{ weekday, ...window }] : [])].sort((a, b) => a.weekday - b.weekday);
    setHours(next);
    if (persist) commit(next);
    else dirty();
  };

  return (
    <Section id="availability" title="When you take bookings" lead={`Your booking form offers times inside these hours (${inputs.timezone}). Optional now: set one day and copy it to the others.`} aside={<Saved state={state} />}>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 text-sm font-medium text-strong">Days and hours</legend>
        {DAYS.map((day) => {
          const window = dayOf(day.weekday);
          return (
            <div key={day.weekday} className="grid gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex min-w-32 items-center gap-2">
                  <Checkbox checked={window !== null} disabled={disabled} onCheckedChange={(checked) => setDay(day.weekday, checked ? { startMinute: 8 * 60, endMinute: 17 * 60 } : null, true)} />
                  <span className="text-strong">{day.label}</span>
                </label>
                {window ? (
                  <span className="flex items-center gap-1.5">
                    <input aria-label={`${day.label} opens`} type="time" className="h-9 rounded-md border border-input bg-background px-2 focus-visible:outline-2 focus-visible:outline-brand-500" value={clock(window.startMinute)} disabled={disabled} onChange={(e) => { const m = minutes(e.target.value); if (m !== null) setDay(day.weekday, { ...window, startMinute: m }, false); }} onBlur={() => commit(hours)} />
                    <span className="text-muted-foreground">to</span>
                    <input aria-label={`${day.label} closes`} type="time" className="h-9 rounded-md border border-input bg-background px-2 focus-visible:outline-2 focus-visible:outline-brand-500" value={clock(window.endMinute)} disabled={disabled} onChange={(e) => { const m = minutes(e.target.value); if (m !== null) setDay(day.weekday, { ...window, endMinute: m }, false); }} onBlur={() => commit(hours)} />
                  </span>
                ) : (
                  <span className="text-muted-foreground">Closed</span>
                )}
                {window && !disabled ? (
                  <Button variant="ghost" size="xs" className="ml-auto" aria-expanded={copying?.from === day.weekday} onClick={() => setCopying(copying?.from === day.weekday ? null : { from: day.weekday, to: [] })}>
                    Copy to other days
                  </Button>
                ) : null}
              </div>
              {copying?.from === day.weekday ? (
                <div className="grid gap-2 rounded-md bg-muted/40 p-2">
                  <p id={`copy-${day.weekday}`} className="text-xs text-muted-foreground">
                    Copy {day.label}&apos;s hours to:
                  </p>
                  <ChoiceChips
                    aria-labelledby={`copy-${day.weekday}`}
                    density="compact"
                    options={DAYS.filter((d) => d.weekday !== day.weekday).map((d) => ({ value: String(d.weekday), label: d.label.slice(0, 3) }))}
                    value={copying.to}
                    onValueChange={(to) => setCopying({ from: day.weekday, to })}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button size="xs" variant="outline" onClick={() => setCopying({ from: day.weekday, to: ["1", "2", "3", "4", "5"].filter((d) => d !== String(day.weekday)) })}>
                      Weekdays
                    </Button>
                    <Button
                      size="xs"
                      variant="primary"
                      disabled={copying.to.length === 0}
                      onClick={() => {
                        const next = copyHours(hours, day.weekday, copying.to.map(Number));
                        setHours(next);
                        commit(next);
                        setCopying(null);
                      }}
                    >
                      Copy hours
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <details className="rounded-xl border border-border px-3.5 py-2.5" open={zips.trim() ? true : undefined}>
        <summary className="cursor-pointer text-sm font-medium text-strong focus-visible:outline-2 focus-visible:outline-brand-500">Limit online booking to ZIP codes (optional)</summary>
        <div className="mt-3 grid gap-2">
          <p className="text-xs text-muted-foreground">
            This is a real booking rule: an address outside these ZIP codes can&apos;t book online. The areas you described in your company details are only description and limit nothing.
          </p>
          <Field label="ZIP codes customers may book from" hint="Separate them with commas or spaces. Leave empty to accept any address.">
            <TextArea value={zips} disabled={disabled} onChange={(e) => { setZips(e.target.value); dirty(); }} onBlur={() => commit(hours)} placeholder="78701, 78702, 78703" rows={2} />
          </Field>
        </div>
      </details>
      {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
    </Section>
  );
}
