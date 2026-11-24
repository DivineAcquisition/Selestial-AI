import { permanentRedirect } from "next/navigation";

import { BOOK_CALL_PATH } from "@/lib/marketing/content";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** The operations assessment became Book a call. Old links and ads land there, keeping their query (campaign tags). */
export default async function Page({ searchParams }: Props) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, one);
  }
  const rest = query.toString();
  permanentRedirect(`${BOOK_CALL_PATH}${rest ? `?${rest}` : ""}`);
}
