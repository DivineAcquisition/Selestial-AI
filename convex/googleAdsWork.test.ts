/**
 * @vitest-environment edge-runtime
 *
 * Google Ads, Local Services Ads and booked-job reporting against a fake Google: the API version, whole paused
 * campaigns (and never turning on an empty one), manager accounts, conversion destinations checked with a token
 * that can check them, the Data Manager request, the Local Services cursor and results refresh. Every Google
 * call goes to a fake; nothing reaches the network. Kept apart from google.test.ts, whose module order matters.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, refusal, start, type T } from "../tests/harness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { campaignProblem } from "./lib/google/adDrafts";
import { adsVersion, campaignOperations, DEFAULT_ADS_VERSION, lsaSince } from "./lib/google/ads";
import { ingestBody } from "./lib/google/datamanager";
import { SCOPE } from "./lib/google/features";
import { writesToGoogle } from "./lib/google/http";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const ENV = { GOOGLE_CLIENT_ID: "client-id.apps.test", GOOGLE_CLIENT_SECRET: "client-secret-not-real", MAILBOX_TOKEN_KEY: KEY, CONVEX_SITE_URL: "https://deployment.convex.site.test", APP_ORIGIN: "https://app.selestial.test", GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token-test" };

const b64url = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = (sub: string, email: string) => `${b64url({ alg: "none" })}.${b64url({ sub, email })}.sig`;

type Call = { url: string; method: string; body: string; headers: Record<string, string> };
type Reply = { status?: number; body: unknown };
/** A fake Google: the first route whose test matches answers. Every call is recorded with its headers. */
function fakeGoogle(routes: [(call: Call) => boolean, (call: Call) => Reply][]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "", headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) };
      calls.push(call);
      const route = routes.find(([test]) => test(call));
      if (!route) return new Response(JSON.stringify({ error: { message: `not faked: ${call.url}` } }), { status: 404 });
      const reply = route[1](call);
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const query = (call: Call) => (call.body ? ((JSON.parse(call.body) as { query?: string }).query ?? "") : "");
const isSearch = (call: Call, fragment: string) => call.url.endsWith("/googleAds:search") && query(call).includes(fragment);
/** Each connection's refresh token gets its own access token, so a test can tell which grant a call used. */
const tokenRoute = (scopes: Record<string, string[]>): [(call: Call) => boolean, (call: Call) => Reply] => [
  (call) => call.url.includes("oauth2.googleapis.com/token"),
  (call) => {
    const refresh = new URLSearchParams(call.body).get("refresh_token") ?? "";
    return { body: { access_token: `access-for-${refresh}`, scope: [SCOPE.openid, SCOPE.email, ...(scopes[refresh] ?? [])].join(" "), expires_in: 3600 } };
  },
];

async function connect(t: T, as: ReturnType<T["withIdentity"]>, companyId: Id<"companies">, feature: "ads" | "conversions", grant: string[], refresh: string) {
  const { url } = await as.mutation(api.google.startConnect, { companyId, feature });
  const state = new URL(url).searchParams.get("state")!;
  fakeGoogle([[(c) => c.url.includes("oauth2.googleapis.com/token"), () => ({ body: { access_token: "a", refresh_token: refresh, scope: [SCOPE.openid, SCOPE.email, ...grant].join(" "), expires_in: 3600, id_token: idToken("google-sub-1", "owner@alpha.test") } })]]);
  const response = await t.fetch(`/oauth/google/callback?state=${encodeURIComponent(state)}&code=auth-code`, { method: "GET" });
  // Google's answer only waits; the signed-in Owner who started confirms the account in the app.
  const pending = new URL(response.headers.get("location") ?? "", "https://app.test").searchParams.get("pending");
  if (pending) await as.mutation(api.google.confirmConnect, { companyId, token: pending });
}

const DRAFT = { name: "Spring", dailyBudgetCents: 2500, keywords: ["house cleaning", "maid service"], postalCodes: ["78701"], cities: ["Austin, TX"], headline: "Spotless homes", description: "Trusted cleaners near you.", headlines: ["Book in 60 seconds", "Insured local cleaners"], descriptions: ["Same team every visit."], finalUrl: "https://alpha.test/book" };

