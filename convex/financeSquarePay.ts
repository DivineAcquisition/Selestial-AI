/**
 * Finance's Square payments: a hosted Square checkout for one payment attempt, reading the outcome back
 * from Square, closing checkouts that are no longer needed, refunds, webhooks and reconciliation
 * (docs/finance/square.md). The same rules as Stripe (convex/financeStripe.ts):
 *
 *  - One request key per record, on every try. An unclear answer marks the record "checking" and the same
 *    request is asked again or the object is looked up. A new key is never used, so an unclear answer can
 *    never become a second checkout, charge or refund.
 *  - A webhook only says which object changed. The object is read back from Square with the company's own
 *    token, so an event arriving late, twice or out of order can never move a record backwards.
 *  - A redirect back from Square proves nothing. Only Square's own record of the payment does.
 *  - An event for a Square account no company has connected is noted for Selestial's team, never guessed.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { addRefundCredit } from "./finance";
import { connectionBinding, squareAccess } from "./financeSquare";
import { paymentSettled } from "./financeStripe";
import { recordEvent, type Actor } from "./lib/events";
import { recompute } from "./lib/finance/ledger";
import {
  authLost,
  createPaymentLink,
  deletePaymentLink,
  getPayment,
  getRefund,
  linkMarker,
  listPaymentLinks,
  orderOutcome,
  refundFacts,
  refundPayment,
  retrieveOrder,
  revokeToken,
  squareConfig,
  tenderPaymentIds,
  type RawPayment,
  type SquareEvent,
} from "./lib/finance/square";
import { unseal } from "./lib/recruiter/secrets";

const SYSTEM: Actor = { kind: "system" };
const MINUTE = 60_000;
/** Square replays a request for the same idempotency key for a while; past this, Selestial looks the object up instead. */
const REPLAY_WINDOW = 23 * 60 * MINUTE;
const BACKOFF = [30_000, 2 * MINUTE, 10 * MINUTE, 30 * MINUTE];

// ── Checkout ─────────────────────────────────────────────────────────────────────────────────────

export const paymentFor = internalQuery({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args) => {
    const payment = await ctx.db.get(args.paymentId);
    if (!payment?.square) return null;
    const invoice = (await ctx.db.get(payment.invoiceId))!;
    const customer = await ctx.db.get(payment.customerId);
    const company = (await ctx.db.get(payment.companyId))!;
    return { payment, square: payment.square, invoice, customerEmail: customer?.email ?? null, companyName: company.name };
  },
});

/** Asks Square for the hosted checkout the customer started. Every try uses the payment's own key. */
export const createLink = internalAction({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args) => {
    const found = await ctx.runQuery(internal.financeSquarePay.paymentFor, args);
    if (!found || found.square.linkId) return;
    const { payment, square, invoice } = found;
    if (payment.status === "canceled" || payment.status === "succeeded") return;
    const access = await squareAccess(ctx, square.connectionId);
    if (access.kind === "lost") {
      await ctx.runMutation(internal.financeSquarePay.linkRefused, { paymentId: payment._id, problem: "This business's Square connection needs to be reconnected. Nothing was charged." });
      return;
    }
    if (access.kind !== "ok") {
      await ctx.runMutation(internal.financeSquarePay.linkUnclear, args);
      return;
    }
    if (Date.now() - payment.createdAt > REPLAY_WINDOW) {
      // Too late to replay the first answer: look for the link instead of making another.
      const link = await findLink(access.config, access.token, payment._id);
      if (link === "unknown") return;
      if (link) await ctx.runMutation(internal.financeSquarePay.linkCreated, { paymentId: payment._id, linkId: link.id, orderId: link.orderId, url: link.url });
      else await ctx.runMutation(internal.financeSquarePay.linkRefused, { paymentId: payment._id, problem: "Square has no record of this checkout, so nothing was charged. The customer can try again." });
      return;
    }
    await ctx.runMutation(internal.financeSquarePay.noteTry, args);
    const answer = await createPaymentLink(access.config, access.token, {
      paymentId: payment._id,
      locationId: square.locationId,
      amountCents: payment.amountCents,
      tipCents: payment.tipCents ?? 0,
      title: `${invoice.number ?? "Invoice"} · ${found.companyName}`,
      redirectUrl: square.returnUrl,
      buyerEmail: found.customerEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(found.customerEmail) ? found.customerEmail : undefined,
    });
    const link = answer.kind === "ok" ? answer.data.payment_link : undefined;
    if (link?.id && link.order_id && link.url?.startsWith("https://")) {
      await ctx.runMutation(internal.financeSquarePay.linkCreated, { paymentId: payment._id, linkId: link.id, orderId: link.order_id, url: link.url });
    } else if (answer.kind === "refused") {
      if (authLost(answer)) await ctx.runMutation(internal.financeSquarePay.authorizationLost, { connectionId: square.connectionId, reason: "Square stopped accepting Selestial's access to this account." });
      const location = /LOCATION|location/.test(`${answer.code} ${answer.message}`);
      if (location) await ctx.runMutation(internal.financeSquarePay.locationFailed, { connectionId: square.connectionId, locationId: square.locationId });
      await ctx.runMutation(internal.financeSquarePay.linkRefused, { paymentId: payment._id, problem: location ? "Square says this business's location can't take this payment. Nothing was charged." : "Square couldn't start the payment. Nothing was charged." });
    } else {
      await ctx.runMutation(internal.financeSquarePay.linkUnclear, args);
    }
  },
});

