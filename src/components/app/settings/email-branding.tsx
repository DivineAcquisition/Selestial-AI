"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, messageOf, TextInput } from "@/components/app/form";
import { Guard } from "@/components/app/settings/guard";
import { SaveBar, useSavedDraft, useUnsavedWarning } from "@/components/app/settings/save-bar";
import { CheckCircle2 as CheckCircle, DesktopIcon, DeviceMobileIcon, Eye, Info, Mail, PenLine, RotateCcw, SendIcon, TriangleAlert, Upload } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { SegmentedControl, Select, SelectionCards, SwitchRow } from "@/components/ui/selection";
import { appearanceIsDefault, choicesFrom, draftFrom, draftProblems, resetAppearance, savedFrom, type BrandingDraft, type SavedChoices } from "@/lib/app/email-branding";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { checkClosing, checkColor, checkEmail, checkPhone, checkSenderName, checkWebsite, resolveBranding, type ResolvedBranding } from "../../../../convex/lib/email/branding";
import { brandedLetter } from "../../../../convex/lib/email/templates/company";
import type { SampleId } from "../../../../convex/lib/email/brandingSamples";

export type EmailBrandingData = NonNullable<ReturnType<typeof useQuery<typeof api.emailBranding.get>>>;

// ── Small pieces ────────────────────────────────────────────────────────────────────────────────

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-2xl border border-border bg-card">
      <header className="border-b border-border px-4 py-3 sm:px-5">
        <h2 id={id} className="text-base font-semibold text-strong">
          {title}
        </h2>
        {intro ? <p className="mt-0.5 text-sm text-muted-foreground">{intro}</p> : null}
      </header>
      <div className="grid gap-5 px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

function Note({ tone = "info", children }: { tone?: "info" | "warning" | "good"; children: React.ReactNode }) {
  const Icon = tone === "warning" ? TriangleAlert : tone === "good" ? CheckCircle : Info;
  return (
    <p className={cn("flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm", tone === "warning" ? "bg-warning/10 text-strong" : tone === "good" ? "bg-success/10 text-strong" : "bg-muted text-muted-foreground")}>
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", tone === "warning" ? "text-warning" : tone === "good" ? "text-success" : "")} />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function ColorField({ label, value, fallback, onChange, hint, disabled, resetLabel }: { label: string; value: string; fallback: string; onChange: (v: string) => void; hint?: string; disabled?: boolean; resetLabel: string }) {
  const shown = value || fallback;
  const error = value ? checkColor(value, label) : null;
  return (
    <Field label={label} hint={value ? undefined : hint} error={error}>
      <span className="flex items-center gap-2">
        <input type="color" aria-label={`${label} picker`} value={/^#[0-9a-f]{6}$/i.test(shown) ? shown : "#6838EF"} disabled={disabled} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-border disabled:cursor-not-allowed" />
        <TextInput value={value} placeholder={fallback} maxLength={7} disabled={disabled} onChange={(e) => onChange(e.target.value.trim())} className="font-mono" />
        {value && !disabled ? (
          <button type="button" onClick={() => onChange("")} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            {resetLabel}
          </button>
        ) : null}
      </span>
    </Field>
  );
}

// ── Preview ─────────────────────────────────────────────────────────────────────────────────────

/** The email in a frame that can't run anything or go anywhere, sized to its content. */
function EmailFrame({ html, width, title }: { html: string; width: "desktop" | "mobile"; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(640);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    // Measured again whenever the frame or the email changes size: a frame first drawn while hidden (the
    // phone layout's Edit tab) would otherwise keep the height it had then.
    const observer = new ResizeObserver(() => fit());
    const fit = () => {
      const body = frame.contentDocument?.body;
      if (!body) return;
      if (body.scrollHeight > 0) setHeight(Math.max(320, Math.ceil(body.scrollHeight)));
      observer.observe(body);
    };
    observer.observe(frame);
    frame.addEventListener("load", fit);
    if (frame.contentDocument?.readyState === "complete") fit();
    return () => {
      frame.removeEventListener("load", fit);
      observer.disconnect();
    };
  }, [html, width]);
  return (
    <div className={cn("mx-auto overflow-hidden rounded-xl border border-border bg-[#F5F4FA] transition-[width]", width === "desktop" ? "w-full" : "w-[375px] max-w-full")}>
      {/* No scripts and no navigation: the sandbox only lets the frame be measured. */}
      <iframe ref={ref} title={title} sandbox="allow-same-origin" srcDoc={html} className="block w-full border-0" style={{ height }} />
    </div>
  );
}

/** Mail programs that block images show the alt text instead. */
const withoutImages = (html: string) => html.replace(/<img\b[^>]*?\balt="([^"]*)"[^>]*>/g, (_, alt: string) => `<span style="display:inline-block;padding:6px 10px;border:1px dashed #8A8FA3;border-radius:6px;font-family:Arial,sans-serif;font-size:14px;color:#5E6478;">${alt}</span>`);

