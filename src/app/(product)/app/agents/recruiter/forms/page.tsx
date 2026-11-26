import type { Metadata } from "next";

import { FormsHome } from "@/components/app/recruiter-forms/home";

export const metadata: Metadata = { title: "Application forms" };

export default function Page() {
  return <FormsHome />;
}
