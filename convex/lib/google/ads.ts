/**
 * Google Ads API: accounts the authorized user can reach (directly or through a manager account), results by
 * campaign, Local Services leads, and paused campaign creation from an approved draft. Nothing here enables a
 * campaign or changes a budget by itself; those calls are made only by steps that check a recorded approval.
 *
 * The API version is a deployment setting (GOOGLE_ADS_API_VERSION), defaulting to the newest stable version.
 * Request shapes follow that version (https://developers.google.com/google-ads/api/docs/release-notes):
 * campaigns declare EU political advertising, and local_services_lead contact details carry no email (v25).
 * NOT VERIFIED against the live API in this build: no developer token was available.
 */
import { GoogleError, googleCall, type Fetch } from "./http";

/** v26 (October 2026, sunsets November 2027). v20 and v21 are sunset and answer 404. */
export const DEFAULT_ADS_VERSION = "v26";
export const adsVersion = () => process.env.GOOGLE_ADS_API_VERSION?.trim() || DEFAULT_ADS_VERSION;
const base = () => `https://googleads.googleapis.com/${adsVersion()}`;

/** login-customer-id names the manager account the call goes through. Anything that is not a customer id is left out. */
function headers(developerToken: string, loginCustomerId?: string | null): Record<string, string> {
  const login = loginCustomerId?.replace(/-/g, "").trim();
  return { "developer-token": developerToken, ...(login && /^\d{10}$/.test(login) ? { "login-customer-id": login } : {}) };
}

