import type { Metadata } from "next";

import { FoundingClaim } from "@/components/app/founding/claim";

export const metadata: Metadata = { title: "Founding Access" };

export default function Page() {
  return <FoundingClaim />;
}
