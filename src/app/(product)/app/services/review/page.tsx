import type { Metadata } from "next";

import { ReviewAll } from "@/components/app/services/review-all";

export const metadata: Metadata = { title: "Review services" };

export default function Page() {
  return <ReviewAll />;
}
