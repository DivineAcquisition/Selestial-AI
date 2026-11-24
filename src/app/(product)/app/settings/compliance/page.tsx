import type { Metadata } from "next";

import { ComplianceScreen } from "@/components/app/screens/compliance";
import { SectionPage } from "@/components/app/settings/section-page";

export const metadata: Metadata = { title: "Privacy & data" };

export default function Page() {
  return (
    <SectionPage id="compliance">
      <ComplianceScreen />
    </SectionPage>
  );
}
