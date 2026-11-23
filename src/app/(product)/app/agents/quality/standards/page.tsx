import type { Metadata } from "next";

import { QualityStandardsScreen } from "@/components/app/screens/quality/standards";

export const metadata: Metadata = { title: "Standards · Quality" };

export default function Page() {
  return <QualityStandardsScreen />;
}
