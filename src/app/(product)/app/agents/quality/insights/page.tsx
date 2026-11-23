import type { Metadata } from "next";

import { QualityInsightsScreen } from "@/components/app/screens/quality/insights";

export const metadata: Metadata = { title: "Insights · Quality" };

export default function Page() {
  return <QualityInsightsScreen />;
}
