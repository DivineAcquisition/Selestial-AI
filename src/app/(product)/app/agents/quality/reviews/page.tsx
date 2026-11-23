import type { Metadata } from "next";

import { QualityReviewsScreen } from "@/components/app/screens/quality/reviews";

export const metadata: Metadata = { title: "Reviews · Quality" };

export default function Page() {
  return <QualityReviewsScreen />;
}
