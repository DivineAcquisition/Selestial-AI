/**
 * Every Instant Shine table, with where it goes and why. Pure. Shared by the adapter (per-record outcomes),
 * the review summary and the engineering report, and checked against the exporter's list in a test so a
 * table can't be dropped silently.
 *
 * Dispositions:
 *  A native      moved into Selestial's own records (held until the Owner releases each workflow)
 *  B extension   needs an importer or product extension; what is missing is said in `why`
 *  C archive     kept as read-only history or in the export archive
 *  D retained    stays in Instant Shine or its provider until a transition is ready
 *  E excluded    not moved, with the specific reason
 */
export type Disposition = "native" | "extension" | "archive" | "retained" | "excluded";
export type Family = "company" | "customers" | "pricing" | "operations" | "people" | "quality" | "agreements" | "communications" | "finance" | "integrations" | "platform";

export type TableEntry = { table: string; family: Family; disposition: Disposition; destination: string; why: string };

export const FAMILY_WORDS: Record<Family, string> = {
  company: "Company settings",
  customers: "Customers and properties",
  pricing: "Services and pricing",
  operations: "Schedule and work",
  people: "Cleaners and staff",
  quality: "Quality",
  agreements: "Agreements and files",
  communications: "Messages",
  finance: "Payments and pay",
  integrations: "Connected systems",
  platform: "Instant Shine's own records",
};

export const DISPOSITION_WORDS: Record<Disposition, string> = {
  native: "Moved into Selestial",
  extension: "Needs an importer extension",
  archive: "Kept as history",
  retained: "Stays in Instant Shine for now",
  excluded: "Not moved",
};

const t = (table: string, family: Family, disposition: Disposition, destination: string, why: string): TableEntry => ({ table, family, disposition, destination, why });

