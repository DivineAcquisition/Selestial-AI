/**
 * How a company takes online payments right now (docs/finance/square.md): its chosen provider, and whether
 * that provider is ready. There is no fallback: a company that chose Square and isn't ready doesn't
 * silently take Stripe instead. The pay page, online booking and Finance all read this one answer.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { settingsOf, settingsRow } from "./settings";
import { squareConfig } from "./square";
import { readySquareConnection } from "./squareState";
import { stripeState } from "./stripeState";

/** The smallest online payment, per provider. Stripe's own minimum; for Square, Selestial's floor so a tiny remainder isn't sent through card fees. */
export const MIN_CENTS = { stripe: 50, square: 100 } as const;

export async function onlinePaymentState(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">) {
  const provider = settingsOf(await settingsRow(ctx, companyId)).paymentProvider;
  if (provider === "square") {
    const connection = await readySquareConnection(ctx, companyId);
    return { provider, ready: Boolean(connection), testMode: squareConfig()?.environment === "sandbox", minCents: MIN_CENTS.square, connection };
  }
  const stripe = await stripeState(ctx, companyId);
  return { provider, ready: stripe.canPayByCard, testMode: stripe.testMode, minCents: MIN_CENTS.stripe, connection: null };
}
