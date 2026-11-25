/**
 * Departments organize the business; agents work inside them. This catalog is the one place that says
 * which agent belongs where, so a new agent is added here and appears everywhere without a redesign.
 */
import { literals, type Agent } from "./statuses";

export const DEPARTMENT_IDS = ["growth", "operations", "team"] as const;
export type DepartmentId = (typeof DEPARTMENT_IDS)[number];
export const departmentValidator = literals(DEPARTMENT_IDS);

export type Department = { id: DepartmentId; name: string; purpose: string; agents: readonly Agent[] };

/**
 * The three departments. They are departments, not lifecycle stages. Only the agents the backend
 * knows are listed here; Marketing joins its department when it is designed
 * (docs/foundation/01-navigation.md). Team Coordinator was retired: Team is Recruiter alone, with the shared
 * Cleaners workspace. The sidebar's own list of all seven is
 * src/lib/app/navigation.ts, and a test keeps the two in agreement.
 */
export const DEPARTMENTS: readonly Department[] = [
  { id: "growth", name: "Growth", purpose: "Customer interest, bookings and lasting customer relationships.", agents: ["sales", "retention"] },
  { id: "operations", name: "Operations", purpose: "Staffing, service delivery, quality and customer care.", agents: ["dispatch", "quality", "customer-care"] },
  { id: "team", name: "Team", purpose: "Hiring, onboarding, readiness and availability.", agents: ["recruiter"] },
];

/** `built` is false until the agent's first workflow exists. Screens say "not built yet" instead of showing an idle agent. */
export const AGENT_PROFILES: Record<Agent, { name: string; responsibility: string; completion: string; built: boolean }> = {
  sales: {
    name: "Sales",
    responsibility: "Inquiries, quotes, follow-ups and bookings.",
    completion: "A suitable booking the company can fulfill, a clear decline, or a documented next step.",
    built: true,
  },
  recruiter: {
    name: "Recruiter",
    responsibility: "Applicants, interviews and onboarding.",
    completion: "An owner-approved cleaner ready for appropriate work, with availability and onboarding confirmed.",
    built: true,
  },
  dispatch: {
    name: "Dispatch",
    responsibility: "Assignments, coverage and service status.",
    completion: "An accepted assignment, communicated expectations and verified service status, with exceptions resolved or escalated.",
    built: true,
  },
  retention: {
    name: "Retention",
    responsibility: "Service concerns, recurring-service continuity, renewals and re-engagement.",
    completion: "A concern followed through to an outcome the customer confirmed, or recorded as it actually is.",
    built: true,
  },
  "customer-care": {
    name: "Client Care",
    responsibility: "Customer requests by text and email: understanding them, coordinating the action with the agent or system that owns it, and keeping the customer informed until it is resolved.",
    completion: "A customer request resolved with its outcome verified on the record and the customer told, or closed without action for a stated reason.",
    built: true,
  },
  quality: {
    name: "Quality",
    responsibility: "Service standards, completion reviews, quality investigations, correction scope and verification, and proposed improvements.",
    completion: "A visit reviewed against the standard that applied, a concern investigated to findings a person reviewed, and any correction verified, with the customer's own answer kept apart.",
    built: true,
  },
};

export function departmentOf(agent: Agent): Department {
  const found = DEPARTMENTS.find((department) => department.agents.includes(agent));
  if (!found) throw new Error(`Agent ${agent} has no department`);
  return found;
}
