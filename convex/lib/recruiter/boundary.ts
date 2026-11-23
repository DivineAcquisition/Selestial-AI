/**
 * The recruiting boundary: which messages in a connected mailbox Recruiter may open at all.
 *
 * One function, `gate`, decides from what a mailbox lists before any body is fetched (sender, reply-to,
 * subject, thread) plus what Selestial already knows about the sender. Every way a message reaches
 * Recruiter goes through it: the first scan, scheduled reads, Gmail push and history updates, a reconnect
 * or recovery scan, a manual refresh, and the next run after a failure. None of them has its own rule,
 * so an incremental read cannot open something the first scan would have left closed.
 *
 * Three answers:
 *   read      recruiting mail. The body is fetched (attachments only where `attachments` says so).
 *   possible  might be hiring mail and might not. Nothing is fetched. The sender and subject are kept for
 *             14 days so a person can include it, ignore it, or open it in Gmail.
 *   skip      not recruiting mail. Nothing is fetched or kept beyond a content-free id for de-duplication.
 *
 * Detection is not perfect, and this does not pretend it is. Searching a shared business inbox misses
 * inquiries that never say what they are about; a dedicated hiring inbox or label is the clearer boundary.
 *
 * Who the sender is supports a decision; it is not permission. A known applicant writing about a cleaning
 * booking is still not hiring mail, and the reading (interpret.ts) can still find a message unrelated.
 *
 * UNVERIFIED: the job-board patterns this leans on (mail.ts) have not been checked against real Indeed
 * or ZipRecruiter mail. The word lists here are written for this product, not learned from samples.
 */
import { addressOf, classifyHeader, isNotificationAddress, isReplySubject, unsupportedBoardFor, type MessageHeader } from "./mail";
import type { Classification, Source } from "./schema";

/**
 * How an inbox is searched for hiring mail.
 *   hiring_inbox  the whole mailbox is for hiring (hiring@…). Recommended.
 *   label         one Gmail label the Owner files hiring mail under. Recommended.
 *   search        a shared business inbox, searched narrowly. Ambiguous inquiries may be missed.
 */
export const DISCOVERY_MODES = ["hiring_inbox", "label", "search"] as const;
export type DiscoveryMode = (typeof DISCOVERY_MODES)[number];

/**
 * The mode of a connection. One made before modes existed keeps its label if it had one. One that read a
 * whole mailbox without a label is searched narrowly: that is the safer reading of an inbox Selestial
 * cannot tell is dedicated, and the Owner can say it is in Hiring setup.
 */
export function discoveryOf(connection: { discovery?: DiscoveryMode; folder?: string }): DiscoveryMode {
  if (connection.discovery) return connection.discovery === "label" && !connection.folder ? "search" : connection.discovery;
  return connection.folder ? "label" : "search";
}

/** What Selestial already knows about a message's sender and thread. Looked up without reading the message. */
export type Known = {
  /** The sender (or Reply-To) is an applicant on file, by their own address or a confirmed job-board forwarding address. */
  applicant: boolean;
  /** The message is in a conversation already filed under an application. */
  thread: boolean;
  /** The sender is a client of the company and not an applicant. */
  customer: boolean;
  /** The sender is one of the company's working cleaners, with no application or onboarding open. */
  cleaner: boolean;
};

export type GateInput = {
  header: Pick<MessageHeader, "from" | "replyTo" | "subject">;
  mode: DiscoveryMode;
  /** The mailbox's own address. Its own mail is never an applicant's. */
  own: string;
  /** Job boards this connection reads. Empty: every board Recruiter knows. */
  sources: readonly Source[];
  known: Known;
};

export type Gate =
  | { verdict: "read"; classification: Classification; source?: Source; reason: string; attachments: boolean }
  | { verdict: "possible"; reason: string; source?: Source }
  | { verdict: "skip"; classification: Extract<Classification, "unrelated" | "promotion" | "suggested_candidate">; source?: Source };