/** Finds the link Selestial made for a payment by its marker, across the business's recent links. "unknown" when Square didn't answer. */
async function findLink(config: NonNullable<ReturnType<typeof squareConfig>>, token: string, paymentId: string): Promise<{ id: string; orderId: string; url: string } | null | "unknown"> {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const answer = await listPaymentLinks(config, token, cursor);
    if (answer.kind !== "ok") return "unknown";
    const match = (answer.data.payment_links ?? []).find((link) => link.description === linkMarker(paymentId));
    if (match?.id && match.order_id && match.url) return { id: match.id, orderId: match.order_id, url: match.url };
    cursor = answer.data.cursor;
    if (!cursor) return null;
  }
  return "unknown";
}

export const noteTry = internalMutation({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args) => {
    const payment = (await ctx.db.get(args.paymentId))!;
    if (payment.square) await ctx.db.patch(payment._id, { square: { ...payment.square, createTries: payment.square.createTries + 1 }, checkedAt: Date.now() });
  },
});

export const linkCreated = internalMutation({
  args: { paymentId: v.id("payments"), linkId: v.string(), orderId: v.string(), url: v.string() },
  handler: async (ctx, args) => {
    const payment = (await ctx.db.get(args.paymentId))!;
    if (!payment.square || (payment.square.linkId && payment.square.linkId !== args.linkId)) return;
    const canceledMeanwhile = payment.status === "canceled";
    await ctx.db.patch(payment._id, {
      status: payment.status === "checking" ? "awaiting_customer" : payment.status,
      problem: payment.status === "checking" ? undefined : payment.problem,
      square: { ...payment.square, linkId: args.linkId.slice(0, 100), orderId: args.orderId.slice(0, 100), checkoutUrl: canceledMeanwhile ? undefined : args.url.slice(0, 500) },
      updatedAt: Date.now(),
    });
    // The invoice was settled (or a newer attempt started) while Square was answering: close it before anyone can pay it.
    if (canceledMeanwhile) await ctx.scheduler.runAfter(0, internal.financeSquarePay.closeLink, { paymentId: payment._id });
  },
});

export const linkRefused = internalMutation({
  args: { paymentId: v.id("payments"), problem: v.string() },
  handler: async (ctx, args) => {
    const payment = (await ctx.db.get(args.paymentId))!;
    if (payment.status === "succeeded" || payment.status === "processing" || payment.square?.linkId) return;
    await ctx.db.patch(payment._id, { status: "failed", problem: args.problem, updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: payment.companyId, type: "payment.failed", actor: SYSTEM, subject: { table: "payments", id: payment._id }, data: { amountCents: payment.amountCents, provider: "square" } });
  },
});

/** Square's answer to "create" was lost. Checking, then the same request again with the same key. */
export const linkUnclear = internalMutation({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args) => {
    const payment = (await ctx.db.get(args.paymentId))!;
    if (!payment.square || payment.square.linkId || payment.status === "canceled") return;
    const first = payment.status !== "checking";
    await ctx.db.patch(payment._id, { status: "checking", problem: "Square didn't answer clearly. Selestial is checking before anything is tried again.", updatedAt: Date.now() });
    if (first) await recordEvent(ctx, { companyId: payment.companyId, type: "payment.checking", actor: SYSTEM, subject: { table: "payments", id: payment._id }, data: { amountCents: payment.amountCents, provider: "square" } });
    const wait = BACKOFF[Math.min(Math.max(payment.square.createTries - 1, 0), BACKOFF.length - 1)];
    await ctx.scheduler.runAfter(wait, internal.financeSquarePay.createLink, args);
  },
});

/** The chosen location stopped taking payments: new payments wait until the Owner chooses again. */
export const locationFailed = internalMutation({
  args: { connectionId: v.id("squareConnections"), locationId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (!row || row.location?.id !== args.locationId || row.status !== "ready") return;
    await ctx.db.patch(row._id, { status: "needs_location", location: undefined, locationProblem: `Square refused a payment at ${row.location.name}. Choose a location for payments again.`, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.financeSquare.syncLocations, { connectionId: row._id });
  },
});

// ── Reading payments back ────────────────────────────────────────────────────────────────────────

/** Reads one attempt's order and its payments from Square, and writes what Square says. */
export const syncPayment = internalAction({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args) => {
    const found = await ctx.runQuery(internal.financeSquarePay.paymentFor, args);
    if (!found) return;
    const { square } = found;
    if (!square.orderId) {
      if (found.payment.status === "checking") await ctx.runAction(internal.financeSquarePay.createLink, args);
      return;
    }
    const access = await squareAccess(ctx, square.connectionId);
    if (access.kind !== "ok") {
      await ctx.runMutation(internal.financeSquarePay.noteChecked, args);
      return;
    }
    const order = await retrieveOrder(access.config, access.token, square.orderId);
    if (order.kind !== "ok") {
      if (authLost(order)) await ctx.runMutation(internal.financeSquarePay.authorizationLost, { connectionId: square.connectionId, reason: "Square stopped accepting Selestial's access to this account." });
      await ctx.runMutation(internal.financeSquarePay.noteChecked, args);
      return;
    }
    const raw = order.data.order ?? null;
    // Only this attempt's own order counts, at the location it was made for.
    if (raw && (raw.id !== square.orderId || (raw.location_id && raw.location_id !== square.locationId))) return;
    const ids = new Set(tenderPaymentIds(raw));
    if (square.paymentId) ids.add(square.paymentId);
    const payments: RawPayment[] = [];
    for (const id of [...ids].slice(0, 10)) {
      const answer = await getPayment(access.config, access.token, id);
      if (answer.kind === "ok" && answer.data.payment && answer.data.payment.order_id === square.orderId) payments.push(answer.data.payment);
      else if (answer.kind !== "ok") {
        // A payment Square named that couldn't be read now: nothing is concluded until it can.
        await ctx.runMutation(internal.financeSquarePay.noteChecked, args);
        return;
      }
    }
    await ctx.runMutation(internal.financeSquarePay.paymentRead, { paymentId: args.paymentId, facts: orderOutcome(raw, payments) });
  },
});

