"use client";

import { ArrowSquareOut, Copy } from "@phosphor-icons/react";
import { useState } from "react";

import { Field, TextInput } from "@/components/app/form";
import { buttonVariants } from "@/components/ui/button-variants";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value).catch(() => undefined);
        setDone(true);
        window.setTimeout(() => setDone(false), 1500);
      }}
      className={buttonVariants({ variant: "outline", size: "xs" })}
    >
      <Copy aria-hidden /> {done ? "Copied" : label}
    </button>
  );
}

/** A role's public page: its link, a button for any website, and a small embed that opens the page in a new tab. */
export function Snippets({ url, label = "Apply now" }: { url: string; label?: string }) {
  const button = `<a href="${url}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#6838ef;color:#fff;font:600 15px system-ui,sans-serif;text-decoration:none">${label}</a>`;
  const frame = `<iframe src="${url}/embed" title="${label}" style="width:100%;max-width:440px;height:240px;border:0" loading="lazy"></iframe>`;
  return (
    <div className="space-y-3">
      <Field label="Application link">
        <TextInput readOnly value={url} onFocus={(e) => e.target.select()} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <CopyButton value={url} label="Copy link" />
        <a href={url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline", size: "xs" })}>
          <ArrowSquareOut aria-hidden /> Open
        </a>
      </div>
      <Field label="Button for your website" hint="A link styled as a button. Paste it into any page.">
        <textarea readOnly rows={3} value={button} className="block w-full rounded-lg border border-border bg-muted/40 p-2 font-mono text-[11px] text-strong" onFocus={(e) => e.target.select()} />
      </Field>
      <CopyButton value={button} label="Copy button" />
      <Field label="Embedded card" hint="A small card with the role and an Apply button that opens the application in a new tab. It holds no applicant data.">
        <textarea readOnly rows={3} value={frame} className="block w-full rounded-lg border border-border bg-muted/40 p-2 font-mono text-[11px] text-strong" onFocus={(e) => e.target.select()} />
      </Field>
      <CopyButton value={frame} label="Copy embed" />
      <p className="text-xs text-muted-foreground">Add <code>?utm_source=…</code> to the link to see where applicants came from. Never put names or emails in a link.</p>
    </div>
  );
}
