import type { Metadata } from "next";

import { CareRequestsScreen } from "@/components/app/screens/care/requests";

export const metadata: Metadata = { title: "Requests · Care" };

export default function Page() {
  return <CareRequestsScreen />;
}