export const noteChecked = internalMutation({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.paymentId, { checkedAt: Date.now() });
  },
});

const factsValidator = v.object({
  status: v.union(v.literal("awaiting_customer"), v.literal("processing"), v.literal("succeeded"), v.literal("failed"), v.literal("canceled")),
  squarePaymentId: v.union(v.string(), v.null()),
  receivedCents: v.union(v.number(), v.null()),
  feeCents: v.union(v.number(), v.null()),
  receiptUrl: v.union(v.string(), v.null()),
  methodLabel: v.union(v.string(), v.null()),
  problem: v.union(v.string(), v.null()),
  extraPaymentIds: v.array(v.string()),
});

export const paymentRead = internalMutation({
  args: { paymentId: v.id("payments"), facts: factsValidator },
  handler: async (ctx, args) => applySquarePayment(ctx, args.paymentId, args.facts),
});

const EVENT_FOR: Partial<Record<Doc<"payments">["status"], string>> = { processing: "payment.processing", succeeded: "payment.succeeded", failed: "payment.failed", canceled: "payment.canceled" };

/**
 * Writes what Square says about one attempt. Square's current answer is the truth, with one rule: money
 * received is never moved back by a late answer (only refunds change it). A payment on a checkout
 * Selestial had closed still counts: the money arrived, and the invoice shows any overpayment for the
 * Owner to refund.
 */
async function applySquarePayment(ctx: MutationCtx, paymentId: Id<"payments">, facts: typeof factsValidator.type) {
  const payment = (await ctx.db.get(paymentId))!;
  if (!payment.square) return;
  const now = Date.now();
  const status = payment.status === "succeeded" ? "succeeded" : facts.status;
  const expected = payment.amountCents + (payment.tipCents ?? 0);
  const firstReceipt = status === "succeeded" && payment.status !== "succeeded";
  // What reached the invoice is what Square received less the tip, which is the crew's.
  const received = firstReceipt && facts.receivedCents !== null ? Math.max(0, facts.receivedCents - (payment.tipCents ?? 0)) : payment.amountCents;
  const mismatch = firstReceipt && facts.receivedCents !== null && facts.receivedCents !== expected;
  const settled = status !== "awaiting_customer";
  await ctx.db.patch(payment._id, {
    status,
    amountCents: received,
    problem: mismatch
      ? `Square received $${((facts.receivedCents ?? 0) / 100).toFixed(2)}, not the $${(expected / 100).toFixed(2)} asked for. Check this payment in Square.`
      : status === "failed" || status === "awaiting_customer"
        ? (facts.problem ?? undefined)
        : status === "succeeded" && facts.extraPaymentIds.length
          ? "Square shows more than one payment on this checkout. Check it in Square; only one is counted here."
          : undefined,
    square: {
      ...payment.square,
      paymentId: payment.square.paymentId ?? facts.squarePaymentId ?? undefined,
      receiptUrl: facts.receiptUrl ?? payment.square.receiptUrl,
      feeCents: facts.feeCents ?? payment.square.feeCents,
      methodLabel: facts.methodLabel ?? payment.square.methodLabel,
      checkoutUrl: settled ? undefined : payment.square.checkoutUrl,
      extraPaymentIds: facts.extraPaymentIds.length ? facts.extraPaymentIds.slice(0, 10) : payment.square.extraPaymentIds,
    },
    succeededAt: status === "succeeded" ? (payment.succeededAt ?? now) : payment.succeededAt,
    checkedAt: now,
    updatedAt: now,
  });
  if (status !== payment.status && EVENT_FOR[status]) {
    await recordEvent(ctx, { companyId: payment.companyId, type: EVENT_FOR[status]!, actor: SYSTEM, subject: { table: "payments", id: payment._id }, data: { amountCents: received, provider: "square" } });
  }
  await paymentSettled(ctx, payment, status);
}

/**
 * Closes a checkout nobody should pay any more (the invoice was paid another way, voided, or a newer
 * attempt replaced it). Deleting the link cancels its order at Square; then the order is read back, so a
 * payment that slipped through first is still recorded.
 */
export const closeLink = internalAction({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args) => {
    const found = await ctx.runQuery(internal.financeSquarePay.paymentFor, args);
    if (!found) return;
    if (!found.square.linkId) {
      await ctx.runMutation(internal.financeSquarePay.markCanceled, args);
      return;
    }
    const access = await squareAccess(ctx, found.square.connectionId);
    if (access.kind !== "ok") return;
    const answer = await deletePaymentLink(access.config, access.token, found.square.linkId);
    if (answer.kind === "ok" || (answer.kind === "refused" && answer.status === 404)) await ctx.runMutation(internal.financeSquarePay.linkClosed, args);
    await ctx.runAction(internal.financeSquarePay.syncPayment, args);
  },
});

