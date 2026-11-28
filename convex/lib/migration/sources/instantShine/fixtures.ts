/**
 * A de-identified Instant Shine snapshot for tests: invented names, 555 phone numbers and example
 * addresses, shaped like the real export (same tables, columns, units and quirks). It covers the pilot cases:
 * a one-time visit, a recurring client with a negotiated price, a customer with two properties, a confirmed
 * two-cleaner crew, a paid deposit with a balance due, a completed visit with locked and paid cleaner pay, a
 * cancellation with a refund, a signed agreement, a quality issue with photos, an opted-out customer, shared and
 * placeholder contact values, a Jobber-linked booking, a test record and an unpaid online checkout.
 *
 * Never put real customer data here.
 */
import type { Snapshot } from "./adapt";

export const INSTANCE = "testinstance";
/** The day the fixture's "today" is, in the business's time zone. */
export const TODAY = "2026-12-01";

const C1 = "00000000-0000-4000-8000-000000000001"; // Ana Rivera: two properties, opted out of texts
const C2 = "00000000-0000-4000-8000-000000000002"; // Ben Ortiz: shares a phone with C3
const C3 = "00000000-0000-4000-8000-000000000003"; // Cara Ortiz
const C4 = "00000000-0000-4000-8000-000000000004"; // a test record
const W1 = "00000000-0000-4000-8000-0000000000a1"; // Dee Lane: payroll contractor and directory entry
const W2 = "00000000-0000-4000-8000-0000000000a2"; // Eli Moss: placeholder email and phone from the sync
const W3 = "00000000-0000-4000-8000-0000000000a3"; // directory-only company address

