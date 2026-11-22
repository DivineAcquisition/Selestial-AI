import type { Metadata } from "next";

import { TextingConfigPage } from "@/components/staff/texting-case";

export const metadata: Metadata = { title: "Texting forms" };

export default function Page() {
  return <TextingConfigPage />;
}
