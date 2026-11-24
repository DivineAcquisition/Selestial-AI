/**
 * The recipient's own clock, for sending hours (docs/sms/00-architecture.md §1: 8 AM to 9 PM in the
 * recipient's local time; an owner can narrow it, never widen it).
 *
 * Where a person's time zone comes from, in order:
 *   1. a customer's property: its stored time zone, or the main time zone of its state
 *   2. otherwise the company's own time zone (cleaners, applicants and new leads are local to the business)
 *
 * Phone area codes are not used: numbers move with people, and a wrong guess would be worse than the
 * company's clock. Multi-zone states use their most populous zone.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Recipient } from "../compliance/schema";

/** Selestial's floor for every company's texts to people outside the company: no texts 9 PM to 8 AM, recipient's time. */
export const SENDING_FLOOR = { start: "21:00", end: "08:00" } as const;

const EASTERN = "America/New_York";
const CENTRAL = "America/Chicago";
const MOUNTAIN = "America/Denver";
const PACIFIC = "America/Los_Angeles";

export const STATE_TIMEZONES: Readonly<Record<string, string>> = {
  AL: CENTRAL, AK: "America/Anchorage", AZ: "America/Phoenix", AR: CENTRAL, CA: PACIFIC, CO: MOUNTAIN, CT: EASTERN, DE: EASTERN, DC: EASTERN,
  FL: EASTERN, GA: EASTERN, HI: "Pacific/Honolulu", ID: "America/Boise", IL: CENTRAL, IN: "America/Indiana/Indianapolis", IA: CENTRAL, KS: CENTRAL,
  KY: EASTERN, LA: CENTRAL, ME: EASTERN, MD: EASTERN, MA: EASTERN, MI: "America/Detroit", MN: CENTRAL, MS: CENTRAL, MO: CENTRAL, MT: MOUNTAIN,
  NE: CENTRAL, NV: PACIFIC, NH: EASTERN, NJ: EASTERN, NM: MOUNTAIN, NY: EASTERN, NC: EASTERN, ND: CENTRAL, OH: EASTERN, OK: CENTRAL, OR: PACIFIC,
  PA: EASTERN, RI: EASTERN, SC: EASTERN, SD: CENTRAL, TN: CENTRAL, TX: CENTRAL, UT: MOUNTAIN, VT: EASTERN, VA: EASTERN, WA: PACIFIC, WV: EASTERN,
  WI: CENTRAL, WY: MOUNTAIN,
};

export function stateTimezone(region: string | undefined): string | null {
  if (!region) return null;
  return STATE_TIMEZONES[region.trim().toUpperCase()] ?? null;
}

/** The first customer's property time zone found among the recipients, or null (use the company's clock). */
export async function recipientTimezone(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">, recipients: Recipient[]): Promise<string | null> {
  for (const recipient of recipients) {
    if (recipient.kind !== "customer") continue;
    const properties = await ctx.db
      .query("properties")
      .withIndex("by_company_customer", (q) => q.eq("companyId", companyId).eq("customerId", recipient.id as Id<"customers">))
      .take(5);
    for (const property of properties) {
      if (property.status === "archived") continue;
      const zone = property.timezone ?? stateTimezone(property.address.region);
      if (zone) return zone;
    }
  }
  return null;
}
