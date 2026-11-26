import type { Metadata } from "next";

import { ContinueScreen } from "@/components/auth/google";
import { AuthPage } from "@/components/auth/page";

export const metadata: Metadata = { title: "Create account" };

export default function Page() {
  return (
    <AuthPage>
      <ContinueScreen />
    </AuthPage>
  );
}
