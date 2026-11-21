import type { Metadata } from "next";

import { SupportAccess } from "@/components/app/settings/support-access";
import { SectionPage } from "@/components/app/settings/section-page";

export const metadata: Metadata = { title: "Support access" };

export default function Page() {
  return (
    <SectionPage id="support-access">
      <SupportAccess />
    </SectionPage>
  );
}