export const linkClosed = internalMutation({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args) => {
    const payment = (await ctx.db.get(args.paymentId))!;
    if (payment.square) await ctx.db.patch(payment._id, { square: { ...payment.square, linkClosed: true, checkoutUrl: undefined }, updatedAt: Date.now() });
  },
});

export const markCanceled = internalMutation({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args) => {
    const payment = (await ctx.db.get(args.paymentId))!;
    if (payment.status !== "awaiting_customer" && payment.status !== "checking") return;
    if (payment.square?.linkId) return;
    await ctx.db.patch(payment._id, { status: "canceled", updatedAt: Date.now(), square: payment.square ? { ...payment.square, checkoutUrl: undefined } : undefined });
  },
});

// ── Refunds ──────────────────────────────────────────────────────────────────────────────────────

export const refundFor = internalQuery({
  args: { refundId: v.id("refunds") },
  handler: async (ctx, args) => {
    const refund = await ctx.db.get(args.refundId);
    const payment = refund ? await ctx.db.get(refund.paymentId) : null;
    return refund && payment?.square ? { refund, payment, square: payment.square } : null;
  },
});

/** Sends a confirmed refund to Square under the refund's own key on every try. */
export const sendRefund = internalAction({
  args: { refundId: v.id("refunds") },
  handler: async (ctx, args) => {
    const found = await ctx.runQuery(internal.financeSquarePay.refundFor, args);
    if (!found?.square.paymentId || found.refund.squareRefundId) return;
    if (!["sending", "checking"].includes(found.refund.status)) return;
    const access = await squareAccess(ctx, found.square.connectionId);
    if (access.kind === "lost") {
      await ctx.runMutation(internal.financeSquarePay.refundRefused, { refundId: args.refundId, problem: "Square needs to be reconnected before this refund can be sent. No money was returned." });
      return;
    }
    if (access.kind !== "ok") {
      await ctx.runMutation(internal.financeSquarePay.refundUnclear, args);
      return;
    }
    if (Date.now() - found.refund.createdAt > REPLAY_WINDOW) {
      await ctx.runAction(internal.financeSquarePay.syncDashboardRefunds, { paymentId: found.payment._id, adoptFor: args.refundId });
      return;
    }
    await ctx.runMutation(internal.financeSquarePay.refundTry, args);
    const answer = await refundPayment(access.config, access.token, { refundId: found.refund._id, squarePaymentId: found.square.paymentId, amountCents: found.refund.amountCents, reason: found.refund.reason });
    const refund = answer.kind === "ok" ? answer.data.refund : undefined;
    if (refund?.id) await ctx.runMutation(internal.financeSquarePay.refundRead, { refundId: args.refundId, squareRefundId: refund.id.slice(0, 100), facts: refundFacts(refund) });
    else if (answer.kind === "refused") {
      if (authLost(answer)) await ctx.runMutation(internal.financeSquarePay.authorizationLost, { connectionId: found.square.connectionId, reason: "Square stopped accepting Selestial's access to this account." });
      await ctx.runMutation(internal.financeSquarePay.refundRefused, { refundId: args.refundId, problem: `Square didn't refund it: ${answer.message}` });
    } else await ctx.runMutation(internal.financeSquarePay.refundUnclear, args);
  },
});

export const refundTry = internalMutation({
  args: { refundId: v.id("refunds") },
  handler: async (ctx, args) => {
    const refund = (await ctx.db.get(args.refundId))!;
    await ctx.db.patch(refund._id, { tries: refund.tries + 1, updatedAt: Date.now() });
  },
});

export const refundRefused = internalMutation({
  args: { refundId: v.id("refunds"), problem: v.string() },
  handler: async (ctx, args) => {
    const refund = (await ctx.db.get(args.refundId))!;
    if (refund.status === "succeeded" || refund.squareRefundId) return;
    await ctx.db.patch(refund._id, { status: "failed", problem: args.problem.slice(0, 300), updatedAt: Date.now() });
    await recordEvent(ctx, { companyId: refund.companyId, type: "refund.failed", actor: SYSTEM, subject: { table: "refunds", id: refund._id }, data: { amountCents: refund.amountCents, provider: "square" } });
  },
});

export const refundUnclear = internalMutation({
  args: { refundId: v.id("refunds") },
  handler: async (ctx, args) => {
    const refund = (await ctx.db.get(args.refundId))!;
    if (refund.squareRefundId || !["sending", "checking"].includes(refund.status)) return;
    await ctx.db.patch(refund._id, { status: "checking", problem: "Square didn't answer clearly. Selestial is checking before anything is tried again.", updatedAt: Date.now() });
    const wait = BACKOFF[Math.min(Math.max(refund.tries - 1, 0), BACKOFF.length - 1)];
    await ctx.scheduler.runAfter(wait, internal.financeSquarePay.sendRefund, args);
  },
});

const refundFactsValidator = v.object({ status: v.union(v.literal("pending"), v.literal("succeeded"), v.literal("failed"), v.literal("canceled")), problem: v.union(v.string(), v.null()) });

