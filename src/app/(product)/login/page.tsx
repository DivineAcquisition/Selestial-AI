import type { Metadata } from "next";

import { LoginScreen } from "@/components/auth/login";
import { AuthPage } from "@/components/auth/page";
import { googleSignIn } from "@/lib/auth/policy.server";

export const metadata: Metadata = { title: "Sign in" };

export default async function Page() {
  const google = await googleSignIn();
  return (
    <AuthPage>
      <LoginScreen google={google} />
    </AuthPage>
  );
}
