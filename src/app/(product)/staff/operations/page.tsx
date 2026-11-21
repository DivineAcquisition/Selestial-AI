import type { Metadata } from "next";
import { Suspense } from "react";

import { OperationsWorkspace } from "@/components/staff/operations";

export const metadata: Metadata = { title: "Operations" };

export default function Page() {
  return (
    <Suspense>
      <OperationsWorkspace />
    </Suspense>
  );
}
