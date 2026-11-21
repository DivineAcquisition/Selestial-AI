import type { Metadata } from "next";

import { Companies } from "@/components/staff/console";
import { SupportDirectoryIfAllowed } from "@/components/staff/support-start";

export const metadata: Metadata = { title: "Companies" };

export default function Page() {
  return (
    <div className="grid gap-6">
      <SupportDirectoryIfAllowed />
      <Companies />
    </div>
  );
}
