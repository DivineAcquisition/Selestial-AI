import type { Metadata } from "next";

import { QualityCorrectionsScreen } from "@/components/app/screens/quality/corrections";

export const metadata: Metadata = { title: "Corrections · Quality" };

export default function Page() {
  return <QualityCorrectionsScreen />;
}
