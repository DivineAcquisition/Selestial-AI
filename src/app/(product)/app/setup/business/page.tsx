import type { Metadata } from "next";

import { BusinessSetup } from "@/components/app/setup/business";

export const metadata: Metadata = { title: "Your business setup" };

export default function Page() {
  return <BusinessSetup />;
}