export const CATALOG: readonly TableEntry[] = [
  // Company settings
  t("business_calendar_settings", "company", "native", "Company profile: time zone and booking hours", "Time zone (America/Chicago), closed weekdays and arrival windows become the company's booking hours, applied by the Owner."),
  t("service_areas", "company", "native", "Company profile: ZIP codes served", "Active ZIP codes become the booking area, applied by the Owner."),
  t("availability_schedule", "company", "archive", "Export archive", "Per-day slot counters derived from the calendar settings and bookings; Selestial works capacity out from the schedule itself."),
  t("payroll_settings", "people", "native", "Team pay settings", "Pay cycle and percent-of-job model inform the crew pay rule the Owner confirms."),
  t("cleaner_pay_rates", "people", "native", "Team pay: 40% share, split by crew", "One rate for every crew size maps exactly to a 40% share split by crew size."),
  t("job_checklists", "quality", "archive", "Export archive", "Per-visit checklist progress; Selestial's job standards are drafted separately."),
  // Customers
  t("customers", "customers", "native", "Clients", "Each customer with contact details and address. Placeholder or shared contact values are not used as messaging destinations."),
  t("payroll_recurring_clients", "customers", "native", "Clients, properties and recurring services (in review)", "Recurring customers with per-visit price and cadence. They have no next-visit date or arrival time in Instant Shine, so each recurring service waits in review for those before it can be planned."),
  t("partial_bookings", "customers", "retained", "Stays in Instant Shine", "Abandoned online checkouts. Not imported, so Sales doesn't follow up on stale leads; listed for the Owner."),
  t("commercial_estimates", "customers", "native", "Sales inquiries (when present)", "Commercial estimate requests; none at export time."),
  t("va_quotes", "pricing", "archive", "Export archive", "Internal Booking quotes with 48-hour price locks; none at export time. A converted quote's price lives on its booking."),
  // Pricing
  t("promo_codes", "pricing", "extension", "Owner decision: promotion", "Selestial applies only promotions the Owner approves; NEW_CUSTOMER_50 ($50 off deep cleans) is listed for that decision."),
  t("promo_redemptions", "pricing", "archive", "Export archive", "Legacy redemptions tied to the old orders table; none at export time."),
  t("referral_codes", "pricing", "archive", "Export archive", "Legacy referral codes; none at export time. The live funnel never checks them."),
  t("referral_uses", "pricing", "archive", "Export archive", "Legacy referral uses; none at export time."),
  // Operations
  t("bookings", "operations", "native", "Upcoming visits (held), history, or review", "Future scheduled visits become held visits with their accepted totals; completed visits become history; past visits never marked complete wait for the Owner to say what happened."),
  t("booking_events", "operations", "archive", "Export archive", "The source's event log. Never replayed as new activity."),
  t("booking_notes", "operations", "native", "Visit notes (when present)", "None at export time."),
  t("orders", "operations", "excluded", "Not moved", "Legacy checkout table the current booking flow never writes; none at export time."),
  t("order_status_updates", "operations", "excluded", "Not moved", "Belongs to the legacy orders table; none at export time."),
  t("order_tips", "finance", "excluded", "Not moved", "Belongs to the legacy orders table; none at export time."),
  t("service_modifications", "operations", "archive", "Export archive", "None at export time."),
  t("payroll_recurring_assignments", "people", "native", "Preferred cleaners on recurring services", "Primary, secondary and backup cleaners per recurring client; none at export time."),
  t("payroll_jobs", "operations", "archive", "History (when present)", "Payroll's own job log, separate from bookings; none at export time. Matched to bookings only by an explicit source_booking_id, never by name."),
  t("payroll_job_assignments", "people", "archive", "History with pay snapshot (when present)", "None at export time."),
  t("job_tracking", "operations", "archive", "Export archive", "Check-in and check-out records; none at export time."),
  t("job_field_notes", "operations", "archive", "Export archive", "None at export time."),
  t("job_documentation", "quality", "extension", "Job photos (files)", "Photo records; none at export time, and the job-photos bucket is empty. Copying files needs the binary import path."),
  // People
  t("subcontractors", "people", "native", "Cleaners (onboarding, held)", "The cleaner directory. Same person as the payroll contractor with the same id: imported once with both references."),
  t("payroll_contractors", "people", "native", "Cleaners (merged)", "Synced into subcontractors by a database trigger using the same id, so each is merged with its directory entry."),
  t("subcontractor_job_assignments", "people", "native", "Accepted crew on upcoming visits, or history", "An accepted assignment on an upcoming visit transfers as accepted, with its pay snapshot and no new offer; on a past visit it is kept with the visit's review."),
  t("subcontractor_applications", "people", "native", "Applicants (when present)", "None at export time."),
  t("subcontractor_restrictions", "people", "archive", "Export archive", "None at export time."),
  t("subcontractor_job_drops", "people", "archive", "Export archive", "None at export time."),
  t("cleaner_extra_pay", "finance", "archive", "Pay history (when present)", "Mileage, supplies and other extras with paid status; none at export time."),
  t("performance_metrics", "people", "archive", "Export archive", "None at export time."),
  t("profiles", "platform", "excluded", "Not moved", "Sign-in profiles. Staff are invited to Selestial by the Owner; nobody's account or password moves."),
  t("user_roles", "platform", "excluded", "Not moved", "Sign-in roles, including Divine Acquisition's own admin accounts, which never become members of the cleaning company."),
  // Quality and agreements
  t("customer_feedback", "quality", "native", "Quality feedback (when present)", "None at export time."),
  t("qc_issues", "quality", "native", "Quality cases (when present)", "None at export time."),
  t("qc_issue_events", "quality", "archive", "Case history (when present)", "None at export time."),
  t("incidents", "quality", "native", "Quality cases (when present)", "None at export time."),
  t("service_agreements", "agreements", "extension", "Agreements with the signed PDF (when present)", "None at export time and the service-agreements bucket is empty. Signed PDFs would come over as externally signed documents, never re-sent."),
  t("contracts", "platform", "excluded", "Not moved", "Divine Acquisition's own revenue-share contract model, not the cleaning company's business. None at export time."),
  t("companies", "platform", "excluded", "Not moved", "Instant Shine's unused tenant registry. None at export time."),
  // Communications
  t("email_logs", "communications", "archive", "Export archive", "Delivery log. All but one were failed reminders; no customer conversation exists to import. Never replayed."),
  t("sms_logs", "communications", "archive", "Export archive", "Delivery log; all failed reminders. Never replayed."),
  t("messages", "communications", "archive", "Export archive", "None at export time."),
  t("sms_opt_outs", "communications", "native", "Text opt-outs on the matching customer", "Applied before any messaging is switched on; none at export time."),
  t("sms_intents", "communications", "excluded", "Not moved", "Pending cancel or reschedule confirmations by text; none at export time, and they can't be answered after the move."),
  t("email_retry_queue", "communications", "excluded", "Not moved", "A send queue, never history. Nothing pending at export time; moving it would send old messages."),
  // Integrations
  t("ghl_integration_config", "integrations", "retained", "Stays in Instant Shine", "HighLevel location settings. Bookings confirmations and balance reminders are switched on there; see the workflow plan."),
  t("ghl_sync_log", "integrations", "archive", "Export archive", "HighLevel sync attempts with their ids, kept as references."),
  t("jobber_integration_config", "integrations", "retained", "Stays in Instant Shine", "Jobber is disconnected and was never connected (no credentials)."),
  t("jobber_lead_links", "integrations", "archive", "Export archive", "None at export time."),
  t("jobber_sync_log", "integrations", "archive", "Export archive", "None at export time."),
  t("jobber_sync_queue", "integrations", "excluded", "Not moved", "An outbox, not history; empty."),
  t("jobber_webhook_events", "integrations", "archive", "Export archive", "None at export time."),
  t("busy_slots", "integrations", "excluded", "Not moved", "Google Calendar busy times, recomputed by whichever system owns the calendar; none at export time."),
  // Never read (see the exporter's SKIPPED)
  t("ghl_private_credentials", "integrations", "excluded", "Never read", "Provider credentials are never copied."),
  t("jobber_credentials", "integrations", "excluded", "Never read", "Provider tokens are never copied."),
  t("jobber_oauth_states", "integrations", "excluded", "Never read", "OAuth handshake state."),
  t("user_calendar_tokens", "integrations", "excluded", "Never read", "Google OAuth tokens are never copied."),
  t("interview_tokens", "people", "excluded", "Never read", "Reusable applicant links; none created by current code."),
  t("subcontractor_onboarding_tokens", "people", "excluded", "Never read", "Reusable onboarding links; none created by current code."),
  t("auth_redirects", "platform", "excluded", "Never read", "Sign-in redirect state."),
  t("security_logs", "platform", "excluded", "Never read", "The source application's own security log."),
  t("interview_slots", "people", "excluded", "Never read", "No rows and no Selestial equivalent."),
];

export const CATALOG_BY_TABLE: ReadonlyMap<string, TableEntry> = new Map(CATALOG.map((entry) => [entry.table, entry]));
