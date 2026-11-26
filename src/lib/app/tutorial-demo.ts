/**
 * Local tutorial recording. True only when this build was started with
 * NEXT_PUBLIC_TUTORIAL_DEMO=local and the record is a loopback Convex backend.
 * Production never sets that flag, and a public Convex URL cannot satisfy the check.
 */
export function tutorialDemoEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_TUTORIAL_DEMO !== "local") return false;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL?.trim() ?? "";
  return /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url);
}

/** The fictional person the local token server signs in. example.com only. */
export const TUTORIAL_DEMO_NAME = "Jordan Reyes";
export const TUTORIAL_DEMO_EMAIL = "jordan.reyes@example.com";
