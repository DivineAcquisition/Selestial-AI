import type { Metadata } from "next";

import { ResearchHome } from "@/components/app/services/research";

export const metadata: Metadata = { title: "Market research" };

export default function Page() {
  return <ResearchHome />;
}
