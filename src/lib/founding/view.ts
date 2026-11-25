/**
 * What the Founding Access page shows, from the backend's public status and the web server's clock. Pure,
 * so the page, the live-status route and tests decide the same way. The deadline is never computed here:
 * it is the stored timestamp staff set once (convex/founding.ts, `activate`).
 */
import type { PublicFoundingStatus } from "../../../convex/founding";
import { enrollmentState, FOUNDING_OFFER, type EnrollmentState } from "../../../convex/lib/founding/offer";

export type FoundingView = {
  state: EnrollmentState | "unavailable";
  startsAt: number | null;
  endsAt: number | null;
  timezone: string;
  /** The server's time when this view was made. The browser measures its own clock against it. */
  serverNow: number;
  /** Verified founding companies, or null when unavailable: never a stand-in number. */
  joined: number | null;
  /** Places left under the real capacity limit, shown only while enrollment is open. */
  placesLeft: number | null;
  /** Whether "Claim founding access" leads to a claim: open enrollment and a founding price checkout can charge. */
  canClaim: boolean;
};

export function viewFrom(status: PublicFoundingStatus | null, now: number): FoundingView {
  const timezone = status?.campaign?.displayTimezone ?? FOUNDING_OFFER.displayTimezone;
  if (!status) return { state: "unavailable", startsAt: null, endsAt: null, timezone, serverNow: now, joined: null, placesLeft: null, canClaim: false };
  const campaign = status.campaign;
  const used = status.placesUsed ?? 0;
  const state = enrollmentState(
    campaign ? { status: campaign.status, enrollmentStartsAt: campaign.enrollmentStartsAt ?? undefined, enrollmentEndsAt: campaign.enrollmentEndsAt ?? undefined } : null,
    used,
    now,
  );
  const open = state === "open";
  return {
    state,
    startsAt: campaign?.enrollmentStartsAt ?? null,
    endsAt: campaign?.enrollmentEndsAt ?? null,
    timezone,
    serverNow: now,
    joined: status.joined,
    placesLeft: open && status.placesUsed !== null ? Math.max(0, status.offer.capacity - status.placesUsed) : null,
    canClaim: open && status.checkoutOn,
  };
}

/** "Friday, February 23, 2027 at 6:00 PM CST", in the offer's display zone. */
export function closingDate(endsAt: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(endsAt));
}
