import type { Metadata } from "next";

import { StartDraft } from "@/components/app/sales/start-draft";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Named for what is being started: a proposal belongs to Quotes & Proposals, anything else is a booking. */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { mode, kind } = await searchParams;
  if (mode === "proposal") return { title: "New proposal · Quotes & Proposals" };
  return { title: `${kind === "recurring" ? "New recurring booking" : "New booking"} · Internal Booking` };
}

export default async function Page({ searchParams }: Props) {
  const params = await searchParams;
  const one = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : undefined);
  return <StartDraft mode={one("mode") === "proposal" ? "proposal" : "booking"} segment={one("segment")} kind={one("kind")} customerId={one("customer")} propertyId={one("property")} opportunityId={one("opportunity")} jobId={one("job")} from={one("from")} clientKey={one("key")} />;
}