/**
 * The Owner's "Use", as the page sends it. Its own check with Google is scheduled; it is held here (timers faked
 * only while the mutation runs) so each test runs that check itself, against its own fake.
 */
async function addResource(as: ReturnType<T["withIdentity"]>, args: { companyId: Id<"companies">; kind: "ads_account" | "conversion_destination"; externalId: string; label: string; detail?: string }) {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    return await as.mutation(api.google.addResource, args);
  } finally {
    vi.useRealTimers();
  }
}

async function adsCompany(t: T, detail?: string) {
  const { as, companyId } = await company(t, "owner", "Alpha");
  await connect(t, as, companyId, "ads", [SCOPE.ads], "refresh-ads");
  const accountResource = await addResource(as, { companyId, kind: "ads_account", externalId: "1234567890", label: "Alpha Ads", detail });
  await t.run((ctx) => ctx.db.patch(accountResource, { access: "verified" }));
  return { as, companyId, accountResource };
}

async function runJob(t: T, jobId: Id<"googleJobs">) {
  await t.run((ctx) => ctx.db.patch(jobId, { status: "running", attempts: 1 }));
  await t.action(internal.googleWork.run, { jobId });
  return (await t.run((ctx) => ctx.db.get(jobId)))!;
}

describe("the Google Ads API version", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to v26, a version Google still serves (v20 and v21 are sunset), and can be set per deployment", () => {
    vi.stubEnv("GOOGLE_ADS_API_VERSION", "");
    expect(DEFAULT_ADS_VERSION).toBe("v26");
    expect(adsVersion()).toBe("v26");
    vi.stubEnv("GOOGLE_ADS_API_VERSION", "v27");
    expect(adsVersion()).toBe("v27");
  });

  it("treats a location lookup as a read and a campaign mutate as a write", () => {
    expect(writesToGoogle("https://googleads.googleapis.com/v26/geoTargetConstants:suggest", "POST")).toBe(false);
    expect(writesToGoogle("https://googleads.googleapis.com/v26/customers/1234567890/googleAds:mutate", "POST")).toBe(true);
  });
});

