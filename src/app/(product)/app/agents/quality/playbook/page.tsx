import type { Metadata } from "next";

import { QualityPlaybookScreen } from "@/components/app/screens/quality/playbook";

export const metadata: Metadata = { title: "Playbook · Quality" };

export default function Page() {
  return <QualityPlaybookScreen />;
}
