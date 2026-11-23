import type { Metadata } from "next";

import { QualityRequestPage } from "@/components/public/quality-page";

export const metadata: Metadata = { title: "Your visit", robots: { index: false, follow: false, nocache: true }, referrer: "no-referrer" };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <QualityRequestPage token={token} />;
}
