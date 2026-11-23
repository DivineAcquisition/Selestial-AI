import type { Metadata } from "next";
import { Suspense } from "react";

import { CalendarScreen } from "@/components/app/calendar/screen";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Calendar" };

/** The company-wide Calendar (docs/calendar/00-architecture.md). Its view, day and filters live in the address. */
export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <CalendarScreen />
    </Suspense>
  );
}
