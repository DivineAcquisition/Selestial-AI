/**
 * Which visit a conversation is about. A link is made automatically only on evidence:
 *
 *  1. an explicit reference (a Selestial link for one visit or case in the text),
 *  2. a thread already linked (the same provider conversation, close in time, with no other visit between),
 *  3. a verified relationship: the number is on exactly one client's record, exactly one of that client's
 *     visits is in the window, AND the words point at it (its day, its street, its service or a task on it).
 *
 * Never on a name, a lone phone match, "their latest booking", or an address fragment on its own. A number
 * on two clients' records, a client with several visits in the window, or words that point nowhere: the
 * conversation goes to the review queue with each candidate and the reasons for and against, in words. There
 * is no score.
 */
import type { Doc, Id } from "../../../_generated/dataModel";
import { localParts } from "../../availability";
import { dayName } from "../../time";
import { areasIn, sharedAreas } from "../../retention/cases";

export type Candidate = { jobId: Id<"jobs">; customerId: Id<"customers">; propertyId: Id<"properties">; startsAt: number; for: string[]; against: string[] };
export type Decision =
  | { status: "linked"; jobId: Id<"jobs">; method: "explicit_reference" | "thread_association" | "verified_relationship"; why: string; candidates: Candidate[] }
  | { status: "needs_review"; why: string; candidates: Candidate[] }
  | { status: "unlinked"; why: string; candidates: Candidate[] };

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** What the words point at for one visit, as reasons. Each alone is weak; the rule needs at least one with a single candidate. */
export function pointers(text: string, job: Doc<"jobs">, property: Doc<"properties"> | null, occurredAt: number, timezone: string): string[] {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9#]+/g, " ")} `;
  const out: string[] = [];
  const visitDay = localParts(job.startsAt, timezone);
  const saidDay = localParts(occurredAt, timezone);
  const daysBetween = Math.round((Date.parse(saidDay.day) - Date.parse(visitDay.day)) / 86_400_000);
  if (daysBetween === 0 && /\b(today|this morning|this afternoon|earlier)\b/.test(lower)) out.push("says \"today\", the visit's day");
  if (daysBetween === 1 && /\byesterday\b/.test(lower)) out.push("says \"yesterday\", the visit's day");
  if (lower.includes(` ${WEEKDAYS[visitDay.weekday]} `) && daysBetween >= 0 && daysBetween < 7) out.push(`names ${dayName(job.startsAt, timezone)}, the visit's day`);
  const month = new Date(job.startsAt).toLocaleString("en-US", { month: "long", timeZone: timezone }).toLowerCase();
  const dom = Number(visitDay.day.slice(8, 10));
  if (lower.includes(` ${month} ${dom} `) || lower.includes(` ${dom}${["th", "st", "nd", "rd"][dom % 10 > 3 || [11, 12, 13].includes(dom) ? 0 : dom % 10]} `)) out.push("names the visit's date");
  if (property) {
    const street = property.address.line1.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
    const parts = street.split(/\s+/);
    // A number and a street name together: a fragment alone (just "oak") is not enough.
    if (parts.length >= 2 && lower.includes(` ${parts[0]} `) && lower.includes(` ${parts[1]} `)) out.push(`names ${property.address.line1}`);
    if (property.label && property.label.trim().length > 3 && lower.includes(` ${property.label.toLowerCase().trim()} `)) out.push(`names the property "${property.label}"`);
  }
  const service = (job.serviceSnapshot?.name ?? job.serviceType).toLowerCase();
  if (service.length > 3 && lower.includes(` ${service} `)) out.push(`names the service (${job.serviceSnapshot?.name ?? job.serviceType})`);
  const areas = sharedAreas(areasIn(text), areasIn(job.scope));
  if (areas.length) out.push(`mentions ${areas.join(", ")}, which was in the visit's scope`);
  return out;
}

/** Strong pointers: a day, a date, or a street. A task or service name alone does not pick between visits. */
const strong = (reasons: string[]) => reasons.some((r) => r.includes("day") || r.includes("date") || r.startsWith("names ") && !r.startsWith("names the service"));

export type MatchInput = {
  text: string;
  occurredAt: number;
  timezone: string;
  /** Clients whose phone or contacts match the other side's number. */
  customerIds: Id<"customers">[];
  /** Visits for those clients from 14 days before to 2 days after, with their properties. */
  visits: { job: Doc<"jobs">; property: Doc<"properties"> | null }[];
  /** A visit an explicit link in the text names. */
  explicitJobId?: Id<"jobs">;
  /** The visit an earlier message in the same provider conversation was linked to, if any. */
  threadJobId?: Id<"jobs">;
};

export function decideAssociation(input: MatchInput): Decision {
  const candidates: Candidate[] = input.visits
    .filter(({ job }) => job.status !== "cancelled")
    .map(({ job, property }) => {
      const reasons = pointers(input.text, job, property, input.occurredAt, input.timezone);
      const against: string[] = [];
      if (job.startsAt > input.occurredAt + 2 * 86_400_000) against.push("is after the conversation");
      if (!reasons.length) against.push("nothing in the words points at it");
      return { jobId: job._id, customerId: job.customerId, propertyId: job.propertyId, startsAt: job.startsAt, for: reasons, against };
    })
    .sort((a, b) => b.startsAt - a.startsAt);
  if (input.explicitJobId) return { status: "linked", jobId: input.explicitJobId, method: "explicit_reference", why: "The text carries a link to this visit.", candidates };
  if (!input.customerIds.length) return { status: "unlinked", why: "The number is not on any client's record.", candidates };
  if (input.customerIds.length > 1) return { status: "needs_review", why: `The number is on ${input.customerIds.length} clients' records, so a person decides which one this is.`, candidates };
  if (input.threadJobId) {
    const others = candidates.filter((c) => c.jobId !== input.threadJobId && c.startsAt > (candidates.find((x) => x.jobId === input.threadJobId)?.startsAt ?? 0));
    if (!others.length) return { status: "linked", jobId: input.threadJobId, method: "thread_association", why: "An earlier message in the same conversation is linked to this visit, and no later visit came between.", candidates };
  }
  if (!candidates.length) return { status: "unlinked", why: "The client has no visit in the two weeks before this conversation.", candidates };
  const pointed = candidates.filter((c) => strong(c.for));
  if (candidates.length === 1 && pointed.length === 1) return { status: "linked", jobId: pointed[0].jobId, method: "verified_relationship", why: `The number is on one client's record, they had one visit in the window, and the words ${pointed[0].for[0]}.`, candidates };
  if (pointed.length === 1 && candidates.length > 1) {
    // Several visits (several properties, or a recurring service): only a strong pointer to exactly one, with a street or date, decides it.
    const decisive = pointed[0].for.some((r) => r.includes("date") || (r.startsWith("names ") && !r.includes("service") && !r.includes("day")));
    if (decisive) return { status: "linked", jobId: pointed[0].jobId, method: "verified_relationship", why: `The client had ${candidates.length} visits in the window; the words ${pointed[0].for.join(" and ")}, and point at no other.`, candidates };
  }
  if (candidates.length === 1) return { status: "needs_review", why: "The number is on one client's record and they had one visit in the window, but nothing in the words points at it. A matching number alone is not enough.", candidates };
  return { status: "needs_review", why: `The client had ${candidates.length} visits in the window and the words do not settle which one this is about.`, candidates };
}
