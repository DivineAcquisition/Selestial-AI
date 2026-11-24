"use client";

import { useMutation } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, FormError, TextArea, TextInput, useRun } from "@/components/app/form";
import { FileSpreadsheet, Plus, Sparkles, TemplateIcon, Upload } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SegmentedControl, Select, SelectionCards } from "@/components/ui/selection";
import { importPath, SERVICES_ROOT, servicePath } from "@/lib/app/services";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import { blankSpec, CATEGORIES, CATEGORY_LABELS, FULLY_SUPPORTED, METHOD_LABELS, type Category } from "../../../../convex/lib/services/spec";
import { TEMPLATES } from "../../../../convex/lib/services/templates";
import { Notice } from "./shared";

type Mode = "selestial" | "template" | "import" | "blank";
const MODES: { id: Mode; label: string; blurb: string; icon: typeof Sparkles }[] = [
  { id: "selestial", label: "Describe it", blurb: "Say what the service is. Selestial drafts it beside the editor and asks what a price needs.", icon: Sparkles },
  { id: "template", label: "Use a template", blurb: "Start from a structure for a kind of cleaning and make it yours.", icon: TemplateIcon },
  { id: "import", label: "Import prices", blurb: "A spreadsheet or a pasted price list, reviewed row by row.", icon: Upload },
  { id: "blank", label: "Create manually", blurb: "Start from an empty service and fill it in yourself.", icon: Plus },
];

const CATEGORY_BLURB: Record<Category, string> = {
  residential: "Homes: regular, deep and move-out cleans.",
  commercial: "Offices, retail, common areas and warehouses.",
  short_term_rental: "Turnovers, linens, restocking and periodic deep cleans.",
  property_management: "Vacant units, portfolios and community spaces.",
  post_construction: "Rough, final and touch-up cleans after building work.",
  specialty: "Windows, carpets, floor care and events.",
};

export function NewService() {
  const params = useSearchParams();
  const router = useRouter();
  const mode = (MODES.find((m) => m.id === params.get("mode"))?.id ?? "selestial") as Mode;
  const { role } = useCompany();
  if (role === "office") return <Notice>Your role can read services but not start them. Ask the Owner or a Manager.</Notice>;
  return (
    <div className="grid grid-cols-1 gap-5">
      <div role="tablist" aria-label="How to start" className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {MODES.map(({ id, label, blurb, icon: Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={mode === id} onClick={() => router.replace(`${SERVICES_ROOT}/new?mode=${id}`)} className={cn("flex gap-3 rounded-2xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-brand-500/50", mode === id ? "border-brand-500 bg-brand-500/[0.06]" : "border-border bg-card hover:border-brand-500/40")}>
            <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-brand-600" />
            <span>
              <span className="block text-sm font-semibold text-strong">{label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{blurb}</span>
            </span>
          </button>
        ))}
      </div>
      {mode === "selestial" ? <BuildWithSelestial /> : mode === "template" ? <FromTemplate /> : mode === "import" ? <ImportPricing /> : <Blank />}
    </div>
  );
}

const EXAMPLES = [
  "A standard home clean for regular customers: kitchen, bathrooms, floors and dusting. Two cleaners, about three hours.",
  "Airbnb turnovers for 1–4 bedroom homes, with laundry done on site and restocking.",
  "Office cleaning after hours, priced by square foot.",
];

/**
 * Describe a service and Selestial drafts it, in the service's own workspace: the draft is created here,
 * the request goes to Selestial beside it, and the page opens with the conversation alongside the editor.
 */
function BuildWithSelestial() {
  const { companyId } = useCompany();
  const router = useRouter();
  const start = useMutation(api.services.startDraft);
  const send = useMutation(api.chat.send);
  const { busy, error, run } = useRun();
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("residential");
  const begin = () =>
    run(async () => {
      const { serviceId, revision } = await start({ companyId, category, spec: { ...blankSpec(category), name: name.trim() }, origin: "manual" });
      await send({ companyId, text: `Draft this service from my description. Ask me for anything a price needs; use only amounts I give.\n\n${text.trim()}`, clientKey: `describe-${serviceId}`, origin: { kind: "service_draft", serviceId }, draftRevision: revision, page: servicePath(serviceId) });
      router.push(`${servicePath(serviceId)}?panel=assistant`);
    });
  return (
    <div className="grid grid-cols-1 gap-4 rounded-2xl border border-border bg-card p-4 sm:p-6">
      <div>
        <h2 className="font-heading text-lg tracking-tight text-strong">Describe it to Selestial</h2>
        <p className="mt-1 text-sm text-muted-foreground">Selestial drafts the scope, crew and questions, and asks for any amount a price needs. You see every change beside the editor, can undo any of them, and nothing is published. Each answer uses one Chat credit.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Service name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Standard clean" maxLength={80} />
        </Field>
        <label className="grid grid-cols-1 gap-1.5 text-sm">
          <span className="font-medium text-strong">Kind of cleaning</span>
          <Select value={category} onValueChange={(next) => setCategory((next ?? "residential") as Category)} options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))} />
        </label>
      </div>
      <Field label="In your own words">
        <TextArea value={text} rows={4} onChange={(event) => setText(event.target.value)} placeholder={EXAMPLES[0]} />
      </Field>
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <button key={example} type="button" className="rounded-full border border-border bg-card px-3 py-1 text-left text-xs text-strong hover:border-brand-500/50 focus-visible:outline-2 focus-visible:outline-brand-500/40" onClick={() => setText(example)}>
            {example}
          </button>
        ))}
      </div>
      <FormError message={error} />
      <div>
        <Button variant="primary" loading={busy} disabled={!name.trim() || !text.trim()} onClick={() => void begin()}>
          <Sparkles aria-hidden /> Draft it with Selestial
        </Button>
      </div>
    </div>
  );
}

