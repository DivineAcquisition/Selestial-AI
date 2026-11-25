/**
 * The few Founding Access events, sent only to analytics tools the visitor's consent already loaded
 * (src/components/consent/trackers.tsx loads nothing until a choice allows it). With no tool loaded these
 * do nothing. Events carry a name and a fixed position word: never a name, email, company or claim key.
 *
 * The rest of the funnel (account created, checkout started, founding claim verified, onboarding started
 * and completed) is measured on the server from Selestial's own records (convex/founding.ts `funnel`),
 * because the workspace never runs third-party trackers.
 */
export type FoundingEvent = "founding_page_viewed" | "founding_cta_selected" | "founding_signup_started";

type Win = Window & { va?: (...args: unknown[]) => void; gtag?: (...args: unknown[]) => void };

export function trackFounding(event: FoundingEvent, position?: string) {
  if (typeof window === "undefined") return;
  const win = window as Win;
  const data = position ? { position: position.replace(/[^a-z0-9-]/gi, "").slice(0, 32) } : undefined;
  try {
    win.va?.("event", { name: event, ...(data ? { data } : {}) });
    win.gtag?.("event", event, data ?? {});
  } catch {
    // Analytics never breaks the page.
  }
}