function Preview({ data, branding, replyWords }: { data: EmailBrandingData; branding: ResolvedBranding; replyWords: string }) {
  const [sampleId, setSampleId] = useState<SampleId>("booking_confirmation");
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");
  const [images, setImages] = useState<"on" | "off">("on");
  const sample = data.samples.find((s) => s.id === sampleId) ?? data.samples[0];
  const letter = useMemo(() => brandedLetter({ branding, text: sample.body, reason: sample.reason }), [branding, sample]);
  const html = images === "off" ? withoutImages(letter.html) : letter.html;
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <Field label="Sample email" hint={`Sent by ${sample.sentBy}. Sample content, not a real customer.`}>
          <Select value={sampleId} onValueChange={(v) => v && setSampleId(v as SampleId)} options={data.samples.map((s) => ({ value: s.id, label: s.label }))} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <SegmentedControl label="Preview size" hideLabel density="compact" value={width} onChange={setWidth} options={[{ id: "desktop", label: <span className="inline-flex items-center gap-1.5"><DesktopIcon className="size-3.5" />Desktop</span> }, { id: "mobile", label: <span className="inline-flex items-center gap-1.5"><DeviceMobileIcon className="size-3.5" />Phone</span> }]} />
          <SegmentedControl label="Images" hideLabel density="compact" value={images} onChange={setImages} options={[{ id: "on", label: "Images on" }, { id: "off", label: "Images off" }]} />
        </div>
      </div>
      <dl className="grid gap-1.5 rounded-xl border border-border bg-card px-4 py-3 text-sm">
        {[
          ["From", `${branding.senderName} <${data.sender.address ?? "address assigned when delivery is ready"}>`],
          ["Reply to", replyWords],
          ["Subject", sample.subject],
        ].map(([k, value]) => (
          <div key={k} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-words font-medium text-strong">{value}</dd>
          </div>
        ))}
        <p className="pt-1 text-xs text-muted-foreground">
          <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 font-medium uppercase tracking-wide text-strong">Sample</span>
          The names, times and prices are made up. Links go nowhere.
        </p>
      </dl>
      <EmailFrame html={html} width={width} title={`Preview: ${sample.label}`} />
    </div>
  );
}

// ── Test email ──────────────────────────────────────────────────────────────────────────────────

