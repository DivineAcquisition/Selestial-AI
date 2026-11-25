import type { Metadata } from "next";

import { CareFollowUpsScreen } from "@/components/app/screens/care/follow-ups";

export const metadata: Metadata = { title: "Follow-ups · Client Care" };

export default function Page() {
  return <CareFollowUpsScreen />;
}
