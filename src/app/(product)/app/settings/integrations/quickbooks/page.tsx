import type { Metadata } from "next";
import { Suspense } from "react";

import { QuickBooksSetupScreen } from "@/components/app/screens/quickbooks-setup";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "QuickBooks Online" };

export default function Page() {
  // Intuit sends the Owner back here with ?result=…, read on the client.
  return (
    <Suspense fallback={<Skeleton className="h-64 rounded-2xl" />}>
      <QuickBooksSetupScreen />
    </Suspense>
  );
}
