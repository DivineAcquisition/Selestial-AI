import { redirect } from "next/navigation";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Recruiting's rules have one editor: Hiring setup, in the Recruiter workspace. Old links land there,
 * keeping their query, so a Gmail connection that began before the move still finishes (?mailbox=…).
 */
export default async function Page({ searchParams }: Props) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, one);
  }
  const rest = query.toString();
  redirect(`/app/agents/recruiter/hiring-setup${rest ? `?${rest}` : ""}`);
}
