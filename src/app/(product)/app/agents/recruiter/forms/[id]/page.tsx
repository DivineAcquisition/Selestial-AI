import type { Metadata } from "next";

import { FormBuilder } from "@/components/app/recruiter-forms/builder";

import type { Id } from "../../../../../../../../convex/_generated/dataModel";

export const metadata: Metadata = { title: "Application form" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FormBuilder formId={id as Id<"applicationForms">} />;
}