/** Structural templates. Amounts are illustrative and labeled so; publishing waits until the owner confirms them. */
function FromTemplate() {
  const { companyId } = useCompany();
  const router = useRouter();
  const start = useMutation(api.services.startDraft);
  const { busy, error, run } = useRun();
  const [category, setCategory] = useState<Category>("residential");
  const [picked, setPicked] = useState<string | null>(null);
  const templates = TEMPLATES.filter((t) => t.category === category);
  return (
    <div className="grid grid-cols-1 gap-4">
      <Notice title="Templates are structure, not your rates">Every amount in a template is illustrative and marked so. A service made from one can&apos;t be published until you confirm or replace its amounts for your market, and specialized work lists what your company must confirm it has.</Notice>
      <div role="tablist" aria-label="Kind of cleaning" className="flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => (
          <button key={c} type="button" role="tab" aria-selected={category === c} onClick={() => setCategory(c)} className={cn("rounded-full border px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-brand-500/40", category === c ? "border-brand-500 bg-brand-500/[0.08] font-medium text-strong" : "border-border bg-card text-muted-foreground hover:text-strong")}>
            {CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {CATEGORY_BLURB[category]} {FULLY_SUPPORTED.includes(category) ? "Fully supported at launch." : "Offered as a template: these start on a walkthrough until you set your prices."}
      </p>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {templates.map((t) => (
          <li key={t.id} className="flex flex-col rounded-2xl border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-heading text-base tracking-tight text-strong">{t.name}</h3>
              <Badge variant="warning" size="sm">
                Illustrative amounts
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{t.blurb}</p>
            <dl className="mt-3 grid gap-1.5 text-xs">
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">Priced by</dt>
                <dd className="text-strong">{t.methods.map((m) => METHOD_LABELS[m].label).join(" · ")}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">Includes</dt>
                <dd className="text-strong">{t.spec.included.length} tasks, {t.spec.excluded.length} exclusions</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">Staffing</dt>
                <dd className="text-strong">{t.staffing}</dd>
              </div>
              {t.spec.requirements.length ? (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">You confirm</dt>
                  <dd className="text-strong">{t.spec.requirements.map((r) => r.label).join("; ")}</dd>
                </div>
              ) : null}
            </dl>
            <div className="mt-auto pt-4">
              <Button
                variant={picked === t.id ? "primary" : "secondary"}
                size="sm"
                loading={busy && picked === t.id}
                onClick={() => {
                  setPicked(t.id);
                  void run(async () => {
                    const { serviceId } = await start({ companyId, category: t.category, spec: t.spec, origin: "template", templateId: t.id });
                    router.push(servicePath(serviceId));
                  });
                }}
              >
                Use this template
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <FormError message={error} />
    </div>
  );
}

/** A spreadsheet (as CSV) or pasted text, read in code and held for review. */
function ImportPricing() {
  const { companyId } = useCompany();
  const router = useRouter();
  const create = useMutation(api.servicesImports.create);
  const { busy, error, run, setError } = useRun();
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"csv" | "text">("text");
  const file = useRef<HTMLInputElement>(null);
  const read = (picked: File) => {
    if (picked.size > 400_000) return setError("That file is larger than Selestial reads at once. Split it, or save only the price list as CSV.");
    if (/\.(xlsx|xls|numbers|pdf|docx?)$/i.test(picked.name)) return setError("Save the sheet as CSV (File › Save as or Download › CSV), then choose that file. PDFs and Word files are not read here; paste their price list instead.");
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ""));
      setName(picked.name);
      setKind(/\.csv$/i.test(picked.name) ? "csv" : "text");
      setError(null);
    };
    reader.readAsText(picked);
  };
  return (
    <div className="grid grid-cols-1 gap-4 rounded-2xl border border-border bg-card p-4 sm:p-6">
      <div>
        <h2 className="font-heading text-lg tracking-tight text-strong">Bring in your current prices</h2>
        <p className="mt-1 text-sm text-muted-foreground">Selestial reads each line, keeps where it came from, and flags anything unclear: a price with no unit, &ldquo;per hour&rdquo; without saying per cleaner or per crew, a missing scope, or a duplicate. Nothing becomes a service until you review it, and nothing goes live until it is published. Reading a file costs nothing.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={file} type="file" accept=".csv,.txt,text/csv,text/plain" className="sr-only" onChange={(event) => event.target.files?.[0] && read(event.target.files[0])} aria-label="Choose a CSV or text file" />
        <Button variant="secondary" size="sm" onClick={() => file.current?.click()}>
          <FileSpreadsheet aria-hidden /> Choose a CSV or text file
        </Button>
        {name ? <span className="text-sm text-muted-foreground">{name}</span> : <span className="text-sm text-muted-foreground">or paste below</span>}
      </div>
      <Field label="Your price list" hint="One service per line, like “Standard clean — $150 per visit — kitchen, baths, floors”. For a spreadsheet, a header row with Service, Price, Unit and Description helps.">
        <TextArea rows={8} value={text} onChange={(event) => setText(event.target.value)} placeholder={"Standard clean — $150 per visit — kitchen, baths, floors\nDeep clean — $280 per visit\nWindows — $8 per window"} />
      </Field>
      <SegmentedControl label="How the list is written" value={kind} onChange={setKind} options={[{ id: "text", label: "One service per line" }, { id: "csv", label: "Spreadsheet (CSV)" }]} />
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          loading={busy}
          disabled={!text.trim()}
          onClick={() =>
            void run(async () => {
              const result = await create({ companyId, kind, name: name || (kind === "csv" ? "Spreadsheet" : "Pasted price list"), source: text });
              if (result.state === "failed") setError(result.error);
              else router.push(importPath(result.importId));
            })
          }
        >
          Read it
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">PDFs and photos of price lists are not read yet: paste their text.</p>
    </div>
  );
}

function Blank() {
  const { companyId } = useCompany();
  const router = useRouter();
  const start = useMutation(api.services.startDraft);
  const { busy, error, run } = useRun();
  const [category, setCategory] = useState<Category>("residential");
  const [name, setName] = useState("");
  return (
    <div className="grid grid-cols-1 gap-4 rounded-2xl border border-border bg-card p-4 sm:p-6">
      <h2 className="font-heading text-lg tracking-tight text-strong">Add a service</h2>
      <Field label="Name customers will see">
        <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Standard clean" maxLength={80} />
      </Field>
      <Field label="Kind of cleaning">
        <SelectionCards type="single" columns={3} value={category} onValueChange={setCategory} options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c], description: CATEGORY_BLURB[c] }))} />
      </Field>
      <FormError message={error} />
      <div>
        <Button
          variant="primary"
          loading={busy}
          disabled={!name.trim()}
          onClick={() =>
            void run(async () => {
              const { serviceId } = await start({ companyId, category, spec: { ...blankSpec(category), name: name.trim() }, origin: "manual" });
              router.push(servicePath(serviceId));
            })
          }
        >
          Start building
        </Button>
      </div>
    </div>
  );
}
