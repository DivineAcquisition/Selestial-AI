/**
 * Deployment settings staff must be able to see without reading the deployment's variables
 * (docs/billing/03-messaging-billing.md): whether messages are charged, and which AI rate card is in force.
 * Read from the environment only; nothing here returns a key or a secret's value.
 */
import { activeRateCard, TASK_IDS, TASKS } from "../billing/rateCards";
import { environment, type Environment } from "../environment";
import { meteringOn } from "../messagingBilling/ledger";

/** Why messaging is free on purpose, in a person's words: "Pilot: free messaging through 2027-01-31, approved by …". */
export function subsidyNote(env: Record<string, string | undefined> = process.env): string | null {
  const note = env.MESSAGING_BILLING_SUBSIDY_NOTE?.replace(/\s+/g, " ").trim().slice(0, 300);
  return note ? note : null;
}

export type MessagingCharges = {
  state: "on" | "subsidy" | "off";
  /** What staff read, for example "Off — pilot subsidy: …". */
  words: string;
  /** Set only when messages are free on the production backend and nobody has recorded why. */
  warning: string | null;
  note: string | null;
};

export const UNMETERED_WARNING = "Messages are not being charged. If this is a deliberate pilot subsidy, record it.";

export function messagingCharges(where: Environment = environment()): MessagingCharges {
  if (meteringOn()) return { state: "on", words: "On", warning: null, note: null };
  const note = subsidyNote();
  if (note) return { state: "subsidy", words: `Off — pilot subsidy: ${note}`, warning: null, note };
  return { state: "off", words: "Off", warning: where === "production" ? UNMETERED_WARNING : null, note: null };
}

/** True when the production backend sends for free and no subsidy is recorded: the one condition staff are alerted to. */
export function unmeteredWithoutReason(where: Environment = environment()): boolean {
  return where === "production" && messagingCharges(where).state === "off";
}

export type RateCardReadiness = {
  /** The card in force, or null when BILLING_RATE_CARD names none. */
  version: string | null;
  /** Tasks with no approved rate on it: each runs its rules-based path, or is not offered, until a rate is approved. */
  unapproved: { task: string; label: string }[];
};

export function rateCardReadiness(): RateCardReadiness {
  const card = activeRateCard();
  if (!card) return { version: null, unapproved: [] };
  return { version: card.version, unapproved: TASK_IDS.filter((task) => card.rates[task] === null).map((task) => ({ task, label: TASKS[task].label })) };
}
