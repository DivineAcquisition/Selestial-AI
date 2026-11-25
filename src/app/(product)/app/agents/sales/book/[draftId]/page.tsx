import type { Metadata } from "next";

import { SalesWorkspace } from "@/components/app/sales/workspace";

import type { Id } from "../../../../../../../../convex/_generated/dataModel";

// The workspace names itself once the draft is read: the customer, then Internal Booking or Quotes & Proposals.
export const metadata: Metadata = { title: "Sales workspace" };

export default async function Page({ params, searchParams }: { params: Promise<{ draftId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { draftId } = await params;
  const { from } = await searchParams;
  return <SalesWorkspace draftId={draftId as Id<"salesDrafts">} from={typeof from === "string" ? from : undefined} />;
}