export const refundRead = internalMutation({
  args: { refundId: v.id("refunds"), squareRefundId: v.string(), facts: refundFactsValidator },
  handler: async (ctx, args) => applySquareRefund(ctx, (await ctx.db.get(args.refundId))!, args.squareRefundId, args.facts),
});

/** Writes what Square says about a refund, then adds the payment and the invoice up again. */
async function applySquareRefund(ctx: MutationCtx, refund: Doc<"refunds">, squareRefundId: string, facts: typeof refundFactsValidator.type) {
  if (refund.squareRefundId && refund.squareRefundId !== squareRefundId) return;
  const now = Date.now();
  const wasDone = refund.status === "succeeded";
  const status = facts.status;
  await ctx.db.patch(refund._id, { squareRefundId, status, problem: facts.problem ?? undefined, settledAt: status === "succeeded" ? (refund.settledAt ?? now) : refund.settledAt, updatedAt: now });
  const payment = (await ctx.db.get(refund.paymentId))!;
  if (!wasDone && status === "succeeded") {
    await ctx.db.patch(payment._id, { refundedCents: payment.refundedCents + refund.amountCents, updatedAt: now });
    if (refund.alsoCredit) await addRefundCredit(ctx, refund._id);
    await recordEvent(ctx, { companyId: refund.companyId, type: "refund.succeeded", actor: SYSTEM, subject: { table: "refunds", id: refund._id }, data: { amountCents: refund.amountCents, provider: "square" } });
  } else if (wasDone && status !== "succeeded") {
    await ctx.db.patch(payment._id, { refundedCents: Math.max(0, payment.refundedCents - refund.amountCents), updatedAt: now });
    await recordEvent(ctx, { companyId: refund.companyId, type: "refund.failed", actor: SYSTEM, subject: { table: "refunds", id: refund._id }, data: { amountCents: refund.amountCents, provider: "square" } });
  } else if (status === "failed" && refund.status !== "failed") {
    await recordEvent(ctx, { companyId: refund.companyId, type: "refund.failed", actor: SYSTEM, subject: { table: "refunds", id: refund._id }, data: { amountCents: refund.amountCents, provider: "square" } });
  }
  await recompute(ctx, refund.invoiceId);
}

export const syncRefund = internalAction({
  args: { refundId: v.id("refunds") },
  handler: async (ctx, args) => {
    const found = await ctx.runQuery(internal.financeSquarePay.refundFor, args);
    if (!found) return;
    if (!found.refund.squareRefundId) {
      await ctx.runAction(internal.financeSquarePay.sendRefund, args);
      return;
    }
    const access = await squareAccess(ctx, found.square.connectionId);
    if (access.kind !== "ok") return;
    const answer = await getRefund(access.config, access.token, found.refund.squareRefundId);
    const refund = answer.kind === "ok" ? answer.data.refund : undefined;
    if (refund?.id && refund.payment_id === found.square.paymentId) await ctx.runMutation(internal.financeSquarePay.refundRead, { refundId: args.refundId, squareRefundId: refund.id, facts: refundFacts(refund) });
  },
});

/** What the Owner reads on a refund made in Square rather than in Selestial. */
export const SQUARE_REFUND_REASON = "Refunded in Square";

/**
 * Refunds on a Square payment that Selestial has no record of: made in the Square Dashboard, or (with
 * `adoptFor`) the answer to Selestial's own refund that was lost and can no longer be replayed. Each is
 * read from Square and written once, by Square's refund id.
 */
export const syncDashboardRefunds = internalAction({
  args: { paymentId: v.id("payments"), adoptFor: v.optional(v.id("refunds")) },
  handler: async (ctx, args) => {
    const found = await ctx.runQuery(internal.financeSquarePay.paymentFor, { paymentId: args.paymentId });
    if (!found?.square.paymentId) return;
    const access = await squareAccess(ctx, found.square.connectionId);
    if (access.kind !== "ok") return;
    const payment = await getPayment(access.config, access.token, found.square.paymentId);
    if (payment.kind !== "ok" || !payment.data.payment) return;
    for (const id of (payment.data.payment.refund_ids ?? []).slice(0, 20)) {
      const answer = await getRefund(access.config, access.token, id);
      const refund = answer.kind === "ok" ? answer.data.refund : undefined;
      const amount = refund?.amount_money?.currency === "USD" ? refund.amount_money.amount : undefined;
      if (!refund?.id || refund.payment_id !== found.square.paymentId || !Number.isSafeInteger(amount) || (amount ?? 0) <= 0) continue;
      await ctx.runMutation(internal.financeSquarePay.squareRefundRead, { paymentId: args.paymentId, squareRefundId: refund.id.slice(0, 100), amountCents: amount!, facts: refundFacts(refund), adoptFor: args.adoptFor });
    }
    if (args.adoptFor) await ctx.runMutation(internal.financeSquarePay.adoptionDone, { refundId: args.adoptFor });
  },
});

