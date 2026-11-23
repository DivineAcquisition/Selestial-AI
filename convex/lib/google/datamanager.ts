/**
 * Reporting booked jobs to Google Ads through the Data Manager API (events:ingest). Only a job that came from a
 * Google ad (a lead with a click id) is reported, once, under its own transaction id, with the consent the Owner
 * recorded. Google's answer is kept as diagnostics.
 *
 * Request shape per https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/send-events
 * and https://developers.google.com/data-manager/api/reference/rpc/google.ads.datamanager.v1:
 *  - destination: operatingAccount (the Google Ads account that owns the conversion action, 10 digits),
 *    loginAccount (the account the signed-in Google user reaches it through: a manager, or the account itself),
 *    productDestinationId (the conversion action id; it must be an "Import from clicks" / UPLOAD_CLICKS action);
 *  - event: eventTimestamp (RFC 3339), eventSource (required), transactionId (dedupes), conversionValue with
 *    currency, adIdentifiers.gclid;
 *  - consent: request-level DMA consent (adUserData, adPersonalization: CONSENT_GRANTED / CONSENT_DENIED).
 *
 * NOT VERIFIED against the live API in this build: no authorized Ads account was available.
 */
import { googleCall, type Fetch } from "./http";

const API = "https://datamanager.googleapis.com/v1";

export type ConversionEvent = { transactionId: string; at: number; valueCents: number; currency: string; gclid: string; consent: { adUserData: boolean; adPersonalization: boolean } };

const status = (granted: boolean) => (granted ? "CONSENT_GRANTED" : "CONSENT_DENIED");
const digits = (id: string) => id.replace(/-/g, "");

/** One request per consent basis: the company's recorded consent applies to every event in it. Pure, for tests. */
export function ingestBody(destination: { accountId: string; conversionActionId: string; loginAccountId?: string }, events: ConversionEvent[], validateOnly = false) {
  const consent = events[0]?.consent ?? { adUserData: false, adPersonalization: false };
  return {
    destinations: [
      {
        operatingAccount: { accountType: "GOOGLE_ADS", accountId: digits(destination.accountId) },
        loginAccount: { accountType: "GOOGLE_ADS", accountId: digits(destination.loginAccountId || destination.accountId) },
        productDestinationId: destination.conversionActionId,
      },
    ],
    consent: { adUserData: status(consent.adUserData), adPersonalization: status(consent.adPersonalization) },
    events: events.map((event) => ({
      transactionId: event.transactionId,
      eventTimestamp: new Date(event.at).toISOString(),
      // A booked visit is arranged by text, phone or the booking page, not on the advertiser's site after the click.
      eventSource: "OTHER",
      conversionValue: event.valueCents / 100,
      currency: event.currency,
      adIdentifiers: { gclid: event.gclid },
    })),
    validateOnly,
    encoding: "HEX",
  };
}

export async function ingest(token: string, destination: Parameters<typeof ingestBody>[0], events: ConversionEvent[], options: { validateOnly?: boolean; fetcher?: Fetch } = {}): Promise<{ requestId: string | null; warnings: unknown[] }> {
  const body = await googleCall<{ requestId?: string; fieldWarnings?: unknown[] }>(`${API}/events:ingest`, token, { method: "POST", body: ingestBody(destination, events, options.validateOnly), fetcher: options.fetcher });
  return { requestId: body.requestId ?? null, warnings: body.fieldWarnings ?? [] };
}

/** What Google later said about a request: processed, partly processed, or failed, with its reasons. */
export async function requestStatus(token: string, requestId: string, fetcher?: Fetch): Promise<Record<string, unknown>> {
  return googleCall<Record<string, unknown>>(`${API}/requestStatus:retrieve?requestId=${encodeURIComponent(requestId)}`, token, { fetcher });
}
