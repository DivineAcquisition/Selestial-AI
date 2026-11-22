import { permanentRedirect } from "next/navigation";

/**
 * Team Coordinator was retired before release (November 22, 2026): onboarding new cleaners through to
 * readiness is Recruiter's, and coordinating their visits is Dispatch's. Old links land on Recruiter.
 */
export default function Page() {
  permanentRedirect("/agents/recruiter");
}