export const squareRefundRead = internalMutation({
  args: { paymentId: v.id("payments"), squareRefundId: v.string(), amountCents: v.number(), facts: refundFactsValidator, adoptFor: v.optional(v.id("refunds")) },
  handler: async (ctx, args) => {
    const payment = await ctx.db.get(args.paymentId);
    if (!payment || payment.source !== "square") return;
    const existing = await ctx.db
      .query("refunds")
      .withIndex("by_square_refund", (q) => q.eq("squareRefundId", args.squareRefundId))
      .first();
    if (existing) {
      if (existing.paymentId === payment._id && existing.origin === "square_dashboard") await applySquareRefund(ctx, existing, args.squareRefundId, args.facts);
      return;
    }
    // Selestial's own refund whose answer was lost: the one Square refund of the same amount made after it was asked for.
    if (args.adoptFor) {
      const mine = await ctx.db.get(args.adoptFor);
      if (mine && !mine.squareRefundId && mine.paymentId === payment._id && mine.amountCents === args.amountCents) {
        await applySquareRefund(ctx, mine, args.squareRefundId, args.facts);
        return;
      }
    }
    if (args.facts.status === "failed" || args.facts.status === "canceled" || payment.status !== "succeeded") return;
    const amountCents = Math.min(args.amountCents, payment.amountCents - payment.refundedCents);
    if (amountCents <= 0) return;
    const now = Date.now();
    const refundId = await ctx.db.insert("refunds", {
      companyId: payment.companyId,
      paymentId: payment._id,
      invoiceId: payment.invoiceId,
      customerId: payment.customerId,
      amountCents,
      reason: SQUARE_REFUND_REASON,
      status: "pending",
      alsoCredit: false,
      origin: "square_dashboard",
      tries: 0,
      clientKey: `square-${args.squareRefundId}`.slice(0, 80),
      createdAt: now,
      updatedAt: now,
    });
    await recordEvent(ctx, { companyId: payment.companyId, type: "refund.found_in_square", actor: SYSTEM, subject: { table: "refunds", id: refundId }, data: { amountCents, squareAmountCents: args.amountCents } });
    await applySquareRefund(ctx, (await ctx.db.get(refundId))!, args.squareRefundId, args.facts);
  },
});

/** A lost refund answer that Square has no matching refund for: nothing was returned. */
export const adoptionDone = internalMutation({
  args: { refundId: v.id("refunds") },
  handler: async (ctx, args) => {
    const refund = (await ctx.db.get(args.refundId))!;
    if (refund.squareRefundId || !["sending", "checking"].includes(refund.status)) return;
    await ctx.db.patch(refund._id, { status: "failed", problem: "Square has no record of this refund, so no money was returned. Start it again if it's still needed.", updatedAt: Date.now() });
  },
});

// ── Webhooks ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A verified Square event. Recorded once by its id; then the object it names is read back from Square with
 * the connected company's own token. The merchant decides the company, never the event's contents.
 */
export const webhookReceived = internalMutation({
  args: { event: v.object({ eventId: v.string(), type: v.string(), merchantId: v.string(), objectType: v.union(v.string(), v.null()), objectId: v.union(v.string(), v.null()) }) },
  handler: async (ctx, { event }: { event: SquareEvent }) => {
    const seen = await ctx.db
      .query("providerReceipts")
      .withIndex("by_provider_event", (q) => q.eq("provider", "square").eq("eventId", event.eventId))
      .unique();
    if (seen) return { handled: false, unmatched: false };
    await ctx.db.insert("providerReceipts", { provider: "square", eventId: event.eventId, receivedAt: Date.now() });
    const environment = squareConfig()?.environment;
    if (!environment) return { handled: false, unmatched: false };
    const rows = await ctx.db
      .query("squareConnections")
      .withIndex("by_merchant", (q) => q.eq("environment", environment).eq("merchantId", event.merchantId))
      .take(20);
    const row = rows.find((r) => r.status !== "disconnected") ?? null;
    if (!row) return { handled: false, unmatched: rows.length === 0 };

    if (event.type === "oauth.authorization.revoked") {
      await lose(ctx, row, "The Square account's owner ended Selestial's access in Square.");
      return { handled: true, unmatched: false };
    }
    if (event.type.startsWith("payment.") && event.objectId) {
      const payment = await ctx.db
        .query("payments")
        .withIndex("by_square_payment", (q) => q.eq("square.paymentId", event.objectId!))
        .first();
      if (payment) {
        if (payment.companyId === row.companyId) await ctx.scheduler.runAfter(0, internal.financeSquarePay.syncPayment, { paymentId: payment._id });
        return { handled: payment.companyId === row.companyId, unmatched: false };
      }
      // Not known by its payment id yet: Square's own record says which order (and so which attempt) it is for.
      await ctx.scheduler.runAfter(0, internal.financeSquarePay.matchPayment, { connectionId: row._id, squarePaymentId: event.objectId });
      return { handled: true, unmatched: false };
    }
    if (event.type.startsWith("refund.") && event.objectId) {
      const refund = await ctx.db
        .query("refunds")
        .withIndex("by_square_refund", (q) => q.eq("squareRefundId", event.objectId!))
        .first();
      if (refund) {
        if (refund.companyId === row.companyId) await ctx.scheduler.runAfter(0, internal.financeSquarePay.syncRefund, { refundId: refund._id });
        return { handled: refund.companyId === row.companyId, unmatched: false };
      }
      await ctx.scheduler.runAfter(0, internal.financeSquarePay.matchRefund, { connectionId: row._id, squareRefundId: event.objectId });
      return { handled: true, unmatched: false };
    }
    return { handled: false, unmatched: false };
  },
});

