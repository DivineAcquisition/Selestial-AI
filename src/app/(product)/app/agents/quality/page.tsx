import type { Metadata } from "next";

import { QualityOverviewScreen } from "@/components/app/screens/quality/overview";

export const metadata: Metadata = { title: "Quality" };

export default function Page() {
  return <QualityOverviewScreen />;
}
