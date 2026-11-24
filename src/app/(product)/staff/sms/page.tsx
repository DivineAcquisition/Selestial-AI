import type { Metadata } from "next";

import { SmsOperations } from "@/components/staff/sms-ops";

export const metadata: Metadata = { title: "Texting operations" };

export default function Page() {
  return <SmsOperations />;
}
