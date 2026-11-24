import type { Metadata } from "next";

import { MessagingSetup } from "@/components/app/settings/messaging";
import { SectionPage } from "@/components/app/settings/section-page";

export const metadata: Metadata = { title: "Email & texting" };

export default function Page() {
  return (
    <SectionPage id="messaging">
      <MessagingSetup />
    </SectionPage>
  );
}
