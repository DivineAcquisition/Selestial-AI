import { redirect } from "next/navigation";

import { TEAM_COORDINATOR_MOVED } from "@/lib/app/navigation";

/** Old Team Coordinator tabs go where that work lives now; anything else to the page that explains the move. */
export default async function Page({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  redirect(TEAM_COORDINATOR_MOVED[tab] ?? "/app/agents/team-coordinator");
}