describe("campaigns are created whole, paused, and never turned on empty", () => {
  let t: T;
  beforeEach(() => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    t = start();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refuses a draft that could not become a whole campaign, with the reason", async () => {
    const { as, companyId } = await adsCompany(t);
    const manager = await addMember(t, as, companyId, "manager", "manager");
    const base = { companyId, accountId: "123-456-7890", ...DRAFT };
    expect(await refusal(manager.mutation(api.googleAds.draftCampaign, { ...base, headlines: [] }))).toMatch(/at least 3 different headlines/);
    expect(await refusal(manager.mutation(api.googleAds.draftCampaign, { ...base, descriptions: [] }))).toMatch(/at least 2 different descriptions/);
    expect(await refusal(manager.mutation(api.googleAds.draftCampaign, { ...base, keywords: [] }))).toMatch(/no keywords/);
    expect(await refusal(manager.mutation(api.googleAds.draftCampaign, { ...base, postalCodes: [], cities: [] }))).toMatch(/ZIP codes or cities/);
    expect(await refusal(manager.mutation(api.googleAds.draftCampaign, { ...base, finalUrl: undefined }))).toMatch(/no published booking page/);
    expect(campaignProblem(DRAFT)).toBeNull();
  });

  it("creates budget, campaign (PAUSED, EU political ads declared), ad group, keywords, ad and locations in one request, through the manager account", async () => {
    const { as, companyId } = await adsCompany(t, "9876543210");
    const { draftId } = await as.mutation(api.googleAds.draftCampaign, { companyId, accountId: "1234567890", ...DRAFT, keywordMatch: "exact" });
    const { jobId } = await as.mutation(api.googleAds.approveCampaign, { companyId, draftId, confirmDailyBudgetCents: 2500 });
    const calls = fakeGoogle([
      tokenRoute({ "refresh-ads": [SCOPE.ads] }),
      [(c) => isSearch(c, "FROM campaign WHERE campaign.name"), () => ({ body: { results: [] } })],
      [(c) => c.url.endsWith("/geoTargetConstants:suggest"), () => ({ body: { geoTargetConstantSuggestions: [{ searchTerm: "78701", geoTargetConstant: { resourceName: "geoTargetConstants/9028246", name: "78701", targetType: "Postal Code", status: "ENABLED" } }, { searchTerm: "Austin, TX", geoTargetConstant: { resourceName: "geoTargetConstants/1026201", name: "Austin", targetType: "City", status: "ENABLED" } }] } })],
      [(c) => c.url.endsWith("/googleAds:mutate"), () => ({ body: { mutateOperationResponses: [{ campaignBudgetResult: { resourceName: "customers/1234567890/campaignBudgets/11" } }, { campaignResult: { resourceName: "customers/1234567890/campaigns/22" } }] } })],
    ]);
    expect((await runJob(t, jobId)).status).toBe("done");
    const mutate = calls.find((c) => c.url.endsWith("/googleAds:mutate"))!;
    expect(mutate.url).toBe("https://googleads.googleapis.com/v26/customers/1234567890/googleAds:mutate");
    expect(mutate.headers["login-customer-id"]).toBe("9876543210");
    expect(mutate.headers["developer-token"]).toBe("dev-token-test");
    const ops = (JSON.parse(mutate.body) as { mutateOperations: Record<string, { create: Record<string, unknown> }>[] }).mutateOperations;
    const of = (kind: string) => ops.filter((op) => op[kind]).map((op) => op[kind].create);
    expect(of("campaignOperation")[0]).toMatchObject({ status: "PAUSED", advertisingChannelType: "SEARCH", containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING", campaignBudget: "customers/1234567890/campaignBudgets/-1" });
    expect(of("campaignBudgetOperation")[0]).toMatchObject({ amountMicros: "25000000" });
    expect(of("adGroupOperation")).toHaveLength(1);
    expect(of("adGroupCriterionOperation").map((c) => c.keyword)).toEqual([{ text: "house cleaning", matchType: "EXACT" }, { text: "maid service", matchType: "EXACT" }]);
    const ad = of("adGroupAdOperation")[0].ad as { finalUrls: string[]; responsiveSearchAd: { headlines: unknown[]; descriptions: unknown[] } };
    expect(ad.finalUrls).toEqual(["https://alpha.test/book"]);
    expect(ad.responsiveSearchAd.headlines).toHaveLength(3);
    expect(ad.responsiveSearchAd.descriptions).toHaveLength(2);
    expect(of("campaignCriterionOperation").map((c) => c.location)).toEqual([{ geoTargetConstant: "geoTargetConstants/9028246" }, { geoTargetConstant: "geoTargetConstants/1026201" }]);
    // Nothing turned it on.
    expect(calls.some((c) => c.url.endsWith("/campaigns:mutate"))).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject({ state: "created_paused", googleCampaign: "customers/1234567890/campaigns/22" });
  });

  it("a retry finds the campaign an earlier attempt made instead of making a second one", async () => {
    const { as, companyId } = await adsCompany(t);
    const { draftId } = await as.mutation(api.googleAds.draftCampaign, { companyId, accountId: "1234567890", ...DRAFT });
    const { jobId } = await as.mutation(api.googleAds.approveCampaign, { companyId, draftId, confirmDailyBudgetCents: 2500 });
    const calls = fakeGoogle([tokenRoute({ "refresh-ads": [SCOPE.ads] }), [(c) => isSearch(c, "FROM campaign WHERE campaign.name"), () => ({ body: { results: [{ campaign: { resourceName: "customers/1234567890/campaigns/22", status: "PAUSED" } }] } })]]);
    await t.run((ctx) => ctx.db.patch(jobId, { checkpoint: "reconcile" }));
    expect((await runJob(t, jobId)).status).toBe("done");
    expect(calls.some((c) => c.url.endsWith("/googleAds:mutate"))).toBe(false);
    expect(calls.find((c) => c.url.endsWith("/googleAds:search"))!.headers["login-customer-id"]).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(draftId)))!.state).toBe("created_paused");
  });

  it("creates nothing when Google recognizes none of the service area, and says so", async () => {
    const { as, companyId } = await adsCompany(t);
    const { draftId } = await as.mutation(api.googleAds.draftCampaign, { companyId, accountId: "1234567890", ...DRAFT });
    const { jobId } = await as.mutation(api.googleAds.approveCampaign, { companyId, draftId, confirmDailyBudgetCents: 2500 });
    const calls = fakeGoogle([tokenRoute({ "refresh-ads": [SCOPE.ads] }), [(c) => c.url.endsWith("/googleAds:search"), () => ({ body: { results: [] } })], [(c) => c.url.endsWith("/geoTargetConstants:suggest"), () => ({ body: { geoTargetConstantSuggestions: [] } })]]);
    expect((await runJob(t, jobId)).status).toBe("failed");
    expect(calls.some((c) => c.url.endsWith("/googleAds:mutate"))).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject({ state: "failed", problem: expect.stringMatching(/didn’t recognize any/) });
  });

  it("will not turn on a campaign that has no ad, keywords or locations in Google Ads: it stays paused and the Owner is told", async () => {
    const { as, companyId } = await adsCompany(t);
    const { draftId } = await as.mutation(api.googleAds.draftCampaign, { companyId, accountId: "1234567890", ...DRAFT });
    // An empty campaign made by an earlier version of Selestial.
    await t.run((ctx) => ctx.db.patch(draftId, { state: "created_paused", googleCampaign: "customers/1234567890/campaigns/22", approvedBudgetCents: 2500 }));
    const { jobId } = await as.mutation(api.googleAds.activateCampaign, { companyId, draftId, confirmDailyBudgetCents: 2500 });
    const calls = fakeGoogle([
      tokenRoute({ "refresh-ads": [SCOPE.ads] }),
      [(c) => isSearch(c, "FROM campaign WHERE campaign.name"), () => ({ body: { results: [{ campaign: { resourceName: "customers/1234567890/campaigns/22", status: "PAUSED" } }] } })],
      [(c) => isSearch(c, "FROM ad_group WHERE"), () => ({ body: { results: [{ adGroup: { id: "1" } }] } })],
      [(c) => c.url.endsWith("/googleAds:search"), () => ({ body: { results: [] } })],
    ]);
    expect((await runJob(t, jobId)).status).toBe("failed");
    expect(calls.some((c) => c.url.endsWith("/campaigns:mutate"))).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject({ state: "created_paused", problem: expect.stringMatching(/is missing an ad, keywords, locations\. It stays paused/) });
  });

  it("turns on a whole campaign only after the Owner's activation", async () => {
    const { as, companyId } = await adsCompany(t);
    const { draftId } = await as.mutation(api.googleAds.draftCampaign, { companyId, accountId: "1234567890", ...DRAFT });
    await t.run((ctx) => ctx.db.patch(draftId, { state: "created_paused", googleCampaign: "customers/1234567890/campaigns/22", approvedBudgetCents: 2500 }));
    const { jobId } = await as.mutation(api.googleAds.activateCampaign, { companyId, draftId, confirmDailyBudgetCents: 2500 });
    const calls = fakeGoogle([
      tokenRoute({ "refresh-ads": [SCOPE.ads] }),
      [(c) => isSearch(c, "FROM campaign WHERE campaign.name"), () => ({ body: { results: [{ campaign: { resourceName: "customers/1234567890/campaigns/22", status: "PAUSED" } }] } })],
      [(c) => c.url.endsWith("/googleAds:search"), () => ({ body: { results: [{ any: 1 }] } })],
      [(c) => c.url.endsWith("/campaigns:mutate"), () => ({ body: { results: [{ resourceName: "customers/1234567890/campaigns/22" }] } })],
    ]);
    expect((await runJob(t, jobId)).status).toBe("done");
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/campaigns:mutate"))!.body)).toEqual({ operations: [{ update: { resourceName: "customers/1234567890/campaigns/22", status: "ENABLED" }, updateMask: "status" }] });
    expect((await t.run((ctx) => ctx.db.get(draftId)))!.state).toBe("active");
  });

  it("builds the mutate operations from the plan alone", () => {
    const ops = campaignOperations("123-456-7890", { name: "X", dailyBudgetMicros: 1_000_000, keywords: ["a"], matchType: "PHRASE", headlines: ["1", "2", "3"], descriptions: ["d1", "d2"], finalUrl: "https://x.test", geoTargets: ["geoTargetConstants/1"] });
    expect(ops.map((op) => Object.keys(op)[0])).toEqual(["campaignBudgetOperation", "campaignOperation", "adGroupOperation", "adGroupCriterionOperation", "adGroupAdOperation", "campaignCriterionOperation"]);
  });
});

