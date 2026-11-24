import type { Metadata } from "next";

import { PricingStudio } from "@/components/app/services/studio";

export const metadata: Metadata = { title: "Compare example jobs" };

export default function Page() {
  return <PricingStudio />;
}