/** A Square payment Selestial hasn't seen by id: its order names the attempt. A sale the business made elsewhere in Square matches nothing and is left alone. */
export const matchPayment = internalAction({
  args: { connectionId: v.id("squareConnections"), squarePaymentId: v.string() },
  handler: async (ctx, args) => {
    const access = await squareAccess(ctx, args.connectionId);
    if (access.kind !== "ok") return;
    const answer = await getPayment(access.config, access.token, args.squarePaymentId);
    const orderId = answer.kind === "ok" ? answer.data.payment?.order_id : undefined;
    if (!orderId) return;
    const paymentId = await ctx.runQuery(internal.financeSquarePay.attemptForOrder, { connectionId: args.connectionId, orderId });
    if (paymentId) await ctx.runAction(internal.financeSquarePay.syncPayment, { paymentId });
  },
});

export const attemptForOrder = internalQuery({
  args: { connectionId: v.id("squareConnections"), orderId: v.string() },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_square_order", (q) => q.eq("square.orderId", args.orderId))
      .first();
    return payment && connection && payment.companyId === connection.companyId && payment.square?.merchantId === connection.merchantId ? payment._id : null;
  },
});

/** A Square refund Selestial hasn't seen: if it is on one of the company's Square payments, it was made in Square. */
export const matchRefund = internalAction({
  args: { connectionId: v.id("squareConnections"), squareRefundId: v.string() },
  handler: async (ctx, args) => {
    const access = await squareAccess(ctx, args.connectionId);
    if (access.kind !== "ok") return;
    const answer = await getRefund(access.config, access.token, args.squareRefundId);
    const squarePaymentId = answer.kind === "ok" ? answer.data.refund?.payment_id : undefined;
    if (!squarePaymentId) return;
    const paymentId = await ctx.runQuery(internal.financeSquarePay.attemptForSquarePayment, { connectionId: args.connectionId, squarePaymentId });
    if (paymentId) await ctx.runAction(internal.financeSquarePay.syncDashboardRefunds, { paymentId });
  },
});

export const attemptForSquarePayment = internalQuery({
  args: { connectionId: v.id("squareConnections"), squarePaymentId: v.string() },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_square_payment", (q) => q.eq("square.paymentId", args.squarePaymentId))
      .first();
    return payment && connection && payment.companyId === connection.companyId ? payment._id : null;
  },
});

// ── Losing and ending access ─────────────────────────────────────────────────────────────────────

async function lose(ctx: MutationCtx, row: Doc<"squareConnections">, reason: string) {
  if (row.status === "needs_reconnect" || row.status === "disconnected") return;
  const open = (await squarePaymentsOf(ctx, row, ["awaiting_customer", "checking"])).length;
  const now = Date.now();
  await ctx.db.patch(row._id, { status: "needs_reconnect", problem: reason, refreshingUntil: undefined, openLinksAtLoss: open || undefined, updatedAt: now });
  await recordEvent(ctx, { companyId: row.companyId, type: "square.updated", actor: SYSTEM, subject: { table: "squareConnections", id: row._id }, data: { status: "needs_reconnect", openLinks: open } });
}

export const authorizationLost = internalMutation({
  args: { connectionId: v.id("squareConnections"), reason: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row) await lose(ctx, row, args.reason);
  },
});

async function squarePaymentsOf(ctx: MutationCtx, row: Doc<"squareConnections">, statuses: Doc<"payments">["status"][]) {
  const out: Doc<"payments">[] = [];
  for (const status of statuses) {
    const rows = await ctx.db
      .query("payments")
      .withIndex("by_company_status", (q) => q.eq("companyId", row.companyId).eq("status", status))
      .take(500);
    out.push(...rows.filter((p) => p.square?.connectionId === row._id));
  }
  return out;
}

export const openAttempts = internalQuery({
  args: { connectionId: v.id("squareConnections") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (!row) return [];
    const out: Id<"payments">[] = [];
    for (const status of ["awaiting_customer", "checking", "processing"] as const) {
      const rows = await ctx.db
        .query("payments")
        .withIndex("by_company_status", (q) => q.eq("companyId", row.companyId).eq("status", status))
        .take(500);
      out.push(...rows.filter((p) => p.square?.connectionId === row._id).map((p) => p._id));
    }
    return out;
  },
});

/** Reconnected: read every attempt that was open while access was lost. */
export const recheckConnection = internalMutation({
  args: { connectionId: v.id("squareConnections") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (!row) return;
    for (const payment of await squarePaymentsOf(ctx, row, ["awaiting_customer", "checking", "processing"])) await ctx.scheduler.runAfter(0, internal.financeSquarePay.syncPayment, { paymentId: payment._id });
  },
});

/**
 * After the Owner disconnected: close every unfinished checkout and read it back while Selestial still
 * can, then end Square's grant and forget the tokens. When access was already lost, only the record changes.
 */
