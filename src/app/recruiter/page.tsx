import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsentControls } from "@/components/consent/banner";
import { Trackers } from "@/components/consent/trackers";
import { RecruiterOfferPage } from "@/components/recruiter-offer/page";
import { trackingTools } from "@/lib/consent/tools";
import { hostMap, RECRUITER_OFFER_PATH } from "@/lib/hosts";
import { META, RECRUITER_INDEXABLE } from "@/lib/recruiter-offer/content";

/** The access host's /recruiter when the host is set (src/lib/hosts.ts); otherwise this path. */
function canonical(): string {
  const origin = hostMap(process.env).founding;
  return origin ? `${origin}${RECRUITER_OFFER_PATH}` : RECRUITER_OFFER_PATH;
}

export function generateMetadata(): Metadata {
  const url = canonical();
  return {
    title: { absolute: META.title },
    description: META.description,
    alternates: { canonical: url },
    // Kept out of search until the offer can actually be bought (src/lib/recruiter-offer/content.ts).
    robots: RECRUITER_INDEXABLE ? undefined : { index: false, follow: false },
    openGraph: { type: "website", siteName: "Selestial", title: META.title, description: META.description, url },
    twitter: { card: "summary_large_image", title: META.title, description: META.description },
  };
}

export const revalidate = 300;

export default function Recruiter() {
  const tools = trackingTools();
  return (
    <>
      <RecruiterOfferPage />
      <ConsentControls tools={tools} />
      <Suspense fallback={null}>
        <Trackers tools={tools} />
      </Suspense>
    </>
  );
}
