import type { Metadata } from "next";

import { CleanerProviders } from "@/components/cleaner/shell";

/** A company's public application pages. No sign-in; nothing private. Starting hands the applicant to their own link under /c. */
export const metadata: Metadata = {
  title: "Apply",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ApplyLayout({ children }: { children: React.ReactNode }) {
  return <CleanerProviders>{children}</CleanerProviders>;
}