describe("ad accounts under a manager account", () => {
  let t: T;
  beforeEach(() => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    t = start();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("lists the advertiser accounts under each manager with the manager's id, and verifies one through it", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connect(t, as, companyId, "ads", [SCOPE.ads], "refresh-ads");
    const connectionId = (await as.query(api.google.status, { companyId })).tools.find((tool) => tool.feature === "ads")!.connection!.id;
    const calls = fakeGoogle([
      tokenRoute({ "refresh-ads": [SCOPE.ads] }),
      [(c) => c.url.endsWith("/customers:listAccessibleCustomers"), () => ({ body: { resourceNames: ["customers/9876543210", "customers/5555555555"] } })],
      [(c) => isSearch(c, "FROM customer LIMIT 1") && c.url.includes("/customers/9876543210/"), () => ({ body: { results: [{ customer: { id: "9876543210", descriptiveName: "Agency MCC", manager: true } }] } })],
      [(c) => isSearch(c, "FROM customer LIMIT 1") && c.url.includes("/customers/5555555555/"), () => ({ body: { results: [{ customer: { id: "5555555555", descriptiveName: "Own account", manager: false } }] } })],
      [(c) => isSearch(c, "FROM customer_client"), () => ({ body: { results: [{ customerClient: { id: "1234567890", descriptiveName: "Alpha Cleaning", manager: false, status: "ENABLED", level: "1" } }] } })],
      [(c) => isSearch(c, "FROM customer LIMIT 1") && c.url.includes("/customers/1234567890/"), () => ({ body: { results: [{ customer: { id: "1234567890", descriptiveName: "Alpha Cleaning", manager: false } }] } })],
      [(c) => isSearch(c, "FROM campaign WHERE segments.date"), () => ({ body: { results: [] } })],
    ]);
    await t.action(internal.googleWork.listChoices, { connectionId, kind: "ads_accounts" });
    const choices = (await as.query(api.google.choices, { companyId, kind: "ads_accounts" }))!;
    expect(choices.items).toEqual([
      { id: "5555555555", label: "Own account (555-555-5555)" },
      { id: "1234567890", label: "Alpha Cleaning (123-456-7890) · through Agency MCC (987-654-3210)", detail: "9876543210" },
    ]);
    expect(calls.find((c) => isSearch(c, "FROM customer_client"))!.headers["login-customer-id"]).toBe("9876543210");
    const managed = choices.items[1];
    const resourceId = await addResource(as, { companyId, kind: "ads_account", externalId: managed.id, label: managed.label, detail: managed.detail });
    await t.action(internal.googleWork.verifyResource, { resourceId });
    expect(await t.run((ctx) => ctx.db.get(resourceId))).toMatchObject({ access: "verified", accessNote: expect.stringMatching(/manager account 987-654-3210/) });
    expect(calls.filter((c) => c.url.includes("/customers/1234567890/")).every((c) => c.headers["login-customer-id"] === "9876543210")).toBe(true);
    // Results are read straight away, through the manager.
    const jobs = await t.run((ctx) => ctx.db.query("googleJobs").collect());
    const snapshot = jobs.find((j) => j.kind === "ads_snapshot")!;
    expect(JSON.parse(snapshot.payload)).toMatchObject({ accountId: "1234567890", loginCustomerId: "9876543210" });
    expect((await runJob(t, snapshot._id)).status).toBe("done");
    expect(calls.filter((c) => isSearch(c, "FROM campaign WHERE segments.date")).at(-1)!.headers["login-customer-id"]).toBe("9876543210");
  });

  it("does not verify an account the Google account cannot reach, directly or through its manager", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connect(t, as, companyId, "ads", [SCOPE.ads], "refresh-ads");
    fakeGoogle([tokenRoute({ "refresh-ads": [SCOPE.ads] }), [(c) => c.url.endsWith("/customers:listAccessibleCustomers"), () => ({ body: { resourceNames: ["customers/5555555555"] } })]]);
    const resourceId = await addResource(as, { companyId, kind: "ads_account", externalId: "1234567890", label: "Not mine", detail: "9876543210" });
    await t.action(internal.googleWork.verifyResource, { resourceId });
    expect((await t.run((ctx) => ctx.db.get(resourceId)))!.access).toBe("lost");
  });

  it("refreshes results every six hours for confirmed accounts only", async () => {
    const { companyId, accountResource } = await adsCompany(t, "9876543210");
    expect(await t.mutation(internal.googleAds.sweepResults, {})).toBe(1);
    expect(await t.mutation(internal.googleAds.sweepResults, {})).toBe(0);
    await t.run((ctx) => ctx.db.patch(accountResource, { access: "lost" }));
    const jobs = await t.run((ctx) => ctx.db.query("googleJobs").collect());
    expect(jobs.filter((j) => j.kind === "ads_snapshot" && j.companyId === companyId)).toHaveLength(1);
  });
});

