import type { Metadata } from "next";

import { IntegrationsPageView } from "@/components/marketing/integrations-page";
import { PublicPage } from "@/components/trust/public-page";
import { INTEGRATIONS_PATH } from "@/lib/marketing/integrations-page";
import { loadPublicTrust } from "@/lib/trust/public";

export const metadata: Metadata = {
  title: "Integrations",
  description: "The tools Selestial's AI team for cleaning companies works with today, and the ones on the way: payments, lead sources, Google, texting, accounting, hiring and moving in from other software.",
  alternates: { canonical: INTEGRATIONS_PATH },
};

export const revalidate = 300;

export default async function IntegrationsPage() {
  const trust = await loadPublicTrust();
  return (
    <PublicPage trust={trust}>
      <IntegrationsPageView />
    </PublicPage>
  );
}
