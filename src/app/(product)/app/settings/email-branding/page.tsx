import type { Metadata } from "next";

import { EmailBranding } from "@/components/app/settings/email-branding";
import { SectionPage } from "@/components/app/settings/section-page";

export const metadata: Metadata = { title: "Email branding" };

export default function Page() {
  return (
    <SectionPage id="email-branding" title="Your email branding">
      <EmailBranding />
    </SectionPage>
  );
}
