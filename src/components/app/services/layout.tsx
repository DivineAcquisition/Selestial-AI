"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { ActionMenu } from "@/components/app/clients/menu";
import { useCompany } from "@/components/app/company";
import { PageHeader } from "@/components/app/layout";
import { ArrowLeft, MoreHorizontal, Plus, Upload } from "@/components/icons";
import { buttonVariants } from "@/components/ui/button-variants";
import { REVIEW_ALL_PATH, SERVICES_ROOT, SERVICES_TOOLS } from "@/lib/app/services";

import { api } from "../../../../convex/_generated/api";

/** Pages that are a service of their own fill the frame; the rest are tools with a way back. */
const TOOL_PAGES = /^\/app\/services\/(studio|research|changes|setup|imports|new|review)(\/|$)/;

const OTHER_PAGES = [
  { href: `${SERVICES_ROOT}/new`, label: "Add a service", blurb: "Start from what Selestial already knows, a template, your own price list, or a blank service." },
  { href: REVIEW_ALL_PATH, label: "Review services", blurb: "Check several drafts together and publish or submit the ones that are ready." },
  { href: `${SERVICES_ROOT}/imports`, label: "Imported prices", blurb: "Each line from your price list, checked before it becomes a draft." },
];

/**
 * Every Services & Pricing page sits inside this. The main page is the company's services; its tools
 * (comparing example jobs, research, costs, review history) open from More and keep their own addresses.
 * A single service opens as its own workspace with its own way back.
 */
export function ServicesLayout({ children }: { children: React.ReactNode }) {
  const { companyId, role } = useCompany();
  const pathname = usePathname() ?? SERVICES_ROOT;
  const catalog = useQuery(api.services.catalog, { companyId });
  const migrate = useMutation(api.services.migrateFromSettings);
  const asked = useRef(false);
  const canDraft = role === "owner" || role === "manager";
  // The Owner's services from Settings move into the one catalog the first time the Owner opens it.
  useEffect(() => {
    if (asked.current || !catalog || catalog.legacyWaiting === 0 || !catalog.canPublish) return;
    asked.current = true;
    void migrate({ companyId }).catch(() => undefined);
  }, [catalog, companyId, migrate]);

  const home = pathname === SERVICES_ROOT;
  const tool = TOOL_PAGES.test(pathname);
  const current = SERVICES_TOOLS.find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`)) ?? OTHER_PAGES.find((p) => pathname.startsWith(p.href));
  const tools = SERVICES_TOOLS.filter((t) => !("ownerOnly" in t) || role === "owner").map((t) => ({ label: t.label, href: t.href }));
  const waiting = catalog?.counts.waiting ?? 0;
  // A single service is its own workspace: it brings its own header.
  if (!home && !tool) return <div className="min-w-0">{children}</div>;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      {home ? (
        <PageHeader
          title="Services & Pricing"
          lead="What you sell and how each service is priced. Changes are drafted and checked here, and nothing reaches a customer until it is published."
          actions={
            <>
              {canDraft ? (
                <>
                  <Link href={`${SERVICES_ROOT}/new?mode=import`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                    <Upload aria-hidden /> Import prices
                  </Link>
                  <Link href={`${SERVICES_ROOT}/new`} className={buttonVariants({ variant: "primary", size: "sm" })}>
                    <Plus aria-hidden /> Add service
                  </Link>
                </>
              ) : null}
              <ActionMenu
                label="More tools"
                className="h-8 rounded-lg border border-border bg-card px-2"
                trigger={
                  <span className="inline-flex items-center gap-1 text-sm text-strong">
                    <MoreHorizontal aria-hidden className="size-4" />
                    <span>More</span>
                  </span>
                }
                actions={[...(waiting && canDraft ? [{ label: `Review ${waiting} waiting`, href: REVIEW_ALL_PATH }] : []), ...tools]}
              />
            </>
          }
        />
      ) : (
        <div className="grid gap-1">
          <Link href={SERVICES_ROOT} className="inline-flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-strong focus-visible:outline-2 focus-visible:outline-brand-500/50">
            <ArrowLeft aria-hidden className="size-4" /> Services &amp; Pricing
          </Link>
          {current ? (
            <div>
              <h1 className="font-heading text-2xl tracking-tight text-strong">{current.label}</h1>
              <p className="text-sm text-muted-foreground">{current.blurb}</p>
            </div>
          ) : null}
        </div>
      )}
      <div className="min-w-0">{children}</div>
      {home ? <p className="text-xs text-muted-foreground">These are your company&apos;s prices for your customers. Selestial&apos;s own plans and credits are under Settings › Plan &amp; Usage.</p> : null}
    </div>
  );
}
