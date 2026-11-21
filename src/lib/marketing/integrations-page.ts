/**
 * The public Integrations page (/integrations), drawn from the product's own list
 * (src/lib/app/integrations.ts) so the site can't say more than the product does. An integration is
 * "Live" exactly when the server lists it as built (convex/lib/integrations.ts, `BUILT`); everything
 * else is "Coming soon" and promises no date. A test keeps the two in step.
 */
import { BUILT } from "../../../convex/lib/integrations";
import { CATEGORIES, INTEGRATIONS, type Integration, type IntegrationCategory } from "@/lib/app/integrations";
import type { AgentId } from "@/lib/app/navigation";

export const INTEGRATIONS_PATH = "/integrations";

export type PublicIntegration = { id: string; name: string; does: string; can: string[]; agents: AgentId[]; live: boolean };
export type PublicCategory = { id: IntegrationCategory; label: string; lead: string; items: PublicIntegration[] };

export function isLive(id: string): boolean {
  return (BUILT as readonly string[]).includes(id);
}

function toPublic(integration: Integration): PublicIntegration {
  return { id: integration.id, name: integration.name, does: integration.does, can: integration.can, agents: integration.agents, live: isLive(integration.id) };
}

/** The integrations by category, in the product's order, keeping only those with `live` as asked. */
export function integrationsByCategory(live: boolean): PublicCategory[] {
  return CATEGORIES.map((category) => ({
    ...category,
    items: INTEGRATIONS.filter((integration) => integration.category === category.id && isLive(integration.id) === live).map(toPublic),
  })).filter((category) => category.items.length > 0);
}

export const INTEGRATIONS_PAGE = {
  eyebrow: "Integrations",
  headline: "Your AI team works inside the tools you already use.",
  lead: "Connect the accounts your business already runs on. Each agent uses only the tools it needs, only for the jobs you allow, and every action it takes is recorded.",
  liveTitle: "Working today",
  liveLead: "Connect these from your workspace now.",
  plannedTitle: "Coming soon",
  plannedLead: "On the way. An Owner can ask for one from the workspace, which tells us what to build next. We don't promise dates.",
  liveLabel: "Live",
  plannedLabel: "Coming soon",
  usedBy: "Used by",
  principles: [
    { id: "owner", title: "Only the Owner connects", body: "Connecting or disconnecting an account is the Owner's decision. Everyone in the company can see what is connected." },
    { id: "scope", title: "You choose what each tool reaches", body: "Connect each Google tool on its own, with the account you choose, and pick exactly which files, calendars and locations it may use." },
    { id: "yours", title: "Your accounts, your money", body: "Payments go straight to your own Stripe account. Imports from Jobber and Housecall Pro only read; nothing changes there." },
  ],
  askTitle: "Don't see what you use?",
  askBody: "Tell us which tool your business runs on. Requests from cleaning companies decide what we connect next.",
  askCta: "Tell us what you use",
  note: "Names and logos belong to their owners and are shown only to say which service a connection is for.",
} as const;
