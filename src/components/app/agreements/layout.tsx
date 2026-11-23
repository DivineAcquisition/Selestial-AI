"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";

import { useCompany } from "@/components/app/company";
import { PageHeader, PageTabs } from "@/components/app/layout";
import { Sparkles } from "@/components/icons";
import { buttonVariants } from "@/components/ui/button-variants";
import { AGREEMENT_TABS, AGREEMENTS_ROOT } from "@/lib/app/agreements";

import { api } from "../../../../convex/_generated/api";

/**
 * Every Agreements page sits inside this: the three ways to start, and the workspace's own navigation.
 * A single agreement or template opens in the same frame so the way back is always the library.
 */
export function AgreementsLayout({ children }: { children: React.ReactNode }) {
  const { companyId } = useCompany();
  const pathname = usePathname() ?? AGREEMENTS_ROOT;
  const catalog = useQuery(api.companyAgreements.catalog, { companyId });
  const canDraft = catalog ? catalog.capabilities.includes("draft") : true;
  const active = AGREEMENT_TABS.find((tab) => (tab.href === AGREEMENTS_ROOT ? pathname === AGREEMENTS_ROOT : pathname === tab.href || pathname.startsWith(`${tab.href}/`)));
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <PageHeader
        title="Agreements"
        lead="Your customer, workforce and business agreements: drafts built from your own details, reviewed by a person, signed, and kept through renewal."
        actions={
          canDraft ? (
            <>
              <Link href={`${AGREEMENTS_ROOT}/new?mode=template`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                Use a Template
              </Link>
              <Link href={`${AGREEMENTS_ROOT}/new?mode=upload`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                Upload Agreement
              </Link>
              <Link href={`${AGREEMENTS_ROOT}/new?mode=selestial`} className={buttonVariants({ variant: "primary", size: "sm" })}>
                <Sparkles aria-hidden /> Build with Selestial
              </Link>
            </>
          ) : null
        }
      />
      <PageTabs label="Agreements" activeId={active?.id} tabs={AGREEMENT_TABS.map((tab) => ({ id: tab.id, label: tab.label, href: tab.href }))} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
