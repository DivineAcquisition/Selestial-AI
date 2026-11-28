/**
 * The Instant Shine adapter: an exported snapshot in, rows for Selestial's guided migration out, with an
 * outcome for every source record and nothing dropped silently. Pure and deterministic: the same snapshot
 * always gives the same rows, so staging twice changes nothing.
 *
 * It only shapes data. Every row still goes through the migration's own check, review, import and release,
 * with their validation, duplicate detection, held state and permissions.
 *
 * Identity: every id is namespaced by source instance, source table and source id
 * (`<instance>/<table>/<id>`), so two tables or two databases can never collide. A person who is both a
 * payroll contractor and a directory subcontractor (the same id, by the source's own sync trigger) is one
 * cleaner, with both references kept.
 *
 * Nothing is inferred from a shared email, phone or name: a shared value is noted, never merged.
 */
import { CATALOG, CATALOG_BY_TABLE } from "./catalog";
import { checkStoredPrice, type OfferType } from "./pricing";
import { selestialPayRule, type RateBracket } from "./pay";

export type Row = Record<string, unknown>;
export type Snapshot = { manifest?: { version?: number; source?: { instance?: string }; startedAt?: string; consistent?: boolean; moved?: string[] }; tables: Record<string, Row[]> };

export type Kind = "customers" | "properties" | "recurring" | "cleaners" | "bookings" | "history";
export type Outcome = "staged" | "merged" | "review" | "archived" | "retained" | "excluded";
export type RecordOutcome = { table: string; id: string; outcome: Outcome; kind?: Kind; ref?: string; label?: string; reason: string };
export type StagedFile = { kind: Kind; name: string; header: string[]; rows: { sourceId: string; cells: string[] }[] };

export type Adapted = {
  instance: string;
  snapshotAt: string | null;
  consistent: boolean | null;
  files: StagedFile[];
  records: RecordOutcome[];
  reconciliation: { table: string; source: number; outcomes: Partial<Record<Outcome, number>>; balanced: boolean }[];
  config: {
    timezone: string | null;
    serviceAreas: string[];
    hours: { weekday: number; startMinute: number; endMinute: number }[];
    booking: { leadTimeHours: number | null; horizonDays: number | null; perSlotCapacity: number | null; arrivalWindows: string[] };
    pay: { model: string | null; brackets: RateBracket[]; rule: { shareBps: number; mode: "split_by_crew" } | null; payCycle: string | null; mileageRate: number | null };
    promotions: { code: string; words: string; active: boolean }[];
  };
  finance: {
    visits: { ref: string; label: string; date: string; totalCents: number | null; depositCents: number | null; balanceCents: number | null; refundedCents: number; paymentStatus: string; stripe: { paymentIntent: string | null; balanceIntent: string | null; customer: string | null; subscription: string | null }; priceNotes: string[] }[];
    totals: { paymentStatus: string; visits: number; totalCents: number; depositCents: number; balanceCents: number; refundedCents: number }[];
  };
  links: { kind: string; count: number; what: string }[];
  flags: { placeholderContacts: number; sharedPhones: number; sharedEmails: number; outOfArea: number; heldBack: { ref: string; label: string; why: string }[] };
};

// ── Small helpers ─────────────────────────────────────────────────────────────────────────────────────

const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value).trim());
const PLACEHOLDER_EMAIL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@/i;

/** A usable email, or null. The source's sync writes `<uuid>@<business domain>` when there is none. */
export function realEmail(value: unknown): string | null {
  const email = str(value).toLowerCase();
  if (!email || !email.includes("@") || PLACEHOLDER_EMAIL.test(email)) return null;
  return email;
}

/** A usable 10-digit phone, or null. The source writes 0000000000 when there is none. */
export function realPhone(value: unknown): string | null {
  let digits = str(value).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10 || /^0+$/.test(digits) || /^(\d)\1{9}$/.test(digits)) return null;
  return digits;
}

const TEST_SIGNAL = /(^|[^a-z])test([^a-z]|$)|example\.(com|org|net)|mailinator|@divineacquisition\.io$/i;

