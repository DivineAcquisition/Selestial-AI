/**
 * Where a customer is invited to leave a public review. Retention's care page shows the same invitation to
 * every customer it sends a feedback link to, whatever they answered: review gating (asking only happy
 * customers) is against Google's policy, so no answer, rating or sentiment ever decides who sees it.
 *
 * The link is the one the Owner wrote in the Retention Playbook, or else the Google review page of the
 * company's verified Business Profile location (convex/googleWork.ts keeps it when the location is checked).
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { retentionSettings } from "../retention/settings";
import { activeConnection } from "./connection";

type Ctx = QueryCtx | MutationCtx;

/** The Google review page of the company's verified Business Profile location, while Business Profile is connected. */
export async function businessReviewLink(ctx: Ctx, companyId: Id<"companies">): Promise<string | null> {
  const connection = await activeConnection(ctx, companyId, "business_profile");
  if (!connection || connection.status !== "connected") return null;
  const rows = await ctx.db.query("googleResources").withIndex("by_company_kind", (q) => q.eq("companyId", companyId).eq("kind", "business_location")).take(20);
  return rows.find((row) => row.access === "verified" && row.connectionId === connection._id && row.reviewUri)?.reviewUri ?? null;
}

/** The review link a customer is shown: the Playbook's, or else the Business Profile location's. Null when there is none. */
export async function reviewLinkFor(ctx: Ctx, company: Doc<"companies">): Promise<string | null> {
  return retentionSettings(company).reviewUrl ?? (await businessReviewLink(ctx, company._id));
}
