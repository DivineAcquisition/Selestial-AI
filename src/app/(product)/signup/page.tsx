import type { Metadata } from "next";

import { AuthPage } from "@/components/auth/page";
import { SignupScreen } from "@/components/auth/signup";
import { googleSignIn, passwordPolicy } from "@/lib/auth/policy.server";

export const metadata: Metadata = { title: "Create account" };

export default async function Page() {
  const [policy, google] = await Promise.all([passwordPolicy(), googleSignIn()]);
  return (
    <AuthPage>
      <SignupScreen policy={policy} google={google} />
    </AuthPage>
  );
}
