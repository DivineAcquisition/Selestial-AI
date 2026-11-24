/**
 * Calendar's vocabulary (docs/calendar/00-architecture.md). Calendar is a view over the company's own
 * records: a visit is a job, an interview is an interview, a walkthrough is an assessment. Nothing here is
 * stored. Every item names the record it was read from, and every change goes back through that record's
 * own workflow.
 *
 * These are pure functions: no database, no clock. convex/calendar.ts reads the records and calls them.
 */
import type { Doc } from "../../_generated/dataModel";
import type { Agent } from "../statuses";
import type { Role } from "../roles";
import type { Staffing } from "../dispatch/crew";

// ── Layers ──────────────────────────────────────────────────────────────────────────────────────────

/** The groups a person turns on and off. Each maps to records that exist; none is decoration. */
export const LAYERS = ["jobs", "hiring", "sales", "quality", "availability", "business", "deadlines", "external"] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * Who may see each layer. Office works visits and crews; everything about applicants, walkthroughs,
 * inspections, members' own time, the company's connected calendar and most deadlines is for Owners and
 * Managers (the owner's decision of November 23, 2026). Convex enforces this on every read.
 */
export const LAYER_ROLES: Record<Layer, readonly Role[]> = {
  jobs: ["owner", "manager", "office"],
  availability: ["owner", "manager", "office"],
  deadlines: ["owner", "manager", "office"],
  hiring: ["owner", "manager"],
  sales: ["owner", "manager"],
  quality: ["owner", "manager"],
  business: ["owner", "manager"],
  external: ["owner", "manager"],
};

export function layersFor(role: Role): Layer[] {
  return LAYERS.filter((layer) => LAYER_ROLES[layer].includes(role));
}

/** The layers shown when nobody has chosen: the operational view. Deadlines and outside busy time are behind filters. */
export const DEFAULT_LAYERS: readonly Layer[] = ["jobs", "hiring", "sales", "quality", "availability", "business"];

// ── Items ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * What kind of time an item is. These are never mixed up on screen:
 * appointment: it occupies time and was booked.
 * proposed: a time was offered and nobody has confirmed it.
 * due: a date something must happen by. It reserves no time.
 * availability: hours someone can or cannot work.
 * projected: a recurring occurrence beyond what is booked. Nothing exists for it yet.
 */
export const TIMINGS = ["appointment", "proposed", "due", "availability", "projected"] as const;
export type Timing = (typeof TIMINGS)[number];

export const KINDS = [
  "visit",
  "correction_visit",
  "projected_visit",
  "interview",
  "interview_slot",
  "walkthrough",
  "time_off",
  "unavailable",
  "task_due",
  "renewal_due",
  "meeting",
  "appointment",
  "member_unavailable",
  "training",
  "inspection",
  "external_busy",
] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LAYER: Record<Kind, Layer> = {
  visit: "jobs",
  correction_visit: "jobs",
  projected_visit: "jobs",
  interview: "hiring",
  interview_slot: "hiring",
  walkthrough: "sales",
  time_off: "availability",
  unavailable: "availability",
  task_due: "deadlines",
  meeting: "business",
  appointment: "business",
  member_unavailable: "business",
  training: "hiring",
  inspection: "quality",
  renewal_due: "deadlines",
  external_busy: "external",
};

/** The record an item was read from. Calendar never edits an item; it edits this. */
export type SourceRef =
  | { table: "jobs"; id: string }
  | { table: "servicePlans"; id: string }
  | { table: "recurringPlans"; id: string }
  | { table: "interviews"; id: string }
  | { table: "interviewSlots"; id: string }
  | { table: "assessments"; id: string }
  | { table: "timeOff"; id: string }
  | { table: "availabilityExceptions"; id: string }
  | { table: "tasks"; id: string }
  | { table: "agreements"; id: string }
  | { table: "googleBusy"; id: string }
  | { table: "calendarEvents"; id: string };

export type Resource = { kind: "cleaner" | "member"; id: string; name: string; state: "accepted" | "offered" | "assigned" | "away" };

export type Item = {
  /** Stable across reads: the source table and id, and the occurrence date for a projection. */
  key: string;
  source: SourceRef;
  kind: Kind;
  layer: Layer;
  timing: Timing;
  title: string;
  /** A second line: service, applicant, property area. Never access instructions, pay or private notes. */
  detail: string | null;
  startsAt: number;
  endsAt: number;
  /** A date with no time (a due date, a whole day off): YYYY-MM-DD on the company's calendar. */
  allDay: string | null;
  /** The visit may begin any time from startsAt until here. Null when it starts at a fixed time. */
  arrivalEndsAt: number | null;
  /** The zone the record was scheduled in. The company's unless the property has its own. */
  timezone: string;
  status: string;
  /** The status in words. Color is never the only sign of it. */
  statusLabel: string;
  resources: Resource[];
  customerId: string | null;
  /** The client's name, for the client filter. Filled once for the whole answer. */
  customerName?: string | null;
  propertyId: string | null;
  /** The agent whose work this is, when one is. */
  agent: Agent | null;
  /** What is wrong with it, from the record. Empty when nothing is. */
  problems: string[];
  /** Where to open the record itself. */
  href: string | null;
  /** The connected calendar shows this record changed outside Selestial, waiting for a person. */
  googleChange?: { linkId: string; change: "moved" | "deleted" | "edited"; startsAt: number | null; endsAt: number | null } | null;
  /** The record's own version, so a change prepared against an older read is recognised as stale. */
  version: number;
};

// ── Visits ──────────────────────────────────────────────────────────────────────────────────────────

/** What sort of visit this is, from the record: a correction, a turnover, commercial, recurring or one-time. */
export function visitCategory(job: { planId?: string; recovery?: Doc<"jobs">["recovery"] }, propertyKind: string | null): { id: string; label: string } {
  if (job.recovery) return { id: "correction", label: "Correction visit" };
  if (propertyKind === "short_term_rental") return { id: "turnover", label: "Turnover" };
  if (propertyKind === "office") return { id: "office", label: "Office cleaning" };
  if (propertyKind === "commercial") return { id: "commercial", label: "Commercial cleaning" };
  if (job.planId) return { id: "recurring", label: "Recurring visit" };
  return { id: "one_time", label: "One-time visit" };
}

export const VISIT_STATES = ["booked", "offer_sent", "partly_staffed", "fully_staffed", "in_progress", "under_review", "completed", "cancelled"] as const;
export type VisitState = (typeof VISIT_STATES)[number];

export const VISIT_STATE_LABEL: Record<VisitState, string> = {
  booked: "Booked · nobody assigned",
  offer_sent: "Offer sent",
  partly_staffed: "Partly staffed",
  fully_staffed: "Fully staffed",
  in_progress: "In progress",
  under_review: "Done · under review",
  completed: "Completed",
  cancelled: "Cancelled",
};

/**
 * One state for a visit, from the job and its crew, using the same separation Dispatch uses: the job's
 * status, its crew and its review are separate facts. "Accepted" by part of the crew is partly staffed;
 * every place accepted is fully staffed; an offer out is not a cleaner.
 */
export function visitState(job: Pick<Doc<"jobs">, "status" | "completionReportedAt" | "completionReview">, staff: Pick<Staffing, "open" | "accepted" | "offersOut">): VisitState {
  if (job.status === "cancelled") return "cancelled";
  if (job.completionReportedAt !== undefined && job.completionReview === undefined && job.status !== "completed") return "under_review";
  if (job.status === "completed") return "completed";
  if (job.status === "in_progress") return "in_progress";
  if (staff.open === 0) return "fully_staffed";
  if (staff.accepted > 0) return "partly_staffed";
  if (staff.offersOut > 0) return "offer_sent";
  return "booked";
}

// ── Interviews and walkthroughs ─────────────────────────────────────────────────────────────────────

export const INTERVIEW_LABEL: Record<Doc<"interviews">["status"], string> = {
  awaiting_slots: "Waiting for times",
  proposed: "Times offered · not confirmed",
  reserving: "Holding the time",
  confirmed: "Confirmed",
  completed: "Held",
  cancelled: "Cancelled",
  no_show: "Applicant did not come",
};

/** Only a confirmed interview is an appointment. A held or reserving time is not yet confirmed. */
export function interviewTiming(status: Doc<"interviews">["status"]): Timing {
  return status === "reserving" ? "proposed" : "appointment";
}

export const WALKTHROUGH_LABEL: Record<Doc<"assessments">["status"], string> = {
  requested: "Requested · no time yet",
  scheduled: "Scheduled",
  completed: "Findings recorded",
  cancelled: "Cancelled",
};

// ── Ranges ──────────────────────────────────────────────────────────────────────────────────────────

/** An item is in the range when any part of it is. An item that ends at the range's start is not. */
export function overlaps(item: { startsAt: number; endsAt: number }, from: number, to: number): boolean {
  return item.startsAt < to && item.endsAt > from;
}

/** The most days one read covers. A month view with its leading and trailing week fits. */
export const MAX_RANGE_DAYS = 45;

/** How many records of one kind a single read takes. A source that reaches it is reported, never silently cut. */
export const SOURCE_LIMIT = 400;

/** Sorted the way a person reads a schedule: by start, longer first when two start together, then by key. */
export function byStart(a: Pick<Item, "startsAt" | "endsAt" | "key">, b: Pick<Item, "startsAt" | "endsAt" | "key">): number {
  return a.startsAt - b.startsAt || b.endsAt - a.endsAt || a.key.localeCompare(b.key);
}

/** Calendar's own events by kind: which Item kind each becomes. */
export const EVENT_ITEM_KIND = { meeting: "meeting", appointment: "appointment", unavailable: "member_unavailable", training: "training", inspection: "inspection" } as const satisfies Record<string, Kind>;

export const EVENT_STATUS_LABEL: Record<"scheduled" | "completed" | "cancelled", string> = { scheduled: "Scheduled", completed: "Done", cancelled: "Cancelled" };
