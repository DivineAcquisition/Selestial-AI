"use client";

/**
 * "Have a website? Let Selestial help fill this in." The read runs in the background, so the owner can
 * keep typing, or carry on without it if it fails or takes long. What it found is shown in one panel: each
 * suggestion with where it came from and a choice to use it, what stayed uncertain, and what wasn't found.
 *
 * A suggestion is never used until the owner chooses it, and choosing it is the same as typing it: it
 * becomes a confirmed fact when setup saves. Prices and policies found on the site are shown as the site's
 * own words; they never become prices, rules or commitments.
 */
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, messageOf, TextInput } from "@/components/app/form";
import { Modal } from "@/components/app/modal";
import { useNow } from "@/components/app/use-now";
import { Check, Globe, LoaderCircle } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { CATEGORY_CHOICES } from "../../../../convex/lib/setup/facts";

type Facts = FunctionReturnType<typeof api.setup.state>["facts"];
type Value = string | string[];

/** The facts a website read can suggest, in the order the panel lists them. */
const KEYS = [
  { key: "company.location", label: "Where you're based" },
  { key: "services.categories", label: "Who you clean for" },
  { key: "company.areas", label: "Areas you serve" },
  { key: "contact.phone", label: "Phone" },
  { key: "contact.email", label: "Email" },
  { key: "company.about", label: "How you describe the company" },
  { key: "policies.published", label: "A policy, in your website's words" },
] as const;
type Key = (typeof KEYS)[number]["key"];

/** Used only when the owner picks it one by one: a policy found on a page is never used in bulk. */
const ONE_BY_ONE: Key[] = ["policies.published", "company.about"];

const SLOW_MS = 45_000;

function words(key: Key, value: Value): string {
  if (key === "services.categories") return (Array.isArray(value) ? value : [value]).map((item) => CATEGORY_CHOICES.find((c) => c.value === item)?.label ?? item).join(", ");
  return Array.isArray(value) ? value.join(", ") : value;
}

function pageOf(ref: string | null): string | null {
  if (!ref) return null;
  try {
    const url = new URL(ref);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return null;
  }
}

/**
 * `current` holds what the form has now (confirmed or typed). `onUse` puts a suggestion into the form, where
 * the owner can still change it.
 */
