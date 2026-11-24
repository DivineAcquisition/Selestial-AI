import type { Metadata } from "next";

import { MessagingSetup } from "@/components/app/settings/messaging";
import { SectionPage } from "@/components/app/settings/section-page";
import { SetupHelpCard } from "@/components/app/tutorials/setup-help";

export const metadata: Metadata = { title: "Email & texting" };

export default function Page() {
  return (
    <SectionPage id="messaging">
      <SetupHelpCard tutorialId="setup-communication" placement="settings.messaging" className="mb-5" />
      <MessagingSetup />
    </SectionPage>
  );
}