export const customerId = (value: string) => {
  const id = value.replace(/^customers\//, "").replace(/-/g, "");
  if (!/^\d{10}$/.test(id)) throw new GoogleError("invalid", "That is not a Google Ads account id.");
  return id;
};

export const formatCustomerId = (id: string) => `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`;

const quoted = (value: string) => value.replace(/['\\]/g, "");

export async function accessibleCustomers(token: string, developerToken: string, fetcher?: Fetch): Promise<string[]> {
  const body = await googleCall<{ resourceNames?: string[] }>(`${base()}/customers:listAccessibleCustomers`, token, { headers: headers(developerToken), fetcher });
  return (body.resourceNames ?? []).map((name) => name.replace("customers/", ""));
}

export async function search<T = Record<string, unknown>>(token: string, developerToken: string, account: string, query: string, loginCustomerId?: string | null, fetcher?: Fetch): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const body = await googleCall<{ results?: T[]; nextPageToken?: string }>(`${base()}/customers/${customerId(account)}/googleAds:search`, token, { method: "POST", body: { query, ...(pageToken ? { pageToken } : {}) }, headers: headers(developerToken, loginCustomerId), fetcher });
    out.push(...(body.results ?? []));
    if (!body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return out;
}

/** One account's name and whether it is a manager account. Throws if the account cannot be reached as asked. */
export async function customerInfo(token: string, developerToken: string, account: string, loginCustomerId?: string | null, fetcher?: Fetch): Promise<{ id: string; name: string; manager: boolean }> {
  const rows = await search<{ customer?: { id?: string; descriptiveName?: string; manager?: boolean } }>(token, developerToken, account, "SELECT customer.id, customer.descriptive_name, customer.manager FROM customer LIMIT 1", loginCustomerId, fetcher);
  const row = rows[0]?.customer;
  if (!row) throw new GoogleError("not_found", "Google Ads did not return this account.");
  return { id: customerId(String(row.id ?? account)), name: row.descriptiveName ?? "", manager: row.manager === true };
}

/** The enabled advertiser accounts (not managers) under a manager account, at any level. */
export async function managedClients(token: string, developerToken: string, managerId: string, fetcher?: Fetch): Promise<{ id: string; name: string }[]> {
  const rows = await search<{ customerClient?: { id?: string; descriptiveName?: string; manager?: boolean; status?: string; level?: string | number } }>(
    token,
    developerToken,
    managerId,
    "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status, customer_client.level FROM customer_client WHERE customer_client.level >= 1 AND customer_client.manager = FALSE AND customer_client.status = 'ENABLED'",
    managerId,
    fetcher,
  );
  return rows.filter((row) => row.customerClient?.id && row.customerClient.manager !== true).map((row) => ({ id: String(row.customerClient!.id), name: row.customerClient!.descriptiveName ?? "" }));
}

export type CampaignResult = { campaign: string; status: string; impressions: number; clicks: number; costMicros: number; conversions: number };

export async function performance(token: string, developerToken: string, account: string, loginCustomerId?: string | null, fetcher?: Fetch): Promise<CampaignResult[]> {
  const rows = await search<{ campaign?: { name?: string; status?: string }; metrics?: { impressions?: string; clicks?: string; costMicros?: string; conversions?: number } }>(
    token,
    developerToken,
    account,
    "SELECT campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS",
    loginCustomerId,
    fetcher,
  );
  return rows.map((row) => ({ campaign: row.campaign?.name ?? "", status: row.campaign?.status ?? "", impressions: Number(row.metrics?.impressions ?? 0), clicks: Number(row.metrics?.clicks ?? 0), costMicros: Number(row.metrics?.costMicros ?? 0), conversions: Number(row.metrics?.conversions ?? 0) }));
}

/** No email: Google removed local_services_lead contact_details.email in v25. */
export type LsaLead = { id: string; type: string; status: string; createdAt: string; name?: string; phone?: string };

/** Local Services leads created after a time ("YYYY-MM-DD HH:MM:SS", the account's time zone), oldest first. */
export async function localServicesLeads(token: string, developerToken: string, account: string, since: string, loginCustomerId?: string | null, fetcher?: Fetch): Promise<LsaLead[]> {
  const rows = await search<{ localServicesLead?: { id?: string; leadType?: string; leadStatus?: string; creationDateTime?: string; contactDetails?: { consumerName?: string; phoneNumber?: string } } }>(
    token,
    developerToken,
    account,
    `SELECT local_services_lead.id, local_services_lead.lead_type, local_services_lead.lead_status, local_services_lead.creation_date_time, local_services_lead.contact_details FROM local_services_lead WHERE local_services_lead.creation_date_time > '${quoted(since)}' ORDER BY local_services_lead.creation_date_time ASC`,
    loginCustomerId,
    fetcher,
  );
  return rows.filter((row) => row.localServicesLead?.id).map((row) => ({ id: String(row.localServicesLead!.id), type: row.localServicesLead!.leadType ?? "", status: row.localServicesLead!.leadStatus ?? "", createdAt: row.localServicesLead!.creationDateTime ?? "", name: row.localServicesLead!.contactDetails?.consumerName, phone: row.localServicesLead!.contactDetails?.phoneNumber }));
}

/** Where the next Local Services poll starts: the newest lead seen, a little earlier so nothing slips between polls; a week back the first time. */
export function lsaSince(cursor: string | undefined, now: number, overlapMinutes = 60): string {
  const format = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const at = cursor ? Date.parse(`${cursor.trim().replace(" ", "T")}Z`) : NaN;
  if (!Number.isFinite(at)) return format(now - 7 * 86_400_000);
  return format(at - overlapMinutes * 60_000);
}

/** Finds a campaign Selestial created, by its exact name (which carries the draft id). */
export async function campaignByName(token: string, developerToken: string, account: string, name: string, loginCustomerId?: string | null, fetcher?: Fetch): Promise<{ resourceName: string; status: string } | null> {
  const rows = await search<{ campaign?: { resourceName?: string; status?: string } }>(token, developerToken, account, `SELECT campaign.resource_name, campaign.status FROM campaign WHERE campaign.name = '${quoted(name)}' AND campaign.status != 'REMOVED'`, loginCustomerId, fetcher);
  const row = rows[0]?.campaign;
  return row?.resourceName ? { resourceName: row.resourceName, status: row.status ?? "" } : null;
}

export type GeoMatch = { term: string; resourceName: string; name: string; targetType: string };

/**
 * Google's location for each ZIP code or city name (GeoTargetConstantService.SuggestGeoTargetConstants). A term
 * Google does not recognize as an enabled location is left out, so the caller can say which ones did not match.
 */
export async function suggestGeoTargets(token: string, developerToken: string, names: string[], countryCode = "US", fetcher?: Fetch): Promise<GeoMatch[]> {
  const out: GeoMatch[] = [];
  for (let i = 0; i < names.length; i += 25) {
    const batch = names.slice(i, i + 25);
    const body = await googleCall<{ geoTargetConstantSuggestions?: { searchTerm?: string; geoTargetConstant?: { resourceName?: string; name?: string; targetType?: string; status?: string } }[] }>(`${base()}/geoTargetConstants:suggest`, token, {
      method: "POST",
      headers: headers(developerToken),
      body: { locale: "en", countryCode, locationNames: { names: batch } },
      fetcher,
    });
    for (const term of batch) {
      const zip = /^\d{5}$/.test(term);
      const candidates = (body.geoTargetConstantSuggestions ?? []).filter((s) => (s.searchTerm ?? "").trim().toLowerCase() === term.trim().toLowerCase() && s.geoTargetConstant?.resourceName && (s.geoTargetConstant.status ?? "ENABLED") === "ENABLED");
      const best = candidates.find((s) => (zip ? s.geoTargetConstant!.targetType === "Postal Code" : s.geoTargetConstant!.targetType === "City")) ?? (zip ? undefined : candidates[0]);
      if (best) out.push({ term, resourceName: best.geoTargetConstant!.resourceName!, name: best.geoTargetConstant!.name ?? term, targetType: best.geoTargetConstant!.targetType ?? "" });
    }
  }
  return out;
}

export type CampaignPlan = { name: string; dailyBudgetMicros: number; keywords: string[]; matchType: "PHRASE" | "EXACT"; headlines: string[]; descriptions: string[]; finalUrl: string; geoTargets: string[] };

/**
 * Everything one search campaign needs, as one atomic GoogleAdsService.Mutate: a budget, the campaign (PAUSED),
 * an ad group, its keywords, one responsive search ad and the locations. Temporary ids link them; Google makes
 * all of them or none, so a retry that finds the campaign by name finds all of it. Pure, for tests.
 */
export function campaignOperations(account: string, plan: CampaignPlan): Record<string, unknown>[] {
  const id = customerId(account);
  const budget = `customers/${id}/campaignBudgets/-1`;
  const campaign = `customers/${id}/campaigns/-2`;
  const adGroup = `customers/${id}/adGroups/-3`;
  return [
    { campaignBudgetOperation: { create: { resourceName: budget, name: `${plan.name} budget`, amountMicros: String(plan.dailyBudgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false } } },
    {
      campaignOperation: {
        create: {
          resourceName: campaign,
          name: plan.name,
          status: "PAUSED",
          advertisingChannelType: "SEARCH",
          campaignBudget: budget,
          // Maximize clicks within the approved daily budget: no per-click bid for anyone to set or forget.
          targetSpend: {},
          networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
          geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" },
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
        },
      },
    },
    { adGroupOperation: { create: { resourceName: adGroup, name: `${plan.name} ads`, campaign, status: "ENABLED", type: "SEARCH_STANDARD" } } },
    ...plan.keywords.map((text) => ({ adGroupCriterionOperation: { create: { adGroup, status: "ENABLED", keyword: { text, matchType: plan.matchType } } } })),
    { adGroupAdOperation: { create: { adGroup, status: "ENABLED", ad: { finalUrls: [plan.finalUrl], responsiveSearchAd: { headlines: plan.headlines.map((text) => ({ text })), descriptions: plan.descriptions.map((text) => ({ text })) } } } } },
    ...plan.geoTargets.map((geoTargetConstant) => ({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant } } } })),
  ];
}

/** A PAUSED search campaign with its ad group, keywords, ad and locations. It does not run until a separate, approved activation. */
export async function createPausedCampaign(token: string, developerToken: string, account: string, plan: CampaignPlan, loginCustomerId?: string | null, fetcher?: Fetch): Promise<string> {
  const body = await googleCall<{ mutateOperationResponses?: { campaignResult?: { resourceName?: string } }[] }>(`${base()}/customers/${customerId(account)}/googleAds:mutate`, token, {
    method: "POST",
    headers: headers(developerToken, loginCustomerId),
    body: { mutateOperations: campaignOperations(account, plan) },
    fetcher,
  });
  const name = body.mutateOperationResponses?.find((r) => r.campaignResult?.resourceName)?.campaignResult?.resourceName;
  if (!name) throw new GoogleError("invalid", "Google Ads did not create the campaign.");
  return name;
}

/** What a campaign lacks before it may run: an ad group, an ad, keywords, locations. Empty means ready. */
export async function campaignGaps(token: string, developerToken: string, account: string, resourceName: string, loginCustomerId?: string | null, fetcher?: Fetch): Promise<string[]> {
  const where = `campaign.resource_name = '${quoted(resourceName)}'`;
  const count = async (query: string) => (await search(token, developerToken, account, query, loginCustomerId, fetcher)).length;
  const gaps: string[] = [];
  if (!(await count(`SELECT ad_group.id FROM ad_group WHERE ${where} AND ad_group.status = 'ENABLED'`))) gaps.push("an ad group");
  if (!(await count(`SELECT ad_group_ad.ad.id FROM ad_group_ad WHERE ${where} AND ad_group_ad.status = 'ENABLED'`))) gaps.push("an ad");
  if (!(await count(`SELECT ad_group_criterion.criterion_id FROM ad_group_criterion WHERE ${where} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status = 'ENABLED'`))) gaps.push("keywords");
  if (!(await count(`SELECT campaign_criterion.criterion_id FROM campaign_criterion WHERE ${where} AND campaign_criterion.type IN ('LOCATION', 'PROXIMITY') AND campaign_criterion.negative = FALSE`))) gaps.push("locations");
  return gaps;
}

export async function setCampaignStatus(token: string, developerToken: string, account: string, resourceName: string, status: "ENABLED" | "PAUSED", loginCustomerId?: string | null, fetcher?: Fetch): Promise<void> {
  await googleCall(`${base()}/customers/${customerId(account)}/campaigns:mutate`, token, { method: "POST", headers: headers(developerToken, loginCustomerId), body: { operations: [{ update: { resourceName, status }, updateMask: "status" }] }, fetcher });
}

/** A conversion action in an account, if it is there: its type says whether click imports can be sent to it. */
export async function conversionAction(token: string, developerToken: string, account: string, actionId: string, loginCustomerId?: string | null, fetcher?: Fetch): Promise<{ id: string; type: string; status: string } | null> {
  if (!/^\d+$/.test(actionId)) return null;
  const rows = await search<{ conversionAction?: { id?: string; type?: string; status?: string } }>(token, developerToken, account, `SELECT conversion_action.id, conversion_action.type, conversion_action.status FROM conversion_action WHERE conversion_action.id = ${actionId}`, loginCustomerId, fetcher);
  const row = rows[0]?.conversionAction;
  return row?.id ? { id: String(row.id), type: row.type ?? "", status: row.status ?? "" } : null;
}
