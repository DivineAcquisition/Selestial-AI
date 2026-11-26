import type { Metadata } from "next";

import { SsoCallbackScreen } from "@/components/auth/google";
import { AuthPage } from "@/components/auth/page";

export const metadata: Metadata = { title: "Signing in" };

export default function Page() {
  return (
    <AuthPage>
      <SsoCallbackScreen />
    </AuthPage>
  );
}