export function WebsitePanel({ facts, current, onUse, onStarted }: { facts: Facts; current: Partial<Record<Key, Value>>; onUse: (key: Key, value: Value) => void; onStarted: () => void }) {
  const { companyId } = useCompany();
  const read = useQuery(api.setupWebsite.status, { companyId });
  const start = useMutation(api.setupWebsite.start);
  const stop = useMutation(api.setupWebsite.stop);
  const now = useNow();
  const savedSite = typeof facts["company.website"]?.value === "string" ? (facts["company.website"].value as string) : "";
  const [open, setOpen] = useState(Boolean(savedSite || read));
  const [url, setUrl] = useState(savedSite);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  async function begin(replace = false) {
    setBusy(true);
    setError(null);
    try {
      const result = await start({ companyId, url, ...(replace ? { replace: true } : {}) });
      if (result.confirm) setConfirm(result.confirm.current);
      else {
        setConfirm(null);
        onStarted();
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  const running = read?.status === "queued" || read?.status === "reading";
  const slow = running && now !== undefined && now - read.startedAt > SLOW_MS;
  const suggestions = KEYS.flatMap(({ key, label }) => {
    const row = facts[key];
    if (!row) return [];
    const offer = row.state === "found" && row.source === "website" ? row.value : row.conflict?.source === "website" ? row.conflict.value : null;
    if (offer === null) return [];
    return [{ key, label, value: offer, conflict: row.state === "confirmed", page: pageOf(row.sourceRef) }];
  });
  const notFound = read?.status === "ready" ? KEYS.filter(({ key }) => !facts[key] && !ONE_BY_ONE.includes(key)) : [];
  const used = (key: Key, value: Value) => JSON.stringify(current[key]) === JSON.stringify(value);
  const bulk = suggestions.filter((row) => !ONE_BY_ONE.includes(row.key) && !row.conflict && !used(row.key, row.value));

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-brand-500/40 bg-[#eee8ff]/50 px-4 py-3 text-left text-sm hover:border-brand-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white text-[#6838ef]" aria-hidden>
          <Globe className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block font-medium text-strong">Have a website? Let Selestial help fill this in.</span>
          <span className="block text-muted-foreground">Optional. It reads in the background while you keep going.</span>
        </span>
      </button>
    );
  }

  return (
    <section className="grid gap-3 rounded-2xl border border-brand-500/25 bg-[#eee8ff]/40 p-4" aria-labelledby="website-heading">
      <h2 id="website-heading" className="flex items-center gap-2 text-sm font-semibold text-strong">
        <Globe className="size-4 text-[#6838ef]" aria-hidden />
        Fill in from your website
      </h2>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && url.trim()) void begin();
        }}
      >
        <Field label="Website address" className="min-w-0 flex-1">
          <TextInput value={url} onChange={(event) => setUrl(event.target.value)} placeholder="yourcompany.com" inputMode="url" autoComplete="url" maxLength={200} />
        </Field>
        <Button type="submit" variant="outline" loading={busy} disabled={!url.trim()}>
          {read && read.status === "ready" && savedSite && url.trim() && url.trim() !== savedSite ? "Read this site instead" : "Read my website"}
        </Button>
      </form>

      {read ? (
        <div className="grid gap-1 text-sm" aria-live="polite">
          {running ? (
            <p className="flex flex-wrap items-center gap-2 text-strong">
              <LoaderCircle className="size-4 animate-spin text-[#6838ef] motion-reduce:animate-none" aria-hidden />
              Reading {read.host}: {read.pages.filter((page) => page.ok).length} {read.pages.filter((page) => page.ok).length === 1 ? "page" : "pages"} so far.
              <button type="button" className="text-xs font-medium text-[#5126c7] underline-offset-4 hover:underline" onClick={() => void stop({ companyId, readId: read.readId })}>
                Stop
              </button>
            </p>
          ) : read.status === "ready" ? (
            <p className="flex items-center gap-2 text-strong">
              <Check className="size-4 text-success" aria-hidden />
              Read {read.pages.filter((page) => page.ok).length} pages of {read.host}.
            </p>
          ) : read.status === "failed" ? (
            <p className="text-strong">{read.problem ?? `We couldn't read ${read.host}.`} You can fill this in yourself; nothing waits on it.</p>
          ) : (
            <p className="text-muted-foreground">The reading was stopped. Anything already found is below.</p>
          )}
          {running ? <p className="text-xs text-muted-foreground">{slow ? "This is taking longer than usual. Keep going by hand: suggestions appear here if they arrive." : "You don't need to wait. Keep filling in the form."}</p> : null}
        </div>
      ) : null}

      {suggestions.length ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">What we found</h3>
            {bulk.length > 1 ? (
              <Button variant="ghost" size="xs" className="ml-auto" onClick={() => bulk.forEach((row) => onUse(row.key, row.value))}>
                Use all {bulk.length} suggestions
              </Button>
            ) : null}
          </div>
          <ul className="grid gap-1.5">
            {suggestions.map((row) => {
              const on = used(row.key, row.value);
              return (
                <li key={row.key} className="grid gap-1 rounded-xl border border-border bg-white px-3 py-2.5 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {row.label}
                      <Badge variant={on ? "success" : row.conflict ? "warning" : "outline"} size="sm">
                        {on ? "Using it" : row.conflict ? "Differs from yours" : "Suggested"}
                      </Badge>
                    </p>
                    <p className="break-words text-strong">{words(row.key, row.value)}</p>
                    <p className="text-xs text-muted-foreground">
                      From {row.page ?? "your website"}
                      {row.key === "policies.published" ? ". Kept as your website's words: it is not a rule Selestial applies." : ""}
                      {row.conflict ? ". Your own answer stays unless you choose this." : ""}
                    </p>
                  </div>
                  {on ? (
                    <span className="text-xs text-muted-foreground">You can edit it in the form.</span>
                  ) : (
                    <Button variant="outline" size="xs" onClick={() => onUse(row.key, row.value)}>
                      Use this
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {read?.status === "ready" && (notFound.length || read.services.some((service) => service.advertised)) ? (
        <div className="grid gap-1 rounded-xl bg-white/70 px-3 py-2.5 text-xs text-muted-foreground">
          <p className="font-medium text-strong">Still uncertain</p>
          {notFound.length ? <p>Not found on your site: {notFound.map((row) => row.label.toLowerCase()).join(", ")}. Add them yourself if you want them used.</p> : null}
          {read.services
            .filter((service) => service.advertised)
            .slice(0, 4)
            .map((service) => (
              <p key={service.name}>
                &ldquo;{service.name}&rdquo; is advertised as &ldquo;{service.advertised}&rdquo;. That is not used as a price: you set prices yourself.
              </p>
            ))}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}

      <Modal open={confirm !== null} onClose={() => setConfirm(null)} title="Read a different website?" description={`Selestial already read ${confirm ?? "your website"}.`}>
        <div className="grid gap-3 text-sm">
          <p className="text-muted-foreground">Suggestions from {confirm} that you haven&apos;t used are removed, and {url.trim()} is read instead. Anything you typed or chose to use stays exactly as it is. Setup can read up to three websites.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep {confirm}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void begin(true)}>
              Read {url.trim()}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
