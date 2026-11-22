import type { Metadata } from "next";

import { ConversationsScreen } from "@/components/app/screens/inbox";

export const metadata: Metadata = { title: "Inbox" };

export default function Page() {
  return <ConversationsScreen />;
}
