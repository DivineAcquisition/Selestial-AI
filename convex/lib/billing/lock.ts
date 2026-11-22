/**
 * The rules for an unpaid Selestial plan (convex/billingLock.ts does the work):
 *
 *   1st failed attempt   the Owner is told, with the amount and when Stripe tries again. Nothing changes.
 *   2nd failed attempt   the account locks: the team can't open the workspace and every agent pauses.
 *                        Booking pages, quote and payment links, the cleaner portal and the records stay.
 *   23 days locked       the Owner is reminded that the plan is canceled in 7 days.
 *   30 days locked       the plan is canceled. The data stays; choosing a plan again brings everything back.
 *   paid (any time)      the lock lifts at once and the agents return to how the Owner left them.
 *
 * The attempt count is Stripe's own (`attempt_count` on the invoice in its signed event), so a retry
 * schedule changed in Stripe's dashboard changes nothing here: the lock follows the second real failure.
 */
const DAY = 86_400_000;

export const LOCK_AFTER_ATTEMPTS = 2;
export const CANCEL_AFTER_MS = 30 * DAY;
export const REMIND_BEFORE_CANCEL_MS = 7 * DAY;

/** The Stripe invoice events that matter here. */
export const DUNNING_EVENTS = ["invoice.payment_failed", "invoice.paid", "invoice.voided", "invoice.marked_uncollectible"] as const;
export type DunningEventType = (typeof DUNNING_EVENTS)[number];

export type InvoiceEvent = {
  eventId: string;
  type: DunningEventType;
  invoiceId: string;
  stripeCustomerId: string | null;
  /** Only invoices for a subscription count: a one-off purchase is paid on the spot, never retried. */
  subscription: boolean;
  attempts: number;
  amountCents: number;
  currency: string;
  hostedUrl: string | null;
  nextAttemptAt: number | null;
  failure: string | null;
  /** An Autumn customer id found on the invoice itself (`company_<id>`), when Autumn put one there. */
  customerHint: string | null;
  at: number;
};

const str = (value: unknown, max = 200): string | null => (typeof value === "string" && value.length > 0 ? value.slice(0, max) : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** Selestial's Autumn customer ids are `company_<convex id>` (lib/billing/access.ts customerIdFor). */
const CUSTOMER_ID = /^company_[a-z0-9]{10,64}$/;

/** Metadata keys Autumn is known to use for its own customer id. Read as hints only, then checked. */
const HINT_KEYS = ["autumn_customer_id", "autumn_id", "customer_id"];

function hintIn(metadata: unknown): string | null {
  const meta = obj(metadata);
  if (!meta) return null;
  for (const key of HINT_KEYS) {
    const value = str(meta[key]);
    if (value && CUSTOMER_ID.test(value)) return value;
  }
  return null;
}

/** An Autumn customer id anywhere Autumn might have put one on the invoice: its own metadata, the subscription's, or a line's. */
export function customerHintOf(invoice: Record<string, unknown>): string | null {
  const parent = obj(invoice.parent);
  const candidates: unknown[] = [invoice.metadata, obj(invoice.subscription_details)?.metadata, obj(parent?.subscription_details)?.metadata];
  const lines = obj(invoice.lines)?.data;
  if (Array.isArray(lines)) for (const line of lines.slice(0, 20)) candidates.push(obj(line)?.metadata);
  for (const metadata of candidates) {
    const hint = hintIn(metadata);
    if (hint) return hint;
  }
  return null;
}

/** The Autumn customer id on a Stripe customer's metadata, when Autumn put one there. */
export function customerHintOfCustomer(customer: unknown): string | null {
  return hintIn(obj(customer)?.metadata);
}

/**
 * A verified Stripe event body, read into the few facts used here. Anything that isn't an invoice event
 * this file handles, or lacks an id, is null and ignored.
 */
export function parseInvoiceEvent(body: string): InvoiceEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const event = obj(parsed);
  const type = str(event?.type);
  if (!event || !type || !(DUNNING_EVENTS as readonly string[]).includes(type)) return null;
  const eventId = str(event.id, 100);
  const invoice = obj(obj(event.data)?.object);
  const invoiceId = str(invoice?.id, 100);
  if (!eventId || !invoice || !invoiceId) return null;
  const parent = obj(invoice.parent);
  const subscription = Boolean(str(invoice.subscription) ?? obj(invoice.subscription) ?? str(obj(parent?.subscription_details)?.subscription) ?? (str(invoice.billing_reason)?.startsWith("subscription") ? "yes" : null));
  const customer = invoice.customer;
  const lastError = obj(obj(invoice.last_finalization_error) ?? obj(obj(invoice.payment_intent)?.last_payment_error));
  const nextAttempt = num(invoice.next_payment_attempt);
  const created = num(event.created);
  return {
    eventId,
    type: type as DunningEventType,
    invoiceId,
    stripeCustomerId: str(customer, 100) ?? str(obj(customer)?.id, 100),
    subscription,
    attempts: Math.max(0, Math.floor(num(invoice.attempt_count) ?? 0)),
    amountCents: Math.max(0, Math.round(num(invoice.amount_remaining) ?? num(invoice.amount_due) ?? 0)),
    currency: (str(invoice.currency, 10) ?? "usd").toLowerCase(),
    hostedUrl: str(invoice.hosted_invoice_url, 500),
    nextAttemptAt: nextAttempt ? nextAttempt * 1000 : null,
    failure: str(lastError?.message, 300),
    customerHint: customerHintOf(invoice),
    at: created ? created * 1000 : Date.now(),
  };
}

/** Whether this failure locks the account. */
export function locksAt(attempts: number): boolean {
  return attempts >= LOCK_AFTER_ATTEMPTS;
}

/** When a lock that began at `lockedAt` cancels the plan, and when the Owner is reminded before that. */
export function lockDeadlines(lockedAt: number): { remindAt: number; cancelAt: number } {
  const cancelAt = lockedAt + CANCEL_AFTER_MS;
  return { remindAt: cancelAt - REMIND_BEFORE_CANCEL_MS, cancelAt };
}

/** "$299.00", for screens and notices. */
export function moneyWords(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
