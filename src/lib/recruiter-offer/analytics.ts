/**
 * Recruiter offer page events, sent only to analytics tools the visitor's consent already loaded (the same
 * path as src/lib/founding/analytics.ts: src/components/consent/trackers.tsx loads nothing until a choice
 * allows it). Events carry a name and a short fixed word — never a name, email, company or applicant data.
 *
 * Only what happens on this page is tracked. Signup, checkout and Recruiter onboarding events do not exist
 * yet because those steps do not exist for this offer (src/lib/recruiter-offer/content.ts, BILLING).
 */
export type RecruiterEvent =
  | "recruiter_page_viewed"
  | "recruiter_cta_selected"
  | "recruiter_workflow_step_selected"
  | "recruiter_faq_opened";

type Win = Window & { va?: (...args: unknown[]) => void; gtag?: (...args: unknown[]) => void };

export function trackRecruiter(event: RecruiterEvent, detail?: Record<string, string>) {
  if (typeof window === "undefined") return;
  const win = window as Win;
  const data = detail
    ? Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, String(v).replace(/[^a-z0-9-]/gi, "").slice(0, 32)]))
    : undefined;
  try {
    win.va?.("event", { name: event, ...(data ? { data } : {}) });
    win.gtag?.("event", event, data ?? {});
  } catch {
    // Analytics never breaks the page.
  }
}
