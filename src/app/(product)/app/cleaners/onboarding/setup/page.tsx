import type { Metadata } from "next";

import { OnboardingSetupScreen } from "@/components/app/cleaners/onboarding-setup";

export const metadata: Metadata = { title: "Guided onboarding" };

export default function Page() {
  return <OnboardingSetupScreen />;
}
