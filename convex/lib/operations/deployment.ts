/**
 * Which backend this is, and what it may do to the outside world (docs/operations/02-isolation-and-restore.md).
 *
 * Isolation is enforced here, on the backend, not by which keys someone remembered to copy:
 *
 *  - production  everything runs. Only the live deployment (or SELESTIAL_DEPLOYMENT=production).
 *  - test        a real deployment that is not production: texts and emails go only to the addresses in
 *                SELESTIAL_TEST_RECIPIENTS (none listed, none sent), and live Stripe or Autumn keys are
 *                refused, so no real customer is messaged or charged.
 *  - restore     a backend holding restored data: nothing is sent, nothing is charged, and no scheduled
 *                job runs, until the runbook's reconciliation is done and the role is changed on purpose.
 *  - local       the test harness and a local backend with no deployment URL: unchanged behavior, with
 *                mock providers.
 *
 * SELESTIAL_DEPLOYMENT, when set, always wins. Without it, the live deployment's name decides production;
 * any other real deployment is "test". So a new or copied backend is never production by accident.
 */
export const PRODUCTION_DEPLOYMENT = "terrific-avocet-835";

export type DeploymentRole = "production" | "test" | "restore" | "local";

export function deploymentRole(): DeploymentRole {
  const declared = process.env.SELESTIAL_DEPLOYMENT?.trim().toLowerCase();
  if (declared === "production" || declared === "test" || declared === "restore" || declared === "local") return declared;
  const url = process.env.CONVEX_CLOUD_URL?.trim() ?? "";
  if (!url || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url)) return "local";
  return url.includes(PRODUCTION_DEPLOYMENT) ? "production" : "test";
}

/** Whether the role was set explicitly, rather than worked out from the deployment's address. */
export function roleDeclared(): boolean {
  return Boolean(process.env.SELESTIAL_DEPLOYMENT?.trim());
}

const digits = (value: string) => value.replace(/[^\d+]/g, "");

/** The addresses a test backend may send to: phone numbers in +digits form and email addresses, lower case. */
export function testRecipients(): Set<string> {
  const raw = process.env.SELESTIAL_TEST_RECIPIENTS ?? "";
  const out = new Set<string>();
  for (const part of raw.split(/[,\s;]+/)) {
    const value = part.trim().toLowerCase();
    if (!value) continue;
    out.add(value.includes("@") ? value : digits(value));
  }
  return out;
}

/**
 * Why a message to this address may not leave this backend, or null when it may. Every outbound path
 * asks: the send policy (convex/lib/messaging/policy.ts) and, as a backstop for mail that does not go
 * through the outbox, the provider getters.
 */
export function sendIsolation(channel: "sms" | "email", to: string): string | null {
  const role = deploymentRole();
  if (role === "production" || role === "local") return null;
  if (role === "restore") return "This backend holds restored data, so nothing is sent from it until the restore is reconciled.";
  const address = channel === "email" ? to.trim().toLowerCase() : digits(to);
  if (testRecipients().has(address)) return null;
  return "This is a test backend, so it only sends to the test recipients listed in SELESTIAL_TEST_RECIPIENTS. Nothing was sent.";
}

/**
 * Whether a live payment key may be used here. Production does; so does "local" (the test harness, whose
 * payment providers are stand-ins). A real non-production deployment never does.
 */
export function liveMoneyAllowed(): boolean {
  const role = deploymentRole();
  return role === "production" || role === "local";
}

/** Whether any payment provider may be called at all (a restored backend calls none, test keys included). */
export function paymentsAllowed(): boolean {
  return deploymentRole() !== "restore";
}

/** Whether scheduled jobs may run (convex/crons.ts goes through operations.gate). */
export function jobsAllowed(): boolean {
  return deploymentRole() !== "restore";
}

/** For the staff Operations overview: what this backend is and what it will refuse. */
export function isolationSummary() {
  const role = deploymentRole();
  return {
    role,
    declared: roleDeclared(),
    testRecipients: role === "test" ? testRecipients().size : null,
    liveMoney: liveMoneyAllowed(),
    payments: paymentsAllowed(),
    jobs: jobsAllowed(),
  };
}
