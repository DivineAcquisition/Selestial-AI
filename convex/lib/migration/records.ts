/**
 * Records brought from another system besides clients: upcoming appointments, recurring service and past
 * invoices or service history. Pure parts only: reading one spreadsheet row. Writing is in
 * convex/migrationImports.ts.
 *
 * Every record belongs to a client already in Selestial and is matched to one by email, phone or exact name,
 * never guessed. An imported appointment or schedule is kept for the owner to review: nothing is booked,
 * priced, assigned or sent because it was imported. History is reference only, never an invoice to collect.
 */
import type { Schedule } from "../services/spec";

export const RECORD_KINDS = ["appointment", "recurring", "history"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const KIND_WORDS: Record<RecordKind, { one: string; many: string }> = {
  appointment: { one: "appointment", many: "appointments" },
  recurring: { one: "recurring schedule", many: "recurring schedules" },
  history: { one: "history record", many: "history records" },
};

export const RECORD_ROW_LIMIT = 1000;
export const RECORD_COMMIT_LIMIT = 100;

export type RecordField =
  | "clientName"
  | "clientEmail"
  | "clientPhone"
  | "street"
  | "date"
  | "time"
  | "endDate"
  | "duration"
  | "frequency"
  | "amount"
  | "reference"
  | "description"
  | "status"
  | "assignedTo";

export const RECORD_FIELD_LABELS: Record<RecordField, string> = {
  clientName: "Client name",
  clientEmail: "Client email",
  clientPhone: "Client phone",
  street: "Service street",
  date: "Date",
  time: "Start time",
  endDate: "End date",
  duration: "Duration",
  frequency: "Frequency",
  amount: "Amount",
  reference: "Job or invoice number",
  description: "Description",
  status: "Status",
  assignedTo: "Assigned to",
};

/** The fields each kind asks for, in the order shown. */
export const FIELDS_FOR: Record<RecordKind, RecordField[]> = {
  appointment: ["clientName", "clientEmail", "clientPhone", "street", "date", "time", "duration", "amount", "description", "assignedTo", "reference"],
  recurring: ["clientName", "clientEmail", "clientPhone", "street", "frequency", "date", "endDate", "time", "duration", "amount", "description", "reference"],
  history: ["clientName", "clientEmail", "clientPhone", "date", "amount", "reference", "description", "status"],
};

export const REQUIRED_FOR: Record<RecordKind, RecordField[]> = {
  appointment: ["clientName", "date"],
  recurring: ["clientName", "frequency"],
  history: ["clientName", "date"],
};

/**
 * Header names, including those in Jobber's Visits, Recurring jobs and Invoices reports and Housecall Pro's
 * job export as their help centers list them. A guess is a suggestion the owner confirms.
 */
const GUESSES: Record<RecordField, string[]> = {
  clientName: ["client name", "customer name", "customer", "client", "name", "display name"],
  clientEmail: ["client email", "customer email", "email"],
  clientPhone: ["client phone", "customer phone", "mobile phone", "phone", "mobile number"],
  street: ["service street", "service address", "street", "address", "street 1", "job location"],
  date: ["date", "visit date", "scheduled date", "scheduled start", "schedule start date", "start date", "booking start date time", "issued date", "invoice date", "created at", "completed date"],
  time: ["start time", "time", "scheduled time"],
  endDate: ["schedule end date", "end date"],
  duration: ["scheduled duration", "duration", "job duration", "total duration"],
  frequency: ["visit frequency", "frequency", "recurring", "recurrence", "occurrence", "repeat"],
  amount: ["total ($)", "total", "invoice total", "amount", "job amount", "subtotal ($)", "job revenue ($)", "paid amount"],
  reference: ["job #", "invoice #", "invoice number", "job number", "booking id", "id"],
  description: ["visit title", "job title", "job name", "description", "job description", "line items", "service"],
  status: ["status", "job status", "payment status", "invoice status"],
  assignedTo: ["assigned to", "visits assigned to", "assigned employees", "employee", "provider"],
};

export function guessRecordMapping(kind: RecordKind, header: string[]): Partial<Record<RecordField, number>> {
  const names = header.map((cell) => cell.trim().toLowerCase());
  const out: Partial<Record<RecordField, number>> = {};
  const used = new Set<number>();
  for (const field of FIELDS_FOR[kind]) {
    for (const guess of GUESSES[field]) {
      const index = names.indexOf(guess);
      if (index >= 0 && !used.has(index)) {
        out[field] = index;
        used.add(index);
        break;
      }
    }
  }
  return out;
}

export type RecordRow = Partial<Record<RecordField, string>>;

export function toRecordRow(cells: string[], mapping: Partial<Record<RecordField, number>>): RecordRow {
  const row: RecordRow = {};
  for (const [field, index] of Object.entries(mapping) as [RecordField, number | undefined][]) {
    if (index === undefined) continue;
    const value = (cells[index] ?? "").trim();
    if (value) row[field] = value.slice(0, 500);
  }
  return row;
}

// ── Reading values ────────────────────────────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

function validDay(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * A calendar day, YYYY-MM-DD, from the ways exports write one: 2026-12-03, 12/03/2026 (US order), or
 * Dec 3, 2026. A time after the date is ignored here and read by `readTime`. Anything else is null.
 */
export function readDay(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (match) return validDay(+match[1], +match[2], +match[3]);
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(text);
  if (match) return validDay(match[3].length === 2 ? 2000 + +match[3] : +match[3], +match[1], +match[2]);
  match = /^(?:[a-z]+,?\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(text);
  if (match) {
    const month = MONTHS.indexOf(match[1].toLowerCase()) + 1;
    return month ? validDay(+match[3], month, +match[2]) : null;
  }
  return null;
}

/** A timestamp that names its own zone: "2026-12-03T02:00:00Z" or "2026-12-03 18:00-08:00". */
const ZONED = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i;

/** The instant a zoned timestamp names, or null when the value is not one. */
function zonedInstant(value: string | undefined): number | null {
  const match = ZONED.exec(value?.trim() ?? "");
  if (!match) return null;
  if (!validDay(+match[1], +match[2], +match[3]) || +match[4] > 23 || +match[5] > 59) return null;
  let offsetMinutes = 0;
  if (match[7].toUpperCase() !== "Z") {
    const sign = match[7].startsWith("-") ? -1 : 1;
    const digitsOnly = match[7].slice(1).replace(":", "");
    offsetMinutes = sign * (+digitsOnly.slice(0, 2) * 60 + +(digitsOnly.slice(2, 4) || "0"));
  }
  return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] ?? "0")) - offsetMinutes * 60_000;
}