export const FIXTURE: Snapshot = {
  manifest: { version: 1, source: { instance: INSTANCE }, startedAt: "2026-12-01T15:00:00.000Z", consistent: true, moved: [] },
  tables: {
    business_calendar_settings: [{ id: "cal", timezone: "America/Chicago", slot_templates: ["8:00 AM - 10:00 AM", "11:00 AM - 1:00 PM", "2:00 PM - 4:00 PM"], slot_capacity: 3, closed_weekdays: [0], lead_time_hours: 24, booking_horizon_days: 45 }],
    service_areas: [
      { zip_code: "77001", city: "Houston", state: "TX", active: true },
      { zip_code: "77520", city: "Baytown", state: "TX", active: true },
      { zip_code: "77002", city: "Houston", state: "TX", active: false },
    ],
    payroll_settings: [{ id: "ps", pay_cycle: "biweekly", period_start_date: "2026-04-20", default_hourly_rate: 18, mileage_rate: 0.7, payout_model: "percent_of_job" }],
    cleaner_pay_rates: [
      { id: "r1", min_crew_size: 1, max_crew_size: 1, pay_tier: "texas", rate_percent: 40, note: "Texas 1099 · solo · 40% of job value (crew pool of 1)" },
      { id: "r2", min_crew_size: 2, max_crew_size: null, pay_tier: "texas", rate_percent: 40, note: "Texas 1099 · crew of 2+ · 40% pool, split by crew size" },
    ],
    promo_codes: [{ id: "p1", code: "NEW_CUSTOMER_50", discount_type: "flat", discount_value: 5000, applies_to: "deep_clean", is_active: true }],
    customers: [
      { id: C1, first_name: "Ana", last_name: "Rivera", name: "Ana Rivera", email: "ana@rivera.invalid", phone: "(281) 555-0101", address_line1: "100 Elm St", city: "Houston", state: "TX", postal_code: "77001", stripe_customer_id: "cus_TEST1", ghl_contact_id: "ghl_TEST1" },
      { id: C2, first_name: "Ben", last_name: "Ortiz", name: "Ben Ortiz", email: "ben@ortiz.invalid", phone: "281-555-0102", address: "200 Oak Ave, Baytown, TX 77520" },
      { id: C3, first_name: "Cara", last_name: "Ortiz", name: "Cara Ortiz", email: "cara@ortiz.invalid", phone: "2815550102", address: "200 Oak Ave, Baytown, TX 77520" },
      { id: C4, first_name: "Test", last_name: "Booking", name: "Test Booking", email: "qa@example.com", phone: "0000000000", address: "1 Test Way, Los Angeles, CA 90001", state: "CA", postal_code: "90001" },
    ],
    payroll_recurring_clients: [
      { id: "00000000-0000-4000-8000-0000000000r1", name: "Fran Hale", email: "fran@hale.invalid", phone: "281-555-0110", address: "300 Pine Rd", zip_code: "77001", city: "Houston", frequency: "monthly", duration_hrs: 3, revenue_per_visit: 180, status: "active", service_day_of_week: 3, start_date: "2026-04-24", end_date: null },
      { id: "00000000-0000-4000-8000-0000000000r2", name: "Gus Park", email: "", phone: "281-555-0111", address: "400 Cedar Ln", zip_code: "77520", city: "Baytown", frequency: "biweekly", duration_hrs: 2.5, revenue_per_visit: 150, status: "paused", service_day_of_week: null, start_date: "2026-04-24", end_date: null },
      { id: "00000000-0000-4000-8000-0000000000r3", name: "Hal Ward", email: "hal@ward.invalid", phone: "281-555-0112", address: "500 Birch Ct", zip_code: "77099", city: "Houston", frequency: "custom", duration_hrs: 3, revenue_per_visit: 210, status: "active", service_day_of_week: 1, start_date: "2026-04-24", end_date: null },
      { id: "00000000-0000-4000-8000-0000000000r4", name: "Ida Fox", email: "ida@fox.invalid", phone: "281-555-0113", address: "600 Maple Dr", zip_code: "77001", city: "Houston", frequency: "weekly", duration_hrs: 3, revenue_per_visit: 155, status: "ended", service_day_of_week: 5, start_date: "2026-04-24", end_date: "2026-09-01" },
    ],
    payroll_contractors: [
      { id: W1, name: "Dee Lane", email: "dee@lane.invalid", phone: "281-555-0120", hourly_rate: 18, status: "active", pay_tier: "texas" },
      { id: W2, name: "Eli Moss", email: "", phone: "", hourly_rate: 18, status: "active", pay_tier: "texas" },
    ],
    subcontractors: [
      { id: W1, full_name: "Dee Lane", email: "dee@lane.invalid", phone: "281-555-0120", directory_status: "active", pay_tier: "texas", subscription_status: "active" },
      { id: W2, full_name: "Eli Moss", email: `${W2}@bayareacleaningpros.com`, phone: "0000000000", directory_status: "active", pay_tier: "texas", subscription_status: "active" },
      { id: W3, full_name: "Office Owner", email: "owner@bayareacleaningpros.com", phone: "281-555-0199", directory_status: "active", pay_tier: "texas", subscription_status: "active" },
    ],
    bookings: [
      // Upcoming one-time deep clean at Ana's second property: deposit paid, balance due, two-cleaner crew, Jobber-linked.
      { id: "b1", customer_id: C1, customer_name: "Ana Rivera", customer_email: "ana@rivera.invalid", service_address: "110 Elm St, Houston, TX 77001", zip_code: "77001", service_date: "2026-12-10", service_time: "8:00 AM - 10:00 AM", estimated_duration: 240, status: "assigned", payment_status: "deposit_paid", service_type: "deep", offer_type: "deep_clean", frequency: "one_time", est_price: 262.04, base_price: 327.55, deposit_amount: 131.02, balance_due: 131.02, promo_code: "WELCOME2025", promo_discount_cents: 6551, pricing_breakdown: { version: 2, listPriceCents: 32755, discountCents: 6551, totalCents: 26204, depositCents: 13102 }, stripe_payment_intent_id: "pi_TEST1", stripe_customer_id: "cus_TEST1", booking_source: "internal", jobber_job_id: "jobber_TEST1", manage_token__present: true, pay_page_token__present: true },
      // Completed standard clean at Ana's first property, paid in full, cleaner pay locked and extra paid.
      { id: "b2", customer_id: C1, customer_name: "Ana Rivera", service_address: "100 Elm St, Houston, TX 77001", zip_code: "77001", service_date: "2026-11-02", service_time: "11:00 AM - 1:00 PM", estimated_duration: 2, status: "completed", completed_at: "2026-11-02T19:00:00Z", payment_status: "paid", service_type: "regular", offer_type: "standard", est_price: 202.78, base_price: 225.31, deposit_amount: 101.39, balance_due: 0, stripe_payment_intent_id: "pi_TEST2", remaining_balance_intent_id: "pi_TEST2B", booking_source: "web" },
      // Cancelled with a partial refund and a late fee.
      { id: "b3", customer_id: C2, customer_name: "Ben Ortiz", service_address: "200 Oak Ave, Baytown, TX 77520", zip_code: "77520", service_date: "2026-11-20", service_time: "2:00 PM - 4:00 PM", status: "cancelled", cancellation_reason: "customer request", cancellation_fee_cents: 2500, refunded_amount_cents: 7639, payment_status: "partially_refunded", offer_type: "standard", est_price: 202.78, deposit_amount: 101.39, balance_due: 101.39, stripe_payment_intent_id: "pi_TEST3", booking_source: "web" },
      // Past, never marked completed.
      { id: "b4", customer_id: C3, customer_name: "Cara Ortiz", service_address: "200 Oak Ave, Baytown, TX 77520", zip_code: "77520", service_date: "2026-11-25", service_time: "8:00 AM - 10:00 AM", status: "confirmed", payment_status: "deposit_paid", offer_type: "deep_clean", est_price: 230.87, deposit_amount: 58, balance_due: 172.87, booking_source: "web" },
      // An online checkout that was never paid.
      { id: "b5", customer_id: C2, customer_name: "Ben Ortiz", service_address: "200 Oak Ave, Baytown, TX 77520", zip_code: "77520", service_date: "2026-12-15", service_time: "11:00 AM - 1:00 PM", status: "pending", payment_status: "pending", offer_type: "standard", est_price: 202.78, deposit_amount: 101.39, balance_due: 101.39, stripe_payment_intent_id: "pi_TEST5", booking_source: "web" },
    ],
    subcontractor_job_assignments: [
      { id: "a1", subcontractor_id: W1, booking_id: "b1", status: "accepted", accepted_at: "2026-11-28T15:00:00Z", crew_size_snapshot: 2, pay_rate_percent: 40, share_cents: 5240, pay_locked_at: null, response_token__present: true },
      { id: "a2", subcontractor_id: W2, booking_id: "b1", status: "assigned", accepted_at: "2026-11-28T16:00:00Z", crew_size_snapshot: 2, pay_rate_percent: 40, share_cents: 5240, pay_locked_at: null },
      { id: "a3", subcontractor_id: W1, booking_id: "b2", status: "completed", accepted_at: "2026-10-30T15:00:00Z", completed_at: "2026-11-02T19:00:00Z", crew_size_snapshot: 1, pay_rate_percent: 40, share_cents: 8111, pay_locked_at: "2026-11-02T19:00:00Z" },
      { id: "a4", subcontractor_id: W2, booking_id: "b5", status: "offered", accepted_at: null },
    ],
    cleaner_extra_pay: [{ id: "x1", contractor_id: W1, booking_id: "b2", kind: "mileage", amount_cents: 1400, status: "paid", paid_at: "2026-11-07T12:00:00Z" }],
    sms_opt_outs: [{ phone_e164: "+12815550101", source: "inbound_stop", lifted_at: null }],
    service_agreements: [{ id: "sa1", booking_id: "b2", customer_name: "Ana Rivera", signed_by: "Ana Rivera", source: "pay_page", pdf_path: "b2/sa1.pdf", ip: "203.0.113.5" }],
    qc_issues: [{ id: "q1", booking_id: "b2", issue_type: "reclean", severity: "medium", status: "resolved", credit_cents: 0 }],
    job_documentation: [{ id: "d1", booking_id: "b2", before_photos: ["b2/before-1.jpg"], after_photos: ["b2/after-1.jpg"] }],
    partial_bookings: [{ id: "pb1", email: "lead@lead.invalid", zip_code: "77001", service_type: "deep", last_step: "contact" }],
    email_logs: [{ id: "e1", booking_id: "b2", kind: "visit_reminder", status: "failed" }],
    email_retry_queue: [{ id: "q-1", booking_id: "b2", kind: "visit_reminder", attempts: 3, completed_at: null }],
    job_checklists: [{ id: "jc1", booking_id: "b1", token__present: true, total_items: 32, completed_items: 0 }],
    user_roles: [{ id: "ur1", role: "super_admin" }],
  },
};
