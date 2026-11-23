/**
 * The early-user price, as the Owner sees it (convex/lib/billing/earlyOffer.ts decides it; this only words it).
 *
 * Every line here is driven by what the server says will be honored: $199 is shown only when a place is open
 * for this company (or it already holds one), never from a guess on this page. The remaining count is shown
 * because it is the server's own count and tells the Owner plainly that the offer is limited; it is never
 * shown as urgency, and it disappears when no place is left.
 */
import { Sparkles } from "@/components/icons";
import { money } from "@/lib/app/format";

import type { OwnerOffer } from "../../../../convex/lib/billing/earlyOffer";

const day = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const whole = (cents: number) => money(cents).replace(/\.00$/, "");

/** The offer before buying: shown above the plan when a place is open for this company. */
export function EarlyOfferNote({ offer }: { offer: OwnerOffer | undefined }) {
  if (!offer || (offer.kind !== "available" && offer.kind !== "reserved")) return null;
  const left = offer.kind === "available" ? offer.placesLeft : null;
  return (
    <div role="note" aria-label="Early-user price" className="flex items-start gap-3 rounded-xl border border-brand-500/30 bg-brand-500/5 px-4 py-3">
      <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0 text-brand-600" />
      <div className="min-w-0 text-sm">
        <p className="font-medium text-strong">
          Early-user price: {whole(offer.monthlyCents)} a month for your first {offer.months} months, then {whole(offer.fullCents)}.
        </p>
        <p className="mt-0.5 text-muted-foreground">
          {offer.kind === "reserved"
            ? "A place is held for your purchase while its payment is completed."
            : `${left} of ${offer.places} places left. A place is yours once your first payment goes through.`}{" "}
          The plan, agents and credits are exactly Operate&apos;s.
        </p>
      </div>
    </div>
  );
}

/** On the active plan card: the price paid now, until when, and what follows. */
export function EarlyPriceLine({ offer }: { offer: OwnerOffer | undefined }) {
  if (!offer || offer.kind !== "active") return null;
  return (
    <p className="mt-2 inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-brand-500/10 px-2.5 py-1 text-sm text-strong ring-1 ring-brand-500/25">
      <Sparkles aria-hidden className="size-3.5 text-brand-600" />
      <span>
        Early-user price {whole(offer.monthlyCents)} until {day(offer.endsAt)}
        {offer.ending ? "." : `, then ${whole(offer.fullCents)}.`}
      </span>
    </p>
  );
}

/** In the purchase dialog, for a purchase previewed at the early-user price. */
export function EarlyOfferConfirmNote({ early, offer }: { early: boolean; offer: OwnerOffer | undefined }) {
  if (!early) return null;
  const monthly = offer && offer.kind !== "none" ? offer.monthlyCents : 199_00;
  const full = offer && offer.kind !== "none" ? offer.fullCents : 299_00;
  return (
    <p className="text-sm text-strong">
      Early-user price: {whole(monthly)} a month for your first 12 months, then {whole(full)} a month. If the last place is taken before you confirm, you&apos;ll see the full price before anything is charged.
    </p>
  );
}
