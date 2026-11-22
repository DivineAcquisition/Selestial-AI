import type { Metadata } from "next";

import { OnboardingScreen } from "@/components/app/screens/recruiter/onboarding";

export const metadata: Metadata = { title: "Onboarding & Readiness" };

export default function Page() {
  return <OnboardingScreen />;
}
