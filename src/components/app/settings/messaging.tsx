"use client";

import Link from "next/link";

import { useCompany } from "@/components/app/company";
import { Disclosures, Messaging, Readiness } from "@/components/app/screens/compliance";
import { Guard } from "@/components/app/settings/guard";
import { BusinessTexting } from "@/components/app/texting/business-texting";
import { ChevronRight } from "@/components/icons";

/** Where the rest of email and texting lives. Each has one editor; this page links to it. */
function Related() {
  const { role } = useCompany();
  const rows = [
    { href: "/app/settings/integrations", label: "Connected apps", detail: "Your texting number's provider, Gmail and other connections." },
    ...(role === "owner" ? [{ href: "/app/settings/billing?tab=messaging", label: "Messaging charges", detail: "Your messaging balance, top-ups and what texts cost, in Plan & usage." }] : []),
    { href: "/app/settings/business#identity", label: "Legal details", detail: "The legal name, address and representative your registration uses, in Company profile." },
  ];
  return (
    <section aria-labelledby="messaging-related" className="rounded-2xl border border-border bg-card">
      <h2 id="messaging-related" className="border-b border-border px-4 py-2.5 text-sm font-semibold text-strong sm:px-5">
        Related
      </h2>
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.href}>
            <Link href={row.href} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500 sm:px-5">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-strong">{row.label}</span>
                <span className="block text-xs text-muted-foreground">{row.detail}</span>
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Settings → Email & texting: one place to see whether the company can message people, and to set who
 * messages come from, registration, quiet hours and consent wording. Charges stay in Plan & usage.
 */
export function MessagingSetup() {
  return (
    <div className="grid gap-5">
      <Guard>
        <BusinessTexting />
      </Guard>
      <Guard>
        <Readiness />
      </Guard>
      <Guard>
        <Messaging />
      </Guard>
      <Guard>
        <Disclosures />
      </Guard>
      <Related />
    </div>
  );
}
