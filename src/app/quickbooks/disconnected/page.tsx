import type { Metadata } from "next";
import Link from "next/link";

import { PublicPage } from "@/components/trust/public-page";
import { marketingLead, marketingPageGutter, marketingSectionTitle } from "@/lib/marketing/ui";
import { loadPublicTrust } from "@/lib/trust/public";
import { sectionLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "QuickBooks disconnected",
  description: "Selestial has been disconnected from your QuickBooks Online company.",
  robots: { index: false, follow: false },
};

export const revalidate = 300;

/**
 * Intuit's "Disconnect URL": where QuickBooks sends someone who disconnected Selestial from inside
 * QuickBooks. Intuit has already ended Selestial's access by then; Selestial notices on its next call and
 * asks the Owner to reconnect (convex/quickbooks.ts). This page only says what happened and what to do.
 */
export default async function Page() {
  const trust = await loadPublicTrust();
  return (
    <PublicPage trust={trust}>
      <div className={cn(marketingPageGutter, "pb-20 pt-10 sm:pb-28 sm:pt-16")}>
        <div className="mx-auto max-w-2xl">
          <p className={sectionLabel}>QuickBooks Online</p>
          <h1 className={cn(marketingSectionTitle, "mt-3")}>Selestial is disconnected from QuickBooks</h1>
          <p className={cn(marketingLead, "mt-4")}>Selestial can no longer reach your QuickBooks company. Nothing in QuickBooks was changed, and nothing in Selestial was deleted.</p>
          <p className={cn(marketingLead, "mt-4")}>
            To connect again, open{" "}
            <Link href="/app/settings/integrations/quickbooks" className="font-medium text-[#5126c7] underline-offset-4 hover:underline">
              Settings › Connected apps › QuickBooks
            </Link>{" "}
            in Selestial and choose Connect QuickBooks.
          </p>
        </div>
      </div>
    </PublicPage>
  );
}
