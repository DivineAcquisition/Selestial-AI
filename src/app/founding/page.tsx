import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsentControls } from "@/components/consent/banner";
import { Trackers } from "@/components/consent/trackers";
import { FoundingPage } from "@/components/founding/page";
import { FoundingStatusProvider } from "@/components/founding/status-context";
import { trackingTools } from "@/lib/consent/tools";
import { META } from "@/lib/founding/content";
import { loadFoundingView } from "@/lib/founding/status";
import { hostMap } from "@/lib/hosts";

/** The founding host's root when it is set (src/lib/hosts.ts); otherwise this page's own path. */
function canonical(): string {
  const origin = hostMap(process.env).founding;
  return origin ? `${origin}/` : "/founding";
}

export function generateMetadata(): Metadata {
  const url = canonical();
  return {
    title: { absolute: META.title },
    description: META.description,
    alternates: { canonical: url },
    openGraph: { type: "website", siteName: "Selestial", title: META.title, description: META.description, url, images: [{ url: "/founding/og.png", width: 1200, height: 630, alt: "Selestial Founding Access" }] },
    twitter: { card: "summary_large_image", title: META.title, description: META.description, images: ["/founding/og.png"] },
  };
}

/**
 * The status is re-read at most every minute for the first paint; the browser then corrects its clock
 * against the server and keeps the count fresh (src/components/founding/status-context.tsx).
 */
export const revalidate = 60;

export default async function Founding() {
  const view = await loadFoundingView();
  const tools = trackingTools();
  const map = hostMap(process.env);
  return (
    <FoundingStatusProvider initial={view} hosts={{ public: map.public, app: map.app }}>
      <FoundingPage />
      <ConsentControls tools={tools} />
      <Suspense fallback={null}>
        <Trackers tools={tools} />
      </Suspense>
    </FoundingStatusProvider>
  );
}