/** Evidence that a record is a test, in words, or null. Only explicit signals; a far-away address isn't one. */
export function testEvidence(name: string, email: string | null): string | null {
  if (TEST_SIGNAL.test(name)) return `its name ("${name}") says test`;
  if (email && TEST_SIGNAL.test(email)) return `its email (${email.replace(/^[^@]*/, "…")}) is a test or vendor address`;
  return null;
}

/** Texas ZIP codes start 75–79 or 885. Used only to fill a missing state, and said so. */
export const regionFromZip = (zip: string): string | null => (/^(7[5-9]\d|885)/.test(zip) ? "TX" : null);

function splitAddress(raw: string): { line1: string; city: string; region: string; postalCode: string } {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const tail = parts.slice(1).join(", ");
  const stateZip = tail.match(/\b([A-Z]{2})\s*(\d{5})(?:-\d{4})?\b/);
  return { line1: parts[0] ?? "", city: parts.length >= 3 ? parts[1] : "", region: stateZip?.[1] ?? "", postalCode: stateZip?.[2] ?? "" };
}

/** "8:00 AM - 10:00 AM" → minutes after midnight. */
export function slotMinutes(slot: string): { start: number; end: number } | null {
  const match = slot.match(/(\d{1,2}):(\d{2})\s*([AP]M)\s*[-–]\s*(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!match) return null;
  const at = (h: string, m: string, ap: string) => ((Number(h) % 12) + (ap.toUpperCase() === "PM" ? 12 : 0)) * 60 + Number(m);
  return { start: at(match[1], match[2], match[3]), end: at(match[4], match[5], match[6]) };
}
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const cents = (value: unknown): number | null => (value === null || value === undefined || value === "" || Number.isNaN(Number(value)) ? null : Math.round(Number(value) * 100));
const dollars = (c: number) => (c / 100).toFixed(2);

const OFFER_OF: Record<string, OfferType> = { standard: "standard", regular: "standard", deep: "deep_clean", deep_clean: "deep_clean", move_in_out: "move_in_out", recurring: "recurring" };
const SERVICE_NAME: Record<OfferType, string> = { standard: "Standard Clean", deep_clean: "Deep Clean", move_in_out: "Move-In / Move-Out Clean", recurring: "Recurring Maintenance" };
const FREQUENCY: Record<string, string> = { weekly: "every week", biweekly: "every 2 weeks", bi_weekly: "every 2 weeks", monthly: "once a month" };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const HEADERS: Record<Kind, string[]> = {
  properties: ["externalId", "customerRef", "customerName", "line1", "line2", "city", "region", "postalCode"],
  customers: ["externalId", "firstName", "lastName", "name", "email", "phone", "line1", "line2", "city", "region", "postalCode", "notes", "smsOptOut"],
  recurring: ["externalId", "customerRef", "customerName", "line1", "city", "region", "postalCode", "service", "frequency", "nextVisit", "time", "durationMinutes", "price", "status", "notes"],
  cleaners: ["externalId", "firstName", "lastName", "name", "email", "phone", "engagement", "status", "notes"],
  bookings: ["externalId", "customerRef", "customerName", "line1", "city", "region", "postalCode", "service", "date", "time", "durationMinutes", "price", "status", "crew", "notes"],
  history: ["externalId", "customerRef", "customerName", "line1", "city", "region", "postalCode", "date", "service", "price", "status", "notes"],
};
const FILE_NAMES: Record<Kind, string> = { properties: "Instant Shine service addresses", customers: "Instant Shine customers", recurring: "Instant Shine recurring services", cleaners: "Instant Shine cleaners", bookings: "Instant Shine upcoming visits", history: "Instant Shine visit history" };

// ── The adapter ───────────────────────────────────────────────────────────────────────────────────────

export function adaptInstantShine(snapshot: Snapshot, options: { instance?: string; today: string; include?: string[] }): Adapted {
  const instance = options.instance ?? snapshot.manifest?.source?.instance ?? "instant_shine";
  const ns = (table: string, id: unknown) => `${instance}/${table}/${str(id)}`.slice(0, 120);
  const tables = snapshot.tables;
  const rows = (table: string): Row[] => tables[table] ?? [];
  const include = new Set(options.include ?? []);
  const records: RecordOutcome[] = [];
  const staged: Record<Kind, { sourceId: string; values: Record<string, string> }[]> = { customers: [], properties: [], recurring: [], cleaners: [], bookings: [], history: [] };
  const heldBack: Adapted["flags"]["heldBack"] = [];
  const out = (r: RecordOutcome) => records.push(r);
  const stage = (kind: Kind, sourceId: string, values: Record<string, string | null | undefined>) => {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== "") clean[key] = String(value).slice(0, 500);
    staged[kind].push({ sourceId, values: clean });
  };

  // Company configuration.
  const calendar = rows("business_calendar_settings")[0] ?? {};
  const timezone = str(calendar.timezone) || null;
  const slots = (Array.isArray(calendar.slot_templates) ? calendar.slot_templates : []).map(String);
  const windows = slots.map(slotMinutes).filter((w): w is { start: number; end: number } => w !== null);
  const closed = new Set((Array.isArray(calendar.closed_weekdays) ? calendar.closed_weekdays : []).map(Number));
  const hours = windows.length ? [0, 1, 2, 3, 4, 5, 6].filter((d) => !closed.has(d)).map((weekday) => ({ weekday, startMinute: Math.min(...windows.map((w) => w.start)), endMinute: Math.max(...windows.map((w) => w.end)) })) : [];
  const serviceAreas = [...new Set(rows("service_areas").filter((a) => a.active !== false).map((a) => str(a.zip_code)).filter((z) => /^\d{5}$/.test(z)))].sort();
  const areaSet = new Set(serviceAreas);
  const brackets: RateBracket[] = rows("cleaner_pay_rates").map((r) => ({ minCrew: Number(r.min_crew_size ?? 1), maxCrew: r.max_crew_size === null || r.max_crew_size === undefined ? null : Number(r.max_crew_size), tier: str(r.pay_tier).toLowerCase(), ratePercent: Number(r.rate_percent) }));
  const payroll = rows("payroll_settings")[0] ?? {};
  const tiers = [...new Set(brackets.map((b) => b.tier))];
  const config: Adapted["config"] = {
    timezone,
    serviceAreas,
    hours,
    booking: { leadTimeHours: calendar.lead_time_hours === undefined ? null : Number(calendar.lead_time_hours), horizonDays: calendar.booking_horizon_days === undefined ? null : Number(calendar.booking_horizon_days), perSlotCapacity: calendar.slot_capacity === undefined ? null : Number(calendar.slot_capacity), arrivalWindows: slots },
    pay: { model: str(payroll.payout_model) || null, brackets, rule: tiers.length === 1 ? selestialPayRule(brackets, tiers[0]) : null, payCycle: str(payroll.pay_cycle) || null, mileageRate: payroll.mileage_rate === undefined ? null : Number(payroll.mileage_rate) },
    promotions: rows("promo_codes").map((p) => ({ code: str(p.code), active: p.is_active !== false, words: `${str(p.discount_type) === "flat" ? `$${dollars(Number(p.discount_value))}` : `${Number(p.discount_value)}%`} off ${str(p.applies_to).replace(/_/g, " ") || "any service"}${p.expires_at ? `, until ${str(p.expires_at).slice(0, 10)}` : ""}` })),
  };
  for (const table of ["business_calendar_settings", "service_areas", "payroll_settings", "cleaner_pay_rates"]) for (const r of rows(table)) out({ table, id: str(r.id ?? r.zip_code), outcome: "staged", reason: "Company setting, applied by the Owner from the review." });
  for (const r of rows("promo_codes")) out({ table: "promo_codes", id: str(r.id), outcome: "review", label: str(r.code), reason: "A promotion is applied only after the Owner approves it." });

  // Opt-outs, keyed by phone, applied to the matching customer before anything else.
  const optedOut = new Set(rows("sms_opt_outs").filter((o) => !o.lifted_at).map((o) => realPhone(o.phone_e164)).filter((p): p is string => p !== null));
  const optOutUsed = new Set<string>();

  // Shared contact values are noted on each, never used to merge.
  const phoneCount = new Map<string, number>();
  const emailCount = new Map<string, number>();
  const people = [...rows("customers"), ...rows("payroll_recurring_clients")];
  for (const p of people) {
    const ph = realPhone(p.phone);
    const em = realEmail(p.email);
    if (ph) phoneCount.set(ph, (phoneCount.get(ph) ?? 0) + 1);
    if (em) emailCount.set(em, (emailCount.get(em) ?? 0) + 1);
  }
  let placeholderContacts = 0;
  let outOfArea = 0;

  const ownAddress = new Map<string, string>();
  const addressKey = (a: { line1: string; postalCode: string }) => `${a.line1.toLowerCase().replace(/[^a-z0-9]/g, "")}|${a.postalCode}`;
  const extraProperty = new Set<string>();
  /** A visit at an address that isn't the customer's own needs that property first; one per customer and address. */
  const propertyFor = (customerRef: string, customerName: string, address: { line1: string; city: string; region: string; postalCode: string }) => {
    if (!customerRef || !address.line1 || !address.city || !address.region || !address.postalCode) return;
    const key = addressKey(address);
    if (ownAddress.get(customerRef) === key || extraProperty.has(`${customerRef}#${key}`)) return;
    extraProperty.add(`${customerRef}#${key}`);
    const ref = `${customerRef}#${key}`.slice(0, 120);
    stage("properties", ref, { externalId: ref, customerRef, customerName, ...address });
  };
  const customerValues = (table: string, r: Row, address: { line1: string; line2?: string; city: string; region: string; postalCode: string }, extraNotes: string[]) => {
    const email = realEmail(r.email);
    const phone = realPhone(r.phone);
    if (str(r.email) && !email) placeholderContacts += 1;
    if (str(r.phone) && !phone) placeholderContacts += 1;
    const notes = [...extraNotes];
    if (str(r.email) && !email) notes.push("The email in Instant Shine was a placeholder, so none was kept.");
    if (str(r.phone) && !phone) notes.push("The phone in Instant Shine was a placeholder (like 0000000000), so none was kept.");
    if (phone && (phoneCount.get(phone) ?? 0) > 1) notes.push("This phone number is shared with another customer in Instant Shine. They were kept as separate customers.");
    if (email && (emailCount.get(email) ?? 0) > 1) notes.push("This email is shared with another customer in Instant Shine. They were kept as separate customers.");
    if (address.postalCode && serviceAreas.length && !areaSet.has(address.postalCode)) {
      outOfArea += 1;
      notes.push(`ZIP ${address.postalCode} isn't in the service area Instant Shine had.`);
    }
    const refs = [r.stripe_customer_id ? `Stripe customer ${str(r.stripe_customer_id)}` : "", r.ghl_contact_id ? `HighLevel contact ${str(r.ghl_contact_id)}` : "", r.jobber_client_id ? `Jobber client ${str(r.jobber_client_id)}` : ""].filter(Boolean);
    if (refs.length) notes.push(`Instant Shine references: ${refs.join(", ")}.`);
    const optOut = phone !== null && optedOut.has(phone);
    if (optOut) optOutUsed.add(phone!);
    const first = str(r.first_name);
    const last = str(r.last_name);
    return { email, phone, notes, optOut, first, last, name: str(r.name) || `${first} ${last}`.trim() };
  };

  // Customers.
  for (const r of rows("customers")) {
    const raw = splitAddress(str(r.address));
    const postalCode = str(r.postal_code) || raw.postalCode;
    const address = { line1: str(r.address_line1) || raw.line1, line2: str(r.address_line2), city: str(r.city) || raw.city, region: str(r.state) || raw.region || regionFromZip(postalCode) || "", postalCode };
    const c = customerValues("customers", r, address, []);
    const ref = ns("customers", r.id);
    const test = testEvidence(c.name, c.email);
    if (test && !include.has(ref)) {
      heldBack.push({ ref, label: c.name || "Unnamed customer", why: `Looks like a test record: ${test}.` });
      out({ table: "customers", id: str(r.id), outcome: "excluded", ref, label: c.name, reason: `Held back as a likely test record (${test}). The Owner can include it.` });
      continue;
    }
    stage("customers", ref, { externalId: ref, firstName: c.first, lastName: c.last, name: c.first || c.last ? undefined : c.name, email: c.email, phone: c.phone, ...address, notes: c.notes.join(" "), smsOptOut: c.optOut ? "yes" : undefined });
    ownAddress.set(ref, addressKey(address));
    out({ table: "customers", id: str(r.id), outcome: "staged", kind: "customers", ref, label: c.name, reason: "Customer." });
  }

  // Recurring clients: a customer, and a recurring service that waits for its next visit and arrival time.
  for (const r of rows("payroll_recurring_clients")) {
    const raw = splitAddress(str(r.address));
    const postalCode = str(r.zip_code) || raw.postalCode;
    const region = raw.region || regionFromZip(postalCode) || "";
    const address = { line1: raw.line1 || str(r.address), city: str(r.city) || raw.city, region, postalCode };
    const fromZip = !raw.region && region ? [`State ${region} was taken from the ZIP code.`] : [];
    const c = customerValues("payroll_recurring_clients", r, address, fromZip);
    const customerRef = ns("payroll_recurring_clients", r.id);
    const status = str(r.status) || "active";
    const label = c.name || "Recurring customer";
    const test = testEvidence(c.name, c.email);
    if (test && !include.has(customerRef)) {
      heldBack.push({ ref: customerRef, label, why: `Looks like a test record: ${test}.` });
      out({ table: "payroll_recurring_clients", id: str(r.id), outcome: "excluded", ref: customerRef, label, reason: `Held back as a likely test record (${test}).` });
      continue;
    }
    stage("customers", customerRef, { externalId: customerRef, firstName: c.first, lastName: c.last, name: c.name, email: c.email, phone: c.phone, ...address, notes: c.notes.join(" "), smsOptOut: c.optOut ? "yes" : undefined });
    ownAddress.set(customerRef, addressKey(address));
    if (status === "ended") {
      out({ table: "payroll_recurring_clients", id: str(r.id), outcome: "staged", kind: "customers", ref: customerRef, label, reason: "Customer. Their recurring service had ended, so no plan was staged." });
      continue;
    }
    const day = r.service_day_of_week === null || r.service_day_of_week === undefined || r.service_day_of_week === "" ? null : Number(r.service_day_of_week);
    const frequency = FREQUENCY[str(r.frequency)] ?? str(r.frequency);
    const notes = [
      "From Instant Shine's payroll schedule.",
      day !== null ? `Usually on ${WEEKDAYS[day]}.` : "No usual day recorded.",
      r.start_date ? `Recorded start ${str(r.start_date).slice(0, 10)} (the date the list was entered, not necessarily the first visit).` : "",
      "Instant Shine has no next visit or arrival time for this customer: add them before the plan can be scheduled.",
    ].filter(Boolean);
    stage("recurring", ns("payroll_recurring_clients:plan", r.id), {
      externalId: ns("payroll_recurring_clients:plan", r.id),
      customerRef,
      customerName: label,
      ...address,
      service: SERVICE_NAME.recurring,
      frequency,
      nextVisit: "",
      time: "",
      durationMinutes: r.duration_hrs === null || r.duration_hrs === undefined ? "" : String(Math.round(Number(r.duration_hrs) * 60)),
      price: r.revenue_per_visit === null || r.revenue_per_visit === undefined ? "" : dollars(cents(r.revenue_per_visit)!),
      status: status === "paused" ? "paused" : "active",
      notes: notes.join(" "),
    });
    out({ table: "payroll_recurring_clients", id: str(r.id), outcome: "review", kind: "recurring", ref: customerRef, label, reason: "Customer staged; the recurring service needs its next visit and arrival time from the Owner before it can be planned." });
  }

  // Cleaners: one per person. The source's sync gives a payroll contractor and its directory entry the same id.
  const contractors = new Map(rows("payroll_contractors").map((r) => [str(r.id), r]));
  const directory = new Map(rows("subcontractors").map((r) => [str(r.id), r]));
  const ids = [...new Set([...contractors.keys(), ...directory.keys()])].sort();
  const cleanerRef = new Map<string, string>();
  for (const id of ids) {
    const pc = contractors.get(id);
    const sub = directory.get(id);
    const ref = pc ? ns("payroll_contractors", id) : ns("subcontractors", id);
    cleanerRef.set(id, ref);
    const name = str(pc?.name) || str(sub?.full_name);
    const email = realEmail(pc?.email) ?? realEmail(sub?.email);
    const phone = realPhone(pc?.phone) ?? realPhone(sub?.phone);
    if ((str(pc?.email) || str(sub?.email)) && !email) placeholderContacts += 1;
    if ((str(pc?.phone) || str(sub?.phone)) && !phone) placeholderContacts += 1;
    const active = (pc ? str(pc.status) !== "inactive" : true) && (sub ? str(sub.directory_status) !== "inactive" : true);
    const tier = str(pc?.pay_tier ?? sub?.pay_tier).toLowerCase();
    const contractorEvidence = tier && brackets.some((b) => b.tier === tier) ? rows("cleaner_pay_rates").map((b) => str(b.note)).find((n) => /1099/.test(n)) : undefined;
    const notes = [
      `Instant Shine references: ${[pc ? `payroll contractor ${id}` : "", sub ? `directory subcontractor ${id}` : ""].filter(Boolean).join(" and ")}.`,
      tier ? `Pay tier: ${tier}.` : "",
      contractorEvidence ? `Contractor, from Instant Shine's pay rate note ("${contractorEvidence}").` : "",
      sub?.jobber_user_id ? `Jobber user ${str(sub.jobber_user_id)}.` : "",
    ].filter(Boolean);
    const test = testEvidence(name, email) ?? (!pc && email && /@bayareacleaningpros\.com$/i.test(email) ? "it is only in the directory, with a company email address, so it may be a staff or test account" : null);
    if (test && !include.has(ref)) {
      heldBack.push({ ref, label: name || "Unnamed cleaner", why: `May not be a cleaner: ${test}.` });
      for (const [table, row] of [["payroll_contractors", pc], ["subcontractors", sub]] as const) if (row) out({ table, id, outcome: "excluded", ref, label: name, reason: `Held back: ${test}. The Owner can include it.` });
      continue;
    }
    const [first, ...rest] = name.split(/\s+/);
    stage("cleaners", ref, { externalId: ref, firstName: first, lastName: rest.join(" "), email, phone, engagement: contractorEvidence ? "contractor" : "", status: active ? "active" : "ended", notes: notes.join(" ") });
    if (pc) out({ table: "payroll_contractors", id, outcome: "staged", kind: "cleaners", ref, label: name, reason: contractorEvidence ? "Cleaner (contractor)." : "Cleaner; the Owner says whether they are an employee or contractor." });
    if (sub) out({ table: "subcontractors", id, outcome: pc ? "merged" : "staged", kind: "cleaners", ref, label: name, reason: pc ? "Same person as the payroll contractor with this id; imported once." : "Cleaner from the directory only." });
  }

  // Bookings: upcoming ones become held visits with their accepted crew; completed ones become history; past
  // ones never marked complete, cancellations and unpaid checkouts are kept for the Owner with their money.
  const assignments = rows("subcontractor_job_assignments");
  const finance: Adapted["finance"]["visits"] = [];
  for (const b of rows("bookings")) {
    const id = str(b.id);
    const ref = ns("bookings", id);
    const date = str(b.service_date).slice(0, 10);
    const status = str(b.status) || "pending";
    const paymentStatus = str(b.payment_status) || "pending";
    const offer = OFFER_OF[str(b.offer_type) || str(b.service_type)] ?? "standard";
    const label = `${SERVICE_NAME[offer]} on ${date}`;
    const total = cents(b.est_price);
    const raw = splitAddress(str(b.service_address));
    const postalCode = str(b.zip_code) || raw.postalCode;
    const address = { line1: raw.line1, city: raw.city, region: raw.region || regionFromZip(postalCode) || "", postalCode };
    const customerRef = b.customer_id ? ns("customers", b.customer_id) : "";
    const priced = checkStoredPrice(b);
    finance.push({ ref, label, date, totalCents: total, depositCents: cents(b.deposit_amount), balanceCents: cents(b.balance_due), refundedCents: Number(b.refunded_amount_cents ?? 0), paymentStatus, stripe: { paymentIntent: str(b.stripe_payment_intent_id) || null, balanceIntent: str(b.remaining_balance_intent_id) || null, customer: str(b.stripe_customer_id) || null, subscription: str(b.stripe_subscription_id) || null }, priceNotes: priced.notes });
    const window = slotMinutes(str(b.service_time));
    const estimated = b.estimated_duration === null || b.estimated_duration === undefined ? null : Number(b.estimated_duration);
    const minutes = estimated === null ? null : estimated >= 30 ? estimated : estimated * 60;
    const crew = assignments.filter((a) => str(a.booking_id) === id && ["assigned", "accepted", "completed"].includes(str(a.status)) && a.accepted_at);
    const base = { customerRef, customerName: str(b.customer_name), ...address, service: SERVICE_NAME[offer], price: total === null ? "" : dollars(total) };
    for (const a of assignments.filter((x) => str(x.booking_id) === id)) {
      const accepted = crew.includes(a);
      out({ table: "subcontractor_job_assignments", id: str(a.id), outcome: accepted && date >= options.today && !["cancelled", "completed"].includes(status) ? "staged" : "archived", kind: accepted ? "bookings" : undefined, ref, label, reason: accepted ? "Accepted crew member, with the pay share recorded on the assignment." : `An ${str(a.status) || "unanswered"} offer: not carried over, and no new offer is sent.` });
    }
    if (status === "cancelled" || status === "canceled") {
      out({ table: "bookings", id, outcome: "archived", ref, label, reason: `Cancelled${b.cancellation_reason ? ` (${str(b.cancellation_reason)})` : ""}. Kept with its refund and fee for reference.` });
      continue;
    }
    if (status === "completed" || b.completed_at) {
      propertyFor(customerRef, str(b.customer_name), address);
      stage("history", ref, { externalId: ref, ...base, date, status: "completed", notes: `From Instant Shine. Paid status: ${paymentStatus}.` });
      out({ table: "bookings", id, outcome: "staged", kind: "history", ref, label, reason: "Completed visit, kept as read-only history." });
      continue;
    }
    if (date < options.today) {
      out({ table: "bookings", id, outcome: "review", ref, label, reason: `The date has passed and Instant Shine never marked it completed (status ${status}, payment ${paymentStatus}). The Owner says whether it happened before it becomes history.` });
      continue;
    }
    const unpaidCheckout = str(b.booking_source) === "web" && status === "pending" && paymentStatus === "pending";
    if (unpaidCheckout) {
      out({ table: "bookings", id, outcome: "retained", ref, label, reason: "An online checkout that was never paid: not a confirmed visit. It stays in Instant Shine." });
      continue;
    }
    propertyFor(customerRef, str(b.customer_name), address);
    const crewField = crew.map((a) => [cleanerRef.get(str(a.subcontractor_id)) ?? "", str(a.share_cents), a.pay_locked_at ? "locked" : "provisional", str(a.accepted_at)].join("|")).filter((s) => !s.startsWith("|")).join(";");
    stage("bookings", ref, {
      externalId: ref,
      ...base,
      date,
      time: window ? hhmm(window.start) : "",
      durationMinutes: minutes === null ? "" : String(minutes),
      status: "scheduled",
      crew: crewField,
      notes: [str(b.special_instructions), window ? `Arrival window ${str(b.service_time)}.` : ""].filter(Boolean).join(" "),
    });
    out({ table: "bookings", id, outcome: "staged", kind: "bookings", ref, label, reason: crew.length ? `Upcoming visit with ${crew.length} accepted cleaner${crew.length === 1 ? "" : "s"}; held until the Owner releases the schedule.` : "Upcoming visit; held until the Owner releases the schedule." });
  }

  // Every other table: its catalog disposition, record by record.
  const handled = new Set(["business_calendar_settings", "service_areas", "payroll_settings", "cleaner_pay_rates", "promo_codes", "customers", "payroll_recurring_clients", "payroll_contractors", "subcontractors", "bookings", "subcontractor_job_assignments"]);
  for (const [table, list] of Object.entries(tables)) {
    if (handled.has(table)) continue;
    const entry = CATALOG_BY_TABLE.get(table);
    for (const r of list) {
      const id = str(r.id ?? r.phone_e164 ?? r.zip_code);
      if (table === "sms_opt_outs") {
        const phone = realPhone(r.phone_e164);
        out({ table, id, outcome: phone && optOutUsed.has(phone) ? "merged" : "review", reason: phone && optOutUsed.has(phone) ? "Applied to the matching customer as a text opt-out." : "No staged customer has this number: kept for review so the opt-out is not lost." });
        continue;
      }
      const outcome: Outcome = !entry ? "review" : entry.disposition === "archive" ? "archived" : entry.disposition === "retained" ? "retained" : entry.disposition === "excluded" ? "excluded" : "review";
      out({ table, id, outcome, reason: entry ? entry.why : "A table the catalog doesn't know: listed for review." });
    }
  }

  // Outstanding links, counted, never copied.
  const present = (table: string, column: string) => rows(table).filter((r) => r[`${column}__present`] === true || (typeof r[column] === "string" && str(r[column]) !== "")).length;
  const links = [
    { kind: "Customer manage-booking links", count: present("bookings", "manage_token"), what: "Keep working in Instant Shine until the visit moves; Selestial issues its own links after release." },
    { kind: "Payment links", count: present("bookings", "pay_page_token"), what: "Stay with Instant Shine, which keeps charging until payments move." },
    { kind: "Cleaner photo links", count: present("bookings", "photo_upload_token") + present("bookings", "photo_view_token"), what: "Stay with Instant Shine for its own visits." },
    { kind: "Cleaner offer and job links", count: present("subcontractor_job_assignments", "response_token"), what: "Not copied. Accepted work moves without a new offer; Selestial issues job links at release." },
    { kind: "Checklist links", count: present("job_checklists", "token"), what: "Not copied." },
  ];

  // Files.
  const ORDER: Kind[] = ["customers", "properties", "cleaners", "recurring", "bookings", "history"];
  const files: StagedFile[] = ORDER
    .filter((kind) => staged[kind].length)
    .map((kind) => ({ kind, name: FILE_NAMES[kind], header: HEADERS[kind], rows: staged[kind].map((s) => ({ sourceId: s.sourceId, cells: HEADERS[kind].map((key) => s.values[key] ?? "") })) }));

  // Reconciliation: every source row has exactly one outcome per table it came from.
  const reconciliation = Object.entries(tables)
    .map(([table, list]) => {
      const mine = records.filter((r) => r.table === table);
      const outcomes: Partial<Record<Outcome, number>> = {};
      for (const r of mine) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
      return { table, source: list.length, outcomes, balanced: mine.length === list.length };
    })
    .sort((a, b) => a.table.localeCompare(b.table));

  const totals = new Map<string, Adapted["finance"]["totals"][number]>();
  for (const v of finance) {
    const t = totals.get(v.paymentStatus) ?? { paymentStatus: v.paymentStatus, visits: 0, totalCents: 0, depositCents: 0, balanceCents: 0, refundedCents: 0 };
    t.visits += 1;
    t.totalCents += v.totalCents ?? 0;
    t.depositCents += v.depositCents ?? 0;
    t.balanceCents += v.balanceCents ?? 0;
    t.refundedCents += v.refundedCents;
    totals.set(v.paymentStatus, t);
  }

  return {
    instance,
    snapshotAt: snapshot.manifest?.startedAt ?? null,
    consistent: snapshot.manifest?.consistent ?? null,
    files,
    records,
    reconciliation,
    config,
    finance: { visits: finance, totals: [...totals.values()].sort((a, b) => a.paymentStatus.localeCompare(b.paymentStatus)) },
    links,
    flags: { placeholderContacts, sharedPhones: [...phoneCount.values()].filter((n) => n > 1).length, sharedEmails: [...emailCount.values()].filter((n) => n > 1).length, outOfArea, heldBack },
  };
}

export { CATALOG };
