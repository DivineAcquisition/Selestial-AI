import type { Metadata } from "next";

import { CareOverviewScreen } from "@/components/app/screens/care/overview";

export const metadata: Metadata = { title: "Client Care" };

export default function Page() {
  return <CareOverviewScreen />;
}
