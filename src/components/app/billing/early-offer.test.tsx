import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PRICING } from "@/lib/marketing/content";

import type { OwnerOffer } from "../../../../convex/lib/billing/earlyOffer";
import { EarlyOfferConfirmNote, EarlyOfferNote, EarlyPriceLine } from "./early-offer";

const base = { monthlyCents: 199_00, fullCents: 299_00 };
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const TRIAL = /trial/i;

/** The Owner sees $199 only when the server says it will be honored. */
describe("the early-user price on Plan & Usage", () => {
  it("is shown before buying only while a place is open for this company, with the count and the price after", () => {
    const available: OwnerOffer = { kind: "available", placesLeft: 4, places: 15, months: 12, ...base };
    const note = html(<EarlyOfferNote offer={available} />);
    expect(note).toContain("Early-user price: $199 a month for your first 12 months, then $299.");
    expect(note).toContain("4 of 15 places left.");
    expect(note).not.toMatch(TRIAL);
    expect(html(<EarlyOfferNote offer={{ kind: "reserved", until: 1, months: 12, ...base }} />)).toContain("$199");
  });

  it("is never shown when it won't be honored: no place, a place held before, a plan already, or still loading", () => {
    for (const offer of [{ kind: "none" } as OwnerOffer, undefined]) {
      expect(html(<EarlyOfferNote offer={offer} />)).toBe("");
      expect(html(<EarlyPriceLine offer={offer} />)).toBe("");
    }
    // An active offer is a plan card line, not a purchase note.
    expect(html(<EarlyOfferNote offer={{ kind: "active", endsAt: Date.UTC(2028, 2, 1), switchScheduled: false, ending: false, ...base }} />)).toBe("");
    expect(html(<EarlyOfferConfirmNote early={false} offer={undefined} />)).toBe("");
  });

  it("says on the active plan until when $199 lasts and what follows", () => {
    const active: OwnerOffer = { kind: "active", endsAt: Date.UTC(2028, 2, 1, 12), switchScheduled: true, ending: false, ...base };
    expect(html(<EarlyPriceLine offer={active} />)).toContain("Early-user price $199 until March 1, 2028, then $299.");
    // A plan that is ending is not promised a later price.
    expect(html(<EarlyPriceLine offer={{ ...active, ending: true }} />)).not.toContain("$299");
  });

  it("tells the Owner in the purchase dialog what happens if the last place goes first", () => {
    expect(html(<EarlyOfferConfirmNote early offer={{ kind: "available", placesLeft: 1, places: 15, months: 12, ...base }} />)).toMatch(/\$199 a month for your first 12 months, then \$299 a month\. If the last place is taken before you confirm, you&#x27;ll see the full price/);
  });
});

describe("public pricing", () => {
  it("states the offer honestly under the $299 plan and never promises a trial", () => {
    const [operate] = PRICING.plans;
    expect(operate.price).toBe("$299");
    // Who, how much, for how long and the price after, all on the card (shown only while the offer is switched on).
    expect(operate.offer).toEqual({ price: "$199", period: "/month", terms: "for your first 12 months, then $299", note: "For the first 15 companies. While places last." });
    expect(JSON.stringify(PRICING)).not.toMatch(TRIAL);
  });
});