describe("booked-job reporting", () => {
  let t: T;
  beforeEach(() => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    t = start();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends the Data Manager request Google documents: accounts, conversion action, event source, consent, click id", () => {
    const body = ingestBody({ accountId: "123-456-7890", conversionActionId: "777", loginAccountId: "9876543210" }, [{ transactionId: "selestial-j1", at: Date.UTC(2026, 10, 1, 15), valueCents: 18550, currency: "USD", gclid: "g-1", consent: { adUserData: true, adPersonalization: false } }]);
    expect(body.destinations).toEqual([{ operatingAccount: { accountType: "GOOGLE_ADS", accountId: "1234567890" }, loginAccount: { accountType: "GOOGLE_ADS", accountId: "9876543210" }, productDestinationId: "777" }]);
    expect(body.consent).toEqual({ adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_DENIED" });
    expect(body.events).toEqual([{ transactionId: "selestial-j1", eventTimestamp: "2026-11-01T15:00:00.000Z", eventSource: "OTHER", conversionValue: 185.5, currency: "USD", adIdentifiers: { gclid: "g-1" } }]);
    // Reached directly, the login account is the account itself.
    expect(ingestBody({ accountId: "1234567890", conversionActionId: "777" }, []).destinations[0].loginAccount).toEqual({ accountType: "GOOGLE_ADS", accountId: "1234567890" });
  });

  it("checks the conversion action with the Google Ads token, not the reporting token, which cannot query Google Ads", async () => {
    const { as, companyId } = await adsCompany(t, "9876543210");
    await connect(t, as, companyId, "conversions", [SCOPE.dataManager], "refresh-conv");
    const resourceId = await addResource(as, { companyId, kind: "conversion_destination", externalId: "777", label: "Booked visit", detail: "1234567890:9876543210" });
    const calls = fakeGoogle([
      tokenRoute({ "refresh-ads": [SCOPE.ads], "refresh-conv": [SCOPE.dataManager] }),
      [(c) => isSearch(c, "FROM conversion_action WHERE conversion_action.id = 777"), () => ({ body: { results: [{ conversionAction: { id: "777", type: "UPLOAD_CLICKS", status: "ENABLED" } }] } })],
    ]);
    await t.action(internal.googleWork.verifyResource, { resourceId });
    expect((await t.run((ctx) => ctx.db.get(resourceId)))!.access).toBe("verified");
    const lookup = calls.find((c) => c.url.endsWith("/googleAds:search"))!;
    expect(lookup.headers.authorization).toBe("Bearer access-for-refresh-ads");
    expect(lookup.headers["login-customer-id"]).toBe("9876543210");
  });

  it("refuses a conversion that does not accept imported clicks", async () => {
    const { as, companyId } = await adsCompany(t);
    await connect(t, as, companyId, "conversions", [SCOPE.dataManager], "refresh-conv");
    const resourceId = await addResource(as, { companyId, kind: "conversion_destination", externalId: "777", label: "Website purchase", detail: "1234567890" });
    fakeGoogle([tokenRoute({ "refresh-ads": [SCOPE.ads], "refresh-conv": [SCOPE.dataManager] }), [(c) => isSearch(c, "FROM conversion_action"), () => ({ body: { results: [{ conversionAction: { id: "777", type: "WEBPAGE", status: "ENABLED" } }] } })]]);
    await t.action(internal.googleWork.verifyResource, { resourceId });
    expect(await t.run((ctx) => ctx.db.get(resourceId))).toMatchObject({ access: "lost", accessNote: expect.stringMatching(/Import from clicks/) });
  });

  it("without Google Ads connected, the destination waits for the first report, which sends and confirms it", async () => {
    const { as, companyId } = await company(t, "owner", "Alpha");
    await connect(t, as, companyId, "conversions", [SCOPE.dataManager], "refresh-conv");
    const resourceId = await addResource(as, { companyId, kind: "conversion_destination", externalId: "777", label: "Booked visit", detail: "1234567890" });
    const calls = fakeGoogle([tokenRoute({ "refresh-conv": [SCOPE.dataManager] }), [(c) => c.url.endsWith("/events:ingest"), () => ({ body: { requestId: "req-1" } })]]);
    await t.action(internal.googleWork.verifyResource, { resourceId });
    expect(await t.run((ctx) => ctx.db.get(resourceId))).toMatchObject({ access: "unverified", accessNote: expect.stringMatching(/first booked-visit report/) });
    expect(calls.some((c) => c.url.includes("googleads.googleapis.com"))).toBe(false);
    // A booked visit from an ad click, with consent recorded.
    await as.mutation(api.googleAds.setConversionConsent, { companyId, adUserData: true, adPersonalization: false, basis: "Booking form consent checkbox" });
    const conversionId = await t.run(async (ctx) => {
      const customerId = await ctx.db.insert("customers", { companyId, name: "Pat", kind: "home", status: "active", createdAt: 0 });
      const propertyId = await ctx.db.insert("properties", { companyId, customerId, kind: "home", address: { line1: "1 Main", city: "Austin", region: "TX", postalCode: "78701" }, status: "active", createdAt: 0 });
      const leadId = await ctx.db.insert("googleLeads", { companyId, source: "lead_form", externalId: "l1", gclid: "g-1", customerId, receivedAt: 0 });
      const jobId = await ctx.db.insert("jobs", { companyId, customerId, propertyId, serviceType: "standard", scope: "x", requiredSkills: [], startsAt: 0, endsAt: 1, status: "scheduled", priceCents: 16000, createdAt: Date.UTC(2026, 10, 1) });
      return ctx.db.insert("googleConversions", { companyId, jobId, leadId, transactionId: "selestial-j1", valueCents: 16000, status: "queued", createdAt: 0 });
    });
    const connectionId = (await as.query(api.google.status, { companyId })).tools.find((tool) => tool.feature === "conversions")!.connection!.id;
    const jobId = await t.run((ctx) => ctx.db.insert("googleJobs", { companyId, connectionId, kind: "conversion", key: "conversion:x", status: "running", payload: JSON.stringify({ conversionId }), attempts: 1, nextAt: 0, createdAt: Date.now(), updatedAt: Date.now() }));
    await t.action(internal.googleWork.run, { jobId });
    expect((await t.run((ctx) => ctx.db.get(conversionId)))!.status).toBe("sent");
    expect(await t.run((ctx) => ctx.db.get(resourceId))).toMatchObject({ access: "verified" });
    const sent = JSON.parse(calls.find((c) => c.url.endsWith("/events:ingest"))!.body) as ReturnType<typeof ingestBody>;
    expect(sent.destinations[0]).toMatchObject({ operatingAccount: { accountId: "1234567890" }, productDestinationId: "777" });
    expect(sent.events[0]).toMatchObject({ transactionId: "selestial-j1", eventSource: "OTHER", adIdentifiers: { gclid: "g-1" }, conversionValue: 160 });
  });
});

describe("Local Services leads", () => {
  let t: T;
  beforeEach(() => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    t = start();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("starts a week back the first time, then from the newest lead read with an hour's overlap", () => {
    const now = Date.UTC(2026, 10, 23, 12);
    expect(lsaSince(undefined, now)).toBe("2026-11-16 12:00:00");
    expect(lsaSince("2026-11-23 09:30:00", now)).toBe("2026-11-23 08:30:00");
  });

  it("files each lead once in the Sales pipeline, moves the cursor forward, and asks Google for no email (removed in v25)", async () => {
    const { companyId, accountResource } = await adsCompany(t, "9876543210");
    await t.mutation(internal.googleAds.sweepLocalServices, {});
    const job = (await t.run((ctx) => ctx.db.query("googleJobs").collect())).find((j) => j.kind === "lsa_poll")!;
    expect(JSON.parse(job.payload).since).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const calls = fakeGoogle([
      tokenRoute({ "refresh-ads": [SCOPE.ads] }),
      [(c) => isSearch(c, "FROM local_services_lead"), () => ({ body: { results: [{ localServicesLead: { id: "501", leadType: "PHONE_CALL", leadStatus: "NEW", creationDateTime: "2026-11-23 09:00:00", contactDetails: { consumerName: "Sam", phoneNumber: "+15550101010" } } }, { localServicesLead: { id: "502", leadType: "MESSAGE", leadStatus: "NEW", creationDateTime: "2026-11-23 09:30:00", contactDetails: { consumerName: "Lee", phoneNumber: "+15550102020" } } }] } })],
    ]);
    expect((await runJob(t, job._id)).status).toBe("done");
    const lsa = calls.find((c) => isSearch(c, "FROM local_services_lead"))!;
    expect(query(lsa)).not.toContain("email");
    expect(lsa.headers["login-customer-id"]).toBe("9876543210");
    expect((await t.run((ctx) => ctx.db.get(accountResource)))!.cursor).toBe("2026-11-23 09:30:00");
    const leads = await t.run((ctx) => ctx.db.query("googleLeads").collect());
    expect(leads.filter((l) => l.companyId === companyId && l.source === "local_services").map((l) => l.externalId).sort()).toEqual(["501", "502"]);
    // Each became an opportunity in the Sales pipeline.
    expect(leads.every((l) => l.customerId)).toBe(true);
    // The next poll starts from the cursor, an hour back.
    await t.run((ctx) => ctx.db.patch(job._id, { status: "done" }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await t.mutation(internal.googleAds.sweepLocalServices, {});
    vi.useRealTimers();
    const next = (await t.run((ctx) => ctx.db.query("googleJobs").collect())).filter((j) => j.kind === "lsa_poll").at(-1)!;
    expect(JSON.parse(next.payload).since).toBe("2026-11-23 08:30:00");
    // The cursor never moves back.
    await t.mutation(internal.googleAds.advanceLsaCursor, { companyId, accountId: "1234567890", newest: "2026-11-01 00:00:00" });
    expect((await t.run((ctx) => ctx.db.get(accountResource)))!.cursor).toBe("2026-11-23 09:30:00");
  });
});
