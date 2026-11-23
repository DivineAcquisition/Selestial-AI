import type { Metadata } from "next";

import { QuoSetupScreen } from "@/components/app/screens/quo-setup";

export const metadata: Metadata = { title: "Quo" };

export default function Page() {
  return <QuoSetupScreen />;
}