export const endAccess = internalAction({
  args: { connectionId: v.id("squareConnections"), reachable: v.boolean() },
  handler: async (ctx, args) => {
    const config = squareConfig();
    const row = await ctx.runQuery(internal.financeSquare.connectionFor, { connectionId: args.connectionId });
    if (!row || row.status !== "disconnected") return;
    const token = args.reachable && config?.environment === row.environment ? await unseal(row.sealedAccessToken, connectionBinding(row._id, "access")) : null;
    for (const paymentId of await ctx.runQuery(internal.financeSquarePay.openAttempts, { connectionId: args.connectionId })) {
      const found = await ctx.runQuery(internal.financeSquarePay.paymentFor, { paymentId });
      if (!found) continue;
      if (token && config && found.square.linkId && found.payment.status === "awaiting_customer") {
        const answer = await deletePaymentLink(config, token, found.square.linkId);
        if (answer.kind === "ok" || (answer.kind === "refused" && answer.status === 404)) await ctx.runMutation(internal.financeSquarePay.linkClosed, { paymentId });
        const order = found.square.orderId ? await retrieveOrder(config, token, found.square.orderId) : null;
        if (order?.kind === "ok") {
          const payments: RawPayment[] = [];
          for (const id of tenderPaymentIds(order.data.order ?? null).slice(0, 10)) {
            const p = await getPayment(config, token, id);
            const read = p.kind === "ok" ? p.data.payment : undefined;
            if (read && read.order_id === found.square.orderId) payments.push(read);
          }
          await ctx.runMutation(internal.financeSquarePay.paymentRead, { paymentId, facts: orderOutcome(order.data.order ?? null, payments) });
        }
      } else if (!found.square.linkId) {
        await ctx.runMutation(internal.financeSquarePay.markCanceled, { paymentId });
      }
    }
    if (token && config?.secret) await revokeToken(config, row.merchantId);
    await ctx.runMutation(internal.financeSquare.forgetTokens, { connectionId: args.connectionId });
  },
});

// ── Keeping records true when a webhook is late or missing ───────────────────────────────────────

/**
 * Every few minutes: read back Square attempts still in flight or being checked, close checkouts customers
 * left unfinished for a day, and read back refunds that haven't settled. Never creates a new attempt.
 */
export const reconcile = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = async (status: Doc<"payments">["status"], olderThan: number) =>
      (
        await ctx.db
          .query("payments")
          .withIndex("by_status_updated", (q) => q.eq("status", status).lt("updatedAt", now - olderThan))
          .take(100)
      ).filter((p) => p.source === "square");
    for (const payment of await due("processing", 10 * MINUTE)) if (!payment.checkedAt || now - payment.checkedAt > 10 * MINUTE) await ctx.scheduler.runAfter(0, internal.financeSquarePay.syncPayment, { paymentId: payment._id });
    for (const payment of await due("checking", 30 * MINUTE)) await ctx.scheduler.runAfter(0, internal.financeSquarePay.syncPayment, { paymentId: payment._id });
    for (const payment of await due("awaiting_customer", 30 * MINUTE)) {
      // A checkout open a day is closed; a newer one is read, in case the webhook never came.
      if (now - payment.createdAt > 24 * 60 * MINUTE) await ctx.scheduler.runAfter(0, internal.financeSquarePay.closeLink, { paymentId: payment._id });
      else if (!payment.checkedAt || now - payment.checkedAt > 30 * MINUTE) await ctx.scheduler.runAfter(0, internal.financeSquarePay.syncPayment, { paymentId: payment._id });
    }
    for (const status of ["pending", "checking", "sending"] as const) {
      const rows = await ctx.db
        .query("refunds")
        .withIndex("by_status_updated", (q) => q.eq("status", status).lt("updatedAt", now - 15 * MINUTE))
        .take(100);
      for (const refund of rows) {
        const payment = await ctx.db.get(refund.paymentId);
        if (payment?.source === "square") await ctx.scheduler.runAfter(0, internal.financeSquarePay.syncRefund, { refundId: refund._id });
      }
    }
  },
});

// ── Starting an attempt (the pay page and online booking) ───────────────────────────────────────

/** Selestial's own floor for a Square checkout, so a tiny remainder isn't sent through card fees. */
export const SQUARE_MIN_CENTS = 100;

/**
 * Records one Square payment attempt for an invoice and asks Square for its checkout. The amount is the
 * caller's server-side figure, never the browser's. Only one unfinished attempt is kept per invoice, so a
 * second tab can't collect the same balance twice. `returnTo` is the page Square sends the customer back
 * to; the attempt's id is added so that page can read this attempt.
 */
export async function startSquareAttempt(
  ctx: MutationCtx,
  input: { invoice: Doc<"invoices">; connection: Doc<"squareConnections">; amountCents: number; tipCents: number; clientKey: string; returnTo: string },
): Promise<Id<"payments">> {
  const { invoice, connection } = input;
  if (connection.status !== "ready" || !connection.location) throw new Error("Square isn't ready for this company.");
  const now = Date.now();
  const placeholder = "https://selestial.invalid/";
  const paymentId = await ctx.db.insert("payments", {
    companyId: invoice.companyId,
    invoiceId: invoice._id,
    customerId: invoice.customerId,
    amountCents: input.amountCents,
    method: "card",
    source: "square",
    status: "awaiting_customer",
    clientKey: input.clientKey,
    square: { connectionId: connection._id, environment: connection.environment, merchantId: connection.merchantId, locationId: connection.location.id, returnUrl: placeholder, createTries: 0 },
    refundedCents: 0,
    tipCents: input.tipCents || undefined,
    createdAt: now,
    updatedAt: now,
  });
  const back = new URL(input.returnTo);
  back.searchParams.set("square", paymentId);
  const row = (await ctx.db.get(paymentId))!;
  await ctx.db.patch(paymentId, { square: { ...row.square!, returnUrl: back.toString() } });
  await recordEvent(ctx, { companyId: invoice.companyId, type: "payment.started", actor: SYSTEM, subject: { table: "payments", id: paymentId }, data: { amountCents: input.amountCents, provider: "square" } });
  await ctx.scheduler.runAfter(0, internal.financeSquarePay.createLink, { paymentId });
  return paymentId;
}
