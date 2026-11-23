import type { Metadata } from "next";

import { HiringSetupScreen } from "@/components/app/screens/recruiter/hiring-setup";

export const metadata: Metadata = { title: "Hiring setup" };

export default function Page() {
  return <HiringSetupScreen />;
}
