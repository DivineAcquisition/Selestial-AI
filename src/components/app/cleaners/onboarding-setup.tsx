"use client";

/**
 * Team › Cleaners › Onboarding setup. What a new cleaner is asked to do and what each step shows: the
 * agreement each relationship signs, the supplies and who provides them, how jobs work, expectations, the
 * ways the company pays, the training, which steps hold up work and which a person checks. Changes are made
 * as a draft, previewed exactly as a cleaner sees them, and published as a new version. For each part that
 * changed, the Owner decides whether people who already completed it must do it again.
 */
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, FormError, TextArea, TextInput, useRun } from "@/components/app/form";
import { Modal } from "@/components/app/modal";
import { PageHeader } from "@/components/app/shell";
import { GuidedOnboarding, type GuidedView } from "@/components/cleaner/guided-onboarding";
import { ArrowLeft, Eye, Plus, Trash2 } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/selection";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import { CLEANERS_PATH } from "./state";

type Setup = FunctionReturnType<typeof api.onboardingSetup.get>;
type Content = Setup["published"]["content"];
type StepRule = Setup["template"]["steps"][number];

const nativeSelect = "block min-h-10 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-strong";

export function OnboardingSetupScreen() {
  const { companyId, role, name } = useCompany();
  const data = useQuery(api.onboardingSetup.get, { companyId });
  const saveDraft = useMutation(api.onboardingSetup.saveDraft);
  const discard = useMutation(api.onboardingSetup.discardDraft);
  const switchToGuided = useMutation(api.onboardingSetup.useGuided);
  const { busy, error, run } = useRun();
  const [content, setContent] = useState<Content | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [preview, setPreview] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const owner = role === "owner";
  useEffect(() => {
    // The form starts from the draft, or from what is in force.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (data && content === null) setContent(data.draft?.content ?? data.published.content);
  }, [data, content]);
  const dirty = useMemo(() => data && content && JSON.stringify(content) !== JSON.stringify(data.draft?.content ?? data.published.content), [data, content]);

  if (!data || !content) return <Skeleton className="h-[32rem] rounded-2xl" />;
  const save = () => run(async () => setProblems((await saveDraft({ companyId, content })).problems));
  const set = <K extends keyof Content>(key: K, value: Content[K]) => setContent({ ...content, [key]: value });

  return (
    <>
      <Link href={`${CLEANERS_PATH}/onboarding`} className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-strong">
        <ArrowLeft className="size-4" aria-hidden />
        Onboarding checklist
      </Link>
      <PageHeader
        title="Guided onboarding"
        lead="What a new cleaner sees from your invitation link, step by step. Edit a draft, preview it as they will see it, then publish."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => setPreview(true)}>
              <Eye aria-hidden />
              Preview as a cleaner
            </Button>
            {owner ? (
              <>
                <Button variant="outline" size="sm" loading={busy} disabled={!dirty} onClick={() => void save()}>
                  Save draft
                </Button>
                <Button variant="primary" size="sm" disabled={!data.draft || Boolean(dirty)} onClick={() => setPublishing(true)}>
                  Publish
                </Button>
              </>
            ) : null}
          </>
        }
      />
      <FormError message={error} />
      <div className="grid gap-4">
        <p className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          {data.published.version === 0 ? "Using Selestial's starting content." : `Version ${data.published.version} is live${data.published.publishedAt ? `, published ${new Date(data.published.publishedAt).toLocaleDateString()}` : ""}.`}{" "}
          {data.draft ? <span className="font-medium text-strong">You have an unpublished draft{data.changed.length ? ` changing ${data.changed.map((c) => c.label.toLowerCase()).join(", ")}` : ""}.</span> : null}
          {data.draft && owner ? (
            <button type="button" className="ml-2 underline underline-offset-4" onClick={() => void run(async () => { await discard({ companyId }); setContent(data.published.content); })}>
              Discard draft
            </button>
          ) : null}
        </p>
        {problems.length ? <FormError message={problems.join(" ")} /> : null}
        {!owner ? <p className="text-sm text-muted-foreground">Only the Owner changes onboarding. You can preview it.</p> : null}

        <StepRules data={data} owner={owner} onGuided={() => void run(() => switchToGuided({ companyId }))} />

        <Section title="Welcome and support" description="Shown at the top of every cleaner's setup.">
          <Field label="Welcome message (optional)">
            <TextArea value={content.welcome ?? ""} disabled={!owner} onChange={(event) => set("welcome", event.target.value || undefined)} placeholder={`A few short steps to get you ready to work with ${name}.`} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Support phone">
              <TextInput value={content.support.phone ?? ""} disabled={!owner} onChange={(event) => set("support", { ...content.support, phone: event.target.value || undefined })} />
            </Field>
            <Field label="Support email">
              <TextInput value={content.support.email ?? ""} disabled={!owner} onChange={(event) => set("support", { ...content.support, email: event.target.value || undefined })} />
            </Field>
            <Field label="Hours">
              <TextInput value={content.support.hours ?? ""} disabled={!owner} placeholder="Mon–Fri, 8am–5pm" onChange={(event) => set("support", { ...content.support, hours: event.target.value || undefined })} />
            </Field>
          </div>
        </Section>

        <Section title="1. Agreement" description="Which approved agreement each relationship signs. Employees never sign a contractor agreement. Prepare and approve each person's agreement in Agreements; they sign it inside their setup.">
          <div className="grid gap-3 sm:grid-cols-2">
            {(["contractor", "employee"] as const).map((engagement) => (
              <Field key={engagement} label={engagement === "contractor" ? "Independent contractors sign" : "Employees sign"}>
                <select className={nativeSelect} disabled={!owner} value={content.agreementTypes[engagement] ?? ""} onChange={(event) => set("agreementTypes", { ...content.agreementTypes, [engagement]: event.target.value || undefined })}>
                  <option value="">Any working agreement</option>
                  {data.agreementTypes.map((type) => (
                    <option key={type.key} value={type.key}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
        </Section>

        <Section title="3. Supplies" description="What cleaners bring, what you provide, and specialty equipment for particular services. A truthful checklist completes the step whatever is missing.">
          <Field label="When someone is missing a required supply">
            <select className={nativeSelect} disabled={!owner} value={content.supplies.rule} onChange={(event) => set("supplies", { ...content.supplies, rule: event.target.value as Content["supplies"]["rule"] })}>
              <option value="advisory">Dispatch is told; they can still be offered visits</option>
              <option value="required_for_visit">Don&apos;t offer visits that need what they are missing</option>
            </select>
          </Field>
          <ul className="grid gap-2">
            {content.supplies.items.map((item, index) => {
              const update = (patch: Partial<typeof item>) => set("supplies", { ...content.supplies, items: content.supplies.items.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
              return (
                <li key={`${item.id}-${index}`} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1.4fr_1fr_1fr_1.2fr_auto_auto] sm:items-center">
                  <TextInput aria-label="Item" value={item.label} disabled={!owner} onChange={(event) => update({ label: event.target.value })} />
                  <select aria-label="Category" className={nativeSelect} disabled={!owner} value={item.category} onChange={(event) => update({ category: event.target.value as typeof item.category })}>
                    <option value="solutions">Solutions</option>
                    <option value="tools">Tools</option>
                    <option value="safety">Safety</option>
                    <option value="specialty">Specialty</option>
                  </select>
                  <select aria-label="Who provides it" className={nativeSelect} disabled={!owner} value={item.provider} onChange={(event) => update({ provider: event.target.value as typeof item.provider })}>
                    <option value="cleaner">Cleaner brings</option>
                    <option value="company">We provide</option>
                  </select>
                  <TextInput aria-label="Only for services" placeholder="Every job" value={item.forServices.join(", ")} disabled={!owner} onChange={(event) => update({ forServices: event.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={item.required} disabled={!owner} onCheckedChange={(next) => update({ required: next })} /> Required
                  </label>
                  {owner ? (
                    <Button variant="ghost" size="xs" aria-label={`Remove ${item.label}`} onClick={() => set("supplies", { ...content.supplies, items: content.supplies.items.filter((_, i) => i !== index) })}>
                      <Trash2 aria-hidden />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {owner ? (
            <Button variant="outline" size="sm" onClick={() => set("supplies", { ...content.supplies, items: [...content.supplies.items, { id: "", label: "New item", category: "tools", provider: "cleaner", forServices: [], required: false }] })}>
              <Plus aria-hidden /> Add an item
            </Button>
          ) : null}
        </Section>

        <GuideEditor title="4. How your jobs work" description="Your job-day procedure, offer to earnings. Cleaners must tick to confirm; opening it does not count." guide={content.jobGuide} owner={owner} onChange={(guide) => set("jobGuide", guide)} />
        <GuideEditor title="5. Dress code and expectations" description="Your standards for every job, with an optional image. Cleaners must agree explicitly." guide={content.expectations} owner={owner} onChange={(guide) => set("expectations", guide)} />

        <Section title="6. How you pay" description="Only methods Finance › Team Pay can record. Choosing a method records a preference; you confirm it before the first payment. There are no automatic payouts.">
          <div className="flex flex-wrap gap-2">
            {data.payMethods.map((method) => {
              const on = content.payment.methods.includes(method.id as Content["payment"]["methods"][number]);
              return (
                <label key={method.id} className={cn("flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm", on ? "border-brand-500 bg-brand-500/5" : "border-border")}>
                  <Checkbox checked={on} disabled={!owner} onCheckedChange={(next) => set("payment", { ...content.payment, methods: next ? [...content.payment.methods, method.id as Content["payment"]["methods"][number]] : content.payment.methods.filter((m) => m !== method.id) })} />
                  {method.label}
                </label>
              );
            })}
          </div>
          <Field label="Pay schedule, in your words">
            <TextArea value={content.payment.schedule} disabled={!owner} onChange={(event) => set("payment", { ...content.payment, schedule: event.target.value })} />
          </Field>
          <Field label="Anything else about getting paid (optional)">
            <TextInput value={content.payment.instructions ?? ""} disabled={!owner} onChange={(event) => set("payment", { ...content.payment, instructions: event.target.value || undefined })} />
          </Field>
          <p className="text-xs text-muted-foreground">Contractors at a US company are asked for W-9 details inside this step, after a one-time code, and certify them themselves. The form is prepared in the background; you download it from their profile.</p>
        </Section>

        <TrainingEditor content={content} owner={owner} onChange={(training) => set("training", training)} />

        <Section title="Other documents" description="Use a document upload only when you genuinely need an external document, such as an insurance certificate.">
          <Button variant="outline" size="sm" render={<Link href={`${CLEANERS_PATH}/onboarding`} />}>
            Manage document requirements in the checklist
          </Button>
        </Section>
      </div>
      {preview ? <PreviewDialog content={content} data={data} company={name} onClose={() => setPreview(false)} /> : null}
      {publishing ? <PublishDialog data={data} onClose={() => setPublishing(false)} onDone={() => setContent(null)} /> : null}
    </>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div>
        <h2 className="text-base font-semibold text-strong">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

const STEP_KINDS: Record<string, string> = { agreement: "Signature", contact: "Contact verification", availability: "Part of contact", service_areas: "Part of contact", equipment: "Checklist", acknowledgment: "Guide acknowledgment", payment: "Payment setup", tax: "Background (inside pay)", training: "Training", document: "Document upload", custom: "Document upload", skills: "Document upload" };
const REVIEWABLE = ["contact", "equipment", "training", "document", "custom"];

function StepRules({ data, owner, onGuided }: { data: Setup; owner: boolean; onGuided: () => void }) {
  const { companyId } = useCompany();
  const save = useMutation(api.requirements.saveDefinition);
  const { busy, error, run } = useRun();
  const change = (step: StepRule, patch: Partial<StepRule>) =>
    run(() =>
      save({
        companyId,
        key: step.key,
        label: step.label,
        description: step.description ?? undefined,
        kind: step.kind,
        effect: patch.effect ?? step.effect,
        appliesTo: step.appliesTo,
        reviewer: step.reviewer,
        validForDays: step.validForDays,
        providedBy: step.providedBy,
        forServices: step.forServices,
        cleanerCompletes: step.cleanerCompletes,
        agreementDocType: step.agreementDocType,
        officeReview: patch.officeReview ?? step.officeReview,
      }),
    );
  return (
    <Section title="Steps and what they hold up" description="One list for the cleaner's page, your profile view, reminders and Dispatch. A step that holds up work keeps someone from being offered jobs until it is met.">
      {data.template.startingTemplate !== "guided" && !data.template.saved ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-info/30 bg-info/5 px-4 py-3 text-sm">
          <span>Your company uses Selestial&apos;s earlier checklist (identity upload, office-recorded training). Switch to guided onboarding for new cleaners; nobody already onboarding loses anything.</span>
          {owner ? (
            <Button size="sm" variant="primary" onClick={onGuided}>
              Use guided onboarding
            </Button>
          ) : null}
        </div>
      ) : null}
      <FormError message={error} />
      <ul className="grid gap-2">
        {data.template.steps.map((step) => (
          <li key={step.key} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5">
            <span className="min-w-0">
              <span className="font-medium text-strong">{step.label}</span>
              <span className="ml-2 text-xs text-muted-foreground">{STEP_KINDS[step.kind] ?? step.kind}</span>
            </span>
            <span className="flex flex-wrap items-center gap-3 text-sm">
              {step.kind === "tax" || step.kind === "payment" ? (
                <Badge variant="warning" size="sm">
                  Needed before payment
                </Badge>
              ) : (
                <label className="flex items-center gap-2">
                  <Checkbox checked={step.effect === "blocks_assignments"} disabled={!owner || busy} onCheckedChange={(next) => void change(step, { effect: next ? "blocks_assignments" : "informational" })} />
                  Holds up work
                </label>
              )}
              {REVIEWABLE.includes(step.kind) ? (
                <label className="flex items-center gap-2">
                  <Checkbox checked={step.officeReview || step.kind === "document" || step.kind === "custom"} disabled={!owner || busy || step.kind === "document" || step.kind === "custom"} onCheckedChange={(next) => void change(step, { officeReview: next })} />
                  Office reviews
                </label>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function GuideEditor({ title, description, guide, owner, onChange }: { title: string; description: string; guide: Content["jobGuide"]; owner: boolean; onChange: (guide: Content["jobGuide"]) => void }) {
  return (
    <Section title={title} description={description}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title">
          <TextInput value={guide.title} disabled={!owner} onChange={(event) => onChange({ ...guide, title: event.target.value })} />
        </Field>
        <Field label="Image address (optional, https)" hint="Its words must also be in the sections below.">
          <TextInput value={guide.imageUrl ?? ""} disabled={!owner} onChange={(event) => onChange({ ...guide, imageUrl: event.target.value || undefined })} />
        </Field>
      </div>
      <Field label="Introduction">
        <TextArea value={guide.intro} disabled={!owner} onChange={(event) => onChange({ ...guide, intro: event.target.value })} />
      </Field>
      <ol className="grid gap-2">
        {guide.sections.map((section, index) => (
          <li key={index} className="grid gap-2 rounded-xl border border-border p-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">{index + 1}</span>
              <TextInput aria-label="Section title" value={section.title} disabled={!owner} onChange={(event) => onChange({ ...guide, sections: guide.sections.map((row, i) => (i === index ? { ...row, title: event.target.value } : row)) })} />
              {owner ? (
                <Button variant="ghost" size="xs" aria-label="Remove section" onClick={() => onChange({ ...guide, sections: guide.sections.filter((_, i) => i !== index) })}>
                  <Trash2 aria-hidden />
                </Button>
              ) : null}
            </div>
            <TextArea aria-label="Section text" value={section.body} disabled={!owner} onChange={(event) => onChange({ ...guide, sections: guide.sections.map((row, i) => (i === index ? { ...row, body: event.target.value } : row)) })} />
          </li>
        ))}
      </ol>
      {owner ? (
        <Button variant="outline" size="sm" onClick={() => onChange({ ...guide, sections: [...guide.sections, { title: "New section", body: "" }] })}>
          <Plus aria-hidden /> Add a section
        </Button>
      ) : null}
      <Field label="What they tick to agree">
        <TextInput value={guide.agreeLabel} disabled={!owner} onChange={(event) => onChange({ ...guide, agreeLabel: event.target.value })} />
      </Field>
    </Section>
  );
}

function TrainingEditor({ content, owner, onChange }: { content: Content; owner: boolean; onChange: (training: Content["training"]) => void }) {
  const modules = content.training.modules;
  const update = (index: number, patch: Partial<(typeof modules)[number]>) => onChange({ modules: modules.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  return (
    <Section title="7. Training" description="Required and optional modules. A video counts only when watched to the end; a guide only when every section is read and its questions answered.">
      <ul className="grid gap-3">
        {modules.map((lesson, index) => (
          <li key={`${lesson.key}-${index}`} className="grid gap-2 rounded-xl border border-border p-3">
            <div className="grid gap-2 sm:grid-cols-[2fr_1fr_auto_auto] sm:items-center">
              <TextInput aria-label="Module title" value={lesson.title} disabled={!owner} onChange={(event) => update(index, { title: event.target.value })} />
              <select aria-label="Kind" className={nativeSelect} disabled={!owner} value={lesson.kind} onChange={(event) => update(index, { kind: event.target.value as "video" | "guide", sections: event.target.value === "guide" ? (lesson.sections ?? [{ title: "Section 1", body: "" }]) : undefined })}>
                <option value="guide">Guide with questions</option>
                <option value="video">Video</option>
              </select>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={lesson.required} disabled={!owner} onCheckedChange={(next) => update(index, { required: next })} /> Required
              </label>
              {owner ? (
                <Button variant="ghost" size="xs" aria-label={`Remove ${lesson.title}`} onClick={() => onChange({ modules: modules.filter((_, i) => i !== index) })}>
                  <Trash2 aria-hidden />
                </Button>
              ) : null}
            </div>
            {lesson.kind === "video" ? (
              <Field label="Video file address (https, .mp4 or .webm)">
                <TextInput value={lesson.videoUrl ?? ""} disabled={!owner} onChange={(event) => update(index, { videoUrl: event.target.value })} />
              </Field>
            ) : (
              <ol className="grid gap-2">
                {(lesson.sections ?? []).map((section, s) => (
                  <li key={s} className="grid gap-1.5 rounded-lg bg-muted/40 p-2">
                    <TextInput aria-label="Section title" value={section.title} disabled={!owner} onChange={(event) => update(index, { sections: lesson.sections!.map((row, i) => (i === s ? { ...row, title: event.target.value } : row)) })} />
                    <TextArea aria-label="Section text" value={section.body} disabled={!owner} onChange={(event) => update(index, { sections: lesson.sections!.map((row, i) => (i === s ? { ...row, body: event.target.value } : row)) })} />
                    {section.check ? <p className="text-xs text-muted-foreground">Question: {section.check.question}</p> : null}
                  </li>
                ))}
                {owner ? (
                  <Button variant="ghost" size="xs" onClick={() => update(index, { sections: [...(lesson.sections ?? []), { title: "New section", body: "" }] })}>
                    <Plus aria-hidden /> Add a section
                  </Button>
                ) : null}
              </ol>
            )}
          </li>
        ))}
      </ul>
      {owner ? (
        <Button variant="outline" size="sm" onClick={() => onChange({ modules: [...modules, { key: "", title: "New lesson", kind: "video", required: true, videoUrl: "" }] })}>
          <Plus aria-hidden /> Add a lesson
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground">A certificate issued by someone else (for example, a safety course) is a document requirement in the checklist, not a lesson.</p>
    </Section>
  );
}

/** The exact cleaner screens, from the draft, with sample progress. Nothing can be sent from it. */
function PreviewDialog({ content, data, company, onClose }: { content: Content; data: Setup; company: string; onClose: () => void }) {
  const view = previewView(content, data, company);
  return (
    <Modal open onClose={onClose} title="Preview as a cleaner" description="A new independent contractor's setup, from your current draft.">
      <div className="mx-auto max-h-[75vh] w-full max-w-[420px] overflow-y-auto rounded-[2rem] border-8 border-strong/80 bg-background">
        <GuidedOnboarding view={view} token={null} />
      </div>
    </Modal>
  );
}

function PublishDialog({ data, onClose, onDone }: { data: Setup; onClose: () => void; onDone: () => void }) {
  const { companyId } = useCompany();
  const publish = useMutation(api.onboardingSetup.publish);
  const counts = useQuery(api.onboardingSetup.completions, { companyId });
  const { busy, error, run } = useRun();
  const [again, setAgain] = useState<string[]>([]);
  const [note, setNote] = useState("");
  return (
    <Modal open onClose={onClose} title={`Publish version ${data.published.version + 1}`} description="New cleaners see it at once. For each changed part, decide whether people who already completed it must do it again.">
      <div className="grid gap-3">
        {data.changed.length === 0 ? <p className="text-sm text-muted-foreground">Nothing anyone completes has changed; only wording around the steps.</p> : null}
        {data.changed.map((part) => (
          <label key={part.key} className="flex items-start gap-3 rounded-xl border border-border p-3 text-sm">
            <Checkbox checked={again.includes(part.key)} onCheckedChange={(next) => setAgain(next ? [...again, part.key] : again.filter((k) => k !== part.key))} className="mt-0.5" />
            <span>
              <span className="font-medium text-strong">Ask again: {part.label}</span>
              <span className="block text-muted-foreground">{counts?.[part.key] ?? 0} people completed it. Leave unticked for a wording fix; tick for a new rule. Their earlier completion and its evidence are kept either way.</span>
            </span>
          </label>
        ))}
        <Field label="Note for the history (optional)">
          <TextInput value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void run(async () => { await publish({ companyId, again, note: note || undefined }); onDone(); onClose(); })}>
            Publish
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** A believable new contractor partway through, built from the draft, in the shape the cleaner's page reads. */
export function previewView(content: Content, data: Setup, company: string): GuidedView {
  const steps = data.template.steps.filter((step) => step.appliesTo.includes("contractor"));
  const has = (kind: string) => steps.some((step) => step.kind === kind);
  const order: [string, GuidedView["journey"]["steps"][number]["type"], string][] = [
    ["agreement", "signature", "Review and sign your agreement"],
    ["contact", "contact_verification", "Verify your phone and confirm your details"],
    ["equipment", "checklist", "Check your supplies"],
    ["acknowledgment:job_day", "guide_acknowledgment", content.jobGuide.title],
    ["acknowledgment:policies", "guide_acknowledgment", content.expectations.title],
    ["payment", "payment_setup", "Set up how you get paid"],
    ["training", "training", "Complete your training"],
  ];
  const shown = order.filter(([kind]) => (kind.startsWith("acknowledgment:") ? steps.some((s) => s.key === kind.split(":")[1]) : has(kind)));
  const journeySteps = shown.map(([kind, type, title], index) => ({
    id: kind.includes(":") ? kind.split(":")[1] : (steps.find((s) => s.kind === kind)?.key ?? kind),
    type,
    number: index + 1,
    title,
    description: null,
    keys: [kind.includes(":") ? kind.split(":")[1] : kind],
    state: (index === 0 ? "done" : "todo") as "done" | "todo",
    blocksWork: true,
    dependsOn: [],
    locked: false,
    changes: null,
    open: [],
  }));
  return {
    company: { name: company, logoUrl: null, brandColor: "#5b33d6", support: { phone: content.support.phone ?? null, email: content.support.email ?? null, hours: content.support.hours ?? null }, welcome: content.welcome ?? null },
    firstName: "Maria",
    focus: null,
    expiresAt: Date.now() + 30 * 86_400_000,
    timezone: "America/Chicago",
    journey: { state: "in_progress", steps: journeySteps, finished: 1, total: journeySteps.length, next: journeySteps[1]?.id ?? null, actionable: [] },
    readiness: { state: "onboarding", summary: "" },
    verified: true,
    agreement: { title: "Independent Contractor Agreement", workflow: "partially_signed", role: "Independent contractor", pay: "45% of each job's price", markdown: "", version: 1, hash: "", hosted: true, canSign: false, signedAt: Date.now(), typedName: "Maria Lopez", others: [{ name: company, role: "company", signed: false }], expiresAt: null, consent: "" },
    contact: { phone: "+1 512 555 0142", email: "maria@example.com", phoneVerifiedAt: null, textsWording: `${company} work texts`, windows: [], areas: [], asksHours: true, asksAreas: true },
    supplies: { key: "equipment", items: content.supplies.items, answers: {}, submittedAt: null, rule: content.supplies.rule },
    guides: [
      { key: "job_day", ...content.jobGuide, hash: "preview", agreedAt: null },
      { key: "policies", ...content.expectations, hash: "preview", agreedAt: null },
    ],
    payment: { key: "payment_setup", methods: content.payment.methods.map((id) => ({ id, label: data.payMethods.find((m) => m.id === id)?.label ?? id, detail: data.payMethods.find((m) => m.id === id)?.detail ?? "" })), schedule: content.payment.schedule, instructions: content.payment.instructions ?? null, pay: "45% of each job's price", current: null, tax: { form: "w9", status: "awaiting_information", needsWorker: true, secureReady: true, legalName: "Maria Lopez", tinLast4: null, tinType: null, certification: "Under penalties of perjury, I certify…" } },
    training: { key: "training", modules: content.training.modules.map((m) => ({ ...m, sections: m.sections?.map((s) => ({ title: s.title, body: s.body, check: s.check ? { question: s.check.question, options: s.check.options } : null })), completedAt: null, watchedSeconds: 0, sectionsRead: [] })) },
    documents: [],
  } as GuidedView;
}