function TestEmail({ data, dirty }: { data: EmailBrandingData; dirty: boolean }) {
  const { companyId } = useCompany();
  const send = useMutation(api.emailBranding.sendTest);
  const [sample, setSample] = useState<SampleId>("booking_confirmation");
  const [to, setTo] = useState<"me" | "reply">("me");
  const [sent, setSent] = useState<Id<"messages"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = useQuery(api.emailBranding.testStatus, sent ? { companyId, messageId: sent } : "skip");
  if (!data.canEdit) return null;
  const recipients = [...(data.test.to ? [{ value: "me" as const, label: `Me (${data.test.to.masked})` }] : []), ...(data.test.reply ? [{ value: "reply" as const, label: `Reply address (${data.test.reply})` }] : [])];
  return (
    <section aria-labelledby="test-email" className="grid gap-3 rounded-2xl border border-border bg-card px-4 py-4 sm:px-5">
      <div>
        <h2 id="test-email" className="text-base font-semibold text-strong">
          Send me a test email
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          A real email through Selestial, marked as a test, with sample content. It goes only to you{data.test.reply ? " or your verified reply address" : ""}, up to 5 an hour, and is charged like any business email ({data.billing.perEmail}).
        </p>
      </div>
      {!data.sending.ready ? (
        <Note tone="warning">{data.sending.words}</Note>
      ) : recipients.length === 0 ? (
        <Note tone="warning">Your sign-in email isn&apos;t verified, so there&apos;s nowhere safe to send a test.</Note>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Sample">
              <Select value={sample} onValueChange={(v) => v && setSample(v as SampleId)} options={data.samples.map((s) => ({ value: s.id, label: s.label }))} />
            </Field>
            <Field label="Send to">
              <Select value={to} onValueChange={(v) => v && setTo(v as "me" | "reply")} options={recipients} />
            </Field>
          </div>
          {dirty ? <Note>Tests use your saved branding. Save your changes first to test them.</Note> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={busy}
              disabled={busy || dirty}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const result = await send({ companyId, sample, to });
                  setSent(result.messageId);
                } catch (e) {
                  setError(messageOf(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <SendIcon aria-hidden /> Send test email
            </Button>
            <span role="status" aria-live="polite" className="text-sm">
              {error ? <span className="text-destructive-foreground">{error}</span> : status ? (
                <span className={cn(status.tone === "good" ? "text-success" : status.tone === "bad" ? "text-destructive-foreground" : "text-muted-foreground")}>
                  {status.label}
                  {status.to ? ` · to ${status.to}` : ""}
                  {status.problem && status.tone === "bad" ? `: ${status.problem}` : ""}
                </span>
              ) : null}
            </span>
          </div>
        </>
      )}
    </section>
  );
}

// ── Replies ─────────────────────────────────────────────────────────────────────────────────────

const HOW_WORDS = { code: "confirmed with a code", sign_in: "your verified sign-in email", connected_inbox: "a connected inbox" } as const;

function Replies({ data }: { data: EmailBrandingData }) {
  const { companyId } = useCompany();
  const request = useMutation(api.emailBranding.requestReply);
  const confirm = useMutation(api.emailBranding.confirmReply);
  const cancel = useMutation(api.emailBranding.cancelReply);
  const clear = useMutation(api.emailBranding.clearReply);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const codeId = useId();
  const reply = data.reply;
  const run = async (work: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await work();
      if (success) setDone(success);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const addressProblem = address ? checkEmail(address, "The reply address") : null;
  return (
    <div className="grid gap-3">
      <div>
        <h3 className="text-sm font-semibold text-strong">Where replies go</h3>
        <p className="text-sm text-muted-foreground">When a customer presses Reply, their message is delivered here.</p>
      </div>
      {reply.active ? (
        <div className="rounded-xl border border-border px-3 py-2.5">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Mail aria-hidden className="size-4 text-muted-foreground" />
            <span className="font-medium text-strong break-all">{reply.active.address}</span>
            <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">Verified</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Verified as {HOW_WORDS[reply.active.how]}. Used for every email sent through Selestial, except where a workflow has its own reply address (Finance invoices, the hiring inbox, Sales conversations).</p>
        </div>
      ) : (
        <Note tone="warning">
          No verified reply address yet.{" "}
          {reply.fallback ? (
            <>
              For now, each workflow uses its own: mostly <span className="font-medium text-strong">{reply.fallback}</span>, which hasn&apos;t been confirmed here.
            </>
          ) : (
            <>Replies to emails without a workflow reply address can&apos;t reach you. Add one below.</>
          )}
        </Note>
      )}
      {reply.agentsCanRead ? (
        <Note tone="good">Your agents can read replies here: {reply.agentsCanRead.address} is connected to Selestial.</Note>
      ) : (
        <Note>
          A reply address is where replies are <em>delivered</em>. Agents can only <em>read</em> replies in an inbox connected to Selestial.{" "}
          <Link href="/app/settings/integrations?tool=gmail" className="font-medium text-brand-700 underline underline-offset-2">
            Connect Gmail
          </Link>{" "}
          (optional; Microsoft Outlook is coming soon).
          {reply.salesRouting ? " Replies to Sales conversations already come back into Selestial on their own." : ""}
        </Note>
      )}
      {data.canEdit && reply.pending ? (
        <div className="grid gap-2 rounded-xl border border-brand-500/30 bg-brand-500/5 px-3 py-3">
          <p className="text-sm text-strong">
            {reply.pending.delivery === "failed" ? (
              <>We couldn&apos;t send the code to <span className="font-medium">{reply.pending.address}</span>{reply.pending.problem ? `: ${reply.pending.problem}` : "."}</>
            ) : (
              <>
                We {reply.pending.delivery === "sent" ? "sent" : "are sending"} a 6-digit code to <span className="font-medium break-all">{reply.pending.address}</span>. {reply.active ? "Replies keep going to the current address until you enter it." : ""}
              </>
            )}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label htmlFor={codeId} className="grid gap-1 text-sm">
              <span className="font-medium text-strong">Code</span>
              <TextInput id={codeId} inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} className="w-32 font-mono tracking-widest" />
            </label>
            <Button type="button" size="sm" variant="primary" loading={busy} disabled={busy || code.replace(/\D/g, "").length !== 6} onClick={() => run(async () => { const r = await confirm({ companyId, code }); if (!r.ok) throw new Error(r.words); setCode(""); }, "Reply address confirmed.")}>
              Confirm
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => run(() => request({ companyId, address: reply.pending!.address }), "A new code is on its way.")}>
              Send a new code
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => run(() => cancel({ companyId }))}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {data.canEdit && !reply.pending ? (
        <div className="grid gap-2">
          <Field label={reply.active ? "Use a different reply address" : "Reply address"} error={addressProblem} hint="We'll email a code to confirm it's yours, unless it's your own verified sign-in email or a connected inbox.">
            <TextInput type="email" autoComplete="email" placeholder="office@yourcompany.com" value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          {reply.suggestions.length ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Suggestions:</span>
              {reply.suggestions.map((s) => (
                <button key={s} type="button" onClick={() => setAddress(s)} className="rounded-full border border-border px-2 py-0.5 text-strong hover:bg-muted focus-visible:outline-2 focus-visible:outline-brand-500">
                  {s}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" loading={busy} disabled={busy || !address.trim() || Boolean(addressProblem)} onClick={() => run(async () => { const r = await request({ companyId, address }); setAddress(""); if (r.verified) setDone("Reply address set and verified."); })}>
              {reply.active ? "Verify new address" : "Verify address"}
            </Button>
            {reply.active ? (
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => run(() => clear({ companyId }), "Stopped using that reply address.")}>
                Stop using {reply.active.address}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="text-sm">
        {error ? <span className="text-destructive-foreground">{error}</span> : done ? <span className="text-success">{done}</span> : null}
      </p>
    </div>
  );
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────

/** The page with its data loaded. Exported for the visual harness and tests. */
export function EmailBrandingForm({ data }: { data: EmailBrandingData }) {
  const { companyId } = useCompany();
  const save = useMutation(api.emailBranding.save);
  const uploadUrl = useMutation(api.emailBranding.uploadUrl);
  const checkLogo = useMutation(api.emailBranding.checkLogo);
  const initial = useMemo(() => draftFrom((data.saved as SavedChoices | null) ?? null), [data.saved]);
  const { value: draft, dirty, stale, change, reset } = useSavedDraft<BrandingDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const leaveDialog = useUnsavedWarning(dirty, () => false, "your email branding");
  const can = data.canEdit;
  const d = draft!;
  const set = (update: (current: BrandingDraft) => BrandingDraft) => {
    setNotice(null);
    setError(null);
    change(update);
  };
  const sig = (patch: Partial<BrandingDraft["signature"]>) => set((c) => ({ ...c, signature: { ...c.signature, ...patch } }));
  const branding = useMemo(() => resolveBranding(savedFrom(d), data.defaults), [d, data.defaults]);
  const problems = draftProblems(d);
  const replyWords = data.reply.active?.address ?? (data.reply.fallback ? `${data.reply.fallback} (each workflow's own, not yet verified)` : "Each workflow's own reply address");
  const defaults = data.defaults;

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await save({ companyId, baseRevision: data.revision, choices: choicesFrom(d) });
      reset();
      setNotice("Saved. New emails use this branding.");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  };

  const upload = async (file: File) => {
    setUploading(null);
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) return setUploading("Use a PNG, JPEG or WebP image.");
    if (file.size > 2 * 1024 * 1024) return setUploading("Use an image under 2 MB.");
    setUploading("Uploading…");
    try {
      const url = await uploadUrl({ companyId });
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      const checked = await checkLogo({ companyId, storageId });
      set((c) => ({ ...c, logoSource: "custom", logo: checked.storageId, logoUrl: checked.url }));
      setUploading(null);
    } catch (e) {
      setUploading(messageOf(e));
    }
  };

  const controls = (
    <fieldset disabled={!can || saving} className="grid min-w-0 gap-5">
      <Section id="sender" title="Sender & replies" intro="Who your emails are from, and where customers' replies go.">
        <Field label="Sender name" hint={`What customers see as the sender. Leave empty to use your company name, ${defaults.companyName}.`} error={d.senderName ? checkSenderName(d.senderName) : null}>
          <TextInput value={d.senderName} placeholder={defaults.companyName} maxLength={60} onChange={(e) => set((c) => ({ ...c, senderName: e.target.value.replace(/[\r\n]/g, "") }))} />
        </Field>
        <div className="grid gap-1.5 text-sm">
          <span className="font-medium text-strong">Sending address</span>
          {data.sender.address ? (
            <p className="break-all rounded-lg border border-dashed border-border bg-muted/50 px-3 py-2 font-mono text-[13px] text-strong">{data.sender.address}</p>
          ) : (
            <p className="rounded-lg border border-dashed border-border px-3 py-2 text-muted-foreground">Selestial assigns your address once email delivery is set up on this account.</p>
          )}
          <span className="text-xs text-muted-foreground">
            Assigned by Selestial{data.sender.assigned ? "" : " when you first save"} and only ever used by {defaults.companyName}. Customers see “{branding.senderName}” as the sender. It stays the same if you rename your business.
          </span>
        </div>
        <Replies data={data} />
      </Section>

      <Section id="appearance" title="Appearance" intro="Starts from your company branding. Choose a layout and colours; the preview updates as you go.">
        <div className="grid gap-2">
          <SegmentedControl
            label="Logo"
            value={d.logoSource}
            onChange={(logoSource) => set((c) => ({ ...c, logoSource }))}
            options={[
              { id: "company", label: "Company logo" },
              { id: "custom", label: "Upload one" },
              { id: "none", label: "Name only" },
            ]}
          />
          {d.logoSource === "company" && !defaults.logoUrl ? <p className="text-xs text-muted-foreground">Your company has no logo yet, so emails show your name in your colour. Upload one here or in your booking profile.</p> : null}
          {d.logoSource === "custom" ? (
            <div className="flex flex-wrap items-center gap-3">
              {d.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={d.logoUrl} alt="Your email logo" className="h-12 max-w-[160px] rounded-lg border border-border bg-white object-contain p-1" />
              ) : (
                <span className="grid h-12 w-20 place-items-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">No logo</span>
              )}
              <label className={cn(buttonVariants({ variant: "outline", size: "sm" }), !can && "pointer-events-none opacity-60")}>
                <Upload aria-hidden /> {d.logoUrl ? "Replace" : "Upload"} logo
                <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={!can} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void upload(file); }} />
              </label>
              <span className="text-xs text-muted-foreground">PNG, JPEG or WebP, under 2 MB. A wide logo about 400 × 100 px looks best.</span>
              {uploading ? <span role="status" className="w-full text-xs text-destructive-foreground">{uploading}</span> : null}
            </div>
          ) : null}
        </div>
        <ColorField label="Accent colour" value={d.accent} fallback={defaults.brandColor && !checkColor(defaults.brandColor, "x") ? defaults.brandColor.toUpperCase() : "#6838EF"} hint={defaults.brandColor ? "Your brand colour, from your booking profile." : "Selestial's default, until you choose one."} onChange={(accent) => set((c) => ({ ...c, accent }))} disabled={!can} resetLabel="Use company colour" />
        <Field label="Layout">
          <SelectionCards type="single" columns={3} value={d.layout} onValueChange={(layout) => set((c) => ({ ...c, layout }))} options={(Object.keys(data.layouts) as (keyof typeof data.layouts)[]).map((id) => ({ value: id, label: data.layouts[id].label, description: data.layouts[id].detail }))} />
        </Field>
        <SegmentedControl label="Header" value={d.header} onChange={(header) => set((c) => ({ ...c, header }))} options={[{ id: "light", label: "Light" }, { id: "dark", label: "Dark" }]} />
        <details className="group rounded-xl border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-strong">More appearance options</summary>
          <div className="grid gap-4 pt-3">
            <ColorField label="Button colour" value={d.button} fallback={branding.accent} hint="Matches the accent colour unless you choose another." onChange={(button) => set((c) => ({ ...c, button }))} disabled={!can} resetLabel="Match accent" />
            <SegmentedControl label="Logo position" value={d.logoAlign} onChange={(logoAlign) => set((c) => ({ ...c, logoAlign }))} options={[{ id: "left", label: "Left" }, { id: "center", label: "Centred" }]} />
          </div>
        </details>
        <div>
          <Button type="button" variant="ghost" size="sm" disabled={!can || appearanceIsDefault(d)} onClick={() => set(resetAppearance)}>
            <RotateCcw aria-hidden /> Reset appearance to company defaults
          </Button>
        </div>
      </Section>

      <Section id="signature" title="Signature & business details" intro="Shown to customers at the end of each email. Empty fields use your company profile.">
        <SwitchRow title="Add a signature" description="Your team name and contact details under each message." checked={d.signature.include} onChange={(include) => sig({ include })} effect="on-save" dirty={d.signature.include !== initial.signature.include} disabled={!can} />
        {d.signature.include ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Signature name" hint={`For example “The ${defaults.companyName} team”.`} error={d.signature.name.length > 60 ? "Keep it to 60 characters or fewer." : null}>
              <TextInput value={d.signature.name} placeholder={defaults.companyName} maxLength={60} onChange={(e) => sig({ name: e.target.value })} />
            </Field>
            <Field label="Business phone" error={d.signature.phone ? checkPhone(d.signature.phone) : null}>
              <TextInput type="tel" value={d.signature.phone} placeholder={defaults.phone ?? "(415) 555-0134"} onChange={(e) => sig({ phone: e.target.value })} />
            </Field>
            <Field label="Website" error={d.signature.website ? checkWebsite(d.signature.website) : null}>
              <TextInput value={d.signature.website} placeholder={defaults.website ?? "https://yourcompany.com"} onChange={(e) => sig({ website: e.target.value })} />
            </Field>
            <Field label="Customer support email" error={d.signature.supportEmail ? checkEmail(d.signature.supportEmail, "The support email") : null}>
              <TextInput type="email" value={d.signature.supportEmail} placeholder={defaults.supportEmail ?? "help@yourcompany.com"} onChange={(e) => sig({ supportEmail: e.target.value })} />
            </Field>
            <Field className="sm:col-span-2" label="Closing line (optional)" hint="One short line, like “Thanks for trusting us with your home.” It's on every email, including invoices, so no offers or links." error={d.signature.closing ? checkClosing(d.signature.closing) : null}>
              <TextInput value={d.signature.closing} maxLength={80} onChange={(e) => sig({ closing: e.target.value })} />
            </Field>
          </div>
        ) : null}
        <div className="grid gap-3">
          <Field label="Business address" hint="Printed in the footer. Marketing email must show it, so it's on by default.">
            <TextInput value={d.signature.address} placeholder={defaults.address ?? "Street, city, state ZIP"} maxLength={140} onChange={(e) => sig({ address: e.target.value })} />
          </Field>
          <SwitchRow title="Show the address in the footer" checked={d.signature.showAddress} onChange={(showAddress) => sig({ showAddress })} effect="on-save" dirty={d.signature.showAddress !== initial.signature.showAddress} disabled={!can} consequence={d.signature.showAddress ? null : "Finish-your-booking reminders still include your mailing address in their own words, because the law requires it."} />
        </div>
        <Note>Every email keeps its footer: why the person got it, that it was sent via Selestial, and an unsubscribe link where one applies. Branding can&apos;t remove them.</Note>
      </Section>

      <Section id="coverage" title="Which emails use this branding">
        <ul className="grid gap-2 text-sm">
          {data.workflows.map((w) => (
            <li key={w.id} className="flex gap-2">
              <CheckCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
              <span>
                <span className="font-medium text-strong">{w.label}:</span> <span className="text-muted-foreground">{w.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        <details className="rounded-xl border border-border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium text-strong">What doesn&apos;t use it</summary>
          <ul className="mt-2 grid list-disc gap-1 pl-5 text-muted-foreground">
            {data.notCovered.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      </Section>

      <Section id="billing" title="Costs">
        <ul className="grid gap-1.5 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-strong">Business emails sent through Selestial use your messaging balance</span>: {data.billing.perEmail} per recipient on the current rate card.
          </li>
          <li>Writing an email with an agent uses AI credits; delivering it uses the messaging balance.</li>
          <li>Email from a connected Gmail inbox has no Selestial delivery charge. Selestial&apos;s notices to your team are included.</li>
          <li>Editing your branding is free and uses no AI credits.</li>
        </ul>
        {data.canEdit ? (
          <Link href="/app/settings/billing?tab=messaging" className="text-sm font-medium text-brand-700 underline underline-offset-2">
            See your messaging balance
          </Link>
        ) : null}
      </Section>
    </fieldset>
  );

  return (
    <div className="grid gap-5">
      {leaveDialog}
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "Email delivery", value: data.sending.ready ? (data.sending.mode === "test" ? "Test mode" : "Ready") : "Not ready yet", tone: data.sending.ready ? "good" : "warning", detail: data.sending.words },
          { label: "Sent from", value: data.sender.address ?? "Assigned when ready", tone: "neutral", detail: `As “${branding.senderName}”` },
          { label: "Replies go to", value: data.reply.active?.address ?? "Not verified yet", tone: data.reply.active ? "good" : "warning", detail: data.reply.active ? "Verified" : "Each workflow's own address for now" },
        ].map((card) => (
          <div key={card.label} className="min-w-0 rounded-2xl border border-border bg-card px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{card.label}</p>
            <p className={cn("mt-0.5 truncate text-sm font-semibold", card.tone === "good" ? "text-success" : card.tone === "warning" ? "text-warning" : "text-strong")} title={card.value}>
              {card.value}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{card.detail}</p>
          </div>
        ))}
      </div>
      {!can ? <Note>Only the Owner can change email branding. You can see how emails look.</Note> : null}

      <div className="lg:hidden">
        <SegmentedControl label="Show" hideLabel value={view} onChange={setView} options={[{ id: "edit", label: <span className="inline-flex items-center gap-1.5"><PenLine className="size-3.5" />Edit</span> }, { id: "preview", label: <span className="inline-flex items-center gap-1.5"><Eye className="size-3.5" />Preview</span> }]} />
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className={cn("grid min-w-0 gap-5", view === "preview" && "max-lg:hidden")}>{controls}</div>
        <div className={cn("grid min-w-0 gap-5 lg:sticky lg:top-4", view === "edit" && "max-lg:hidden")}>
          <section aria-labelledby="preview" className="grid gap-3 rounded-2xl border border-border bg-card px-4 py-4 sm:px-5">
            <div>
              <h2 id="preview" className="text-base font-semibold text-strong">
                What your customers see
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">{dirty ? "Showing your unsaved changes. Nothing changes for customers until you save." : "This is how emails look now."}</p>
            </div>
            <Preview data={data} branding={branding} replyWords={replyWords} />
          </section>
          <TestEmail data={data} dirty={dirty} />
        </div>
      </div>

      <SaveBar canEdit={can} dirty={dirty} saving={saving} error={error} notice={notice} problems={problems} stale={stale} onSave={onSave} onDiscard={() => { reset(); setError(null); }} />
    </div>
  );
}

/**
 * Settings › Email & texting › Email branding: the Owner makes emails sent through Selestial look like
 * the business, with a live preview built by the same renderer real sends use.
 */
export function EmailBranding() {
  return (
    <Guard>
      <Fetched />
    </Guard>
  );
}

function Fetched() {
  const { companyId } = useCompany();
  const data = useQuery(api.emailBranding.get, { companyId });
  if (data === undefined) return <div aria-busy className="h-96 animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" />;
  return <EmailBrandingForm data={data} />;
}