/** Words that say plainly that someone is applying or asking for work. Enough to open the message. */
const HIRING = /\b(appl(y|ying|ication|icant|ied)|new (candidate|applicant)|resume|curriculum vitae|\bcv\b|job (inquiry|enquiry|opening|application)|(employment|work) (inquiry|enquiry|opportunit(y|ies))|looking for (work|a job|employment)|seeking (work|employment|a position)|are you hiring|still hiring|now hiring|cleaning (job|position|role)|cleaner (job|position|role)|housekeep(er|ing) (job|position)|(job|position) (as|for) (a )?(cleaner|housekeeper))\b/i;
/** Words that might be about work, and might be about anything. The Owner decides. */
const MAYBE = /\b(job|jobs|hiring|position|opening|interview|work for you|join your team|available to work|availability|part[- ]time|full[- ]time|opportunit(y|ies)|employment)\b/i;
/** Plainly not hiring mail, whoever sent it. */
const NOT_HIRING = /\b(invoice|receipt|payment (due|received|confirmation)|order (#|number|confirmation)|your order|quote request|estimate request|book(ing)? (a |my )?(clean|cleaning|appointment|visit)|schedule (a |my )?(clean|cleaning)|reschedul\w* (my|our) (clean|cleaning|appointment)|newsletter|unsubscribe|webinar|promo(tion)?|% off|sale ends|statement (is )?ready|subscription|password reset|verify your (email|account)|security alert|supplies? (order|request)|tracking number|shipped|delivery (update|scheduled))\b/i;

/**
 * Whether a subject is hiring mail by its words alone. Shared with the provider-side search query
 * (gmail.ts) so the scan and every later read agree on what counts.
 */
export function subjectSaysHiring(raw: string): "yes" | "maybe" | "no" {
  // "Résumé" and "resume" alike: accents off before the words are matched.
  const subject = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (NOT_HIRING.test(subject)) return "no";
  if (HIRING.test(subject)) return "yes";
  if (MAYBE.test(subject)) return "maybe";
  return "no";
}

/**
 * The words a provider-side search uses in "search" mode, so the shared inbox is narrowed before any
 * header is listed. The local gate still runs on everything listed: the search is a narrowing, not the rule.
 */
export const SEARCH_TERMS = ["application", "applying", "apply", "applicant", "resume", "\"job inquiry\"", "\"looking for work\"", "\"are you hiring\"", "\"still hiring\"", "employment", "hiring", "position", "interview", "\"cleaning job\"", "\"cleaner position\""] as const;
export const SEARCH_SENDERS = ["indeed.com", "indeedemail.com", "ziprecruiter.com"] as const;

export function gate(input: GateInput): Gate {
  const { header, known } = input;
  const from = addressOf(header.from);
  // The mailbox's own mail (an invitation it sent, a reply the Owner wrote) is never an applicant's.
  if (from && from === input.own.toLowerCase()) return { verdict: "skip", classification: "unrelated" };

  const subjectSays = subjectSaysHiring(header.subject);
  const byHeader = classifyHeader({ id: "", from: header.from, replyTo: header.replyTo, subject: header.subject, receivedAt: 0 });

  // An established conversation with an applicant. Rechecked on what it says, not just on who sent it.
  if (known.thread || known.applicant) {
    const boardNamesNew = byHeader.kind === "board" && (byHeader.classification === "new_application" || byHeader.classification === "duplicate_notification");
    if (boardNamesNew && !isReplySubject(header.subject)) {
      // A new notice about the same person (another role): read as a notice, not as their reply.
      return readBoard(byHeader.source, byHeader.classification, byHeader.reason, input.sources);
    }
    if (subjectSays === "no" && NOT_HIRING.test(header.subject) && !known.thread) {
      // From an applicant's address, about something else entirely (a booking, an invoice). The Owner decides.
      return { verdict: "possible", reason: "From someone who applied, about something that does not read as hiring." };
    }
    return { verdict: "read", classification: "applicant_reply", source: byHeader.kind === "board" ? byHeader.source : undefined, reason: known.thread ? "In a conversation filed under an application." : "From an address an applicant is known by.", attachments: false };
  }

  // A supported job board's own mail.
  if (byHeader.kind === "board") {
    if (byHeader.classification === "promotion" || byHeader.classification === "suggested_candidate") return { verdict: "skip", classification: byHeader.classification, source: byHeader.source };
    if (byHeader.classification === "needs_review") return { verdict: "possible", reason: `From ${byHeader.source === "indeed" ? "Indeed" : "ZipRecruiter"}, with a subject Recruiter does not recognise.`, source: byHeader.source };
    return readBoard(byHeader.source, byHeader.classification, byHeader.reason, input.sources);
  }

  // A client or a working cleaner writing about their own business with the company is not hiring mail.
  if (known.customer || known.cleaner) return { verdict: "skip", classification: "unrelated" };

  // A board Recruiter does not read (LinkedIn, an applicant-tracking tool): never read by itself.
  if (unsupportedBoardFor(from) ?? unsupportedBoardFor(addressOf(header.replyTo))) {
    return subjectSays === "no" ? { verdict: "skip", classification: "unrelated" } : { verdict: "possible", reason: "From a job site Recruiter does not read yet." };
  }

  // A notice-only sender (newsletters, alerts, receipts) is not a person applying.
  if (from && isNotificationAddress(from)) return { verdict: "skip", classification: "unrelated" };

  if (subjectSays === "yes") return { verdict: "read", classification: "new_application", reason: "A person writing about applying or about work.", attachments: true };
  if (subjectSays === "maybe") return { verdict: "possible", reason: "The subject might be about work." };
  // In a mailbox or label kept for hiring, a person writing in is probably about hiring. Elsewhere, it is not.
  if (input.mode !== "search" && !NOT_HIRING.test(header.subject)) return { verdict: "possible", reason: "A person wrote to the hiring inbox; the subject does not say why." };
  return { verdict: "skip", classification: "unrelated" };
}

function readBoard(source: Exclude<Source, "direct" | "manual" | "other">, classification: Classification, reason: string, sources: readonly Source[]): Gate {
  if (sources.length > 0 && !sources.includes(source)) return { verdict: "skip", classification: "promotion", source };
  return { verdict: "read", classification, source, reason, attachments: classification === "new_application" || classification === "duplicate_notification" };
}

/** How long a possibly-hiring message's sender and subject are kept before they are cleared. The Owner's choice (November 23, 2026). */
export const POSSIBLE_DAYS = 14;
