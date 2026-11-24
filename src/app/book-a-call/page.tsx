import type { Metadata } from "next";
import Link from "next/link";

import { LogoMark } from "@/components/brand/logo";
import { CalEmbed } from "@/components/marketing/cal-embed";
import { PublicPage } from "@/components/trust/public-page";
import { BOOK_CALL_PAGE, BOOK_CALL_PATH } from "@/lib/marketing/content";
import { marketingLead, marketingPageGutter, marketingSectionTitle } from "@/lib/marketing/ui";
import { loadPublicTrust } from "@/lib/trust/public";
import { sectionLabel } from "@/lib/ui";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: BOOK_CALL_PAGE.title,
  description: BOOK_CALL_PAGE.lead,
  alternates: { canonical: BOOK_CALL_PATH },
};

export const revalidate = 300;

/** Book a call: a short call with Selestial, booked straight from the calendar on the page. */
export default async function BookCallPage() {
  const trust = await loadPublicTrust();
  return (
    <PublicPage trust={trust}>
      <div className={cn(marketingPageGutter, "pb-20 pt-10 sm:pb-28 sm:pt-16")}>
        <div className="mx-auto max-w-2xl">
          <LogoMark className="size-14 shadow-[0_12px_30px_-14px_rgba(104,56,239,0.8)]" />
          <p className={cn(sectionLabel, "mt-6")}>{BOOK_CALL_PAGE.eyebrow}</p>
          <h1 className={cn(marketingSectionTitle, "mt-3")}>{BOOK_CALL_PAGE.headline}</h1>
          <p className={cn(marketingLead, "mt-4")}>{BOOK_CALL_PAGE.lead}</p>
        </div>
        {/* Wider than the text: the month view needs room for the calendar and its times side by side. */}
        <div className="mx-auto mt-10 max-w-5xl overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
          <CalEmbed />
        </div>
        <div className="mx-auto max-w-2xl">
          <p className="mt-6 text-sm">
            <Link href="/" className="font-medium text-[#5126c7] underline-offset-4 hover:underline">
              ← {BOOK_CALL_PAGE.back}
            </Link>
          </p>
        </div>
      </div>
    </PublicPage>
  );
}
