import type { Metadata } from "next";

import { Identity } from "@/components/app/screens/compliance";
import { BusinessSection } from "@/components/app/settings/business-sections";
import { Guard } from "@/components/app/settings/guard";
import { SectionPage } from "@/components/app/settings/section-page";

export const metadata: Metadata = { title: "Company profile" };

/**
 * One destination for who the company is. Business details (how it runs) and legal details (who it is
 * to carriers and customers) are kept apart, each with its own save, because they are stored apart.
 */
export default function Page() {
  return (
    <SectionPage id="business">
      <div className="grid gap-8">
        <section aria-labelledby="business-details" className="grid gap-3">
          <div>
            <h2 id="business-details" className="font-heading text-lg tracking-tight text-strong">
              Business details
            </h2>
            <p className="text-sm text-muted-foreground">How your business runs: its name, clock, where you work and when customers can book.</p>
          </div>
          <BusinessSection />
        </section>
        <section aria-labelledby="legal-details" className="grid gap-3">
          <div>
            <h2 id="legal-details" className="font-heading text-lg tracking-tight text-strong">
              Legal details
            </h2>
            <p className="text-sm text-muted-foreground">Who your business is to carriers and customers. Email &amp; texting and your texting registration use these. They save separately from the details above.</p>
          </div>
          <Guard>
            <Identity />
          </Guard>
        </section>
      </div>
    </SectionPage>
  );
}
