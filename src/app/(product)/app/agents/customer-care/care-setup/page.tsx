import type { Metadata } from "next";

import { CareSetupScreen } from "@/components/app/screens/care/setup";

export const metadata: Metadata = { title: "Care Setup · Client Care" };

export default function Page() {
  return <CareSetupScreen />;
}
