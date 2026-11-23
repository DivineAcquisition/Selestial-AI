/**
 * Alerts to Selestial staff, grouped: every pending alert goes out in one message per person each time
 * the sender runs, never one message per incident or per retry (docs/operations/04-owner-recovery.md).
 *
 * Channels are one interface, so another (Discord, decided for later) is added here without touching
 * detection or notification. Each channel gets the same batch and says whether it went.
 */
import { emailLayout, emailText, escapeHtml } from "../email/layout";
import { emailProvider } from "../email/provider";
import { NOT_SENT_ON_TEST } from "../environment";

export type AlertLine = {
  reason: "critical" | "needs_staff" | "recovery_exhausted" | "owner_asked";
  title: string;
  company: string | null;
  severity: string;
  reference: string;
  at: number;
};

export type AlertBatch = { key: string; lines: AlertLine[]; consoleUrl: string | null };
export type Recipient = { email: string; name: string };

/**
 * What a channel did with a batch. `reached` counts the people the provider accepted a message for; an
 * alert is only "sent" when that is at least one. `retry` means trying the same batch again may help.
 * `problem` is a reason code for staff (never an address, a key or a provider's own words).
 */
export type AlertProblem = "no_recipients" | "not_configured" | "provider_refused" | "provider_unavailable" | "not_production";
export type AlertOutcome = { reached: number; retry: boolean; problem: AlertProblem | null };

export interface AlertChannel {
  name: string;
  /** Sends the batch to these people and says how many it reached. */
  send(batch: AlertBatch, recipients: Recipient[]): Promise<AlertOutcome>;
}

export const ALERT_PROBLEM_WORDS: Record<AlertProblem, string> = {
  no_recipients: "No active admin or support staff member is set up to receive alerts.",
  not_configured: "No email service is set up on this backend.",
  provider_refused: "The email service refused every alert. Its key or sending domain needs checking.",
  provider_unavailable: "The email service is not answering. The same alerts are tried again every five minutes.",
  not_production: "This is not the production backend, and no staff address is on its TEST_RECIPIENTS list.",
};

/** One outcome for all channels: delivered if any channel reached someone. */
export function combineOutcomes(outcomes: AlertOutcome[]): AlertOutcome {
  const reached = outcomes.reduce((sum, row) => sum + row.reached, 0);
  const retry = outcomes.some((row) => row.retry);
  return { reached, retry, problem: reached > 0 ? null : (outcomes.find((row) => row.problem)?.problem ?? "not_configured") };
}

const REASON_WORDS: Record<AlertLine["reason"], string> = {
  critical: "Critical",
  needs_staff: "Needs staff",
  recovery_exhausted: "Automatic recovery ran out",
  owner_asked: "A company asked for help",
};

/** The grouped email. Pure. It names incidents and companies, never customers, messages or secrets. */
export function alertEmail(batch: AlertBatch): { subject: string; html: string; text: string } {
  const count = batch.lines.length;
  const critical = batch.lines.filter((line) => line.reason === "critical").length;
  const heading = critical ? `${critical} critical ${critical === 1 ? "incident" : "incidents"} in Selestial` : `${count} ${count === 1 ? "incident needs" : "incidents need"} Selestial staff`;
  const lines = batch.lines.map((line) => `${REASON_WORDS[line.reason]} · ${line.title}${line.company ? ` · ${line.company}` : ""} · ${line.severity} · ${line.reference}`);
  const action = batch.consoleUrl ? { label: "Open Operations", url: batch.consoleUrl } : undefined;
  const bodyHtml = lines.map((line) => `<p style="margin:0 0 10px 0;">${escapeHtml(line)}</p>`).join("");
  return {
    subject: heading,
    html: emailLayout({ preheader: lines[0] ?? heading, heading, bodyHtml, action, footnote: "Details, records and diagnostics are in the staff Operations workspace, not in this email." }),
    text: emailText({ heading, lines, action }),
  };
}

export const emailChannel: AlertChannel = {
  name: "email",
  async send(batch, recipients) {
    const provider = emailProvider();
    if (!provider) return { reached: 0, retry: false, problem: "not_configured" };
    if (recipients.length === 0) return { reached: 0, retry: false, problem: "no_recipients" };
    const message = alertEmail(batch);
    let reached = 0;
    let retry = false;
    let blocked = 0;
    for (const person of recipients) {
      try {
        // One key per batch and person, so a retry of the same batch never sends twice.
        const result = await provider.send({ to: person.email, ...message, idempotencyKey: `staff-alerts-${batch.key}-${person.email}` });
        if (result.ok) reached += 1;
        else if (result.retryable) retry = true;
        else if (result.problem === NOT_SENT_ON_TEST) blocked += 1;
      } catch {
        retry = true;
      }
    }
    // A refusal (a revoked key, an unverified domain) reaches nobody: it is never counted as sent.
    const problem: AlertProblem | null = reached > 0 ? null : retry ? "provider_unavailable" : blocked === recipients.length ? "not_production" : "provider_refused";
    return { reached, retry, problem };
  },
};

/** The channels in use. Discord is added here when it is set up. */
export const ALERT_CHANNELS: readonly AlertChannel[] = [emailChannel];
