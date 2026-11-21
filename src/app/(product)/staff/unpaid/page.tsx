import type { Metadata } from "next";

import { UnpaidPlans } from "@/components/staff/console";

export const metadata: Metadata = { title: "Unpaid plans" };

export default function Page() {
  return <UnpaidPlans />;
}
