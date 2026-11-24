import type { Metadata } from "next";

import { SecuritySettings } from "@/components/auth/security";
import { SectionPage } from "@/components/app/settings/section-page";

export const metadata: Metadata = { title: "My account & security" };

export default function Page() {
  return (
    <SectionPage id="security">
      <SecuritySettings />
    </SectionPage>
  );
}
