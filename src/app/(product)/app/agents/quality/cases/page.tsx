import type { Metadata } from "next";

import { QualityCasesScreen } from "@/components/app/screens/quality/cases";

export const metadata: Metadata = { title: "Cases · Quality" };

export default function Page() {
  return <QualityCasesScreen />;
}