/**
 * The day and start time of a row on the company's clock.
 *
 * - A timestamp with its own zone ("…T02:00Z", or an offset) is an instant: it is converted to the
 *   company's time zone first, so 02:00 UTC on the 3rd is the evening of the 2nd in Chicago, on either
 *   side of a daylight-saving change.
 * - Anything else is already the company's wall clock and is read as written.
 * - The time comes from the Start time column when the row has one, and otherwise from the time written
 *   in the date column ("Scheduled start", "Booking start date time").
 */
export function readStart(row: Pick<RecordRow, "date" | "time">, timezone: string): { day: string | null; time: string | null } {
  const instant = zonedInstant(row.date);
  if (instant !== null) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, time: readTime(row.time) ?? `${parts.hour}:${parts.minute}` };
  }
  return { day: readDay(row.date), time: readTime(row.time) ?? readTime(row.date) };
}

/** A time of day, HH:MM on a 24-hour clock, from "9:30", "09:30 AM", "2:00pm" or a date with a time. */
export function readTime(value: string | undefined): string | null {
  const match = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?/i.exec(value ?? "");
  if (!match) return null;
  let hour = +match[1];
  const minute = +match[2];
  const half = match[3]?.toLowerCase().replace(/\./g, "");
  if (half === "pm" && hour < 12) hour += 12;
  if (half === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

/** Minutes, from "90", "1.5" (Jobber writes hours as a decimal), "1:30", "2h", "45 min". */
export function readMinutes(value: string | undefined): number | null {
  const text = value?.trim().toLowerCase();
  if (!text) return null;
  let match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (match) return +match[1] * 60 + +match[2];
  match = /^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?)$/.exec(text);
  if (match) return Math.round(+match[1] * 60);
  match = /^(\d+)\s*(m|min|mins|minutes?)$/.exec(text);
  if (match) return +match[1];
  match = /^(\d+(?:\.\d+)?)$/.exec(text);
  if (match) {
    const n = +match[1];
    // A small number is hours (Jobber's 0.5, 2.5); a larger whole number is minutes.
    return n <= 12 ? Math.round(n * 60) : Math.round(n);
  }
  return null;
}

/** Cents, from "$1,234.50", "1234.5", "(45.00)" (a negative in accounting style). */
export function readCents(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  const number = text.replace(/[^0-9.]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(number)) return null;
  const cents = Math.round(parseFloat(number) * 100);
  return negative ? -cents : cents;
}

/**
 * Selestial's schedule for a frequency an export wrote in words, or null when it does not say one plainly.
 * "Every 4 weeks" and "monthly" are different calendars and are kept apart.
 */
export function readCadence(value: string | undefined): Schedule | null {
  const text = value?.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return null;
  // "Bi-monthly" means twice a month to some and every two months to others. It is never guessed.
  if (ambiguousCadence(text)) return null;
  if (/twice (a|per) month|semi-?monthly|2x (a |per )?month/.test(text)) return "twice_per_month";
  if (/every (4|four) weeks|every 28 days|4-?weekly/.test(text)) return "every_28_days";
  if (/every (2|two|other) weeks?|bi-?weekly|fortnight|every 14 days/.test(text)) return "every_14_days";
  if (/^weekly$|every week|every 7 days|once a week|^1 week/.test(text)) return "every_7_days";
  if (/monthly|every month|once a month|per month/.test(text)) return "once_per_month";
  return null;
}

/** True for a frequency that reads two ways, so the owner chooses the schedule themselves. */
export function ambiguousCadence(value: string | undefined): boolean {
  return /\bbi-?\s?monthly\b/i.test(value ?? "");
}

export const CADENCE_WORDS: Record<Schedule, string> = {
  every_7_days: "Every week",
  every_14_days: "Every 2 weeks",
  every_28_days: "Every 4 weeks",
  twice_per_month: "Twice a month",
  once_per_month: "Once a month",
};

/** What is wrong with a row before it can be matched, in words for the owner. */
export function recordProblems(kind: RecordKind, row: RecordRow): string[] {
  const problems: string[] = [];
  if (!row.clientName?.trim() && !row.clientEmail?.trim() && !row.clientPhone?.trim()) problems.push("It has no client name, email or phone to match.");
  if (kind !== "recurring" || row.date) {
    if (!row.date?.trim()) problems.push("It has no date.");
    else if (!readDay(row.date)) problems.push(`"${row.date}" isn't a date Selestial can read. Use YYYY-MM-DD.`);
  }
  if (row.time && !readTime(row.time)) problems.push(`"${row.time}" isn't a time Selestial can read. Use HH:MM.`);
  if (row.duration && readMinutes(row.duration) === null) problems.push(`"${row.duration}" isn't a duration Selestial can read.`);
  if (row.amount && readCents(row.amount) === null) problems.push(`"${row.amount}" isn't an amount Selestial can read.`);
  if (kind === "recurring" && !row.frequency?.trim()) problems.push("It has no frequency.");
  if (row.endDate && !readDay(row.endDate)) problems.push(`"${row.endDate}" isn't a date Selestial can read.`);
  return problems;
}

/** Notes that do not stop the import but the owner should see. */
export function recordNotes(kind: RecordKind, row: RecordRow, today: string, timezone?: string): string[] {
  const notes: string[] = [];
  const day = timezone ? readStart(row, timezone).day : readDay(row.date);
  if (kind === "appointment" && day && day < today) notes.push("This date has passed. It is kept as history, not as an upcoming visit.");
  if (kind === "recurring" && row.frequency && ambiguousCadence(row.frequency)) notes.push(`"${row.frequency}" can mean twice a month or every two months. It is kept as written and marked for review; choose the schedule when you set it up.`);
  else if (kind === "recurring" && row.frequency && !readCadence(row.frequency)) notes.push(`"${row.frequency}" is kept as written; choose the schedule when you set it up.`);
  return notes;
}

const keyPart = (value: string | undefined) => (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The key that says two rows are the same record, so a file imported twice adds nothing the second time.
 * It names the job number, the day and start time on the company's clock, the client and the service
 * street: two visits for one client on one day, at different times or different properties, are two records.
 */
export function recordKey(kind: RecordKind, row: RecordRow, timezone = "UTC"): string {
  const start = readStart(row, timezone);
  const parts = ["v2", kind, keyPart(row.reference), start.day ?? "", start.time ?? "", keyPart(row.clientEmail ?? row.clientPhone ?? row.clientName), keyPart(row.street).replace(/[.,#]/g, ""), kind === "history" ? String(readCents(row.amount) ?? "") : ""];
  return parts.join("|").slice(0, 400);
}

/** The key records were stored under before the street and the date column's time were part of it. Read only to recognize those records. */
export function legacyRecordKey(kind: RecordKind, row: RecordRow): string {
  const parts = [kind, (row.reference ?? "").trim().toLowerCase(), readDay(row.date) ?? "", readTime(row.time) ?? "", (row.clientEmail ?? row.clientPhone ?? row.clientName ?? "").trim().toLowerCase(), kind === "history" ? String(readCents(row.amount) ?? "") : ""];
  return parts.join("|").slice(0, 300);
}
