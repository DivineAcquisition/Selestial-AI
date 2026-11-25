import { describe, expect, it } from "vitest";

import type { PublicFoundingStatus } from "../../../convex/founding";
import { DAY_MS } from "../../../convex/lib/founding/offer";
import { closingDate, viewFrom } from "./view";

const START = Date.UTC(2026, 11, 1, 18, 0);
const END = START + 90 * DAY_MS;
const offer = { id: "founding-access", version: "v", capacity: 25, foundingMonthlyCents: 19900, foundingMonths: 12, renewalMonthlyCents: 29900 };
const status = (fields: Partial<PublicFoundingStatus> = {}): PublicFoundingStatus => ({
  offer,
  campaign: { status: "open", enrollmentStartsAt: START, enrollmentEndsAt: END, displayTimezone: "America/Chicago" },
  checkoutOn: true,
  joined: 7,
  placesUsed: 9,
  ...fields,
});

describe("the founding page's view", () => {
  it("is not open before activation, and shows no deadline", () => {
    expect(viewFrom(status({ campaign: null }), START)).toMatchObject({ state: "not_open", endsAt: null, canClaim: false, placesLeft: null });
  });

  it("is open between the stored timestamps, for everyone, with real places left", () => {
    expect(viewFrom(status(), START + DAY_MS)).toMatchObject({ state: "open", endsAt: END, canClaim: true, joined: 7, placesLeft: 16 });
  });

  it("closes exactly at the deadline", () => {
    expect(viewFrom(status(), END - 1).state).toBe("open");
    expect(viewFrom(status(), END)).toMatchObject({ state: "closed_deadline", canClaim: false, placesLeft: null });
  });

  it("closes when the places are used, on the billing rule's own count", () => {
    expect(viewFrom(status({ placesUsed: 25 }), START + DAY_MS)).toMatchObject({ state: "closed_full", canClaim: false });
  });

  it("never invites a claim checkout can't charge", () => {
    expect(viewFrom(status({ checkoutOn: false }), START + DAY_MS)).toMatchObject({ state: "open", canClaim: false });
  });

  it("shows nothing made up when the status can't be read", () => {
    expect(viewFrom(null, START)).toMatchObject({ state: "unavailable", joined: null, placesLeft: null, endsAt: null, canClaim: false });
    expect(viewFrom(status({ joined: null, placesUsed: null }), START + DAY_MS)).toMatchObject({ joined: null, placesLeft: null });
  });

  it("writes the closing date in the offer's zone, the same on server and browser", () => {
    expect(closingDate(END, "America/Chicago")).toBe("Monday, March 1, 2027 at 12:00 PM CST");
  });
});
