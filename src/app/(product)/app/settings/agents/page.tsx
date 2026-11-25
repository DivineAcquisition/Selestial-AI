import type { Metadata } from "next";

import { AgentSettings } from "@/components/app/settings/agents";
import { SectionPage } from "@/components/app/settings/section-page";
import { SetupHelpCard } from "@/components/app/tutorials/setup-help";

export const metadata: Metadata = { title: "Agent permissions" };

export default function Page() {
  return (
    <SectionPage id="agents">
      <SetupHelpCard tutorialId="setup-agents" placement="agents.controls" className="mb-5" />
      <AgentSettings />
    </SectionPage>
  );
}
