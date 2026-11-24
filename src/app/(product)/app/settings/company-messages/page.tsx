import type { Metadata } from "next";

import { EmailPreviews } from "@/components/app/settings/email-previews";
import { SectionPage } from "@/components/app/settings/section-page";

export const metadata: Metadata = { title: "Company messages & previews" };

export default function Page() {
  return (
    <SectionPage id="company-messages">
      <EmailPreviews />
    </SectionPage>
  );
}
