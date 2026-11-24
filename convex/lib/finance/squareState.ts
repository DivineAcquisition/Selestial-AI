/**
 * Where a company's Square connection stands, in one word the pages and the pay page can trust
 * (docs/finance/square.md):
 *  unavailable      Square can't be connected on this deployment yet (Selestial's own setup is missing).
 *  not_connected    the company hasn't connected Square (or the connection is from the other environment).
 *  needs_location   connected and confirmed; no location that can take online card payments is chosen.
 *  ready            Square takes this company's online payments at the chosen location.
 *  needs_reconnect  Square stopped accepting the authorization.
 *  disconnected     the company ended it; the history stays.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { squareBlockers, squareConfig, webhookReady, type SquareEnvironment } from "./square";

export type SquareState = "unavailable" | "not_connected" | "needs_location" | "ready" | "needs_reconnect" | "disconnected";

/** The company's newest Square connection in this environment that isn't disconnected, else its newest one. */
export async function currentSquareConnection(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">, environment: SquareEnvironment | null = squareConfig()?.environment ?? null): Promise<Doc<"squareConnections"> | null> {
  if (!environment) return null;
  const rows = (
    await ctx.db
      .query("squareConnections")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .order("desc")
      .take(10)
  ).filter((row) => row.environment === environment);
  return rows.find((row) => row.status !== "disconnected") ?? rows[0] ?? null;
}

/** A connection that can take a payment now: ready, with a location, in this deployment's environment. */
export async function readySquareConnection(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">): Promise<Doc<"squareConnections"> | null> {
  const row = await currentSquareConnection(ctx, companyId);
  return row && row.status === "ready" && row.location ? row : null;
}

/** What the Owner's pages read. Never a token, never a setting's value. */
export async function squareState(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">, sealingReady: boolean) {
  const config = squareConfig();
  const blockers = squareBlockers(config, sealingReady);
  const row = await currentSquareConnection(ctx, companyId, config?.environment ?? null);
  const state: SquareState = !config ? "unavailable" : !row ? (blockers.length ? "unavailable" : "not_connected") : row.status;
  return {
    state,
    environment: config?.environment ?? null,
    sandbox: config?.environment === "sandbox",
    /** Why connecting can't start yet, in words. Setting names are for Selestial's team, shown under support details. */
    blockers: blockers.map((b) => b.words),
    blockerSettings: blockers.flatMap((b) => b.settings),
    /** Without the webhook, payments are still confirmed, by reading Square every few minutes. */
    webhookReady: webhookReady(config),
    canConnect: Boolean(config) && blockers.length === 0,
    canPay: state === "ready" && Boolean(row?.location),
    businessName: row?.businessName ?? null,
    merchantId: row?.merchantId ?? null,
    location: row?.location ?? null,
    locations: row?.locations ?? [],
    locationProblem: row?.locationProblem ?? null,
    problem: row?.problem ?? null,
    checkedAt: row?.checkedAt ?? null,
    confirmedAt: row?.confirmedAt ?? null,
    openLinksAtLoss: row?.openLinksAtLoss ?? 0,
    connectionId: row?._id ?? null,
  };
}
